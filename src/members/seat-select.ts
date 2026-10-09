// mupot#1794 W1 — seat_select: find-or-create the agent for a (human, harness, workspace key) seat.
//
// WHAT THIS IS: an unbound, OAuth-authenticated human session names the workspace it is working in
// (project / folder / thread / squad). The server normalises that into a canonical key
// (src/members/seat-key.ts), hashes it, and returns THE agent for that key — creating it on
// first sight. Same key -> same agent, always. Another human's identical key -> a different
// agent. A per-human cap bounds the number of live seats.
//
// WHAT THIS IS NOT: it does not bind the calling session to the seat (that is W2: Mcp-Session-Id
// + a seat lock in the auth build), it does not widen any capability, and it does not accept a
// label as authority. project / squad / folder / thread / harness_kind are LABELS that feed the
// key and the display name; the squad argument never places the agent anywhere.
//
// FLAG: everything is behind SEAT_AUTO_ENROLL === '1' (unset in prod). Flag off -> the very first
// statement returns a refusal, before any read or write.
//
// AUTHORITY: the agent is a plain, dedicated, MEMBER-capability agent on the HUMAN's own home
// squad (createHomeForMember if none yet). The human must hold admin there (the home squad's
// founder grant) or the call refuses `home_rank_insufficient` — the same floor /oauth/consent
// applies before a human may weld a session to an agent. No admin is ever granted by enrolment.
// The agent's identity is welded the way every agent is (members row + agent_member_bindings
// BEFORE its token + a home-squad capability, via prepareAgentIdentityWeldStatements) and it
// carries a SERVER-HELD directory token whose raw secret is discarded at creation: nothing can
// present it, but deactivate_agent's revocation sweep, the 0071 liveness checks and
// agent_sessions all see a normal welded agent. No workspace token is minted.
//
// ATOMICITY: agent + membership + member + binding + capability + directory token + audit row +
// seat row go in ONE env.DB.batch(). The seat row is LAST and carries the per-member cap as a
// BEFORE INSERT trigger (migration 0198), because a D1 batch rolls back on an ERROR only — a
// zero-row "capped INSERT ... SELECT" would commit everything before it and orphan it. Any
// failure (cap, UNIQUE race on the key, UNIQUE race on the derived slug, a trigger) therefore
// rolls the WHOLE batch back: zero orphan agents / members / bindings / tokens. A lost race is
// classified AFTER the rollback by re-reading the winner (disposition 'existing'). No
// ON CONFLICT DO NOTHING anywhere (that is exactly the orphan-producing shape).
//
// AUDIT: action 'seat_select' in agent_audit, actor = the human. Deliberately NOT
// 'bootstrap_self': migration 0092's partial UNIQUE index on (actor_id) WHERE
// action='bootstrap_self' (the once-per-member rule) is untouched and unreachable from here, and
// findExistingBootstrap keeps answering only for real bootstrap_self rows.

import type { D1PreparedStatement } from '@cloudflare/workers-types'
import type { Env, AuthContext } from '../types'
import { assertBatchWritten, type D1WriteLike } from '../lib/receipt'
import { createHomeForMember, prepareAgentCreate, isValidSlug } from '../org/service'
import { capabilityRank } from '../auth/capability'
import {
  prepareAgentIdentityWeldStatements,
  prepareDirectoryTokenInsert,
  resolveAgentMemberBinding,
  type AgentForMint,
} from './service'
import {
  AGENT_SNAPSHOT_FIELDS,
  createdAgentSnapshot,
  emptyIdentitySnapshot,
  isUnboundDirectorySession,
} from './bootstrap-self'
import { loadHarness, sanitizeLabel, seatAutoEnrollEnabled, type HarnessRow } from './harness'
import { normalizeSeatKey, seatKeyHash, type SeatKeyArgs } from './seat-key'

export const SEAT_MAX_PER_MEMBER_DEFAULT = 16
const SEAT_MAX_PER_MEMBER_CEILING = 256

