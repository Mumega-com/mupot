// mupot — /circuits dashboard view (mupot-circuit-state-view flight, follow-on
// to mupot-workflow-circuits).
//
// "Clear state of workflows" (Hadi's own words) is the point of the whole
// workflow-circuits addon — this file is the FIRST place a human can actually
// SEE it, not just query it through MCP tools. Two views:
//   GET /circuits       — every circuit for this tenant (key, name, status,
//                          node count), linking into each.
//   GET /circuits/:id   — one circuit's live state: a Mermaid flowchart of its
//                          nodes/edges (progressive enhancement) PLUS a plain
//                          table underneath that carries the SAME information
//                          — accessibility, and the diagram is never the only
//                          way to read state (mermaid.min.js could fail to
//                          load; the table still renders server-side).
//
// Read-only. Calls src/addons/workflow-circuits/service.ts's listCircuits /
// getCircuitState directly — same process, no HTTP hop, same pattern every
// other dashboard view in this file uses to call its domain service layer.
// No addon-active gate here (see listCircuits' docstring): an inactive addon
// simply has zero rows, which is already an honest empty state.

import { html, raw } from 'hono/html'
import type { Env } from '../types'
import {
  getCircuitState,
  listCircuits,
  type CircuitDoneState,
  type CircuitEdgeRecord,
  type CircuitState,
  type CircuitSummary,
} from '../addons/workflow-circuits/service'
import type { CircuitEdgeType } from '../addons/workflow-circuits/validation'
import { pageHeader, pill, sectionPanel } from './ui'
import type { Html, Tone } from './ui'

// ── list view ────────────────────────────────────────────────────────────────

export interface CircuitListView {
  circuits: CircuitSummary[]
}

export async function loadCircuitListView(env: Env): Promise<CircuitListView> {
  return { circuits: await listCircuits(env) }
}

function circuitStatusTone(status: CircuitSummary['status']): Tone {
  return status === 'archived' ? 'dim' : 'ok'
}

export function circuitListBody(view: CircuitListView): Html {
  const rows = view.circuits.map((circuit) => [
    html`<a class="ui-link" href="/circuits/${encodeURIComponent(circuit.id)}"><strong>${circuit.name}</strong></a>`,
    html`<code>${circuit.key}</code>`,
    pill(circuit.status === 'archived' ? 'Archived' : 'Defined', circuitStatusTone(circuit.status)),
    html`${String(circuit.node_count)}`,
    html`${circuit.created_at}`,
  ])
  return html`${pageHeader({
    crumbs: 'Overview / Circuits',
    title: 'Circuits',
    sub: 'Live state of every deterministic workflow circuit in this pot — pending, active, done, blocked, failed, timeout, degraded.',
  })}
    ${sectionPanel({
      title: 'All circuits',
      body: circuitTable('circuit-list', 'Circuits', [
        { label: 'Name', width: '1.4fr' },
        { label: 'Key', width: '1fr' },
        { label: 'Status', width: 'auto' },
        { label: 'Nodes', width: 'auto' },
        { label: 'Created', width: '1.1fr' },
      ], rows, 'No circuits are defined yet. An owner/admin can define one via the workflow-circuits MCP tools.'),
    })}`
}

// ── detail view ──────────────────────────────────────────────────────────────

export async function loadCircuitDetailView(env: Env, circuitId: string): Promise<CircuitState | null> {
  return getCircuitState(env, circuitId)
}

export function circuitNotFoundBody(circuitId: string): Html {
  return html`${pageHeader({ crumbs: 'Overview / Circuits', title: 'Circuit not found' })}
    <p class="ui-sub">No circuit with id <code>${circuitId}</code> exists for this org.</p>
    <p><a class="ui-link" href="/circuits">← Back to circuits</a></p>`
}

const DONE_STATE_LABEL: Record<CircuitDoneState, string> = {
  pending: 'Pending', active: 'Active', done: 'Done', blocked: 'Blocked',
  failed: 'Failed', timeout: 'Timeout', degraded: 'Degraded',
}

// Same bucket a reader would expect from a traffic-light reading of the addon's
// own state machine (service.ts VALID_TRANSITIONS docstring): done=green,
// active=amber/in-progress, blocked=grey, failed/timeout=red, degraded=orange
// (distinct from active's amber — this dashboard has no existing "orange"
// token, so the fill color chosen for the diagram below is new; the pill tone
// below reuses ui.ts's existing 'warn' for both active and degraded since
// ui.ts's Tone enum has no separate orange, and pill tone is a secondary,
// lower-fidelity signal — the diagram is the source of truth for the
// active/degraded distinction).
function nodeStateTone(state: CircuitDoneState): Tone {
  if (state === 'done') return 'ok'
  if (state === 'active' || state === 'degraded') return 'warn'
  if (state === 'failed' || state === 'timeout') return 'danger'
  if (state === 'blocked') return 'dim'
  return 'primary' // pending
}

