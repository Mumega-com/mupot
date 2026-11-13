// tests/boundary/fixture.ts — the shared two-customer fixture of the boundary suite.
//
// One pot, two customers that must never see each other:
//   squad A (sq-a)  an attacker agent ag-a, a peer agent ag-a2, a human member mem-a-human
//   squad B (sq-b)  the victim agents ag-b / ag-b2, a human mem-b-human, a project, a task in review,
//                   memory, a message, a flight and a Supabase connector — all carrying the marker
//                   B_SECRET so any leak is one string search.
//   an org admin (mem-admin) and an org owner (mem-owner).
// Nobody on side A holds any grant on squad B, and the reverse. The schema is the whole migration
// chain (applyAllMigrations); every MCP call goes through invokeTool, the chokepoint real callers use.
import { vi } from 'vitest'
import { invokeTool } from '../../src/mcp/index'
import { resolveCapabilities } from '../../src/auth/capability'
import { hashMemberToken } from '../../src/auth/member-bearer'
import { authApp } from '../../src/auth'
import { addConnector } from '../../src/connectors/service'
import type { AuthContext, Env } from '../../src/types'
import { applyAllMigrations } from '../helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from '../helpers/sqlite-d1'

export const TENANT = 'mumega'
export const ORIGIN = 'https://pot.test'
/** Every datum that belongs to customer B carries this string. */
export const B_SECRET = 'B_SECRET'
/** Customer B's Supabase connector: a request carrying this host or key is customer B's credential in use. */
export const B_SUPABASE_HOST = 'b-secret.supabase.co'
export const B_SUPABASE_KEY = 'B_SECRET-SERVICE-ROLE-KEY'

export const RAW = {
  agentA: 'raw-token-agent-a',
  agentA2: 'raw-token-agent-a2',
  humanA: 'raw-token-human-a',
  agentB: 'raw-token-agent-b',
  admin: 'raw-token-admin',
  zero: 'raw-token-zero-grants',
} as const

export interface Boundary {
  h: SqliteD1Harness
  env: Env
  /** Messages the tools put on the bus. */
  bus: unknown[]
  /** Sign a persona in through the real email one-time-code door; returns a session cookie. */
  signIn(email: string): Promise<string>
  /** AuthContext for an agent-bound caller, built the way the bearer path builds it. */
  agent(agentId: string, memberId: string): Promise<AuthContext>
  /** AuthContext for a human member (no agent weld). */
  human(memberId: string, role?: AuthContext['role']): Promise<AuthContext>
  /** invokeTool, with the JSON round-trip the wire applies. */
  call(auth: AuthContext, tool: string, args?: Record<string, unknown>): Promise<ToolResult>
  /** Read rows straight from the migrated database (assertions only). */
  all(sql: string, ...values: unknown[]): Array<Record<string, unknown>>
  /** `SELECT COUNT(*) n ...` as a number. */
  count(sql: string, ...values: unknown[]): number
  /** The attacker: customer A's agent. */
  attacker(): Promise<AuthContext>
  close(): void
}

export interface ToolResult {
  ok: boolean
  status?: number
  error?: string
  result?: unknown
  [k: string]: unknown
}

function memoryKv() {
  const store = new Map<string, string>()
  return {
    store,
    async get(k: string, t?: string) {
      const v = store.get(k)
      return v === undefined ? null : t === 'json' ? JSON.parse(v) : v
    },
    async put(k: string, v: string) { store.set(k, v) },
    async delete(k: string) { store.delete(k) },
    async list() { return { keys: [], list_complete: true } },
  }
}

