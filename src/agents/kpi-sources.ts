// mupot — pluggable KPI signal sources (S4b: real domain signals for the goal loop).
//
// The goal loop's original KPI progress was a TASK-COUNTER: done tasks / target_count.
// This is coarse and can be stuck at 0 when kpi_target is text without a leading integer.
//
// This module introduces a PLUGGABLE SOURCE interface so each agent/pot can select the
// signal that actually measures its output. The adapter is pure data → no bus calls,
// no external fetch, no secrets — it only reads from the pot's own D1 tables.
//
// ── Source registry (add new sources here) ────────────────────────────────────────────
//
//   'task_counter'  — (DEFAULT) done tasks / parseLeadingInt(kpi_target). Backward-compat;
//                     keeps all existing agents unchanged (no migration, no config change).
//
//   'github_prs'    — COUNT of merged PRs in the trailing window (default: 30 days) in
//                     github_prs_merged, divided by parseLeadingInt(kpi_target). The dev-pot
//                     (mumega#0) sets this to get a real signal.
//                     READ MECHANISM: purely event-fed (the GitHub webhook handler writes a
//                     row on pull_request closed+merged). NO poll, NO GITHUB_TOKEN used here.
//
// ── Selection ────────────────────────────────────────────────────────────────────────
//
// Source is selected via agent.kpi_target suffix: "10 prs/month [github_prs]" → uses
// 'github_prs'. Any kpi_target without a source tag → 'task_counter' (default).
// This keeps all existing agents unchanged (no schema migration for agent config).
//
// ── Degradation contract ────────────────────────────────────────────────────────────
//
// ANY DB hiccup returns { ok: false } — the caller (safeWriteProgress in loop.ts) swallows
// it and leaves kpi_progress unchanged. A source failure is NEVER a cycle abort. This
// matches the S4a episodic pattern.

import type { Env, Agent } from '../types'

// ── Source identifier ─────────────────────────────────────────────────────────

export type KpiSourceId = 'task_counter' | 'github_prs'

const KPI_SOURCE_IDS: readonly KpiSourceId[] = ['task_counter', 'github_prs']

export function isKpiSourceId(v: unknown): v is KpiSourceId {
  return typeof v === 'string' && (KPI_SOURCE_IDS as readonly string[]).includes(v)
}

// ── Source result ─────────────────────────────────────────────────────────────

export type KpiSignalResult =
  | { ok: true; count: number; target: number; progress: number; source: KpiSourceId }
  | { ok: false; reason: string; source: KpiSourceId }

// ── Source selection ──────────────────────────────────────────────────────────

/**
 * Parse the KPI source tag from kpi_target. The tag is an optional suffix in brackets:
 *   "10 tasks/week"            → 'task_counter' (default)
 *   "10 prs/month [github_prs]" → 'github_prs'
 *   "20 [github_prs]"          → 'github_prs'
 *
 * Returns 'task_counter' when no tag is present (backward-compatible default).
 */
export function parseKpiSource(kpiTarget: string | null | undefined): KpiSourceId {
  if (!kpiTarget) return 'task_counter'
  const m = kpiTarget.match(/\[([^\]]+)\]\s*$/)
  if (!m) return 'task_counter'
  const tag = m[1].trim()
  return isKpiSourceId(tag) ? tag : 'task_counter'
}

// ── Leading integer parser (re-exported for tests; canonical copy stays in loop.ts) ──

/**
 * Parse the leading integer from a kpi_target string. Returns null when absent.
 * Identical logic to parseLeadingInt in loop.ts — duplicated here to keep
 * kpi-sources.ts import-free from loop.ts (no circular dep).
 */
