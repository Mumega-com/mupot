// Tests for the Linear ↔ pot bridge (src/integrations/linear-issues.ts, flight-20260803).
//
// Coverage maps to the flight's binding requirements:
//   (a) tenant isolation — tenant A cannot resolve tenant B's connector
//   (b) missing/revoked credential fails CLOSED with a typed reason, never a silent
//       skip and never an env fallback (there is no env-fallback path in this file)
//   (c) no code path reaches an agent-dispatch or task-authorizing surface — proven
//       both behaviorally (DB assertions) and structurally (source-text assertions,
//       so a future edit that reintroduces an assignee-resolution mechanism fails
//       this test even before it fails a behavioral one)

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { encryptConnectorSecret } from '../src/connectors/crypto'
import {
  defaultSquadIdFromMeta,
  fetchLinearIssues,
  importLinearIssues,
  parseLinearIssues,
  LINEAR_ISSUES_QUERY,
} from '../src/integrations/linear-issues'
// PR #659 P0 fix: end-to-end property test drives the REAL execute path
// (runTaskExecution -> canAgentExecuteTask) against a Linear-imported task.
import { runTaskExecution } from '../src/agents/execute'
import type { Env, ModelPort } from '../src/types'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const MASTER_KEY = '11'.repeat(32)
const TENANT = 'tenant-a'

function applyAllMigrations(harness: SqliteD1Harness): void {
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
}

function makeKv() {
  const store = new Map<string, string>()
  return {
    async get(k: string) { return store.get(k) ?? null },
    async put(k: string, v: string) { store.set(k, v) },
    store,
  }
}

