import { html } from 'hono/html'
import type { AddonBinding, AddonBindingGeneration } from '../addons/bindings'
import { listAddonBindings, loadLiveAddonBindingGeneration } from '../addons/bindings'
import {
  getLatestMarketingMonitorRun,
  listMarketingMonitorRuns,
} from '../addons/marketing/service'
import type {
  MarketingMonitorRun,
  MarketingOutcomes,
  OutcomeValue,
  SourceStatus,
} from '../addons/marketing/types'
import type { AddonActor, AddonInstallation, AddonState } from '../addons/service'
import type { Env } from '../types'
import { emptyState, pageHeader, pill, sectionPanel, statusDot } from './ui'
import type { Html, Tone } from './ui'

const ADDON_KEY = 'marketing-cro-monitor'
const RUN_LIST_LIMIT = 10

const SOURCE_SLOTS = [
  { slot: 'web_analytics', label: 'Web analytics' },
  { slot: 'content_surface', label: 'Content surface' },
  { slot: 'search_performance', label: 'Search performance' },
  { slot: 'crm', label: 'CRM and revenue' },
  { slot: 'ai_visibility', label: 'AI visibility' },
] as const

const OUTCOMES = [
  { key: 'visibility', label: 'AI visibility' },
  { key: 'qualifiedTraffic', label: 'Qualified traffic' },
  { key: 'leads', label: 'Leads' },
  { key: 'conversion', label: 'Conversion' },
  { key: 'revenue', label: 'Revenue' },
] as const

export type MonitorSourceHealthStatus = 'bound' | SourceStatus

export interface MonitorSourceHealthView {
  slot: string
  label: string
  adapter: string | null
  status: MonitorSourceHealthStatus
  detail: string
}

export interface MonitorRunView {
  id: string
  windowStart: string
  windowEnd: string
  sourceCount: number
  observationCount: number
  evidenceDigest: string
  completedAt: string
}

export interface MonitorOpportunityView {
  title: string
  detail: string
  tone: Tone
}

export interface MarketingCroMonitorView {
  installationState: AddonState
  monitorState: 'ready' | 'empty' | 'unavailable'
  outcomes: MarketingOutcomes | null
  sourceHealth: MonitorSourceHealthView[] | null
  recentRuns: MonitorRunView[] | null
  latestEvidenceDigest: string | null
  latestCompletedAt: string | null
  opportunity: MonitorOpportunityView
}

export interface MarketingCroMonitorViewDeps {
  listBindings?: typeof listAddonBindings
  loadBindingGeneration?: typeof loadLiveAddonBindingGeneration
  getLatestRun?: typeof getLatestMarketingMonitorRun
  listRuns?: typeof listMarketingMonitorRuns
}

function bindingSnapshotMatches(
  installation: AddonInstallation,
  generation: AddonBindingGeneration,
  bindings: readonly AddonBinding[],
): boolean {
  return generation.tenant === installation.tenant
    && generation.installationId === installation.id
    && generation.manifestSha256 === installation.manifestSha256
    && generation.revokedAt === null
    && generation.bindingCount === bindings.length
    && bindings.every((binding) => (
      binding.tenant === installation.tenant
      && binding.installationId === installation.id
      && binding.generationId === generation.id
      && binding.manifestSha256 === installation.manifestSha256
      && binding.revokedAt === null
    ))
}

function unavailableView(installationState: AddonState): MarketingCroMonitorView {
  return {
    installationState,
    monitorState: 'unavailable',
    outcomes: null,
    sourceHealth: null,
    recentRuns: null,
    latestEvidenceDigest: null,
    latestCompletedAt: null,
    opportunity: opportunityFor('unavailable', null),
  }
}

function sourceDetail(status: SourceStatus, observationCount: number, reason?: string): string {
  if (status === 'available') {
    return `${observationCount} observation${observationCount === 1 ? '' : 's'}`
  }
  return humanize(reason ?? (status === 'failed' ? 'source_failed' : 'source_unavailable'))
}

function healthFromBindings(
  bindings: readonly AddonBinding[],
  latest: MarketingMonitorRun | null,
): MonitorSourceHealthView[] {
  return SOURCE_SLOTS.map(({ slot, label }) => {
    const binding = bindings.find((candidate) => candidate.slot === slot)
    if (!binding) {
      return { slot, label, adapter: null, status: 'unavailable', detail: 'Not configured' }
    }

    const source = latest?.sources.find((candidate) => candidate.slot === slot)
    if (!source) {
      return {
        slot,
        label,
        adapter: binding.adapter,
        status: 'bound',
        detail: latest ? 'No evidence in latest run' : 'Bound; no completed run',
      }
    }

    return {
      slot,
      label,
      adapter: binding.adapter,
      status: source.status,
      detail: sourceDetail(source.status, source.observationCount, source.reason),
    }
  })
}

