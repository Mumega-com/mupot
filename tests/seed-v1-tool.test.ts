// tests/seed-v1-tool.test.ts — seed_attach MCP tool (src/mcp/seed.ts), entered through
// invokeTool against real SQL (sqlite-d1 harness), never via spec.run().

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { TOOLS, invokeTool } from '../src/mcp/index'
import { createSqliteD1 } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TENANT = 'tenant-a'
const seedText = readFileSync(join(__dirname, '..', 'docs', 'examples', 'seeds', 'mumega-com.seed.yaml'), 'utf8')

function makeDb() {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept', 'dept', 'Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept', 'a', 'A');
    INSERT INTO projects (id, slug, name, goal) VALUES ('proj-vis', 'mumega-com', 'Old Name', 'Old goal');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('proj-vis', 'squad-a', 'read');
    INSERT INTO projects (id, slug, name, goal) VALUES ('proj-hidden', 'hidden-one', 'Hidden', 'secret goal');
  `)
  const count = (table: string) => (harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  return { env: { DB: harness.db, TENANT_SLUG: TENANT } as Env, count, harness }
}

function grant(capability: CapabilityGrant['capability'], scope_type = 'org', scope_id: string | null = null): CapabilityGrant {
  return { member_id: 'n/a', scope_type, scope_id, capability } as CapabilityGrant
}
function auth(memberId: string, capabilities: CapabilityGrant[]): AuthContext {
  return { userId: memberId, email: `${memberId}@example.test`, role: 'member', tenant: TENANT, channel: 'workspace', memberId, capabilities, boundAgentId: null }
}
const member = auth('m1', [grant('member', 'squad', 'squad-a')])
const orgAdmin = auth('adm', [grant('admin', 'org', null)])
const observer = auth('obs', [grant('observer', 'squad', 'squad-a')])

const call = (env: Env, a: AuthContext, args: unknown) => invokeTool(a, env, 'seed_attach', args, 'https://pot.test')

describe('seed_attach registration', () => {
  it('is registered once, member floor, and no other seed tool exists', () => {
    const spec = TOOLS.filter((t) => t.name.startsWith('seed'))
    expect(spec.map((t) => t.name)).toEqual(['seed_attach'])
    expect(spec[0].min).toBe('member')
  })
  it('an observer is refused at the capability floor', async () => {
    const { env } = makeDb()
    const r = await call(env, observer, { seed: seedText })
    expect(r.ok).toBe(false)
  })
})

describe('seed_attach dry run', () => {
  it('defaults to dry_run, validates, returns digest + requests, writes nothing', async () => {
    const { env, count } = makeDb()
    const before = ['projects', 'squads', 'agents', 'members', 'project_squad_access'].map(count)
    const r = await call(env, member, { seed: seedText })
    expect(r.ok).toBe(true)
    const res = (r as { result: { ok: boolean; dry_run: boolean; seed_sha256: string; requests: Array<{ needs: string }> } }).result
    expect(res).toMatchObject({ ok: true, dry_run: true })
    expect(res.seed_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(res.requests.length).toBeGreaterThan(0)
    expect(res.requests.every((q) => q.needs === 'human_accept')).toBe(true)
    expect(['projects', 'squads', 'agents', 'members', 'project_squad_access'].map(count)).toEqual(before)
  })

  it('explicit dry_run:true writes nothing at the whole-database level', async () => {
    const { env, harness } = makeDb()
    const snapshot = () => JSON.stringify(
      (harness.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>)
        .map((t) => [t.name, (harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get() as { n: number }).n]),
    )
    const before = snapshot()
    expect((await call(env, orgAdmin, { seed: seedText, dry_run: true })).ok).toBe(true)
    expect(snapshot()).toBe(before)
  })

  it('reports diffs against a readable existing project of that slug', async () => {
    const { env } = makeDb()
    const r = await call(env, member, { seed: seedText })
    const res = (r as { result: { diffs: Array<{ field: string; current: string | null }> } }).result
    expect(res.diffs.map((d) => d.field)).toEqual(expect.arrayContaining(['name', 'goal']))
    expect(res.diffs.find((d) => d.field === 'name')?.current).toBe('Old Name')
  })

  it('gives no diff and no signal for a project the caller cannot read', async () => {
    const { env } = makeDb()
    const hiddenSeed = seedText.replace('slug: mumega-com', 'slug: hidden-one')
    const r = await call(env, member, { seed: hiddenSeed })
    const res = (r as { result: { diffs: unknown[] } }).result
    expect(res.diffs).toEqual([])
    expect(JSON.stringify(res)).not.toMatch(/secret goal|proj-hidden/)
  })

  it('a refused seed is a 400 invalid_seed with the code', async () => {
    const { env } = makeDb()
    const r = await call(env, member, { seed: seedText + '\npassword: x\n' })
    expect(r).toMatchObject({ ok: false, status: 400, error: 'invalid_seed', detail: { code: 'secret_in_seed' } })
  })

  it('non-boolean dry_run is invalid_args', async () => {
    const { env } = makeDb()
    expect(await call(env, member, { seed: seedText, dry_run: 'false' })).toMatchObject({ ok: false, status: 400 })
  })
})

describe('seed_attach apply is not built', () => {
  it('dry_run:false returns 501 seed_apply_not_built and writes nothing', async () => {
    const { env, count } = makeDb()
    const before = ['projects', 'squads', 'agents'].map(count)
    const r = await call(env, orgAdmin, { seed: seedText, dry_run: false })
    expect(r).toMatchObject({ ok: false, status: 501, error: 'seed_apply_not_built' })
    expect(['projects', 'squads', 'agents'].map(count)).toEqual(before)
  })
})