export async function buildBoundary(extraEnv: Record<string, unknown> = {}): Promise<Boundary> {
  const h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  const bus: unknown[] = []
  // The production flags the reviewers ran under (seat/VIP/doorbell/sudo lanes all live).
  const env = {
    DB: h.db, TENANT_SLUG: TENANT, OWNER_TENANT_SLUG: TENANT, BRAND: 'Test Pot', PUBLIC_ORIGIN: ORIGIN,
    OAUTH_CLIENT_ID: 'x.apps.googleusercontent.com', OAUTH_CLIENT_SECRET: 's',
    EMAIL_LOGIN_ENABLED: 'true', EMAIL_PROVIDER: 'console',
    SESSIONS: memoryKv(),
    OAUTH_KV: { get: async () => null, put: async () => undefined },
    BUS: { send: async (e: unknown) => { bus.push(e) } },
    VEC: { upsert: async () => ({}), query: async () => ({ matches: [] }) },
    AI: { run: async () => ({ data: [[0, 0, 0]] }) },
    AGENT: {
      idFromName: (n: string) => n,
      get: () => ({ fetch: async () => new Response(JSON.stringify({ cycles: 0 }), { headers: { 'content-type': 'application/json' } }) }),
    },
    CONNECTOR_MASTER_KEY: 'f'.repeat(64),
    SEAT_AUTO_ENROLL: '1', SEAT_ATTACH: '1', SEAT_ATTACH_DESIGNATED: '1', VIP_LANE: '1', WEBHOOK_DOORBELL: '1',
    OWNER_SUDO_ENABLED: '1', EVENTS_ENABLED: 'true', TASK_ARCHIVE_ENABLED: '1', REALTIME_SEAT_EVENTS: '1',
    ...extraEnv,
  } as unknown as Env

  const tok = Object.fromEntries(
    await Promise.all(Object.entries(RAW).map(async ([k, v]) => [k, await hashMemberToken(v)] as const)),
  ) as Record<keyof typeof RAW, string>
  const far = '2099-01-01T00:00:00.000Z'

  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a','dept-a','Customer A'),('dept-b','dept-b','Customer B');
    INSERT INTO squads (id, department_id, slug, name, charter, kind) VALUES
      ('sq-a','dept-a','cust-a','Customer A','charter-a','work'),
      ('sq-b','dept-b','cust-b','Customer B Squad ${B_SECRET}','${B_SECRET}-CHARTER','work');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('mem-owner','owner@x.test','Org Owner','active','${TENANT}'),
      ('mem-admin','admin@x.test','Org Admin','active','${TENANT}'),
      ('mem-a-agent',NULL,'a-bot','active','${TENANT}'),
      ('mem-a-agent2',NULL,'a-bot2','active','${TENANT}'),
      ('mem-a-human','alice@a.test','Alice A','active','${TENANT}'),
      ('mem-b-agent',NULL,'b-bot','active','${TENANT}'),
      ('mem-b-agent2',NULL,'b-bot2','active','${TENANT}'),
      ('mem-b-human','bob@b.test','Bob ${B_SECRET}','active','${TENANT}'),
      ('mem-zero','zero@x.test','Zero Grants','active','${TENANT}'),
      ('mem-a-web','web@a.test','Web A','active','${TENANT}'),
      ('mem-admin-web','adminweb@x.test','Org Admin (web)','active','${TENANT}');
    INSERT INTO agents (id, squad_id, slug, name, role, purpose, owner_member_id, status) VALUES
      ('ag-a','sq-a','a-bot','Zed A Bot','worker','a purpose',NULL,'active'),
      ('ag-a2','sq-a','a-bot2','Zed A Bot 2','worker','a2 purpose',NULL,'active'),
      ('ag-b','sq-b','b-bot','B Bot ${B_SECRET}','worker','${B_SECRET}-PURPOSE','mem-b-human','active'),
      ('ag-b2','sq-b','b-bot2','B Bot 2','worker','b2 purpose',NULL,'active');
    INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES
      ('ms-a','ag-a','sq-a','member'),('ms-a2','ag-a2','sq-a','member'),
      ('ms-b','ag-b','sq-b','member'),('ms-b2','ag-b2','sq-b','member');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES
      ('${TENANT}','ag-a','mem-a-agent','2026-11-01'),('${TENANT}','ag-a2','mem-a-agent2','2026-11-01'),
      ('${TENANT}','ag-b','mem-b-agent','2026-11-01'),('${TENANT}','ag-b2','mem-b-agent2','2026-11-01');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('c-owner','mem-owner','org',NULL,'owner'),
      ('c-admin','mem-admin','org',NULL,'admin'),
      ('c-a','mem-a-agent','squad','sq-a','member'),
      ('c-a2','mem-a-agent2','squad','sq-a','member'),
      ('c-ah','mem-a-human','squad','sq-a','member'),
      ('c-b','mem-b-agent','squad','sq-b','member'),
      ('c-b2','mem-b-agent2','squad','sq-b','member'),
      ('c-bh','mem-b-human','squad','sq-b','member'),
      ('c-aw','mem-a-web','squad','sq-a','member'),
      ('c-adw','mem-admin-web','org',NULL,'admin');
    INSERT INTO member_tokens (id, member_id, agent_id, tenant, channel, token_hash, label, expires_at) VALUES
      ('tok-a','mem-a-agent','ag-a','${TENANT}','workspace','${tok.agentA}','a','${far}'),
      ('tok-a2','mem-a-agent2','ag-a2','${TENANT}','workspace','${tok.agentA2}','a2','${far}'),
      ('tok-ah','mem-a-human',NULL,'${TENANT}','workspace','${tok.humanA}','ah','${far}'),
      ('tok-b','mem-b-agent','ag-b','${TENANT}','workspace','${tok.agentB}','b','${far}'),
      ('tok-admin','mem-admin',NULL,'${TENANT}','workspace','${tok.admin}','admin','${far}'),
      ('tok-zero','mem-zero',NULL,'${TENANT}','workspace','${tok.zero}','zero','${far}');
    INSERT INTO projects (id, slug, name, description, goal, status) VALUES
      ('p-a','proj-a','Project A','a desc','a goal','active'),
      ('p-b','proj-b','Project B ${B_SECRET}','${B_SECRET}-PROJECT-DESC','${B_SECRET}-GOAL','active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('p-a','sq-a','write'),('p-b','sq-b','write');
    INSERT INTO tasks (id, squad_id, project_id, title, body, done_when, status, assignee_agent_id, result, gate_owner) VALUES
      ('t-b','sq-b','p-b','${B_SECRET}-TASK-TITLE','${B_SECRET}-TASK-BODY','done','review','ag-b','${B_SECRET}-RESULT','gate:bob'),
      ('t-b-open','sq-b','p-b','${B_SECRET}-TASK2-TITLE','${B_SECRET}-TASK2-BODY','done','open','ag-b',NULL,NULL),
      ('t-a','sq-a','p-a','a task','a body','done','open','ag-a',NULL,NULL);
    INSERT INTO engrams (id, agent_id, text) VALUES
      ('e-proj','project:p-b','${B_SECRET}-PROJMEM'),
      ('e-squad','squad:sq-b','${B_SECRET}-SQUADMEM'),
      ('e-member','member:mem-b-agent','${B_SECRET}-AGENTMEM');
    INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, kind, body) VALUES
      ('msg-b','${TENANT}','ag-b','ag-b2','mem-b-agent2','message','${B_SECRET}-MSG');
    INSERT INTO flights (id, tenant, agent, goal, status, meta, project_id, dispatched_by_agent_id) VALUES
      ('f-b','${TENANT}','ag-b','${B_SECRET}-FLIGHT-GOAL','running','{"v":1,"squad_ids":["sq-b"]}','p-b','ag-b');
  `)

  const seeded = await addConnector(env, {
    type: 'supabase', label: 'b db', secret: JSON.stringify({ url: `https://${B_SUPABASE_HOST}`, apiKey: B_SUPABASE_KEY }),
    scope_type: 'squad', scope_id: 'sq-b', created_by: 'mem-owner',
  })
  if (!seeded.ok) throw new Error(`connector seed failed: ${seeded.error}`)

  const bound = async (agentId: string, memberId: string): Promise<AuthContext> => ({
    userId: memberId, memberId, email: null, role: 'member', tenant: TENANT, channel: 'workspace',
    capabilities: await resolveCapabilities(env, memberId), boundAgentId: agentId, tokenId: `tok-${agentId}`,
  })
  const human = async (memberId: string, role: AuthContext['role'] = 'member'): Promise<AuthContext> => ({
    userId: memberId, memberId, email: null, role, tenant: TENANT, channel: 'workspace',
    capabilities: await resolveCapabilities(env, memberId), boundAgentId: null,
  })
  const ctx = { origin: ORIGIN, transport: 'mcp' as const }
  const execCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

  const signIn = async (email: string): Promise<string> => {
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')) })
    const pending: Promise<unknown>[] = []
    const deferred = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext
    const start = await authApp.fetch(new Request(`${ORIGIN}/email/start`, {
      method: 'POST', headers: { 'content-type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ email }),
    }), env, deferred)
    await Promise.all(pending)
    spy.mockRestore()
    if (start.status !== 200) throw new Error(`email/start ${start.status}`)
    const code = /Or enter this code: (\d{6})/.exec(lines[lines.length - 1] ?? '')?.[1]
    if (!code) throw new Error('no sign-in code was sent')
    const verify = await authApp.fetch(new Request(`${ORIGIN}/email/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ email, code }),
    }), env, execCtx)
    const m = /mupot_session=([^;]+)/.exec(verify.headers.get('set-cookie') ?? '')
    if (!m) throw new Error(`no session cookie (verify ${verify.status} ${await verify.clone().text()})`)
    return `mupot_session=${m[1]}`
  }

  return {
    h, env, bus, signIn,
    agent: bound, human,
    call: async (auth, tool, args = {}) => JSON.parse(JSON.stringify(await invokeTool(auth, env, tool, args, ctx))) as ToolResult,
    all: (sql, ...values) => h.sqlite.prepare(sql).all(...values),
    count: (sql, ...values) => Number((h.sqlite.prepare(sql).get(...values) as { n: number | bigint }).n),
    attacker: () => bound('ag-a', 'mem-a-agent'),
    close: () => h.close(),
  }
}

/** True when any part of `value` mentions customer B's marker. */
export function leaksB(value: unknown): boolean {
  return JSON.stringify(value ?? null).includes(B_SECRET)
}

export const bearer = (raw: string): Record<string, string> => ({
  authorization: `Bearer ${raw}`, 'content-type': 'application/json',
})

export const RAW_STRANGER = 'raw-token-stranger'

export interface Stranger { member: AuthContext; agent: AuthContext; agentId: string }

/**
 * A brand-new person who walks in through bootstrap_self (an unbound directory-channel session with no
 * grants). Returns that session, and the agent it minted, both as the live grants resolve after the call.
 */
export async function bootstrapStranger(b: Boundary, opts: { apiKey?: boolean } = {}): Promise<Stranger> {
  const memberId = 'mem-stranger'
  b.h.sqlite.exec(`INSERT INTO members (id, email, display_name, status, created_at, tenant)
    VALUES ('${memberId}','stranger@x.test','Stranger','active','2026-11-12T00:00:00.000Z','${TENANT}')`)
  const session = (caps: AuthContext['capabilities']): AuthContext => ({
    userId: memberId, memberId, email: 'stranger@x.test', role: 'member', tenant: TENANT, channel: 'directory',
    capabilities: caps, boundAgentId: null,
  })
  const out = await b.call(session([]), 'bootstrap_self', { agent_name: 'Stranger Bot' })
  if (!out.ok) throw new Error(`bootstrap_self failed: ${JSON.stringify(out)}`)
  // The stranger's ordinary API key (an unbound workspace token), for the HTTP surfaces.
  // (a member holding a bearer cannot also use the email door: the identity-attach guard refuses it)
  if (opts.apiKey) b.h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, agent_id, tenant, channel, token_hash, label, expires_at)
    VALUES ('tok-stranger','${memberId}',NULL,'${TENANT}','workspace','${await hashMemberToken(RAW_STRANGER)}','stranger','2099-01-01T00:00:00.000Z')`)
  const agent = b.h.sqlite.prepare(`SELECT id FROM agents WHERE name = 'Stranger Bot'`).get() as { id: string } | undefined
  if (!agent) throw new Error('bootstrap_self minted no agent')
  const binding = b.h.sqlite.prepare(`SELECT member_id AS m FROM agent_member_bindings WHERE agent_id = ?`).get(agent.id) as { m: string } | undefined
  const agentMember = binding?.m ?? memberId
  return {
    member: session(await resolveCapabilities(b.env, memberId)),
    agent: await b.agent(agent.id, agentMember),
    agentId: agent.id,
  }
}

/** Everything customer B owns, serialised. A write by anyone else changes this string. */
export function snapshotB(b: Boundary): string {
  const q = (sql: string): unknown => b.all(sql)
  return JSON.stringify([
    q(`SELECT * FROM tasks WHERE squad_id = 'sq-b' ORDER BY id`),
    q(`SELECT * FROM task_verdicts WHERE task_id LIKE 't-b%' ORDER BY id`),
    q(`SELECT * FROM engrams WHERE id IN ('e-proj','e-squad','e-member') OR text LIKE '%${B_SECRET}%' ORDER BY id`),
    q(`SELECT id, to_agent, from_agent, body FROM agent_messages WHERE to_agent LIKE 'ag-b%' OR from_agent LIKE 'ag-b%' ORDER BY id`),
    q(`SELECT * FROM flights WHERE agent LIKE 'ag-b%' OR project_id = 'p-b' ORDER BY id`),
    q(`SELECT * FROM agents WHERE squad_id = 'sq-b' ORDER BY id`),
    q(`SELECT * FROM squads WHERE id = 'sq-b'`),
    q(`SELECT * FROM memberships WHERE squad_id = 'sq-b' ORDER BY id`),
    q(`SELECT * FROM capabilities WHERE member_id LIKE 'mem-b-%' OR scope_id = 'sq-b' ORDER BY id`),
    q(`SELECT id, member_id, agent_id, revoked_at FROM member_tokens WHERE member_id LIKE 'mem-b-%' ORDER BY id`),
    q(`SELECT * FROM members WHERE id LIKE 'mem-b-%' ORDER BY id`),
    q(`SELECT * FROM projects WHERE id = 'p-b'`),
    q(`SELECT * FROM project_squad_access WHERE project_id = 'p-b' OR squad_id = 'sq-b' ORDER BY project_id, squad_id`),
    q(`SELECT * FROM connectors WHERE scope_id = 'sq-b' ORDER BY id`),
  ])
}
