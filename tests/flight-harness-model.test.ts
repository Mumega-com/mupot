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

import {
  flightHarnessDisplay, landGovernedFlight, loadFlightHarness,
  sanitizeBoundedFlightText, FLIGHT_MODEL_MAX_LEN,
} from '../src/flight/service'
import { systemLandParkedFlight } from '../src/flight/watchdog'
import type { FlightRow } from '../src/flight/service'
import { parseFlightMetaV1 } from '../src/flight/meta'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1 } from './helpers/sqlite-d1'
import type { Env } from '../src/types'
import { fleetAttachApp } from '../src/fleet/attach-routes'
import { signedAttach } from '../fleet-runtime/fleet-sign.mjs'

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

async function insertFleetRow(env: Env, agent: string, runtime: string, model: string | null) {
  // mupot#1590 gate round 2: EVERY .run() off the async D1 wrapper is awaited — an
  // unawaited run() escapes as an unhandled rejection (gate-2270-a/b: vitest exit 1).
  await env.DB.prepare(
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
  it('P3b: the real host signer reports model through signed attach into the flight landing receipt', async () => {
    const { env, harnessDb } = fixture()
    try {
      const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair
      const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
      harnessDb.sqlite.exec(`
        INSERT INTO members (id, display_name, tenant, status) VALUES ('m-signed', 'Signed runner', '${TENANT}', 'active');
        INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
          VALUES ('${TENANT}', 'agent-1', 'm-signed', datetime('now'));
      `)
      harnessDb.sqlite.prepare(`INSERT INTO agent_keys (tenant, agent_id, pubkey, algo, member_id, created_at)
        VALUES (?, ?, ?, 'Ed25519', ?, ?)`).run(TENANT, 'agent-1', jwk.x!, 'm-signed', Math.floor(Date.now() / 1000))
      const attached = await signedAttach('https://pot.example.com', 'agent-1', {
        tenant: TENANT, runtime: 'claude-code', model: 'claude-opus-4-6', privKey: pair.privateKey,
        fetchImpl: async (_url: string, init: RequestInit) => fleetAttachApp.request('/attach-signed', init, env),
      })
      expect(attached.ok).toBe(true)
      expect(attached.json.report).toMatchObject({ model: 'claude-opus-4-6', reported_by: 'm-signed', signed: true })
      expect(await landGovernedFlight(env, FLIGHT, LAND_OPTS_BASE)).toEqual({ transitioned: true, receipt: true })
      expect(await landedRow(env)).toMatchObject({ status: 'landed', harness: 'claude-code', model: 'claude-opus-4-6' })
      expect(await landedReceiptPayload(env)).toMatchObject({ harness: 'claude-code', model: 'claude-opus-4-6' })
    } finally {
      harnessDb.close()
    }
  })

  it('stores harness+model from the executing agent fleet row and writes both to the landing receipt', async () => {
    const { env } = fixture()
    await insertFleetRow(env, 'agent-1', 'codex-cloud', 'gpt-5.4')

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
    await insertFleetRow(env, 'agent-1', 'codex-cloud', 'gpt-5.4')

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
    await insertFleetRow(env, 'agent-1', oddHarness, 'weird-model-1')

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
    await insertFleetRow(env, 'agent-1', dirty, 'model\u200e-1')

    const result = await landGovernedFlight(env, FLIGHT, LAND_OPTS_BASE)
    expect(result).toEqual({ transitioned: true, receipt: true })

    const row = await landedRow(env)
    // eslint-disable-next-line no-control-regex
    expect(row?.harness).toBe('codex-hiddenx')
    expect(row?.model).toBe('model-1')
  })

  it('P1 (mupot#1590): the model bound is exactly 128 — a longer model stores precisely its first 128 chars', async () => {
    const { env } = fixture()
    // M4 (gate-2270): the bound back at 64 must NOT survive — assert exact equality.
    await insertFleetRow(env, 'agent-1', 'codex-cloud', 'm'.repeat(140))

    const result = await landGovernedFlight(env, FLIGHT, LAND_OPTS_BASE)
    expect(result).toEqual({ transitioned: true, receipt: true })

    const row = await landedRow(env)
    expect(row?.model).toBe('m'.repeat(128))
    // Direct on the loader too — no sqlite round-trip can mask a weak cut.
    expect((await loadFlightHarness(env, 'agent-1')).model).toBe('m'.repeat(128))
  })

  it('P1 (mupot#1590): a pair that ends exactly at the 128 cut survives whole — assert on the returned value', async () => {
    const { env } = fixture()
    // The pair occupies units 126-127 (0-based): the 128-cut lands exactly after it.
    await insertFleetRow(env, 'agent-1', 'codex-cloud', `${'x'.repeat(126)}\ud83d\ude00zzzzz`)

    const result = await landGovernedFlight(env, FLIGHT, LAND_OPTS_BASE)
    expect(result).toEqual({ transitioned: true, receipt: true })

    const row = await landedRow(env)
    expect(row?.model).toBe(`${'x'.repeat(126)}\ud83d\ude00`)
    expect(row!.model!.length).toBe(128)
  })

  it('P1 (mupot#1590): the lone-surrogate guard is witnessed on RETURN values, not a sqlite round-trip', async () => {
    // M3 (gate-2270-b): node:sqlite maps a stored lone high surrogate to U+FFFD, so a
    // read-back assertion passes either way. Assert on what the sanitizer/loader RETURN.
    const { env } = fixture()
    // The pair straddles the cut: unit 127 is the HIGH surrogate, 128 the low one.
    const splitModel = `${'y'.repeat(127)}\ud83d\ude00tail`
    await insertFleetRow(env, 'agent-1', 'codex-cloud', splitModel)

    const identity = await loadFlightHarness(env, 'agent-1')
    expect(identity.model).toBe('y'.repeat(127))
    expect(identity.model!.length).toBe(127)
    const lastChar = identity.model!.charCodeAt(identity.model!.length - 1)
    expect(lastChar < 0xd800 || lastChar > 0xdbff).toBe(true)

    const directHarness = sanitizeBoundedFlightText(`${'a'.repeat(127)}\ud83d\ude00tail`, 128)
    expect(directHarness).toBe('a'.repeat(127))
    const directModel = sanitizeBoundedFlightText(`${'b'.repeat(127)}\ud83d\ude00tail`, FLIGHT_MODEL_MAX_LEN)
    expect(directModel).toBe('b'.repeat(127))
  })

  it('P2 provenance (Codex, mupot#1590): a slug-keyed fleet row is found through readFleetAgentRow, not lost as unknown', async () => {
    const { env } = fixture('agent-slug-id')
    // The daemon reported the agent BY ITS SLUG: a fleet row keyed on the slug, no id-keyed row.
    env.DB.prepare(`UPDATE agents SET slug = 'walker-slug' WHERE id = ?1`).bind('agent-slug-id').run()
    await insertFleetRow(env, 'walker-slug', 'herdr-probe', 'glm-1')

    const identity = await loadFlightHarness(env, 'agent-slug-id')
    expect(identity.harness).toBe('herdr-probe')
    expect(identity.model).toBe('glm-1')
  })

  it('P2 (mupot#1590): an ambiguous slug resolves to nothing — refused to guess, never leaks the slug row', async () => {
    // Two agents tenant-wide carry the same slug and a daemon keyed the fleet row by that
    // slug. The exact-id branch finds no row; the slug fallback must refuse (>1 matches)
    // rather than silently read the other agent's harness.
    // gate-2270 a/b: agent-a2 sits in a SECOND squad (agents.slug is UNIQUE per squad),
    // and every .run() is awaited — the unawaited UNIQUE-violation was CI red round 1.
    const { env } = fixture('agent-a1')
    await env.DB.prepare(`INSERT INTO departments (id, slug, name) VALUES ('dept-b', 'dept-b', 'Dept B')`).run()
    await env.DB.prepare(`INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-b', 'dept-b', 'squad-b', 'Squad B')`).run()
    await env.DB.prepare(`UPDATE agents SET slug = 'shared-slug' WHERE id = 'agent-a1'`).run()
    await env.DB.prepare(`INSERT INTO agents (id, squad_id, slug, name, role, model, status)
      VALUES ('agent-a2', 'squad-b', 'shared-slug', 'Agent Two', 'operator', 'test', 'active')`).run()
    await env.DB.prepare(`INSERT INTO fleet_agents (agent_id, tenant, runtime, model, status)
      VALUES ('shared-slug', 'mumega', 'leak-probe-runtime', 'leak-probe-model', 'running')`).run()

    const identity = await loadFlightHarness(env, 'agent-a1')
    expect(identity.harness).toBeNull()
    expect(identity.model).toBeNull()
  })

  it('P1 (mupot#1590): the fleet lookup filters by tenant AND agent — no neighbouring row can supply identity', async () => {
    const { env } = fixture('agent-1')
    // gate-2270-a P2: the neighbours must resist whatever row the PK index reaches first,
    // so they are named to sort BEFORE the right row ('aaa-' tenant, 'agent-0wrong' id).
    // Dropping either filter then returns a neighbour first and fails loudly, independent
    // of insertion order.
    await env.DB.prepare(`INSERT INTO fleet_agents (agent_id, tenant, runtime, model, status)
      VALUES ('agent-1', 'aaa-wrong-tenant', 'wrong-tenant-runtime', 'wrong-tenant-model', 'running')`).run()
    await env.DB.prepare(`INSERT INTO agents (id, squad_id, slug, name, role, model, status)
      VALUES ('agent-0wrong', 'squad-core', 'agent-0wrong', 'Wrong', 'operator', 'test', 'active')`).run()
    await env.DB.prepare(`INSERT INTO fleet_agents (agent_id, tenant, runtime, model, status)
      VALUES ('agent-0wrong', 'mumega', 'wrong-agent-runtime', 'wrong-agent-model', 'running')`).run()
    await insertFleetRow(env, 'agent-1', 'codex-cloud', 'gpt-5.4')

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
    await insertFleetRow(env, 'agent-1', 'codex-cloud', 'gpt-5.4')
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
