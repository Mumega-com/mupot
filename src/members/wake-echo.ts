/**
 * A deliberately narrow wake proof: a nonce response proves only an inbox
 * round-trip until a receipt ties this exact challenge message to a successful
 * transport delivery.  It does not attest that a runtime took a turn.
 */
import type { Env } from '../types'
import { sendAgentMessage } from '../agents/messages'
import { ONBOARDING_SENDER } from '../agents/system-senders'
import { TOKEN_LIVE_PREDICATE } from '../auth/token-lifecycle'
import { eventIdFor } from '../bus/events-delivery'

export interface WakeEchoContext {
  agentId: string
  credentialId: string
  memberId: string
  harnessId?: string | null
  attachmentId?: string | null
}

type WakePath = 'native_wake' | 'push_host' | 'webhook_doorbell' | 'none'
type Challenge = {
  expires_at: string
  created_at: string
  nonce_hash: string
  message_id: string
  scope_hash: string
  binding_hash: string
  challenge_id: string
}
type Proof = {
  state: 'wake_proven' | 'echo_roundtrip'
  wake_proven_at: string | null
  path: WakePath
  delivery_to_reply_ms: number | null
  t0_to_delivery_ms: number | null
  reason: string
  binding_hash: string
  created_at: string
  /** Internal audit-only context. Never copied to the public getter. */
  context: WakeEchoContext
}

const TEN_MINUTES = 10 * 60_000
const SEVEN_DAYS = 7 * 24 * 60 * 60_000

