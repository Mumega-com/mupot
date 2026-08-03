// Tests for createLinearBoardPort (src/projects/providers/linear.ts) and its wiring
// through the registry — the ProjectBoardProvider contract level, one layer above
// tests/linear-issues.test.ts's direct integration-module tests.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { encryptConnectorSecret } from '../src/connectors/crypto'
import { createLinearBoardPort } from '../src/projects/providers/linear'
import { getTaskBoardPort } from '../src/projects/providers/registry'
import type { ProjectProviderBinding } from '../src/projects/providers/port'
import type { Env } from '../src/types'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const MASTER_KEY = '22'.repeat(32)
const TENANT = 'tenant-a'

async function makeEnv() {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'squad-a', 'Squad A');
    INSERT INTO projects (id, slug, name, status) VALUES ('proj-1', 'proj-1', 'Proj 1', 'active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('proj-1', 'squad-a', 'write');
  `)
  const encrypted = await encryptConnectorSecret(MASTER_KEY, 'connector-linear-1', 'linear', 'lin_secret')
  harness.sqlite.exec(
    `INSERT INTO connectors (id, tenant, type, label, encrypted_secret, meta, scope_type, scope_id, created_by, created_at)
     VALUES ('connector-linear-1', '${TENANT}', 'linear', 'Linear', '${encrypted}', NULL, 'pot', NULL, 'admin-1', datetime('now'));`,
  )
  const env = {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    CONNECTOR_MASTER_KEY: MASTER_KEY,
    SESSIONS: { get: async () => null, put: async () => {} },
  } as unknown as Env
  return { env, harness }
}

function binding(overrides: Partial<ProjectProviderBinding> = {}): ProjectProviderBinding {
  return {
    project_id: 'proj-1',
    provider: 'linear',
    external_id: 'ENG',
    connector_id: 'connector-linear-1',
    meta_json: '{}',
    synced_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function linearFetch(nodes: unknown[]) {
  return vi.fn(async () => new Response(
    JSON.stringify({ data: { teams: { nodes: [{ id: 't1', name: 'Eng', issues: { nodes } }] } } }),
    { status: 200 },
  )) as unknown as typeof fetch
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('registry wiring', () => {
  it('getTaskBoardPort(env, "linear") returns the Linear adapter', async () => {
    const { env } = await makeEnv()
    const port = getTaskBoardPort(env, 'linear')
    expect(port.provider).toBe('linear')
  })
})

describe('createLinearBoardPort.listItems', () => {
  it('requires a bound connector — no env fallback, fails closed', async () => {
    const { env } = await makeEnv()
    const port = createLinearBoardPort(env)
    const res = await port.listItems(binding({ connector_id: null }))
    expect(res).toEqual({ ok: false, error: 'connector_required' })
  })

  it('lists issues, carrying assignee only as a display hint', async () => {
    const { env } = await makeEnv()
    vi.stubGlobal('fetch', linearFetch([
      { id: 'I1', identifier: 'ENG-1', title: 'Fix parser', url: 'https://linear.app/x/issue/ENG-1', state: { name: 'Todo' }, assignee: { name: 'kasra' } },
    ]))
    const port = createLinearBoardPort(env)
    const res = await port.listItems(binding())
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error()
    expect(res.items).toEqual([
      { external_id: 'ENG-1', title: 'Fix parser', url: 'https://linear.app/x/issue/ENG-1', status: 'Todo', assignee_hint: 'kasra' },
    ])
  })
})

describe('createLinearBoardPort.syncIntoProject', () => {
  it('rejects a project_id mismatch between opts and binding', async () => {
    const { env } = await makeEnv()
    const port = createLinearBoardPort(env)
    const res = await port.syncIntoProject(binding(), { project_id: 'other-project', dryRun: true })
    expect(res).toEqual({ ok: false, error: 'project_mismatch' })
  })

  it('imports unassigned tasks and reports created/no_squad depending on meta_json', async () => {
    const { env } = await makeEnv()
    vi.stubGlobal('fetch', linearFetch([
      { id: 'I1', identifier: 'ENG-1', title: 'Fix parser', url: null, state: { name: 'Todo' }, assignee: null },
    ]))
    const port = createLinearBoardPort(env)

    const withoutSquad = await port.syncIntoProject(binding({ meta_json: '{}' }), { project_id: 'proj-1', dryRun: false })
    expect(withoutSquad).toMatchObject({ ok: true, imported: 0 })
    if (withoutSquad.ok) expect(withoutSquad.items[0].status).toBe('no_squad')

    const withSquad = await port.syncIntoProject(
      binding({ meta_json: JSON.stringify({ defaultSquadId: 'squad-a' }) }),
      { project_id: 'proj-1', dryRun: false },
    )
    expect(withSquad).toMatchObject({ ok: true, imported: 1 })
    if (withSquad.ok) {
      expect(withSquad.items[0]).toEqual({ title: 'Fix parser', status: 'created' })
    }

    const row = await env.DB.prepare('SELECT assignee_agent_id FROM tasks WHERE title = ?1')
      .bind('Fix parser')
      .first<{ assignee_agent_id: string | null }>()
    expect(row?.assignee_agent_id).toBeNull()
  })

  // PR #659 P0 gate, Low finding: a no_squad-misconfigured binding (defaultSquadId
  // unset) imported NOTHING but still stamped synced_at — a fresh "successful sync"
  // receipt hiding the actual misconfiguration from an operator looking at the binding.
  it('does NOT stamp synced_at when the binding is no_squad-misconfigured (nothing was imported)', async () => {
    const { env, harness } = await makeEnv()
    harness.sqlite.exec(
      `INSERT INTO project_provider_bindings (project_id, provider, external_id, connector_id, meta_json)
       VALUES ('proj-1', 'linear', 'ENG', 'connector-linear-1', '{}')`,
    )
    vi.stubGlobal('fetch', linearFetch([
      { id: 'I1', identifier: 'ENG-1', title: 'Fix parser', url: null, state: { name: 'Todo' }, assignee: null },
    ]))
    const port = createLinearBoardPort(env)

    const res = await port.syncIntoProject(binding({ meta_json: '{}' }), { project_id: 'proj-1', dryRun: false })
    expect(res).toMatchObject({ ok: true, imported: 0 })

    const row = await env.DB.prepare(
      `SELECT synced_at FROM project_provider_bindings WHERE project_id = ?1 AND provider = 'linear'`,
    ).bind('proj-1').first<{ synced_at: string | null }>()
    expect(row?.synced_at).toBeNull() // no false "synced" receipt for a misconfigured binding
  })

  it('DOES stamp synced_at for a real (squad-configured) sync, including a zero-issue team', async () => {
    const { env, harness } = await makeEnv()
    harness.sqlite.exec(
      `INSERT INTO project_provider_bindings (project_id, provider, external_id, connector_id, meta_json)
       VALUES ('proj-1', 'linear', 'ENG', 'connector-linear-1', '{}')`,
    )
    vi.stubGlobal('fetch', linearFetch([])) // empty team — a legitimate "synced nothing" outcome
    const port = createLinearBoardPort(env)

    const res = await port.syncIntoProject(
      binding({ meta_json: JSON.stringify({ defaultSquadId: 'squad-a' }) }),
      { project_id: 'proj-1', dryRun: false },
    )
    expect(res).toMatchObject({ ok: true, imported: 0, skipped: 0 })

    const row = await env.DB.prepare(
      `SELECT synced_at FROM project_provider_bindings WHERE project_id = ?1 AND provider = 'linear'`,
    ).bind('proj-1').first<{ synced_at: string | null }>()
    expect(row?.synced_at).not.toBeNull() // a genuine empty-team sync IS a successful sync
  })
})
