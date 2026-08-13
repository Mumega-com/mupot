// tests/fleet-squad-control.test.ts — squad-scoped fleet control (route + panel).
//
// Extends the Deliverable 2 control plane (see fleet-control-route.test.ts,
// dashboard-fleet-brain-agent-scope.test.ts) to the squad-scoped shape added alongside the
// host's engine.control_squad (agents/fleet-control/engine.py, mumega-com repo):
//
//   POST /api/fleet/control  {squad_id, verb}  — mutually exclusive with {agent_id, verb}
//   POST /fleet/host-control  squad_id=<id>&verb=<v>  — the dashboard "Squad control" panel
//
// Real SQL end-to-end (createSqliteD1 + applyAllMigrations — the #684 ratchet rejects
// hand-built schema / a mock D1 for any NEW test file, scripts/check-test-schema-source.mjs).
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { fleetControlApp } from '../src/fleet/control-routes'
import { verifySquadControlRequest } from '../src/fleet/control-request'
import { dashboardApp } from '../src/dashboard/index'
import { groupBySquad } from '../src/dashboard/fleet-host'
import { listSquadMemberIds, type FleetAgentRuntimeView } from '../src/fleet/registry'
import type { Env } from '../src/types'

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

let panelPrivJwk = ''
let panelPubJwk = ''
const OWNER_TOKEN = 'owner-plaintext-token'
let ownerTokenHash = ''

beforeAll(async () => {
  const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  panelPrivJwk = JSON.stringify(await crypto.subtle.exportKey('jwk', kp.privateKey))
  panelPubJwk = JSON.stringify(await crypto.subtle.exportKey('jwk', kp.publicKey))
  ownerTokenHash = await sha256Hex(OWNER_TOKEN)
})

async function makeHarness(): Promise<SqliteD1Harness> {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-core', 'dept-core', 'Core');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('sq-core', 'dept-core', 'squad-core', 'Squad Core');

    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('m-owner', 'owner@pot.test', 'Owner', 'active', 't');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('cap-owner', 'm-owner', 'org', NULL, 'owner');

    -- The owner's bearer token (API route auth path).
    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, agent_id, tenant, created_at) VALUES
      ('tok-owner', 'm-owner', '${ownerTokenHash}', 'test', 'workspace', NULL, 't', datetime('now'));

    -- fleet_agents.squads is a self-reported JSON array of squad SLUGS — the SAME data
    -- groupBySquad/squadControlPanel group by. 'kasra' and 'river' are in 'squad-core';
    -- 'solo' is in a different squad, so it must never appear in the squad-core group.
    INSERT INTO fleet_agents (agent_id, tenant, display, runtime, squads, lifecycle, status, reported_by, last_reported_at, updated_at) VALUES
      ('kasra', 't', 'Kasra', 'claude-code', '["squad-core"]', 'on_demand', 'running', 'daemon', datetime('now'), datetime('now')),
      ('river', 't', 'River', 'claude-code', '["squad-core"]', 'always_on', 'running', 'daemon', datetime('now'), datetime('now')),
      ('solo', 't', 'Solo', 'tmux', '["other-squad"]', 'always_on', 'stopped', 'daemon', datetime('now'), datetime('now'));
  `)
  return harness
}

function apiEnv(harness: SqliteD1Harness, over: Partial<Env> = {}): Env {
  return {
    TENANT_SLUG: 't',
    DB: harness.db,
    FLEET_PANEL_SK: panelPrivJwk,
    FLEET_CONSUMER_AGENT: 'fleet-consumer',
    ...over,
  } as unknown as Env
}

function sessionRecord(email: string, role: 'owner' | 'admin' | 'member' = 'owner'): string {
  return JSON.stringify({ userId: `u-${email}`, email, role, createdAt: '2026-01-01T00:00:00Z' })
}

function dashboardEnv(harness: SqliteD1Harness, sessions: Record<string, string>): Env {
  return {
    DB: harness.db,
    TENANT_SLUG: 't',
    BRAND: 'Test Pot',
    FLEET_PANEL_SK: panelPrivJwk,
    FLEET_CONSUMER_AGENT: 'fleet-consumer',
    SESSIONS: { get: async (key: string) => sessions[key] ?? null },
    OAUTH_KV: { get: async () => null, put: async () => undefined },
  } as unknown as Env
}

function req(path: string, sessionId: string, init: RequestInit = {}): Request {
  return new Request(`https://pot.test${path}`, {
    ...init,
    headers: { ...init.headers, Cookie: `mupot_session=${sessionId}` },
  })
}

