// mupot W2 — seat_attach: a THREAD (an agent_seats row, auto or seat_select) acts AS an existing named agent.
//
// PROBLEM. One OAuth harness grant (ChatGPT, claude.ai, Grok, Cursor) serves many threads. Binding the grant to one
// agent collapses every chat into that agent; the per-thread seat agents (seat-auto.ts / seat-select.ts) fix the
// collapse but are throwaway agents, not Rava or hadi-admin. This module lets a thread ATTACH to an agent that
// already exists, statefully, without ever binding the grant itself.
//
// MODEL (migration 0220).
//   * ADMISSION (agent_seat_admissions): the HUMAN's explicit, once-per-(agent, human, harness) permission. Created
//     'pending' by the seat_attach tool (a thread can only ASK) and decided by the human: a passkey tap on a secure
//     moment (kind 'seat_admit', src/secure-moments/routes.ts) or the dashboard Connections page. Only a 'live'
//     admission authorises anything. Revoke is a timestamp.
//   * ATTACHMENT (agent_seat_attachments): one thread acting as one admitted agent. At most one live attachment per
//     seat. It carries its own server-held directory token for the agent's welded member (raw secret discarded), so
//     agent sessions and revocation sweeps see a normal credential per thread.
//   * PINNED: a seat with a live attachment is never an auto-pool reclaim victim (prepareAutoSeatReclaim).
//
// THE ONE CHOKEPOINT. `findLiveAttachment` is the single place a request's admission is checked: ONE statement that
// requires the attachment live, the admission LIVE and for the same (agent, human, harness), the seat un-retired
// and the human's grant live + unbound, the agent active and welded, its token live. buildSeatContext (the single
// place every seat context is built) calls it; no reader re-derives any of this. Revoking an admission or detaching
// takes effect on the very next request of every thread.
//
// AUTHORITY. The attached context is the SAME clamp every seat has (resolveSeatCapabilities): per scope
// min(human live rank, agent rank, the CEILING the human approved: member by default, lead or full only if chosen), human
// must be admin on the agent's squad. It never exceeds that ceiling,
// never gains the agent's gate authority (see callerHoldsGateCapability), and never reaches another member's agent:
// the attachable set is "agents on a squad the human administers", excluding any pool-managed seat agent (and, with
// SEAT_ATTACH_DESIGNATED on, only agents an org admin designated for this human: attachDesignatedClause).
//
// TRUST BOUNDARY. A thread's client key is a SELECTOR (seat-auto.ts). Under that stance whoever holds the harness
// grant can act as any of its threads; what attach adds is that reaching an agent needs the human's one-time
// admission, and an attached thread cannot hop (seat_attach refuses an already-attached or non-seat session; a move
// is a human act on the dashboard).
//
// FLAG: SEAT_ATTACH === '1' AND SEAT_AUTO_ENROLL === '1'. Off -> nothing here reads or writes.

import type { D1PreparedStatement } from '@cloudflare/workers-types'
import type { Env } from '../types'
import { timingSafeEqual } from '../lib/crypto'
import { TOKEN_LIVE_PREDICATE, nowSqlUtc } from '../auth/token-lifecycle'
import { canOnSquad, resolveCapabilities } from '../auth/capability'

import { mintRawToken, prepareConditionalIdentityWeld, resolveAgentMemberBinding, sha256Hex } from './service'
import { issueMomentLink } from '../secure-moments/issue'
import type { HumanProof, Outcome, WaitUntil, Gate } from '../access/decision-core'
import { type AttachCeiling } from '../auth/attached-ceiling'
import { sanitizeLabel } from './harness'

// The flag predicates and the designation clause live in the leaf module attach-designated.ts (no heavy imports), so the
// events / elevation readers can use the SAME predicate without pulling this module's graph. Re-exported here unchanged.
export { seatAttachEnabled, seatAttachDesignatedEnabled, attachDesignatedClause, ADMISSION_BOUND_TO_SEAT_SQL } from './attach-designated'
import { attachDesignatedClause, seatAttachEnabled, ADMISSION_BOUND_TO_SEAT_SQL } from './attach-designated'

/** An attached thread unused this long is detached (and unpinned) when its app's thread pool is full. */
export const ATTACH_IDLE_DAYS = 30
export const ADMISSION_PENDING_TTL_MS = 24 * 60 * 60 * 1000
/** Live pending admissions one human may hold: a flood cap, so a thread cannot bury the real ask. */
export const ADMISSION_MAX_PENDING_PER_HUMAN = 10
/** last_used_at is bookkeeping: refresh at most this often. */
export const ATTACHMENT_TOUCH_INTERVAL_MS = 10 * 60 * 1000

export type AttachFailure =
  | 'seat_attach_disabled'
  | 'seat_required'
  | 'already_attached'
  | 'invalid_args'
  | 'agent_not_found'
  | 'agent_ambiguous'
  | 'agent_identity_unminted'
  | 'seat_not_found'
  | 'too_many_pending_admissions'
  | 'attach_refused'
  | 'attach_code_mismatch'
  | 'approval_bound_to_other_chat'

export interface AttachableAgent {
  id: string
  slug: string
  name: string
  squad_id: string
  squad_name: string
}

// ── agents a human may attach to ─────────────────────────────────────────────

interface AgentCandidate { id: string; slug: string; name: string; squad_id: string; squad_name: string }

/**
 * The agents this human may attach a thread to: ACTIVE, NOT a pool-managed seat, and either welded (active member binding) or
 * identity-only (NO binding row yet: admitting it welds the identity, see promoteAdmission). A binding whose member is suspended
 * is neither, so it stays out. NOT a pool-managed seat
 * agent, and on a squad where the human holds admin (the same floor resolveSeatCapabilities re-applies on every
 * request). owner_member_id is deliberately not authority (design 4.3). Another member's agent is therefore never
 * in this set unless the human really administers its squad.
 */
export async function listAttachableAgents(env: Env, humanMemberId: string, refs?: { ref: string }): Promise<AttachableAgent[]> {
  const where = refs
    ? 'AND (a.id = ?1 OR a.slug = ?1 OR lower(a.name) = lower(?1))'
    : ''
  const stmt = env.DB.prepare(
    `SELECT a.id AS id, a.slug AS slug, a.name AS name, a.squad_id AS squad_id, sq.name AS squad_name
       FROM agents a
       JOIN squads sq ON sq.id = a.squad_id
       LEFT JOIN agent_member_bindings b ON b.tenant = ?${refs ? 2 : 1} AND b.agent_id = a.id
       LEFT JOIN members am ON am.id = b.member_id AND am.tenant = b.tenant AND am.status = 'active'
      WHERE a.status = 'active'
        AND (b.agent_id IS NULL OR am.id IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM agent_seats s WHERE s.agent_id = a.id)
        ${attachDesignatedClause(env, 'a', refs ? '?3' : '?2')}
        ${where}
      ORDER BY a.name ASC
      LIMIT 400`,
  )
  const rows = (refs ? await stmt.bind(refs.ref, env.TENANT_SLUG, humanMemberId).all<AgentCandidate>() : await stmt.bind(env.TENANT_SLUG, humanMemberId).all<AgentCandidate>()).results ?? []
  if (rows.length === 0) return []
  const grants = await resolveCapabilities(env, humanMemberId)
  const out: AttachableAgent[] = []
  const bySquad = new Map<string, boolean>()
  for (const r of rows) {
    let ok = bySquad.get(r.squad_id)
    if (ok === undefined) {
      ok = await canOnSquad(env, grants, r.squad_id, 'admin')
      bySquad.set(r.squad_id, ok)
    }
    if (ok) out.push(r)
  }
  return out
}

