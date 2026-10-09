// src/hygiene/archive.ts — receipted archive/unarchive substrate (mupot#1496).
//
// One core pair, archiveRow/unarchiveRow, covers the five tables the data-
// hygiene audit (mupot#1496, PR #1556's classifier) found accumulating
// build-time debris: members, agents, squads, projects, tasks. "Mark and
// archive, never delete" (the issue's own words): every call writes a
// conditional UPDATE (or, for tasks, an INSERT into a side table — see
// migrations/0173_archive_columns.sql's header for why tasks is a side table
// and why members.status is not WIDENED — it is set to the existing
// 'suspended' value instead) PLUS one immutable receipt row in
// `archive_receipts`.
//
// ROUND 2 (Athena BLOCK + adversarial BLOCK on PR #1561): this module now
// takes `auth: AuthContext` — archiving a member is a rank-ceiling-gated
// action (exceedsTargetRankCeiling, the SAME predicate PATCH /members/:id
// already uses for suspend/reactivate/mint, per mupot#1337), not a bare
// dependent-safety check. It is no longer true that "this module never reads
// auth" (Round 1's framing) — auth is load-bearing for members specifically.
//
// ATOMICITY: state mutation + revocation-that-is-a-plain-SQL-statement +
// receipt are now ONE `env.DB.batch([...])` call. The receipt INSERT is
// `... SELECT ... WHERE changes() = 1` — the SAME cross-statement idiom this
// codebase already uses (src/members/index.ts's telegram-unbind receipt,
// migrations 0071/0134/0135's triggers, src/flight-spine/receipts.ts) to make
// one statement's write conditional on the row count the PREVIOUS statement
// in the same transaction actually changed, rather than two separate
// non-transactional `.run()` calls (Round 1's shape — Athena's repro: a
// `BEFORE INSERT ON archive_receipts` failure left the state UPDATE committed
// with no receipt). Session revocation (web_sessions, agent_sessions) still
// happens as a SEPARATE, best-effort step AFTER the batch commits — those go
// through existing helper functions (revokeAllWebSessions,
// revokeAllAgentSessionsForMember), not raw prepared statements a batch can
// hold, and this codebase already accepts that exact shape for
// deactivate_agent's own agent_sessions revoke (documented there).
//
// WRITE-TIME RE-ASSERTION: every dependent-safety predicate (squad/project
// active dependents, task claim/flight state, member agent-seat ownership) is
// embedded directly in the guarded write's WHERE/SELECT clause, not just
// checked ahead of time — a change between the pre-read and the write
// converges to a clean, re-derived refusal instead of a corrupted write.

import type { AuthContext, Env } from '../types'
import { assertWritten, rowsWritten } from '../lib/receipt'
import { revokeAllWebSessions } from '../auth/web-sessions'
import { revokeAllAgentSessionsForMember } from '../auth/agent-sessions'
import { exceedsTargetRankCeiling, targetLegacyRoleRank, capabilityRank } from '../auth/capability'
import { TOKEN_LIVE_PREDICATE, nowSqlUtc } from '../auth/token-lifecycle'
import { TASK_NOT_ARCHIVED_SQL } from './filters'
import { isTaskStatus, ALL_TASK_STATUSES } from '../tasks/service'
import { archiveBlockingDispatchExistsSql, hasArchiveBlockingDispatch } from '../tasks/runtime-receipts'

export const ARCHIVABLE_TABLES = ['members', 'agents', 'squads', 'projects', 'tasks'] as const
export type ArchivableTable = (typeof ARCHIVABLE_TABLES)[number]

export function isArchivableTable(value: unknown): value is ArchivableTable {
  return typeof value === 'string' && (ARCHIVABLE_TABLES as readonly string[]).includes(value)
}

export interface ArchiveInput {
  table: ArchivableTable
  id: string
  reason: string
  actorMemberId: string
  /** tasks only (mupot#1571 plan drift check): the status the reviewed plan saw. When set,
   *  the archive is refused for this row if tasks.status no longer matches — checked inside
   *  the guarded INSERT's own WHERE, not only in a pre-read. */
  expectedStatus?: string
}

export interface UnarchiveInput {
  table: ArchivableTable
  id: string
  reason: string
  actorMemberId: string
}

export type ArchiveOutcome =
  | {
      ok: true
      status: 'archived'
      receiptId: string
      revoked?: { tokens: number; web_sessions: number; agent_sessions: number }
    }
  | { ok: true; status: 'already_archived' }
  | { ok: false; error: 'not_found' }
  | { ok: false; error: 'invalid_reason' }
  | { ok: false; error: 'active_dependents'; counts: Record<string, number> }
  | { ok: false; error: 'live_execution_claim' }
  | { ok: false; error: 'in_air_flight' }
  // mupot#1571: an unsettled dispatch receipt - the bus consumer would still deliver it.
  | { ok: false; error: 'in_flight_dispatch' }
  | { ok: false; error: 'status_drift'; expected: string; actual: string }
  | { ok: false; error: 'invalid_expected_status'; accepted: readonly string[] }
  | { ok: false; error: 'owns_active_agent'; counts: { active_agents: number } }
  | { ok: false; error: 'cannot_archive_self' }
  | { ok: false; error: 'cannot_affect_higher_rank' }
  | { ok: false; error: 'last_org_owner' }
  | { ok: false; error: 'must_deactivate_first'; tool: 'deactivate_agent' }
  | { ok: false; error: 'not_supported' }
  | { ok: false; error: 'archive_refused_conflict' }

export type UnarchiveOutcome =
  | { ok: true; status: 'unarchived'; receiptId: string }
  | { ok: true; status: 'not_archived' }
  | { ok: false; error: 'not_found' }
  | { ok: false; error: 'invalid_reason' }
  // mupot#1571: a task cannot be revived inside an archived squad or project.
  | { ok: false; error: 'parent_archived'; parent: 'squad' | 'project' }
  | { ok: false; error: 'cannot_affect_higher_rank' }
  | { ok: false; error: 'not_supported' }

function validReason(reason: string): boolean {
  const trimmed = reason.trim()
  return trimmed.length > 0 && trimmed.length <= 2000
}

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * mupot#1571 / #1778 / #1780: archiving TASKS stays off unless `TASK_ARCHIVE_ENABLED` is exactly '1'.
 * The action-boundary guards ship on every task writer and on every autonomous effect site
 * (cron sweeps and their effect helpers) regardless of the flag; the flag only gates CREATING
 * archived tasks. Flipping it is a separate, deliberate change.
 */
export function taskArchiveEnabled(env: Env): boolean {
  return env.TASK_ARCHIVE_ENABLED === '1'
}