function runView(run: MarketingMonitorRun): MonitorRunView {
  return {
    id: run.id,
    windowStart: run.window.start,
    windowEnd: run.window.end,
    sourceCount: run.sourceCount,
    observationCount: run.observationCount,
    evidenceDigest: run.evidenceDigest,
    completedAt: run.completedAt,
  }
}

function opportunityFor(
  monitorState: MarketingCroMonitorView['monitorState'],
  outcomes: MarketingOutcomes | null,
): MonitorOpportunityView {
  if (monitorState === 'unavailable') {
    return {
      title: 'Opportunity evidence unavailable',
      detail: 'The monitor reads could not be verified. No opportunity is inferred from missing data.',
      tone: 'warn',
    }
  }
  if (!outcomes) {
    return {
      title: 'No opportunity evidence yet',
      detail: 'Complete a monitor run to establish measured outcomes before review.',
      tone: 'dim',
    }
  }

  const unavailable = OUTCOMES.find(({ key }) => outcomes[key].status === 'unavailable')
  if (unavailable) {
    const outcome = outcomes[unavailable.key]
    return {
      title: `${unavailable.label} measurement gap`,
      detail: outcome.status === 'unavailable'
        ? `${humanize(outcome.reason)}. Treat this outcome as unavailable, not zero.`
        : 'Outcome evidence is available.',
      tone: 'warn',
    }
  }

  return {
    title: 'Evidence ready for review',
    detail: 'The latest completed run measured every monitor outcome.',
    tone: 'ok',
  }
}

export async function loadMarketingCroMonitorView(
  env: Env,
  installation: AddonInstallation,
  actor: AddonActor,
  deps: MarketingCroMonitorViewDeps = {},
): Promise<MarketingCroMonitorView> {
  const readBindings = deps.listBindings ?? listAddonBindings
  const readGeneration = deps.loadBindingGeneration ?? loadLiveAddonBindingGeneration
  const readLatest = deps.getLatestRun ?? getLatestMarketingMonitorRun
  const readRuns = deps.listRuns ?? listMarketingMonitorRuns
  let bindings: AddonBinding[]
  let generation: AddonBindingGeneration | null
  try {
    bindings = await readBindings(env, installation.id)
    generation = await readGeneration(env, installation.id)
  } catch {
    return unavailableView(installation.state)
  }
  if (!generation) {
    if (bindings.length > 0) return unavailableView(installation.state)
    return {
      installationState: installation.state,
      monitorState: 'empty',
      outcomes: null,
      sourceHealth: healthFromBindings([], null),
      recentRuns: [],
      latestEvidenceDigest: null,
      latestCompletedAt: null,
      opportunity: opportunityFor('empty', null),
    }
  }
  if (!bindingSnapshotMatches(installation, generation, bindings)) {
    return unavailableView(installation.state)
  }

  const scope = {
    installationId: installation.id,
    generationId: generation.id,
    bindingCount: generation.bindingCount,
  }
  const [latestResult, runsResult] = await Promise.allSettled([
    readLatest(env, actor, scope),
    readRuns(env, actor, { limit: RUN_LIST_LIMIT, ...scope }),
  ])
  if (
    latestResult.status !== 'fulfilled'
    || !latestResult.value.ok
    || runsResult.status !== 'fulfilled'
    || !runsResult.value.ok
  ) return unavailableView(installation.state)

  const latest = latestResult.value.run
  const runs = runsResult.value.runs
  const readsAgree = latest === null ? runs.length === 0 : runs[0]?.id === latest.id
  if (!readsAgree) return unavailableView(installation.state)
  const monitorState: MarketingCroMonitorView['monitorState'] = latest ? 'ready' : 'empty'
  const outcomes = latest?.outcomes ?? null
  const recentRuns = runs.map(runView)
  const sourceHealth = healthFromBindings(bindings, latest)

  return {
    installationState: installation.state,
    monitorState,
    outcomes,
    sourceHealth,
    recentRuns,
    latestEvidenceDigest: latest?.evidenceDigest ?? null,
    latestCompletedAt: latest?.completedAt ?? null,
    opportunity: opportunityFor(monitorState, outcomes),
  }
}

function humanize(value: string): string {
  const normalized = value.replaceAll('_', ' ')
  return normalized.length === 0
    ? 'Unavailable'
    : `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`
}

function outcomeDisplay(outcome: OutcomeValue | undefined): { value: string; detail: string } {
  if (!outcome || outcome.status === 'unavailable') {
    return {
      value: 'Unavailable',
      detail: outcome?.status === 'unavailable' ? humanize(outcome.reason) : 'No completed run',
    }
  }
  if (outcome.unit === 'ratio') {
    return { value: `${(outcome.value * 100).toFixed(1).replace(/\.0$/, '')}%`, detail: humanize(outcome.source) }
  }
  if (outcome.unit === 'usd') {
    return {
      value: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(outcome.value),
      detail: humanize(outcome.source),
    }
  }
  return {
    value: new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(outcome.value),
    detail: humanize(outcome.source),
  }
}

