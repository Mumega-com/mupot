// B3c: department-gate drafts go to the customer's OWN destination (the task's squad-scoped connector),
// never the operator's. REAL SQLite schema + real connector service (encrypt/decrypt); only the outbound
// HTTP is stubbed. Assertions are on the actual outgoing request (body tenant_slug / URL, Authorization).
// Covers Inkwell (meta.tenantSlug) and WordPress (mcpwp: siteUrl + app password), same route.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { dashboardApp } from '../src/dashboard/index'
import { addConnector, revokeConnector } from '../src/connectors/service'
import { parseInkwellTenantSlug } from '../src/departments/inkwell-target'
import { resolveSquadConnectorWithMeta } from '../src/connectors/service'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import type { Env } from '../src/types'

const OPERATOR_SLUG = 'operator-pot'
const OPERATOR_TENANT_SLUG = 'operator-tenant'

let h: SqliteD1Harness
let env: Env
let calls: { url: string; auth: string; body: Record<string, unknown> }[]

function session(role: string): string {
  return JSON.stringify({ userId: 'u1', email: 'a@b.com', role, createdAt: '2026-01-01T00:00:00Z' })
}

async function connector(
  type: 'inkwell' | 'mcpwp',
  scope: { type: 'squad' | 'pot'; id?: string },
  secret: string,
  meta: unknown,
): Promise<string> {
  const r = await addConnector(env, {
    type,
    label: `${type}-${scope.type}-${scope.id ?? 'pot'}`,
    secret,
    meta: meta === null ? undefined : JSON.stringify(meta),
    scope_type: scope.type,
    scope_id: scope.id,
    created_by: 'm1',
  })
  if (!r.ok) throw new Error(`addConnector failed: ${r.error}`)
  return r.connector.id
}

function seedTask(id: string, squadId: string | null, executor: 'inkwell-content' | 'mcpwp', withTaskRow = true): void {
  if (withTaskRow) {
    h.sqlite
      .prepare(`INSERT INTO tasks (id, squad_id, title, body, status, done_when) VALUES (?, ?, 't', 'b', 'approved', 'd')`)
      .run(id, squadId)
  }
  h.sqlite
    .prepare(`INSERT INTO department_proposals (gate_id, tenant_id, department_key, action, payload_json) VALUES (?, ?, 'growth', 'content-publish', ?)`)
    .run(id, OPERATOR_SLUG, JSON.stringify({ executor, title: 'T', content: 'body', status: 'draft' }))
  // A gate id with no task row can only carry a verdict with FK enforcement off (the point: even a fully
  // approved gate must not fall back to the operator's connector when no task backs it).
  h.sqlite.exec('PRAGMA foreign_keys = OFF')
  h.sqlite
    .prepare(`INSERT INTO task_verdicts (id, task_id, verdict, note, decided_by, decided_at) VALUES (?, ?, 'approved', NULL, 'm1', '2026-07-16T12:00:00.000Z')`)
    .run(`v-${id}`, id)
  h.sqlite.exec('PRAGMA foreign_keys = ON')
}