/** archiveRow — the single entry point for marking members/agents/squads/projects/tasks archived.
 *
 *  `tasks` was held back in mupot#1496 Round 3 because archive was only a READER filter: every
 *  task-mutating writer kept acting on an archived task. mupot#1571 made archive an ACTION
 *  boundary: every `UPDATE tasks` in src/ carries TASK_NOT_ARCHIVED_SQL in its own WHERE or is on
 *  the justified allowlist in tests/task-archive-action-boundary.test.ts (a raw-text seam scan
 *  that fails CI on a new unguarded writer), and every autonomous effect site (scheduled sweeps
 *  and the helpers they call) re-asserts not-archived at the point of effect (#1780).
 *
 *  `tasks` is additionally gated by taskArchiveEnabled(env): with the flag off the tasks arm
 *  returns `not_supported` (the other four tables are unaffected). */
export async function archiveRow(env: Env, auth: AuthContext, input: ArchiveInput): Promise<ArchiveOutcome> {
  if (!validReason(input.reason)) return { ok: false, error: 'invalid_reason' }

  switch (input.table) {
    case 'members':
      return archiveMember(env, auth, input)
    case 'agents':
      return archiveAgent(env, input)
    case 'squads':
      return archiveSquad(env, input)
    case 'projects':
      return archiveProject(env, input)
    case 'tasks':
      if (!taskArchiveEnabled(env)) return { ok: false, error: 'not_supported' }
      return archiveTask(env, input)
  }
}

export async function unarchiveRow(env: Env, auth: AuthContext, input: UnarchiveInput): Promise<UnarchiveOutcome> {
  if (!validReason(input.reason)) return { ok: false, error: 'invalid_reason' }

  switch (input.table) {
    case 'members':
      return unarchiveMember(env, auth, input)
    case 'agents':
      return unarchiveSimple(env, 'agents', input, { statusColumn: null })
    case 'squads':
      return unarchiveSimple(env, 'squads', input, { statusColumn: 'status', restoreStatus: 'active' })
    case 'projects':
      return unarchiveProject(env, input)
    case 'tasks':
      if (!taskArchiveEnabled(env)) return { ok: false, error: 'not_supported' }
      return unarchiveTask(env, input)
  }
}

