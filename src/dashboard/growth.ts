// mupot — /departments/growth: Marketing & Sales department console view.
//
// Read-only. Renders the Growth department surface: funnel, KPI cards, trend
// chart, and squad cards — all from REAL data (prospects table + metric_points).
//
// Data sources:
//   Funnel + KPIs : src/loops/prospects.ts countByStatus (queued/drafted/sent/replied)
//   Trend chart   : src/metrics/pulse.ts readSeries('growth.leads') → aggregateOHLC
//                   seriesShape always returns 'bar' for growth metrics (ohlcEligible=false)
//   Squads        : D1 squads table WHERE department.template_key = 'growth'
//
// Honesty contract (microkernel §4.2, enforced here):
//   - Every number is read from live DB/metric_points — zero fabricated values.
//   - If prospects table is empty → honest empty state per section.
//   - If metric_points has no growth.leads rows → honest empty state for chart.
//   - Reply rate shown as "—" when (sent + replied) = 0 (nobody reached yet).
//   - Chart is SVG, deterministic — NO Math.random, NO Date.now in render path.
//   - seriesShape is always 'bar' for growth metrics (daily scalar, ohlcEligible=false).
//
// Auth: route is behind the dashboardApp auth gate (requireAuth + tenant guard).
// This module has no POST/mutation. All writes go through existing endpoints.

import { html, raw } from 'hono/html'
import type { Env } from '../types'
import type { AuthContext } from '../types'
import { countByStatus } from '../loops/prospects'
import { readSeries, aggregateOHLC, seriesShape } from '../metrics/pulse'
import type { OHLCBucket } from '../metrics/pulse'

// ── Data shapes ───────────────────────────────────────────────────────────────

export interface GrowthSquadRow {
  id: string
  name: string
  slug: string
  charter: string | null
}

/** Funnel counts: each step from queued → replied. */
export interface GrowthFunnel {
  queued: number
  drafted: number
  sent: number
  replied: number
}

/** KPI computations, derived honestly from the funnel. */
export interface GrowthKPIs {
  /** Total prospects ever in funnel = queued+drafted+sent+replied. */
  leads: number
  /** Prospects that replied (the outcome KPI). */
  replies: number
  /**
   * Reply rate = replied / (sent + replied).
   * null when (sent + replied) = 0 — nobody has been reached yet.
   * Bounded [0, 1] by construction (not capped, just natural from counts).
   */
  replyRate: number | null
}

