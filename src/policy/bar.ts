// src/policy/bar.ts — the Security Bar READ side: level resolution, policy(), the would_block log.
// Deliberately light (types + registry only) so task/mcp/agent modules can import it without pulling
// auth or session code into their bundle graph (top-level-await cycle risk). The guarded level-change
// flows (owner, step-up, lowering) live in ./admin. Registry (data) lives in ./registry.
//
// E3 conditions (Athena, task 565da9e9), each pinned by tests/security-bar.test.ts:
//   * Baseline protections never turn off: floors resolve strict at every level, re-asserted here.
//   * A missing or malformed setting, or a failed read, is the STRICTER level. Concretely:
//       - failed read, or a row whose level is not one of the three  -> under_attack (strictest)
//       - no tenant row at all (a pre-bar tenant)                     -> operating  (today's behaviour,
//         one step stricter than the onboarding default; a new tenant is put on 'onboarding' explicitly)
//   * No request-local cache is kept at MODULE level (Workers isolates are shared across requests).
//     policy() reads fresh every call; a caller that wants a per-request memo builds a PolicyReader,
//     which is an instance scoped to that request and never stored globally.
//   * Raising is always allowed for the owner. Lowering needs (1) a fresh strong re-auth through a path
//     the bar cannot relax (own window below, not the relaxable step-up window), plus (2) a second owner
//     when one exists, otherwise a delay. Never an automatic timed downgrade: a lowering lands only on an
//     explicit confirm call.
//   * State, version and audit persist in one D1 batch; the audit row is conditioned on the state write
//     having landed (optimistic version check).

import type { AuthContext, Env } from '../types'
import { LEVEL_RANK, POLICY_LEVELS, getRule, isPolicyLevel, type PolicyLevel, type PolicyValue } from './registry'

export type PolicyScopeKind = 'tenant' | 'department' | 'squad' | 'project' | 'agent'

/** Nearest scope first when resolving. tenant is implicit (env.TENANT_SLUG). */
export interface PolicyScope {
  department?: string | null
  squad?: string | null
  project?: string | null
  agent?: string | null
}

export const MISSING_LEVEL: PolicyLevel = 'operating'
export const FAIL_CLOSED_LEVEL: PolicyLevel = 'under_attack'
/** Bar step-up window. Deliberately its own constant, NOT the shared RECENT_REAUTH_WINDOW_MS: the shared
 *  window is a relaxable friction rule candidate; the bar's must not move with the bar. */
export const BAR_REAUTH_WINDOW_MS = 5 * 60 * 1000
/** Delay before a lowering can be confirmed when there is no second owner. */
export const LOWER_DELAY_MS = 24 * 60 * 60 * 1000
export const LOWER_DELAY_MS_FOR_TESTS = LOWER_DELAY_MS

const NEAR_TO_FAR: readonly Exclude<PolicyScopeKind, 'tenant'>[] = ['agent', 'project', 'squad', 'department']

const stricter = (a: PolicyLevel, b: PolicyLevel): PolicyLevel => (LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b)

export interface ResolvedLevel {
  level: PolicyLevel
  /** why: 'row' | 'missing' | 'malformed' | 'read_failed' */
  source: 'row' | 'missing' | 'malformed' | 'read_failed'
  version: number | null
}

/** Resolve the effective level for a scope: nearest valid row wins, but is never LOOSER than the tenant
 *  level (a nearer scope may tighten the bar, never loosen it). Fails closed. */
export async function resolveLevel(env: Env, scope: PolicyScope = {}): Promise<ResolvedLevel> {
  const probes: Array<{ kind: PolicyScopeKind; id: string }> = [{ kind: 'tenant', id: env.TENANT_SLUG }]
  for (const kind of NEAR_TO_FAR) {
    const id = scope[kind]
    if (typeof id === 'string' && id.length > 0) probes.push({ kind, id })
  }
  let rows: Array<{ scope_kind: string; scope_id: string; level: string; version: number }>
  try {
    const where = probes.map((_, i) => `(scope_kind = ?${i * 2 + 1} AND scope_id = ?${i * 2 + 2})`).join(' OR ')
    const res = await env.DB.prepare(`SELECT scope_kind, scope_id, level, version FROM security_bar_state WHERE ${where}`)
      .bind(...probes.flatMap((p) => [p.kind, p.id]))
      .all<{ scope_kind: string; scope_id: string; level: string; version: number }>()
    rows = res.results ?? []
  } catch {
    return { level: FAIL_CLOSED_LEVEL, source: 'read_failed', version: null }
  }
  if (!Array.isArray(rows)) return { level: FAIL_CLOSED_LEVEL, source: 'read_failed', version: null }

  const find = (kind: PolicyScopeKind, id: string) => rows.find((r) => r.scope_kind === kind && r.scope_id === id)
  const tenantRow = find('tenant', env.TENANT_SLUG)
  let tenant: ResolvedLevel
  if (!tenantRow) tenant = { level: MISSING_LEVEL, source: 'missing', version: null }
  else if (!isPolicyLevel(tenantRow.level)) tenant = { level: FAIL_CLOSED_LEVEL, source: 'malformed', version: null }
  else tenant = { level: tenantRow.level, source: 'row', version: Number(tenantRow.version) || null }

  for (const p of probes.slice(1)) {
    const r = find(p.kind, p.id)
    if (!r) continue
    // Nearest wins; a malformed nearer row is the strictest answer, not a silent skip.
    const nearer: PolicyLevel = isPolicyLevel(r.level) ? r.level : FAIL_CLOSED_LEVEL
    return { level: stricter(nearer, tenant.level), source: isPolicyLevel(r.level) ? 'row' : 'malformed', version: Number(r.version) || null }
  }
  return tenant
}