/** Resolve a caller-supplied agent reference (id, slug or exact name) inside the attachable set only. A reference
 *  the human may not attach to reads identically to one that does not exist (no existence oracle). */
export async function resolveAttachableAgent(env: Env, humanMemberId: string, ref: string):
  Promise<{ ok: true; agent: AttachableAgent } | { ok: false; error: 'agent_not_found' | 'agent_ambiguous' }> {
  const found = await listAttachableAgents(env, humanMemberId, { ref })
  if (found.length === 0) return { ok: false, error: 'agent_not_found' }
  if (found.length > 1) return { ok: false, error: 'agent_ambiguous' }
  return { ok: true, agent: found[0] }
}

// ── admissions ───────────────────────────────────────────────────────────────

export interface AdmissionRow {
  id: string
  tenant: string
  agent_id: string
  human_member_id: string
  harness_id: string
  status: 'pending' | 'live' | 'denied' | 'revoked' | 'expired'
  gates: number
  ceiling: AttachCeiling
  requested_via: 'tool' | 'dashboard'
  requested_seat_id: string | null
  /** Short human code the asking chat displays; null on legacy admissions (and dashboard-made rows). Not a credential. */
  attach_code: string | null
  created_at: string
  expires_at: string | null
  decided_at: string | null
  decided_by_member_id: string | null
  decided_via: 'webauthn' | 'dashboard' | null
  revoked_at: string | null
  revoked_by_member_id: string | null
}

const ADMISSION_COLUMNS = `id, tenant, agent_id, human_member_id, harness_id, status, gates, ceiling, requested_via, requested_seat_id, attach_code,
  created_at, expires_at, decided_at, decided_by_member_id, decided_via, revoked_at, revoked_by_member_id`

export async function loadAdmission(env: Env, id: string): Promise<AdmissionRow | null> {
  return env.DB.prepare(`SELECT ${ADMISSION_COLUMNS} FROM agent_seat_admissions WHERE id = ?1 AND tenant = ?2 LIMIT 1`)
    .bind(id, env.TENANT_SLUG).first<AdmissionRow>()
}

// Attach code: a short code the asking chat shows its human and the /connections card repeats, so the human can tell WHICH
// chat is asking. Unambiguous alphabet (no I, O, L, 0, 1). It is a label, not a credential: it never rides in an audit field.
const ATTACH_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function generateAttachCode(): string {
  const limit = 256 - (256 % ATTACH_CODE_ALPHABET.length) // rejection sampling: no modulo bias
  let out = ''
  while (out.length < 4) {
    const buf = crypto.getRandomValues(new Uint8Array(8))
    for (const b of buf) {
      if (b < limit && out.length < 4) out += ATTACH_CODE_ALPHABET[b % ATTACH_CODE_ALPHABET.length]
    }
  }
  return `${out.slice(0, 2)}-${out.slice(2)}`
}