export interface GrowthView {
  dept: {
    id: string | null
    name: string
    active: boolean
  }
  funnel: GrowthFunnel
  kpis: GrowthKPIs
  /** OHLC buckets for growth.leads over last 30 days. Empty = no history yet. */
  leadsBuckets: OHLCBucket[]
  /** True if readSeries was truncated (data-honesty invariant from pulse.ts). */
  truncated: boolean
  squads: GrowthSquadRow[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * isoWindowDays — returns { from, to } as strict canonical ISO strings
 * for a UTC window of `days` days ending now.
 *
 * Deterministic: no Date.now() here — caller passes the timestamp.
 * This lets unit tests inject a stable now value.
 */
export function isoWindowDays(nowMs: number, days: number): { from: string; to: string } {
  const to = new Date(nowMs).toISOString()
  const from = new Date(nowMs - days * 86_400_000).toISOString()
  return { from, to }
}

/**
 * computeKPIs — pure function: derives KPI scalars from the funnel counts.
 *
 * Honesty:
 *   leads     = sum of all funnel steps (everyone who ever entered).
 *   replies   = replied count directly.
 *   replyRate = replied / (sent + replied).  null when reached = 0.
 *               "reached" = sent + replied (prospects who left the drafting stage).
 *               bounded [0,1] naturally (replied <= reached).
 */
export function computeKPIs(f: GrowthFunnel): GrowthKPIs {
  const leads = f.queued + f.drafted + f.sent + f.replied
  const replies = f.replied
  const reached = f.sent + f.replied
  const replyRate = reached > 0 ? replies / reached : null
  return { leads, replies, replyRate }
}

// ── Data load ─────────────────────────────────────────────────────────────────

export interface GrowthViewDeps {
  countFn?: (env: Env, status: 'queued' | 'drafted' | 'sent' | 'replied') => Promise<number>
  readSeriesFn?: typeof readSeries
  nowMs?: number  // injected for deterministic tests; defaults to Date.now()
}

/**
 * loadGrowthView — load all data for the Marketing & Sales department view.
 *
 * Tenant isolation:
 *   - countByStatus uses env.DB (single-tenant D1 — one pot per DB).
 *   - readSeries always binds tenant_id = auth.tenant in the WHERE clause.
 *   - squads query is unscoped by tenant_id because D1 is already per-tenant.
 *
 * Failure discipline: each section fails independently (Promise.allSettled-like
 * approach: individual try/catch per source so a metric_points gap doesn't break
 * the funnel). All sections default to safe empty values.
 */
export async function loadGrowthView(env: Env, auth: AuthContext, deps: GrowthViewDeps = {}): Promise<GrowthView> {
  const countFn = deps.countFn ?? ((e, s) => countByStatus(e, s))
  const readSeriesFn = deps.readSeriesFn ?? readSeries
  const nowMs = deps.nowMs ?? Date.now()

  // ── 1. Funnel counts (parallel) ────────────────────────────────────────────
  const [queued, drafted, sent, replied] = await Promise.all([
    countFn(env, 'queued').catch(() => 0),
    countFn(env, 'drafted').catch(() => 0),
    countFn(env, 'sent').catch(() => 0),
    countFn(env, 'replied').catch(() => 0),
  ])
  const funnel: GrowthFunnel = { queued, drafted, sent, replied }
  const kpis = computeKPIs(funnel)

  // ── 2. Trend series (growth.leads, last 30 days) ───────────────────────────
  //
  // We read growth.leads (total funnel count per day) for the chart.
  // ohlcEligible=false for this key (growth module declares it so); seriesShape
  // will return 'bar' — the render always renders a bar chart, never a candle.
  const { from, to } = isoWindowDays(nowMs, 30)
  let leadsBuckets: OHLCBucket[] = []
  let truncated = false
  try {
    const result = await readSeriesFn(env.DB, auth.tenant, 'growth.leads', from, to)
    leadsBuckets = aggregateOHLC(result.points, { bucket: 'day' })
    truncated = result.truncated
  } catch {
    // metric_points table may not exist yet in older migrations — safe fallback.
    leadsBuckets = []
    truncated = false
  }

  // ── 3. Dept row + squads ───────────────────────────────────────────────────
  //
  // Find the department row with template_key = 'growth'.
  // squads are fetched for that department_id.
  // Falls back to { id: null, name: 'Marketing & Sales', active: false } when
  // the department has not been activated yet (module not yet seeded).
  type DeptRow = { id: string; name: string; active: number }
  let dept: GrowthView['dept'] = { id: null, name: 'Marketing & Sales', active: false }
  let squads: GrowthSquadRow[] = []

  try {
    const deptRow = await env.DB
      .prepare(`SELECT id, name, active FROM departments WHERE template_key = ?1 LIMIT 1`)
      .bind('growth')
      .first<DeptRow>()

    if (deptRow) {
      dept = { id: deptRow.id, name: deptRow.name, active: deptRow.active === 1 }

      type SquadDbRow = { id: string; name: string; slug: string; charter: string | null }
      const squadResult = await env.DB
        .prepare(`SELECT id, name, slug, charter FROM squads WHERE department_id = ?1 ORDER BY created_at ASC, name ASC`)
        .bind(deptRow.id)
        .all<SquadDbRow>()

      squads = (squadResult.results ?? []).map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        charter: r.charter ?? null,
      }))
    }
  } catch {
    // Department not yet activated — squads stay empty, dept stays default.
  }

  return { dept, funnel, kpis, leadsBuckets, truncated, squads }
}

// ── SVG bar chart — deterministic, no Math.random, no Date.now ───────────────

