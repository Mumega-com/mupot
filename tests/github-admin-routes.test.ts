// Tests for the GitHub admin JSON routes on dashboardApp.
//   GET  /admin/github/status
//   POST /admin/github/agent-def
//   POST /admin/github/assign-copilot
//
// These assert the auth gate (isAdmin), input handling, and that the routes wire into the
// already-tested service layer. Success paths that require live GitHub fetch are covered in
// github-repo-write.test.ts (with injected fetch); here we drive the deterministic gate +
// fail-closed paths through the real route.

import { describe, it, expect, vi } from 'vitest'
import { dashboardApp } from '../src/dashboard/index'
import type { Env } from '../src/types'
import { createTask } from '../src/tasks/service'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

function envForRole(role: 'owner' | 'admin' | 'member', extra: Record<string, unknown> = {}): Env {
  const stmt = {
    bind: (..._a: unknown[]) => stmt,
    first: vi.fn(async () => null),
    all: vi.fn(async () => ({ results: [] })),
    run: vi.fn(async () => ({ meta: { changes: 1 } })),
  }
  return {
    TENANT_SLUG: 't',
    BRAND: 'Test',
    DB: { prepare: vi.fn(() => stmt) },
    SESSIONS: {
      get: vi.fn(async () =>
        JSON.stringify({ userId: 'u1', email: 'a@b.com', role, createdAt: '2026-01-01T00:00:00Z' }),
      ),
    },
    OAUTH_KV: { get: vi.fn(), put: vi.fn() },
    ...extra,
  } as unknown as Env
}

