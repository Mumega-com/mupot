// dashboard/flights-deck — Mission Control Flight Deck for GET /flights.
//
// Pure presentation over FlightCard[] (flight/board.ts). No D1, no env, no
// Date.now() on the render path — callers pass `nowMs` so tests stay deterministic.
// Artifact links are classified from flights.meta refs only; we never invent a
// PR, sandbox, or receipt URL that the flight did not declare.

import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import type { Project } from '../types'
import { humanDur, type FlightCard, type FlightPhase } from '../flight/board'
import { pageHeader, kpiRow } from './ui'

export const FLIGHT_DECK_POLL_MS = 12_000
export const FLIGHT_PIPELINE_STAGES = ['Plan', 'Sandbox', 'Tests', 'Gate', 'PR', 'Deploy'] as const
export type FlightPipelineStage = (typeof FLIGHT_PIPELINE_STAGES)[number]
export type FlightDeckFilter = 'all' | 'flying' | 'landed' | 'held' | 'failed'
export type FlightDeckBadge = 'flying' | 'landed' | 'held' | 'failed'

export interface FlightPersona {
  emoji: string
  label: string
}

export interface FlightArtifacts {
  prUrl: string | null
  sandboxUrl: string | null
  receiptUrl: string | null
  issueUrl: string | null
  repoUrl: string | null
  repoLabel: string | null
}

export interface FlightDeckKpis {
  total: number
  active: number
  landed: number
  failed: number
  withPr: number
  prLandingRate: number | null
  prLandingLabel: string
}

const PERSONAS: ReadonlyArray<{ match: RegExp; persona: FlightPersona }> = [
  { match: /\bloom\b/i, persona: { emoji: '🧶', label: 'Loom' } },
  { match: /\bkasra\b/i, persona: { emoji: '🔨', label: 'Kasra' } },
  { match: /\bathena\b/i, persona: { emoji: '🛡️', label: 'Athena' } },
  { match: /architect/i, persona: { emoji: '☁️', label: 'Cursor Architect' } },
  { match: /builder/i, persona: { emoji: '⚙️', label: 'Cursor Builder' } },
]

export function escHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function agentPersona(name: string): FlightPersona {
  const trimmed = name.trim()
  for (const row of PERSONAS) {
    if (row.match.test(trimmed)) return row.persona
  }
  return { emoji: '✈️', label: trimmed || 'Agent' }
}

export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return url.toString()
  } catch {
    return null
  }
}

function githubRepoFromUrl(url: string): { repoUrl: string; repoLabel: string } | null {
  try {
    const parsed = new URL(url)
    if (!/^(www\.)?github\.com$/i.test(parsed.hostname)) return null
    const parts = parsed.pathname.split('/').filter(Boolean)
    if (parts.length < 2) return null
    const owner = parts[0]
    const repo = parts[1]
    if (!owner || !repo) return null
    return {
      repoUrl: `https://github.com/${owner}/${repo}`,
      repoLabel: `${owner}/${repo}`,
    }
  } catch {
    return null
  }
}

function classifyRef(ref: string, into: FlightArtifacts): void {
  const url = safeHttpUrl(ref)
  if (!url) return
  const lower = url.toLowerCase()
  const github = githubRepoFromUrl(url)
  if (github && !into.repoUrl) {
    into.repoUrl = github.repoUrl
    into.repoLabel = github.repoLabel
  }
  if (/github\.com\/[^/]+\/[^/]+\/pull\/\d+/i.test(url)) {
    if (!into.prUrl) into.prUrl = url
    return
  }
  if (/github\.com\/[^/]+\/[^/]+\/issues\/\d+/i.test(url)) {
    if (!into.issueUrl) into.issueUrl = url
    return
  }
  if (
    /cursor\.com\/(agents|dashboard)/i.test(url) ||
    lower.includes('sandbox') ||
    lower.includes('cloud-agent')
  ) {
    if (!into.sandboxUrl) into.sandboxUrl = url
    return
  }
  if (lower.includes('receipt')) {
    if (!into.receiptUrl) into.receiptUrl = url
  }
}

