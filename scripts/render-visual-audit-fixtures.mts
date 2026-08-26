// scripts/render-visual-audit-fixtures.mts — dump static HTML for visual QA.
import { mkdirSync, writeFileSync } from 'node:fs'
import { html } from 'hono/html'
import { flightsBody } from '../src/dashboard/flights-deck.ts'
import { buildBoard } from '../src/flight/board.ts'
import type { FlightRow, FlightStatus } from '../src/flight/service.ts'
import { projectsPageBody, projectDetailBody } from '../src/dashboard/projects.ts'
import { verificationsBody, athenaGateReceiptsBody } from '../src/dashboard/verifications.ts'
import { copilotPageBody } from '../src/dashboard/copilot.ts'
import { shell } from '../src/dashboard/index.ts'
import type { Env } from '../src/types.ts'

const NOW = 1_900_000_000_000
const outDir = new URL('../reports/visual-audit-fixtures/', import.meta.url)
mkdirSync(outDir, { recursive: true })

const env = { BRAND: 'Mupot', TENANT_SLUG: 'mumega' } as Env

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

async function write(name: string, title: string, body: unknown) {
  const page = String(await shell(env, title, html`${body}`))
  writeFileSync(new URL(name, outDir), page)
}

const flights = buildBoard(
  [
    row({
      id: 'flight-live-1',
      agent: 'kasra',
      agent_name: 'Kasra',
      status: 'running',
      goal: 'Ship the flight deck visual polish',
      meta: meta({ artifacts: ['https://cursor.com/agents/abc'] }),
    }),
    row({
      id: 'flight-landed-1',
      agent: 'loom',
      agent_name: 'Loom',
      status: 'landed',
      ended_at: NOW - 10_000,
      goal: 'Land the board PR',
      meta: meta({
        artifacts: ['https://github.com/Mumega-com/mupot/pull/1212'],
        receipts: ['https://mupot.mumega.com/receipts/flight-1212'],
      }),
    }),
    row({ id: 'flight-held-1', agent: 'athena', agent_name: 'Athena', status: 'held', goal: 'Hold for gate' }),
    row({ id: 'flight-fail-1', agent: 'builder', agent_name: 'Cursor Builder', status: 'failed', ended_at: NOW - 20_000, goal: 'Broken sandbox' }),
  ],
  NOW,
)

const project = {
  id: 'project-worker-alpha',
  slug: 'worker-alpha',
  name: 'Worker Alpha',
  description: 'First customer worker',
  goal: 'Ship the preview canvas',
  status: 'active' as const,
  parent_project_id: null,
  target_date: null,
  created_at: '2026-08-26T00:00:00.000Z',
  updated_at: '2026-08-26T00:00:00.000Z',
  repo_url: 'https://github.com/Mumega-com/mupot',
  worker_name: 'worker-alpha',
  live_url: 'https://worker-alpha.mupot.mumega.com',
  assigned_squad_id: 'squad-cursor',
  deploy_status: 'healthy' as const,
}

await write('copilot.html', 'Co-Pilot', await copilotPageBody())
await write('flights.html', 'Flights', await flightsBody(flights, undefined, false, NOW))
await write(
  'projects.html',
  'Projects',
  await projectsPageBody({
    nodes: [{
      project,
      contextOnly: false,
      metrics: { directSquads: 1, openWork: 2, activeFlights: 1 },
      worker: {
        assignedSquadName: 'squad-cursor',
        recentFlights: [{ id: 'f1', goal: 'Ship contact form', status: 'running' }],
        recentPrs: [{ title: 'Add preview', repo: 'Mumega-com/mupot', pr_number: 1216 }],
      },
      children: [],
    }],
    visibleProjectCount: 1,
    capped: false,
    canManage: true,
    filters: { search: '', status: '' },
  }),
)
await write(
  'project-alpha.html',
  'Worker Alpha',
  await projectDetailBody({
    project,
    parent: null,
    aggregates: { directTasks: 1, directSquads: 1, directFlights: 1 },
    tasks: [],
    squads: [],
    squadsTruncated: false,
    members: [],
    membersTruncated: false,
    situation: {
      health: 'active',
      summary: 'Worker Alpha is healthy and ready for a feature flight.',
      blockers: [],
      pending_reviews: [],
      task_counts: { open: 0, in_progress: 1, review: 0, blocked: 0, done: 0 },
      task_counts_truncated: { open: false, in_progress: false, review: false, blocked: false, done: false },
      active_work_count: 1,
      active_work_count_truncated: false,
      active_flight_count: 1,
      active_flight_count_truncated: false,
      blocker_details_truncated: false,
      pending_review_details_truncated: false,
      snapshot_truncated: false,
      routines: { active_run: null, latest_terminal_run: null, next: null },
      needs_you: { count: 0, highest_priority: null },
      latest_activity: null,
      next_action: { kind: 'dispatch', label: 'Dispatch a feature flight' },
    } as never,
    activity: { rows: [], next_cursor: null },
    evidence: { rows: [], next_cursor: null },
    canManage: true,
    boards: [],
    canManageBoards: false,
    assignedSquadName: 'squad-cursor',
    recentFlights: [{ id: 'f1', goal: 'Ship contact form', status: 'running' }],
    recentPrs: [{ title: 'Add preview', repo: 'Mumega-com/mupot', pr_number: 1216 }],
    deployments: [],
  }),
)
await write(
  'verifications.html',
  'Verifications',
  html`${verificationsBody([
    {
      verdict_id: 'v1',
      task_id: 't1',
      task_title: 'Gate the flight deck',
      squad_name: 'squad-core',
      verdict: 'approved',
      decided_by: 'athena',
      decided_at: '2026-08-26T12:00:00.000Z',
      note: 'Checks clean',
    },
  ])}${athenaGateReceiptsBody([
    {
      id: 'r1',
      repo: 'Mumega-com/mupot',
      pr_number: 1218,
      commit_sha: '702593d24e273dd498c47dc2e5c9d6af4959a861',
      verdict: 'APPROVED',
      checks_json: JSON.stringify([
        { id: 'no_hardcoded_secrets', name: 'No hardcoded secrets', passed: true },
        { id: 'verified_unit_tests', name: 'Verified unit tests', passed: true },
        { id: 'rbac_compliance', name: 'RBAC compliance', passed: true },
        { id: 'schema_backward_compatibility', name: 'Schema backward-compatibility', passed: true },
      ]),
      summary: 'Athena APPROVED GitHub webhook PR gate reviewer',
      created_at: '2026-08-26T12:28:23.000Z',
    },
    {
      id: 'r2',
      repo: 'Mumega-com/mupot',
      pr_number: 42,
      commit_sha: 'deadbeefcafebabe',
      verdict: 'BLOCKED',
      checks_json: JSON.stringify([
        { id: 'no_hardcoded_secrets', name: 'No hardcoded secrets', passed: false },
        { id: 'verified_unit_tests', name: 'Verified unit tests', passed: true },
      ]),
      summary: 'Athena BLOCKED hardcoded secret in added lines',
      created_at: '2026-08-26T11:00:00.000Z',
    },
  ])}`,
)

console.log(`wrote fixtures to ${outDir.pathname}`)
