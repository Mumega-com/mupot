// Read/notice companion for elevation cards. It decides nothing and grants no authority.
import type { Env } from '../types'
import type { ElevationRequestRecord } from '../auth/elevation'
import { SWEEPER_SENDER } from '../agents/system-senders'

export interface ApprovalSweepEntry {
  task_id?: string; request_id?: string; event?: string; reason?: string
  gate_owner?: string; receipt_id?: string; episode?: string; notice: string
}

/** Complete bounded chunks; return only entries actually named in delivered/replayed messages. */
export async function sendApprovalSweepDigest(env: Env, toAgent: string, fromMember: string, entries: ApprovalSweepEntry[]): Promise<number> {
  let named=0
  try {
    const {sendAgentMessage,MAX_BODY_CHARS}=await import('../agents/messages')
    // Random receipt ids remain in the ledger. Stable task episodes make replay bodies and keys deterministic.
    const canonical:ApprovalSweepEntry[]=entries.map(e=>({task_id:e.task_id,request_id:e.request_id,event:e.event,reason:e.reason,gate_owner:e.gate_owner,episode:e.episode,notice:e.notice}))
    canonical.sort((a,b)=>JSON.stringify(a)<JSON.stringify(b)?-1:JSON.stringify(a)>JSON.stringify(b)?1:0)
    const header={type:'approval_sweeper_digest',total:entries.length,omitted:0,notice:'Status summary only; no reply is required. Read the named task or elevation request for its current state.',entries:[]}
    const baseLength=JSON.stringify(header).length
    const chunks:ApprovalSweepEntry[][]=[];let chunk:ApprovalSweepEntry[]=[],length=baseLength
    for(const entry of canonical){
      const size=JSON.stringify(entry).length
      if(chunk.length && length+size+1>MAX_BODY_CHARS){chunks.push(chunk);chunk=[];length=baseLength}
      if(length+size>MAX_BODY_CHARS)throw new Error('single approval notice exceeds inbox body cap')
      length+=size+(chunk.length?1:0);chunk.push(entry)
    }
    if(chunk.length)chunks.push(chunk)
    for(const items of chunks){
      try {
        const body=JSON.stringify({...header,total:items.length,entries:items})
        const refs=items.map(e=>JSON.stringify(e.task_id?['task',e.task_id,e.episode??'']:['elevation',e.request_id,e.event])).sort()
        const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([env.TENANT_SLUG,toAgent,refs])))
        const id=[...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('')
        const sent=await sendAgentMessage(env,{fromAgent:SWEEPER_SENDER,fromMember,toAgent,kind:'message',requestId:`approval-digest-v2:${id}`,body},
          {system:true,reason:'complete informational digest chunk for canonical recipients from this bounded expiry sweep'})
        if(sent.ok)named+=items.length
      }catch{ /* Already committed state and earlier successful chunks remain truthful. */ }
    }
  }catch{ /* Unrepresentable input counts as zero delivered, never as an omitted success. */ }
  return named
}

// Recognize both old per-request notices and the new digest after an inbox ACK too.
function recordedNoticeSql(id:string,event:string):string {
  const body="CASE WHEN datetime(m.created_at)>=datetime(?6) THEN CASE WHEN json_valid(m.body) THEN m.body ELSE '{}' END ELSE '{}' END"
  const entry="CASE WHEN e.type='object' THEN e.value ELSE '{}' END"
  return `(datetime(m.created_at)>=datetime(?6) AND (m.request_id='approval-bot:' || ${id} || ':' || ${event}
    OR (json_extract(${body},'$.type')='approval_sweeper_digest' AND EXISTS (
      SELECT 1 FROM json_each(${body},'$.entries') e
        WHERE json_extract(${entry},'$.request_id')=${id} AND json_extract(${entry},'$.event')=${event}))))`
}
async function noticeRecorded(env:Env,req:ElevationRequestRecord,event:string,nowMs=Date.now()):Promise<boolean>{
  return !!await env.DB.prepare(`SELECT 1 FROM agent_messages m WHERE m.tenant=?1 AND m.from_agent=?2 AND m.to_agent=?3
    AND ${recordedNoticeSql('?4','?5')} LIMIT 1`).bind(req.tenant,SWEEPER_SENDER,req.agent_id,req.id,event,new Date(nowMs-APPROVAL_NOTICE_DEDUPE_MS).toISOString()).first()
}
function approvalNotice(event:string):string{
  return event==='expired'?'This elevation request expired without a decision. No approval was granted. File a new request if it is still needed.'
    :event==='denied'?'The human denied this elevation request. No approval was granted.'
    :'The approval bot could not apply this tap or command. Check elevation_status for the current request state and ask the intended approver to retry if needed.'
}

export const APPROVAL_NOTICE_BATCH_LIMIT = 25
export const APPROVAL_NOTICE_LOOKBACK_MS = 24 * 60 * 60 * 1000
export const APPROVAL_NOTICE_DEDUPE_MS = 30 * 24 * 60 * 60 * 1000

export function effectiveApprovalStatus(req: ElevationRequestRecord, nowMs = Date.now()): ElevationRequestRecord['status'] {
  return req.status === 'pending' && Date.parse(req.decision_expires_at) <= nowMs ? 'expired' : req.status
}

