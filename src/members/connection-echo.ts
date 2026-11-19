/** A nonce return verifies an inbox roundtrip only. It makes no wake claim. */
import type { Env } from '../types'
import { sendAgentMessage } from '../agents/messages'
import { ONBOARDING_SENDER } from '../agents/system-senders'
import { TOKEN_LIVE_PREDICATE } from '../auth/token-lifecycle'

export interface ConnectionEchoContext {
  agentId:string
  credentialId:string
  memberId:string
  harnessId?:string|null
  attachmentId?:string|null
}

type Challenge={created_at:string;expires_at:string;nonce_hash:string;message_id:string;scope_hash:string;binding_hash:string}
type EchoRecord={state:'echo_roundtrip';created_at:string;echo_returned_at:string;path:'inbox_echo';latency_ms:number;binding_hash:string;context:ConnectionEchoContext}
export type ConnectionEchoStatus={state:'echo_roundtrip'|'stale'|'not_returned';echo_returned_at:string|null;path:'inbox_echo'|null;latency_ms:number|null;reason:string}
const TEN_MINUTES=10*60_000
const SEVEN_DAYS=7*24*60*60_000
const NEXT='Read your own inbox, then call connection_check with echo_reply set to the nonce. This checks an inbox echo.'

function iso(ms: number): string { return new Date(ms).toISOString() }
async function hash(value: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('')
}
function scope(ctx: ConnectionEchoContext): string {
  return JSON.stringify([ctx.agentId, ctx.credentialId, ctx.memberId, ctx.harnessId ?? null, ctx.attachmentId ?? null])
}
function parse<T>(raw: string): T | null { try { return JSON.parse(raw) as T } catch { return null } }
function numberMs(at: string | null | undefined): number | null {
  if (!at) return null
  const canonical = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(at) ? at.replace(' ', 'T')+'Z' : at
  const n = Date.parse(canonical)
  return Number.isFinite(n) ? n : null
}

type Binding = { hash: string; tokens: string[]; runtime: string | null; runtimeSeq:number }
function credentialLive(ph: {tenant:string;agent:string;member:string;token:string;now:string}): string {
  return `EXISTS (SELECT 1 FROM member_tokens t
    JOIN agents a ON a.id=t.agent_id AND a.status IN ('active','paused') AND a.archived_at IS NULL
    JOIN agent_member_bindings b ON b.tenant=t.tenant AND b.agent_id=a.id AND b.member_id=t.member_id
    JOIN members m ON m.id=b.member_id AND m.tenant=b.tenant AND m.status='active'
    WHERE t.tenant=${ph.tenant} AND t.id=${ph.token} AND t.member_id=${ph.member} AND t.agent_id=${ph.agent}
      AND ${TOKEN_LIVE_PREDICATE(ph.now)})`
}
async function bindingHash(env: Env, ctx: ConnectionEchoContext, nowMs: number): Promise<Binding | null> {
  const credential = await env.DB.prepare(`SELECT 1 AS x WHERE ${credentialLive({tenant:'?1',token:'?2',member:'?3',agent:'?4',now:'?5'})}`)
    .bind(env.TENANT_SLUG,ctx.credentialId,ctx.memberId,ctx.agentId,iso(nowMs)).first()
  if (!credential) return null
  // Include retained revoked rows too: issuing then revoking a new token must not resurrect an old echo record.
  const rows = await env.DB.prepare(`SELECT id FROM member_tokens WHERE tenant=?1 AND agent_id=?2 ORDER BY id ASC LIMIT 1001`)
    .bind(env.TENANT_SLUG,ctx.agentId).all<{id:string}>()
  const tokens = (rows.results ?? []).map(r=>r.id)
  if (tokens.length>1000) return null
  const fleet = await env.DB.prepare('SELECT runtime FROM fleet_agents WHERE tenant=?1 AND agent_id=?2 LIMIT 1')
    .bind(env.TENANT_SLUG,ctx.agentId).first<{runtime:string|null}>()
  const runtime = fleet?.runtime ?? null // unknown is recorded, not invented; a later report changes the binding
  const runtimeSeq=Number(await env.DB.prepare("SELECT COALESCE(MAX(seq),0) AS n FROM agent_audit WHERE agent_id=?1 AND action='fleet_runtime_transition'").bind(ctx.agentId).first<number>('n'))
  return {hash:await hash(JSON.stringify([scope(ctx),tokens,runtime,runtimeSeq])),tokens,runtime,runtimeSeq}
}