function iso(ms: number): string { return new Date(ms).toISOString() }
async function hash(value: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('')
}
function scope(ctx: WakeEchoContext): string {
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
async function bindingHash(env: Env, ctx: WakeEchoContext, nowMs: number): Promise<Binding | null> {
  const credential = await env.DB.prepare(`SELECT 1 AS x WHERE ${credentialLive({tenant:'?1',token:'?2',member:'?3',agent:'?4',now:'?5'})}`)
    .bind(env.TENANT_SLUG,ctx.credentialId,ctx.memberId,ctx.agentId,iso(nowMs)).first()
  if (!credential) return null
  // Include retained revoked rows too: issuing then revoking a new token must not resurrect an old proof.
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

type ProofFence = { binding: Binding; seq:number; t0:string; deliveryAt:string|null; state:string; now:string }

async function writeAudit(env: Env, id: string, ctx: WakeEchoContext, action: string, after: unknown, fence?: ProofFence): Promise<boolean> {
  try {
    const guard = fence ? ` WHERE ${credentialLive({tenant:'?6',token:'?7',member:'?3',agent:'?2',now:'?8'})}
      AND (SELECT json_group_array(id) FROM (SELECT id FROM member_tokens WHERE tenant=?6 AND agent_id=?2 ORDER BY id ASC LIMIT 1001)) = ?9
      AND (SELECT runtime FROM fleet_agents WHERE tenant=?6 AND agent_id=?2 LIMIT 1) IS ?10
      AND (SELECT COALESCE(MAX(seq),0) FROM agent_audit WHERE agent_id=?2 AND action='fleet_runtime_transition')=?15
      AND (?11 <> 'wake_proven' OR NOT EXISTS (SELECT 1 FROM agent_audit p
        WHERE p.agent_id=?2 AND p.action='connection_wake_inbox_read' AND p.seq>?12
          AND (NOT json_valid(p.after_state) OR julianday(json_extract(CASE WHEN json_valid(p.after_state) THEN p.after_state ELSE '{}' END,'$.observed_at')) IS NULL
            OR (julianday(json_extract(p.after_state,'$.observed_at'))>=julianday(?13)
              AND julianday(json_extract(p.after_state,'$.observed_at'))<julianday(?14)))))` : ''
    const stmt = env.DB.prepare(`INSERT INTO agent_audit (id,agent_id,actor_id,actor_type,action,fields_changed,before_state,after_state)
      SELECT ?1,?2,?3,'system',?4,'["connection_wake"]','{}',?5${guard}`)
    const common = [id,ctx.agentId,ctx.memberId,action,JSON.stringify(after)]
    const result = await stmt.bind(...common,...(fence ? [env.TENANT_SLUG,ctx.credentialId,fence.now,JSON.stringify(fence.binding.tokens),fence.binding.runtime,fence.state,fence.seq,fence.t0,fence.deliveryAt,fence.binding.runtimeSeq] : [])).run()
    return Number(result.meta.changes) === 1
  } catch { return false }
}

async function latestChallenge(env: Env, ctx: WakeEchoContext, scopeHash: string): Promise<{ seq: number; id: string; value: Challenge } | null> {
  const rows = await env.DB.prepare(
    `SELECT c.seq,c.id,r.after_state FROM agent_audit c JOIN agent_audit r ON r.id=c.id||':ready' AND r.action='connection_wake_ready' AND r.agent_id=c.agent_id WHERE c.agent_id=?1 AND c.actor_id=?2 AND c.action='connection_wake_challenge' ORDER BY c.seq DESC LIMIT 40`,
  ).bind(ctx.agentId, ctx.memberId).all<{ seq: number; id: string; after_state: string }>()
  for (const row of rows.results ?? []) {
    const value = parse<Challenge>(row.after_state)
    if (value?.scope_hash === scopeHash && typeof value.nonce_hash === 'string') return { seq: Number(row.seq), id: row.id, value }
  }
  return null
}

export async function startWakeEcho(env: Env, ctx: WakeEchoContext, nowMs = Date.now()): Promise<
  | { ok: true; state: 'pending'; message_id: string; expires_at: string; next_step: string }
  | { ok: false; error: string }
> {
  const binding = await bindingHash(env, ctx, nowMs).catch(() => null)
  if (!binding) return { ok: false, error: 'wake_context_unverified' }
  const scopeHash = await hash(scope(ctx))
  const prior = await latestChallenge(env, ctx, scopeHash)
  const priorConsumed = prior && await env.DB.prepare(`SELECT 1 FROM agent_audit WHERE id = ?1 LIMIT 1`)
    .bind(await hash(`wake-proof\n${prior.id}`)).first()
  if (prior && !priorConsumed && prior.value.binding_hash === binding.hash && numberMs(prior.value.expires_at)! > nowMs) {
    return { ok: true, state: 'pending', message_id: prior.value.message_id, expires_at: prior.value.expires_at, next_step: 'End this turn. After delivery, read your own inbox and call connection_check with echo_reply set to the challenge nonce.' }
  }
  const nonce = crypto.randomUUID()
  const challengeId = await hash(`wake-challenge\n${scopeHash}\n${crypto.randomUUID()}`)
  const challenge: Challenge = {
    expires_at:iso(nowMs+TEN_MINUTES),created_at:iso(nowMs),nonce_hash:await hash(nonce),
    message_id:'',scope_hash:scopeHash,binding_hash:binding.hash,challenge_id:challengeId,
  }
  // Publish the observation window BEFORE exposing the nonce through any message/wake path.
  if (!(await writeAudit(env,challengeId,ctx,'connection_wake_challenge',challenge))) return {ok:false,error:'wake_challenge_audit_failed'}
  const sent = await sendAgentMessage(env, {
    fromAgent:ONBOARDING_SENDER,fromMember:ctx.memberId,toAgent:ctx.agentId,kind:'message',requestId:`wake-echo:${challengeId}`,
    body:`connection_wake_echo: reply with this nonce after your wake delivery: ${nonce}`,
  },{system:true,reason:'server-verified own-agent wake echo challenge'},{now:()=>iso(nowMs)})
  if (!sent.ok) return {ok:false,error:'wake_challenge_send_failed'}
  challenge.message_id=sent.id
  if (!(await writeAudit(env,challengeId+':ready',ctx,'connection_wake_ready',challenge))) return {ok:false,error:'wake_challenge_audit_failed'}
  return { ok: true, state: 'pending', message_id: sent.id, expires_at: challenge.expires_at, next_step: 'End this turn. After delivery, read your own inbox and call connection_check with echo_reply set to the challenge nonce.' }
}

async function delivery(env: Env, ctx: WakeEchoContext, messageId: string, t0: number, reply: number): Promise<{ path: WakePath; at: number|null } | null> {
  let hit:{path:WakePath;at:number|null}|null=null
  const native = await env.DB.prepare(
    `SELECT r.created_at, r.signed_at, r.event_id, s.id AS subscription_id FROM event_delivery_receipts r JOIN event_subscriptions s ON s.id = r.subscription_id
      WHERE s.tenant = ?1 AND s.agent_id = ?2 AND s.event_name = 'message.created' AND s.token_id=?5 AND r.outcome = 'delivered' AND r.http_status BETWEEN 200 AND 299
        AND julianday(r.created_at)>julianday(?3) AND julianday(r.created_at)<julianday(?4) ORDER BY r.created_at ASC LIMIT 20`,
  ).bind(env.TENANT_SLUG, ctx.agentId, iso(t0), iso(reply),ctx.credentialId).all<{ created_at: string; signed_at: string | null; event_id: string; subscription_id: string }>()
  for (const row of native.results ?? []) {
    // Receipt event ids are subscription-specific, so derive and compare rather than trusting a nearby delivery.
    if (await eventIdFor(row.subscription_id, messageId) !== row.event_id) continue
    const signed = numberMs(row.signed_at)
    const at=numberMs(row.created_at)
    if (at===null || !(at>t0 && at<reply) || (row.signed_at!==null && (signed===null || !(signed>=Math.floor(t0/1000)*1000 && signed<=reply)))) continue
    hit={path:'native_wake',at};break
  }
  if(hit) return hit
  // Doorbell success has no completion timestamp: attempted_at cannot bound a no-poll window.
  const doorbell = await env.DB.prepare(
    `SELECT attempted_at, signed_at FROM agent_webhook_doorbell_receipts WHERE tenant = ?1 AND agent_id = ?2
      AND event_type IN ('inbox.wake', 'mupot.inbox.wake') AND ref_id = ?3 AND outcome='posted'
      AND http_status BETWEEN 200 AND 299 AND julianday(attempted_at)>julianday(?4) AND julianday(attempted_at)<julianday(?5) ORDER BY attempted_at ASC LIMIT 1`,
  ).bind(env.TENANT_SLUG, ctx.agentId, messageId, iso(t0), iso(reply)).first<{ attempted_at: string; signed_at: string | null }>()
  if (doorbell) {
    const signed = numberMs(doorbell.signed_at)
    const at=numberMs(doorbell.attempted_at)
    if (at!==null && at>t0 && at<reply && (doorbell.signed_at===null || (signed!==null && signed>=Math.floor(t0/1000)*1000 && signed<=reply))) hit={path:'webhook_doorbell',at:null}
  }
  return hit
}

export async function finishWakeEcho(env: Env, ctx: WakeEchoContext, nonce: string, nowMs = Date.now()): Promise<
  | { ok: true; state: 'wake_proven' | 'echo_roundtrip'; wake_proven_at: string | null; path: WakePath; delivery_to_reply_ms: number | null; t0_to_delivery_ms: number | null; reason: string }
  | { ok: false; error: string }
> {
  const binding = await bindingHash(env, ctx, nowMs).catch(() => null)
  if (!binding) return { ok: false, error: 'wake_context_unverified' }
  const scopeHash = await hash(scope(ctx)); const found = await latestChallenge(env, ctx, scopeHash)
  if (!found || found.value.binding_hash !== binding.hash) return { ok: false, error: 'wake_challenge_not_found' }
  const t0 = numberMs(found.value.created_at); const expires = numberMs(found.value.expires_at)
  if (t0 === null || expires === null || nowMs >= expires || nowMs < t0) return { ok: false, error: 'wake_challenge_expired' }
  if (await hash(nonce) !== found.value.nonce_hash) return { ok: false, error: 'wake_nonce_invalid' }
  const proofId = await hash(`wake-proof\n${found.id}`)
  const existing = await env.DB.prepare(`SELECT 1 FROM agent_audit WHERE id = ?1 LIMIT 1`).bind(proofId).first()
  if (existing) return { ok: false, error: 'wake_challenge_replayed' }
  const hit = await delivery(env, ctx, found.value.message_id, t0, nowMs)
  const read = hit && hit.at!==null && await env.DB.prepare(
    `SELECT 1 FROM agent_audit WHERE agent_id = ?1 AND action = 'connection_wake_inbox_read' AND seq > ?2
      AND (NOT json_valid(after_state) OR julianday(json_extract(CASE WHEN json_valid(after_state) THEN after_state ELSE '{}' END,'$.observed_at')) IS NULL
        OR (julianday(json_extract(after_state,'$.observed_at'))>=julianday(?3) AND julianday(json_extract(after_state,'$.observed_at'))<julianday(?4))) LIMIT 1`,
  ).bind(ctx.agentId, found.seq, iso(t0), iso(hit.at)).first()
  const proof: Proof = hit && hit.at!==null && !read
    ? { state: 'wake_proven', wake_proven_at: iso(nowMs), path: hit.path, delivery_to_reply_ms: nowMs - hit.at, t0_to_delivery_ms: hit.at - t0, reason: 'matching_delivery_receipt', binding_hash: binding.hash, created_at: iso(nowMs), context: ctx }
    : { state: 'echo_roundtrip', wake_proven_at: null, path: hit?.path ?? 'none', delivery_to_reply_ms: hit?.at != null ? nowMs - hit.at : null, t0_to_delivery_ms: hit?.at != null ? hit.at - t0 : null, reason: hit && hit.at===null ? 'delivery_timestamp_unavailable' : read ? 'inbox_read_before_delivery' : 'no_matching_delivery_receipt', binding_hash: binding.hash, created_at: iso(nowMs), context: ctx }
  if (!(await writeAudit(env, proofId, ctx, 'connection_wake_proof', { ...proof, challenge_id: found.id, message_id: found.value.message_id }, {binding,seq:found.seq,t0:iso(t0),deliveryAt:hit?.at!=null?iso(hit.at):null,state:proof.state,now:iso(nowMs)}))) return { ok: false, error: 'wake_proof_audit_failed' }
  return {
    ok: true,
    state: proof.state,
    wake_proven_at: proof.wake_proven_at,
    path: proof.path,
    delivery_to_reply_ms: proof.delivery_to_reply_ms,
    t0_to_delivery_ms: proof.t0_to_delivery_ms,
    reason: proof.reason,
  }
}

export async function loadWakeProof(env: Env, query: { agentId: string; credentialId?: string; harnessId?: string | null; attachmentId?: string | null }, nowMs = Date.now()): Promise<{ evidence_scope:'agent_transport'; runtime_turn_attested:false; state: 'proven' | 'stale' | 'unproven'; wake_proven_at: string | null; path: WakePath; delivery_to_reply_ms: number | null; t0_to_delivery_ms: number | null; reason: string }> {
  try {
  const row = await env.DB.prepare(`SELECT after_state FROM agent_audit WHERE agent_id = ?1 AND action = 'connection_wake_proof' AND json_extract(CASE WHEN json_valid(after_state) THEN after_state ELSE '{}' END,'$.state')='wake_proven' ORDER BY seq DESC LIMIT 1`).bind(query.agentId).first<{ after_state: string }>()
  const proof = row ? parse<Proof>(row.after_state) : null
  if (!proof || proof.state !== 'wake_proven') return { evidence_scope:'agent_transport',runtime_turn_attested:false, state: 'unproven', wake_proven_at: null, path: 'none', delivery_to_reply_ms: null, t0_to_delivery_ms: null, reason: proof?.reason ?? 'no_wake_proof' }
  const stored = proof.context
  if (!stored || stored.agentId !== query.agentId) return { evidence_scope:'agent_transport',runtime_turn_attested:false, state: 'unproven', wake_proven_at: null, path: 'none', delivery_to_reply_ms: null, t0_to_delivery_ms: null, reason: 'wake_context_unverified' }
  if ((query.credentialId && query.credentialId !== stored.credentialId)
    || (query.harnessId !== undefined && query.harnessId !== (stored.harnessId ?? null))
    || (query.attachmentId !== undefined && query.attachmentId !== (stored.attachmentId ?? null))) {
    return { evidence_scope:'agent_transport',runtime_turn_attested:false, state: 'unproven', wake_proven_at: null, path: 'none', delivery_to_reply_ms: null, t0_to_delivery_ms: null, reason: 'wake_context_unverified' }
  }
  const live = await env.DB.prepare(`SELECT member_id FROM member_tokens WHERE tenant = ?1 AND id = ?2 AND agent_id = ?3 AND revoked_at IS NULL LIMIT 1`).bind(env.TENANT_SLUG, stored.credentialId, query.agentId).first<{ member_id: string }>()
  if (!live) return { evidence_scope:'agent_transport',runtime_turn_attested:false, state: 'unproven', wake_proven_at: null, path: 'none', delivery_to_reply_ms: null, t0_to_delivery_ms: null, reason: 'wake_context_unverified' }
  const current = await bindingHash(env, { ...stored, memberId: live.member_id }, nowMs)
  if (!current || current.hash !== proof.binding_hash) return { evidence_scope:'agent_transport',runtime_turn_attested:false, state: 'unproven', wake_proven_at: null, path: 'none', delivery_to_reply_ms: null, t0_to_delivery_ms: null, reason: 'wake_binding_changed' }
  const age = numberMs(proof.created_at)
  if (age === null || nowMs - age >= SEVEN_DAYS) return { evidence_scope:'agent_transport',runtime_turn_attested:false, state: 'stale', wake_proven_at: proof.wake_proven_at, path: proof.path, delivery_to_reply_ms: proof.delivery_to_reply_ms, t0_to_delivery_ms: proof.t0_to_delivery_ms, reason: 'wake_proof_stale' }
  return { evidence_scope:'agent_transport',runtime_turn_attested:false, state: 'proven', wake_proven_at: proof.wake_proven_at, path: proof.path, delivery_to_reply_ms: proof.delivery_to_reply_ms, t0_to_delivery_ms: proof.t0_to_delivery_ms, reason: proof.reason }
  } catch {return { evidence_scope:'agent_transport',runtime_turn_attested:false,state:'unproven',wake_proven_at:null,path:'none',delivery_to_reply_ms:null,t0_to_delivery_ms:null,reason:'wake_proof_unavailable'}}
}