export function extractFlightArtifacts(meta: string): FlightArtifacts {
  const empty: FlightArtifacts = {
    prUrl: null,
    sandboxUrl: null,
    receiptUrl: null,
    issueUrl: null,
    repoUrl: null,
    repoLabel: null,
  }
  if (!meta || !meta.trim()) return empty
  let parsed: unknown
  try {
    parsed = JSON.parse(meta)
  } catch {
    return empty
  }
  if (!parsed || typeof parsed !== 'object') return empty
  const rec = parsed as Record<string, unknown>
  const refs = [
    ...(Array.isArray(rec.artifact_refs) ? rec.artifact_refs : []),
    ...(Array.isArray(rec.receipt_refs) ? rec.receipt_refs : []),
  ]
  for (const ref of refs) {
    if (typeof ref === 'string') classifyRef(ref, empty)
  }
  return empty
}

export function flightFilterGroup(phase: FlightPhase): Exclude<FlightDeckFilter, 'all'> {
  if (phase === 'landed') return 'landed'
  if (phase === 'failed') return 'failed'
  if (phase === 'held' || phase === 'holding') return 'held'
  return 'flying'
}

export function flightBadgeKind(phase: FlightPhase): FlightDeckBadge {
  return flightFilterGroup(phase)
}

export function pipelineStageIndex(phase: FlightPhase, artifacts: FlightArtifacts): number {
  switch (phase) {
    case 'preflight':
      return 0
    case 'flying':
    case 'sleeping':
      return 1
    case 'holding':
    case 'held':
      return 3
    case 'landed':
      return artifacts.prUrl ? 4 : 3
    case 'failed':
      return artifacts.prUrl ? 4 : 2
    default:
      return 0
  }
}

export function formatFlightClock(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—'
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')
}

export function flightDuration(card: FlightCard, nowMs: number): string {
  const start = card.started_at ?? card.created_at
  const end = card.ended_at ?? (card.live ? nowMs : card.started_at ? nowMs : card.created_at)
  return humanDur(Math.max(0, end - start))
}

export function deriveFlightDeckKpis(cards: FlightCard[]): FlightDeckKpis {
  const total = cards.length
  const active = cards.filter((card) => card.live).length
  const landed = cards.filter((card) => card.phase === 'landed').length
  const failed = cards.filter((card) => card.phase === 'failed').length
  const withPr = cards.filter((card) => card.phase === 'landed' && extractFlightArtifacts(card.meta).prUrl).length
  const closed = landed + failed
  const prLandingRate = closed === 0 ? null : Math.round((100 * (withPr > 0 ? withPr : landed)) / closed)
  return {
    total,
    active,
    landed,
    failed,
    withPr,
    prLandingRate,
    prLandingLabel: prLandingRate === null ? '—' : `${prLandingRate}%`,
  }
}

export function knownRepoOptions(cards: FlightCard[]): Array<{ url: string; label: string }> {
  const seen = new Map<string, string>()
  for (const card of cards) {
    const artifacts = extractFlightArtifacts(card.meta)
    if (artifacts.repoUrl && artifacts.repoLabel && !seen.has(artifacts.repoUrl)) {
      seen.set(artifacts.repoUrl, artifacts.repoLabel)
    }
  }
  return [...seen.entries()].map(([url, label]) => ({ url, label }))
}

function shortFlightId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

function searchHaystack(card: FlightCard, persona: FlightPersona): string {
  return [card.goal, card.squad_name ?? '', card.agent_name, persona.label, card.agent, card.id].join(' ')
}

function renderPipeline(current: number): string {
  return `<ol class="fd-pipe" aria-label="Flight stage pipeline">${FLIGHT_PIPELINE_STAGES.map((stage, index) => {
    const state = index < current ? 'is-done' : index === current ? 'is-current' : ''
    const arrow = index < FLIGHT_PIPELINE_STAGES.length - 1 ? '<span class="fd-pipe-arrow" aria-hidden="true">➔</span>' : ''
    return `<li class="fd-pipe-step ${state}"><span class="fd-pipe-dot"></span><span class="fd-pipe-label">${escHtml(stage)}</span>${arrow}</li>`
  }).join('')}</ol>`
}