async function insertReceiptUnconditional(
  env: Env,
  table: ArchivableTable,
  id: string,
  action: 'archive' | 'unarchive',
  reason: string,
  actorMemberId: string,
  priorStatus: string | null,
): Promise<string> {
  const receiptId = crypto.randomUUID()
  const result = await env.DB.prepare(
    `INSERT INTO archive_receipts (id, tenant, entity_table, entity_id, action, reason, actor_member_id, prior_status, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(receiptId, env.TENANT_SLUG, table, id, action, reason, actorMemberId, priorStatus, nowIso())
    .run()
  assertWritten(result, `${action}_row.receipt.backfill`, 1)
  return receiptId
}

/** True only when `id` is a row THIS TENANT considers currently enforced-
 *  archived — the per-table "is this row archived" signal
 *  (members/agents: archived_at IS NOT NULL; squads/projects: status =
 *  'archived'), tenant-scoped where the table has a tenant column at all
 *  (only `members` — agents/squads/projects have none; this D1 IS the pot,
 *  single-tenant, so there is nothing to scope for them). Used to keep
 *  backfillReceiptIfMissing from ever minting a receipt for a row that
 *  isn't actually archived, or that belongs to a different tenant entirely
 *  (adversarial P1-B). */
async function isRowCurrentlyArchived(env: Env, table: 'members' | 'agents' | 'squads' | 'projects', id: string): Promise<boolean> {
  if (table === 'members') {
    const row = await env.DB.prepare(
      'SELECT archived_at FROM members WHERE id = ?1 AND (tenant = ?2 OR tenant IS NULL)',
    ).bind(id, env.TENANT_SLUG).first<{ archived_at: string | null }>()
    return row?.archived_at != null
  }
  if (table === 'agents') {
    const row = await env.DB.prepare('SELECT archived_at FROM agents WHERE id = ?1').bind(id).first<{ archived_at: string | null }>()
    return row?.archived_at != null
  }
  const row = await env.DB.prepare(`SELECT status FROM ${table} WHERE id = ?1`).bind(id).first<{ status: string }>()
  return row?.status === 'archived'
}

/** Backfill a missing receipt for an already-enforced archive (adversarial P1-1 / Round 2):
 *  a prior call's state-flip could have landed while its OWN receipt attempt failed on an
 *  earlier, non-atomic build of this module, or a future bug could reintroduce the gap. The
 *  "already_archived" path self-heals rather than leaving a permanently unreceipted row.
 *
 *  mupot#1496 Round 3 (adversarial P1-B): gated on isRowCurrentlyArchived — a caller
 *  reaching this function after a 0-row write (a race, or a genuinely-refused
 *  archive that merely LOOKED clean on recheck) must never mint a phantom
 *  receipt for a row this tenant does not currently consider archived, or
 *  that belongs to a different tenant entirely. */
async function backfillReceiptIfMissing(
  env: Env,
  table: 'members' | 'agents' | 'squads' | 'projects',
  id: string,
  reason: string,
  actorMemberId: string,
): Promise<void> {
  if (!(await isRowCurrentlyArchived(env, table, id))) return
  const existing = await env.DB.prepare(
    `SELECT id FROM archive_receipts WHERE entity_table = ?1 AND entity_id = ?2 AND action = 'archive' LIMIT 1`,
  ).bind(table, id).first<{ id: string }>()
  if (existing) return
  await insertReceiptUnconditional(env, table, id, 'archive', reason, actorMemberId, null)
}

// ── members ──────────────────────────────────────────────────────────────────

const OWNER_RANK = capabilityRank('owner')

/** True when `memberId` holds ORG-SCOPE owner standing specifically — an
 *  org-scope `capabilities` row (capability='owner', scope_id IS NULL) OR
 *  the legacy `users.role='owner'` plane (via targetLegacyRoleRank, the SAME
 *  helper actorRankOnScopeFor/exceedsTargetRankCeiling already use for the
 *  legacy plane — never a second copy). Deliberately NOT
 *  targetMaxRankAcrossScopes, which is GLOBAL across every scope a member
 *  holds a grant on and would count a merely SQUAD-scoped 'owner' capability
 *  as an "org owner" — the exact over-counting the last-owner check exists
 *  to avoid. */
async function isOrgScopeOwner(env: Env, memberId: string): Promise<boolean> {
  const capRow = await env.DB.prepare(
    `SELECT 1 FROM capabilities WHERE member_id = ?1 AND scope_type = 'org' AND scope_id IS NULL AND capability = 'owner'`,
  ).bind(memberId).first()
  if (capRow) return true
  return (await targetLegacyRoleRank(env, memberId)) >= OWNER_RANK
}

/** mupot#1496 Round 4 (Athena, confirmation-pass BLOCK on f42b9996): the
 *  last-org-owner refusal above is JS-only — a fast pre-check that reads
 *  state, THEN a separate atomic write. Two owners archiving each other
 *  concurrently can both pass the pre-check (each still sees the OTHER as an
 *  active survivor before either write commits) and both writes then
 *  succeed, leaving zero org owners. D1 serializes actual writes against a
 *  given database, so embedding the SAME survivor predicate directly in the
 *  guarded UPDATE's WHERE — as a correlated subquery evaluated at write time,
 *  not at pre-read time — makes the two concurrent archives serialize on it:
 *  whichever write commits first suspends its target; the second's WHERE
 *  re-evaluates the survivor subquery against that now-committed state and
 *  correctly finds no other owner, so its own UPDATE matches 0 rows.
 *
 *  Deliberately expressed with NO new bind parameters — `?5` (input.id) and
 *  `?1` (env.TENANT_SLUG) are already bound by the caller's UPDATE, so this
 *  fragment is spliced into that same statement's WHERE clause without
 *  touching its bind order. Checks BOTH authority planes the JS-side
 *  isOrgScopeOwner does (an org-scope capabilities row, or the legacy
 *  users.role='owner' plane bridged by lower(email)) — never a second,
 *  narrower copy of that logic. */
function orgOwnerSurvivorGuardSQL(idParam: string, tenantParam: string): string {
  // NOTE: every leaf check below is an EXISTS, deliberately — never a scalar
  // `(SELECT role FROM users ...) = 'owner'` comparison. A scalar comparison
  // against a subquery that finds no matching row returns SQL NULL, and
  // `FALSE OR NULL` is NULL (three-valued logic), not FALSE — which a WHERE
  // clause then treats as no-match, refusing rows that should have passed.
  // This is exactly the mutation-invisible bug a first draft of this
  // function had: it silently refused EVERY archive (not just an owner's),
  // because the legacy-role EXISTS-shaped check was a scalar `=` compare
  // whose NULL poisoned the surrounding OR. EXISTS never returns NULL.
  return `(
    NOT (
      EXISTS (SELECT 1 FROM capabilities c WHERE c.member_id = ${idParam} AND c.scope_type = 'org' AND c.scope_id IS NULL AND c.capability = 'owner')
      OR EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = (SELECT lower(email) FROM members WHERE id = ${idParam}) AND u.role = 'owner')
    )
    OR EXISTS (
      SELECT 1 FROM members m2
       WHERE m2.id != ${idParam}
         AND m2.status = 'active'
         AND m2.archived_at IS NULL
         AND (m2.tenant = ${tenantParam} OR m2.tenant IS NULL)
         AND (
           EXISTS (SELECT 1 FROM capabilities c2 WHERE c2.member_id = m2.id AND c2.scope_type = 'org' AND c2.scope_id IS NULL AND c2.capability = 'owner')
           OR EXISTS (SELECT 1 FROM users u2 WHERE lower(u2.email) = lower(m2.email) AND u2.role = 'owner')
         )
    )
  )`
}

/** Every reason members archival can be refused, independent of the write's own row count.
 *  Called BEFORE attempting the write (fast fail) and, if the guarded write still returns 0
 *  rows, called AGAIN to produce an honest, freshly-derived refusal instead of guessing. */
async function checkMemberArchivable(env: Env, auth: AuthContext, input: ArchiveInput): Promise<ArchiveOutcome | null> {
  if (input.actorMemberId === input.id) return { ok: false, error: 'cannot_archive_self' }

  if (await exceedsTargetRankCeiling(env, auth, input.id)) {
    return { ok: false, error: 'cannot_affect_higher_rank' }
  }

  if (await isOrgScopeOwner(env, input.id)) {
    // mupot#1496 Round 3 (Athena P0 — org-scope-only, not Round 2's
    // targetMaxRankAcrossScopes, which is GLOBAL across every scope and
    // would count a member who is merely a SQUAD-scoped owner as a
    // surviving "org owner"). "Last owner" is specifically about the org's
    // top-level owner standing, so the survivor count must check the SAME
    // narrow thing: an org-scope capabilities row OR the legacy role plane
    // (targetLegacyRoleRank — the same helper the rank-ceiling path already
    // reuses, never a second hand-rolled copy). Excludes suspended/archived/
    // foreign-tenant members from counting as a "surviving" owner — a
    // suspended or archived owner cannot actually act, so is not a real
    // safety net; only ACTIVE, same-tenant members count. Short-circuits the
    // moment one other real owner is found; a rare, high-stakes action, so
    // an O(members) worst case (no other owner exists) is an acceptable cost.
    const others = await env.DB.prepare(
      `SELECT id FROM members WHERE id != ?1 AND status = 'active' AND archived_at IS NULL AND (tenant = ?2 OR tenant IS NULL)`,
    ).bind(input.id, env.TENANT_SLUG).all<{ id: string }>()
    let anotherOwnerExists = false
    for (const other of others.results ?? []) {
      if (await isOrgScopeOwner(env, other.id)) {
        anotherOwnerExists = true
        break
      }
    }
    if (!anotherOwnerExists) return { ok: false, error: 'last_org_owner' }
  }

  // "Owns a live agent seat" — THREE relationship shapes, not just
  // agents.owner_member_id (adversarial P0-2: that column is set on ~1 row
  // tenant-wide; the real seat link is agent_member_bindings and an
  // agent-bound member_tokens row). Any of the three pointing at a
  // currently-active agent refuses archiving the member out from under it —
  // suspending the member would revoke credentials backing a live agent
  // without going through deactivate_agent's fleet-consumer/ops protection.
  // Third UNION arm aliases member_tokens as `t` and uses TOKEN_LIVE_PREDICATE
  // (not a bare `revoked_at IS NULL`) — only a LIVE credential represents a
  // real risk of suspending the member breaking a currently-usable agent
  // credential; a revoked token's agent_id linkage is historical, not live.
  // tests/token-lifecycle-real-schema.test.ts's shared-predicate ratchet
  // requires every member_tokens SELECT in src/ to consume this export.
  const activeSeats = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM (
       SELECT a.id FROM agents a WHERE a.owner_member_id = ?1 AND a.status IN ('active','paused')
       UNION
       SELECT a.id FROM agent_member_bindings b
         JOIN agents a ON a.id = b.agent_id
        WHERE b.member_id = ?1 AND a.status IN ('active','paused')
       UNION
       SELECT a.id FROM member_tokens t
         JOIN agents a ON a.id = t.agent_id
        WHERE t.member_id = ?1 AND t.agent_id IS NOT NULL AND a.status IN ('active','paused') AND ${TOKEN_LIVE_PREDICATE('?2')}
     )`,
  ).bind(input.id, nowSqlUtc()).first<{ n: number }>()
  const activeAgents = activeSeats?.n ?? 0
  if (activeAgents > 0) {
    return { ok: false, error: 'owns_active_agent', counts: { active_agents: activeAgents } }
  }

  return null
}

