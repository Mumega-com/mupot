// mupot — episodic memory layer (S4a sane-brain).
//
// Episodic memory records WHAT HAPPENED on each notable goal-cycle: a durable,
// recency-ordered per-agent timeline that the loop re-reads each cycle so the
// agent knows its own recent trajectory ("last N cycles I did X, Y, Z").
//
// This is DISTINCT from the two existing memory surfaces:
//   - Semantic engrams (src/memory/index.ts) — Vectorize-backed similarity
//     recall over outcome text. LLM-driven, async embedding pipeline.
//   - loop_decision_dedup — idempotent reservation key, NOT a log.
//
// Episodic memory is:
//   STRUCTURED   — typed rows with kind/cycle/kpi_progress; queryable without a
//                  model call or embedding.
//   RECENCY-ORDERED — newest first; the agent reads the last N episodes, not a
//                  semantic neighborhood.
//   CHEAP        — a single D1 SELECT (no Vectorize, no AI). A DB hiccup degrades
//                  to an empty episode list; the cycle continues unaffected.
//   APPEND-ONLY  — no UNIQUE dedup; the dedup gate already prevents redundant
//                  runs; episode rows are the log of what actually happened.
//
// RECORD POLICY:
//   RECORD:   'spawned'      — at least one task was created (always signal)
//             'backpressure' — queue-full state (real operational signal)
//             'escalated'    — observer.escalate fired (operator notified)
//   SKIP:     'observe-only' — effort=low no-op (noise)
//             'deduped'      — idempotent rest (not a new event)
//             'rate_limited' / 'budget_exhausted' — economic gates, not trajectory
//
// FINGERPRINT / DEDUP RELATIONSHIP (intentional — read carefully):
//   The episodic block is INJECTED INTO THE GOAL PROMPT, so it influences what the
//   model PROPOSES. But the dedup fingerprint (computeDecisionFp) keys on
//   (sensorium state + the resulting PROPOSALS + version constants) — NOT on the
//   raw episode text. Deliberate:
//     - Episode content is CONTEXT, not decision IDENTITY. The decision is the
//       proposal set; if episodes shift the model's proposals, the fp shifts via
//       the proposals (→ not deduped). If proposals are identical, re-acting would
//       duplicate work → dedup SHOULD fire (rest). Correct either way.
//     - Hashing the ever-changing recent-episode TEXT into the fp would make it
//       churn every tick → dedup never fires → defeats S2's anti-spam purpose.
//   EPISODIC_VERSION (a constant) is in the preimage ONLY so an episodic
//   logic/format change can invalidate stale dedup on demand — same role as
//   SENSORIUM_VERSION. It is NOT the episode content. See dedup.ts.

import type { Env, Agent } from '../types'

// ── Version (fingerprint preimage component) ──────────────────────────────────
//
// A CONSTANT included in computeDecisionFp's preimage (dedup.ts) alongside
// SENSORIUM_VERSION. It is NOT the episode content — only a version token. Bump it
// to invalidate stale dedup rows when the episodic logic/format changes.
export const EPISODIC_VERSION = 'v1' as const

// ── Caps ──────────────────────────────────────────────────────────────────────

/** Maximum characters for an episode summary (enforced before INSERT). */
export const EPISODE_SUMMARY_MAX = 300

/** Default number of recent episodes returned by recentEpisodes(). */
export const EPISODE_DEFAULT_LIMIT = 5

/** Maximum number of recent episodes the caller may request. */
export const EPISODE_LIMIT_MAX = 20

// ── Types ─────────────────────────────────────────────────────────────────────

/** The episode kinds we record (excludes noise: observe-only / deduped / rate_limited). */
export type EpisodeKind = 'spawned' | 'backpressure' | 'escalated'

export interface EpisodeInput {
  /** Cycle counter from AgentDO runtime at time of recording. */
  cycle?: number | null
  /** Episode kind — caller determines from GoalCycleDecided. */
  kind: EpisodeKind
  /** Human-readable outcome description, bounded to EPISODE_SUMMARY_MAX. */
  summary: string
  /** SHA-256 hex decision fingerprint from dedup.ts, if available. */
  decisionFp?: string | null
  /** kpi_progress at time of recording, if available. */
  kpiProgress?: number | null
}

export interface Episode {
  id: string
  tenant: string
  agent_id: string
  cycle: number | null
  ts: string
  kind: string
  summary: string
  decision_fp: string | null
  kpi_progress: number | null
  created_at: string
}

// ── recordEpisode ─────────────────────────────────────────────────────────────

/**
 * recordEpisode — append a single episode row to the agent's timeline.
 *
 * Best-effort: callers wrap in try/catch (or use safeRecordEpisode below).
 * A failed write degrades silently; the cycle MUST NOT abort on episode write failure.
 *
 * Tenant isolation: tenant = env.TENANT_SLUG on every row.
 * Summary is bounded to EPISODE_SUMMARY_MAX before INSERT.
 */