function renderArtifactButtons(artifacts: FlightArtifacts): string {
  const buttons: string[] = []
  if (artifacts.prUrl) {
    buttons.push(
      `<a class="fd-art fd-art-pr" href="${escHtml(artifacts.prUrl)}" target="_blank" rel="noopener noreferrer">🌐 View PR</a>`,
    )
  }
  if (artifacts.sandboxUrl) {
    buttons.push(
      `<a class="fd-art fd-art-sandbox" href="${escHtml(artifacts.sandboxUrl)}" target="_blank" rel="noopener noreferrer">☁️ Cloud Sandbox</a>`,
    )
  }
  if (artifacts.receiptUrl) {
    buttons.push(
      `<a class="fd-art fd-art-receipt" href="${escHtml(artifacts.receiptUrl)}" target="_blank" rel="noopener noreferrer">📄 Receipt</a>`,
    )
  }
  return buttons.length
    ? `<div class="fd-arts">${buttons.join('')}</div>`
    : `<span class="fd-arts-empty">No artifacts yet</span>`
}

function renderBadge(kind: FlightDeckBadge): string {
  const label =
    kind === 'flying' ? 'Flying' : kind === 'landed' ? 'Landed' : kind === 'held' ? 'Held' : 'Failed'
  return `<span class="fd-badge fd-badge-${kind}">${kind === 'flying' ? '<span class="fd-pulse" aria-hidden="true"></span>' : ''}${escHtml(label)}</span>`
}

function renderRow(card: FlightCard, nowMs: number): string {
  const artifacts = extractFlightArtifacts(card.meta)
  const persona = agentPersona(card.agent_name)
  const filter = flightFilterGroup(card.phase)
  const badge = flightBadgeKind(card.phase)
  const stage = pipelineStageIndex(card.phase, artifacts)
  const started = formatFlightClock(card.started_at ?? card.created_at)
  const finished = formatFlightClock(card.ended_at)
  const duration = flightDuration(card, nowMs)
  const issue = artifacts.issueUrl
    ? `<a class="fd-issue" href="${escHtml(artifacts.issueUrl)}" target="_blank" rel="noopener noreferrer">GitHub issue</a>`
    : ''
  const repo = artifacts.repoLabel
    ? `<span class="fd-repo">${escHtml(artifacts.repoLabel)}</span>`
    : `<span class="fd-repo fd-repo-empty">No target repo</span>`
  return `
    <tr class="fd-row${card.live ? ' is-live' : ''}" data-fd-row data-fd-filter="${filter}" data-fd-search="${escHtml(searchHaystack(card, persona))}">
      <td class="fd-cell-goal">
        <div class="fd-id" title="${escHtml(card.id)}">${escHtml(shortFlightId(card.id))}</div>
        <div class="fd-goal">${escHtml(card.goal)}</div>
        <div class="fd-goal-meta">${repo}${issue}</div>
      </td>
      <td class="fd-cell-crew">
        <div class="fd-agent"><span class="fd-avatar" aria-hidden="true">${escHtml(persona.emoji)}</span><span>${escHtml(persona.label)}</span></div>
        <div class="fd-squad">${card.squad_name ? escHtml(card.squad_name) : 'Unassigned squad'}</div>
      </td>
      <td class="fd-cell-pipe">${renderPipeline(stage)}</td>
      <td class="fd-cell-art">${renderArtifactButtons(artifacts)}</td>
      <td class="fd-cell-status">${renderBadge(badge)}</td>
      <td class="fd-cell-time">
        <div><span class="fd-time-label">Started</span> ${escHtml(started)}</div>
        <div><span class="fd-time-label">Duration</span> ${escHtml(duration)}</div>
        <div><span class="fd-time-label">Finished</span> ${escHtml(finished)}</div>
      </td>
    </tr>`
}

