// tests/mcp-profile-needs-you-no-side-effects.test.ts — round-2 P1 (Athena + kasra-review) for
// PR #1624: the profile advertises readOnlyHint:true, so a call on it must leave NO session side
// effect: no presence bump, no poll-mode last-seen refresh, no fleet self-report, no KV debounce
// key, no audit row — nothing. Proven by snapshotting EVERY table (real migration chain, real
// SQL) plus the KV before/after each of the 8 profile tools, with a bound-agent session.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encryptConnectorSecret } from '../src/connectors/crypto'
import { FakeInternalWiki } from './helpers/fake-internal-wiki'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { mcpApp } from '../src/mcp'
import { AUTH_CONTEXT_HEADER } from '../src/mcp/auth-header'
import { NEEDS_YOU_PROFILE } from '../src/mcp/profile-needs-you'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'mumega'
const MEMBER = 'mem-1'
const AGENT = 'agent-uuid-1'
const SQUAD = 'squad-1'
const PROJECT = 'proj-1'
const STALE = '2026-09-01 00:00:00'

let harness: SqliteD1Harness
let env: Env
let kv: Map<string, string>
let pending: Promise<unknown>[]

beforeEach(async () => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'd', 'D');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD}', 'dept-1', 'squad-one', 'Squad One');
    INSERT INTO agents (id, squad_id, slug, name, status, created_at) VALUES ('${AGENT}', '${SQUAD}', 'poller', 'Poller', 'active', '${STALE}');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('${MEMBER}', 'm@example.test', 'Member', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-1', '${MEMBER}', 'squad', '${SQUAD}', 'member');
    INSERT INTO projects (id, slug, name, status) VALUES ('${PROJECT}', 'proj', 'Project', 'active');
    INSERT INTO tasks (id, squad_id, title, body, done_when, status, gate_owner, assignee_agent_id, result, created_at, updated_at)
      VALUES ('task-1', '${SQUAD}', 'T', 'B', 'D', 'open', NULL, '${AGENT}', NULL, '${STALE}', '${STALE}');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('${PROJECT}', '${SQUAD}', 'write');
    -- A LIVE poll-mode row (running): touchPollFleetPresence skips stopped rows, so a stopped
    -- fixture could never show a task_list last-seen refresh.
    INSERT INTO fleet_agents (agent_id, tenant, display, runtime, model, squads, lifecycle, status, reported_by, agent_type,
                              presence_mode, presence_ttl_sec, last_reported_at, updated_at)
      VALUES ('${AGENT}', '${TENANT}', 'Poller', 'codex', 'orig-model', '[]', 'on_demand', 'running', '${AGENT}', 'generic',
              'poll', 600, '${STALE}', '${STALE}');
  `)
  // project_wiki reads an Inkwell wiki through a service binding: seed a real encrypted
  // connector row + the repo's wiki double so that tool actually succeeds (a refused call
  // proves nothing about side effects).
  const MASTER_KEY = '44'.repeat(32)
  const wiki = new FakeInternalWiki({ [TENANT]: 'wiki-secret' })
  wiki.seed({ tenantSlug: TENANT, project: PROJECT, slug: 'overview', title: 'Overview' })
  const encrypted = await encryptConnectorSecret(MASTER_KEY, 'connector-inkwell', 'inkwell', 'wiki-secret')
  harness.sqlite.exec(
    `INSERT INTO connectors (id, tenant, type, label, encrypted_secret, meta, scope_type, scope_id, created_by, created_at)
     VALUES ('connector-inkwell', '${TENANT}', 'inkwell', 'Inkwell wiki', '${encrypted}', NULL, 'pot', NULL, 'test-setup', '2026-01-01T00:00:00Z')`,
  )
  kv = new Map()
  env = {
    DB: harness.db,
    CONNECTOR_MASTER_KEY: MASTER_KEY,
    INKWELL_API_URL: 'https://inkwell-api.test',
    INKWELL_SVC: wiki.asFetcher(),
    TENANT_SLUG: TENANT,
    BUS: { send: async () => {} },
    SESSIONS: {
      async get(key: string, type?: string) {
        const v = kv.get(key) ?? null
        return type === 'json' && v ? JSON.parse(v) : v
      },
      async put(key: string, value: string) {
        kv.set(key, value)
      },
      async delete(key: string) {
        kv.delete(key)
      },
    },
  } as unknown as Env
  pending = []
})
afterEach(() => harness.close())

const auth: AuthContext = {
  userId: MEMBER, email: 'm@example.test', role: 'member', tenant: TENANT, memberId: MEMBER,
  channel: 'workspace', capabilities: [], boundAgentId: AGENT,
} as AuthContext

/** Every row of every table + the KV, as one comparable string. */
function snapshot(): Record<string, string> {
  const tables = (harness.sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[]).map((t) => t.name)
  const out: Record<string, unknown> = {}
  for (const t of tables) out[t] = harness.sqlite.prepare(`SELECT * FROM "${t}"`).all()
  out.__kv = [...kv.entries()].sort()
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, JSON.stringify(v)]))
}

/** Names of the tables (or __kv) whose contents differ — a compact failure message. */
function changed(before: Record<string, string>, after: Record<string, string>): string[] {
  return Object.keys(after).filter((k) => before[k] !== after[k])
}

async function callOn(path: string, name: string, args: Record<string, unknown>) {
  const executionCtx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext
  const res = await mcpApp.request(
    `https://pot.test${path}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', [AUTH_CONTEXT_HEADER]: JSON.stringify(auth) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    },
    env,
    executionCtx,
  )
  const json = (await res.json()) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any -- test-only probe
  // Presence bumps are fire-and-forget (waitUntil / unawaited): settle them before snapshotting.
  await Promise.allSettled(pending)
  await new Promise((r) => setTimeout(r, 25))
  return { status: res.status, json }
}

const ARGS: Record<string, Record<string, unknown>> = {
  boot_context: {},
  needs_you_list: {},
  orient: {},
  project_get: { project_id: PROJECT },
  project_list: {},
  project_wiki: { project_id: PROJECT },
  task_board: { squad_id: SQUAD },
  task_list: { squad_id: SQUAD },
}

describe('profile mode = no session side effects', () => {
  it('ARGS covers exactly the profile allowlist', () => {
    expect(Object.keys(ARGS).sort()).toEqual(NEEDS_YOU_PROFILE.map((e) => e.name).sort())
  })

  for (const entry of NEEDS_YOU_PROFILE) {
    it(`${entry.name}: succeeds on the profile and changes NO row in ANY table and NO KV key`, async () => {
      const before = snapshot()
      const r = await callOn('/profile/needs-you', entry.name, ARGS[entry.name]!)
      expect(r.status, JSON.stringify(r.json)).toBe(200)
      expect(r.json.result, entry.name).toBeTruthy()
      expect(changed(before, snapshot())).toEqual([])
    })
  }

  it('control: the SAME calls on /mcp DO write (the snapshot can see a session side effect)', async () => {
    // Guards the guard: if this stopped moving, the assertions above would be vacuous.
    const before = snapshot()
    await callOn('/', 'task_list', ARGS.task_list!)
    await callOn('/', 'boot_context', ARGS.boot_context!)
    expect(changed(before, snapshot()).length).toBeGreaterThan(0)
  })
})