function normalizeAttachCode(v: string): string {
  return v.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** Constant-time, case-insensitive, separator-insensitive compare (no early exit on the first differing byte). */
export function attachCodeMatches(expected: string, given: unknown): boolean {
  const a = normalizeAttachCode(expected)
  const b = typeof given === 'string' ? normalizeAttachCode(given.slice(0, 32)) : ''
  // The one shared comparator (src/lib/crypto.ts); a second hand-rolled xor loop is refused by the timing-safe-equal ratchet.
  if (a.length === 0) return false
  return timingSafeEqual(a, b)
}

/** THE code predicate every path that moves a pending admission to live goes through (promoteAdmission enforces it too). */
export function attachCodeRefused(adm: AdmissionRow, given: unknown): boolean {
  return adm.attach_code !== null && !attachCodeMatches(adm.attach_code, given)
}

export function admissionIsPendingLive(row: AdmissionRow, nowMs: number): boolean {
  return row.status === 'pending' && row.expires_at !== null && Date.parse(row.expires_at) > nowMs
}

async function findOpenAdmission(env: Env, agentId: string, humanMemberId: string, harnessId: string): Promise<AdmissionRow | null> {
  return env.DB.prepare(
    `SELECT ${ADMISSION_COLUMNS} FROM agent_seat_admissions
      WHERE tenant = ?1 AND agent_id = ?2 AND human_member_id = ?3 AND harness_id = ?4 AND status IN ('pending', 'live')
      LIMIT 1`,
  ).bind(env.TENANT_SLUG, agentId, humanMemberId, harnessId).first<AdmissionRow>()
}

function auditInsert(env: Env, agentId: string, actorId: string, action: string, after: Record<string, unknown>, guardSql: string, guardBinds: unknown[]): D1PreparedStatement {
  // INSERT ... SELECT ... WHERE <guard>: the audit row exists only when the write it records landed.
  return env.DB.prepare(
    `INSERT INTO agent_audit (id, agent_id, actor_id, actor_type, action, fields_changed, before_state, after_state)
     SELECT ?1, ?2, ?3, 'user', ?4, '["seat"]', '{}', ?5 WHERE ${guardSql}`,
  ).bind(crypto.randomUUID(), agentId, actorId, action, JSON.stringify(after), ...guardBinds)
}

/** The audit row for an identity weld, written ONLY if the binding this batch created exists (a weld that was skipped by its guards
 *  leaves no row, so the trail never claims a weld that did not happen). Keyed on the member id THIS batch generated: unique per
 *  batch, so a losing weld that no-ops cannot borrow a winner's binding (a timestamp key could, in the same millisecond). */
export function weldAudit(env: Env, agentId: string, actorId: string, admissionId: string, memberId: string): D1PreparedStatement {
  return auditInsert(env, agentId, actorId, 'identity_weld',
    { admission_id: admissionId, via: 'seat_admission', member: 'new dedicated agent member, home-squad capability member, no token' },
    'EXISTS (SELECT 1 FROM agent_member_bindings WHERE tenant = ?6 AND agent_id = ?2 AND member_id = ?7)', [env.TENANT_SLUG, memberId])
}

export type EnsureAdmissionResult =
  | { ok: true; state: 'live'; admission: AdmissionRow }
  | { ok: true; state: 'pending'; admission: AdmissionRow; approveUrl: string | null; alreadyPending: boolean }
  | { ok: false; error: 'too_many_pending_admissions' | 'attach_refused' | 'attach_code_mismatch' | 'approval_bound_to_other_chat' }

/**
 * Find or create the admission for (agent, human, harness).
 *  - live  -> returned as is (a later thread attaches immediately).
 *  - via 'dashboard' (the human is acting in an authenticated, fresh web session, which IS the human proof): a pending
 *    row is promoted, else a live row is created.
 *  - via 'tool': a thread can only ASK. A pending row is created (idempotent on the partial unique index, capped per
 *    human) and a secure-moment link is minted for the human's passkey tap.
 */
export async function ensureAdmission(
  env: Env,
  p: { agentId: string; humanMemberId: string; harnessId: string; seatId: string; via: 'tool' | 'dashboard'; requesterAgentId?: string | null; ceiling?: AttachCeiling; attachCode?: unknown },
  nowMs: number = Date.now(),
): Promise<EnsureAdmissionResult> {
  const nowIso = new Date(nowMs).toISOString()
  // A pending row past its expiry must not hold the unique slot.
  await env.DB.prepare(
    `UPDATE agent_seat_admissions SET status = 'expired'
      WHERE tenant = ?1 AND agent_id = ?2 AND human_member_id = ?3 AND harness_id = ?4 AND status = 'pending' AND expires_at <= ?5`,
  ).bind(env.TENANT_SLUG, p.agentId, p.humanMemberId, p.harnessId, nowIso).run()

  const open = await findOpenAdmission(env, p.agentId, p.humanMemberId, p.harnessId)
  // An admission is bound to the ONE chat (seat) that asked: the unique (agent, human, harness) slot means a second chat gets
  // no row of its own, so it is refused (the human revokes, then it asks again and gets its own coded ask).
  if (open && open.status === 'live') {
    return open.requested_seat_id === p.seatId ? { ok: true, state: 'live', admission: open } : { ok: false, error: 'approval_bound_to_other_chat' }
  }

  if (p.via === 'dashboard') {
    if (open && open.status === 'pending') {
      if (open.requested_seat_id !== p.seatId) return { ok: false, error: 'approval_bound_to_other_chat' }
      if (attachCodeRefused(open, p.attachCode)) return { ok: false, error: 'attach_code_mismatch' }
      await promoteAdmission(env, open, p.humanMemberId, 'dashboard', nowIso, p.ceiling ?? 'member', p.attachCode)
    } else if (!open) {
      const id = crypto.randomUUID()
      const agentRow = await env.DB.prepare(`SELECT a.name AS name, a.squad_id AS squad_id FROM agents a WHERE a.id = ?1 LIMIT 1`)
        .bind(p.agentId).first<{ name: string; squad_id: string }>()
      const weld = agentRow && !(await hasBindingRow(env, p.agentId)) ? prepareConditionalIdentityWeld(env, { id, agent_id: p.agentId }, agentRow, nowIso, 'direct') : null
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO agent_seat_admissions
             (id, tenant, agent_id, human_member_id, harness_id, status, gates, ceiling, requested_via, requested_seat_id, created_at, decided_at, decided_by_member_id, decided_via)
           SELECT ?1, ?2, ?3, ?4, ?5, 'live', 0, ?8, 'dashboard', ?6, ?7, ?7, ?4, 'dashboard'
            WHERE EXISTS (SELECT 1 FROM agents ag WHERE ag.id = ?3 AND ag.status = 'active' ${attachDesignatedClause(env, 'ag', '?4')})
           ON CONFLICT DO NOTHING`,
        ).bind(id, env.TENANT_SLUG, p.agentId, p.humanMemberId, p.harnessId, p.seatId, nowIso, p.ceiling ?? 'member'),
        // The weld comes AFTER the admission insert and is guarded on that exact row existing live: a lost conflict welds nothing.
        ...(weld ? weld.statements : []),
        auditInsert(env, p.agentId, p.humanMemberId, 'seat_admit',
          { admission_id: id, harness_id: p.harnessId, human_member_id: p.humanMemberId, via: 'dashboard' },
          'EXISTS (SELECT 1 FROM agent_seat_admissions WHERE id = ?6 AND status = \'live\')', [id]),
        ...(weld ? [weldAudit(env, p.agentId, p.humanMemberId, id, weld.memberId)] : []),
      ])
    }
    const now = await findOpenAdmission(env, p.agentId, p.humanMemberId, p.harnessId)
    if (now && now.status === 'live' && now.requested_seat_id !== p.seatId) return { ok: false, error: 'approval_bound_to_other_chat' }
    return now && now.status === 'live' ? { ok: true, state: 'live', admission: now } : { ok: false, error: 'attach_refused' }
  }

  // via 'tool'. A repeat ask while one is already pending NEVER mints or rotates a link: the human already has one (or can
  // decide it on the Connections page), and a rotated link would silently kill the one they are holding.
  // A repeat ask while a LIVE approval link exists never mints or rotates (that would kill the link in the human's hands).
  // But a pending admission with NO live pending moment is stranded: the first mint failed, the link expired, or a decision
  // consumed the one-time moment and the admission write did not land (split write; waitUntil is not transactional). The
  // unique index covers pending moments only, so minting a fresh link here is safe and is the recovery path.
  // Only the chat that filed the ask is handed (or re-handed) the approval link; any other chat gets no link and no code.
  if (open && open.status === 'pending' && open.requested_seat_id !== p.seatId) {
    return { ok: true, state: 'pending', admission: open, approveUrl: null, alreadyPending: true }
  }
  if (open && open.status === 'pending') {
    const liveMoment = await env.DB.prepare(
      `SELECT 1 AS ok FROM secure_moments WHERE tenant = ?1 AND kind = 'seat_admit' AND subject_id = ?2 AND status = 'pending' AND expires_at > ?3 LIMIT 1`,
    ).bind(env.TENANT_SLUG, open.id, nowIso).first<{ ok: number }>()
    if (liveMoment) return { ok: true, state: 'pending', admission: open, approveUrl: null, alreadyPending: true }
  }
  let pending = open
  if (!pending) {
    const id = crypto.randomUUID()
    const expiresAt = new Date(nowMs + ADMISSION_PENDING_TTL_MS).toISOString()
    const res = await env.DB.prepare(
      `INSERT INTO agent_seat_admissions
         (id, tenant, agent_id, human_member_id, harness_id, status, gates, requested_via, requested_seat_id, created_at, expires_at, attach_code)
       SELECT ?1, ?2, ?3, ?4, ?5, 'pending', 0, 'tool', ?6, ?7, ?8, ?10
        WHERE (SELECT COUNT(*) FROM agent_seat_admissions
                WHERE tenant = ?2 AND human_member_id = ?4 AND status = 'pending' AND expires_at > ?7) < ?9
          AND EXISTS (SELECT 1 FROM agents ag WHERE ag.id = ?3 ${attachDesignatedClause(env, 'ag', '?4')})
       ON CONFLICT DO NOTHING`,
    ).bind(id, env.TENANT_SLUG, p.agentId, p.humanMemberId, p.harnessId, p.seatId, nowIso, expiresAt, ADMISSION_MAX_PENDING_PER_HUMAN, generateAttachCode()).run()
    const inserted = res.meta.changes === 1
    pending = inserted ? await loadAdmission(env, id) : await findOpenAdmission(env, p.agentId, p.humanMemberId, p.harnessId)
    if (!pending) {
      // The insert also refuses when the designation changed after the caller resolved the agent: that is not a flood.
      const stillDesignated = await env.DB.prepare(`SELECT 1 AS x FROM agents ag WHERE ag.id = ?1 ${attachDesignatedClause(env, 'ag', '?2')}`)
        .bind(p.agentId, p.humanMemberId).first<{ x: number }>()
      return { ok: false, error: stillDesignated ? 'too_many_pending_admissions' : 'attach_refused' }
    }
    if (pending.status === 'live') return pending.requested_seat_id === p.seatId ? { ok: true, state: 'live', admission: pending } : { ok: false, error: 'approval_bound_to_other_chat' }
    // Lost a concurrent first-ask race: the winner mints the one link. Minting here would rotate it and silently kill the
    // link the winner returned (bot review P2).
    if (!inserted && pending.status === 'pending') return { ok: true, state: 'pending', admission: pending, approveUrl: null, alreadyPending: true }
  }
  // noRotate: two concurrent recoveries (or a recovery racing the first mint) must never rotate each other's link; the loser
  // simply gets no link and the human uses the winner's (or asks again).
  const link = pending.expires_at
    ? await issueMomentLink(env, { kind: 'seat_admit', subjectId: pending.id, requesterAgentId: p.requesterAgentId ?? null, subjectExpiresAtIso: pending.expires_at, noRotate: true })
    : null
  return { ok: true, state: 'pending', admission: pending, approveUrl: link?.url ?? null, alreadyPending: false }
}

/** The human's decision on a PENDING admission (dashboard path: no secure moment). */
export async function decideAdmissionDirect(
  env: Env,
  p: { admissionId: string; humanMemberId: string; decision: 'approve' | 'deny'; ceiling?: AttachCeiling; attachCode?: unknown },
  nowMs: number = Date.now(),
): Promise<{ ok: true } | { ok: false; error: 'admission_not_found' | 'not_pending' | 'attach_refused' | 'attach_code_mismatch' }> {
  const adm = await loadAdmission(env, p.admissionId)
  if (!adm || adm.human_member_id !== p.humanMemberId) return { ok: false, error: 'admission_not_found' }
  if (!admissionIsPendingLive(adm, nowMs)) return { ok: false, error: 'not_pending' }
  const nowIso = new Date(nowMs).toISOString()
  if (p.decision === 'deny') {
    const r = await env.DB.prepare(
      `UPDATE agent_seat_admissions SET status = 'denied', decided_at = ?2, decided_by_member_id = ?3, decided_via = 'dashboard'
        WHERE id = ?1 AND tenant = ?4 AND human_member_id = ?3 AND status = 'pending'`,
    ).bind(adm.id, nowIso, p.humanMemberId, env.TENANT_SLUG).run()
    return r.meta.changes === 1 ? { ok: true } : { ok: false, error: 'not_pending' }
  }
  // Approve needs the code the asking chat showed (legacy rows with no code are exempt). Refused BEFORE any state change.
  if (attachCodeRefused(adm, p.attachCode)) return { ok: false, error: 'attach_code_mismatch' }
  const refusal = await admissionRefusal(env, adm)
  if (refusal) return { ok: false, error: 'attach_refused' }
  return (await promoteAdmission(env, adm, p.humanMemberId, 'dashboard', nowIso, p.ceiling ?? 'member', p.attachCode)) ? { ok: true } : { ok: false, error: 'not_pending' }
}

/** Why a pending admission may not be promoted NOW (agent gone/inactive/unwelded, harness gone, human lost admin). */
async function admissionRefusal(env: Env, adm: AdmissionRow): Promise<string | null> {
  const agent = await env.DB.prepare(`SELECT a.status AS status, a.squad_id AS squad_id FROM agents a WHERE a.id = ?1 LIMIT 1`)
    .bind(adm.agent_id).first<{ status: string; squad_id: string }>()
  if (!agent || agent.status !== 'active') return 'agent_not_active'
  // Designation is re-checked at the human's decision with the SAME predicate the list, the chokepoint and the insert use.
  const designated = await env.DB.prepare(`SELECT 1 AS x FROM agents a WHERE a.id = ?1 ${attachDesignatedClause(env, 'a', '?2')} LIMIT 1`)
    .bind(adm.agent_id, adm.human_member_id).first<{ x: number }>()
  if (!designated) return 'agent_not_designated'
  const seatAgent = await env.DB.prepare(`SELECT 1 AS x FROM agent_seats WHERE agent_id = ?1 LIMIT 1`).bind(adm.agent_id).first<{ x: number }>()
  if (seatAgent) return 'agent_is_seat_agent'
  // Identity-only (no binding row at all) is admissible: promoteAdmission welds it in the same batch. A binding row whose member is
  // not active (suspended) is NOT: that agent has an identity that something took away.
  if ((await resolveAgentMemberBinding(env, adm.agent_id)).kind !== 'bound' && (await hasBindingRow(env, adm.agent_id))) return 'agent_identity_unminted'
  const harness = await env.DB.prepare(`SELECT 1 AS x FROM harnesses WHERE id = ?1 AND tenant = ?2 AND member_id = ?3 LIMIT 1`)
    .bind(adm.harness_id, env.TENANT_SLUG, adm.human_member_id).first<{ x: number }>()
  if (!harness) return 'harness_gone'
  const grants = await resolveCapabilities(env, adm.human_member_id)
  if (!(await canOnSquad(env, grants, agent.squad_id, 'admin'))) return 'human_not_admin'
  return null
}

async function hasBindingRow(env: Env, agentId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 AS x FROM agent_member_bindings WHERE tenant = ?1 AND agent_id = ?2 LIMIT 1`)
    .bind(env.TENANT_SLUG, agentId).first<{ x: number }>()
  return !!row
}

export async function promoteAdmission(env: Env, adm: AdmissionRow, humanMemberId: string, via: 'webauthn' | 'dashboard', nowIso: string, ceiling: AttachCeiling, attachCode: unknown): Promise<boolean> {
  // The single place a pending admission becomes live: the code is enforced HERE so no caller can forget it.
  if (attachCodeRefused(adm, attachCode)) return false
  // An identity-only agent is welded IN THE SAME BATCH as the admission going live, before it, so a refused/expired admission welds nothing.
  const agent = await env.DB.prepare(`SELECT a.name AS name, a.squad_id AS squad_id FROM agents a WHERE a.id = ?1 LIMIT 1`)
    .bind(adm.agent_id).first<{ name: string; squad_id: string }>()
  const weld = agent && !(await hasBindingRow(env, adm.agent_id)) ? prepareConditionalIdentityWeld(env, adm, agent, nowIso) : null
  const out = await env.DB.batch([
    ...(weld ? weld.statements : []),
    env.DB.prepare(
      `UPDATE agent_seat_admissions SET status = 'live', decided_at = ?2, decided_by_member_id = ?3, decided_via = ?4, ceiling = ?6
        WHERE id = ?1 AND tenant = ?5 AND human_member_id = ?3 AND status = 'pending' AND expires_at > ?2
          AND EXISTS (SELECT 1 FROM agents ag WHERE ag.id = agent_seat_admissions.agent_id AND ag.status = 'active'
                        ${attachDesignatedClause(env, 'ag', '?3')})`,
    ).bind(adm.id, nowIso, humanMemberId, via, env.TENANT_SLUG, ceiling),
    auditInsert(env, adm.agent_id, humanMemberId, 'seat_admit',
      { admission_id: adm.id, harness_id: adm.harness_id, human_member_id: adm.human_member_id, via, ceiling },
      'EXISTS (SELECT 1 FROM agent_seat_admissions WHERE id = ?6 AND status = \'live\' AND decided_at = ?7)', [adm.id, nowIso]),
    ...(weld ? [weldAudit(env, adm.agent_id, humanMemberId, adm.id, weld.memberId)] : []),
  ])
  return out[weld ? weld.statements.length : 0].meta.changes === 1
}

/** Revoke a live admission (or deny a pending one). Live -> revoked cascades to every live attachment (trigger). */
export async function revokeAdmission(
  env: Env,
  p: { admissionId: string; humanMemberId: string },
  nowMs: number = Date.now(),
): Promise<{ ok: true; detached: number } | { ok: false; error: 'admission_not_found' }> {
  const adm = await loadAdmission(env, p.admissionId)
  if (!adm || adm.human_member_id !== p.humanMemberId || (adm.status !== 'live' && adm.status !== 'pending')) {
    return { ok: false, error: 'admission_not_found' }
  }
  const nowIso = new Date(nowMs).toISOString()
  const before = await env.DB.prepare(`SELECT COUNT(*) AS n FROM agent_seat_attachments WHERE admission_id = ?1 AND detached_at IS NULL`)
    .bind(adm.id).first<{ n: number }>()
  if (adm.status === 'pending') {
    await env.DB.prepare(
      `UPDATE agent_seat_admissions SET status = 'denied', decided_at = ?2, decided_by_member_id = ?3, decided_via = 'dashboard'
        WHERE id = ?1 AND tenant = ?4 AND human_member_id = ?3 AND status = 'pending'`,
    ).bind(adm.id, nowIso, p.humanMemberId, env.TENANT_SLUG).run()
    return { ok: true, detached: 0 }
  }
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE agent_seat_admissions SET status = 'revoked', revoked_at = ?2, revoked_by_member_id = ?3
        WHERE id = ?1 AND tenant = ?4 AND human_member_id = ?3 AND status = 'live'`,
    ).bind(adm.id, nowIso, p.humanMemberId, env.TENANT_SLUG),
    auditInsert(env, adm.agent_id, p.humanMemberId, 'seat_revoke',
      { admission_id: adm.id, harness_id: adm.harness_id, human_member_id: adm.human_member_id },
      'EXISTS (SELECT 1 FROM agent_seat_admissions WHERE id = ?6 AND status = \'revoked\' AND revoked_at = ?7)', [adm.id, nowIso]),
  ])
  return { ok: true, detached: before?.n ?? 0 }
}

// ── secure moment decision (channel-neutral core for kind 'seat_admit') ──────

const CLOSED: Outcome = { status: 409, title: 'Request closed', message: 'This request is no longer pending.', tone: 'warn' }

/** What the human sees for an admission request (rendered inside the decision form). All names are labels. */
export async function admissionView(env: Env, adm: AdmissionRow): Promise<{ agentName: string; agentSlug: string; harnessName: string; harnessKind: string; seatLabel: string | null; seatFirstSeen: string | null }> {
  const a = await env.DB.prepare(`SELECT name, slug FROM agents WHERE id = ?1 LIMIT 1`).bind(adm.agent_id).first<{ name: string; slug: string }>()
  const h = await env.DB.prepare(`SELECT client_name, kind FROM harnesses WHERE id = ?1 AND tenant = ?2 LIMIT 1`).bind(adm.harness_id, env.TENANT_SLUG).first<{ client_name: string; kind: string }>()
  const s = adm.requested_seat_id
    ? await env.DB.prepare(`SELECT label_basename, created_at FROM agent_seats WHERE id = ?1 AND tenant = ?2 LIMIT 1`).bind(adm.requested_seat_id, env.TENANT_SLUG).first<{ label_basename: string; created_at: string }>()
    : null
  return { agentName: a?.name ?? adm.agent_id, agentSlug: a?.slug ?? '', harnessName: h?.client_name ?? '', harnessKind: h?.kind ?? '', seatLabel: s?.label_basename ?? null, seatFirstSeen: s?.created_at ?? null }
}

// Same contract as durably() in access/decision-core (not imported: that module pulls the whole MCP tool graph into this
// leaf and creates an import cycle). Run `fn` to completion even if the client goes away; the caller still awaits it.
function durablyLocal<T>(waitUntil: WaitUntil | undefined, fn: () => Promise<T>): Promise<T> {
  const p = fn()
  if (waitUntil) waitUntil(p.then(() => undefined, () => undefined))
  return p
}

/**
 * The passkey-verified human decides an admission. Every refusable check runs BEFORE the one-time gate (a refusal
 * never burns the link). Only the admission's own human may decide it: a passkey of any other member is refused.
 */
export async function decideSeatAdmission(
  env: Env,
  input: { adm: AdmissionRow; decision: 'approve' | 'deny'; proof: HumanProof; gate: Gate; waitUntil?: WaitUntil; ceiling?: AttachCeiling; attachCode?: unknown },
  nowMs: number,
): Promise<Outcome> {
  const { adm, decision, proof } = input
  if (proof.memberId !== adm.human_member_id) {
    return { status: 403, title: 'Not allowed', message: 'This passkey belongs to a member who may not decide this request.', tone: 'bad' }
  }
  const nowIso = new Date(nowMs).toISOString()
  // The gate consumes the one-time moment, then a write follows. waitUntil only extends the request's lifetime: it is NOT
  // transactional, so a failed promotion can still leave a consumed moment with the admission pending. That state is
  // recoverable: the next seat_attach finds no live moment and mints a fresh link (see ensureAdmission), and the human can
  // also decide it on the Connections page.
  return durablyLocal(input.waitUntil, async (): Promise<Outcome> => {
    if (decision === 'deny') {
      if (!(await input.gate())) return CLOSED
      const r = await env.DB.prepare(
        `UPDATE agent_seat_admissions SET status = 'denied', decided_at = ?2, decided_by_member_id = ?3, decided_via = 'webauthn'
          WHERE id = ?1 AND tenant = ?4 AND human_member_id = ?3 AND status = 'pending'`,
      ).bind(adm.id, nowIso, proof.memberId, env.TENANT_SLUG).run()
      return r.meta.changes === 1
        ? { status: 200, title: 'Denied', message: 'Nothing was admitted and nothing was attached.', tone: 'ok' }
        : CLOSED
    }
    const refusal = await admissionRefusal(env, adm)
    if (refusal) {
      return { status: 409, title: 'Cannot admit', message: `This admission can no longer be granted (${refusal}). Nothing was changed.`, tone: 'warn' }
    }
    // Before the one-time gate: a wrong code never burns the link.
    if (attachCodeRefused(adm, input.attachCode)) {
      return { status: 403, title: 'Wrong attach code', message: 'The attach code does not match the one the chat showed. Nothing was changed.', tone: 'warn' }
    }
    if (!(await input.gate())) return CLOSED
    const landed = await promoteAdmission(env, adm, proof.memberId, 'webauthn', nowIso, input.ceiling ?? 'member', input.attachCode)
    if (!landed) return CLOSED
    // The write already landed: a failed name lookup must not turn a successful approval into an error page.
    const who = (await admissionView(env, adm).then((v) => v.agentName, () => null)) ?? 'this agent'
    return { status: 200, title: 'Admitted', message: `Chats from this app can now act as ${who} (ceiling: ${input.ceiling ?? 'member'}). Paste the message below into the chat that asked: it attaches to ${who} by name, immediately.`, tone: 'ok' }
  })
}

// ── the per-request chokepoint ───────────────────────────────────────────────

export interface LiveAttachmentRow {
  attachment_id: string
  admission_id: string
  last_used_at: string | null
  seat_id: string
  seat_label: string
  seat_agent_id: string
  agent_id: string
  agent_squad_id: string
  agent_member_id: string
  agent_email: string | null
  harness_id: string
  seat_token_id: string
  ceiling: AttachCeiling
}

/**
 * THE admission check: one statement, evaluated on every request of an attached thread. The attachment must be live,
 * its admission LIVE and for exactly this (agent, human, harness), its seat un-retired and the same human's, the
 * human's unbound grant token live, the harness still the human's, the agent active, welded to an active member, and
 * the attachment's own token live. Anything else -> null, and the caller serves the thread's own seat agent.
 *   ?1 tenant ?2 seat id ?3 grant token id ?4 human member id ?5 now
 */
export async function findLiveAttachment(env: Env, human: { memberId: string; tokenId: string }, seatId: string): Promise<LiveAttachmentRow | null> {
  const row = await env.DB.prepare(
    `SELECT att.id AS attachment_id, adm.id AS admission_id, att.last_used_at AS last_used_at, adm.ceiling AS ceiling, s.id AS seat_id,
            s.label_basename AS seat_label, s.agent_id AS seat_agent_id, a.id AS agent_id, a.squad_id AS agent_squad_id,
            b.member_id AS agent_member_id, am.email AS agent_email, att.harness_id AS harness_id,
            (SELECT t.id FROM member_tokens t
              WHERE t.id = att.seat_token_id AND t.member_id = b.member_id AND t.agent_id = a.id
                AND t.tenant = ?1 AND t.channel = 'directory'
                AND ${TOKEN_LIVE_PREDICATE('?5')}) AS seat_token_id
       FROM agent_seat_attachments att
       JOIN agent_seat_admissions adm ON adm.id = att.admission_id AND adm.tenant = att.tenant
       JOIN agent_seats s ON s.id = att.seat_id AND s.tenant = att.tenant
       JOIN agents a ON a.id = att.agent_id
       JOIN agent_member_bindings b ON b.tenant = att.tenant AND b.agent_id = a.id
       JOIN members am ON am.id = b.member_id AND am.tenant = att.tenant AND am.status = 'active'
       JOIN harnesses hr ON hr.id = att.harness_id AND hr.tenant = att.tenant AND hr.member_id = att.human_member_id
      WHERE att.tenant = ?1
        AND att.seat_id = ?2
        AND att.detached_at IS NULL
        AND att.human_member_id = ?4
        AND adm.status = 'live'
        AND adm.agent_id = att.agent_id
        AND adm.human_member_id = att.human_member_id
        AND adm.harness_id = att.harness_id
        AND ${ADMISSION_BOUND_TO_SEAT_SQL}
        AND s.retired_at IS NULL
        AND s.member_id = att.human_member_id
        AND s.harness_id = att.harness_id
        AND a.status = 'active'
        ${attachDesignatedClause(env, 'a', '?4')}
        AND EXISTS (SELECT 1 FROM member_tokens g
                     WHERE g.id = ?3 AND g.member_id = ?4 AND g.tenant = ?1
                       AND g.channel = 'directory' AND g.agent_id IS NULL
                       AND ${TOKEN_LIVE_PREDICATE('?5').replace(/\bt\./g, 'g.')})
      LIMIT 1`,
  ).bind(env.TENANT_SLUG, seatId, human.tokenId, human.memberId, nowSqlUtc())
    .first<Omit<LiveAttachmentRow, 'seat_token_id'> & { seat_token_id: string | null }>()
  if (!row || !row.seat_token_id) return null
  return { ...row, seat_token_id: row.seat_token_id }
}

/** LRU/display bookkeeping, never fails a request. */
export async function touchAttachment(env: Env, row: LiveAttachmentRow, nowMs: number): Promise<void> {
  const last = row.last_used_at ? Date.parse(row.last_used_at) : NaN
  if (Number.isFinite(last) && nowMs - last < ATTACHMENT_TOUCH_INTERVAL_MS) return
  try {
    await env.DB.prepare(`UPDATE agent_seat_attachments SET last_used_at = ?2 WHERE id = ?1 AND detached_at IS NULL`)
      .bind(row.attachment_id, new Date(nowMs).toISOString()).run()
  } catch {
    // Bookkeeping only.
  }
}

// ── attach / detach ──────────────────────────────────────────────────────────

export interface SeatForAttach {
  id: string
  harness_id: string
  member_id: string
  agent_id: string
  label_basename: string
}

/** A live (un-retired) seat of THIS human. Nothing else is attachable. */
export async function loadHumanSeat(env: Env, humanMemberId: string, seatId: string): Promise<SeatForAttach | null> {
  return env.DB.prepare(
    `SELECT s.id AS id, s.harness_id AS harness_id, s.member_id AS member_id, s.agent_id AS agent_id, s.label_basename AS label_basename
       FROM agent_seats s JOIN harnesses h ON h.id = s.harness_id AND h.tenant = s.tenant AND h.member_id = s.member_id
      WHERE s.id = ?1 AND s.tenant = ?2 AND s.member_id = ?3 AND s.retired_at IS NULL LIMIT 1`,
  ).bind(seatId, env.TENANT_SLUG, humanMemberId).first<SeatForAttach>()
}

export interface AttachOk {
  ok: true
  status: 'attached'
  attachment_id: string
  admission_id: string
  agent: { id: string; slug: string; name: string }
  seat_id: string
}
export interface AttachPending {
  ok: true
  status: 'pending_admission'
  admission_id: string
  approve_url: string | null
  expires_at: string | null
  /** The code to show the human; null on a repeat ask from a DIFFERENT chat (it must not learn the first chat's code). */
  attach_code: string | null
  /** A repeat ask while one was already pending: NO new link is minted (the human has one, or decides on /connections). */
  already_pending: boolean
}
export interface AttachErr { ok: false; error: AttachFailure }
export type AttachResult = AttachOk | AttachPending | AttachErr

async function liveAttachmentOfSeat(env: Env, seatId: string): Promise<{ id: string; agent_id: string } | null> {
  return env.DB.prepare(`SELECT id, agent_id FROM agent_seat_attachments WHERE tenant = ?1 AND seat_id = ?2 AND detached_at IS NULL LIMIT 1`)
    .bind(env.TENANT_SLUG, seatId).first<{ id: string; agent_id: string }>()
}

/**
 * Attach a human's seat to an admitted agent. The shared writer for the MCP tool (via 'tool') and the dashboard (via
 * 'dashboard'). `agentRef` is re-resolved here against the attachable set, so neither caller can name an agent the
 * human may not attach to. Attachment + token + audit land in ONE batch whose every guard is in the statements' WHERE.
 */
export async function attachSeatToAgent(
  env: Env,
  p: { humanMemberId: string; seatId: string; agentRef: string; via: 'tool' | 'dashboard'; requesterAgentId?: string | null; moveIfAttached?: boolean; ceiling?: AttachCeiling; attachCode?: unknown },
  nowMs: number = Date.now(),
): Promise<AttachResult> {
  if (!seatAttachEnabled(env)) return { ok: false, error: 'seat_attach_disabled' }
  const seat = await loadHumanSeat(env, p.humanMemberId, p.seatId)
  if (!seat) return { ok: false, error: 'seat_not_found' }
  const resolved = await resolveAttachableAgent(env, p.humanMemberId, p.agentRef)
  if (!resolved.ok) return resolved
  const agent = resolved.agent

  // A live attachment row the designation predicate no longer admits is dead to every reader (findLiveAttachment already serves the
  // seat agent). Retire it here so it cannot block a new attach with already_attached. No-op while the designation flag is off
  // (the clause is then a tautology, so NOT EXISTS is false).
  await env.DB.prepare(
    `UPDATE agent_seat_attachments SET detached_at = ?3, detach_reason = 'admission_revoked', detached_by_member_id = ?4
      WHERE tenant = ?1 AND seat_id = ?2 AND detached_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM agents ag WHERE ag.id = agent_seat_attachments.agent_id ${attachDesignatedClause(env, 'ag', 'agent_seat_attachments.human_member_id')})`,
  ).bind(env.TENANT_SLUG, seat.id, new Date(nowMs).toISOString(), p.humanMemberId).run()
  const current = await liveAttachmentOfSeat(env, seat.id)
  if (current) {
    if (!p.moveIfAttached) return { ok: false, error: 'already_attached' }
    if (current.agent_id === agent.id) {
      const adm = await findOpenAdmission(env, agent.id, p.humanMemberId, seat.harness_id)
      return adm && adm.status === 'live'
        ? { ok: true, status: 'attached', attachment_id: current.id, admission_id: adm.id, agent: { id: agent.id, slug: agent.slug, name: agent.name }, seat_id: seat.id }
        : { ok: false, error: 'attach_refused' }
    }
  }

  const admission = await ensureAdmission(env, {
    agentId: agent.id, humanMemberId: p.humanMemberId, harnessId: seat.harness_id, seatId: seat.id, via: p.via, requesterAgentId: p.requesterAgentId, ceiling: p.ceiling, attachCode: p.attachCode,
  }, nowMs)
  if (!admission.ok) return { ok: false, error: admission.error }
  if (admission.state === 'pending') {
    // Only the chat that filed the ask learns the code; a different chat hitting the same pending row gets none.
    const attachCode = admission.admission.requested_seat_id === seat.id ? admission.admission.attach_code : null
    return { ok: true, status: 'pending_admission', admission_id: admission.admission.id, approve_url: admission.admission.requested_seat_id === seat.id ? admission.approveUrl : null, expires_at: admission.admission.expires_at, already_pending: admission.alreadyPending, attach_code: attachCode }
  }
  if ((await resolveAgentMemberBinding(env, agent.id)).kind !== 'bound') return { ok: false, error: 'agent_identity_unminted' }

  const nowIso = new Date(nowMs).toISOString()
  const attachmentId = crypto.randomUUID()
  const tokenId = crypto.randomUUID()
  const tokenHash = await sha256Hex(mintRawToken()) // the raw secret is discarded: nothing can present this token
  const statements: D1PreparedStatement[] = []
  if (current) {
    statements.push(env.DB.prepare(
      `UPDATE agent_seat_attachments SET detached_at = ?2, detach_reason = 'moved', detached_by_member_id = ?3
        WHERE id = ?1 AND tenant = ?4 AND detached_at IS NULL
          AND EXISTS (SELECT 1 FROM agents na WHERE na.id = ?5 ${attachDesignatedClause(env, 'na', '?3')})`,
    ).bind(current.id, nowIso, p.humanMemberId, env.TENANT_SLUG, agent.id))
  }
  const attachIndex = statements.length
  statements.push(env.DB.prepare(
    `INSERT INTO agent_seat_attachments (id, tenant, seat_id, human_member_id, harness_id, agent_id, admission_id, seat_token_id, created_at)
     SELECT ?1, ?2, s.id, s.member_id, s.harness_id, a.id, adm.id, ?3, ?4
       FROM agent_seats s
       JOIN agent_seat_admissions adm ON adm.id = ?5 AND adm.tenant = s.tenant AND adm.status = 'live'
            AND adm.human_member_id = s.member_id AND adm.harness_id = s.harness_id AND adm.agent_id = ?6
            AND adm.requested_seat_id = s.id -- the approval belongs to the chat that asked
       JOIN agents a ON a.id = adm.agent_id AND a.status = 'active'
       JOIN agent_member_bindings b ON b.tenant = s.tenant AND b.agent_id = a.id
       JOIN members am ON am.id = b.member_id AND am.tenant = s.tenant AND am.status = 'active'
       JOIN harnesses hr ON hr.id = s.harness_id AND hr.tenant = s.tenant AND hr.member_id = s.member_id
      WHERE s.id = ?7 AND s.tenant = ?2 AND s.member_id = ?8 AND s.retired_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM agent_seats x WHERE x.agent_id = a.id)
        ${attachDesignatedClause(env, 'a', '?8')}`,
  ).bind(attachmentId, env.TENANT_SLUG, tokenId, nowIso, admission.admission.id, agent.id, seat.id, p.humanMemberId))
  statements.push(env.DB.prepare(
    `INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
     SELECT ?1, b.member_id, ?2, ?3, 'directory', datetime('now'), b.agent_id, ?4
       FROM agent_seat_attachments att JOIN agent_member_bindings b ON b.tenant = att.tenant AND b.agent_id = att.agent_id
      WHERE att.id = ?5 AND att.seat_token_id = ?1`,
  ).bind(tokenId, tokenHash, `attach:${agent.slug}`.slice(0, 100) + `:${seat.id.slice(-12)}`, env.TENANT_SLUG, attachmentId))
  statements.push(auditInsert(env, agent.id, p.humanMemberId, 'seat_attach',
    { attachment_id: attachmentId, seat_id: seat.id, admission_id: admission.admission.id, harness_id: seat.harness_id, human_member_id: p.humanMemberId },
    'EXISTS (SELECT 1 FROM agent_seat_attachments WHERE id = ?6)', [attachmentId]))

  try {
    const out = await env.DB.batch(statements)
    if (out[attachIndex].meta.changes !== 1) return { ok: false, error: 'attach_refused' }
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) return { ok: false, error: 'already_attached' }
    throw err
  }
  return { ok: true, status: 'attached', attachment_id: attachmentId, admission_id: admission.admission.id, agent: { id: agent.id, slug: agent.slug, name: agent.name }, seat_id: seat.id }
}

/** The human detaches a thread: it returns to its own seat agent on the next request. */
export async function detachAttachment(
  env: Env,
  p: { attachmentId: string; humanMemberId: string },
  nowMs: number = Date.now(),
): Promise<{ ok: true } | { ok: false; error: 'attachment_not_found' }> {
  const nowIso = new Date(nowMs).toISOString()
  const att = await env.DB.prepare(`SELECT agent_id FROM agent_seat_attachments WHERE id = ?1 AND tenant = ?2 AND human_member_id = ?3 AND detached_at IS NULL LIMIT 1`)
    .bind(p.attachmentId, env.TENANT_SLUG, p.humanMemberId).first<{ agent_id: string }>()
  if (!att) return { ok: false, error: 'attachment_not_found' }
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE agent_seat_attachments SET detached_at = ?2, detach_reason = 'human', detached_by_member_id = ?3
        WHERE id = ?1 AND tenant = ?4 AND human_member_id = ?3 AND detached_at IS NULL`,
    ).bind(p.attachmentId, nowIso, p.humanMemberId, env.TENANT_SLUG),
    auditInsert(env, att.agent_id, p.humanMemberId, 'seat_detach',
      { attachment_id: p.attachmentId, human_member_id: p.humanMemberId },
      'EXISTS (SELECT 1 FROM agent_seat_attachments WHERE id = ?6 AND detached_at = ?7)', [p.attachmentId, nowIso]),
  ])
  return { ok: true }
}

