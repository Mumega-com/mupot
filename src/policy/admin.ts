// src/policy/admin.ts — the Security Bar WRITE side: owner check, strong re-auth, raise, and the two-step
// lowering (request, confirm). Read side + would_block log live in ./bar (kept light on purpose).
//
// E3 conditions (Athena, task 565da9e9): raising is always allowed for the owner; lowering needs a fresh
// strong re-auth through a path the bar cannot relax (BAR_REAUTH_WINDOW_MS below, its own constant), plus a
// second owner when one exists (otherwise a delay). No automatic timed downgrade: a lowering lands only on an
// explicit confirm call. State, version and audit persist in ONE D1 batch (optimistic version check).

import type { AuthContext, Env } from '../types'
import { hasCapability, resolveCapabilities, CAPABILITY_LIVE_PREDICATE, nowCapabilitySql } from '../auth/capability'
import { memberIsActiveHuman } from '../access/identity'
import { checkWebSession } from '../secure-moments/enrol-mint'
import { LEVEL_RANK, isPolicyLevel, type PolicyLevel } from './registry'
import { clip, actorOf, getPendingLower, resolveLevel, BAR_REAUTH_WINDOW_MS, LOWER_DELAY_MS, type PendingLower, type ResolvedLevel } from './bar'


// ── owner + step-up ───────────────────────────────────────────────────────────────────────────

/** Owner = a human org-scope 'owner' capability (or the legacy owner role on a web login). Agents never. */
export async function authIsOwner(env: Env, auth: AuthContext): Promise<boolean> {
  if (auth.boundAgentId) return false
  if (auth.role === 'owner') return true
  if (!auth.memberId) return false
  try {
    const grants = auth.capabilities ?? (await resolveCapabilities(env, auth.memberId))
    return hasCapability(grants, 'org', null, 'owner')
  } catch {
    return false
  }
}

/** Strong re-auth for lowering: a real web session, member re-authenticated within BAR_REAUTH_WINDOW_MS.
 *  Reads the session through checkWebSession (not-fresh variant) and applies the bar's OWN window, so
 *  relaxing the shared step-up window can never relax this. */
export async function strongReauth(env: Env, auth: AuthContext, nowMs: number = Date.now()): Promise<boolean> {
  try {
    const s = await checkWebSession(env, auth, { fresh: false }, nowMs)
    if (!s.ok) return false
    const at = s.session.recent_reauth_at ? Date.parse(s.session.recent_reauth_at) : NaN
    return Number.isFinite(at) && nowMs - at >= 0 && nowMs - at <= BAR_REAUTH_WINDOW_MS
  } catch {
    return false
  }
}