async function archiveMember(env: Env, auth: AuthContext, input: ArchiveInput): Promise<ArchiveOutcome> {
  // mupot#1496 Round 3 (adversarial P1-B): tenant-scoped from the very first
  // read — a foreign-tenant id must read as not_found here, not merely at
  // the guarded UPDATE three steps later.
  const row = await env.DB.prepare('SELECT id FROM members WHERE id = ?1 AND (tenant = ?2 OR tenant IS NULL)')
    .bind(input.id, env.TENANT_SLUG)
    .first<{ id: string }>()
  if (!row) return { ok: false, error: 'not_found' }

  const preCheck = await checkMemberArchivable(env, auth, input)
  if (preCheck) return preCheck

  const now = nowIso()
  const receiptId = crypto.randomUUID()

  // Idempotency + write-time re-assertion, ALL in the guarded UPDATE's WHERE:
  //  - NOT (archived_at IS NOT NULL AND status='suspended') — "already fully
  //    enforced" is the ONLY thing that should make this a no-op. A member
  //    reactivated via PATCH /members/:id (status back to 'active') while
  //    archived_at stayed set is NOT treated as already-archived (adversarial
  //    P1-2) — it is re-suspended, and archived_prior_status is refreshed to
  //    the TRUE current status via `archived_prior_status = status` (SQLite
  //    evaluates every SET expression against the pre-update row).
  //  - orgOwnerSurvivorGuardSQL re-asserts the last-owner predicate at write
  //    time (Round 4, Athena): the JS-side pre-check in checkMemberArchivable
  //    is a fast fail only, not the actual guard — two owners archiving each
  //    other concurrently must serialize on THIS clause, not both slip past a
  //    pre-read that is already stale by the time either write lands.
  //  - the three agent-seat NOT EXISTS clauses re-assert checkMemberArchivable's
  //    "owns_active_agent" predicate at write time, not just at the pre-read.
  const stmts = [
    env.DB.prepare(
      `UPDATE members SET
              status = 'suspended',
              tenant = ?1,
              archived_at = ?2,
              archived_reason = ?3,
              archived_by_member_id = ?4,
              archived_prior_status = status
        WHERE id = ?5
          AND (tenant = ?1 OR tenant IS NULL)
          AND NOT (archived_at IS NOT NULL AND status = 'suspended')
          AND ${orgOwnerSurvivorGuardSQL('?5', '?1')}
          AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.owner_member_id = ?5 AND a.status IN ('active','paused'))
          AND NOT EXISTS (
            SELECT 1 FROM agent_member_bindings b JOIN agents a ON a.id = b.agent_id
             WHERE b.member_id = ?5 AND a.status IN ('active','paused')
          )
          AND NOT EXISTS (
            SELECT 1 FROM member_tokens t JOIN agents a ON a.id = t.agent_id
             WHERE t.member_id = ?5 AND t.agent_id IS NOT NULL AND a.status IN ('active','paused') AND ${TOKEN_LIVE_PREDICATE('?6')}
          )`,
    ).bind(env.TENANT_SLUG, now, input.reason, input.actorMemberId, input.id, nowSqlUtc()),
    // The receipt is the VERY NEXT statement after the member UPDATE — not
    // after the token revoke below — specifically so `changes() = 1` here
    // reflects the member UPDATE's own row count. The token revoke
    // legitimately writes 0 rows when there is nothing live to revoke, and
    // gating on ITS count instead would wrongly skip the receipt for a
    // member archived with no live tokens.
    env.DB.prepare(
      `INSERT INTO archive_receipts (id, tenant, entity_table, entity_id, action, reason, actor_member_id, prior_status, created_at)
        SELECT ?1, ?2, 'members', ?3, 'archive', ?4, ?5, m.archived_prior_status, ?6
          FROM members m WHERE m.id = ?3 AND changes() = 1`,
    ).bind(receiptId, env.TENANT_SLUG, input.id, input.reason, input.actorMemberId, now),
    // mupot#1496 Round 3 (adversarial P1-A): NOT merely "unconditional" —
    // gated on THIS call's own archive having actually landed, via an EXISTS
    // matching the EXACT (archived_at, archived_by_member_id) the guarded
    // UPDATE above just set. A refused archive (the UPDATE's WHERE matched 0
    // rows — a race, or any dependent-safety predicate) must revoke NOTHING;
    // `changes()` alone is not used here because it reflects only the
    // IMMEDIATELY PRECEDING statement (the receipt insert, not the member
    // UPDATE two statements back) — this EXISTS check is self-contained and
    // correct regardless of statement ordering.
    env.DB.prepare(
      `UPDATE member_tokens SET revoked_at = ?1
        WHERE tenant = ?2 AND member_id = ?3 AND revoked_at IS NULL
          AND EXISTS (
            SELECT 1 FROM members WHERE id = ?3 AND archived_at = ?1 AND archived_by_member_id = ?4
          )`,
    ).bind(now, env.TENANT_SLUG, input.id, input.actorMemberId),
  ]

  const results = await env.DB.batch(stmts)
  const memberChanges = rowsWritten(results[0])
  if (memberChanges === 0) {
    // Converge to an honest, freshly-derived refusal (P1-1 / write-time
    // re-assertion) rather than assuming "already archived".
    const recheck = await checkMemberArchivable(env, auth, input)
    if (recheck) return recheck
    // mupot#1496 Round 4 (Athena, confirmation-pass BLOCK): a 0-row write with
    // NO refusal reason from the recheck is a success-shaped no-op unless the
    // row is ACTUALLY archived right now — checkMemberArchivable only proves
    // "nothing refuses archiving it", never "it IS archived". Returning
    // ok:true/already_archived here when the member is still active and its
    // tokens are still live would tell the caller (and the CLI's success
    // count) the archive landed when it did not. Only report already_archived
    // when isRowCurrentlyArchived confirms it; otherwise this is a genuine,
    // unexplained write conflict (e.g. a benign race against another writer)
    // and must be reported as one.
    if (await isRowCurrentlyArchived(env, 'members', input.id)) {
      await backfillReceiptIfMissing(env, 'members', input.id, input.reason, input.actorMemberId)
      return { ok: true, status: 'already_archived' }
    }
    return { ok: false, error: 'archive_refused_conflict' }
  }

  assertWritten(results[1], 'archive_row.members.receipt', 1)

  const revokedTokens = rowsWritten(results[2])
  const [{ revokedCount: revokedWebSessions }, { revokedCount: revokedAgentSessions }] = await Promise.all([
    revokeAllWebSessions(env, env.TENANT_SLUG, input.id, 'archived'),
    revokeAllAgentSessionsForMember(env, env.TENANT_SLUG, input.id, 'archived'),
  ])

  return {
    ok: true,
    status: 'archived',
    receiptId,
    revoked: { tokens: revokedTokens, web_sessions: revokedWebSessions, agent_sessions: revokedAgentSessions },
  }
}