function circuitTable(id: string, label: string, columns: Array<{ label: string; width: string }>, rows: Html[][], empty: string): Html {
  const tracks = columns.map((column) => column.width).join(' ')
  const headerIds = columns.map((_, index) => `${id}-header-${index + 1}`)
  return html`<div role="region" aria-label="${label}" tabindex="0" style="max-width:100%;overflow-x:auto;">
    <div class="ui-table circuit-table" role="table" aria-label="${label}">
      <div class="ui-tr ui-thead" role="row" style="grid-template-columns:${raw(tracks)}">${columns.map((column, index) => html`<div id="${headerIds[index]}" class="ui-th" role="columnheader">${column.label}</div>`)}</div>
      ${rows.length ? rows.map((cells, rowIndex) => html`<div class="ui-tr ui-row" role="row" style="grid-template-columns:${raw(tracks)}">${cells.map((cell, index) => {
        const contentId = `${id}-row-${rowIndex + 1}-cell-${index + 1}`
        return html`<div class="ui-td" role="cell" aria-labelledby="${headerIds[index] ?? ''} ${contentId}"><span class="circuit-mobile-label" aria-hidden="true">${columns[index]?.label ?? ''}</span><div id="${contentId}" class="circuit-cell">${cell}</div></div>`
      })}</div>`) : html`<div class="ui-table-empty">${empty}</div>`}
    </div>
  </div>`
}

function jsonScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
}

export function circuitDetailBody(state: CircuitState): Html {
  const definition = buildCircuitMermaidDefinition(state)

  const nodeRows = state.nodes.map((node) => [
    html`<code>${node.id}</code>`,
    html`${node.type}`,
    pill(DONE_STATE_LABEL[node.done_state], nodeStateTone(node.done_state)),
    html`${node.gate_rule}`,
    html`${node.customer_facing ? 'Yes' : 'No'}`,
    node.required_wires.length
      ? html`<ul style="margin:0;padding-left:1.1rem;">${node.required_wires.map((wire) => html`<li><code>${wire.edge_id}</code> · ${wire.type} from <code>${wire.source}</code> · ${wire.satisfied ? pill('Satisfied', 'ok') : pill('Unsatisfied', 'warn')}</li>`)}</ul>`
      : html`<span class="ui-panel-sub">None (entry node)</span>`,
  ])

  const edgeRows = state.edges.map((edge) => [
    html`<code>${edge.id}</code>`,
    html`${edge.type}`,
    html`<code>${edge.source}</code>`,
    html`<code>${edge.target}</code>`,
    edge.type === 'gate'
      ? (edge.approved_at !== null
        ? html`<span class="circuit-stack">${pill('Approved', 'ok')}<span class="ui-panel-sub">${edge.approved_by} · ${edge.approved_at}</span></span>`
        : pill('Not approved', 'warn'))
      : html`<span class="ui-panel-sub">n/a</span>`,
  ])

  return html`${pageHeader({
    crumbs: `Overview / Circuits / ${state.key}`,
    title: state.name,
    sub: `Key ${state.key} · ${state.nodes.length} node${state.nodes.length === 1 ? '' : 's'} · ${state.edges.length} edge${state.edges.length === 1 ? '' : 's'}`,
    badge: state.status === 'archived' ? 'Archived' : 'Defined',
    badgeTone: state.status === 'archived' ? 'dim' : 'ok',
  })}
    <p style="margin:0 0 14px;"><a class="ui-link" href="/circuits">← All circuits</a></p>
    ${sectionPanel({
      title: 'Diagram',
      body: html`<script type="application/json" id="circuit-mermaid-definition">${raw(jsonScript(definition))}</script>
        <div id="circuit-mermaid-diagram" class="circuit-mermaid" aria-hidden="true">
          <p class="ui-panel-sub">Rendering the diagram requires JavaScript. The table below carries the same state.</p>
        </div>
        <noscript><p class="ui-panel-sub">Diagram requires JavaScript — see the node/edge tables below for the same information.</p></noscript>
        <script src="/vendor/mermaid.min.js"></script>
        <script>${raw(CIRCUIT_MERMAID_INIT_SCRIPT)}</script>`,
    })}
    ${sectionPanel({
      title: 'Nodes',
      body: circuitTable('circuit-nodes', 'Circuit nodes', [
        { label: 'ID', width: '1fr' }, { label: 'Type', width: '1fr' }, { label: 'State', width: 'auto' },
        { label: 'Gate rule', width: 'auto' }, { label: 'Customer facing', width: 'auto' }, { label: 'Required wires', width: '1.6fr' },
      ], nodeRows, 'This circuit has no nodes.'),
    })}
    ${sectionPanel({
      title: 'Edges',
      body: circuitTable('circuit-edges', 'Circuit edges', [
        { label: 'ID', width: '1fr' }, { label: 'Type', width: 'auto' }, { label: 'Source', width: '1fr' },
        { label: 'Target', width: '1fr' }, { label: 'Gate approval', width: '1.4fr' },
      ], edgeRows, 'This circuit has no edges.'),
    })}`
}