function req(path: string, method: 'GET' | 'POST', body?: unknown): Request {
  return new Request(`https://pot.test${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Cookie: 'mupot_session=sess1',
      Origin: 'https://pot.test',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

describe('GET /admin/github/status', () => {
  it('non-admin → 403', async () => {
    const res = await dashboardApp.fetch(req('/admin/github/status', 'GET'), envForRole('member'))
    expect(res.status).toBe(403)
  })

  it('admin → 200 capability snapshot (free tier, enterprise off by default)', async () => {
    const res = await dashboardApp.fetch(req('/admin/github/status', 'GET'), envForRole('admin'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      tier: string
      enterpriseEnabled: boolean
      features: Array<{ feature: string; enabled: boolean; enterprise: boolean }>
    }
    expect(body.tier).toBe('free')
    expect(body.enterpriseEnabled).toBe(false)
    // base feature on, enterprise feature off
    expect(body.features.find((f) => f.feature === 'issue_mirror')?.enabled).toBe(true)
    expect(body.features.find((f) => f.feature === 'org_mcp_allowlist')?.enabled).toBe(false)
  })
})

describe('GET /admin/github (HTML card)', () => {
  it('non-admin → 403', async () => {
    const res = await dashboardApp.fetch(req('/admin/github', 'GET'), envForRole('member'))
    expect(res.status).toBe(403)
  })
  it('admin → 200 HTML with connect CTA (not connected by default)', async () => {
    const res = await dashboardApp.fetch(req('/admin/github', 'GET'), envForRole('admin'))
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('Connect GitHub')
    expect(text).toContain('Capabilities')
    expect(text).toContain('Sync the fleet to GitHub')
  })
})

describe('POST /admin/github/agent-def', () => {
  it('non-admin → 403', async () => {
    const res = await dashboardApp.fetch(
      req('/admin/github/agent-def', 'POST', { repo: 'a/b', agentName: 'kasra', content: '# x' }),
      envForRole('member'),
    )
    expect(res.status).toBe(403)
  })

  it('admin, bad json → 400 invalid_json', async () => {
    const r = new Request('https://pot.test/admin/github/agent-def', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: 'mupot_session=sess1', Origin: 'https://pot.test' },
      body: '{not json',
    })
    const res = await dashboardApp.fetch(r, envForRole('admin'))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('invalid_json')
  })

  it('admin, valid input but no token configured → 400 no_token (fail-closed)', async () => {
    const res = await dashboardApp.fetch(
      req('/admin/github/agent-def', 'POST', { repo: 'Mumega-com/mumega-com', agentName: 'kasra', content: '# Kasra' }),
      envForRole('admin'),
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('no_token')
  })

  it('admin, bad agent name → 400 invalid_agent_name (before any network)', async () => {
    const res = await dashboardApp.fetch(
      req('/admin/github/agent-def', 'POST', { repo: 'a/b', agentName: '../escape', content: '# x' }),
      envForRole('admin'),
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('invalid_agent_name')
  })
})

describe('POST /admin/github/sync-fleet', () => {
  it('non-admin → 403', async () => {
    const res = await dashboardApp.fetch(
      req('/admin/github/sync-fleet', 'POST', { repo: 'a/b', dryRun: true }),
      envForRole('member'),
    )
    expect(res.status).toBe(403)
  })

  it('admin, missing repo → 400 repo_required', async () => {
    const res = await dashboardApp.fetch(
      req('/admin/github/sync-fleet', 'POST', { dryRun: true }),
      envForRole('admin'),
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('repo_required')
  })

  it('admin, dry-run with no agents → 200 ok, 0 synced', async () => {
    const res = await dashboardApp.fetch(
      req('/admin/github/sync-fleet', 'POST', { repo: 'Mumega-com/mumega-com', dryRun: true }),
      envForRole('admin'),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; synced: number }
    expect(body.ok).toBe(true)
    expect(body.synced).toBe(0)
  })
})

describe('POST /admin/github/execute-task', () => {
  it('non-admin → 403', async () => {
    const res = await dashboardApp.fetch(
      req('/admin/github/execute-task', 'POST', { taskId: 'T1', repo: 'o/r', branchName: 'b', files: [{ path: 'a.ts', content: 'x' }], title: 'T' }),
      envForRole('member'),
    )
    expect(res.status).toBe(403)
  })
  it('admin, invalid repo → 400 validate stage', async () => {
    const res = await dashboardApp.fetch(
      req('/admin/github/execute-task', 'POST', { taskId: 'T1', repo: 'bad', branchName: 'b', files: [{ path: 'a.ts', content: 'x' }], title: 'T' }),
      envForRole('admin'),
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { stage: string }).stage).toBe('validate')
  })
  it('admin, repo the task does not own → 403 repo stage (no GitHub call)', async () => {
    // Real migration-backed D1: the route runs the genuine task lookup against a genuine task row.
    const h = createSqliteD1()
    applyAllMigrations(h.sqlite)
    h.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-core', 'dept-a', 'squad-core', 'Core');
    `)
    const base = envForRole('admin', { GITHUB_REPO: 'o/r' })
    const env = { ...base, DB: h.db } as Env
    // task exists, no project: only GITHUB_REPO is allowed
    const task = await createTask(env, { squad_id: 'squad-core', project_id: null, title: 'T', body: 'B', done_when: 'the thing is done', status: 'open' }, { skipMirror: true })
    const res = await dashboardApp.fetch(
      req('/admin/github/execute-task', 'POST', { taskId: task.id, repo: 'other/place', branchName: 'b', files: [{ path: 'a.ts', content: 'x' }], title: 'T' }),
      env,
    )
    expect(res.status).toBe(403)
    expect(((await res.json()) as { stage: string }).stage).toBe('repo')
  })
})

describe('POST /admin/github/assign-copilot', () => {
  it('non-admin → 403', async () => {
    const res = await dashboardApp.fetch(
      req('/admin/github/assign-copilot', 'POST', { repo: 'a/b', issueNumber: 1 }),
      envForRole('member'),
    )
    expect(res.status).toBe(403)
  })

  it('admin, free tier → 400 capability_disabled (needs paid plan)', async () => {
    const res = await dashboardApp.fetch(
      req('/admin/github/assign-copilot', 'POST', { repo: 'a/b', issueNumber: 1 }),
      envForRole('admin'),
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('capability_disabled')
  })
})