export function parseKpiTarget(s: string | null | undefined): number | null {
  if (!s || s.trim().length === 0) return null
  const m = s.trim().match(/^(\d+)/)
  if (!m) return null
  const n = parseInt(m[1], 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

// ── 'task_counter' source ─────────────────────────────────────────────────────

/**
 * task_counter — count of 'done' tasks assigned to the agent, divided by the
 * target integer parsed from kpi_target. The original loop behavior, now a named
 * source so it can be selected explicitly.
 */
export async function taskCounterSource(
  env: Env,
  agent: Agent,
): Promise<KpiSignalResult> {
  const target = parseKpiTarget(agent.kpi_target)
  if (target === null) {
    return { ok: false, reason: 'no_target', source: 'task_counter' }
  }
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM tasks
       WHERE assignee_agent_id = ? AND status = 'done' LIMIT 1`,
  )
    .bind(agent.id)
    .first<{ cnt: number }>()
  const count = row?.cnt ?? 0
  const progress = Math.min(100, Math.round((count / target) * 1000) / 10)
  return { ok: true, count, target, progress, source: 'task_counter' }
}

// ── 'github_prs' source ───────────────────────────────────────────────────────

/**
 * Window for counting merged PRs (default: 30 days). Configurable via the source
 * tag for future extension, but fixed for v1: "[github_prs]" always uses 30d.
 * Injectable for tests so they don't need real clocks.
 */
export const GITHUB_PRS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

/**
 * github_prs — count of merged PRs in the trailing 30-day window in
 * github_prs_merged, divided by the target from kpi_target.
 *
 * READ MECHANISM: purely event-fed (migration 0038). The GitHub webhook handler
 * writes a row on pull_request closed+merged=true. NO polling, NO GITHUB_TOKEN.
 *
 * When github_prs_merged table does not exist yet (migration not applied) the
 * DB.prepare().first() will throw, and the caller's safe wrapper degrades gracefully.
 */
export async function githubPrsSource(
  env: Env,
  agent: Agent,
  opts: { nowMs?: number } = {},
): Promise<KpiSignalResult> {
  const target = parseKpiTarget(agent.kpi_target)
  if (target === null) {
    return { ok: false, reason: 'no_target', source: 'github_prs' }
  }
  const nowMs = opts.nowMs ?? Date.now()
  const windowStart = nowMs - GITHUB_PRS_WINDOW_MS

  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM github_prs_merged
       WHERE tenant_id = ? AND merged_at >= ? LIMIT 1`,
  )
    .bind(env.TENANT_SLUG, windowStart)
    .first<{ cnt: number }>()
  const count = row?.cnt ?? 0
  const progress = Math.min(100, Math.round((count / target) * 1000) / 10)
  return { ok: true, count, target, progress, source: 'github_prs' }
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

/**
 * computeKpiSignal — the single entry point the loop calls.
 *
 * Dispatches to the correct source adapter based on parseKpiSource(agent.kpi_target).
 * Generic agents (no source tag) get 'task_counter' — ZERO behavior change.
 *
 * Injectable seams (taskCounter, githubPrs) for test isolation — no D1 in tests.
 */
export async function computeKpiSignal(
  env: Env,
  agent: Agent,
  deps: {
    taskCounter?: (env: Env, agent: Agent) => Promise<KpiSignalResult>
    githubPrs?: (env: Env, agent: Agent, opts?: { nowMs?: number }) => Promise<KpiSignalResult>
    nowMs?: number
  } = {},
): Promise<KpiSignalResult> {
  const source = parseKpiSource(agent.kpi_target)
  switch (source) {
    case 'github_prs': {
      const fn = deps.githubPrs ?? githubPrsSource
      return fn(env, agent, { nowMs: deps.nowMs })
    }
    case 'task_counter':
    default: {
      const fn = deps.taskCounter ?? taskCounterSource
      return fn(env, agent)
    }
  }
}

// ── github_prs_merged writer (called by the webhook handler) ──────────────────

export interface RecordMergedPrInput {
  repo: string    // "owner/repo" (already safeField-sanitized by github-routes)
  prNumber: number
  title: string | null
  nowMs?: number  // injectable for tests
}

export interface RecordMergedPrResult {
  ok: boolean
  inserted: boolean // false = already recorded (idempotent)
}

/**
 * recordMergedPr — write a merged PR observation into github_prs_merged.
 *
 * Called by the GitHub webhook handler when it sees pull_request closed+merged.
 * INSERT OR IGNORE → a webhook redelivery (same PR) is a safe no-op.
 *
 * Never throws — returns { ok: false } on any DB error. The webhook handler
 * should log but always ack GitHub (200 OK) even on a record failure.
 */
export async function recordMergedPr(
  env: Env,
  input: RecordMergedPrInput,
): Promise<RecordMergedPrResult> {
  try {
    const nowMs = input.nowMs ?? Date.now()
    const id = `gpr-${env.TENANT_SLUG}-${input.repo.replace(/[^a-z0-9]/gi, '-')}-${input.prNumber}-${nowMs}`

    const result = await env.DB.prepare(
      `INSERT OR IGNORE INTO github_prs_merged
         (id, tenant_id, repo, pr_number, title, merged_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, env.TENANT_SLUG, input.repo, input.prNumber, input.title, nowMs, nowMs)
      .run()

    return { ok: true, inserted: (result.meta?.changes ?? 0) > 0 }
  } catch {
    return { ok: false, inserted: false }
  }
}