/** SEAT_MAX_PER_MEMBER, parsed defensively: garbage / <1 -> default, >256 -> 256. */
export function seatCap(env: Pick<Env, 'SEAT_MAX_PER_MEMBER'>): number {
  const raw = env.SEAT_MAX_PER_MEMBER
  if (typeof raw !== 'string' || !/^\d{1,4}$/.test(raw.trim())) return SEAT_MAX_PER_MEMBER_DEFAULT
  const n = parseInt(raw.trim(), 10)
  if (n < 1) return SEAT_MAX_PER_MEMBER_DEFAULT
  return Math.min(n, SEAT_MAX_PER_MEMBER_CEILING)
}

export type SeatSelectFailure =
  | 'seat_auto_enroll_disabled'
  | 'not_unbound_directory_session'
  | 'harness_required'
  | 'member_not_active'
  | 'invalid_args'
  | 'home_rank_insufficient'
  | 'seat_cap_reached'
  | 'seat_agent_inactive'
  | 'provisioning_failed'

export interface SeatSelectOk {
  ok: true
  disposition: 'created' | 'existing'
  seat: { id: string; label: string; created_at: string }
  harness: { id: string; client_name: string; kind: string }
  agent: { id: string; slug: string; name: string; squad_id: string }
  /** The agent's own dedicated member id (never the human's). */
  member_id: string
  audit_id: string | null
  /** Honest scope note: W1 find-or-creates the seat; the session lock is a later wave. */
  note: string
}

export interface SeatSelectErr {
  ok: false
  error: SeatSelectFailure
  detail?: unknown
}

export type SeatSelectResult = SeatSelectOk | SeatSelectErr

export type SeatSelectAuth = Pick<AuthContext, 'channel' | 'boundAgentId' | 'memberId' | 'harnessId'>

interface SeatRow {
  id: string
  agent_id: string
  label_basename: string
  created_at: string
  retired_at: string | null
}

const W1_NOTE =
  'Seat resolved. This session is not yet bound to the seat (session lock lands in a later wave); '
  + 'the agent exists with member capability on your home squad and no admin.'

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message)
}

function isCapViolation(err: unknown): boolean {
  return err instanceof Error && err.message.includes('seat_cap_exceeded')
}