async function makeHarness(opts: { defaultSquadId?: string | null } = {}) {
  const harness = createSqliteD1()
  applyAllMigrations(harness)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'squad-a', 'Squad A');
    INSERT INTO agents (id, squad_id, slug, name) VALUES ('agent-kasra', 'squad-a', 'kasra', 'Kasra');
    INSERT INTO projects (id, slug, name, status) VALUES ('proj-1', 'proj-1', 'Proj 1', 'active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('proj-1', 'squad-a', 'write');
  `)

  const connectorId = 'connector-linear-1'
  const secret = 'lin_api_super_secret_key'
  const encrypted = await encryptConnectorSecret(MASTER_KEY, connectorId, 'linear', secret)
  harness.sqlite.exec(
    `INSERT INTO connectors (id, tenant, type, label, encrypted_secret, meta, scope_type, scope_id, created_by, created_at)
     VALUES ('${connectorId}', '${TENANT}', 'linear', 'Linear', '${encrypted}', NULL, 'pot', NULL, 'admin-1', datetime('now'));`,
  )
  // A connector belonging to a DIFFERENT tenant, same type — tenant-isolation fixture.
  const otherEncrypted = await encryptConnectorSecret(MASTER_KEY, 'connector-linear-other', 'linear', 'other-tenant-secret')
  harness.sqlite.exec(
    `INSERT INTO connectors (id, tenant, type, label, encrypted_secret, meta, scope_type, scope_id, created_by, created_at)
     VALUES ('connector-linear-other', 'tenant-b', 'linear', 'Linear', '${otherEncrypted}', NULL, 'pot', NULL, 'admin-1', datetime('now'));`,
  )
  // A revoked connector.
  const revokedEncrypted = await encryptConnectorSecret(MASTER_KEY, 'connector-linear-revoked', 'linear', 'revoked-secret')
  harness.sqlite.exec(
    `INSERT INTO connectors (id, tenant, type, label, encrypted_secret, meta, scope_type, scope_id, created_by, created_at, revoked_at)
     VALUES ('connector-linear-revoked', '${TENANT}', 'linear', 'Linear', '${revokedEncrypted}', NULL, 'pot', NULL, 'admin-1', datetime('now'), datetime('now'));`,
  )

  const kv = makeKv()
  const env = {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    CONNECTOR_MASTER_KEY: MASTER_KEY,
    SESSIONS: kv,
  } as unknown as Env

  return { harness, env, connectorId, secret, kv }
}

function linearResponse(nodes: unknown[], status = 200) {
  return (async () => new Response(
    JSON.stringify({ data: { teams: { nodes: [{ id: 'team-1', name: 'Engineering', issues: { nodes } }] } } }),
    { status },
  )) as unknown as typeof fetch
}

afterEach(() => {
  vi.unstubAllGlobals()
})

// ── pure parser ──────────────────────────────────────────────────────────────

describe('parseLinearIssues', () => {
  it('extracts issues, carrying assignee only as a display hint', () => {
    const items = parseLinearIssues({
      teams: {
        nodes: [{
          id: 't1',
          issues: {
            nodes: [
              { id: 'I1', identifier: 'ENG-1', title: 'Fix parser', url: 'https://linear.app/x/issue/ENG-1', state: { name: 'Todo' }, assignee: { name: 'kasra' } },
              { id: 'I2', identifier: 'ENG-2', title: 'No assignee', url: null, state: { name: 'Backlog' }, assignee: null },
            ],
          },
        }],
      },
    })
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ id: 'I1', identifier: 'ENG-1', title: 'Fix parser', state: 'Todo', assigneeHint: 'kasra' })
    expect(items[1].assigneeHint).toBeNull()
  })

  it('returns [] for an empty/odd response', () => {
    expect(parseLinearIssues({})).toEqual([])
    expect(parseLinearIssues({ teams: { nodes: [] } })).toEqual([])
  })

  // PR #659 P0 fix, finding #5: title was already capped at 200; identifier and url
  // were `typeof string` only and landed UNCAPPED into task.body/done_when
  // (importLinearIssues) — an attacker-controlled Linear field with no bound.
  it('caps identifier at 100 chars and url at 500 chars', () => {
    const longIdentifier = 'X'.repeat(500)
    const longUrl = 'https://linear.app/' + 'y'.repeat(1000)
    const items = parseLinearIssues({
      teams: {
        nodes: [{
          id: 't1',
          issues: {
            nodes: [
              { id: 'I1', identifier: longIdentifier, title: 'Fix parser', url: longUrl, state: { name: 'Todo' }, assignee: null },
            ],
          },
        }],
      },
    })
    expect(items[0].identifier.length).toBe(100)
    expect(items[0].identifier).toBe(longIdentifier.slice(0, 100))
    expect(items[0].url?.length).toBe(500)
    expect(items[0].url).toBe(longUrl.slice(0, 500))
  })
})

describe('defaultSquadIdFromMeta', () => {
  it('parses a configured squad id', () => {
    expect(defaultSquadIdFromMeta(JSON.stringify({ defaultSquadId: 'squad-a' }))).toBe('squad-a')
  })
  it('returns null for absent/blank/invalid meta', () => {
    expect(defaultSquadIdFromMeta('{}')).toBeNull()
    expect(defaultSquadIdFromMeta(JSON.stringify({ defaultSquadId: '  ' }))).toBeNull()
    expect(defaultSquadIdFromMeta('not json')).toBeNull()
  })
})

// ── LINEAR_ISSUES_QUERY is read-only ─────────────────────────────────────────

describe('LINEAR_ISSUES_QUERY', () => {
  it('contains no mutation operation', () => {
    expect(LINEAR_ISSUES_QUERY).not.toMatch(/\bmutation\b/i)
    expect(LINEAR_ISSUES_QUERY.trim().startsWith('query')).toBe(true)
  })
})

// ── fetchLinearIssues — vault resolution + fail-closed ───────────────────────

describe('fetchLinearIssues', () => {
  it('(a) tenant isolation: a connector from another tenant never resolves', async () => {
    const { env } = await makeHarness()
    const fetchSpy = vi.fn(linearResponse([]))
    vi.stubGlobal('fetch', fetchSpy)
    const res = await fetchLinearIssues(env, 'connector-linear-other', 'ENG')
    expect(res).toEqual({ ok: false, error: 'connector_unavailable' })
    expect(fetchSpy).not.toHaveBeenCalled() // no network call for an unresolvable credential
  })

  it('(b) missing credential fails closed with a typed reason', async () => {
    const { env } = await makeHarness()
    const res = await fetchLinearIssues(env, 'connector-does-not-exist', 'ENG')
    expect(res).toEqual({ ok: false, error: 'connector_unavailable' })
  })

  it('(b) revoked credential fails closed', async () => {
    const { env } = await makeHarness()
    const res = await fetchLinearIssues(env, 'connector-linear-revoked', 'ENG')
    expect(res).toEqual({ ok: false, error: 'connector_unavailable' })
  })

  it('rejects an invalid team key before any network call', async () => {
    const { env, connectorId } = await makeHarness()
    const fetchSpy = vi.fn(linearResponse([]))
    vi.stubGlobal('fetch', fetchSpy)
    const res = await fetchLinearIssues(env, connectorId, 'not a key!')
    expect(res).toEqual({ ok: false, error: 'invalid_external_id' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('sends the raw key (no Bearer prefix) and never leaks it in url/body/result', async () => {
    const { env, connectorId, secret } = await makeHarness()
    const fetchSpy = vi.fn(linearResponse([
      { id: 'I1', identifier: 'ENG-1', title: 'Fix parser', url: 'https://linear.app/x/issue/ENG-1', state: { name: 'Todo' }, assignee: null },
    ]))
    vi.stubGlobal('fetch', fetchSpy)
    const res = await fetchLinearIssues(env, connectorId, 'ENG')
    expect(res.ok).toBe(true)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.linear.app/graphql')
    expect(new Headers(init.headers).get('authorization')).toBe(secret)
    expect(String(init.body)).not.toContain(secret)
    expect(JSON.stringify(res)).not.toContain(secret)
  })

  it('fails closed (does not fabricate) on a non-2xx Linear response', async () => {
    const { env, connectorId } = await makeHarness()
    vi.stubGlobal('fetch', vi.fn(linearResponse([], 500)))
    const res = await fetchLinearIssues(env, connectorId, 'ENG')
    expect(res).toEqual({ ok: false, error: 'linear_unavailable' })
  })

  it('fails closed on a redirect instead of following it', async () => {
    const { env, connectorId } = await makeHarness()
    const fetchSpy = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }))
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)
    const res = await fetchLinearIssues(env, connectorId, 'ENG')
    expect(res).toEqual({ ok: false, error: 'linear_unavailable' })
  })
})

// ── importLinearIssues — the structural no-dispatch proof ───────────────────

describe('importLinearIssues', () => {
  it('(c) with no defaultSquadId configured, imports NOTHING — every item reported no_squad', async () => {
    const { env, connectorId } = await makeHarness()
    vi.stubGlobal('fetch', vi.fn(linearResponse([
      { id: 'I1', identifier: 'ENG-1', title: 'Fix parser', url: null, state: { name: 'Todo' }, assignee: { name: 'kasra' } },
    ])))
    const res = await importLinearIssues(env, { connectorId, teamKey: 'ENG', defaultSquadId: null, projectId: 'proj-1' })
    expect(res).toMatchObject({ ok: true, imported: 0, skipped: 0 })
    expect(res.items[0]).toEqual({ title: 'Fix parser', status: 'no_squad' })
    const row = await env.DB.prepare('SELECT COUNT(*) as n FROM tasks').first<{ n: number }>()
    expect(row?.n ?? 0).toBe(0)
  })

  it('(c) imports as UNASSIGNED tasks even when Linear names a real, existing agent as assignee', async () => {
    const { env, connectorId } = await makeHarness()
    vi.stubGlobal('fetch', vi.fn(linearResponse([
      // assignee.name matches a REAL agent ('kasra') seeded in the harness — proving the
      // importer does not resolve it to that agent regardless of whether a match exists.
      { id: 'I1', identifier: 'ENG-1', title: 'Fix parser', url: 'https://linear.app/x/issue/ENG-1', state: { name: 'Todo' }, assignee: { name: 'kasra' } },
    ])))
    const res = await importLinearIssues(env, { connectorId, teamKey: 'ENG', defaultSquadId: 'squad-a', projectId: 'proj-1' })
    expect(res).toMatchObject({ ok: true, imported: 1, skipped: 0 })
    expect(res.items[0]).toEqual({ title: 'Fix parser', status: 'created' })

    const row = await env.DB.prepare('SELECT squad_id, assignee_agent_id, status, github_issue_url, external_source FROM tasks WHERE title = ?1')
      .bind('Fix parser')
      .first<{ squad_id: string; assignee_agent_id: string | null; status: string; github_issue_url: string | null; external_source: string | null }>()
    expect(row?.squad_id).toBe('squad-a') // admin-configured routing, not agent-specific
    expect(row?.assignee_agent_id).toBeNull() // NEVER set from Linear data — the core guarantee
    expect(row?.status).toBe('open') // queued, not started
    expect(row?.github_issue_url).toBeNull() // skipMirror honored — no outbound GitHub write
    // PR #659 P0 fix (migrations/0077): the structural marker every downstream trust
    // decision (canAgentExecuteTask, routeUnassignedWork, the admin reassignment gate,
    // the untrusted-content prompt fence) keys off. Bounded by the already-validated
    // TEAM_KEY_RE team key.
    expect(row?.external_source).toBe('linear:ENG')
  })

  it('dry-run reports without writing', async () => {
    const { env, connectorId } = await makeHarness()
    vi.stubGlobal('fetch', vi.fn(linearResponse([
      { id: 'I1', identifier: 'ENG-1', title: 'Fix parser', url: null, state: { name: 'Todo' }, assignee: null },
    ])))
    const res = await importLinearIssues(env, { connectorId, teamKey: 'ENG', defaultSquadId: 'squad-a', dryRun: true, projectId: 'proj-1' })
    expect(res.imported).toBe(1)
    const row = await env.DB.prepare('SELECT COUNT(*) as n FROM tasks').first<{ n: number }>()
    expect(row?.n ?? 0).toBe(0)
  })

  it('dedups already-imported issues on re-run (idempotent)', async () => {
    const { env, connectorId } = await makeHarness()
    const fetchImpl = linearResponse([
      { id: 'I1', identifier: 'ENG-1', title: 'Fix parser', url: null, state: { name: 'Todo' }, assignee: null },
    ])
    vi.stubGlobal('fetch', vi.fn(fetchImpl))
    await importLinearIssues(env, { connectorId, teamKey: 'ENG', defaultSquadId: 'squad-a', projectId: 'proj-1' })
    const res2 = await importLinearIssues(env, { connectorId, teamKey: 'ENG', defaultSquadId: 'squad-a', projectId: 'proj-1' })
    expect(res2).toMatchObject({ imported: 0, skipped: 1 })
    const row = await env.DB.prepare('SELECT COUNT(*) as n FROM tasks').first<{ n: number }>()
    expect(row?.n ?? 0).toBe(1)
  })

  it('(b) fails closed and imports nothing when the credential is unresolvable', async () => {
    const { env } = await makeHarness()
    const fetchSpy = vi.fn(linearResponse([]))
    vi.stubGlobal('fetch', fetchSpy)
    const res = await importLinearIssues(env, { connectorId: 'nope', teamKey: 'ENG', defaultSquadId: 'squad-a' })
    expect(res).toEqual({ ok: false, imported: 0, skipped: 0, items: [], error: 'connector_unavailable' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a misconfigured defaultSquadId (no project write access) fails the underlying task write rather than silently succeeding', async () => {
    const { env, connectorId, harness } = await makeHarness()
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-b', 'dept-b', 'Department B');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-b', 'dept-b', 'squad-b', 'Squad B');
    `)
    vi.stubGlobal('fetch', vi.fn(linearResponse([
      { id: 'I1', identifier: 'ENG-1', title: 'Fix parser', url: null, state: { name: 'Todo' }, assignee: null },
    ])))
    // squad-b has NO project_squad_access row on proj-1 — createTask's own
    // validateTaskProjectAttribution chokepoint must reject this, not this file.
    const res = await importLinearIssues(env, { connectorId, teamKey: 'ENG', defaultSquadId: 'squad-b', projectId: 'proj-1' })
    expect(res.items[0]?.status).toBe('error')
    expect(res.imported).toBe(0)
  })
})

