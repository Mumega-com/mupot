// src/dashboard/ui.ts — console design-system primitives.
//
// PURE PRESENTATION (Codex acceptance condition 1, 2026-06-18):
//   - NO env / DB / fetch / auth imports. NO route construction. NO mutation.
//   - Accepts already-loaded values only.
//   - String inputs are auto-escaped by the `html` tagged template; callers pass
//     pre-escaped fragments only as HtmlEscapedString. We never wrap untrusted
//     strings in raw().
//
// These emit markup against the CSS classes/vars defined once in shell()'s <style>
// (see the "console-reskin primitives" block). Tokens stay in shell; ui.ts only
// consumes existing CSS custom properties — adding a primitive never adds a route
// or a query.

import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'

// `html` may return a Promise when an interpolation is async; hono renders both.
// Use this union for every primitive's return + composed-child params.
export type Html = HtmlEscapedString | Promise<HtmlEscapedString>

export type Tone = 'primary' | 'ok' | 'warn' | 'danger' | 'dim' | 'accent2'

// Map a semantic tone to an existing CSS var. Pure lookup, no side effects.
const TONE_VAR: Record<Tone, string> = {
  primary: 'var(--primary)',
  ok: 'var(--ok,#16a34a)',
  warn: 'var(--warn,#ca8a04)',
  danger: 'var(--danger,#c0392b)',
  dim: 'var(--dim)',
  accent2: 'var(--accent2,#0891b2)',
}

function toneVar(tone: Tone | undefined): string {
  return TONE_VAR[tone ?? 'primary'] ?? TONE_VAR.primary
}

// ── pageHeader ────────────────────────────────────────────────────────────────
// Crumbs + serif title + optional sub + optional pending badge. `crumbs` is plain
// text (escaped). `badge` is plain text (escaped).
export function pageHeader(opts: {
  crumbs?: string
  title: string
  sub?: string
  badge?: string
  badgeTone?: Tone
}): Html {
  return html`
    ${opts.crumbs ? html`<p class="crumbs">${opts.crumbs}</p>` : ''}
    <div class="ui-pagehead">
      <h1 class="ui-h1">${opts.title}</h1>
      ${opts.badge
        ? html`<span class="ui-pill" style="--pill:${raw(toneVar(opts.badgeTone))}">${opts.badge}</span>`
        : ''}
    </div>
    ${opts.sub ? html`<p class="ui-sub">${opts.sub}</p>` : ''}`
}

// ── statCard ──────────────────────────────────────────────────────────────────
// A KPI tile: label, large serif value, optional sub, optional fill bar (0..1).
export function statCard(opts: {
  label: string
  value: string
  sub?: string
  subTone?: Tone
  fill?: number // 0..1, renders a progress bar
  fillTone?: Tone
}): Html {
  const pct = opts.fill === undefined ? null : Math.max(0, Math.min(1, opts.fill)) * 100
  return html`
    <div class="ui-stat">
      <div class="ui-stat-label">${opts.label}</div>
      <div class="ui-stat-value">${opts.value}</div>
      ${pct !== null
        ? html`<div class="ui-stat-bar"><span style="width:${String(pct)}%;background:${raw(
            toneVar(opts.fillTone),
          )}"></span></div>`
        : ''}
      ${opts.sub
        ? html`<div class="ui-stat-sub" style="color:${raw(toneVar(opts.subTone ?? 'dim'))}">${opts.sub}</div>`
        : ''}
    </div>`
}

// ── kpiRow ────────────────────────────────────────────────────────────────────
// Responsive 4-up grid of pre-built cards (HtmlEscapedString — already escaped).
export function kpiRow(cards: Html[]): Html {
  return html`<div class="ui-kpis">${cards}</div>`
}

// ── sectionPanel ──────────────────────────────────────────────────────────────
// Titled panel. `body` is a pre-escaped fragment; `right` optional pre-escaped
// header-right fragment (e.g. tabs).
export function sectionPanel(opts: {
  title?: string
  right?: Html
  body: Html
}): Html {
  return html`
    <section class="ui-panel">
      ${opts.title || opts.right
        ? html`<div class="ui-panel-head">
            ${opts.title ? html`<h2 class="ui-panel-title">${opts.title}</h2>` : ''}
            ${opts.right ? html`<div class="ui-panel-right">${opts.right}</div>` : ''}
          </div>`
        : ''}
      <div class="ui-panel-body">${opts.body}</div>
    </section>`
}

// ── pill / statusDot ──────────────────────────────────────────────────────────
export function pill(text: string, tone: Tone = 'primary'): Html {
  return html`<span class="ui-pill" style="--pill:${raw(toneVar(tone))}">${text}</span>`
}

export function statusDot(tone: Tone, label?: string): Html {
  return html`<span class="ui-status"><span class="ui-status-dot" style="background:${raw(
    toneVar(tone),
  )}"></span>${label ? html`<span>${label}</span>` : ''}</span>`
}

// ── dataTable ─────────────────────────────────────────────────────────────────
// Mono-headed, hover-row table. `cols` define labels + optional grid widths.
// `rows` are arrays of pre-escaped cells (HtmlEscapedString). When empty, renders
// the honest empty line.
export function dataTable(opts: {
  cols: { label: string; width?: string }[]
  rows: Html[][]
  empty?: string
}): Html {
  const template = opts.cols.map((c) => c.width ?? '1fr').join(' ')
  const head = html`<div class="ui-tr ui-thead" style="grid-template-columns:${raw(template)}">
    ${opts.cols.map((c) => html`<div class="ui-th">${c.label}</div>`)}
  </div>`
  if (opts.rows.length === 0) {
    return html`<div class="ui-table">${head}<div class="ui-table-empty">${opts.empty ?? 'Nothing here yet.'}</div></div>`
  }
  const body = opts.rows.map(
    (cells) => html`<div class="ui-tr ui-row" style="grid-template-columns:${raw(template)}">
      ${cells.map((cell) => html`<div class="ui-td">${cell}</div>`)}
    </div>`,
  )
  return html`<div class="ui-table">${head}${body}</div>`
}

// ── emptyState ────────────────────────────────────────────────────────────────
// Honest "not connected / unavailable" state (Codex condition 6). NEVER fake KPIs.
export function emptyState(opts: {
  title: string
  detail: string
  hint?: string
}): Html {
  return html`
    <div class="ui-empty">
      <div class="ui-empty-mark">○</div>
      <div class="ui-empty-title">${opts.title}</div>
      <div class="ui-empty-detail">${opts.detail}</div>
      ${opts.hint ? html`<div class="ui-empty-hint">${opts.hint}</div>` : ''}
    </div>`
}

// ── notConnected ──────────────────────────────────────────────────────────────
// Shorthand for a greenfield surface that has no backing model yet. Visibly
// "not connected", per Codex condition 6 — no fabricated balances/listings/state.
export function notConnected(surface: string, detail: string): Html {
  return emptyState({
    title: `${surface} — not connected`,
    detail,
    hint: 'This surface is wired for structure only. No data is fabricated.',
  })
}