// ── agents ───────────────────────────────────────────────────────────────────

async function archiveAgent(env: Env, input: ArchiveInput): Promise<ArchiveOutcome> {
  const row = await env.DB.prepare('SELECT id, status, archived_at FROM agents WHERE id = ?1')
    .bind(input.id)
    .first<{ id: string; status: string; archived_at: string | null }>()
  if (!row) return { ok: false, error: 'not_found' }

  // archive_row never deactivates implicitly — deactivate_agent already owns
  // that teardown (tokens, fleet_agents, agent_keys, agent_sessions) and this
  // tool must not fork a second copy of it.
  if (row.status !== 'inactive') {
    return { ok: false, error: 'must_deactivate_first', tool: 'deactivate_agent' }
  }

  const now = nowIso()
  const receiptId = crypto.randomUUID()
  const stmts = [
    env.DB.prepare(
      `UPDATE agents SET archived_at = ?1, archived_reason = ?2, archived_by_member_id = ?3
        WHERE id = ?4 AND status = 'inactive' AND archived_at IS NULL`,
    ).bind(now, input.reason, input.actorMemberId, input.id),
    env.DB.prepare(
      `INSERT INTO archive_receipts (id, tenant, entity_table, entity_id, action, reason, actor_member_id, prior_status, created_at)
        SELECT ?1, ?2, 'agents', ?3, 'archive', ?4, ?5, NULL, ?6
        WHERE changes() = 1`,
    ).bind(receiptId, env.TENANT_SLUG, input.id, input.reason, input.actorMemberId, now),
  ]
  const results = await env.DB.batch(stmts)
  if (rowsWritten(results[0]) === 0) {
    // Re-derive the refusal fresh: could be a genuine already_archived, or a
    // race where the agent's status changed away from 'inactive' between the
    // pre-read and the write.
    const fresh = await env.DB.prepare('SELECT status, archived_at FROM agents WHERE id = ?1')
      .bind(input.id).first<{ status: string; archived_at: string | null }>()
    if (fresh?.status !== 'inactive') {
      return { ok: false, error: 'must_deactivate_first', tool: 'deactivate_agent' }
    }
    // mupot#1496 Round 4 (Athena, confirmation-pass BLOCK): the same
    // success-shaped no-op as archiveMember — `status='inactive'` alone does
    // not mean archived. Only report already_archived when
    // isRowCurrentlyArchived confirms archived_at is actually set; a 0-row
    // write against an inactive-but-not-archived row is an unexplained
    // conflict, not a success to report.
    if (await isRowCurrentlyArchived(env, 'agents', input.id)) {
      await backfillReceiptIfMissing(env, 'agents', input.id, input.reason, input.actorMemberId)
      return { ok: true, status: 'already_archived' }
    }
    return { ok: false, error: 'archive_refused_conflict' }
  }
  assertWritten(results[1], 'archive_row.agents.receipt', 1)
  return { ok: true, status: 'archived', receiptId }
}

// ── squads ───────────────────────────────────────────────────────────────────

async function squadActiveDependentCounts(env: Env, squadId: string): Promise<{ agents: number; members: number; tasks: number }> {
  const [{ n: activeAgents }, { n: activeMembers }, { n: activeTasks }] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM agents WHERE squad_id = ?1 AND status = 'active'`)
      .bind(squadId).first<{ n: number }>() as Promise<{ n: number }>,
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM capabilities c
        JOIN members m ON m.id = c.member_id
        WHERE c.scope_type = 'squad' AND c.scope_id = ?1 AND m.archived_at IS NULL`,
    ).bind(squadId).first<{ n: number }>() as Promise<{ n: number }>,
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM tasks WHERE squad_id = ?1 AND status IN ('open','in_progress','review') AND ${TASK_NOT_ARCHIVED_SQL()}`,
    ).bind(squadId).first<{ n: number }>() as Promise<{ n: number }>,
  ])
  return { agents: activeAgents, members: activeMembers, tasks: activeTasks }
}

async function archiveSquad(env: Env, input: ArchiveInput): Promise<ArchiveOutcome> {
  const row = await env.DB.prepare('SELECT id FROM squads WHERE id = ?1')
    .bind(input.id)
    .first<{ id: string }>()
  if (!row) return { ok: false, error: 'not_found' }

  const counts = await squadActiveDependentCounts(env, input.id)
  if (counts.agents > 0 || counts.members > 0 || counts.tasks > 0) {
    return { ok: false, error: 'active_dependents', counts }
  }

  const now = nowIso()
  const receiptId = crypto.randomUUID()
  const stmts = [
    // Write-time re-assertion: the SAME three predicates, embedded directly
    // in this UPDATE's WHERE — a dependent appearing between the pre-read
    // above and this write makes the UPDATE itself a no-op, never a corrupt
    // archive of a squad that just became non-empty.
    env.DB.prepare(
      `UPDATE squads SET status = 'archived', archived_at = ?1, archived_reason = ?2, archived_by_member_id = ?3
        WHERE id = ?4 AND status != 'archived'
          AND NOT EXISTS (SELECT 1 FROM agents WHERE squad_id = ?4 AND status = 'active')
          AND NOT EXISTS (
            SELECT 1 FROM capabilities c JOIN members m ON m.id = c.member_id
             WHERE c.scope_type = 'squad' AND c.scope_id = ?4 AND m.archived_at IS NULL
          )
          AND NOT EXISTS (SELECT 1 FROM tasks WHERE squad_id = ?4 AND status IN ('open','in_progress','review') AND ${TASK_NOT_ARCHIVED_SQL()})`,
    ).bind(now, input.reason, input.actorMemberId, input.id),
    env.DB.prepare(
      `INSERT INTO archive_receipts (id, tenant, entity_table, entity_id, action, reason, actor_member_id, prior_status, created_at)
        SELECT ?1, ?2, 'squads', ?3, 'archive', ?4, ?5, 'active', ?6
        WHERE changes() = 1`,
    ).bind(receiptId, env.TENANT_SLUG, input.id, input.reason, input.actorMemberId, now),
  ]
  const results = await env.DB.batch(stmts)
  if (rowsWritten(results[0]) === 0) {
    const fresh = await env.DB.prepare('SELECT status FROM squads WHERE id = ?1').bind(input.id).first<{ status: string }>()
    if (fresh?.status !== 'archived') {
      const freshCounts = await squadActiveDependentCounts(env, input.id)
      return { ok: false, error: 'active_dependents', counts: freshCounts }
    }
    await backfillReceiptIfMissing(env, 'squads', input.id, input.reason, input.actorMemberId)
    return { ok: true, status: 'already_archived' }
  }
  assertWritten(results[1], 'archive_row.squads.receipt', 1)
  return { ok: true, status: 'archived', receiptId }
}

// ── projects ─────────────────────────────────────────────────────────────────

async function projectActiveTaskCount(env: Env, projectId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?1 AND status IN ('open','in_progress','review') AND ${TASK_NOT_ARCHIVED_SQL()}`,
  ).bind(projectId).first<{ n: number }>()
  return row?.n ?? 0
}