async function otherOwnerCount(env: Env, exceptMemberId: string): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT DISTINCT c.member_id FROM capabilities c
      WHERE c.scope_type = 'org' AND c.scope_id IS NULL AND c.capability = 'owner'
        AND c.member_id != ?1 AND ${CAPABILITY_LIVE_PREDICATE('c', '?2')}`,
  ).bind(exceptMemberId, nowCapabilitySql()).all<{ member_id: string }>()
  let count = 0
  for (const row of rows.results ?? []) if (await memberIsActiveHuman(env, row.member_id)) count++
  return count
}

/** A confirming peer must already have been a human org owner when the request was made.
 * Grant events also cover promotions and legacy created_at values rounded to the second. */
async function ownerBeforeRequest(env: Env, memberId: string, requestedAt: string): Promise<boolean> {
  if (!(await memberIsActiveHuman(env, memberId))) return false
  const row = await env.DB.prepare(
    `SELECT 1 AS ok FROM capabilities c
      WHERE c.member_id = ?1 AND c.scope_type = 'org' AND c.scope_id IS NULL AND c.capability = 'owner'
        AND julianday(c.created_at) < julianday(?2)
        AND NOT EXISTS (
          SELECT 1 FROM grant_events e WHERE e.grant_table = 'capabilities' AND e.grant_id = c.id
            AND e.event = 'granted' AND julianday(e.at) >= julianday(?2)
            AND (json_extract(e.snapshot_json, '$.previous_capability') IS NULL
              OR json_extract(e.snapshot_json, '$.previous_capability') != 'owner')
        )
        AND ${CAPABILITY_LIVE_PREDICATE('c', '?3')}`,
  ).bind(memberId, requestedAt, nowCapabilitySql()).first<{ ok: number }>()
  return row !== null
}

// ── level changes ───────────────────────────────────────────────────────────────────────────────

export type ChangeRefusal =
  | 'owner_required'
  | 'invalid_level'
  | 'reauth_required'
  | 'not_a_lowering'
  | 'not_a_raise'
  | 'no_pending_request'
  | 'second_owner_required'
  | 'delay_not_elapsed'
  | 'state_unreadable'
  | 'conflict'

export type ChangeResult =
  | { ok: true; level: PolicyLevel; version: number; applied: boolean; pending?: PendingLower }
  | { ok: false; error: ChangeRefusal; retry_after?: string }

export async function logEvent(env: Env, kind: string, level: PolicyLevel | null, actor: string, scope: string, detail?: string): Promise<void> {
  try {
    await env.DB.prepare(`INSERT INTO policy_events (id, kind, rule_id, level, actor, scope, detail) VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6)`)
      .bind(crypto.randomUUID(), kind, level, clip(actor, 200), clip(scope, 200), detail ? clip(detail, 200) : null)
      .run()
  } catch {
    // the refusal itself already happened; a failed log must not turn it into a different answer
  }
}

/** One batch: compare-and-set the state, then audit and resolve/cancel only if THIS write landed. */
async function writeTenantLevel(
  env: Env, target: PolicyLevel, current: ResolvedLevel, actor: string, detail: string, pendingId: string | null = null,
): Promise<number | null> {
  const nextVersion = (current.version ?? 0) + 1
  const now = new Date().toISOString()
  const eventId = crypto.randomUUID()
  const pendingGuard = `(?6 IS NULL OR EXISTS (SELECT 1 FROM security_bar_lower_requests WHERE id = ?6 AND status = 'pending'))`
  const upsert =
    current.version === null
      ? env.DB.prepare(
          `INSERT INTO security_bar_state (scope_kind, scope_id, level, version, updated_at, updated_by)
           SELECT 'tenant', ?1, ?2, 1, ?3, ?4
            WHERE NOT EXISTS (SELECT 1 FROM security_bar_state WHERE scope_kind = 'tenant' AND scope_id = ?1)
              AND ${pendingGuard}`,
        ).bind(env.TENANT_SLUG, target, now, clip(actor, 200), current.version, pendingId)
      : env.DB.prepare(
          `UPDATE security_bar_state SET level = ?2, version = version + 1, updated_at = ?3, updated_by = ?4
            WHERE scope_kind = 'tenant' AND scope_id = ?1 AND version = ?5 AND ${pendingGuard}`,
        ).bind(env.TENANT_SLUG, target, now, clip(actor, 200), current.version, pendingId)
  // changes() refers to the immediately preceding statement in this sequential, atomic batch.
  // A matching version/level alone could have been written by a different winner.
  const audit = env.DB.prepare(
    `INSERT INTO policy_events (id, kind, rule_id, level, actor, scope, detail)
     SELECT ?1, 'level_change', NULL, ?2, ?3, ?4, ?5 WHERE changes() = 1`,
  ).bind(eventId, target, clip(actor, 200), env.TENANT_SLUG, clip(detail, 200))
  const resolve = env.DB.prepare(
    `UPDATE security_bar_lower_requests SET status = ?1, resolved_by = ?2, resolved_at = ?3
      WHERE status = 'pending' AND (?4 IS NULL OR id = ?4)
        AND EXISTS (SELECT 1 FROM policy_events WHERE id = ?5)`,
  ).bind(pendingId ? 'applied' : 'cancelled', clip(actor, 200), now, pendingId, eventId)
  const results = await env.DB.batch([upsert, audit, resolve])
  return results[0]?.meta?.changes ? nextVersion : null
}

/** RAISE strictness. Owner-only; always allowed; needs no step-up. Cancels any pending lowering. */
export async function raiseLevel(env: Env, auth: AuthContext, target: unknown): Promise<ChangeResult> {
  if (!(await authIsOwner(env, auth))) return { ok: false, error: 'owner_required' }
  if (!isPolicyLevel(target)) return { ok: false, error: 'invalid_level' }
  const current = await resolveLevel(env)
  if (current.source === 'read_failed') return { ok: false, error: 'state_unreadable' }
  if (LEVEL_RANK[target] <= LEVEL_RANK[current.level] && current.source !== 'malformed') return { ok: false, error: 'not_a_raise' }
  const actor = actorOf(auth)
  const v = await writeTenantLevel(env, target, current, actor, `raise ${current.level}->${target}`)
  if (v === null) return { ok: false, error: 'conflict' }
  return { ok: true, level: target, version: v, applied: true }
}

/** Step 1 of LOWERING. Owner + fresh strong re-auth. Creates the pending request; does NOT change the level. */
export async function requestLower(env: Env, auth: AuthContext, target: unknown, nowMs: number = Date.now()): Promise<ChangeResult> {
  const actor = actorOf(auth)
  if (!(await authIsOwner(env, auth))) return { ok: false, error: 'owner_required' }
  if (!isPolicyLevel(target)) return { ok: false, error: 'invalid_level' }
  if (!(await strongReauth(env, auth, nowMs))) {
    await logEvent(env, 'lower_refused', target, actor, env.TENANT_SLUG, 'reauth_required')
    return { ok: false, error: 'reauth_required' }
  }
  const current = await resolveLevel(env)
  if (current.source === 'read_failed') return { ok: false, error: 'state_unreadable' }
  if (LEVEL_RANK[target] >= LEVEL_RANK[current.level]) return { ok: false, error: 'not_a_lowering' }
  const memberId = auth.memberId as string // authIsOwner proved a member
  const others = await otherOwnerCount(env, memberId)
  const needsSecond = others > 0
  const id = crypto.randomUUID()
  const effective = new Date(nowMs + (needsSecond ? 0 : LOWER_DELAY_MS)).toISOString()
  const cancelOld = env.DB.prepare(`UPDATE security_bar_lower_requests SET status = 'cancelled', resolved_by = ?1, resolved_at = ?2 WHERE status = 'pending'`)
    .bind(clip(actor, 200), new Date(nowMs).toISOString())
  const insert = env.DB.prepare(
    `INSERT INTO security_bar_lower_requests (id, from_level, target_level, requested_by, requested_at, effective_after, needs_second_owner)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).bind(id, current.level, target, clip(actor, 200), new Date(nowMs).toISOString(), effective, needsSecond ? 1 : 0)
  const audit = env.DB.prepare(
    `INSERT INTO policy_events (id, kind, rule_id, level, actor, scope, detail) VALUES (?1, 'lower_requested', NULL, ?2, ?3, ?4, ?5)`,
  ).bind(crypto.randomUUID(), target, clip(actor, 200), env.TENANT_SLUG, needsSecond ? 'second_owner' : 'delay_24h')
  await env.DB.batch([cancelOld, insert, audit])
  const pending: PendingLower = { id, from_level: current.level, target_level: target, requested_by: actor, requested_at: new Date(nowMs).toISOString(), effective_after: effective, needs_second_owner: needsSecond }
  return { ok: true, level: current.level, version: current.version ?? 0, applied: false, pending }
}

