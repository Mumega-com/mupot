// Brief P3 (Hadi 2026-10-29, v0.33 "Proof in" criterion 2) — a landed flight names the
// harness and model that flew it, taken from the executing agent's fleet_agents row.
//
// The four contract points under test:
//   1. A landed flight stores and returns harness + model (server-derived).
//   2. A caller-supplied harness/model NEVER overrides the server-derived values —
//      they may only ride the landing receipt as claimed_* describe-only keys.
//   3. An unknown/odd harness string is accepted as a BOUNDED string (max 64 chars,
//      no control chars) — sanitised, not refused, never fabricated.
//   4. An agent with no fleet_agents row lands with NULL columns and the read seam
//      says 'unknown' — never blank, never invented.
import { describe, expect, it } from 'vitest'

import { flightHarnessDisplay, landGovernedFlight, loadFlightHarness } from '../src/flight/service'
import { systemLandParkedFlight } from '../src/flight/watchdog'
import type { FlightRow } from '../src/flight/service'
import { parseFlightMetaV1 } from '../src/flight/meta'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1 } from './helpers/sqlite-d1'
import type { Env } from '../src/types'

const TENANT = 'mumega'
const FLIGHT = 'flight-harness'
const TASK = 'task-harness'

function meta() {
  const parsed = parseFlightMetaV1({
    schema: 'mupot.flight.meta/v1',
    goal_id: 'g', objective_id: 'o',
    squad_ids: ['squad-core'], task_ids: [TASK],
    done_when: ['done'], artifact_refs: [], receipt_refs: [],
    confidentiality: 'internal', publication_target: 'none', parent_flight_id: null,
  })
  if (!parsed) throw new Error('fixture meta must parse as v1')
  return parsed
}