async function archiveProject(env: Env, input: ArchiveInput): Promise<ArchiveOutcome> {
  const row = await env.DB.prepare('SELECT id, status FROM projects WHERE id = ?1')
    .bind(input.id)
    .first<{ id: string; status: string }>()
  if (!row) return { ok: false, error: 'not_found' }

  const activeTasks = await projectActiveTaskCount(env, input.id)
  if (activeTasks > 0) {
    return { ok: false, error: 'active_dependents', counts: { tasks: activeTasks } }
  }

  const now = nowIso()
  const receiptId = crypto.randomUUID()
  const stmts = [
    env.DB.prepare(
      `UPDATE projects SET status = 'archived', archived_at = ?1, archived_reason = ?2,
              archived_by_member_id = ?3, archived_prior_status = status
        WHERE id = ?4 AND status != 'archived'
          AND NOT EXISTS (SELECT 1 FROM tasks WHERE project_id = ?4 AND status IN ('open','in_progress','review') AND ${TASK_NOT_ARCHIVED_SQL()})`,
    ).bind(now, input.reason, input.actorMemberId, input.id),
    env.DB.prepare(
      `INSERT INTO archive_receipts (id, tenant, entity_table, entity_id, action, reason, actor_member_id, prior_status, created_at)
        SELECT ?1, ?2, 'projects', ?3, 'archive', ?4, ?5, p.archived_prior_status, ?6
          FROM projects p WHERE p.id = ?3 AND changes() = 1`,
    ).bind(receiptId, env.TENANT_SLUG, input.id, input.reason, input.actorMemberId, now),
  ]
  const results = await env.DB.batch(stmts)
  if (rowsWritten(results[0]) === 0) {
    const fresh = await env.DB.prepare('SELECT status FROM projects WHERE id = ?1').bind(input.id).first<{ status: string }>()
    if (fresh?.status !== 'archived') {
      const freshActiveTasks = await projectActiveTaskCount(env, input.id)
      return { ok: false, error: 'active_dependents', counts: { tasks: freshActiveTasks } }
    }
    await backfillReceiptIfMissing(env, 'projects', input.id, input.reason, input.actorMemberId)
    return { ok: true, status: 'already_archived' }
  }
  assertWritten(results[1], 'archive_row.projects.receipt', 1)
  return { ok: true, status: 'archived', receiptId }
}

// ── unarchive: agents / squads ───────────────────────────────────────────────

async function unarchiveSimple(
  env: Env,
  table: 'agents' | 'squads',
  input: UnarchiveInput,
  opts: { statusColumn: 'status' | null; restoreStatus?: string },
): Promise<UnarchiveOutcome> {
  const row = await env.DB.prepare(`SELECT id FROM ${table} WHERE id = ?1`)
    .bind(input.id)
    .first<{ id: string }>()
  if (!row) return { ok: false, error: 'not_found' }

  const receiptId = crypto.randomUUID()
  const setClause = opts.statusColumn
    ? `status = ?1, archived_at = NULL, archived_reason = NULL, archived_by_member_id = NULL`
    : `archived_at = NULL, archived_reason = NULL, archived_by_member_id = NULL`
  const bindArgs = opts.statusColumn ? [opts.restoreStatus, input.id] : [input.id]
  const whereClause = opts.statusColumn ? `id = ?2 AND status = 'archived'` : `id = ?1 AND archived_at IS NOT NULL`
  const now = nowIso()

  const stmts = [
    env.DB.prepare(`UPDATE ${table} SET ${setClause} WHERE ${whereClause}`).bind(...bindArgs),
    env.DB.prepare(
      `INSERT INTO archive_receipts (id, tenant, entity_table, entity_id, action, reason, actor_member_id, prior_status, created_at)
        SELECT ?1, ?2, ?3, ?4, 'unarchive', ?5, ?6, ?7, ?8
        WHERE changes() = 1`,
    ).bind(receiptId, env.TENANT_SLUG, table, input.id, input.reason, input.actorMemberId, opts.statusColumn ? 'archived' : null, now),
  ]
  const results = await env.DB.batch(stmts)
  if (rowsWritten(results[0]) === 0) return { ok: true, status: 'not_archived' }
  assertWritten(results[1], `unarchive_row.${table}.receipt`, 1)
  return { ok: true, status: 'unarchived', receiptId }
}

async function unarchiveMember(env: Env, auth: AuthContext, input: UnarchiveInput): Promise<UnarchiveOutcome> {
  // mupot#1496 Round 3 (adversarial P0-B): tenant-scoped, matching archiveMember's
  // own convention (a legacy NULL-tenant row is still adoptable; a REAL foreign-
  // tenant row is not found at all — never leak its existence cross-tenant).
  const row = await env.DB.prepare(
    'SELECT id, archived_prior_status FROM members WHERE id = ?1 AND (tenant = ?2 OR tenant IS NULL)',
  )
    .bind(input.id, env.TENANT_SLUG)
    .first<{ id: string; archived_prior_status: string | null }>()
  if (!row) return { ok: false, error: 'not_found' }

  // mupot#1496 Round 3 (adversarial P0-B): reactivating an archived member is
  // the SAME rank-ceiling-gated action as archiving one — a plain admin must
  // not be able to reverse an owner's archive any more than they could have
  // performed it. The exact #1337 predicate, not a second copy.
  if (await exceedsTargetRankCeiling(env, auth, input.id)) {
    return { ok: false, error: 'cannot_affect_higher_rank' }
  }

  const restoreStatus = row.archived_prior_status ?? 'active'
  const now = nowIso()
  const receiptId = crypto.randomUUID()
  const stmts = [
    env.DB.prepare(
      `UPDATE members SET status = ?1, tenant = ?3, archived_at = NULL, archived_reason = NULL,
              archived_by_member_id = NULL, archived_prior_status = NULL
        WHERE id = ?2 AND (tenant = ?3 OR tenant IS NULL) AND archived_at IS NOT NULL`,
    ).bind(restoreStatus, input.id, env.TENANT_SLUG),
    env.DB.prepare(
      `INSERT INTO archive_receipts (id, tenant, entity_table, entity_id, action, reason, actor_member_id, prior_status, created_at)
        SELECT ?1, ?2, 'members', ?3, 'unarchive', ?4, ?5, 'archived', ?6
        WHERE changes() = 1`,
    ).bind(receiptId, env.TENANT_SLUG, input.id, input.reason, input.actorMemberId, now),
  ]
  const results = await env.DB.batch(stmts)
  if (rowsWritten(results[0]) === 0) return { ok: true, status: 'not_archived' }
  assertWritten(results[1], 'unarchive_row.members.receipt', 1)
  // Unarchiving restores STANDING (status), never credentials — a suspended-
  // then-archived member's tokens/sessions were revoked on the way in and
  // stay revoked on the way out; re-authenticating mints fresh ones through
  // the normal login/mint paths, exactly like reactivating a suspended member
  // today.
  return { ok: true, status: 'unarchived', receiptId }
}

