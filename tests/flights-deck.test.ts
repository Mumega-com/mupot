// tests/flights-deck.test.ts — Mission Control Flight Deck view layer.
//
// flightsBody / deriveFlightDeckKpis / extractFlightArtifacts are pure. These
// fixtures go through buildBoard so the HTML under test is the same shape GET
// /flights renders.

import { describe, expect, it } from 'vitest'
import { buildBoard } from '../src/flight/board'
import type { FlightRow, FlightStatus } from '../src/flight/service'
import {
  agentPersona,
  deriveFlightDeckKpis,
  extractFlightArtifacts,
  flightBadgeKind,
  flightFilterGroup,
  flightsBody,
  formatFlightClock,
  pipelineStageIndex,
  FLIGHT_DECK_POLL_MS,
  FLIGHT_PIPELINE_STAGES,
} from '../src/dashboard/flights-deck'

const NOW = 1_900_000_000_000

function meta(refs: { artifacts?: string[]; receipts?: string[] }): string {
  return JSON.stringify({
    schema: 'mupot.flight.meta/v1',
    goal_id: 'goal-1',
    objective_id: 'obj-1',
    squad_ids: ['squad-core'],
    task_ids: ['task-1'],
    done_when: ['done'],
    artifact_refs: refs.artifacts ?? [],
    receipt_refs: refs.receipts ?? [],
    confidentiality: 'internal',
    publication_target: 'none',
    parent_flight_id: null,
  })
}

function row(p: Partial<FlightRow> & { agent: string; status: FlightStatus }): FlightRow {
  return {
    id: p.id ?? 'flight-aaaa-bbbb-cccc',
    tenant: 'test',
    project_id: p.project_id ?? null,
    agent: p.agent,
    dispatched_by_agent_id: p.dispatched_by_agent_id ?? p.agent,
    goal: p.goal ?? 'do the thing',
    status: p.status,
    trigger_source: 'manual',
    gate_verdict: null,
    gate_reason: '',
    score: p.score ?? null,
    budget_micro_usd: p.budget_micro_usd ?? null,
    cost_micro_usd: p.cost_micro_usd ?? 0,
    next_run_at: p.next_run_at ?? null,
    created_at: p.created_at ?? NOW - 120_000,
    started_at: p.started_at ?? NOW - 90_000,
    ended_at: p.ended_at ?? null,
    meta: p.meta ?? '{}',
    agent_name: p.agent_name ?? p.agent,
    squad_name: p.squad_name ?? 'Core',
  }
}

async function render(cards = buildBoard([], NOW), project?: { name: string }): Promise<string> {
  return String(
    await flightsBody(
      cards,
      project as never,
      false,
      NOW,
    ),
  )
}

describe('agentPersona', () => {
  it('maps the council seats to their avatars', () => {
    expect(agentPersona('Loom')).toEqual({ emoji: '🧶', label: 'Loom' })
    expect(agentPersona('Kasra')).toEqual({ emoji: '🔨', label: 'Kasra' })
    expect(agentPersona('Athena')).toEqual({ emoji: '🛡️', label: 'Athena' })
    expect(agentPersona('Cursor Architect')).toEqual({ emoji: '☁️', label: 'Cursor Architect' })
    expect(agentPersona('Cursor Builder')).toEqual({ emoji: '⚙️', label: 'Cursor Builder' })
    expect(agentPersona('Scout')).toEqual({ emoji: '✈️', label: 'Scout' })
  })
})

describe('extractFlightArtifacts', () => {
  it('classifies PR, issue, repo, sandbox, and receipt URLs from meta refs', () => {
    const artifacts = extractFlightArtifacts(
      meta({
        artifacts: [
          'https://github.com/Mumega-com/mupot/pull/75',
          'https://github.com/Mumega-com/mupot/issues/61',
          'https://cursor.com/agents/abc',
        ],
        receipts: ['https://pot.test/receipts/flight-75'],
      }),
    )
    expect(artifacts.prUrl).toBe('https://github.com/Mumega-com/mupot/pull/75')
    expect(artifacts.issueUrl).toBe('https://github.com/Mumega-com/mupot/issues/61')
    expect(artifacts.repoLabel).toBe('Mumega-com/mupot')
    expect(artifacts.sandboxUrl).toBe('https://cursor.com/agents/abc')
    expect(artifacts.receiptUrl).toBe('https://pot.test/receipts/flight-75')
  })

  it('ignores javascript: and malformed meta instead of inventing links', () => {
    expect(extractFlightArtifacts('not-json').prUrl).toBeNull()
    expect(extractFlightArtifacts(JSON.stringify({ artifact_refs: ['javascript:alert(1)'] })).prUrl).toBeNull()
    expect(extractFlightArtifacts('{}').repoUrl).toBeNull()
  })
})

