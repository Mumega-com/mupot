// mupot — squad join requests: an agent ASKS to join a squad, a human admin of THAT squad taps once.
//
// THE DOOR. Before this an agent that wanted into a squad could only say "an admin there can add me by agent id": it
// cannot see other squads and had no way to ask. The tool (src/mcp/squad-join.ts) files a PENDING request and a
// secure-moment link (kind 'squad_join', src/secure-moments); the decision happens on /m/* with a passkey, never in the
// chat. This module is the whole model: file, view, decide.
//
// AUTHORITY (the argument, so a reviewer can attack it):
//   * The ASK grants nothing. A pending row plus a link whose opening decides nothing.
//   * APPROVE needs a passkey of an ACTIVE HUMAN (routes.ts) who, re-derived NOW, is in whoMayApprove(request): `admin` on the
//     TARGET squad by canOnSquad over the member's own grants (the same predicate the seat-attach admission uses). The same
//     function picks who is NOTIFIED (Telegram, with the link), so a human never has to paste a link. canOnSquad already
//     lets org/department admin count where the squad kind allows it and answers false on a kind='home' squad for every
//     inherited plane; on top of that a home target is refused outright (G-FP1b: the only writer of a home capability
//     row is createHomeForMember).
//   * The write is addSquadMember, the SAME function squad_member_add runs (memberships + capability row +
//     membership_receipts), called with the APPROVER's auth: its own rank ceiling, self-grant refusal, the home
//     refusal and receipts apply unchanged. addSquadMember does NOT refuse an archived squad, so this module does (before the
//     gate, and again inside the claim). The request can only ever carry 'member' or 'observer' (column CHECK plus a code
//     check), so nothing it does can reach lead/admin or a gate capability (gates live in gate_grants, which this module
//     never touches). CHECK-THEN-WRITE IS CLOSED BY A CLAIM: the decider first flips the row pending -> approving with ONE guarded
//     UPDATE (still pending, unexpired, squad not archived/home); only the call that changed exactly one row may grant, so a
//     supersede or expiry inside the window can no longer be granted. The grant is raise-only IN ITS SQL (neverLower): a
//     concurrent promotion is never demoted. The row then closes approved|failed in one batch with its audit row.
//   * Segregation of duties: the requesting agent's own welded credential never decides its request. An owner deciding for their
//     own agent is allowed.
//   * Telegram never carries this decision (the Mini App allowlist is seed_attach and elevation only).
//
// THE LINK NEVER GOES TO THE ASKING AGENT. The approval link is a bearer link whose page shows the real squad (name, home or
// archived flags, or "no squad matches"); handing it to the agent would let it read squad names it cannot see. So the link is minted
// here and delivered ONLY to the eligible approvers (notifyApprovers); the agent gets a link-free acknowledgement and learns the
// outcome from its inbox. (The page itself is still a bearer page: whoever holds the link can read it, so the notice goes only to
// approvers and the link is single-use and expires.)
//
// NO EXISTENCE ORACLE. The caller learns nothing about squads it cannot see: the request row, the link and the tool
// reply have the same shape whether the ref names a real squad, a hidden one or nothing. Only the approver's page
// shows what the ref really resolved to.

import type { Env, OrgKind } from '../types'
import { canOnSquad, capabilityRank, resolveCapabilities, CAPABILITY_LIVE_PREDICATE, nowCapabilitySql } from '../auth/capability'
import { resolveSquadRef } from '../org/resolve'
import { issueMomentLink } from '../secure-moments/issue'
import { secureMomentsStatus } from '../secure-moments/config'
import { sendAgentMessage } from '../agents/messages'
import { addSquadMember } from './squad-membership'
import { resolveAgentMemberBinding } from './service'
import { buildAuth, memberIsActiveHuman } from '../access/identity'
import { telegramAdapter } from '../channels/adapters/telegram'
import type { HumanProof, Outcome, WaitUntil, Gate } from '../access/decision-core'

export const SQUAD_JOIN_TTL_MS = 24 * 60 * 60 * 1000
/** Live pending requests one agent may hold across all squads. */
export const SQUAD_JOIN_MAX_PENDING_PER_AGENT = 5
/** Calls (new asks and re-asks alike) one agent may make per hour. */
export const SQUAD_JOIN_MAX_PER_HOUR = 10
export const SQUAD_JOIN_REASON_MAX = 500