/** The human's own name for a thread. A label only: it never selects or authorises anything. */
export async function renameThread(
  env: Env,
  p: { humanMemberId: string; seatId: string; label: unknown },
  nowMs: number = Date.now(),
): Promise<{ ok: true; label: string | null } | { ok: false; error: 'seat_not_found' | 'invalid_args' }> {
  if (typeof p.label !== 'string') return { ok: false, error: 'invalid_args' }
  const seat = await loadHumanSeat(env, p.humanMemberId, p.seatId)
  if (!seat) return { ok: false, error: 'seat_not_found' }
  const label = sanitizeLabel(p.label, 64)
  if (label.length === 0) {
    // An empty name clears the label (the thread shows its own again).
    await env.DB.prepare(`DELETE FROM agent_seat_thread_labels WHERE tenant = ?1 AND seat_id = ?2 AND human_member_id = ?3`)
      .bind(env.TENANT_SLUG, seat.id, p.humanMemberId).run()
    return { ok: true, label: null }
  }
  await env.DB.prepare(
    `INSERT INTO agent_seat_thread_labels (tenant, seat_id, human_member_id, label, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (tenant, seat_id) DO UPDATE SET label = excluded.label, updated_at = excluded.updated_at WHERE human_member_id = excluded.human_member_id`,
  ).bind(env.TENANT_SLUG, seat.id, p.humanMemberId, label, new Date(nowMs).toISOString()).run()
  return { ok: true, label }
}

