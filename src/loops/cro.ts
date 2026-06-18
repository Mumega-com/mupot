// mupot — the CRO config: the reason + KPI seams that make a Conversion-Rate
// Optimization loop DO work (S5). Like outreach.ts, these are passed to the runtime
// by the driver; the runtime/container stays generic, the CRO SPECIFICS live here.
//
// SHAPE: a CRO loop perceives first-party page/funnel performance (each ResourceItem
// is a page with conversion stats), proposes ONE gated content-improvement act per
// underperforming page (up to the effort budget), and measures progress as the
// conversion signal ÷ kpi.target. The proposed act is CONTENT-kind (tool
// 'cro_content_update') — NOT a CRM kind — so the loop gate (wireGatedAct) routes it
// to a REVIEW TASK in /approvals; nothing is published or sent. A human approves and
// applies (S5a); the S4 inkwell-content executor auto-applies on approval in the
// separable follow-on (S5b). Autonomy ends at the gate, by construction.
//
// DEDUP (mirrors outreach's claim-before-propose): a page that already has a pending
// CRO proposal is skipped, so a loop cannot re-propose the same page every tick.
// Within-tick dedup is structural (a Set built during this reason() call); cross-tick
// dedup is best-effort via the injected proposedSlugs seam (a failed read never blocks
// proposing, but also never silently spams — the within-tick guard always holds).

import type { Env, ModelPort, ModelMessage } from '../types'
import type { ProposedAct, RuntimeDeps } from './runtime'
import { createModel } from '../model'
import type { ResourceItem } from './resources'

// A page is an underperformer when its conversion rate is below this floor (fraction,
// e.g. 0.02 = 2%). Overridable per call; a conservative default so the loop targets
// genuinely weak pages, not the whole site.
export const DEFAULT_CONVERSION_FLOOR = 0.02

export interface CroReasonDeps {
  model?: ModelPort
  /** Underperformer floor (conversion fraction). Default DEFAULT_CONVERSION_FLOOR. */
  conversionFloor?: number
  /**
   * Slugs that already have a pending CRO proposal for this loop (cross-tick dedup).
   * Best-effort: a thrown/failed read is treated as "none pending" (the within-tick
   * Set still prevents same-tick duplicates). Default reads open loop-gate tasks.
   */
  proposedSlugs?: (env: Env, loopId: string) => Promise<Set<string>>
}

/**
 * makeCroReason — a runtime `reason` seam. For each perceived page below the conversion
 * floor (worst first, up to the effort budget), drafts a concrete improvement
 * recommendation and proposes a GATED content-update act. Pages without a usable slug or
 * already pending are skipped. Items that carry no conversion signal are ignored, so this
 * is inert (proposes nothing) on a non-CRO source.
 */
export function makeCroReason(deps: CroReasonDeps = {}): NonNullable<RuntimeDeps['reason']> {
  const floor = typeof deps.conversionFloor === 'number' && deps.conversionFloor >= 0
    ? deps.conversionFloor
    : DEFAULT_CONVERSION_FLOOR
  const readPending = deps.proposedSlugs ?? defaultProposedSlugs

  return async (env, input) => {
    const model = deps.model ?? createModel(env)

    // Cross-tick dedup set (best-effort — never let a read failure block the cycle).
    let pending: Set<string>
    try {
      pending = await readPending(env, input.loop.id)
    } catch {
      pending = new Set<string>()
    }

    // Rank underperformers worst-first so a tight effort budget spends on the weakest pages.
    const candidates = input.context
      .map(toPagePerf)
      .filter((p): p is PagePerf => p !== null && p.conversion < floor)
      .sort((a, b) => a.conversion - b.conversion)

    const seen = new Set<string>() // within-tick dedup (structural guarantee)
    const acts: ProposedAct[] = []

    for (const page of candidates) {
      if (acts.length >= input.budget) break
      if (seen.has(page.slug) || pending.has(page.slug)) continue
      seen.add(page.slug)

      const rec = await draftRecommendation(model, input.loop.okr, page)
      if (!rec) continue

      const pct = (page.conversion * 100).toFixed(1)
      acts.push({
        channel_index: -1, // internal proposal — NOT a channel send (content act, gated)
        tool: 'cro_content_update',
        args: {
          slug: page.slug,
          title: page.title,
          url: page.url,
          current_conversion_bps: Math.round(page.conversion * 10_000), // basis points, integer
          recommendation: rec,
          basis: 'low_conversion',
        },
        summary: `CRO: improve "${String(page.title).slice(0, 60)}" — conv ${pct}% < ${(floor * 100).toFixed(1)}%`,
      })
    }

    return acts
  }
}

// ── page-performance extraction ────────────────────────────────────────────────

interface PagePerf {
  slug: string
  title: string
  url: string
  conversion: number // fraction 0..1
}

/**
 * Coerce a perceived ResourceItem into a PagePerf, or null if it carries no usable
 * conversion signal. Accepts either an explicit `conversion_rate` (0..1) or a
 * `conversions`/`views` pair. A slug is required (from `slug` or derived from `url`).
 */