const post = (gate: string) =>
  new Request(`https://pot.test/admin/departments/growth/execute/${gate}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: 'mupot_session=s', Origin: 'https://pot.test' },
  })

const run = (gate: string) => dashboardApp.fetch(post(gate), env)

beforeEach(async () => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  h.sqlite.prepare('INSERT INTO departments (id, slug, name) VALUES (?, ?, ?)').run('dept-1', 'growth', 'Growth')
  for (const s of ['squad-a', 'squad-b', 'squad-none']) {
    h.sqlite.prepare('INSERT INTO squads (id, department_id, slug, name, charter) VALUES (?, ?, ?, ?, ?)').run(s, 'dept-1', s, s, 'c')
  }
  env = {
    TENANT_SLUG: OPERATOR_SLUG,
    BRAND: 'Test',
    INKWELL_API_URL: 'https://inkwell-api.example.com',
    CONNECTOR_MASTER_KEY: 'a'.repeat(64),
    DB: h.db,
    SESSIONS: { get: vi.fn(async () => session('owner')) },
    OAUTH_KV: { get: vi.fn(), put: vi.fn() },
  } as unknown as Env
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers)
      calls.push({ url: String(url), auth: headers.get('authorization') ?? '', body: JSON.parse(String(init.body)) })
      const wp = String(url).includes('/wp-json/')
      return new Response(JSON.stringify(wp ? { id: 5, link: `${String(url).split('/wp-json')[0]}/?p=5` } : { ok: true, slug: 's', url: '/blog/s' }), {
        status: wp ? 201 : 200,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
  h.close()
})

const basic = (user: string, pw: string) => `Basic ${btoa(`${user}:${pw}`)}`

describe('execute route: Inkwell destination is the customer tenant (real DB)', () => {
  beforeEach(async () => {
    await connector('inkwell', { type: 'squad', id: 'squad-a' }, 'tok-a', { tenantSlug: 'tenant-a' })
    await connector('inkwell', { type: 'squad', id: 'squad-b' }, 'tok-b', { tenantSlug: 'tenant-b' })
    // The operator's own pot-scoped connector, with the operator's slug: must never be used.
    await connector('inkwell', { type: 'pot' }, 'tok-pot', { tenantSlug: OPERATOR_TENANT_SLUG })
  })

  it('task A sends tenant-a with squad-a token (draft)', async () => {
    seedTask('task-a', 'squad-a', 'inkwell-content')
    const res = await run('task-a')
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0].body.tenant_slug).toBe('tenant-a')
    expect(calls[0].body.status).toBe('draft')
    expect(calls[0].auth).toBe('Bearer tok-a')
  })

  it('task B sends tenant-b with squad-b token, never tenant-a', async () => {
    seedTask('task-a', 'squad-a', 'inkwell-content')
    seedTask('task-b', 'squad-b', 'inkwell-content')
    await run('task-b')
    expect(calls.map((c) => c.body.tenant_slug)).toEqual(['tenant-b'])
    expect(calls[0].auth).toBe('Bearer tok-b')
    expect(JSON.stringify(calls)).not.toContain('tenant-a')
    expect(JSON.stringify(calls)).not.toContain('tok-a')
  })

  it('pot connector, its slug and env TENANT_SLUG are never used', async () => {
    seedTask('task-a', 'squad-a', 'inkwell-content')
    await run('task-a')
    const wire = JSON.stringify(calls)
    expect(wire).not.toContain(OPERATOR_TENANT_SLUG)
    expect(wire).not.toContain(OPERATOR_SLUG)
    expect(wire).not.toContain('tok-pot')
  })

  it('squad with no connector → refused 503, 0 Inkwell calls (pot connector + TENANT_SLUG do not rescue it)', async () => {
    seedTask('task-none', 'squad-none', 'inkwell-content')
    const res = await run('task-none')
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toBe('executor_not_configured')
    expect(calls).toHaveLength(0)
  })

  it('revoked squad connector is never used (refused, 0 calls), even with a live pot connector', async () => {
    const id = await connector('inkwell', { type: 'squad', id: 'squad-none' }, 'tok-revoked', { tenantSlug: 'tenant-revoked' })
    expect(await revokeConnector(env, id, 'm1')).toBe(true)
    seedTask('task-none', 'squad-none', 'inkwell-content')
    const res = await run('task-none')
    expect(res.status).toBe(503)
    expect(calls).toHaveLength(0)
  })

  it('gate with no task row (approved verdict + proposal exist) → refused 503, 0 calls, no pot fallback', async () => {
    seedTask('ghost', null, 'inkwell-content', false)
    const res = await run('ghost')
    expect(res.status).toBe(503)
    expect(calls).toHaveLength(0)
  })

  it.each([
    ['meta missing', null],
    ['meta without tenantSlug', { other: 1 }],
    ['empty tenantSlug', { tenantSlug: '  ' }],
    ['non-string tenantSlug', { tenantSlug: 7 }],
    ['malformed tenantSlug', { tenantSlug: 'a/../b' }],
  ])('%s → refused 503, 0 calls, no operator fallback', async (_n, meta) => {
    await connector('inkwell', { type: 'squad', id: 'squad-none' }, 'tok-x', meta)
    seedTask('task-none', 'squad-none', 'inkwell-content')
    const res = await run('task-none')
    expect(res.status).toBe(503)
    expect(calls).toHaveLength(0)
  })

  it('non-admin stays forbidden (authority not widened)', async () => {
    seedTask('task-a', 'squad-a', 'inkwell-content')
    ;(env.SESSIONS.get as ReturnType<typeof vi.fn>).mockResolvedValue(session('member'))
    const res = await run('task-a')
    expect(res.status).toBe(403)
    expect(calls).toHaveLength(0)
  })
})

describe('execute route: WordPress (mcpwp) destination is the customer site (real DB)', () => {
  const wpMeta = (host: string) => ({ siteUrl: `https://${host}`, username: `user-${host}` })

  beforeEach(async () => {
    await connector('mcpwp', { type: 'squad', id: 'squad-a' }, 'pw-a', wpMeta('wp-a.example.com'))
    await connector('mcpwp', { type: 'squad', id: 'squad-b' }, 'pw-b', wpMeta('wp-b.example.com'))
    await connector('mcpwp', { type: 'pot' }, 'pw-pot', wpMeta('wp-operator.example.com'))
  })

  it("customer A's task drafts to A's site with A's credentials only", async () => {
    seedTask('task-a', 'squad-a', 'mcpwp')
    // No Inkwell connector anywhere: only mcpwp can satisfy the gate.
    const res = await run('task-a')
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://wp-a.example.com/wp-json/wp/v2/posts')
    expect(calls[0].auth).toBe(basic('user-wp-a.example.com', 'pw-a'))
    expect(calls[0].body.status).toBe('draft')
    expect(JSON.stringify(calls)).not.toContain('wp-operator')
    expect(JSON.stringify(calls)).not.toContain('wp-b.example.com')
  })

  it('squad without an mcpwp connector → refused 503, 0 WordPress calls (pot connector not used)', async () => {
    seedTask('task-none', 'squad-none', 'mcpwp')
    const res = await run('task-none')
    expect(res.status).toBe(503)
    expect(calls).toHaveLength(0)
  })

  it('gate with no task row → refused 503, 0 WordPress calls', async () => {
    seedTask('ghost', null, 'mcpwp', false)
    const res = await run('ghost')
    expect(res.status).toBe(503)
    expect(calls).toHaveLength(0)
  })

  it('revoked squad mcpwp connector is never used', async () => {
    const id = await connector('mcpwp', { type: 'squad', id: 'squad-none' }, 'pw-rev', wpMeta('wp-rev.example.com'))
    expect(await revokeConnector(env, id, 'm1')).toBe(true)
    seedTask('task-none', 'squad-none', 'mcpwp')
    const res = await run('task-none')
    expect(res.status).toBe(503)
    expect(calls).toHaveLength(0)
  })
})