/** Statement for the auto-pool reclaim batch: detach attachments idle for ATTACH_IDLE_DAYS on this harness, so a pool full
 *  of forgotten pinned threads frees itself. Binds: 1 tenant, 2 harness, 3 now (ISO). Conditional: 0 rows is correct. */
export function prepareIdleAttachmentSweep(env: Env, harnessId: string, nowIso: string, liveCap: number): D1PreparedStatement {
  // Only when the auto pool is FULL (same predicate as the reclaim statement): a persistent connection is never swept while
  // the app still has free thread slots.
  return env.DB.prepare(
    `UPDATE agent_seat_attachments SET detached_at = ?3, detach_reason = 'idle_expired'
      WHERE tenant = ?1 AND harness_id = ?2 AND detached_at IS NULL
        AND julianday(COALESCE(last_used_at, created_at)) < julianday(?3) - ${ATTACH_IDLE_DAYS}
        AND (SELECT COUNT(*) FROM agent_seats ls JOIN agents la ON la.id = ls.agent_id
              WHERE ls.tenant = ?1 AND ls.harness_id = ?2 AND ls.source = 'auto' AND ls.retired_at IS NULL
                AND la.status IN ('active', 'paused')) >= ?4`,
  ).bind(env.TENANT_SLUG, harnessId, nowIso, liveCap)
}