function stateTone(state: AddonState): Tone {
  if (state === 'active') return 'ok'
  if (state === 'disabled' || state === 'archived') return 'dim'
  return 'warn'
}

function sourceTone(status: MonitorSourceHealthStatus): Tone {
  if (status === 'available') return 'ok'
  if (status === 'failed') return 'danger'
  if (status === 'bound') return 'primary'
  return 'warn'
}

function sourceLabel(status: MonitorSourceHealthStatus): string {
  if (status === 'available') return 'Available'
  return humanize(status)
}

function compactTimestamp(value: string): string {
  return `${value.slice(0, 10)} ${value.slice(11, 16)} UTC`
}

function sourceHealthBody(sourceHealth: MonitorSourceHealthView[] | null): Html {
  if (sourceHealth === null) {
    return emptyState({
      title: 'Source health unavailable',
      detail: 'Bindings could not be read. No source is reported as healthy.',
    })
  }
  return html`<div class="monitor-source-list">
    ${sourceHealth.map((source) => html`
      <div class="monitor-source-row">
        <div class="monitor-source-main">
          <strong>${source.label}</strong>
          <span>${source.adapter ? humanize(source.adapter) : 'No binding'}</span>
        </div>
        <div class="monitor-source-status">
          ${statusDot(sourceTone(source.status), sourceLabel(source.status))}
          <span>${source.detail}</span>
        </div>
      </div>`)}
  </div>`
}

function recentRunsBody(runs: MonitorRunView[] | null): Html {
  if (runs === null) {
    return emptyState({
      title: 'Run history unavailable',
      detail: 'Completed runs could not be verified. The run count is not reported as zero.',
    })
  }
  if (runs.length === 0) {
    return emptyState({
      title: 'No completed runs',
      detail: 'Run history is available, but this installation has no completed evidence window yet.',
    })
  }
  return html`<div class="monitor-run-list">
    ${runs.map((run) => html`
      <div class="monitor-run-row">
        <div>
          <strong><time datetime="${run.completedAt}">${compactTimestamp(run.completedAt)}</time></strong>
          <span>${run.windowStart.slice(0, 10)} to ${run.windowEnd.slice(0, 10)}</span>
        </div>
        <div><span>Sources</span><strong>${run.sourceCount}</strong></div>
        <div><span>Observations</span><strong>${run.observationCount}</strong></div>
        <div class="monitor-digest"><span>Evidence digest</span><code title="${run.evidenceDigest}">${run.evidenceDigest.slice(0, 12)}</code></div>
      </div>`)}
  </div>`
}