/** Target comes only from the canonical, tenant-scoped request, never Telegram text. */
export async function notifyApprovalRequester(env: Env, req: ElevationRequestRecord, event: string, nowMs = Date.now()): Promise<boolean> {
  if (req.tenant !== env.TENANT_SLUG) return false
  const deadline = Date.parse(req.decision_expires_at)
  if (event === 'expired' && (!Number.isFinite(deadline) || deadline < nowMs - APPROVAL_NOTICE_LOOKBACK_MS || deadline > nowMs)) return true
  try {
    const offered = await env.DB.prepare('SELECT 1 AS offered FROM approval_bot_deliveries WHERE request_id = ?1 AND tenant = ?2 LIMIT 1').bind(req.id, req.tenant).first()
    if (!offered) return true // Not an approval-bot request: other channels keep their own notices.
    if(await noticeRecorded(env,req,event,nowMs))return true
    const notice=approvalNotice(event)
    // Lazy import keeps the common elevation read path out of the messaging/bus initialization cycle.
    const { sendAgentMessage } = await import('../agents/messages')
    const sent = await sendAgentMessage(env, {
      fromAgent: SWEEPER_SENDER, fromMember: 'system:approval-bot', toAgent: req.agent_id,
      kind: 'message', requestId: `approval-bot:${req.id}:${event}`,
      body: JSON.stringify({ type: 'elevation_approval_bot', request_id: req.id, event, notice }),
    }, { system: true, reason: 'informational status for the requester agent read from the tenant-scoped elevation row' })
    return sent.ok
  } catch {
    return false // A read remains truthful; a later read/tap retries the durable notice.
  }
}

/** Repair the stored pending state before returning it. The second read observes a competing decision/renewal. */
export async function reconcileApprovalBotRequestRead(env: Env, req: ElevationRequestRecord, nowMs = Date.now()): Promise<ElevationRequestRecord | null> {
  let current = req
  if (req.status === 'pending' && effectiveApprovalStatus(req, nowMs) === 'expired') {
    try {
      await env.DB.prepare(`UPDATE elevation_requests SET status = 'expired'
        WHERE id = ?1 AND tenant = ?2 AND status = 'pending' AND decision_expires_at <= ?3`)
        .bind(req.id, req.tenant, new Date(nowMs).toISOString()).run()
    } catch { /* read-only callers still get the effective state below */ }
    const latest = await env.DB.prepare(`SELECT status, decision_expires_at, decided_at, decided_by_member_id, decided_by_web_session_hash, decision_note
      FROM elevation_requests WHERE id = ?1 AND tenant = ?2 LIMIT 1`).bind(req.id, req.tenant).first<Pick<ElevationRequestRecord, 'status' | 'decision_expires_at' | 'decided_at' | 'decided_by_member_id' | 'decided_by_web_session_hash' | 'decision_note'>>()
    if (!latest) return null
    current = { ...req, ...latest }
  }
  const view = { ...current, status: effectiveApprovalStatus(current, nowMs) }
  if (view.status === 'expired' && view.decided_at === null) await notifyApprovalRequester(env, view, 'expired', nowMs)
  return view
}

/** Existing expiry reads provide a bounded, replay-safe notification opportunity; no new cron. */
export async function notifyLapsedApprovalBotRequests(env: Env, tenant: string, nowMs = Date.now()): Promise<number> {
  if (tenant !== env.TENANT_SLUG) return 0
  try {
    const rows = await env.DB.prepare(`SELECT r.* FROM elevation_requests r
      WHERE r.tenant = ?1 AND r.status = 'expired' AND r.decided_at IS NULL AND r.decision_expires_at <= ?2 AND r.decision_expires_at >= ?5
        AND EXISTS (SELECT 1 FROM approval_bot_deliveries d WHERE d.request_id = r.id AND d.tenant = r.tenant)
        AND NOT EXISTS (SELECT 1 FROM agent_messages m WHERE m.tenant = r.tenant AND m.from_agent = ?3 AND m.to_agent = r.agent_id AND ${recordedNoticeSql('r.id',"'expired'")})
      ORDER BY r.decision_expires_at, r.id LIMIT ?4`)
      .bind(tenant, new Date(nowMs).toISOString(), SWEEPER_SENDER, APPROVAL_NOTICE_BATCH_LIMIT, new Date(nowMs - APPROVAL_NOTICE_LOOKBACK_MS).toISOString(),new Date(nowMs-APPROVAL_NOTICE_DEDUPE_MS).toISOString()).all<ElevationRequestRecord>()
    const groups=new Map<string,ApprovalSweepEntry[]>()
    for(const req of rows.results??[]){
      if(await noticeRecorded(env,req,'expired',nowMs))continue
      const entries=groups.get(req.agent_id)??[]
      entries.push({request_id:req.id,event:'expired',notice:approvalNotice('expired')});groups.set(req.agent_id,entries)
    }
    let sent=0
    for(const [agent,entries] of groups)sent+=await sendApprovalSweepDigest(env,agent,'system:approval-bot',entries)
    return sent
  } catch {
    return 0
  }
}