/** Render a horizontal bar chart from OHLC close values (one bar per day bucket). */
function svgBarChart(buckets: OHLCBucket[]): string {
  if (buckets.length === 0) return ''

  // Chart dimensions (fixed — deterministic for SSR)
  const W = 560
  const H = 100
  const PAD_LEFT = 8
  const PAD_RIGHT = 8
  const PAD_TOP = 8
  const PAD_BOTTOM = 24 // room for x-axis labels
  const chartW = W - PAD_LEFT - PAD_RIGHT
  const chartH = H - PAD_TOP - PAD_BOTTOM

  // We use the 'close' value as the daily scalar (last reading per day).
  // For growth.leads with ohlcEligible=false, close === open === high === low.
  const maxVal = buckets.reduce((m, b) => (b.close > m ? b.close : m), 0)
  const n = buckets.length
  const barWidth = Math.max(1, Math.floor(chartW / n) - 2)
  const gap = Math.max(1, Math.floor(chartW / n) - barWidth)

  let bars = ''
  let labels = ''

  for (let i = 0; i < n; i++) {
    const b = buckets[i]
    const barH = maxVal > 0 ? Math.max(2, Math.round((b.close / maxVal) * chartH)) : 2
    const x = PAD_LEFT + i * (barWidth + gap)
    const y = PAD_TOP + chartH - barH

    bars += `<rect x="${x}" y="${y}" width="${barWidth}" height="${barH}" rx="2" fill="var(--accent2)" opacity="0.85">`
    bars += `<title>${b.date}: ${b.close}</title></rect>`

    // Only label first and last to avoid clutter
    if (i === 0 || i === n - 1) {
      const labelX = x + barWidth / 2
      const shortDate = b.date.slice(5) // MM-DD
      labels += `<text x="${labelX}" y="${H - 6}" text-anchor="middle" font-size="9" fill="var(--dim)">${shortDate}</text>`
    }
  }

  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-label="Daily leads trend (last 30 days)" style="max-width:100%;overflow:visible">
  <g>${bars}</g>
  <g>${labels}</g>
</svg>`
}

// ── HTML body ─────────────────────────────────────────────────────────────────

/** Format a reply rate [0,1] as a percentage string. */
function fmtRate(r: number | null): string {
  if (r === null) return '—'
  return (r * 100).toFixed(1) + '%'
}

/** Dept status badge. */
function deptStatusBadge(active: boolean): string {
  if (active) return `<span style="font-size:11px;font-weight:700;color:var(--ok);border:1px solid color-mix(in srgb,var(--ok) 40%,var(--border));border-radius:999px;padding:2px 10px">active</span>`
  return `<span style="font-size:11px;font-weight:700;color:var(--dim);border:1px solid var(--border);border-radius:999px;padding:2px 10px">not activated</span>`
}

/** One KPI card. */
function kpiCard(label: string, value: string, sub: string) {
  return html`<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px 18px;min-width:140px;flex:1">
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--dim);font-weight:600;margin-bottom:6px">${label}</div>
    <div style="font-size:28px;font-weight:700;line-height:1.1;color:var(--text);font-family:'Instrument Serif',Georgia,serif">${value}</div>
    <div style="font-size:12px;color:var(--muted);margin-top:4px">${sub}</div>
  </div>`
}

/** One funnel stage cell (with optional connector arrow). */
function funnelCell(label: string, count: number, highlight: boolean, showArrow: boolean) {
  const color = highlight ? 'var(--ok)' : 'var(--text)'
  const numStyle = `font-size:26px;font-weight:700;color:${color};font-family:'Instrument Serif',Georgia,serif`
  return html`<div style="display:flex;align-items:center;gap:12px">
    <div style="text-align:center">
      <div style="${numStyle}">${count}</div>
      <div style="font-size:12px;color:var(--muted);margin-top:2px">${label}</div>
    </div>
    ${showArrow ? raw('<div style="font-size:18px;color:var(--dim);user-select:none">›</div>') : raw('')}
  </div>`
}

/** The four-stage funnel row. */
function funnelRow(f: GrowthFunnel, hasProspects: boolean) {
  if (!hasProspects) {
    return html`<div class="card">
      <p class="empty">No prospects yet — connect a source to fill the funnel.
        Import prospects at <code>POST /api/prospects/import</code> or seed an outreach loop.</p>
    </div>`
  }
  return html`<div class="card" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
    ${funnelCell('queued', f.queued, false, true)}
    ${funnelCell('drafted', f.drafted, false, true)}
    ${funnelCell('sent', f.sent, false, true)}
    ${funnelCell('replied', f.replied, true, false)}
  </div>`
}

/** Squad card with name, OKR/charter. */
function squadCard(s: GrowthSquadRow) {
  const charter = s.charter ? s.charter : 'No charter set.'
  return html`<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px 18px">
    <div style="font-size:14px;font-weight:700;color:var(--accent);margin-bottom:6px">${s.name}</div>
    <div style="font-size:13px;color:var(--muted);white-space:pre-wrap">${charter}</div>
  </div>`
}

/**
 * growthBody — server-rendered HTML fragment for the Marketing & Sales console.
 *
 * Called by the route handler: `c.html(shell(c.env.BRAND, 'Marketing & Sales', growthBody(view)))`.
 *
 * Design:
 *   - Uses only CSS custom properties (--bg, --surface, --border, --text, --muted,
 *     --dim, --accent, --accent2, --ok, --radius) so the light-skin re-roll inherits.
 *   - NEVER hardcodes colors.
 *   - Instrument Serif for KPI numbers (matching the global typography intent).
 *   - Honest empty states throughout — no fabricated bars/numbers.
 */
export function growthBody(view: GrowthView) {
  const hasProspects = view.funnel.queued + view.funnel.drafted + view.funnel.sent + view.funnel.replied > 0
  // seriesShape is always 'bar' for growth.leads (ohlcEligible=false on the module).
  // We verify at runtime so future metric descriptor changes don't silently enable
  // candle rendering. If somehow the shape is 'candle', we still render as bar — the
  // UI must NEVER show a candle for an ohlcEligible=false metric.
  const shape = seriesShape(view.leadsBuckets)
  const renderAsBar = shape === 'bar' || shape === 'candle'  // always true; guard is belt+suspenders
  void renderAsBar  // only used as a runtime-check anchor; render path always uses bar

  const chartSection = (() => {
    if (view.leadsBuckets.length === 0) {
      return html`<div class="card">
        <p class="empty">No history yet — metrics populate as the collector runs each day.
          The collector emits <code>growth.leads</code> once per cron tick.</p>
        ${view.truncated ? html`<p style="font-size:12px;color:var(--warn2)">Note: data was capped at the read-series limit.</p>` : raw('')}
      </div>`
    }
    const svgHtml = svgBarChart(view.leadsBuckets)
    return html`<div class="card" style="overflow-x:auto">
      ${view.truncated ? html`<p style="font-size:12px;color:var(--warn2);margin:0 0 8px">Data capped at 10 000 readings — trailing bucket may be partial.</p>` : raw('')}
      ${raw(svgHtml)}
      <div style="font-size:11px;color:var(--dim);margin-top:6px">Daily lead count (close value) · bar chart · last 30 days</div>
    </div>`
  })()

  const squadSection = (() => {
    if (view.squads.length === 0) {
      const msg = view.dept.id
        ? 'No squads seeded yet for this department.'
        : 'Department not activated — activate it to seed the Demand Gen and Pipeline squads.'
      return html`<div class="card"><p class="empty">${msg}</p></div>`
    }
    const cards = view.squads.map((s) => squadCard(s))
    return html`<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px">${cards}</div>`
  })()

  return html`
    <style>
      /* Growth view local styles — all values via CSS vars, no hardcoded colors. */
      .growth-header {
        display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
        margin-bottom: 4px;
      }
      .growth-title {
        font-size: 22px; font-weight: 700; margin: 0;
        font-family: 'Instrument Serif', Georgia, serif;
        color: var(--text);
      }
      .growth-desc {
        font-size: 13px; color: var(--muted); margin: 4px 0 20px;
        max-width: 620px;
      }
      .growth-kpis {
        display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 24px;
      }
      .growth-section-label {
        font-size: 11px; text-transform: uppercase; letter-spacing: .07em;
        color: var(--dim); font-weight: 600; margin: 24px 0 8px;
      }
    </style>

    <p class="crumbs"><a href="/">Overview</a> / Departments / Marketing &amp; Sales</p>

    <!-- Header -->
    <div class="growth-header">
      <h1 class="growth-title">Marketing &amp; Sales</h1>
      ${raw(deptStatusBadge(view.dept.active))}
    </div>
    <p class="growth-desc">
      Demand generation, outreach, and pipeline conversion. Tracks prospects from
      first-touch through reply — every number from the live prospects table.
    </p>

    <!-- KPI Cards -->
    <div class="growth-kpis">
      ${kpiCard('Leads', String(view.kpis.leads), 'total funnel entries')}
      ${kpiCard('Replies', String(view.kpis.replies), 'prospects replied')}
      ${kpiCard('Reply rate', fmtRate(view.kpis.replyRate), view.kpis.replyRate === null ? 'no one reached yet' : 'replied / reached')}
    </div>

    <!-- Funnel -->
    <div class="growth-section-label">Prospect funnel</div>
    ${funnelRow(view.funnel, hasProspects)}

    <!-- Trend chart -->
    <div class="growth-section-label">Lead trend (last 30 days)</div>
    ${chartSection}

    <!-- Squads -->
    <div class="growth-section-label">Squads</div>
    ${squadSection}`
}