function filterCounts(cards: FlightCard[]): Record<FlightDeckFilter, number> {
  const counts: Record<FlightDeckFilter, number> = {
    all: cards.length,
    flying: 0,
    landed: 0,
    held: 0,
    failed: 0,
  }
  for (const card of cards) counts[flightFilterGroup(card.phase)] += 1
  return counts
}

const DECK_CSS = `
  .ui-pagehead-right { margin-left: auto; }
  .fd-deck { --fd-teal: #0f766e; --fd-amber: #ca8a04; --fd-red: #dc2626; }
  .fd-kpis .ui-stat-value { display: flex; align-items: center; gap: 10px; }
  .fd-radar {
    width: 14px; height: 14px; border-radius: 50%; background: var(--ok);
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--ok) 60%, transparent);
    animation: fd-radar 1.6s ease-out infinite; flex: none;
  }
  @keyframes fd-radar {
    0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--ok) 60%, transparent); }
    70% { box-shadow: 0 0 0 10px transparent; }
  }
  .fd-toolbar {
    display: flex; flex-wrap: wrap; gap: 12px; align-items: center;
    margin: 4px 0 14px;
  }
  .fd-search {
    flex: 1 1 240px; min-width: 200px; font: inherit; font-size: 13.5px;
    padding: 9px 12px; border-radius: 10px; border: 1px solid var(--border);
    background: var(--surface); color: var(--text);
  }
  .fd-tabs { display: flex; flex-wrap: wrap; gap: 6px; }
  .fd-tab {
    appearance: none; cursor: pointer; font: inherit; font-size: 12.5px; font-weight: 600;
    padding: 7px 11px; border-radius: 999px; border: 1px solid var(--border);
    background: var(--surface); color: var(--text2);
  }
  .fd-tab.is-active { background: var(--primary-soft); color: var(--primary); border-color: color-mix(in srgb, var(--primary) 35%, var(--border)); }
  .fd-tab-count { font-family: var(--font-mono); font-size: 11px; color: var(--dim); margin-left: 4px; }
  .fd-live-hint { font-size: 12px; color: var(--dim); margin-left: auto; }
  .fd-board { padding: 0; overflow-x: auto; }
  .fd-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .fd-table th {
    text-align: left; color: var(--muted); font-size: 11px; text-transform: uppercase;
    letter-spacing: .5px; padding: 10px 12px; border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  .fd-table td { padding: 14px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
  .fd-row:last-child td { border-bottom: none; }
  .fd-row.is-live { background: color-mix(in srgb, var(--ok) 5%, var(--surface)); }
  .fd-id { font-family: var(--font-mono); font-size: 11px; color: var(--dim); letter-spacing: .04em; }
  .fd-goal { font-weight: 600; margin: 3px 0; max-width: 360px; }
  .fd-goal-meta { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 12px; color: var(--dim); }
  .fd-repo { font-family: var(--font-mono); font-size: 11.5px; }
  .fd-issue { color: var(--primary); text-decoration: none; font-weight: 600; }
  .fd-issue:hover { text-decoration: underline; }
  .fd-agent { display: flex; align-items: center; gap: 8px; font-weight: 600; }
  .fd-avatar {
    width: 28px; height: 28px; border-radius: 9px; display: inline-flex; align-items: center;
    justify-content: center; background: var(--surface2); border: 1px solid var(--border);
  }
  .fd-squad { font-size: 12px; color: var(--dim); margin-top: 4px; }
  .fd-pipe { display: flex; flex-wrap: wrap; gap: 2px; list-style: none; margin: 0; padding: 0; align-items: center; }
  .fd-pipe-step { display: inline-flex; align-items: center; gap: 4px; color: var(--dim); font-size: 10.5px; font-weight: 600; letter-spacing: .02em; }
  .fd-pipe-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--bars); }
  .fd-pipe-step.is-done .fd-pipe-dot, .fd-pipe-step.is-current .fd-pipe-dot { background: var(--ok); }
  .fd-pipe-step.is-current { color: var(--text); }
  .fd-pipe-step.is-done { color: var(--text2); }
  .fd-pipe-arrow { color: var(--bars); font-size: 10px; margin: 0 2px; }
  .fd-arts { display: flex; flex-wrap: wrap; gap: 6px; }
  .fd-art {
    display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 600;
    padding: 5px 9px; border-radius: 8px; border: 1px solid var(--border); text-decoration: none;
    color: var(--text); background: var(--surface2);
  }
  .fd-art:hover { border-color: var(--primary); color: var(--primary); }
  .fd-arts-empty { color: var(--dim); font-size: 12px; }
  .fd-badge {
    display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700;
    letter-spacing: .04em; text-transform: uppercase; padding: 3px 8px; border-radius: 999px;
    border: 1px solid var(--border);
  }
  .fd-badge-flying { color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); border-color: color-mix(in srgb, var(--ok) 35%, var(--border)); }
  .fd-badge-landed { color: var(--fd-teal); background: color-mix(in srgb, var(--fd-teal) 12%, transparent); border-color: color-mix(in srgb, var(--fd-teal) 35%, var(--border)); }
  .fd-badge-held { color: var(--fd-amber); background: color-mix(in srgb, var(--fd-amber) 12%, transparent); border-color: color-mix(in srgb, var(--fd-amber) 35%, var(--border)); }
  .fd-badge-failed { color: var(--fd-red); background: color-mix(in srgb, var(--fd-red) 12%, transparent); border-color: color-mix(in srgb, var(--fd-red) 35%, var(--border)); }
  .fd-pulse {
    width: 7px; height: 7px; border-radius: 50%; background: var(--ok);
    animation: fd-radar 1.6s ease-out infinite;
  }
  .fd-cell-time { font-variant-numeric: tabular-nums; font-size: 12px; color: var(--text2); white-space: nowrap; }
  .fd-time-label { color: var(--dim); font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; margin-right: 6px; }
  .fd-empty { padding: 28px 18px; }
  .fd-dispatch-backdrop {
    position: fixed; inset: 0; background: rgba(15, 23, 20, .35); z-index: 40;
    opacity: 0; pointer-events: none; transition: opacity .2s ease;
  }
  .fd-dispatch-backdrop.is-open { opacity: 1; pointer-events: auto; }
  .fd-dispatch {
    position: fixed; top: 0; right: 0; bottom: 0; width: min(420px, 100vw);
    background: var(--surface); border-left: 1px solid var(--border); z-index: 41;
    transform: translateX(100%); transition: transform .25s ease; display: flex; flex-direction: column;
    padding: 20px 22px;
  }
  .fd-dispatch.is-open { transform: translateX(0); }
  .fd-dispatch h2 { margin: 0 0 6px; font-size: 20px; font-family: var(--font-display); font-weight: 400; }
  .fd-dispatch p { margin: 0 0 16px; color: var(--dim); font-size: 13px; }
  .fd-dispatch label { display: grid; gap: 6px; font-size: 12.5px; color: var(--muted); margin-bottom: 12px; }
  .fd-dispatch input, .fd-dispatch textarea, .fd-dispatch select {
    font: inherit; font-size: 13.5px; padding: 8px 10px; border-radius: 8px;
    border: 1px solid var(--border); background: var(--bg); color: var(--text); width: 100%;
  }
  .fd-dispatch-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .fd-dispatch-status { min-height: 18px; font-size: 12.5px; color: var(--muted); margin-top: 10px; }
  @media (max-width: 900px) {
    .fd-cell-pipe, .fd-table th:nth-child(3) { display: none; }
  }
  @media (max-width: 680px) {
    .fd-cell-time, .fd-table th:nth-child(6) { display: none; }
    .fd-toolbar { flex-direction: column; align-items: stretch; }
    .fd-live-hint { margin-left: 0; }
  }
`