function toPagePerf(item: ResourceItem): PagePerf | null {
  const slug = deriveSlug(item)
  if (!slug) return null

  let conversion: number | null = null
  const rate = numField(item.conversion_rate)
  if (rate !== null) {
    conversion = rate
  } else {
    const conversions = numField(item.conversions)
    const views = numField(item.views)
    if (conversions !== null && views !== null && views > 0) {
      conversion = conversions / views
    }
  }
  if (conversion === null || !Number.isFinite(conversion) || conversion < 0) return null
  // Clamp a malformed >1 rate to 1 rather than discarding the page.
  if (conversion > 1) conversion = 1

  const title = typeof item.title === 'string' && item.title.trim() ? item.title.trim() : slug
  const url = typeof item.url === 'string' ? item.url : `/${slug}`
  return { slug, title, url, conversion }
}

function numField(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

/** A page slug from an explicit `slug` field or the last path segment of `url`. */
function deriveSlug(item: ResourceItem): string {
  if (typeof item.slug === 'string') {
    const s = normalizeSlug(item.slug)
    if (s) return s
  }
  if (typeof item.url === 'string') {
    try {
      const path = item.url.startsWith('http') ? new URL(item.url).pathname : item.url
      const last = path.split('/').filter(Boolean).pop() ?? ''
      const s = normalizeSlug(last)
      if (s) return s
    } catch {
      // fall through
    }
  }
  if (typeof item.id === 'string') return normalizeSlug(item.id)
  return ''
}

function normalizeSlug(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
}

// ── recommendation drafting (model seam, fail-soft) ────────────────────────────

async function draftRecommendation(model: ModelPort, goal: string, page: PagePerf): Promise<string | null> {
  const messages: ModelMessage[] = [
    {
      role: 'system',
      content:
        'You are a conversion-rate-optimization analyst. Given a page and its current ' +
        'conversion rate, propose ONE specific, testable improvement (headline, CTA, proof, ' +
        'or structure). Respond ONLY with compact JSON {"recommendation": string} — one or two ' +
        'sentences, concrete, no hype, no fabricated metrics.',
    },
    {
      role: 'user',
      content:
        `Goal: ${goal}\n` +
        `Page: ${JSON.stringify({ title: page.title, url: page.url, conversion_pct: (page.conversion * 100).toFixed(2) })}\n` +
        'Propose the single highest-leverage change as JSON only.',
    },
  ]

  let raw: string
  try {
    raw = await model.chat(messages, {})
  } catch {
    return null
  }
  const s = raw.indexOf('{')
  const e = raw.lastIndexOf('}')
  if (s < 0 || e <= s) return null
  try {
    const o = JSON.parse(raw.slice(s, e + 1)) as { recommendation?: unknown }
    if (typeof o.recommendation !== 'string' || o.recommendation.trim() === '') return null
    return o.recommendation.slice(0, 600)
  } catch {
    return null
  }
}

/**
 * Default cross-tick dedup: the set of slugs that already have an open/review CRO task
 * for this loop. Best-effort — reads the tasks raised by wireGatedAct (body carries the
 * loop_id + the act args including slug). A query failure throws, and the caller treats a
 * throw as "none pending" (within-tick dedup still holds).
 */
async function defaultProposedSlugs(env: Env, loopId: string): Promise<Set<string>> {
  const rows = await env.DB.prepare(
    `SELECT body FROM tasks
       WHERE status IN ('open', 'review')
         AND gate_owner = 'gate:loops'
         AND body LIKE ?
       LIMIT 200`,
  )
    .bind(`%${loopId}%`)
    .all<{ body: string }>()

  const slugs = new Set<string>()
  for (const row of rows.results ?? []) {
    try {
      const parsed = JSON.parse(row.body) as { loop_id?: unknown; args?: { slug?: unknown } }
      if (parsed.loop_id !== loopId) continue // LIKE is a coarse prefilter; confirm exact loop
      const slug = parsed.args?.slug
      if (typeof slug === 'string' && slug) slugs.add(slug)
    } catch {
      // a non-JSON body is not a CRO task — skip
    }
  }
  return slugs
}

// ── KPI: conversion signal ÷ target ────────────────────────────────────────────

export interface CroKpiDeps {
  /**
   * Read the current first-party conversion signal in the SAME unit as kpi.target
   * (e.g. average conversion in basis points). Default returns 0 — the loop reports
   * honest "no signal yet" until a first-party source is bound (the data-layer
   * follow-on), rather than a fabricated number.
   */
  readSignal?: (env: Env, loopId: string) => Promise<number>
}

/**
 * makeCroObserveKpi — a runtime `observeKpi` seam. The OUTCOME signal is the conversion
 * rate (NOT activity): progress = signal ÷ kpi.target × 100, clamped 0..100. Returns 0
 * when no signal source is wired — honest, never invented.
 */
export function makeCroObserveKpi(deps: CroKpiDeps = {}): NonNullable<RuntimeDeps['observeKpi']> {
  const readSignal = deps.readSignal ?? (async () => 0)
  return async (env, loop) => {
    const target = loop.kpi.target > 0 ? loop.kpi.target : 1
    let signal = 0
    try {
      signal = await readSignal(env, loop.id)
    } catch {
      signal = 0 // a failed read is honest zero, never a fabricated KPI
    }
    if (!Number.isFinite(signal) || signal < 0) signal = 0
    return Math.max(0, Math.min(100, (signal / target) * 100))
  }
}