// ── structural source-text proof: necessary, but NOT sufficient (PR #659 P0 fix) ────
//
// The diverse-model adversarial gate overturned a PASS on this exact section: the
// 'creates tasks with skipEvent + skipMirror' test below pins the mechanism as a
// source-code regex. It stays green FOREVER even in the vulnerable build, because
// skipEvent/skipMirror only ever suppressed the EVENT wake — they say nothing about
// the board's status-POLLING drivers (canAgentExecuteTask's unassigned-auto-pickup
// branch, the concierge's routeUnassignedWork cron), which never looked at events and
// (pre-migrations/0077) had no column to test at all. Kept below because it is still
// TRUE and a legitimate regression guard for the event-wake mechanism specifically —
// but it is no longer the load-bearing proof. That role now belongs to the property
// tests in the next block, which exercise the REAL functions end-to-end and fail for
// the right reason on da8be05.

describe('structural no-agent-dispatch guarantee (necessary, not sufficient — see block below)', () => {
  const source = readFileSync(join(__dirname, '..', 'src', 'integrations', 'linear-issues.ts'), 'utf8')

  it('never resolves any Linear field to a mupot agent', () => {
    expect(source).not.toMatch(/resolveAgent/i)
    expect(source).toContain('assignee_agent_id: null')
  })

  it('creates tasks with skipEvent + skipMirror (closes the EVENT wake only — see PR #659 P0 fix note above)', () => {
    expect(source).toMatch(/skipEvent:\s*true/)
    expect(source).toMatch(/skipMirror:\s*true/)
  })

  it('the GraphQL query template itself contains no mutation keyword', () => {
    // Checked against LINEAR_ISSUES_QUERY directly (not the whole file, which
    // legitimately discusses "mutation" in prose comments above).
    expect(LINEAR_ISSUES_QUERY).not.toMatch(/\bmutation\b/i)
  })
})