describe('pipeline + status grouping', () => {
  it('keeps the six-stage pipeline honest to phase + PR evidence', () => {
    expect(FLIGHT_PIPELINE_STAGES).toEqual(['Plan', 'Sandbox', 'Tests', 'Gate', 'PR', 'Deploy'])
    const pr = { prUrl: 'https://github.com/org/repo/pull/1', sandboxUrl: null, receiptUrl: null, issueUrl: null, repoUrl: null, repoLabel: null }
    const none = { prUrl: null, sandboxUrl: null, receiptUrl: null, issueUrl: null, repoUrl: null, repoLabel: null }
    expect(pipelineStageIndex('preflight', none)).toBe(0)
    expect(pipelineStageIndex('flying', none)).toBe(1)
    expect(pipelineStageIndex('held', none)).toBe(3)
    expect(pipelineStageIndex('landed', none)).toBe(3)
    expect(pipelineStageIndex('landed', pr)).toBe(4)
    expect(pipelineStageIndex('failed', none)).toBe(2)
  })

  it('maps phases onto the four operator badges / filter tabs', () => {
    expect(flightFilterGroup('flying')).toBe('flying')
    expect(flightFilterGroup('preflight')).toBe('flying')
    expect(flightFilterGroup('sleeping')).toBe('flying')
    expect(flightFilterGroup('holding')).toBe('held')
    expect(flightFilterGroup('held')).toBe('held')
    expect(flightFilterGroup('landed')).toBe('landed')
    expect(flightFilterGroup('failed')).toBe('failed')
    expect(flightBadgeKind('flying')).toBe('flying')
    expect(flightBadgeKind('landed')).toBe('landed')
    expect(flightBadgeKind('held')).toBe('held')
    expect(flightBadgeKind('failed')).toBe('failed')
  })
})

describe('deriveFlightDeckKpis', () => {
  it('counts total, active, landed, and PR landing rate from closed flights', () => {
    const cards = buildBoard(
      [
        row({ id: 'f1', agent: 'kasra', agent_name: 'Kasra', status: 'running' }),
        row({
          id: 'f2',
          agent: 'athena',
          agent_name: 'Athena',
          status: 'landed',
          ended_at: NOW - 10_000,
          meta: meta({ artifacts: ['https://github.com/Mumega-com/mupot/pull/75'] }),
        }),
        row({ id: 'f3', agent: 'loom', agent_name: 'Loom', status: 'failed', ended_at: NOW - 20_000 }),
        row({ id: 'f4', agent: 'builder', agent_name: 'Cursor Builder', status: 'held' }),
      ],
      NOW,
    )
    const kpis = deriveFlightDeckKpis(cards)
    expect(kpis.total).toBe(4)
    expect(kpis.active).toBe(1)
    expect(kpis.landed).toBe(1)
    expect(kpis.failed).toBe(1)
    expect(kpis.withPr).toBe(1)
    expect(kpis.prLandingRate).toBe(50)
    expect(kpis.prLandingLabel).toBe('50%')
  })

  it('shows an honest dash when nothing has closed', () => {
    const cards = buildBoard([row({ agent: 'kasra', status: 'running' })], NOW)
    expect(deriveFlightDeckKpis(cards).prLandingLabel).toBe('—')
  })
})