export type JoinCapability = 'member' | 'observer'
export const JOIN_CAPABILITIES: readonly JoinCapability[] = ['member', 'observer']

export function isJoinCapability(v: unknown): v is JoinCapability {
  return v === 'member' || v === 'observer'
}

export interface SquadJoinRow {
  id: string
  tenant: string
  agent_id: string
  squad_ref: string
  squad_id: string | null
  squad_key: string
  capability: JoinCapability
  reason: string | null
  requested_via: 'agent' | 'attached_chat'
  status: 'pending' | 'approving' | 'approved' | 'denied' | 'expired' | 'superseded' | 'failed'
  created_at: string
  expires_at: string
  decided_at: string | null
  decided_by_member_id: string | null
  result: 'created' | 'updated' | 'unchanged' | null
  decision_error: string | null
}

const COLUMNS = `id, tenant, agent_id, squad_ref, squad_id, squad_key, capability, reason, requested_via, status, created_at, expires_at,
  decided_at, decided_by_member_id, result, decision_error`

export async function loadSquadJoin(env: Env, id: string): Promise<SquadJoinRow | null> {
  return env.DB.prepare(`SELECT ${COLUMNS} FROM squad_join_requests WHERE id = ?1 AND tenant = ?2 LIMIT 1`)
    .bind(id, env.TENANT_SLUG).first<SquadJoinRow>()
}

export function squadJoinIsPendingLive(row: SquadJoinRow, nowMs: number): boolean {
  return row.status === 'pending' && Date.parse(row.expires_at) > nowMs
}