// ── PR #659 P0 fix — property tests against the REAL end-to-end pipeline ───────────
//
// A Linear-origin task, created through the REAL importLinearIssues -> createTask path
// against a REAL D1 harness (full migration chain, including 0077), must be REFUSED by
// the REAL canAgentExecuteTask (exercised via runTaskExecution — canAgentExecuteTask
// itself is not exported, same convention tests/execute.test.ts's #404 regression suite
// uses for source_pot). This is the load-bearing proof the section above cannot be:
// it fails on da8be05 because the task IS picked up and executed, not because a helper
// is missing.

describe('importLinearIssues -> canAgentExecuteTask — Linear-origin task cannot be auto-picked-up (PR #659 P0 fix)', () => {
  it('a Linear-imported task is refused by canAgentExecuteTask for an unassigned squad agent', async () => {
    const { env, connectorId, harness } = await makeHarness()
    vi.stubGlobal('fetch', vi.fn(linearResponse([
      { id: 'I1', identifier: 'ENG-1', title: 'Fix parser', url: null, state: { name: 'Todo' }, assignee: null },
    ])))
    const res = await importLinearIssues(env, { connectorId, teamKey: 'ENG', defaultSquadId: 'squad-a', projectId: 'proj-1' })
    expect(res).toMatchObject({ ok: true, imported: 1 })

    const row = await env.DB.prepare('SELECT id FROM tasks WHERE title = ?1').bind('Fix parser').first<{ id: string }>()
    expect(row?.id).toBeTruthy()

    const agent = harness.sqlite.prepare('SELECT id, squad_id, slug, name, role, model, status, created_at FROM agents WHERE id = ?')
      .get('agent-kasra') as { id: string; squad_id: string; slug: string; name: string; role: string | null; model: string | null; status: string; created_at: string }

    const model: ModelPort = { chat: vi.fn(async () => 'should never run') }
    const r = await runTaskExecution(env, agent, row!.id, { model, emit: async () => {} })

    // Same refusal shape #404's source_pot regression suite proves (tests/execute.test.ts):
    // canAgentExecuteTask's unassigned branch returns false -> loadTaskById+canAgentExecuteTask
    // combo reports task_not_found without ever reaching the model.
    expect(r.ok).toBe(false)
    expect(r.error).toBe('task_not_found')
    expect(model.chat).not.toHaveBeenCalled()
  })
})