const DECK_SCRIPT = `
(function () {
  var root = document.getElementById('fd-deck');
  if (!root) return;
  var search = document.getElementById('fd-search');
  var filter = 'all';
  var pollMs = Number(root.getAttribute('data-fd-poll') || ${FLIGHT_DECK_POLL_MS});

  function applyFilters() {
    var query = ((search && search.value) || '').trim().toLowerCase();
    var rows = root.querySelectorAll('[data-fd-row]');
    var shown = 0;
    rows.forEach(function (row) {
      var hay = (row.getAttribute('data-fd-search') || '').toLowerCase();
      var group = row.getAttribute('data-fd-filter') || 'all';
      var matchFilter = filter === 'all' || group === filter;
      var matchSearch = !query || hay.indexOf(query) !== -1;
      var show = matchFilter && matchSearch;
      row.hidden = !show;
      if (show) shown += 1;
    });
    var empty = document.getElementById('fd-empty-filter');
    if (empty) empty.hidden = shown > 0 || rows.length === 0;
  }

  document.querySelectorAll('[data-fd-tab]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      filter = btn.getAttribute('data-fd-tab') || 'all';
      document.querySelectorAll('[data-fd-tab]').forEach(function (other) {
        var on = other === btn;
        other.classList.toggle('is-active', on);
        other.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      applyFilters();
    });
  });
  if (search) search.addEventListener('input', applyFilters);

  var backdrop = document.getElementById('fd-dispatch-backdrop');
  var panel = document.getElementById('fd-dispatch');
  var openBtn = document.getElementById('fd-dispatch-open');
  var closeBtn = document.getElementById('fd-dispatch-close');
  var cancelBtn = document.getElementById('fd-dispatch-cancel');
  var custom = document.getElementById('fd-repo-custom');
  var customWrap = document.getElementById('fd-repo-custom-wrap');
  var select = document.getElementById('fd-repo-select');

  function setDispatchOpen(open) {
    if (panel) {
      panel.classList.toggle('is-open', open);
      panel.setAttribute('aria-hidden', open ? 'false' : 'true');
    }
    if (backdrop) {
      backdrop.classList.toggle('is-open', open);
      backdrop.hidden = !open;
    }
    if (open) {
      var goal = document.getElementById('fd-dispatch-goal');
      if (goal) goal.focus();
    }
  }
  if (openBtn) openBtn.addEventListener('click', function () { setDispatchOpen(true); });
  if (closeBtn) closeBtn.addEventListener('click', function () { setDispatchOpen(false); });
  if (cancelBtn) cancelBtn.addEventListener('click', function () { setDispatchOpen(false); });
  if (backdrop) backdrop.addEventListener('click', function () { setDispatchOpen(false); });
  if (select && custom) {
    select.addEventListener('change', function () {
      var other = select.value === '__custom';
      custom.hidden = !other;
      if (customWrap) customWrap.hidden = !other;
      if (other) custom.focus();
    });
  }

  var form = document.getElementById('fd-dispatch-form');
  var status = document.getElementById('fd-dispatch-status');
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var goalEl = document.getElementById('fd-dispatch-goal');
      var prompt = (goalEl && goalEl.value || '').trim();
      if (!prompt) {
        if (status) status.textContent = 'Goal is required.';
        return;
      }
      var repo = '';
      if (select && select.value === '__custom') repo = (custom && custom.value || '').trim();
      else if (select && select.value) repo = select.value;
      if (status) status.textContent = 'Dispatching…';
      fetch('/api/studio/dispatch', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: prompt, repoUrl: repo || undefined, model: 'cursor-cloud' })
      }).then(function (res) {
        return res.json().then(function (data) { return { ok: res.ok, data: data }; });
      }).then(function (r) {
        if (r.ok) {
          if (status) status.textContent = 'Flight ' + ((r.data && r.data.flight_id) || '') + ' dispatched.';
          window.location.reload();
        } else {
          if (status) status.textContent = (r.data && r.data.error) || 'dispatch failed';
        }
      }).catch(function () {
        if (status) status.textContent = 'network error — try again';
      });
    });
  }

  function syncCounts(from) {
    if (!from) return;
    document.querySelectorAll('[data-fd-tab]').forEach(function (btn) {
      var key = btn.getAttribute('data-fd-tab');
      var next = from.getAttribute('data-fd-count-' + key);
      var count = btn.querySelector('.fd-tab-count');
      if (count && next != null) count.textContent = next;
    });
  }

  function poll() {
    if (document.hidden) return;
    if (root.getAttribute('data-fd-live') !== '1') return;
    fetch(location.pathname + location.search, { credentials: 'same-origin', headers: { 'Accept': 'text/html' } })
      .then(function (res) { return res.text(); })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var nextRoot = doc.getElementById('fd-deck');
        var nextKpis = doc.getElementById('fd-kpis');
        var nextBoard = doc.getElementById('fd-board');
        var kpis = document.getElementById('fd-kpis');
        var board = document.getElementById('fd-board');
        if (nextKpis && kpis) kpis.replaceWith(nextKpis);
        if (nextBoard && board) board.replaceWith(nextBoard);
        if (nextRoot) {
          root.setAttribute('data-fd-live', nextRoot.getAttribute('data-fd-live') || '0');
          syncCounts(nextRoot);
        }
        var hint = document.getElementById('fd-live-hint');
        if (hint) hint.textContent = 'Live board · refreshed';
        applyFilters();
      }).catch(function () {});
  }

  if (root.getAttribute('data-fd-live') === '1') {
    setInterval(poll, pollMs);
  }
})();
`