function fixture(agent = 'agent-1') {
  const harnessDb = createSqliteD1()
  applyAllMigrations(harnessDb.sqlite)
  // Real FKs are ON in this harness, so the squad/agent/task rows the flight references
  // have to actually exist.
  harnessDb.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Dept A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-core', 'dept-a', 'squad-core', 'Core');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status)
      VALUES ('${agent}', 'squad-core', '${agent}', 'Agent One', 'operator', 'test', 'active');
  `)
  const env = { DB: harnessDb.db, TENANT_SLUG: TENANT, LAND_REQUIRES_EVIDENCE: '0' } as unknown as Env
  harnessDb.sqlite.exec(`
    INSERT INTO tasks (id, squad_id, title, status) VALUES ('${TASK}', 'squad-core', 'task', 'done');
  `)
  harnessDb.sqlite.prepare(
    `INSERT INTO flights (id, tenant, agent, goal, status, budget_micro_usd, cost_micro_usd, meta, created_at, started_at)
     VALUES (?, ?, '${agent}', 'goal', 'running', 100000, 0, ?, ?, ?)`,
  ).run(FLIGHT, TENANT, JSON.stringify(meta()), Date.now(), Date.now())
  return { harnessDb, env }
}

function insertFleetRow(env: Env, agent: string, runtime: string, model: string | null) {
  env.DB.prepare(
    `INSERT INTO fleet_agents (agent_id, tenant, runtime, model, status)
     VALUES (?1, ?2, ?3, ?4, 'running')`,
  ).bind(agent, TENANT, runtime, model).run()
}

async function landedRow(env: Env) {
  return env.DB.prepare(
    `SELECT harness, model, status FROM flights WHERE id=?1 AND tenant=?2`,
  ).bind(FLIGHT, TENANT).first<{ harness: string | null; model: string | null; status: string }>()
}

/** Full flight row read straight off the DB — the argument systemLandParkedFlight takes. */
function rawFlightRow(env: Env, id: string) {
  return env.DB.prepare(`SELECT * FROM flights WHERE id = ?1 AND tenant = ?2`)
    .bind(id, TENANT)
    .first<FlightRow>()
}

async function landedReceiptPayload(env: Env) {
  const receipt = await env.DB.prepare(
    `SELECT payload FROM flight_event_outbox WHERE tenant=?1 AND flight_id=?2 AND event_type='flight.landed'`,
  ).bind(TENANT, FLIGHT).first<{ payload: string }>()
  expect(receipt).not.toBeNull()
  return JSON.parse(receipt!.payload) as Record<string, unknown>
}

const LAND_OPTS_BASE = {
  cost_micro_usd: 1, score: 0.5,
  expected_agent: 'agent-1', agent_id: 'agent-1',
  meta: meta(), actor: { kind: 'agent', id: 'agent-1' } as const,
}

describe('P3: a landed flight names harness and model (server-derived)', () => {
  it('stores harness+model from the executing agent fleet row and writes both to the landing receipt', async () => {
    const { env } = fixture()
    insertFleetRow(env, 'agent-1', 'codex-cloud', 'gpt-5.4')

    const result = await landGovernedFlight(env, FLIGHT, { ...LAND_OPTS_BASE, cost_micro_usd: 4200 })
    expect(result).toEqual({ transitioned: true, receipt: true })

    const row = await landedRow(env)
    expect(row?.status).toBe('landed')
    expect(row?.harness).toBe('codex-cloud')
    expect(row?.model).toBe('gpt-5.4')

    const payload = await landedReceiptPayload(env)
    expect(payload.harness).toBe('codex-cloud')
    expect(payload.model).toBe('gpt-5.4')
    // And the read seam names them exactly as stored.
    const rowFull = await env.DB.prepare(`SELECT * FROM flights WHERE id=?1 AND tenant=?2`).bind(FLIGHT, TENANT).first<Record<string, unknown>>()
    expect(flightHarnessDisplay(rowFull as never)).toEqual({ harness: 'codex-cloud', model: 'gpt-5.4' })
  })

  it('ignores a caller-supplied harness/model: server values win, caller values ride only as claimed_* in the receipt', async () => {
    const { env } = fixture()
    insertFleetRow(env, 'agent-1', 'codex-cloud', 'gpt-5.4')

    const result = await landGovernedFlight(env, FLIGHT, {
      ...LAND_OPTS_BASE,
      claimed_harness: 'claude-code-fake',
      claimed_model: 'opus-9-imaginary',
    })
    expect(result).toEqual({ transitioned: true, receipt: true })

    const row = await landedRow(env)
    expect(row?.harness).toBe('codex-cloud')
    expect(row?.model).toBe('gpt-5.4')

    const payload = await landedReceiptPayload(env)
    expect(payload.harness).toBe('codex-cloud')
    expect(payload.model).toBe('gpt-5.4')
    // The claim is recorded as a describe-only audit fact, never as the stored identity.
    expect(payload.claimed_harness).toBe('claude-code-fake')
    expect(payload.claimed_model).toBe('opus-9-imaginary')
  })

  it('accepts an unknown harness as a bounded string: max 64 chars, control chars stripped', async () => {
    const { env } = fixture()
    // mupot#1590 P1-2: the control char must sit INSIDE the first 64 chars, so stripping is
    // load-bearing for the assertion — at index 95 the 64-cut would delete it anyway and stay green.
    const oddHarness = `e\u0007xotic-runtime-${'x'.repeat(60)}-${'pad'.repeat(12)} trailing`
    insertFleetRow(env, 'agent-1', oddHarness, 'weird-model-1')

    const result = await landGovernedFlight(env, FLIGHT, LAND_OPTS_BASE)
    expect(result).toEqual({ transitioned: true, receipt: true })

    const row = await landedRow(env)
    expect(row?.harness).toBeTruthy()
    expect(row!.harness!.length).toBeLessThanOrEqual(64)
    // eslint-disable-next-line no-control-regex
    expect(row!.harness!).not.toMatch(/[\u0000-\u001f\u007f]/)
    expect(row!.harness!.startsWith('exotic-runtime-')).toBe(true)
    expect(row?.model).toBe('weird-model-1')
  })

  it('P1 (mupot#1590): strips C1 NEL, RTL/bidi controls, zero-width and U+2028 like cleanReported does', async () => {
    const { env } = fixture()
    // Only C0/DEL stripping would leave every one of these embedded characters in the row.
    const dirty = 'cod\u0085ex\u202e-hidden\u200b\u2028x'
    insertFleetRow(env, 'agent-1', dirty, 'model\u200e-1')

    const result = await landGovernedFlight(env, FLIGHT, LAND_OPTS_BASE)
    expect(result).toEqual({ transitioned: true, receipt: true })

    const row = await landedRow(env)
    // eslint-disable-next-line no-control-regex
    expect(row?.harness).toBe('codex-hiddenx')
    expect(row?.model).toBe('model-1')
  })

  it('P1 (mupot#1590): model is bounded at 128 like fleet_agents.model and never leaves a lone surrogate at the cut', async () => {
    const { env } = fixture()
    // 128 'm' then a high surrogate would end up the 128th char if the pair split there.
    insertFleetRow(env, 'agent-1', 'codex-cloud', `${'m'.repeat(128)}\ud83d\ude00tail`)

    const result = await landGovernedFlight(env, FLIGHT, LAND_OPTS_BASE)
    expect(result).toEqual({ transitioned: true, receipt: true })

    const row = await landedRow(env)
    expect(row?.model).toBeTruthy()
    expect(row!.model!.length).toBeLessThanOrEqual(128)
    const last = row!.model!.charCodeAt(row!.model!.length - 1)
    expect(last < 0xd800 || last > 0xdbff).toBe(true)
  })

  it('P1 (mupot#1590): harness cut at 64 never ends mid surrogate pair', async () => {
    const { env } = fixture()
    insertFleetRow(env, 'agent-1', `a${'\ud83d\ude00'.repeat(40)}`, 'model-1')

    const result = await landGovernedFlight(env, FLIGHT, LAND_OPTS_BASE)
    expect(result).toEqual({ transitioned: true, receipt: true })

    const row = await landedRow(env)
    expect(row!.harness!.length).toBeLessThanOrEqual(64)
    const last = row!.harness!.charCodeAt(row!.harness!.length - 1)
    expect(last < 0xd800 || last > 0xdbff).toBe(true)
  })

  it('P2 provenance (Codex, mupot#1590): a slug-keyed fleet row is found through readFleetAgentRow, not lost as unknown', async () => {
    const { env } = fixture('agent-slug-id')
    // The daemon reported the agent BY ITS SLUG: a fleet row keyed on the slug, no id-keyed row.
    env.DB.prepare(`UPDATE agents SET slug = 'walker-slug' WHERE id = ?1`).bind('agent-slug-id').run()
    insertFleetRow(env, 'walker-slug', 'herdr-probe', 'glm-1')

    const identity = await loadFlightHarness(env, 'agent-slug-id')
    expect(identity.harness).toBe('herdr-probe')
    expect(identity.model).toBe('glm-1')
  })

  it('P2 (mupot#1590): an ambiguous slug resolves to nothing — refused to guess, never leaks the slug row', async () => {
    // Two agents tenant-wide carry the same slug and a daemon keyed the fleet row by that
    // slug. The exact-id branch finds no row; the slug fallback must refuse (>1 matches)
    // rather than silently read the other agent's harness. Today's naive id-only lookup
    // returns null too — this pins the ambiguity REFUSAL of the fallback access path.
    const { env } = fixture('agent-a1')
    env.DB.prepare(`INSERT INTO agents (id, squad_id, slug, name, role, model, status)
      VALUES ('agent-a2', 'squad-core', 'shared-slug', 'Agent Two', 'operator', 'test', 'active')`).run()
    env.DB.prepare(`UPDATE agents SET slug = 'shared-slug' WHERE id = 'agent-a1'`).run()
    env.DB.prepare(`INSERT INTO fleet_agents (agent_id, tenant, runtime, model, status)
      VALUES ('shared-slug', 'mumega', 'leak-probe-runtime', 'leak-probe-model', 'running')`).run()

    const identity = await loadFlightHarness(env, 'agent-a1')
    expect(identity.harness).toBeNull()
    expect(identity.model).toBeNull()
  })

  it('P1 (mupot#1590): the fleet lookup filters by tenant AND agent — no neighbouring row can supply identity', async () => {
    const { env } = fixture('agent-1')
    // Wrong-tenant row for the SAME agent id: fleet PK is (tenant, agent_id) — must not be read.
    env.DB.prepare(`INSERT INTO fleet_agents (agent_id, tenant, runtime, model, status)
      VALUES ('agent-1', 'other-tenant', 'wrong-tenant-runtime', 'wrong-tenant-model', 'running')`).run()
    // Right tenant, wrong agent: also must not be read.
    env.DB.prepare(`INSERT INTO agents (id, squad_id, slug, name, role, model, status)
      VALUES ('agent-wrong', 'squad-core', 'agent-wrong', 'Wrong', 'operator', 'test', 'active')`).run()
    env.DB.prepare(`INSERT INTO fleet_agents (agent_id, tenant, runtime, model, status)
      VALUES ('agent-wrong', 'mumega', 'wrong-agent-runtime', 'wrong-agent-model', 'running')`).run()
    insertFleetRow(env, 'agent-1', 'codex-cloud', 'gpt-5.4')

    const result = await landGovernedFlight(env, FLIGHT, LAND_OPTS_BASE)
    expect(result).toEqual({ transitioned: true, receipt: true })

    const row = await landedRow(env)
    expect(row?.harness).toBe('codex-cloud')
    expect(row?.model).toBe('gpt-5.4')
  })

  it('P1 (mupot#1590): the watchdog system land writes harness+model from the fleet row — and null without one', async () => {
    // The system land admits only 'waiting' flights and only structurally-complete work:
    // a real gate owner, an approved verdict from a non-assignee principal, evidence in result.
    const { env, harnessDb: db } = fixture('agent-1')
    db.sqlite.exec(`
      UPDATE tasks SET gate_owner = 'gate:kasra',
        result = 'Artifact: artifact.md
SHA256: ${'1'.repeat(64)}'
        WHERE id = '${TASK}'`)
    db.sqlite.exec(`INSERT INTO task_verdicts (id, task_id, verdict, decided_by, decided_at)
      VALUES ('verdict-1', '${TASK}', 'approved', 'gate-holder-1', '2026-10-29T00:00:00Z')`)
    db.sqlite.exec(`UPDATE flights SET status='waiting' WHERE id='${FLIGHT}'`)

    // Without a fleet row: the landing is real, harness/model stay NULL (the warranty is the row).
    const systemLanded = await systemLandParkedFlight(env, (await rawFlightRow(env, FLIGHT)) as FlightRow, Date.now())
    expect(systemLanded).toMatchObject({ landed: true })
    let row = await landedRow(env)
    expect(row?.status).toBe('landed')
    expect(row?.harness).toBeNull()
    expect(row?.model).toBeNull()

    // Park again and add a fleet row: the SAME path now writes both.
    db.sqlite.exec(`UPDATE flights SET status='waiting', harness=NULL, model=NULL WHERE id='${FLIGHT}'`)
    insertFleetRow(env, 'agent-1', 'codex-cloud', 'gpt-5.4')
    const relanded = await systemLandParkedFlight(env, (await rawFlightRow(env, FLIGHT)) as FlightRow, Date.now())
    expect(relanded).toMatchObject({ landed: true })
    row = await landedRow(env)
    expect(row?.harness).toBe('codex-cloud')
    expect(row?.model).toBe('gpt-5.4')
  })

  it('lands an agent with no fleet row with NULL columns and the read seam says unknown — never blank, never invented', async () => {
    const { env } = fixture()
    // No fleet_agents row for agent-1.

    const result = await landGovernedFlight(env, FLIGHT, LAND_OPTS_BASE)
    expect(result).toEqual({ transitioned: true, receipt: true })

    const row = await landedRow(env)
    expect(row?.status).toBe('landed')
    expect(row?.harness).toBeNull()
    expect(row?.model).toBeNull()

    // The receipt records what the row holds (null), and the read seam must SAY
    // unknown rather than pass blank through to a person.
    const payload = await landedReceiptPayload(env)
    expect(payload.harness).toBeNull()
    expect(payload.model).toBeNull()

    const rowFull = await env.DB.prepare(`SELECT * FROM flights WHERE id=?1 AND tenant=?2`).bind(FLIGHT, TENANT).first<Record<string, unknown>>()
    expect(flightHarnessDisplay(rowFull as never)).toEqual({ harness: 'unknown', model: 'unknown' })
  })
})