export async function recordEpisode(
  env: Env,
  agent: Agent,
  ep: EpisodeInput,
  now?: string,
): Promise<void> {
  const id = crypto.randomUUID()
  const ts = now ?? new Date().toISOString()
  const summary = ep.summary.slice(0, EPISODE_SUMMARY_MAX)

  await env.DB.prepare(
    `INSERT INTO agent_episodes
       (id, tenant, agent_id, cycle, ts, kind, summary, decision_fp, kpi_progress)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      env.TENANT_SLUG,
      agent.id,
      ep.cycle ?? null,
      ts,
      ep.kind,
      summary,
      ep.decisionFp ?? null,
      ep.kpiProgress ?? null,
    )
    .run()
}

// ── recentEpisodes ────────────────────────────────────────────────────────────

/**
 * recentEpisodes — return the most recent episodes for (tenant, agent_id).
 *
 * Ordering: ts DESC, id DESC — stable tiebreak for equal-timestamp rows.
 * Bounded: limit is clamped to [1, EPISODE_LIMIT_MAX].
 * Tenant-isolated: WHERE clause always includes tenant = env.TENANT_SLUG.
 *
 * Best-effort: returns [] on any DB error so a hiccup degrades gracefully.
 */
export async function recentEpisodes(
  env: Env,
  agent: Agent,
  limit: number = EPISODE_DEFAULT_LIMIT,
): Promise<Episode[]> {
  const safeLimit = Math.min(Math.max(1, limit), EPISODE_LIMIT_MAX)
  const rows = await env.DB.prepare(
    `SELECT id, tenant, agent_id, cycle, ts, kind, summary, decision_fp, kpi_progress, created_at
       FROM agent_episodes
      WHERE tenant = ? AND agent_id = ?
      ORDER BY ts DESC, id DESC
      LIMIT ?`,
  )
    .bind(env.TENANT_SLUG, agent.id, safeLimit)
    .all<Episode>()

  return rows.results ?? []
}

// ── renderEpisodes ────────────────────────────────────────────────────────────

/**
 * renderEpisodes — compact, stable, deterministic prompt block.
 *
 * Format: one line per episode, newest first:
 *   [EPISODES v1]
 *   - [cycle N spawned] <summary>
 *   - [cycle N backpressure] <summary>
 *   ...
 *
 * This block is injected into the goal prompt AFTER the sensorium block.
 * The model reads it as "recent trajectory" — what happened in the last N cycles.
 *
 * Empty list → empty string (no block injected, no noise).
 *
 * NOTE ON DEDUP: this block is prompt CONTEXT, not dedup identity. The fp keys on
 * state + proposals (+ version constants); episodes shape proposals, and the fp
 * follows the proposals. Only the EPISODIC_VERSION constant is in the preimage (to
 * invalidate on a logic change) — never the episode text (that would churn the fp
 * every tick and defeat dedup). See dedup.ts.
 */
export function renderEpisodes(eps: Episode[]): string {
  if (eps.length === 0) return ''

  const lines: string[] = [`[EPISODES ${EPISODIC_VERSION}]`]
  for (const ep of eps) {
    const cycleLabel = ep.cycle !== null ? `cycle ${ep.cycle}` : 'cycle ?'
    // Episode summaries are DATA (not instructions). Strip control chars + bound length
    // so a malicious summary cannot forge prompt lines.
    const safeSum = sanitizeData(ep.summary)
    lines.push(`- [${cycleLabel} ${ep.kind}] ${safeSum}`)
  }
  return lines.join('\n')
}

// ── safeRecordEpisode (best-effort wrapper) ───────────────────────────────────

/**
 * safeRecordEpisode — best-effort wrapper for recordEpisode.
 * Swallows any error; the goal cycle must never abort because of an episode write.
 */
export async function safeRecordEpisode(
  env: Env,
  agent: Agent,
  ep: EpisodeInput,
  now?: string,
): Promise<void> {
  try {
    await recordEpisode(env, agent, ep, now)
  } catch {
    // best-effort — a D1 hiccup must not abort the goal cycle
  }
}

/**
 * safeRecentEpisodes — best-effort wrapper for recentEpisodes.
 * Returns [] on any error so a DB hiccup degrades to "no episodes" gracefully.
 */
export async function safeRecentEpisodes(
  env: Env,
  agent: Agent,
  limit?: number,
): Promise<Episode[]> {
  try {
    return await recentEpisodes(env, agent, limit)
  } catch {
    return []
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Sanitize a string for safe DATA injection into a prompt.
 * Strips C0 control chars (including \n, \r, \t) so a summary cannot forge
 * prompt lines. Bounds length. Does NOT wrap in quotes (caller context determines).
 */
function sanitizeData(s: string): string {
  // Strip C0 control chars (\r \n \t and friends) so a summary cannot forge
  // prompt lines; bound length. (Do NOT wrap — caller context determines.)
  // eslint-disable-next-line no-control-regex
  const noControl = s.replace(/[\u0000-\u001F\u007F]+/g, ' ')
  return noControl.trim().slice(0, EPISODE_SUMMARY_MAX)
}