describe('flightsBody — KPI cards, table, badges, artifacts', () => {
  it('renders empty-state KPIs, filter tabs, search, and dispatch chrome', async () => {
    const out = await render()
    expect(out).toContain('Flight Operations')
    expect(out).toContain('Total Flights')
    expect(out).toContain('Active In-Flight')
    expect(out).toContain('Landed / Merged')
    expect(out).toContain('PR Landing Rate')
    expect(out).toContain('data-fd-kpi="total"')
    expect(out).toContain('+ Dispatch Flight')
    expect(out).toContain('id="fd-dispatch-open"')
    expect(out).toContain('id="fd-dispatch"')
    expect(out).toContain('id="fd-repo-select"')
    expect(out).toContain('id="fd-repo-custom-wrap" hidden')
    expect(out).toContain('data-copilot-open')
    expect(out).toContain("event.key !== 'Escape'")
    expect(out).not.toContain('.fd-cell-pipe, .fd-table th:nth-child(3) { display: none; }')
    expect(out).toContain('id="fd-search"')
    expect(out).toContain('Search goal, squad, or agent')
    expect(out).toContain('data-fd-tab="all"')
    expect(out).toContain('🟢 Flying / Running')
    expect(out).toContain('🏁 Landed / Merged')
    expect(out).toContain('⏸️ Held')
    expect(out).toContain('❌ Failed')
    expect(out).toContain('data-fd-poll="12000"')
    expect(out).toContain('No flights yet')
    expect(FLIGHT_DECK_POLL_MS).toBe(12_000)
  })

  it('renders a flying card with radar KPI, pipeline, persona, and timing', async () => {
    const cards = buildBoard(
      [
        row({
          id: 'flight-live-1',
          agent: 'agent-kasra',
          agent_name: 'Kasra',
          squad_name: 'squad-core',
          status: 'running',
          goal: 'Ship the flight deck',
          started_at: NOW - 90_000,
        }),
      ],
      NOW,
    )
    const out = await render(cards)
    expect(out).toContain('data-fd-live="1"')
    expect(out).toContain('fd-radar')
    expect(out).toContain('polling every 12s')
    expect(out).toContain('Ship the flight deck')
    expect(out).toContain('🔨')
    expect(out).toContain('Kasra')
    expect(out).toContain('squad-core')
    expect(out).toContain('fd-badge-flying')
    expect(out).toContain('fd-pulse')
    expect(out).toContain('Plan')
    expect(out).toContain('Sandbox')
    expect(out).toContain('Tests')
    expect(out).toContain('Gate')
    expect(out).toContain('PR')
    expect(out).toContain('Deploy')
    expect(out).toContain(formatFlightClock(NOW - 90_000))
    expect(out).toContain('Started')
    expect(out).toContain('Duration')
    expect(out).toContain('Finished')
    expect(out).toContain('data-fd-filter="flying"')
    expect(out).toContain('data-fd-search=')
  })

  it('renders landed / held / failed badges and clickable PR artifact links', async () => {
    const cards = buildBoard(
      [
        row({
          id: 'landed-1',
          agent: 'loom',
          agent_name: 'Loom',
          status: 'landed',
          goal: 'Land the board PR',
          ended_at: NOW - 5_000,
          meta: meta({
            artifacts: [
              'https://github.com/Mumega-com/mupot/pull/75',
              'https://github.com/Mumega-com/mupot/issues/61',
              'https://cursor.com/agents/sandbox-75',
            ],
            receipts: ['https://pot.test/receipts/landed-1'],
          }),
        }),
        row({
          id: 'held-1',
          agent: 'athena',
          agent_name: 'Athena',
          status: 'held',
          goal: 'Waiting on gate',
        }),
        row({
          id: 'failed-1',
          agent: 'architect',
          agent_name: 'Cursor Architect',
          status: 'failed',
          goal: 'Broke the build',
          ended_at: NOW - 1_000,
        }),
      ],
      NOW,
    )
    const out = await render(cards)
    expect(out).toContain('fd-badge-landed')
    expect(out).toContain('fd-badge-held')
    expect(out).toContain('fd-badge-failed')
    expect(out).toContain('🧶')
    expect(out).toContain('🛡️')
    expect(out).toContain('☁️')
    expect(out).toContain('🌐 View PR')
    expect(out).toContain('href="https://github.com/Mumega-com/mupot/pull/75"')
    expect(out).toContain('☁️ Cloud Sandbox')
    expect(out).toContain('href="https://cursor.com/agents/sandbox-75"')
    expect(out).toContain('📄 Receipt')
    expect(out).toContain('href="https://pot.test/receipts/landed-1"')
    expect(out).toContain('GitHub issue')
    expect(out).toContain('href="https://github.com/Mumega-com/mupot/issues/61"')
    expect(out).toContain('Mumega-com/mupot')
    expect(out).toContain('option value="https://github.com/Mumega-com/mupot"')
    expect(out).not.toContain('<script>alert')
  })

  it('escapes hostile goal text and never turns it into markup', async () => {
    const cards = buildBoard(
      [
        row({
          agent: 'kasra',
          agent_name: 'Kasra',
          status: 'running',
          goal: '<script>alert(1)</script>',
        }),
      ],
      NOW,
    )
    const out = await render(cards)
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(out).not.toContain('<script>alert(1)</script>')
  })
})