type EchoFence={binding:Binding;now:string}
async function writeAudit(env:Env,id:string,ctx:ConnectionEchoContext,action:string,after:unknown,fence?:EchoFence):Promise<boolean> {
  try {
    const guard=fence ? ` WHERE ${credentialLive({tenant:'?6',token:'?7',member:'?3',agent:'?2',now:'?8'})}
      AND (SELECT json_group_array(id) FROM (SELECT id FROM member_tokens WHERE tenant=?6 AND agent_id=?2 ORDER BY id ASC LIMIT 1001))=?9
      AND (SELECT runtime FROM fleet_agents WHERE tenant=?6 AND agent_id=?2 LIMIT 1) IS ?10
      AND (SELECT COALESCE(MAX(seq),0) FROM agent_audit WHERE agent_id=?2 AND action='fleet_runtime_transition')=?11` : ''
    const result=await env.DB.prepare(`INSERT INTO agent_audit(id,agent_id,actor_id,actor_type,action,fields_changed,before_state,after_state)
      SELECT ?1,?2,?3,'system',?4,'["connection_echo"]','{}',?5${guard}`)
      .bind(id,ctx.agentId,ctx.memberId,action,JSON.stringify(after),...(fence?[env.TENANT_SLUG,ctx.credentialId,fence.now,JSON.stringify(fence.binding.tokens),fence.binding.runtime,fence.binding.runtimeSeq]:[])).run()
    return Number(result.meta.changes)===1
  } catch {return false}
}

async function latestChallenge(env:Env,ctx:ConnectionEchoContext,scopeHash:string):Promise<{id:string;value:Challenge}|null> {
  const rows=await env.DB.prepare(`SELECT c.id,r.after_state FROM agent_audit c
    JOIN agent_audit r ON r.id=c.id||':ready' AND r.action='connection_echo_ready' AND r.agent_id=c.agent_id
    WHERE c.agent_id=?1 AND c.actor_id=?2 AND c.action='connection_echo_challenge' ORDER BY c.seq DESC LIMIT 40`)
    .bind(ctx.agentId,ctx.memberId).all<{id:string;after_state:string}>()
  for(const row of rows.results??[]) {
    const value=parse<Challenge>(row.after_state)
    if(value?.scope_hash===scopeHash && typeof value.nonce_hash==='string')return {id:row.id,value}
  }
  return null
}

export async function startConnectionEcho(env:Env,ctx:ConnectionEchoContext,nowMs=Date.now()):Promise<
  {ok:true;state:'pending';message_id:string;expires_at:string;next_step:string}|{ok:false;error:string}
> {
  const binding=await bindingHash(env,ctx,nowMs).catch(()=>null)
  if(!binding)return {ok:false,error:'echo_context_unverified'}
  const scopeHash=await hash(scope(ctx));const prior=await latestChallenge(env,ctx,scopeHash)
  const consumed=prior && await env.DB.prepare('SELECT 1 FROM agent_audit WHERE id=?1 LIMIT 1').bind(await hash(`echo-return\n${prior.id}`)).first()
  if(prior && !consumed && prior.value.binding_hash===binding.hash && (numberMs(prior.value.expires_at)??0)>nowMs)
    return {ok:true,state:'pending',message_id:prior.value.message_id,expires_at:prior.value.expires_at,next_step:NEXT}
  const nonce=crypto.randomUUID();const id=await hash(`echo-challenge\n${scopeHash}\n${crypto.randomUUID()}`)
  const challenge:Challenge={created_at:iso(nowMs),expires_at:iso(nowMs+TEN_MINUTES),nonce_hash:await hash(nonce),message_id:'',scope_hash:scopeHash,binding_hash:binding.hash}
  if(!await writeAudit(env,id,ctx,'connection_echo_challenge',challenge))return {ok:false,error:'echo_challenge_audit_failed'}
  const sent=await sendAgentMessage(env,{fromAgent:ONBOARDING_SENDER,fromMember:ctx.memberId,toAgent:ctx.agentId,kind:'message',
    requestId:`connection-echo:${id}`,body:`connection_echo: return this nonce from your own inbox: ${nonce}`},
    {system:true,reason:'server-resolved own-agent inbox echo'},{now:()=>iso(nowMs)})
  if(!sent.ok)return {ok:false,error:'echo_challenge_send_failed'}
  challenge.message_id=sent.id
  if(!await writeAudit(env,id+':ready',ctx,'connection_echo_ready',challenge))return {ok:false,error:'echo_challenge_audit_failed'}
  return {ok:true,state:'pending',message_id:sent.id,expires_at:challenge.expires_at,next_step:NEXT}
}