describe('parseInkwellTenantSlug', () => {
  it('accepts a plain slug, rejects junk', () => {
    expect(parseInkwellTenantSlug('{"tenantSlug":"tenant-a"}')).toBe('tenant-a')
    expect(parseInkwellTenantSlug('[]')).toBeNull()
    expect(parseInkwellTenantSlug('null')).toBeNull()
    expect(parseInkwellTenantSlug('nope')).toBeNull()
    expect(parseInkwellTenantSlug(null)).toBeNull()
  })
})

describe('resolveSquadConnectorWithMeta is strictly squad-scoped (real DB)', () => {
  it('ignores pot and other-squad connectors; empty squad id → null', async () => {
    await connector('inkwell', { type: 'pot' }, 'tok-pot', { tenantSlug: OPERATOR_TENANT_SLUG })
    await connector('inkwell', { type: 'squad', id: 'squad-b' }, 'tok-b', { tenantSlug: 'tenant-b' })
    expect(await resolveSquadConnectorWithMeta(env, 'squad-a', 'inkwell')).toBeNull()
    expect(await resolveSquadConnectorWithMeta(env, '', 'inkwell')).toBeNull()
    const b = await resolveSquadConnectorWithMeta(env, 'squad-b', 'inkwell')
    expect(b?.secret).toBe('tok-b')
  })
})