export interface PolicyDecision {
  ruleId: string
  level: PolicyLevel
  value: PolicyValue
  floor: boolean
  relaxed: boolean
}

/** The read API: policy(env, scope, ruleId). Unknown rule ids and floors are strict. */
export async function policy(env: Env, scope: PolicyScope, ruleId: string): Promise<PolicyDecision> {
  const { level } = await resolveLevel(env, scope)
  return decide(ruleId, level)
}

function decide(ruleId: string, level: PolicyLevel): PolicyDecision {
  const rule = getRule(ruleId)
  // An unregistered id is a programming error: fail closed, never relaxed.
  if (!rule || rule.floor) return { ruleId, level, value: 'strict', floor: rule?.floor ?? false, relaxed: false }
  const value = rule.values[level]
  return { ruleId, level, value, floor: false, relaxed: value === 'relaxed' }
}

/** A per-request memo. Build one per request and drop it with the request; never assign to module scope. */
export class PolicyReader {
  private memo = new Map<string, Promise<ResolvedLevel>>()
  constructor(private readonly env: Env) {}
  async policy(scope: PolicyScope, ruleId: string): Promise<PolicyDecision> {
    const key = NEAR_TO_FAR.map((k) => scope[k] ?? '').join('|')
    let p = this.memo.get(key)
    if (!p) { p = resolveLevel(this.env, scope); this.memo.set(key, p) }
    return decide(ruleId, (await p).level)
  }
}

// ── would_block / relaxed_applied log ───────────────────────────────────────────────────────────

export interface RelaxContext {
  /** 'member:<id>' | 'agent:<id>' | 'system:<name>' - ids only. */
  actor: string
  /** What was acted on, 'task:<id>' | 'squad:<id>' ... ids only. */
  scopeRef: string
  /** Optional short enum-ish tag. Sanitised and truncated; never a body. */
  detail?: string
  scope?: PolicyScope
}


const SAFE = /[^A-Za-z0-9_.:@\-/ ]/g
export const clip = (s: string, n: number): string => s.replace(SAFE, '_').slice(0, n)

export function actorOf(auth: AuthContext): string {
  if (auth.boundAgentId) return `agent:${auth.boundAgentId}`
  return `member:${auth.memberId ?? auth.userId}`
}

/**
 * Call ONLY when the strict check would have refused. Returns true iff the bar relaxes the rule at the
 * current level AND the record was written. Onboarding uses 'would_block' (the log the later
 * "pave" proposals learn from). Every wired rule stays strict at operating. If the
 * record cannot be written the answer is false: an unaudited relaxation never happens.
 */
export async function relaxes(env: Env, ruleId: string, ctx: RelaxContext): Promise<boolean> {
  let d: PolicyDecision
  try {
    d = await policy(env, ctx.scope ?? {}, ruleId)
  } catch {
    return false
  }
  if (!d.relaxed) return false
  try {
    await env.DB.prepare(
      `INSERT INTO policy_events (id, kind, rule_id, level, actor, scope, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
      .bind(
        crypto.randomUUID(),
        d.level === 'onboarding' ? 'would_block' : 'relaxed_applied',
        ruleId,
        d.level,
        clip(ctx.actor, 200) || 'unknown',
        clip(ctx.scopeRef, 200) || 'unknown',
        ctx.detail ? clip(ctx.detail, 200) : null,
      )
      .run()
    return true
  } catch {
    return false
  }
}

export interface PendingLower {
  id: string
  from_level: PolicyLevel
  target_level: PolicyLevel
  requested_by: string
  requested_at: string
  effective_after: string
  needs_second_owner: boolean
}

export async function getPendingLower(env: Env): Promise<PendingLower | null> {
  try {
    const r = await env.DB.prepare(
      `SELECT id, from_level, target_level, requested_by, requested_at, effective_after, needs_second_owner
         FROM security_bar_lower_requests WHERE status = 'pending' LIMIT 1`,
    ).first<Omit<PendingLower, 'needs_second_owner'> & { needs_second_owner: number }>()
    if (!r || !isPolicyLevel(r.from_level) || !isPolicyLevel(r.target_level)) return null
    return { ...r, needs_second_owner: r.needs_second_owner === 1 }
  } catch {
    return null
  }
}

// ── read view ───────────────────────────────────────────────────────────────────────────────────

export interface BarView {
  level: PolicyLevel
  source: ResolvedLevel['source']
  version: number | null
  pending_lower: PendingLower | null
}

export async function barView(env: Env): Promise<BarView> {
  const r = await resolveLevel(env)
  return { level: r.level, source: r.source, version: r.version, pending_lower: await getPendingLower(env) }
}

export { POLICY_LEVELS }

/** The `security_bar` field boot_context and orient carry, so every agent sees the level it is working under.
 *  Never throws (a failed read already resolves to under_attack). */
export async function securityBarField(env: Env): Promise<{ security_bar: { level: PolicyLevel; pending_lower: boolean; note: string } }> {
  const v = await barView(env)
  const note =
    v.level === 'onboarding' ? 'onboarding: friction rules are relaxed and relaxed uses are logged (would_block); the owner raises the bar when ready'
    : v.level === 'operating' ? "operating: all rules strict, exactly today's behaviour; choose onboarding to opt in to friction relaxations"
    : 'under_attack: all rules strict; floors remain enforced'
  return { security_bar: { level: v.level, pending_lower: v.pending_lower !== null, note } }
}