export async function finishConnectionEcho(env:Env,ctx:ConnectionEchoContext,nonce:string,nowMs=Date.now()):Promise<
  {ok:true;state:'echo_roundtrip';echo_returned_at:string;path:'inbox_echo';latency_ms:number;reason:'echo_returned'}|{ok:false;error:string}
> {
  const binding=await bindingHash(env,ctx,nowMs).catch(()=>null)
  if(!binding)return {ok:false,error:'echo_context_unverified'}
  const found=await latestChallenge(env,ctx,await hash(scope(ctx)))
  if(!found || found.value.binding_hash!==binding.hash)return {ok:false,error:'echo_challenge_not_found'}
  const issued=numberMs(found.value.created_at);const expires=numberMs(found.value.expires_at)
  if(issued===null || expires===null || nowMs>=expires || nowMs<issued)return {ok:false,error:'echo_challenge_expired'}
  if(await hash(nonce)!==found.value.nonce_hash)return {ok:false,error:'echo_nonce_invalid'}
  const id=await hash(`echo-return\n${found.id}`)
  if(await env.DB.prepare('SELECT 1 FROM agent_audit WHERE id=?1 LIMIT 1').bind(id).first())return {ok:false,error:'echo_challenge_replayed'}
  const returned:EchoRecord={state:'echo_roundtrip',created_at:iso(nowMs),echo_returned_at:iso(nowMs),path:'inbox_echo',latency_ms:nowMs-issued,binding_hash:binding.hash,context:ctx}
  if(!await writeAudit(env,id,ctx,'connection_echo_returned',{...returned,challenge_id:found.id,message_id:found.value.message_id},{binding,now:iso(nowMs)}))return {ok:false,error:'echo_record_failed'}
  return {ok:true,state:'echo_roundtrip',echo_returned_at:returned.echo_returned_at,path:'inbox_echo',latency_ms:returned.latency_ms,reason:'echo_returned'}
}

export async function loadConnectionEcho(env:Env,query:{agentId:string;credentialId?:string;harnessId?:string|null;attachmentId?:string|null},nowMs=Date.now()):Promise<ConnectionEchoStatus> {
  const absent=(reason:string):ConnectionEchoStatus=>({state:'not_returned',echo_returned_at:null,path:null,latency_ms:null,reason})
  try {
    const row=await env.DB.prepare("SELECT after_state FROM agent_audit WHERE agent_id=?1 AND action='connection_echo_returned' ORDER BY seq DESC LIMIT 1").bind(query.agentId).first<{after_state:string}>()
    const returned=row?parse<EchoRecord>(row.after_state):null
    if(!returned || returned.state!=='echo_roundtrip')return absent('no_echo_return')
    const stored=returned.context
    if(!stored || stored.agentId!==query.agentId || (query.credentialId && query.credentialId!==stored.credentialId)
      || (query.harnessId!==undefined && query.harnessId!==(stored.harnessId??null))
      || (query.attachmentId!==undefined && query.attachmentId!==(stored.attachmentId??null)))return absent('echo_context_unverified')
    const live=await env.DB.prepare(`SELECT t.member_id FROM member_tokens t WHERE t.tenant=?1 AND t.id=?2 AND t.agent_id=?3 AND ${TOKEN_LIVE_PREDICATE('?4')} LIMIT 1`)
      .bind(env.TENANT_SLUG,stored.credentialId,query.agentId,iso(nowMs)).first<{member_id:string}>()
    if(!live)return absent('echo_context_unverified')
    const current=await bindingHash(env,{...stored,memberId:live.member_id},nowMs)
    if(!current || current.hash!==returned.binding_hash)return absent('echo_binding_changed')
    const at=numberMs(returned.echo_returned_at)
    if(at===null || nowMs<at || !Number.isFinite(returned.latency_ms) || returned.latency_ms<0)return absent('echo_record_unverified')
    const state=nowMs-at>=SEVEN_DAYS?'stale':'echo_roundtrip'
    return {state,echo_returned_at:returned.echo_returned_at,path:'inbox_echo',latency_ms:returned.latency_ms,reason:state==='stale'?'echo_stale':'echo_returned'}
  }catch {return absent('echo_status_unavailable')}
}