/** The default name of a connection (seat) from what the server knows: the app's registered name + the seat's own label. */
export function defaultConnectionName(h: { client_name?: string | null; kind?: string | null }, seatLabel: string): string {
  return [(h.client_name ?? '').trim() || (h.kind ?? '').trim(), seatLabel.trim()].filter((x) => x.length > 0).join(' · ').slice(0, 120)
}

/** The human-facing NAME of a connection: the human's own label if they set one, else the derived default. Server-derived
 *  from the seat the request was bound to; label only, never authority. Null when the seat cannot be read. */
export async function connectionName(env: Env, humanMemberId: string, seatId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT tl.label AS thread_label, s.label_basename AS seat_label, h.client_name AS client_name, h.kind AS kind
       FROM agent_seats s
       JOIN harnesses h ON h.id = s.harness_id AND h.tenant = s.tenant
       LEFT JOIN agent_seat_thread_labels tl ON tl.seat_id = s.id AND tl.tenant = s.tenant AND tl.human_member_id = s.member_id
      WHERE s.id = ?1 AND s.tenant = ?2 AND s.member_id = ?3 LIMIT 1`,
  ).bind(seatId, env.TENANT_SLUG, humanMemberId).first<{ thread_label: string | null; seat_label: string; client_name: string; kind: string }>()
  if (!row) return null
  return row.thread_label ?? defaultConnectionName(row, row.seat_label)
}

// ── dashboard read model ─────────────────────────────────────────────────────

export interface ConnectionSeat {
  seat_id: string
  seat_label: string
  thread_label: string | null
  /** The name shown for this connection: the human's label, else the derived default. */
  connection_name?: string
  source: string
  last_used_at: string | null
  created_at: string
  seat_agent_name: string
  attachment_id: string | null
  attached_agent_id: string | null
  attached_agent_name: string | null
}
export interface ConnectionHarness { id: string; client_name: string; kind: string; credential_kind: string; seats: ConnectionSeat[] }
export interface ConnectionAdmission {
  id: string
  status: 'pending' | 'live'
  agent_name: string
  harness_name: string
  ceiling: AttachCeiling
  created_at: string
  expires_at: string | null
  has_code: number
  requested_seat_id: string | null
  seat_label: string | null
  seat_first_seen: string | null
  live_threads: number
}

export interface BoundConnection { token_id: string; agent_name: string; connected_at: string }

/** Apps this human connected as ONE agent (a legacy consent-bound OAuth grant that is still live). Read from the
 *  consent receipt, the only place the consenting human of a bound grant is recorded. */
async function loadBoundConnections(env: Env, humanMemberId: string): Promise<BoundConnection[]> {
  return (await env.DB.prepare(
    `SELECT r.token_id AS token_id, a.name AS agent_name, r.created_at AS connected_at
       FROM oauth_consent_receipts r
       JOIN agents a ON a.id = r.agent_id
       JOIN member_tokens t ON t.id = r.token_id AND t.tenant = r.tenant AND t.revoked_at IS NULL
      WHERE r.tenant = ?1 AND r.consenting_member_id = ?2 AND t.channel = 'directory'
        AND (t.expires_at IS NULL OR julianday(t.expires_at) > julianday('now'))
      ORDER BY r.created_at DESC LIMIT 50`,
  ).bind(env.TENANT_SLUG, humanMemberId).all<BoundConnection>()).results ?? []
}

export async function loadConnections(env: Env, humanMemberId: string): Promise<{ harnesses: ConnectionHarness[]; admissions: ConnectionAdmission[]; bound: BoundConnection[] }> {
  const hs = (await env.DB.prepare(
    `SELECT id, client_name, kind, credential_kind FROM harnesses WHERE tenant = ?1 AND member_id = ?2 ORDER BY created_at DESC LIMIT 50`,
  ).bind(env.TENANT_SLUG, humanMemberId).all<{ id: string; client_name: string; kind: string; credential_kind: string }>()).results ?? []
  const seats = (await env.DB.prepare(
    `SELECT s.id AS seat_id, s.harness_id AS harness_id, s.label_basename AS seat_label, tl.label AS thread_label, s.source AS source, s.last_used_at AS last_used_at,
            s.created_at AS created_at, sa.name AS seat_agent_name,
            att.id AS attachment_id, att.agent_id AS attached_agent_id, aa.name AS attached_agent_name
       FROM agent_seats s
       JOIN agents sa ON sa.id = s.agent_id
       LEFT JOIN agent_seat_attachments att ON att.seat_id = s.id AND att.tenant = s.tenant AND att.detached_at IS NULL
       LEFT JOIN agents aa ON aa.id = att.agent_id
       LEFT JOIN agent_seat_thread_labels tl ON tl.seat_id = s.id AND tl.tenant = s.tenant AND tl.human_member_id = s.member_id
      WHERE s.tenant = ?1 AND s.member_id = ?2 AND s.retired_at IS NULL AND sa.status IN ('active', 'paused')
      ORDER BY COALESCE(s.last_used_at, s.created_at) DESC
      LIMIT 400`,
  ).bind(env.TENANT_SLUG, humanMemberId).all<ConnectionSeat & { harness_id: string }>()).results ?? []
  const harnesses: ConnectionHarness[] = hs.map((h) => ({
    ...h,
    seats: seats.filter((s) => s.harness_id === h.id).map((s) => ({ ...s, connection_name: s.thread_label ?? defaultConnectionName(h, s.seat_label) })),
  }))
  const admissions = (await env.DB.prepare(
    `SELECT adm.id AS id, adm.status AS status, a.name AS agent_name, h.client_name AS harness_name, adm.ceiling AS ceiling, adm.created_at AS created_at,
            adm.expires_at AS expires_at, (adm.attach_code IS NOT NULL) AS has_code, adm.requested_seat_id AS requested_seat_id, rs.label_basename AS seat_label, rs.created_at AS seat_first_seen,
            (SELECT COUNT(*) FROM agent_seat_attachments x WHERE x.admission_id = adm.id AND x.detached_at IS NULL) AS live_threads
       FROM agent_seat_admissions adm
       JOIN agents a ON a.id = adm.agent_id
       JOIN harnesses h ON h.id = adm.harness_id
       LEFT JOIN agent_seats rs ON rs.id = adm.requested_seat_id AND rs.tenant = adm.tenant
      WHERE adm.tenant = ?1 AND adm.human_member_id = ?2 AND adm.status IN ('pending', 'live')
      ORDER BY adm.created_at DESC LIMIT 200`,
  ).bind(env.TENANT_SLUG, humanMemberId).all<ConnectionAdmission>()).results ?? []
  return { harnesses, admissions, bound: await loadBoundConnections(env, humanMemberId) }
}