async function unarchiveProject(env: Env, input: UnarchiveInput): Promise<UnarchiveOutcome> {
  const row = await env.DB.prepare('SELECT id, status, archived_prior_status FROM projects WHERE id = ?1')
    .bind(input.id)
    .first<{ id: string; status: string; archived_prior_status: string | null }>()
  if (!row) return { ok: false, error: 'not_found' }
  if (row.status !== 'archived') return { ok: true, status: 'not_archived' }

  const restoreStatus = row.archived_prior_status ?? 'active'
  const now = nowIso()
  const receiptId = crypto.randomUUID()
  const stmts = [
    env.DB.prepare(
      `UPDATE projects SET status = ?1, archived_at = NULL, archived_reason = NULL,
              archived_by_member_id = NULL, archived_prior_status = NULL
        WHERE id = ?2 AND status = 'archived'`,
    ).bind(restoreStatus, input.id),
    env.DB.prepare(
      `INSERT INTO archive_receipts (id, tenant, entity_table, entity_id, action, reason, actor_member_id, prior_status, created_at)
        SELECT ?1, ?2, 'projects', ?3, 'unarchive', ?4, ?5, 'archived', ?6
        WHERE changes() = 1`,
    ).bind(receiptId, env.TENANT_SLUG, input.id, input.reason, input.actorMemberId, now),
  ]
  const results = await env.DB.batch(stmts)
  if (rowsWritten(results[0]) === 0) return { ok: true, status: 'not_archived' }
  assertWritten(results[1], 'unarchive_row.projects.receipt', 1)
  return { ok: true, status: 'unarchived', receiptId }
}

// ── tasks (side table — tasks.status is never written by ARCHIVE) ───────────
//
// mupot#1571. Archiving writes only tasks_archive_state (+ a receipt). The action
// boundary lives in every task writer (TASK_NOT_ARCHIVED_SQL in each UPDATE's WHERE),
// so while a row sits in that table nothing can claim, assign, advance, verdict or
// dispatch it. UNARCHIVE restores tasks.status to the captured prior_status (a no-op in
// every reachable case, since a guarded writer cannot move the status meanwhile; it
// repairs a direct D1 edit rather than trusting that).

// Non-terminal flight statuses: flights.status CHECK is
// ('preflight','held','running','waiting','sleeping','landed','failed') —
// only landed/failed are terminal.
const IN_AIR_FLIGHT_STATUSES_SQL = `f.status NOT IN ('landed','failed')`

async function taskArchivabilityBlocker(
  env: Env,
  taskId: string,
  expectedStatus: string | undefined,
): Promise<ArchiveOutcome | null> {
  const row = await env.DB.prepare('SELECT status, execution_claim_expires_at FROM tasks WHERE id = ?1')
    .bind(taskId)
    .first<{ status: string; execution_claim_expires_at: number | null }>()
  if (!row) return { ok: false, error: 'not_found' }
  if (expectedStatus !== undefined && row.status !== expectedStatus) {
    return { ok: false, error: 'status_drift', expected: expectedStatus, actual: row.status }
  }
  if (row.status === 'in_progress' && row.execution_claim_expires_at !== null && row.execution_claim_expires_at > Date.now()) {
    return { ok: false, error: 'live_execution_claim' }
  }
  const inAirRow = await env.DB.prepare(
    `SELECT 1 FROM flights f
      WHERE ${IN_AIR_FLIGHT_STATUSES_SQL}
        AND (
          EXISTS (SELECT 1 FROM flight_lanes fl WHERE fl.flight_id = f.id AND fl.task_id = ?1)
          OR EXISTS (SELECT 1 FROM flight_task_assignments fta WHERE fta.flight_id = f.id AND fta.task_id = ?1)
          OR (json_valid(f.meta) AND EXISTS (SELECT 1 FROM json_each(f.meta, '$.task_ids') WHERE value = ?1))
        )
      LIMIT 1`,
  ).bind(taskId).first()
  if (inAirRow) return { ok: false, error: 'in_air_flight' }
  if (await hasArchiveBlockingDispatch(env, taskId)) return { ok: false, error: 'in_flight_dispatch' }
  return null
}

async function archiveTask(env: Env, input: ArchiveInput): Promise<ArchiveOutcome> {
  // Unknown status values are rejected, never compared: a typo'd expected status would
  // otherwise read as "drifted" (or worse, silently match nothing).
  if (input.expectedStatus !== undefined && !isTaskStatus(input.expectedStatus)) {
    return { ok: false, error: 'invalid_expected_status', accepted: ALL_TASK_STATUSES }
  }
  const expected = input.expectedStatus ?? null

  const exists = await env.DB.prepare('SELECT 1 FROM tasks WHERE id = ?1').bind(input.id).first()
  if (!exists) return { ok: false, error: 'not_found' }

  // Already archived is checked FIRST so an idempotent retry of a successful archive is
  // never reported as drift/claim/flight (the status it saw is exactly what it archived).
  if (await isTaskRowArchived(env, input.id)) {
    await backfillTaskReceiptIfMissing(env, input.id, input.reason, input.actorMemberId)
    return { ok: true, status: 'already_archived' }
  }

  const blocker = await taskArchivabilityBlocker(env, input.id, input.expectedStatus)
  if (blocker) return blocker

  const now = nowIso()
  const receiptId = crypto.randomUUID()
  // Write-time re-assertion: the drift, live-claim and in-air-flight predicates ride in the
  // INSERT ... SELECT's own WHERE, so a change between the pre-read and the write converges
  // to 0 rows and a freshly re-derived refusal. OR IGNORE: a concurrent archive of the same
  // task (PRIMARY KEY) is a 0-row no-op, not an exception.
  const stmts = [
    env.DB.prepare(
      `INSERT OR IGNORE INTO tasks_archive_state (task_id, archived_at, archived_reason, archived_by_member_id, prior_status, created_at)
        SELECT t.id, ?1, ?2, ?3, t.status, ?1
          FROM tasks t
         WHERE t.id = ?4
           AND (?6 IS NULL OR t.status = ?6)
           AND NOT (
             t.status = 'in_progress' AND t.execution_claim_expires_at IS NOT NULL
             AND t.execution_claim_expires_at > ?5
           )
           AND NOT EXISTS (
             SELECT 1 FROM flights f
              WHERE ${IN_AIR_FLIGHT_STATUSES_SQL}
                AND (
                  EXISTS (SELECT 1 FROM flight_lanes fl WHERE fl.flight_id = f.id AND fl.task_id = t.id)
                  OR EXISTS (SELECT 1 FROM flight_task_assignments fta WHERE fta.flight_id = f.id AND fta.task_id = t.id)
                  OR (json_valid(f.meta) AND EXISTS (SELECT 1 FROM json_each(f.meta, '$.task_ids') WHERE value = t.id))
                )
           )
           AND NOT ${archiveBlockingDispatchExistsSql({ tenantParam: '?7', taskIdExpr: 't.id' })}`,
    ).bind(now, input.reason, input.actorMemberId, input.id, Date.now(), expected, env.TENANT_SLUG),
    env.DB.prepare(
      `INSERT INTO archive_receipts (id, tenant, entity_table, entity_id, action, reason, actor_member_id, prior_status, created_at)
        SELECT ?1, ?2, 'tasks', ?3, 'archive', ?4, ?5, s.prior_status, ?6
          FROM tasks_archive_state s WHERE s.task_id = ?3 AND changes() = 1`,
    ).bind(receiptId, env.TENANT_SLUG, input.id, input.reason, input.actorMemberId, now),
  ]
  const results = await env.DB.batch(stmts)
  if (rowsWritten(results[0]) === 0) {
    // 0 rows: a predicate changed since the pre-read, or a concurrent archive won. Re-derive.
    if (await isTaskRowArchived(env, input.id)) {
      await backfillTaskReceiptIfMissing(env, input.id, input.reason, input.actorMemberId)
      return { ok: true, status: 'already_archived' }
    }
    const fresh = await taskArchivabilityBlocker(env, input.id, input.expectedStatus)
    if (fresh) return fresh
    return { ok: false, error: 'archive_refused_conflict' }
  }
  assertWritten(results[1], 'archive_row.tasks.receipt', 1)
  return { ok: true, status: 'archived', receiptId }
}