// ── Mermaid definition (server-side, pure, unit-testable without a DOM) ──────

// Node fill/stroke/text per done_state. failed and timeout share one visual
// bucket (both "red" — the addon's own docs group them as the aviation-
// tolerance abnormal states a fallback wire exists to recover from). Colors
// below are this dashboard's OWN dark-theme tokens (shell()'s [data-theme=
// "dark"] block: --ok #3fb950, --warn2 #d29922, --danger #f85149, --dim
// #6b7685, --bars #2a3140) — reused literally (Mermaid renders into an
// isolated SVG it does not inherit page CSS custom properties into, so a
// var(--token) reference would not resolve; these are the same hex values
// those tokens already hold, not new colors). 'degraded' has no existing
// token in this dashboard for a distinct orange (active already owns the
// amber slot) — db6d28 is chosen from the same GitHub-Dark-derived family
// this palette is already built from (Primer's scale.orange.5).
const NODE_FILL: Record<CircuitDoneState, { fill: string; stroke: string; text: string }> = {
  pending: { fill: '#2a3140', stroke: '#3a4459', text: '#9aa7b5' },
  active: { fill: '#d29922', stroke: '#d29922', text: '#0e1116' },
  done: { fill: '#3fb950', stroke: '#3fb950', text: '#0e1116' },
  blocked: { fill: '#6b7685', stroke: '#6b7685', text: '#ffffff' },
  failed: { fill: '#f85149', stroke: '#f85149', text: '#ffffff' },
  timeout: { fill: '#f85149', stroke: '#f85149', text: '#ffffff' },
  degraded: { fill: '#db6d28', stroke: '#db6d28', text: '#0e1116' },
}

// Edge stroke + dash pattern per type, per the flight brief: dependency=solid,
// gate=dashed (labeled, shows satisfied/unsatisfied), trigger=solid (labeled
// "trigger"), fallback=dotted (labeled "fallback"). Classic Mermaid flowchart
// link glyphs only distinguish solid (-->) vs dashed (-.->) — dotted-vs-dashed
// is a `linkStyle` stroke-dasharray override applied per edge below, keyed to
// each edge's declaration index (Mermaid's own mechanism for per-link style).
const EDGE_STYLE: Record<CircuitEdgeType, { arrow: '-->' | '-.->'; label: string | null; dasharray: string | null; stroke: string }> = {
  dependency: { arrow: '-->', label: null, dasharray: null, stroke: '#6b7685' },
  trigger: { arrow: '-->', label: 'trigger', dasharray: null, stroke: '#06b6d4' },
  gate: { arrow: '-.->', label: null, dasharray: '6,4', stroke: '#06b6d4' },
  fallback: { arrow: '-.->', label: 'fallback', dasharray: '1,4', stroke: '#db6d28' },
}