export function marketingCroMonitorBody(view: MarketingCroMonitorView) {
  const outcomes = OUTCOMES.map(({ key, label }) => ({ label, ...outcomeDisplay(view.outcomes?.[key]) }))
  const latestSummary = view.latestCompletedAt
    ? `Latest completed ${compactTimestamp(view.latestCompletedAt)}`
    : view.monitorState === 'unavailable'
      ? 'Monitor data unavailable'
      : 'No completed run'

  return html`
    <style>
      .monitor-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; }
      .monitor-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .monitor-action { display: inline-flex; align-items: center; gap: 7px; min-height: 34px; padding: 6px 10px; border: 1px solid var(--border); border-radius: 7px; background: var(--surface); color: var(--text2); font-size: 12px; font-weight: 600; }
      .monitor-action:hover { background: var(--hover); color: var(--text); }
      .monitor-action svg { flex: none; }
      .monitor-summary { color: var(--dim); font-size: 12px; margin: 6px 0 0; }
      .monitor-outcomes { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); margin: 18px 0; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); overflow: hidden; }
      .monitor-outcome { min-width: 0; padding: 13px 14px; border-right: 1px solid var(--border-soft); }
      .monitor-outcome:last-child { border-right: 0; }
      .monitor-outcome span { display: block; color: var(--dim); font-size: 11px; line-height: 1.3; overflow-wrap: anywhere; }
      .monitor-outcome strong { display: block; color: var(--text); font-family: var(--font-display); font-size: 24px; font-weight: 400; line-height: 1.1; margin: 5px 0; overflow-wrap: anywhere; }
      .monitor-source-list, .monitor-run-list { display: grid; }
      .monitor-source-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr); align-items: center; gap: 16px; min-height: 52px; padding: 8px 0; border-bottom: 1px solid var(--border-soft); }
      .monitor-source-row:last-child, .monitor-run-row:last-child { border-bottom: 0; }
      .monitor-source-main, .monitor-source-status { min-width: 0; display: flex; align-items: center; gap: 10px; }
      .monitor-source-main strong { font-size: 13px; }
      .monitor-source-main > span, .monitor-source-status > span { color: var(--dim); font-size: 12px; overflow-wrap: anywhere; }
      .monitor-source-status { justify-content: space-between; }
      .monitor-opportunity { display: grid; grid-template-columns: 34px minmax(0, 1fr); gap: 12px; align-items: start; }
      .monitor-opportunity-icon { width: 34px; height: 34px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--border); border-radius: 7px; color: var(--primary); background: var(--primary-soft); }
      .monitor-opportunity strong { display: block; font-size: 13px; margin: 1px 0 4px; }
      .monitor-opportunity p { color: var(--dim); font-size: 12.5px; line-height: 1.5; margin: 0; }
      .monitor-run-row { display: grid; grid-template-columns: minmax(170px, 1.5fr) minmax(68px, .5fr) minmax(90px, .6fr) minmax(130px, .8fr); gap: 14px; align-items: center; padding: 11px 0; border-bottom: 1px solid var(--border-soft); }
      .monitor-run-row > div { min-width: 0; }
      .monitor-run-row span { display: block; color: var(--dim); font-size: 10.5px; }
      .monitor-run-row strong, .monitor-run-row code { display: block; color: var(--text2); font-size: 12px; overflow-wrap: anywhere; }
      .monitor-run-row code { font-family: var(--font-mono); }
      @media (max-width: 900px) {
        .monitor-outcomes { grid-template-columns: repeat(3, minmax(0, 1fr)); }
        .monitor-outcome { border-bottom: 1px solid var(--border-soft); }
      }
      @media (max-width: 680px) {
        .monitor-head { align-items: flex-start; flex-direction: column; }
        .monitor-actions { width: 100%; }
        .monitor-action { flex: 1 1 140px; justify-content: center; }
        .monitor-outcomes { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .monitor-outcome { border-right: 1px solid var(--border-soft); }
        .monitor-outcome:nth-child(2n) { border-right: 0; }
        .monitor-outcome:last-child { grid-column: 1 / -1; border-bottom: 0; }
        .monitor-source-row { grid-template-columns: minmax(0, 1fr); gap: 5px; padding: 11px 0; }
        .monitor-source-status { justify-content: flex-start; flex-wrap: wrap; }
        .monitor-run-row { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 14px; }
        .monitor-run-row > :first-child, .monitor-digest { grid-column: 1 / -1; }
      }
    </style>
    <div class="monitor-head">
      <div>
        ${pageHeader({
          crumbs: 'Addons / Operational console',
          title: 'Marketing & CRO',
          badge: humanize(view.installationState),
          badgeTone: stateTone(view.installationState),
        })}
        <p class="monitor-summary">${latestSummary}${view.latestEvidenceDigest ? ` · Evidence ${view.latestEvidenceDigest.slice(0, 12)}` : ''}</p>
      </div>
      <nav class="monitor-actions" aria-label="Addon evidence links">
        <a class="monitor-action" href="/api/addons/${ADDON_KEY}/monitor/latest">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5z"/><polyline points="14 2 14 8 20 8"/><path d="m9 15 2 2 4-4"/></svg>
          Latest evidence
        </a>
        <a class="monitor-action" href="/api/addons/${ADDON_KEY}/receipts">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><path d="M15 12h-5"/><path d="M15 8h-5"/><path d="M19 17V5a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v12l3-2 2 2 2-2 2 2 2-2z"/></svg>
          Receipts
        </a>
      </nav>
    </div>
    <div class="monitor-outcomes" aria-label="Latest outcomes">
      ${outcomes.map((outcome) => html`
        <div class="monitor-outcome">
          <span>${outcome.label}</span>
          <strong>${outcome.value}</strong>
          <span>${outcome.detail}</span>
        </div>`)}
    </div>
    ${sectionPanel({ title: 'Source health', body: sourceHealthBody(view.sourceHealth) })}
    ${sectionPanel({
      title: 'Opportunity',
      right: pill(view.monitorState === 'ready' ? 'Evidence based' : 'Pending evidence', view.opportunity.tone),
      body: html`<div class="monitor-opportunity">
        <span class="monitor-opportunity-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="17" height="17"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.68.66-1.12 1.18-1.75A6 6 0 1 0 7.73 12.25c.52.62 1 1.07 1.18 1.75"/></svg>
        </span>
        <div><strong>${view.opportunity.title}</strong><p>${view.opportunity.detail}</p></div>
      </div>`,
    })}
    ${sectionPanel({ title: 'Recent runs', body: recentRunsBody(view.recentRuns) })}
  `
}