describe('POST /api/fleet/control — squad-scoped shape', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  function post(env: Env, payload: unknown, token: string | null = OWNER_TOKEN) {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (token) headers.authorization = `Bearer ${token}`
    return fleetControlApp.request('/control', { method: 'POST', headers, body: JSON.stringify(payload) }, env)
  }

  it('happy path: emits a verifiable signed SQUAD control-request + audit row', async () => {
    harness = await makeHarness()
    const env = apiEnv(harness)
    const res = await post(env, { squad_id: 'squad-core', verb: 'start' })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean; nonce: string; squad_id: string; verb: string }
    expect(json.ok).toBe(true)
    expect(json.squad_id).toBe('squad-core')

    const msgRow = await harness.db
      .prepare(`SELECT body, kind, from_member FROM agent_messages WHERE tenant = ?1 AND to_agent = ?2`)
      .bind('t', 'fleet-consumer')
      .first<{ body: string; kind: string; from_member: string }>()
    expect(msgRow).toBeTruthy()
    expect(msgRow!.kind).toBe('request')
    expect(msgRow!.from_member).toBe('m-owner')
    const sentReq = JSON.parse(msgRow!.body)
    expect(sentReq).toMatchObject({ squad_id: 'squad-core', verb: 'start', nonce: json.nonce })
    expect(sentReq.agent_id).toBeUndefined() // never carries BOTH selectors
    // THE BLOCK fix: the member set is resolved server-side (never from the client) and bound
    // into the signature — 'kasra' and 'river' are the seeded squad-core members (see makeHarness).
    expect(sentReq.members).toEqual(['kasra', 'river'])
    expect(await verifySquadControlRequest(panelPubJwk, sentReq)).toBe(true)

    const logRow = await harness.db
      .prepare(`SELECT agent_id, squad_id, verb FROM fleet_control_log WHERE tenant = ?1 AND nonce = ?2`)
      .bind('t', json.nonce)
      .first<{ agent_id: string; squad_id: string; verb: string }>()
    expect(logRow).toEqual({ agent_id: '', squad_id: 'squad-core', verb: 'start' })
  })

  it('400 when BOTH agent_id and squad_id are present (ambiguous target)', async () => {
    harness = await makeHarness()
    const res = await post(apiEnv(harness), { agent_id: 'kasra', squad_id: 'squad-core', verb: 'status' })
    expect(res.status).toBe(400)
  })

  it('400 when NEITHER agent_id nor squad_id is present', async () => {
    harness = await makeHarness()
    const res = await post(apiEnv(harness), { verb: 'status' })
    expect(res.status).toBe(400)
  })

  it('400 for a malformed squad_id (signer validation)', async () => {
    harness = await makeHarness()
    const res = await post(apiEnv(harness), { squad_id: '../evil', verb: 'status' })
    expect(res.status).toBe(400)
  })

  it('403 for a non-owner caller (no owner-capability token minted in this harness)', async () => {
    harness = await makeHarness()
    const res = await post(apiEnv(harness), { squad_id: 'squad-core', verb: 'status' }, 'not-a-real-token')
    expect(res.status).toBe(401) // unrecognized token -> unauthorized, not forbidden
  })

  it('503 when FLEET_PANEL_SK is unconfigured (fail-closed) — same as the agent path', async () => {
    harness = await makeHarness()
    const res = await post(apiEnv(harness, { FLEET_PANEL_SK: undefined }), { squad_id: 'squad-core', verb: 'status' })
    expect(res.status).toBe(503)
  })

  it('400 for a squad with no known members (never signs/sends an empty-member request)', async () => {
    harness = await makeHarness()
    const res = await post(apiEnv(harness), { squad_id: 'no-such-squad', verb: 'status' })
    expect(res.status).toBe(400)
    const msgRow = await harness.db
      .prepare(`SELECT COUNT(*) AS n FROM agent_messages WHERE tenant = ?1 AND to_agent = ?2`)
      .bind('t', 'fleet-consumer')
      .first<{ n: number }>()
    expect(msgRow!.n).toBe(0) // nothing sent
  })
})

describe('listSquadMemberIds (pure DB read)', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('returns sorted, deduped agent_ids reporting the given squad', async () => {
    harness = await makeHarness()
    const env = apiEnv(harness)
    expect(await listSquadMemberIds(env, 'squad-core')).toEqual(['kasra', 'river'])
    expect(await listSquadMemberIds(env, 'other-squad')).toEqual(['solo'])
    expect(await listSquadMemberIds(env, 'no-such-squad')).toEqual([])
  })
})