// Escapes text going into Mermaid's own DSL (a different escaping context
// than HTML). Node `type` is free text up to 64 chars with NO charset
// restriction at validation time (src/addons/workflow-circuits/validation.ts
// only checks length) — define_circuit is admin-gated, but this generator
// still never trusts that string into the diagram source unescaped, matching
// this dashboard's existing rule of never handing an unescaped value to a
// templating layer (ui.ts's safeTrack/safeFill allowlisting).
function mermaidLabel(text: string): string {
  return text
    .replace(/[\r\n]+/g, ' ')
    .replace(/"/g, '&quot;')
    .replace(/\|/g, '/')
    .slice(0, 140)
}

function edgeLabel(edge: CircuitEdgeRecord): string | null {
  const style = EDGE_STYLE[edge.type]
  if (edge.type === 'gate') return `gate: ${edge.approved_at !== null ? 'satisfied' : 'unsatisfied'}`
  return style.label
}

/** Pure: builds a Mermaid flowchart definition string from a circuit's live
 * state. No DOM, no I/O — unit-testable directly. A circuit with zero nodes
 * (defensive; define_circuit's own validation requires >=1 node, but this
 * generator must not assume a caller only ever sees validated data) produces
 * a bare `flowchart TD` — Mermaid renders that as an empty diagram, not an
 * error. An edge referencing a node id absent from `state.nodes` (should be
 * unreachable given the FK constraints in migrations/0075, but defensive
 * regardless) is skipped rather than emitting a dangling reference. */
export function buildCircuitMermaidDefinition(state: CircuitState): string {
  const idMap = new Map<string, string>()
  state.nodes.forEach((node, index) => idMap.set(node.id, `n${index}`))

  const lines: string[] = ['flowchart TD']

  for (const node of state.nodes) {
    const mid = idMap.get(node.id) as string
    const label = mermaidLabel(`${node.id} (${node.type})\n${DONE_STATE_LABEL[node.done_state]}`)
    lines.push(`  ${mid}["${label}"]:::st_${node.done_state}`)
  }

  const usedStates = new Set(state.nodes.map((node) => node.done_state))
  for (const doneState of usedStates) {
    const style = NODE_FILL[doneState]
    lines.push(`  classDef st_${doneState} fill:${style.fill},stroke:${style.stroke},color:${style.text},stroke-width:1.5px`)
  }

  const linkStyles: string[] = []
  let linkIndex = 0
  for (const edge of state.edges) {
    const src = idMap.get(edge.source)
    const tgt = idMap.get(edge.target)
    if (!src || !tgt) continue
    const style = EDGE_STYLE[edge.type]
    const label = edgeLabel(edge)
    const connector = label ? `${style.arrow}|${mermaidLabel(label)}|` : style.arrow
    lines.push(`  ${src} ${connector} ${tgt}`)
    linkStyles.push(`  linkStyle ${linkIndex} stroke:${style.stroke}${style.dasharray ? `,stroke-width:2px,stroke-dasharray:${style.dasharray}` : ''}`)
    linkIndex += 1
  }
  lines.push(...linkStyles)

  return lines.join('\n')
}

// Torivers' established Mermaid dark theme (design/DESIGN-SYSTEM.md) — the
// literal %%{init}%% string, reused verbatim rather than re-derived, since
// the flight brief names this specific convention as already-locked for
// circuit/workflow diagrams. Applied client-side at mermaid.initialize() time
// rather than baked into the definition string, so it stays swappable without
// touching buildCircuitMermaidDefinition's output.
export const CIRCUIT_MERMAID_THEME_VARIABLES = Object.freeze({
  primaryColor: '#D4A017',
  primaryTextColor: '#F0F4FF',
  primaryBorderColor: '#06B6D4',
  lineColor: '#06B6D4',
  background: '#0A0F1E',
})

// Inline init/render script (progressive enhancement — see circuitDetailBody).
// Reads the JSON-embedded definition string, hands it to vendored mermaid.min.js
// (public/vendor/, served via the Workers [assets] binding — see wrangler
// .example.toml), and swaps the rendered SVG into the container. Any failure
// (mermaid absent, parse error, render error) leaves the plain node/edge
// tables below as the sole source of truth — never throws past this IIFE.
//
// container.innerHTML is set to mermaid's OWN render() output — the documented
// Mermaid API contract (mermaid.render returns { svg } specifically for this),
// not raw user content. securityLevel is set to 'strict' explicitly (mermaid's
// own default, but pinned here rather than left implicit) so mermaid runs its
// internal DOMPurify sanitization pass over that SVG and disables script-
// executing directives (e.g. `click` callbacks) before we ever touch the DOM
// with it. Node `type` text is admin-authored (define_circuit is owner/admin-
// gated) and additionally escaped by mermaidLabel() above before it ever
// reaches the Mermaid DSL string mermaid renders from.
const CIRCUIT_MERMAID_INIT_SCRIPT = `(function () {
  var container = document.getElementById('circuit-mermaid-diagram');
  var defScript = document.getElementById('circuit-mermaid-definition');
  if (!container || !defScript) return;
  try {
    var definition = JSON.parse(defScript.textContent || 'null');
    if (typeof definition !== 'string' || !definition || typeof window.mermaid === 'undefined') return;
    window.mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      securityLevel: 'strict',
      themeVariables: ${JSON.stringify(CIRCUIT_MERMAID_THEME_VARIABLES)}
    });
    window.mermaid.render('circuit-mermaid-svg', definition).then(function (result) {
      container.innerHTML = result.svg;
      container.removeAttribute('aria-hidden');
    }).catch(function () {
      // Leave the JS-required note in place; the tables below already carry the state.
    });
  } catch (err) {
    // Same fallback: the plain tables render regardless of any error here.
  }
})();`