async function countLiveSeats(env: Env, memberId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM agent_seats WHERE tenant = ?1 AND member_id = ?2 AND retired_at IS NULL`,
  ).bind(env.TENANT_SLUG, memberId).first<{ n: number }>()
  return row?.n ?? 0
}

async function findSeat(env: Env, memberId: string, harnessId: string, keyHash: string): Promise<SeatRow | null> {
  return env.DB.prepare(
    `SELECT id, agent_id, label_basename, created_at, retired_at
       FROM agent_seats
      WHERE tenant = ?1 AND member_id = ?2 AND harness_id = ?3 AND key_hash = ?4
      LIMIT 1`,
  ).bind(env.TENANT_SLUG, memberId, harnessId, keyHash).first<SeatRow>()
}

/** An EXISTING seat is only handed back while its agent is still a live, welded identity. An
 *  inactive / missing agent or a retired seat refuses — a key is never resurrected. */
async function existingSeatResult(env: Env, seat: SeatRow, harness: HarnessRow): Promise<SeatSelectResult> {
  if (seat.retired_at !== null) return { ok: false, error: 'seat_agent_inactive', detail: { reason: 'seat_retired' } }
  const agent = await env.DB.prepare(
    `SELECT id, slug, name, squad_id, status FROM agents WHERE id = ?1 LIMIT 1`,
  ).bind(seat.agent_id).first<{ id: string; slug: string; name: string; squad_id: string; status: string }>()
  if (!agent || agent.status !== 'active') {
    return { ok: false, error: 'seat_agent_inactive', detail: { reason: 'agent_not_active' } }
  }
  const binding = await resolveAgentMemberBinding(env, agent.id)
  if (binding.kind !== 'bound') {
    return { ok: false, error: 'seat_agent_inactive', detail: { reason: 'agent_binding_missing' } }
  }
  return {
    ok: true,
    disposition: 'existing',
    seat: { id: seat.id, label: seat.label_basename, created_at: seat.created_at },
    harness: { id: harness.id, client_name: harness.client_name, kind: harness.kind },
    agent: { id: agent.id, slug: agent.slug, name: agent.name, squad_id: agent.squad_id },
    member_id: binding.memberId,
    audit_id: null,
    note: W1_NOTE,
  }
}

export interface SeatSelectDeps {
  batch: (env: Env, statements: D1PreparedStatement[]) => Promise<D1WriteLike[]>
}

export function defaultSeatSelectDeps(): SeatSelectDeps {
  return { batch: (env, statements) => env.DB.batch(statements) }
}

export async function seatSelect(
  env: Env,
  auth: SeatSelectAuth,
  args: SeatKeyArgs,
  deps: SeatSelectDeps = defaultSeatSelectDeps(),
): Promise<SeatSelectResult> {
  // 1. Flag. First statement: off means nothing below this line ever runs.
  if (!seatAutoEnrollEnabled(env)) return { ok: false, error: 'seat_auto_enroll_disabled' }

  // 2. Gate: unbound, directory channel. A bound token already has a voice (and its own agent).
  const claimedHarnessId = auth.harnessId // read before the type guard narrows `auth` to BootstrapAuth
  if (!isUnboundDirectorySession(auth)) return { ok: false, error: 'not_unbound_directory_session' }
  const memberId = auth.memberId

  // 3. The session must carry a harness pointer AND the pointer must verify live against the
  //    harnesses table for THIS member + tenant. The pointer alone proves nothing.
  if (typeof claimedHarnessId !== 'string' || claimedHarnessId.length === 0) {
    return { ok: false, error: 'harness_required' }
  }
  const harness = await loadHarness(env, memberId, claimedHarnessId)
  if (!harness) return { ok: false, error: 'harness_required' }

  // 4. The human must still be an active member of this tenant.
  const member = await env.DB.prepare(
    `SELECT id FROM members WHERE id = ?1 AND status = 'active' AND tenant = ?2 LIMIT 1`,
  ).bind(memberId, env.TENANT_SLUG).first<{ id: string }>()
  if (!member) return { ok: false, error: 'member_not_active' }

  // 5. Normalise the key on the server.
  const normalized = normalizeSeatKey(args)
  if (!normalized.ok) {
    return { ok: false, error: 'invalid_args', detail: { field: normalized.field, reason: normalized.error } }
  }
  const key = normalized.key
  const keyHash = await seatKeyHash(memberId, harness.id, key)

  // 6. Idempotent fast path.
  const found = await findSeat(env, memberId, harness.id, keyHash)
  if (found) return existingSeatResult(env, found, harness)

  // 7. Cap pre-check (cheap, no writes). The authoritative cap is the trigger inside the batch;
  //    this just keeps a capped human from provisioning a home squad / burning slugs for nothing.
  const cap = seatCap(env)
  if ((await countLiveSeats(env, memberId)) >= cap) {
    return { ok: false, error: 'seat_cap_reached', detail: { cap } }
  }

  // 8. The human's own home squad (idempotent find-or-create). The agent lives THERE and nowhere
  //    else; the human must hold admin on it.
  const home = await createHomeForMember(env, memberId)
  if (!home.ok) return { ok: false, error: 'provisioning_failed', detail: { stage: 'home', reason: home.error } }
  if (capabilityRank(home.grant.capability) < capabilityRank('admin')) {
    return { ok: false, error: 'home_rank_insufficient' }
  }

  // 9. Server-derived slug + display name. Neither comes from the caller verbatim.
  const slug = `seat-${keyHash.slice(0, 12)}`
  if (!isValidSlug(slug)) return { ok: false, error: 'provisioning_failed', detail: { stage: 'slug_derivation' } }
  const harnessLabel = sanitizeLabel(harness.client_name, 40) || harness.kind
  const kindLabel = key.harnessKindHint && harness.kind === 'unknown' ? key.harnessKindHint : harnessLabel
  const displayName = sanitizeLabel(
    [kindLabel, key.project, key.labelBasename !== key.project ? key.labelBasename : ''].filter(Boolean).join(' · '),
    120,
  )

  const preparedAgent = await prepareAgentCreate(
    env,
    home.squad.id,
    { slug, name: displayName || slug },
    { kind: 'home' },
  )
  if (!preparedAgent.ok) {
    return { ok: false, error: 'provisioning_failed', detail: { stage: 'agent', reason: preparedAgent.error } }
  }
  const agent = preparedAgent.value.agent
  const agentForMint: AgentForMint = { id: agent.id, squad_id: agent.squad_id, slug: agent.slug, name: agent.name }

  // 10. Identity weld, then the server-held directory token (the binding row must precede it).
  const agentMemberId = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  const weld = prepareAgentIdentityWeldStatements(env, agentForMint, agentMemberId, createdAt, 'member')
  const token = await prepareDirectoryTokenInsert(env, agentMemberId, `seat:${slug}`, agent.id)

  // 11. Audit row — computed from in-memory values, same discipline as bootstrap_self.
  const auditId = crypto.randomUUID()
  const auditStatement = env.DB.prepare(
    `INSERT INTO agent_audit
       (id, agent_id, actor_id, actor_type, action, fields_changed, before_state, after_state)
     VALUES (?1, ?2, ?3, 'user', 'seat_select', ?4, ?5, ?6)`,
  ).bind(
    auditId,
    agent.id,
    memberId,
    JSON.stringify(AGENT_SNAPSHOT_FIELDS),
    JSON.stringify(emptyIdentitySnapshot()),
    JSON.stringify(createdAgentSnapshot(agent)),
  )

  // 12. Seat row LAST — its BEFORE INSERT trigger enforces the cap and its UNIQUE key the
  //     idempotency, and either one aborting rolls back every statement above it.
  const seatId = crypto.randomUUID()
  const seatStatement = env.DB.prepare(
    `INSERT INTO agent_seats (id, tenant, member_id, harness_id, key_hash, agent_id, label_basename, max_live, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  ).bind(seatId, env.TENANT_SLUG, memberId, harness.id, keyHash, agent.id, key.labelBasename, cap, createdAt)

  const statements: D1PreparedStatement[] = [
    ...preparedAgent.value.statements,
    ...weld,
    token.statement,
    auditStatement,
    seatStatement,
  ]

  try {
    const writes = await deps.batch(env, statements)
    assertBatchWritten(writes, 'seat_select', 1)
  } catch (err) {
    // The batch is atomic: nothing from it is live, so there is nothing to compensate.
    if (isCapViolation(err)) return { ok: false, error: 'seat_cap_reached', detail: { cap } }
    if (isUniqueViolation(err)) {
      // A concurrent caller for the SAME key won (key UNIQUE, or the derived slug on the home
      // squad). Hand back the winner; if there is no winner for this key it was a genuine slug
      // collision with something else — refuse rather than guess.
      const winner = await findSeat(env, memberId, harness.id, keyHash)
      if (winner) return existingSeatResult(env, winner, harness)
      return { ok: false, error: 'provisioning_failed', detail: { stage: 'batch', reason: 'unique_conflict_without_winner' } }
    }
    return {
      ok: false,
      error: 'provisioning_failed',
      detail: { stage: 'batch', reason: err instanceof Error ? err.message : String(err) },
    }
  }

  return {
    ok: true,
    disposition: 'created',
    seat: { id: seatId, label: key.labelBasename, created_at: createdAt },
    harness: { id: harness.id, client_name: harness.client_name, kind: harness.kind },
    agent: { id: agent.id, slug: agent.slug, name: agent.name, squad_id: agent.squad_id },
    member_id: agentMemberId,
    audit_id: auditId,
    note: W1_NOTE,
  }
}