/** Admin-set or agent-set text headed for a person or a model: one short plain line, no control characters. */
export function oneLine(v: string, max: number): string {
  return v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

// ── the ask ──────────────────────────────────────────────────────────────────

export type FileJoinFailure =
  | 'secure_moments_unavailable'
  | 'agent_inactive'
  | 'agent_is_seat_agent'
  | 'rate_limited'
  | 'too_many_pending_requests'
  | 'link_unavailable'

export type FileJoinResult =
  | { ok: true; expiresAt: string; agentName: string; squadRef: string; capability: JoinCapability }
  | { ok: false; error: FileJoinFailure }

/** One atomic guarded UPSERT per (agent, hour): true iff this call was inside the cap. */
async function underRateLimit(env: Env, agentId: string, nowMs: number): Promise<boolean> {
  const bucket = new Date(nowMs).toISOString().slice(0, 13)
  const r = await env.DB.prepare(
    `INSERT INTO squad_join_rate_limits (tenant, agent_id, bucket, count) VALUES (?1, ?2, ?3, 1)
     ON CONFLICT(tenant, agent_id, bucket) DO UPDATE SET count = count + 1 WHERE count < ?4`,
  ).bind(env.TENANT_SLUG, agentId, bucket, SQUAD_JOIN_MAX_PER_HOUR).run()
  return r.meta.changes === 1
}

async function findPending(env: Env, agentId: string, squadKey: string, nowIso: string): Promise<SquadJoinRow | null> {
  return env.DB.prepare(
    `SELECT ${COLUMNS} FROM squad_join_requests
      WHERE tenant = ?1 AND agent_id = ?2 AND squad_key = ?3 AND status = 'pending' AND expires_at > ?4 LIMIT 1`,
  ).bind(env.TENANT_SLUG, agentId, squadKey, nowIso).first<SquadJoinRow>()
}

/** Is a live pending request for this (agent, ref) already filed? The VIP lane asks BEFORE filing so a repeat join_squad does not
 *  rotate the link and re-notify the approvers (one card, not a second). Same key derivation as fileSquadJoinRequest. */
export async function hasLivePendingJoin(env: Env, agentId: string, squadRef: string, nowMs: number = Date.now()): Promise<boolean> {
  return (await findPending(env, agentId, `ref:${squadRef.trim().toLowerCase()}`, new Date(nowMs).toISOString())) !== null
}

/**
 * A pending request can exist WITHOUT a link (the row was inserted, then issueMomentLink failed). For a pending row with no live
 * moment, make the link now and notify the approvers; with a live moment there is nothing to do (no rotation, no re-notify).
 * 'none' = no live pending row. 'link_pending' = still no link (the caller says so honestly and the next repeat retries).
 */
export async function completePendingJoinCard(
  env: Env, agentId: string, squadRef: string, waitUntil?: WaitUntil, nowMs: number = Date.now(),
): Promise<'complete' | 'link_pending' | 'none'> {
  const row = await findPending(env, agentId, `ref:${squadRef.trim().toLowerCase()}`, new Date(nowMs).toISOString())
  if (!row) return 'none'
  const live = await env.DB.prepare(`SELECT 1 AS x FROM secure_moments WHERE kind = 'squad_join' AND subject_id = ?1 AND status = 'pending' LIMIT 1`).bind(row.id).first<{ x: number }>()
  if (live) return 'complete'
  const agent = await env.DB.prepare(`SELECT name FROM agents WHERE id = ?1 LIMIT 1`).bind(agentId).first<{ name: string }>()
  const link = await issueMomentLink(env, { kind: 'squad_join', subjectId: row.id, requesterAgentId: agentId, subjectExpiresAtIso: row.expires_at })
  if (!link) return 'link_pending'
  const notice = notifyApprovers(env, row, link.url, agent?.name ?? '')
  if (waitUntil) waitUntil(notice)
  else await notice
  return 'complete'
}

/**
 * File (or re-issue) the request and mint its link. Never reveals anything about the squad: the squad is resolved here only
 * to key the dedupe row and to show the APPROVER later. The caller (the tool) has already established WHICH agent is asking
 * from the session, never from args.
 */
export async function fileSquadJoinRequest(
  env: Env,
  p: { agentId: string; squadRef: string; capability: JoinCapability; reason: string | null; via: 'agent' | 'attached_chat'; waitUntil?: WaitUntil;
    /** VIP lane only (join_squad): the asker is a harness SEAT's own agent, which squad_join_request refuses. The approver still decides with a passkey. */
    allowSeatAgent?: boolean },
  nowMs: number = Date.now(),
): Promise<FileJoinResult> {
  if (secureMomentsStatus(env).state !== 'on') return { ok: false, error: 'secure_moments_unavailable' }
  const agent = await env.DB.prepare(`SELECT name, status FROM agents WHERE id = ?1 LIMIT 1`).bind(p.agentId).first<{ name: string; status: string }>()
  if (!agent || agent.status !== 'active') return { ok: false, error: 'agent_inactive' }
  const seatAgent = await env.DB.prepare(`SELECT 1 AS x FROM agent_seats WHERE agent_id = ?1 LIMIT 1`).bind(p.agentId).first<{ x: number }>()
  if (seatAgent && !p.allowSeatAgent) return { ok: false, error: 'agent_is_seat_agent' }
  if (!(await underRateLimit(env, p.agentId, nowMs))) return { ok: false, error: 'rate_limited' }

  const nowIso = new Date(nowMs).toISOString()
  const resolved = await resolveSquadRef(env, p.squadRef)
  const squadId = resolved.ok ? resolved.value.id : null
  // The dedupe key is the normalized ref the CALLER sent, never the resolved id: it must not differ between a squad that exists
  // and one that does not (that difference was an existence oracle through the pending cap and the re-ask path).
  const squadKey = `ref:${p.squadRef.trim().toLowerCase()}`
  // A pending row past its expiry must not hold the unique slot.
  await env.DB.prepare(
    `UPDATE squad_join_requests SET status = 'expired' WHERE tenant = ?1 AND agent_id = ?2 AND squad_key = ?3 AND status = 'pending' AND expires_at <= ?4`,
  ).bind(env.TENANT_SLUG, p.agentId, squadKey, nowIso).run()

  let row = await findPending(env, p.agentId, squadKey, nowIso)
  const same = (r: SquadJoinRow): boolean => r.capability === p.capability && (r.reason ?? null) === p.reason && r.squad_ref === p.squadRef
  if (!row || !same(row)) {
    // What is being asked changed (or nothing is pending): supersede the old row and file a fresh one in ONE batch, so the
    // link the human may be holding can never approve something other than what was asked when it was issued.
    const id = crypto.randomUUID()
    const expiresAt = new Date(nowMs + SQUAD_JOIN_TTL_MS).toISOString()
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE squad_join_requests SET status = 'superseded'
          WHERE tenant = ?1 AND agent_id = ?2 AND squad_key = ?3 AND status = 'pending'`,
      ).bind(env.TENANT_SLUG, p.agentId, squadKey),
      env.DB.prepare(
        `INSERT INTO squad_join_requests
           (id, tenant, agent_id, squad_ref, squad_id, squad_key, capability, reason, requested_via, status, created_at, expires_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending', ?10, ?11
          WHERE (SELECT COUNT(*) FROM squad_join_requests
                  WHERE tenant = ?2 AND agent_id = ?3 AND status = 'pending' AND expires_at > ?10) < ?12
         ON CONFLICT DO NOTHING`,
      ).bind(id, env.TENANT_SLUG, p.agentId, p.squadRef, squadId, squadKey, p.capability, p.reason, p.via, nowIso, expiresAt, SQUAD_JOIN_MAX_PENDING_PER_AGENT),
    ])
    row = await findPending(env, p.agentId, squadKey, nowIso)
    if (!row || !same(row)) return { ok: false, error: 'too_many_pending_requests' }
  }
  // A re-ask rotates the link (only a hash is stored; a lost link must be replaceable; the old one dies).
  const link = await issueMomentLink(env, { kind: 'squad_join', subjectId: row.id, requesterAgentId: p.agentId, subjectExpiresAtIso: row.expires_at })
  if (!link) return { ok: false, error: 'link_unavailable' }
  // Off the response path: whether anyone is notified (and how many Telegram calls that takes) must not show in the latency.
  // Without a hosting waitUntil (a bare test call) it runs inline.
  const notice = notifyApprovers(env, row, link.url, agent.name)
  if (p.waitUntil) p.waitUntil(notice)
  else await notice
  return { ok: true, expiresAt: link.expiresAt, agentName: agent.name, squadRef: p.squadRef, capability: p.capability }
}

// ── who may approve (ONE derivation: the approval check, the notice and any future Ask/Telegram surface use it) ──

/** At most this many approvers are NOTIFIED. The approval CHECK is never capped (it asks about one member directly), so a
 *  member beyond the cap can still approve with a link passed to them; the cap only fails closed on who gets a Telegram message. */
const APPROVER_SCAN_LIMIT = 200
const NOTIFY_MAX_APPROVERS = 10

interface ApproverTarget { id: string; department_id: string }

/** The squad an approver could decide for: null for an unresolved, home or archived target (nobody could ever approve it). */
async function approverTarget(env: Env, squadId: string | null): Promise<ApproverTarget | null> {
  if (!squadId) return null
  const sq = await env.DB.prepare(`SELECT id, department_id, kind, status FROM squads WHERE id = ?1 LIMIT 1`)
    .bind(squadId).first<{ id: string; department_id: string; kind: OrgKind; status: string }>()
  return !sq || sq.kind === 'home' || sq.status === 'archived' ? null : { id: sq.id, department_id: sq.department_id }
}

/** THE eligibility predicate for one member: an ACTIVE HUMAN (never an agent's welded member) who is admin on the target by canOnSquad. */
async function eligibleApprover(env: Env, sq: ApproverTarget, memberId: string): Promise<boolean> {
  if (!(await memberIsActiveHuman(env, memberId))) return false
  return canOnSquad(env, await resolveCapabilities(env, memberId), sq.id, 'admin')
}

/** Is this one member an eligible approver right now (uncapped)? The approval check. */
export async function memberMayApprove(env: Env, req: Pick<SquadJoinRow, 'squad_id'>, memberId: string): Promise<boolean> {
  const sq = await approverTarget(env, req.squad_id)
  return sq !== null && (await eligibleApprover(env, sq, memberId))
}

/**
 * The ACTIVE HUMAN members who may approve this request RIGHT NOW (up to APPROVER_SCAN_LIMIT candidates): admin on the TARGET
 * squad by canOnSquad over each member's own grants. That is squad admins of that squad, plus department/org admin or owner only
 * where canOnSquad already counts them for this squad kind. A closed target has NO approvers. Used for the notice; the approval
 * check uses the same per-member predicate (memberMayApprove).
 */
export async function whoMayApprove(env: Env, req: Pick<SquadJoinRow, 'squad_id'>): Promise<string[]> {
  const sq = await approverTarget(env, req.squad_id)
  if (!sq) return []
  // Candidates: anyone holding an admin-or-better row on a scope that could reach this squad. eligibleApprover is the authority.
  const rows = await env.DB.prepare(
    `SELECT DISTINCT c.member_id AS member_id
       FROM capabilities c JOIN members m ON m.id = c.member_id AND m.tenant = ?1 AND m.status = 'active'
      WHERE c.capability IN ('admin', 'owner')
        AND ${CAPABILITY_LIVE_PREDICATE('c', '?5')}
        AND (c.scope_type = 'org' OR (c.scope_type = 'department' AND c.scope_id = ?2) OR (c.scope_type = 'squad' AND c.scope_id = ?3))
      UNION
     -- channel-derived squad grants count exactly as resolveCapabilities counts them
     SELECT ccg.member_id AS member_id
       FROM channel_capability_grants ccg JOIN members m ON m.id = ccg.member_id AND m.tenant = ?1 AND m.status = 'active'
      WHERE ccg.squad_id = ?3 AND ccg.capability IN ('admin', 'owner')
      ORDER BY member_id LIMIT ?4`,
  ).bind(env.TENANT_SLUG, sq.department_id, sq.id, APPROVER_SCAN_LIMIT, nowCapabilitySql()).all<{ member_id: string }>()
  const out: string[] = []
  for (const r of rows.results ?? []) if (await eligibleApprover(env, sq, r.member_id)) out.push(r.member_id)
  return out
}

const TG_PRIVATE_CHAT = /^[1-9][0-9]{0,15}$/
const TG_NOTICE_TIMEOUT_MS = 4000

/**
 * Tell the eligible approvers, so no human has to paste anything: a plain Telegram message from the notification bot to each
 * approver's own bound private chat, carrying the one-time link. The link decides nothing (it needs a passkey of an admin of
 * that squad, and Telegram cannot approve). Fixed English; the only variable text is names written by org admins, reduced to
 * one line. The agent's free-text reason is NOT included. Best effort by design: a failed notice never fails the request, and
 * the reply to the agent is identical whatever was or was not sent (no oracle through this channel).
 */
async function notifyApprovers(env: Env, req: SquadJoinRow, link: string, agentName: string): Promise<void> {
  try {
    const approvers = (await whoMayApprove(env, req)).slice(0, NOTIFY_MAX_APPROVERS)
    if (approvers.length === 0) return
    const sq = await env.DB.prepare(`SELECT name FROM squads WHERE id = ?1 LIMIT 1`).bind(req.squad_id).first<{ name: string }>()
    const text = [
      `mupot: ${oneLine(agentName, 60)} asked to join the squad "${oneLine(sq?.name ?? '', 64)}" as ${req.capability}.`,
      `You are an admin of that squad. To decide, open this link in your browser and tap your passkey (it cannot be approved from Telegram). It works once and expires ${req.expires_at}.`,
      link,
    ].join('\n')
    for (const id of approvers) {
      const m = await env.DB.prepare(`SELECT telegram_chat_id FROM members WHERE id = ?1 AND tenant = ?2 LIMIT 1`)
        .bind(id, env.TENANT_SLUG).first<{ telegram_chat_id: string | null }>()
      const chat = m?.telegram_chat_id ?? null
      if (!chat || !TG_PRIVATE_CHAT.test(chat)) continue
      await Promise.race([
        telegramAdapter.post(env, chat, text).catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, TG_NOTICE_TIMEOUT_MS)),
      ])
    }
  } catch {
    // best effort
  }
}

// ── what the approver sees ───────────────────────────────────────────────────

export interface SquadJoinView {
  agentName: string
  agentSlug: string
  agentActive: boolean
  squad: { id: string; department_id: string; name: string; slug: string; kind: OrgKind; archived: boolean } | null
  squadRef: string
}

export async function squadJoinView(env: Env, req: SquadJoinRow): Promise<SquadJoinView> {
  const a = await env.DB.prepare(`SELECT name, slug, status FROM agents WHERE id = ?1 LIMIT 1`).bind(req.agent_id).first<{ name: string; slug: string; status: string }>()
  const s = req.squad_id
    ? await env.DB.prepare(`SELECT id, department_id, name, slug, kind, status FROM squads WHERE id = ?1 LIMIT 1`).bind(req.squad_id).first<{ id: string; department_id: string; name: string; slug: string; kind: OrgKind; status: string }>()
    : null
  return {
    agentName: a?.name ?? req.agent_id,
    agentSlug: a?.slug ?? '',
    agentActive: a?.status === 'active',
    squad: s ? { id: s.id, department_id: s.department_id, name: s.name, slug: s.slug, kind: s.kind, archived: s.status === 'archived' } : null,
    squadRef: req.squad_ref,
  }
}

// ── the decision (channel-neutral core for kind 'squad_join') ────────────────

const CLOSED: Outcome = { status: 409, title: 'Request closed', message: 'This request is no longer pending.', tone: 'warn' }
const NOT_ALLOWED: Outcome = { status: 403, title: 'Not allowed', message: 'This passkey belongs to a member who may not decide this request.', tone: 'bad' }

// Same contract as durably() in access/decision-core (not imported: see seat-attach.ts).
function durablyLocal<T>(waitUntil: WaitUntil | undefined, fn: () => Promise<T>): Promise<T> {
  const p = fn()
  if (waitUntil) waitUntil(p.then(() => undefined, () => undefined))
  return p
}

function auditInsert(env: Env, agentId: string, actorId: string, action: string, after: Record<string, unknown>, guardSql: string, guardBinds: unknown[]) {
  // INSERT ... SELECT ... WHERE <guard>: the audit row exists only when the state it records is true.
  return env.DB.prepare(
    `INSERT INTO agent_audit (id, agent_id, actor_id, actor_type, action, fields_changed, before_state, after_state)
     SELECT ?1, ?2, ?3, 'user', ?4, '["squad_join"]', '{}', ?5 WHERE ${guardSql}`,
  ).bind(crypto.randomUUID(), agentId, actorId, action, JSON.stringify(after), ...guardBinds)
}

async function notifyAgent(env: Env, req: SquadJoinRow, deciderId: string, body: string, kind: string, waitUntil?: WaitUntil): Promise<void> {
  try {
    const from = env.TENANT_SLUG ? `mupot-${env.TENANT_SLUG}-hq` : 'mupot-hq'
    await sendAgentMessage(
      env,
      { fromAgent: from, fromMember: deciderId, toAgent: req.agent_id, kind: 'message', body, requestId: `squad-join:${req.id}:${kind}` },
      { system: true, reason: 'recipient is the requesting agent itself, taken from the request row (never caller input)' },
      { waitUntil },
    )
  } catch {
    // The decision already landed; a failed notice must not turn it into an error. The agent can ask again to learn the state.
  }
}

/** Standing is re-derived NOW from the one approver derivation (a passkey proves who, never what). */
async function mayApprove(env: Env, req: SquadJoinRow, memberId: string): Promise<boolean> {
  return memberMayApprove(env, req, memberId)
}

/** Segregation of duties: the request's own agent (its welded member credential) never decides its own request. An owner deciding
 *  for their own agent is fine; this refuses only the agent itself. */
async function isRequestersOwnCredential(env: Env, req: SquadJoinRow, memberId: string): Promise<boolean> {
  const own = await env.DB.prepare(`SELECT 1 AS x FROM agent_member_bindings WHERE tenant = ?1 AND agent_id = ?2 AND member_id = ?3 LIMIT 1`)
    .bind(env.TENANT_SLUG, req.agent_id, memberId).first<{ x: number }>()
  return !!own
}

/**
 * The passkey-verified human decides a request. EVERY refusable check runs BEFORE the one-time gate (a refusal never burns the
 * link). Deny needs the same standing, except for a request nobody could ever approve (unresolved or home target), which any
 * active human holding the link may close.
 */
export async function decideSquadJoin(
  env: Env,
  input: { req: SquadJoinRow; decision: 'approve' | 'deny'; proof: HumanProof; gate: Gate; waitUntil?: WaitUntil },
  nowMs: number,
): Promise<Outcome> {
  const { req, decision, proof } = input
  if (await isRequestersOwnCredential(env, req, proof.memberId)) return NOT_ALLOWED
  const nowIso = new Date(nowMs).toISOString()
  const view = await squadJoinView(env, req)
  const squad = view.squad
  const approvable = squad !== null && squad.kind !== 'home' && !squad.archived

  if (decision === 'deny') {
    if (approvable && !(await mayApprove(env, req, proof.memberId))) return NOT_ALLOWED
    return durablyLocal(input.waitUntil, async (): Promise<Outcome> => {
      if (!(await input.gate())) return CLOSED
      const out = await env.DB.batch([
        env.DB.prepare(
          `UPDATE squad_join_requests SET status = 'denied', decided_at = ?2, decided_by_member_id = ?3, decided_via = 'webauthn'
            WHERE id = ?1 AND tenant = ?4 AND status = 'pending' AND expires_at > ?2`,
        ).bind(req.id, nowIso, proof.memberId, env.TENANT_SLUG),
        auditInsert(env, req.agent_id, proof.memberId, 'squad_join_deny', { request_id: req.id, squad_ref: req.squad_ref, squad_id: req.squad_id, capability: req.capability },
          `EXISTS (SELECT 1 FROM squad_join_requests WHERE id = ?6 AND status = 'denied' AND decided_at = ?7)`, [req.id, nowIso]),
      ])
      if (out[0].meta.changes !== 1) return CLOSED
      await notifyAgent(env, req, proof.memberId, `mupot: your request to join "${oneLine(req.squad_ref, 64)}" was DENIED by a human. Nothing changed. Do not ask again unless your human tells you to.`, 'denied', input.waitUntil)
      return { status: 200, title: 'Denied', message: 'Nothing was added. The agent has been told.', tone: 'ok' }
    })
  }

  // approve: refusals first, none of which burns the link.
  if (!squad) return { status: 409, title: 'Cannot approve', message: `No squad matches "${oneLine(req.squad_ref, 64)}", so there is nothing to join. You can deny this request.`, tone: 'warn' }
  if (squad.kind === 'home') return { status: 409, title: 'Cannot approve', message: 'A home squad is private to its member and cannot be joined by request. You can deny this request.', tone: 'warn' }
  if (squad.archived) return { status: 409, title: 'Cannot approve', message: 'That squad is archived.', tone: 'warn' }
  if (!isJoinCapability(req.capability)) return { status: 409, title: 'Cannot approve', message: 'This request asks for more than a join request may grant.', tone: 'warn' }
  if (!(await mayApprove(env, req, proof.memberId))) return NOT_ALLOWED
  if (!view.agentActive) return { status: 409, title: 'Cannot approve', message: 'The agent is no longer active.', tone: 'warn' }
  const binding = await resolveAgentMemberBinding(env, req.agent_id)
  if (binding.kind !== 'bound') return { status: 409, title: 'Cannot approve', message: "The agent's identity is not usable right now, so it cannot be added to a squad.", tone: 'warn' }
  const current = await env.DB.prepare(`SELECT capability FROM memberships WHERE agent_id = ?1 AND squad_id = ?2 LIMIT 1`)
    .bind(req.agent_id, squad.id).first<{ capability: string }>()
  // `already` needs BOTH planes: the membership AND a LIVE capability row for the bound seat on this squad. A lapsed
  // capability (an expired elevation) must not make the approval a no-op that reports success while granting nothing.
  const liveCap = await env.DB.prepare(
    `SELECT capability FROM capabilities
      WHERE member_id = ?1 AND scope_type = 'squad' AND scope_id = ?2 AND ${CAPABILITY_LIVE_PREDICATE('', '?3')} LIMIT 1`,
  ).bind(binding.memberId, squad.id, nowCapabilitySql()).first<{ capability: string }>()
  const already = current !== null
    && capabilityRank(current.capability as Parameters<typeof capabilityRank>[0]) >= capabilityRank(req.capability)
    && liveCap !== null
    && capabilityRank(liveCap.capability as Parameters<typeof capabilityRank>[0]) >= capabilityRank(req.capability)

  return durablyLocal(input.waitUntil, async (): Promise<Outcome> => {
    if (!(await input.gate())) return CLOSED
    // CLAIM the request before any grant: one guarded UPDATE, and only the call that changed exactly one row may write. A
    // supersede, an expiry, a deny or an archive that landed after the checks above makes this change nothing, so nothing is granted.
    const claim = await env.DB.prepare(
      `UPDATE squad_join_requests SET status = 'approving', decided_at = ?2, decided_by_member_id = ?3, decided_via = 'webauthn'
        WHERE id = ?1 AND tenant = ?4 AND status = 'pending' AND expires_at > ?2
          AND EXISTS (SELECT 1 FROM squads sq WHERE sq.id = squad_join_requests.squad_id AND sq.status <> 'archived' AND sq.kind <> 'home')`,
    ).bind(req.id, nowIso, proof.memberId, env.TENANT_SLUG).run()
    if (claim.meta.changes !== 1) return CLOSED
    let result: 'created' | 'updated' | 'unchanged' = 'unchanged'
    let failure: string | null = null
    if (!already) {
      // The approver's own auth: addSquadMember re-applies its rank ceiling, self-grant and home refusals. neverLower puts the
      // rank predicate in the write itself.
      const auth = await buildAuth(env, proof.memberId)
      const out = await addSquadMember({
        env,
        auth: { ...auth, capabilities: await resolveCapabilities(env, proof.memberId) },
        agentId: req.agent_id,
        squad: { id: squad.id, department_id: squad.department_id, kind: squad.kind },
        capability: req.capability,
        neverLower: true,
        via: 'squad_join',
      })
      if (out.ok) result = out.result
      else {
        // A raise-only upsert that found the agent already at/above the asked level (a concurrent promotion) writes nothing and
        // reads as receipt_failed: that is success-unchanged, not a failure.
        const now = await env.DB.prepare(`SELECT capability FROM memberships WHERE agent_id = ?1 AND squad_id = ?2 LIMIT 1`).bind(req.agent_id, squad.id).first<{ capability: string }>()
        if (out.error === 'receipt_failed' && now && capabilityRank(now.capability as Parameters<typeof capabilityRank>[0]) >= capabilityRank(req.capability)) result = 'unchanged'
        else failure = out.error
      }
    }
    const status = failure ? 'failed' : 'approved'
    const out = await env.DB.batch([
      env.DB.prepare(
        `UPDATE squad_join_requests SET status = ?5, result = ?6, decision_error = ?7
          WHERE id = ?1 AND tenant = ?4 AND status = 'approving' AND decided_by_member_id = ?3`,
      ).bind(req.id, nowIso, proof.memberId, env.TENANT_SLUG, status, failure ? null : result, failure),
      auditInsert(env, req.agent_id, proof.memberId, failure ? 'squad_join_failed' : 'squad_join_approve',
        { request_id: req.id, squad_id: squad.id, capability: req.capability, result, ...(failure ? { error: failure } : {}) },
        `EXISTS (SELECT 1 FROM squad_join_requests WHERE id = ?6 AND status = ?8 AND decided_at = ?7)`, [req.id, nowIso, status]),
    ])
    if (out[0].meta.changes !== 1) return CLOSED
    if (failure) {
      await notifyAgent(env, req, proof.memberId, `mupot: a human approved your request to join "${oneLine(squad.name, 64)}" but it could not be completed (${failure}). Nothing changed. Ask your human to add you with squad_member_add.`, 'failed', input.waitUntil)
      return { status: 409, title: 'Could not add', message: `The agent could not be added (${failure}). Nothing was changed.`, tone: 'warn' }
    }
    await notifyAgent(env, req, proof.memberId, `mupot: your request to join "${oneLine(squad.name, 64)}" was APPROVED by a human: you ${result === 'unchanged' ? 'already hold' : 'now hold'} ${result === 'unchanged' ? (current?.capability ?? req.capability) : req.capability} access on that squad. Call boot_context to see it.`, 'approved', input.waitUntil)
    return {
      status: 200, title: 'Approved', tone: 'ok',
      message: result === 'unchanged'
        ? `${view.agentName} already has ${current?.capability ?? req.capability} access to ${squad.name}; nothing was changed. The agent has been told.`
        : `${view.agentName} is now ${req.capability} of ${squad.name}. The agent has been told.`,
    }
  })
}