async function isTaskRowArchived(env: Env, taskId: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT 1 FROM tasks_archive_state WHERE task_id = ?1').bind(taskId).first()
  return row !== null
}

async function backfillTaskReceiptIfMissing(env: Env, taskId: string, reason: string, actorMemberId: string): Promise<void> {
  const existing = await env.DB.prepare(
    `SELECT id FROM archive_receipts WHERE entity_table = 'tasks' AND entity_id = ?1 AND action = 'archive' LIMIT 1`,
  ).bind(taskId).first<{ id: string }>()
  if (existing) return
  const state = await env.DB.prepare('SELECT prior_status FROM tasks_archive_state WHERE task_id = ?1')
    .bind(taskId).first<{ prior_status: string }>()
  await insertReceiptUnconditional(env, 'tasks', taskId, 'archive', reason, actorMemberId, state?.prior_status ?? null)
}

/** SQL: the task's squad and project are both NOT archived (a NULL project counts as fine). Embedded in
 *  all three unarchive statements so a parent archived mid-call cannot be bypassed by the pre-read. */
const TASK_PARENTS_ACTIVE_SQL = (taskParam: string): string => `NOT EXISTS (
  SELECT 1 FROM tasks pt
    LEFT JOIN squads psq ON psq.id = pt.squad_id
    LEFT JOIN projects ppr ON ppr.id = pt.project_id
   WHERE pt.id = ${taskParam} AND (psq.status = 'archived' OR ppr.status = 'archived')
)`

async function archivedParentOfTask(env: Env, taskId: string): Promise<'squad' | 'project' | null> {
  const row = await env.DB.prepare(
    `SELECT psq.status AS squad_status, ppr.status AS project_status FROM tasks pt
       LEFT JOIN squads psq ON psq.id = pt.squad_id
       LEFT JOIN projects ppr ON ppr.id = pt.project_id
      WHERE pt.id = ?1`,
  ).bind(taskId).first<{ squad_status: string | null; project_status: string | null }>()
  if (row?.squad_status === 'archived') return 'squad'
  if (row?.project_status === 'archived') return 'project'
  return null
}

async function unarchiveTask(env: Env, input: UnarchiveInput): Promise<UnarchiveOutcome> {
  const state = await env.DB.prepare('SELECT prior_status FROM tasks_archive_state WHERE task_id = ?1')
    .bind(input.id).first<{ prior_status: string }>()
  if (!state) {
    const task = await env.DB.prepare('SELECT 1 FROM tasks WHERE id = ?1').bind(input.id).first()
    return task ? { ok: true, status: 'not_archived' } : { ok: false, error: 'not_found' }
  }
  const parent = await archivedParentOfTask(env, input.id)
  if (parent) return { ok: false, error: 'parent_archived', parent }
  const now = nowIso()
  const receiptId = crypto.randomUUID()
  // ONE batch: restore status from the state row's own prior_status (read inside the
  // statement, not carried from the pre-read), mint the receipt from the same row, then
  // delete it. This UPDATE runs while the row is still archived and is allowlisted for
  // exactly that reason (see tests/task-archive-action-boundary.test.ts).
  const stmts = [
    env.DB.prepare(
      `UPDATE tasks SET status = (SELECT prior_status FROM tasks_archive_state WHERE task_id = ?1), updated_at = ?2
        WHERE id = ?1
          AND EXISTS (SELECT 1 FROM tasks_archive_state s WHERE s.task_id = ?1 AND s.prior_status != tasks.status)
          AND ${TASK_PARENTS_ACTIVE_SQL('?1')}`,
    ).bind(input.id, now),
    env.DB.prepare(
      `INSERT INTO archive_receipts (id, tenant, entity_table, entity_id, action, reason, actor_member_id, prior_status, created_at)
        SELECT ?1, ?2, 'tasks', ?3, 'unarchive', ?4, ?5, s.prior_status, ?6
          FROM tasks_archive_state s WHERE s.task_id = ?3 AND ${TASK_PARENTS_ACTIVE_SQL('?3')}`,
    ).bind(receiptId, env.TENANT_SLUG, input.id, input.reason, input.actorMemberId, now),
    env.DB.prepare(
      `DELETE FROM tasks_archive_state
        WHERE task_id = ?1
          AND EXISTS (SELECT 1 FROM archive_receipts WHERE id = ?2)
          AND ${TASK_PARENTS_ACTIVE_SQL('?1')}`,
    ).bind(input.id, receiptId),
  ]
  const results = await env.DB.batch(stmts)
  if (rowsWritten(results[2]) === 0) {
    // Nothing deleted: either the parent got archived since the pre-read, or the state row was already gone.
    const raced = await archivedParentOfTask(env, input.id)
    if (raced) return { ok: false, error: 'parent_archived', parent: raced }
    return { ok: true, status: 'not_archived' }
  }
  assertWritten(results[1], 'unarchive_row.tasks.receipt', 1)
  return { ok: true, status: 'unarchived', receiptId }
}