/** Step 2 of LOWERING: confirm the pending request. Fresh strong re-auth again. With a second owner on the
 *  tenant the confirmer MUST be a different owner; with none, the same owner after LOWER_DELAY_MS. */
export async function confirmLower(env: Env, auth: AuthContext, nowMs: number = Date.now()): Promise<ChangeResult> {
  const actor = actorOf(auth)
  if (!(await authIsOwner(env, auth))) return { ok: false, error: 'owner_required' }
  if (!(await strongReauth(env, auth, nowMs))) {
    await logEvent(env, 'lower_refused', null, actor, env.TENANT_SLUG, 'reauth_required')
    return { ok: false, error: 'reauth_required' }
  }
  const pending = await getPendingLower(env)
  if (!pending) return { ok: false, error: 'no_pending_request' }
  const memberId = auth.memberId as string
  // Re-evaluate active human owners; a newly granted peer cannot bypass the sole-owner delay.
  const secondExists = (await otherOwnerCount(env, memberId)) > 0
  if (pending.needs_second_owner || secondExists) {
    if (pending.requested_by === actor || !(await ownerBeforeRequest(env, memberId, pending.requested_at))) {
      await logEvent(env, 'lower_refused', pending.target_level, actor, env.TENANT_SLUG, 'second_owner_required')
      return { ok: false, error: 'second_owner_required' }
    }
  } else if (nowMs < Date.parse(pending.effective_after)) {
    await logEvent(env, 'lower_refused', pending.target_level, actor, env.TENANT_SLUG, 'delay_not_elapsed')
    return { ok: false, error: 'delay_not_elapsed', retry_after: pending.effective_after }
  }
  const current = await resolveLevel(env)
  if (current.source === 'read_failed') return { ok: false, error: 'state_unreadable' }
  if (LEVEL_RANK[pending.target_level] >= LEVEL_RANK[current.level]) return { ok: false, error: 'not_a_lowering' }
  const v = await writeTenantLevel(env, pending.target_level, current, actor, `lower ${current.level}->${pending.target_level} req ${pending.id.slice(0, 8)}`, pending.id)
  if (v === null) return { ok: false, error: 'conflict' }
  return { ok: true, level: pending.target_level, version: v, applied: true }
}

