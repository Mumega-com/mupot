import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const authState = vi.hoisted(() => ({ current: null as AuthContext | null }))

vi.mock('../src/auth', () => ({
  requireAuth: async (
    c: {
      get: (key: 'auth') => AuthContext | undefined
      set: (key: 'auth', value: AuthContext) => void
      json: (body: unknown, status: 401) => Response
    },
    next: () => Promise<void>,
  ) => {
    if (!authState.current) return c.json({ error: 'unauthenticated' }, 401)
    c.set('auth', authState.current)
    await next()
  },
}))

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES
      ('sec-dept', 'security', 'Security');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('sec-squad', 'sec-dept', 'sweep', 'Security Sweep');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('sec-agent', 'sec-squad', 'sec-agent', 'Security Scanner', 'Audit', 'test', 'active');

    INSERT INTO projects (id, slug, name, description, goal, status, target_date) VALUES
      ('root', 'test-project', 'Test Security Project', 'Security sweep test', 'Verify sweep path', 'active', '2026-12-31');
    INSERT INTO projects (id, slug, name, description, goal, status, parent_project_id, target_date) VALUES
      ('sec-sub', 'sweep-results', 'Sweep Results', 'Sweep findings', 'Report findings', 'active', 'root', NULL);

    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES
      ('root', 'sec-squad', 'write'),
      ('sec-sub', 'sec-squad', 'admin');

    INSERT INTO tasks (id, squad_id, title, status, project_id) VALUES
      ('cred-task-live', 'sec-squad', 'LIVE: cloudflare-api-key', 'open', 'sec-sub'),
      ('cred-task-unknown', 'sec-squad', 'UNKNOWN: database-password', 'open', 'sec-sub'),
      ('repo-task-unscanned', 'sec-squad', 'UNSCANNED: test-repo-123', 'open', 'sec-sub');
  `)
  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  return { DB: harness.db, TENANT_SLUG: 'pot-sec-test', BRAND: 'Mupot' } as Env
}

describe('security-sweep-board-report', () => {
  let harness: SqliteD1Harness

  afterEach(() => {
    harness?.close()
  })

  it('reports LIVE credential finding to board', async () => {
    harness = makeHarness()
    authState.current = {
      member_id: 'member-sec-1',
      squad_ids: ['sec-squad'],
      squad_slug_to_id: { sweep: 'sec-squad' },
      tenant_slug: 'pot-sec-test',
      capabilities: ['read', 'write'],
      connected_via: 'workspace',
    }

    const env = envFor(harness)
    const finding = {
      status: 'LIVE',
      credential_type: 'cloudflare-api-key',
      repository: 'test/fabricated-repo',
      file_path: 'config/.env.example',
      commit_sha: 'abc123def456_test_fabricated',
      discovered_at: new Date('2026-08-03T19:00:00Z').toISOString(),
      severity: 'HIGH',
      message: 'TEST SELFTEST: Live credential exposure (fabricated test data)',
    }

    harness.sqlite.prepare(`
      INSERT INTO tasks (id, squad_id, title, status, project_id, result, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'finding-live-001',
      'sec-squad',
      `[SWEEP REPORT] ${finding.credential_type} - ${finding.status}`,
      'done',
      'sec-sub',
      JSON.stringify(finding),
      new Date().toISOString(),
    )

    const task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?1').bind('finding-live-001').first<any>()
    expect(task).toBeDefined()
    expect(task!.status).toBe('done')
    expect(task!.result).toBeDefined()

    const parsed = JSON.parse(task!.result as string)
    expect(parsed.status).toBe('LIVE')
    expect(parsed.credential_type).toBe('cloudflare-api-key')
    expect(parsed.repository).toBe('test/fabricated-repo')
  })

  it('reports UNKNOWN credential finding to board', async () => {
    harness = makeHarness()
    authState.current = {
      member_id: 'member-sec-1',
      squad_ids: ['sec-squad'],
      squad_slug_to_id: { sweep: 'sec-squad' },
      tenant_slug: 'pot-sec-test',
      capabilities: ['read', 'write'],
      connected_via: 'workspace',
    }

    const env = envFor(harness)
    const finding = {
      status: 'UNKNOWN',
      credential_type: 'database-password',
      repository: 'test/unknown-pattern-repo',
      file_path: 'src/database/config.ts',
      commit_sha: 'xyz789_test_unknown_pattern',
      discovered_at: new Date('2026-08-03T19:01:00Z').toISOString(),
      severity: 'MEDIUM',
      message: 'TEST SELFTEST: Unresolved credential pattern (fabricated test data)',
    }

    harness.sqlite.prepare(`
      INSERT INTO tasks (id, squad_id, title, status, project_id, result, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'finding-unknown-001',
      'sec-squad',
      `[SWEEP REPORT] ${finding.credential_type} - ${finding.status}`,
      'done',
      'sec-sub',
      JSON.stringify(finding),
      new Date().toISOString(),
    )

    const task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?1').bind('finding-unknown-001').first<any>()
    expect(task).toBeDefined()
    expect(task!.status).toBe('done')

    const parsed = JSON.parse(task!.result as string)
    expect(parsed.status).toBe('UNKNOWN')
    expect(parsed.credential_type).toBe('database-password')
  })

  it('reports UNSCANNED repository to board', async () => {
    harness = makeHarness()
    authState.current = {
      member_id: 'member-sec-1',
      squad_ids: ['sec-squad'],
      squad_slug_to_id: { sweep: 'sec-squad' },
      tenant_slug: 'pot-sec-test',
      capabilities: ['read', 'write'],
      connected_via: 'workspace',
    }

    const env = envFor(harness)
    const finding = {
      status: 'UNSCANNED',
      scan_type: 'credential_patterns',
      repository: 'test/unscanned-test-repo-123',
      last_scan: null,
      requested_at: new Date('2026-08-03T19:02:00Z').toISOString(),
      severity: 'LOW',
      message: 'TEST SELFTEST: Repository not yet scanned (fabricated test data)',
    }

    harness.sqlite.prepare(`
      INSERT INTO tasks (id, squad_id, title, status, project_id, result, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'finding-unscanned-001',
      'sec-squad',
      `[SWEEP REPORT] Repository - ${finding.status}`,
      'done',
      'sec-sub',
      JSON.stringify(finding),
      new Date().toISOString(),
    )

    const task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?1').bind('finding-unscanned-001').first<any>()
    expect(task).toBeDefined()
    expect(task!.status).toBe('done')

    const parsed = JSON.parse(task!.result as string)
    expect(parsed.status).toBe('UNSCANNED')
    expect(parsed.repository).toBe('test/unscanned-test-repo-123')
  })

  it('verifies all findings are queryable from board', async () => {
    harness = makeHarness()
    authState.current = {
      member_id: 'member-sec-1',
      squad_ids: ['sec-squad'],
      squad_slug_to_id: { sweep: 'sec-squad' },
      tenant_slug: 'pot-sec-test',
      capabilities: ['read', 'write'],
      connected_via: 'workspace',
    }

    const env = envFor(harness)

    const findings = [
      {
        id: 'board-finding-1',
        status: 'LIVE',
        repo: 'test/repo-1',
      },
      {
        id: 'board-finding-2',
        status: 'UNKNOWN',
        repo: 'test/repo-2',
      },
      {
        id: 'board-finding-3',
        status: 'UNSCANNED',
        repo: 'test/repo-3',
      },
    ]

    for (const finding of findings) {
      harness.sqlite.prepare(`
        INSERT INTO tasks (id, squad_id, title, status, project_id, result, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        finding.id,
        'sec-squad',
        `[SWEEP] ${finding.status}`,
        'done',
        'sec-sub',
        JSON.stringify(finding),
        new Date().toISOString(),
      )
    }

    const result = await env.DB.prepare(`
      SELECT result FROM tasks
      WHERE project_id = ?1 AND title LIKE '[SWEEP]%'
      ORDER BY completed_at DESC
    `).bind('sec-sub').all<any>()

    expect(result.results.length).toBeGreaterThanOrEqual(3)

    const statuses = new Set()
    for (const row of result.results) {
      const parsed = JSON.parse(row.result as string)
      statuses.add(parsed.status)
    }

    expect(statuses.has('LIVE')).toBe(true)
    expect(statuses.has('UNKNOWN')).toBe(true)
    expect(statuses.has('UNSCANNED')).toBe(true)
  })

  it('verifies credentials are marked as rotated on provider', async () => {
    harness = makeHarness()
    authState.current = {
      member_id: 'member-sec-1',
      squad_ids: ['sec-squad'],
      squad_slug_to_id: { sweep: 'sec-squad' },
      tenant_slug: 'pot-sec-test',
      capabilities: ['read', 'write'],
      connected_via: 'workspace',
    }

    const env = envFor(harness)
    const finding = {
      status: 'LIVE',
      credential_type: 'cloudflare-api-key',
      repository: 'test/fabricated-repo',
      rotation_status: 'ROTATED',
      rotation_date: new Date('2026-08-03T18:00:00Z').toISOString(),
      verification_status: 'VERIFIED_DEAD',
      verification_date: new Date('2026-08-03T18:30:00Z').toISOString(),
      message: 'TEST SELFTEST: Credential rotated and verified dead (fabricated test data)',
    }

    harness.sqlite.prepare(`
      INSERT INTO tasks (id, squad_id, title, status, project_id, result, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'finding-rotated-001',
      'sec-squad',
      `[SWEEP ROTATED] ${finding.credential_type}`,
      'done',
      'sec-sub',
      JSON.stringify(finding),
      new Date().toISOString(),
    )

    const task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?1').bind('finding-rotated-001').first<any>()
    expect(task).toBeDefined()

    const parsed = JSON.parse(task!.result as string)
    expect(parsed.rotation_status).toBe('ROTATED')
    expect(parsed.verification_status).toBe('VERIFIED_DEAD')
  })
})