export function flightsBody(
  cards: FlightCard[],
  project?: Project,
  scanLimited = false,
  nowMs = Date.now(),
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const kpis = deriveFlightDeckKpis(cards)
  const counts = filterCounts(cards)
  const repos = knownRepoOptions(cards)
  const table = cards.length
    ? `<table class="fd-table">
        <thead>
          <tr>
            <th>Flight / Goal</th>
            <th>Squad &amp; Agent</th>
            <th>Stage</th>
            <th>Artifacts</th>
            <th>Status</th>
            <th>Timing</th>
          </tr>
        </thead>
        <tbody>${cards.map((card) => renderRow(card, nowMs)).join('')}</tbody>
      </table>
      <p class="empty fd-empty" id="fd-empty-filter" hidden>No flights match this search or status filter.</p>`
    : `<p class="empty fd-empty">No flights yet. Dispatch one to put a bounded agent run on the board — it appears here at preflight and carries its accounted cost on land.</p>`

  const repoOptions = [
    `<option value="">Select a target repo…</option>`,
    ...repos.map((repo) => `<option value="${escHtml(repo.url)}">${escHtml(repo.label)}</option>`),
    `<option value="__custom">Other URL…</option>`,
  ].join('')

  const activeValue = kpis.active > 0
    ? raw(`<span class="fd-radar" title="Active in-flight"></span>${String(kpis.active)}`)
    : String(kpis.active)

  return html`
    <div
      id="fd-deck"
      class="fd-deck"
      data-fd-live="${kpis.active > 0 ? '1' : '0'}"
      data-fd-poll="${String(FLIGHT_DECK_POLL_MS)}"
      data-fd-count-all="${String(counts.all)}"
      data-fd-count-flying="${String(counts.flying)}"
      data-fd-count-landed="${String(counts.landed)}"
      data-fd-count-held="${String(counts.held)}"
      data-fd-count-failed="${String(counts.failed)}"
    >
      ${pageHeader({
        crumbs: project ? `Projects / ${project.name} / Flights` : 'Overview / Flights',
        title: 'Flight Operations',
        sub: project
          ? `Mission Control board for ${project.name}. Live flights pulse; landed flights keep their PR, sandbox, and receipt links.`
          : 'Mission Control flight deck — who is flying, where the pipeline sits, and which artifacts landed. Read-only board; dispatch opens the form or Co-Pilot.',
        right: html`<button type="button" class="btn" id="fd-dispatch-open">+ Dispatch Flight</button>`,
      })}
      <div id="fd-kpis">
        ${kpiRow([
          html`<div class="ui-stat" data-fd-kpi="total">
            <div class="ui-stat-label">Total Flights</div>
            <div class="ui-stat-value">${String(kpis.total)}</div>
          </div>`,
          html`<div class="ui-stat" data-fd-kpi="active">
            <div class="ui-stat-label">Active In-Flight</div>
            <div class="ui-stat-value">${activeValue}</div>
          </div>`,
          html`<div class="ui-stat" data-fd-kpi="landed">
            <div class="ui-stat-label">Landed / Merged</div>
            <div class="ui-stat-value">${String(kpis.landed)}</div>
          </div>`,
          html`<div class="ui-stat" data-fd-kpi="pr-rate">
            <div class="ui-stat-label">PR Landing Rate</div>
            <div class="ui-stat-value">${kpis.prLandingLabel}</div>
            <div class="ui-stat-sub" style="color:var(--dim)">${
              kpis.prLandingRate === null
                ? 'No closed flights yet'
                : kpis.withPr > 0
                  ? `${String(kpis.withPr)} landed with a PR`
                  : 'of closed flights'
            }</div>
          </div>`,
        ])}
      </div>
      ${scanLimited
        ? html`<div class="card" role="status" style="border-color:var(--warn);margin-bottom:12px">
            Flight history is partial because the project scan safety limit was reached.
          </div>`
        : ''}
      <div class="fd-toolbar">
        <input
          id="fd-search"
          class="fd-search"
          type="search"
          placeholder="Search goal, squad, or agent…"
          aria-label="Search flights by goal, squad, or agent"
        />
        <div class="fd-tabs" role="tablist" aria-label="Flight status filters">
          <button type="button" class="fd-tab is-active" role="tab" aria-selected="true" data-fd-tab="all">All <span class="fd-tab-count">${counts.all}</span></button>
          <button type="button" class="fd-tab" role="tab" aria-selected="false" data-fd-tab="flying">🟢 Flying / Running <span class="fd-tab-count">${counts.flying}</span></button>
          <button type="button" class="fd-tab" role="tab" aria-selected="false" data-fd-tab="landed">🏁 Landed / Merged <span class="fd-tab-count">${counts.landed}</span></button>
          <button type="button" class="fd-tab" role="tab" aria-selected="false" data-fd-tab="held">⏸️ Held <span class="fd-tab-count">${counts.held}</span></button>
          <button type="button" class="fd-tab" role="tab" aria-selected="false" data-fd-tab="failed">❌ Failed <span class="fd-tab-count">${counts.failed}</span></button>
        </div>
        ${kpis.active > 0
          ? html`<span class="fd-live-hint" id="fd-live-hint">Live board · polling every 12s</span>`
          : ''}
      </div>
      <style>${raw(DECK_CSS)}</style>
      ${raw(`<div class="card fd-board" id="fd-board">${table}</div>`)}
      <div id="fd-dispatch-backdrop" class="fd-dispatch-backdrop" hidden></div>
      <aside id="fd-dispatch" class="fd-dispatch" aria-hidden="true" aria-label="Dispatch Flight">
        <h2>Dispatch Flight</h2>
        <p>One bounded run toward a goal. Pick the target repo, then send it to Studio / Cursor Cloud — or ask Co-Pilot to draft the brief.</p>
        <form id="fd-dispatch-form">
          <label>Goal
            <textarea id="fd-dispatch-goal" name="prompt" rows="4" maxlength="8000" required placeholder="What should this flight land?"></textarea>
          </label>
          <label>Target repo
            <select id="fd-repo-select" name="repo" aria-label="Target repo">
              ${raw(repoOptions)}
            </select>
          </label>
          <label id="fd-repo-custom-wrap" hidden>
            Repo URL
            <input id="fd-repo-custom" type="url" name="repoUrl" placeholder="https://github.com/org/repo" />
          </label>
          <div class="fd-dispatch-actions">
            <button type="submit" class="btn">Dispatch</button>
            <button type="button" class="btn secondary" id="fd-dispatch-cancel">Cancel</button>
            <button type="button" class="btn secondary" data-copilot-open data-copilot-prefill="Help me dispatch a flight. Suggest a goal and target repo.">Ask Co-Pilot</button>
          </div>
          <p class="fd-dispatch-status" id="fd-dispatch-status" role="status" aria-live="polite"></p>
        </form>
        <button type="button" class="btn secondary sm" id="fd-dispatch-close" style="margin-top:auto">Close</button>
      </aside>
      <script>${raw(DECK_SCRIPT)}</script>
    </div>`
}