describe('POST /fleet/host-control — squad form field (dashboard panel)', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('owner session: squad_id form field emits a squad control-request and redirects with hc=ok', async () => {
    harness = await makeHarness()
    const env = dashboardEnv(harness, { 'sess:s-owner': sessionRecord('owner@pot.test') })
    const form = new URLSearchParams({ squad_id: 'squad-core', verb: 'start' })
    const res = await dashboardApp.fetch(
      req('/fleet/host-control', 's-owner', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://pot.test' },
        body: form.toString(),
      }),
      env,
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/fleet?hc=ok')

    const msgRow = await harness.db
      .prepare(`SELECT body FROM agent_messages WHERE tenant = ?1 AND to_agent = ?2`)
      .bind('t', 'fleet-consumer')
      .first<{ body: string }>()
    expect(JSON.parse(msgRow!.body)).toMatchObject({ squad_id: 'squad-core', verb: 'start' })
  })

  it('owner session: BOTH agent_id and squad_id present -> 400, not a silent squad-wins pick', async () => {
    harness = await makeHarness()
    const env = dashboardEnv(harness, { 'sess:s-owner': sessionRecord('owner@pot.test') })
    const form = new URLSearchParams({ agent_id: 'kasra', squad_id: 'squad-core', verb: 'start' })
    const res = await dashboardApp.fetch(
      req('/fleet/host-control', 's-owner', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://pot.test' },
        body: form.toString(),
      }),
      env,
    )
    expect(res.status).toBe(400)
    const msgRow = await harness.db
      .prepare(`SELECT COUNT(*) AS n FROM agent_messages WHERE tenant = ?1 AND to_agent = ?2`)
      .bind('t', 'fleet-consumer')
      .first<{ n: number }>()
    expect(msgRow!.n).toBe(0)
  })

  it('non-owner session: 403, no message sent', async () => {
    harness = await makeHarness()
    const env = dashboardEnv(harness, { 'sess:s-member': sessionRecord('member@pot.test', 'member') })
    const form = new URLSearchParams({ squad_id: 'squad-core', verb: 'stop' })
    const res = await dashboardApp.fetch(
      req('/fleet/host-control', 's-member', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://pot.test' },
        body: form.toString(),
      }),
      env,
    )
    expect(res.status).toBe(403)
    const msgRow = await harness.db
      .prepare(`SELECT COUNT(*) AS n FROM agent_messages WHERE tenant = ?1 AND to_agent = ?2`)
      .bind('t', 'fleet-consumer')
      .first<{ n: number }>()
    expect(msgRow!.n).toBe(0)
  })

  it('GET /fleet renders the Squad control panel grouped by squads[], scoped like the roster', async () => {
    harness = await makeHarness()
    const env = dashboardEnv(harness, { 'sess:s-owner': sessionRecord('owner@pot.test') })
    const res = await dashboardApp.fetch(req('/fleet', 's-owner'), env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Squad control')
    expect(body).toContain('squad-core')
    expect(body).toContain('Start squad')
    expect(body).toContain('Stop squad')
    expect(body).toContain('Restart squad')
    // confirm-gate data attributes carry the affected member list
    expect(body).toMatch(/data-squad="squad-core"/)
    expect(body).toMatch(/data-members="[^"]*Kasra[^"]*River[^"]*"/)
  })
})

describe('groupBySquad (pure)', () => {
  function view(agentId: string, squads: string[]): FleetAgentRuntimeView {
    return {
      agent_id: agentId, display: agentId, runtime: 'claude-code', squads,
      status: 'running', presence: 'live', lifecycle: 'on_demand', last_seen: '', host: '',
    }
  }

  it('groups agents by their squads[] membership, sorted by squad_id', () => {
    const groups = groupBySquad([view('a', ['yang']), view('b', ['yang']), view('c', ['yin'])])
    expect(groups.map((g) => g.squad_id)).toEqual(['yang', 'yin'])
    expect(groups[0].members.map((m) => m.agent_id)).toEqual(['a', 'b'])
    expect(groups[1].members.map((m) => m.agent_id)).toEqual(['c'])
  })

  it('an agent in multiple squads appears in every group it belongs to', () => {
    const groups = groupBySquad([view('a', ['yang', 'squad-core']), view('b', ['yin'])])
    expect(groups.map((g) => g.squad_id)).toEqual(['squad-core', 'yang', 'yin'])
    expect(groups.find((g) => g.squad_id === 'yang')!.members.map((m) => m.agent_id)).toEqual(['a'])
    expect(groups.find((g) => g.squad_id === 'squad-core')!.members.map((m) => m.agent_id)).toEqual(['a'])
  })

  it('an agent reporting no squads produces no group', () => {
    expect(groupBySquad([view('a', [])])).toEqual([])
  })

  it('empty roster -> no groups', () => {
    expect(groupBySquad([])).toEqual([])
  })
})
