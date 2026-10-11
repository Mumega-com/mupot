// tests/seed-v1-apply.test.ts — seed_attach APPLY (dry_run:false), src/seeds/apply.ts.
// Entered through invokeTool against the real migrated schema (sqlite-d1 harness). Every negative
// case asserts on the WHOLE database (row count of every table), not on the tables we expect to move.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { invokeTool } from '../src/mcp/index'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'tenant-a'
const CANARY = 'RAW-SOURCE-CANARY-9c41e7'
const base = readFileSync(join(__dirname, '..', 'docs', 'examples', 'seeds', 'mumega-com.seed.yaml'), 'utf8')
// A comment is dropped by validation; it must never reach any stored column.
const seedText = `# ${CANARY}\n${base}\n# trailing ${CANARY}\n`

function grant(capability: CapabilityGrant['capability'], scope_type = 'org', scope_id: string | null = null): CapabilityGrant {
  return { member_id: 'n/a', scope_type, scope_id, capability } as CapabilityGrant
}
function auth(memberId: string, capabilities: CapabilityGrant[], boundAgentId: string | null = null): AuthContext {
  return { userId: memberId, email: `${memberId}@example.test`, role: 'member', tenant: TENANT, channel: 'workspace', memberId, capabilities, boundAgentId }
}
const adm = auth('adm', [grant('admin')])
const adm2 = auth('adm2', [grant('admin')])
const memberOnly = auth('m1', [grant('member', 'squad', 'squad-a')])
const agentBound = auth('adm', [grant('admin')], 'agent-x')

let harness: SqliteD1Harness
let env: Env

function setup(): void {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO org_settings (key, value) VALUES ('billing_state', '{"tier":"scale"}');
    INSERT INTO departments (id, slug, name) VALUES ('dept', 'dept', 'Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept', 'a', 'A');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('adm', 'adm@example.test', 'Adm', 'active', '${TENANT}'),
      ('adm2', 'adm2@example.test', 'Adm2', 'active', '${TENANT}'),
      ('m1', 'm1@example.test', 'M1', 'active', '${TENANT}');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-x', 'squad-a', 'agent-x', 'X', 'r', 'm', 'active');
  `)
  env = { DB: harness.db, TENANT_SLUG: TENANT } as Env
}
beforeEach(setup)

const call = (a: AuthContext, args: unknown) => invokeTool(a, env, 'seed_attach', args, 'https://pot.test')
const count = (t: string) => (harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n
const tables = () => (harness.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name)
const counts = (): Record<string, number> => Object.fromEntries(tables().map((t) => [t, count(t)]))
const snapshot = () => JSON.stringify(counts())
const dump = () => JSON.stringify(tables().map((t) => [t, harness.sqlite.prepare(`SELECT * FROM "${t}"`).all()]))

type Out = Awaited<ReturnType<typeof call>>
const okResult = (r: Out): Record<string, unknown> => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`)
  return r.result as Record<string, unknown>
}
async function keys(text = seedText): Promise<string[]> {
  const res = okResult(await call(adm, { seed: text }))
  return (res.requests as Array<{ key: string }>).map((r) => r.key)
}
const apply = async (a: AuthContext = adm, text = seedText, accept?: string[]) =>
  call(a, { seed: text, dry_run: false, accept: accept ?? (await keys(text)) })

describe('dry run (unchanged)', () => {
  it('omitting dry_run validates, returns request keys, writes nothing', async () => {
    const before = snapshot()
    const res = okResult(await call(adm, { seed: seedText }))
    expect(res).toMatchObject({ ok: true, dry_run: true })
    expect((res.requests as Array<{ key: string }>).every((r) => /^[a-z_]+:[0-9a-f]{12}$/.test(r.key))).toBe(true)
    expect(snapshot()).toBe(before)
  })
})

describe('apply: authority', () => {
  it('refuses an agent-bound caller with human_accept_required and writes nothing', async () => {
    const accept = await keys()
    const before = dump()
    const r = await call(agentBound, { seed: seedText, dry_run: false, accept })
    expect(r).toMatchObject({ ok: false, status: 403, error: 'human_accept_required' })
    expect(dump()).toBe(before)
  })

  it('refuses a non-admin member (the team_bootstrap floor) and writes nothing', async () => {
    const accept = await keys()
    const before = dump()
    const r = await call(memberOnly, { seed: seedText, dry_run: false, accept })
    expect(r).toMatchObject({ ok: false, status: 403, error: 'forbidden' })
    expect(dump()).toBe(before)
  })

  it('refuses when ANY request key is not accepted (409, lists the missing) and writes nothing', async () => {
    const all = await keys()
    const before = dump()
    const r = await call(adm, { seed: seedText, dry_run: false, accept: all.slice(1) })
    expect(r).toMatchObject({ ok: false, status: 409, error: 'requests_not_accepted' })
    expect((r as { detail: { missing: Array<{ key: string }> } }).detail.missing.map((m) => m.key)).toEqual([all[0]])
    expect(dump()).toBe(before)
    // accept omitted entirely is also refused, never read as "accept all"
    expect(await call(adm, { seed: seedText, dry_run: false })).toMatchObject({ ok: false, status: 400, error: 'invalid_args' })
    expect(dump()).toBe(before)
  })

  it('refuses an accept key the seed does not produce', async () => {
    const all = await keys()
    const before = dump()
    expect(await call(adm, { seed: seedText, dry_run: false, accept: [...all, 'gate:000000000000'] }))
      .toMatchObject({ ok: false, status: 400, error: 'unknown_accept_keys' })
    expect(dump()).toBe(before)
  })

  it('a slug team_bootstrap cannot derive names from is refused before any write', async () => {
    const text = seedText.replace('slug: mumega-com', 'slug: mumega-prj')
    const before = dump()
    expect(await apply(adm, text)).toMatchObject({ ok: false, status: 400, error: 'seed_slug_not_applicable' })
    expect(dump()).toBe(before)
  })
})

describe('apply: what it creates, and what it never does', () => {
  it('creates project + squad + ADMIN edge + seat cap + seed row + one receipt, and grants nothing', async () => {
    const before = counts()
    const res = okResult(await apply())
    expect(res).toMatchObject({ ok: true, dry_run: false, replay: false, status: 'applied', seat_cap: 2, grants: 'none' })
    const after = counts()
    const moved = tables().filter((t) => after[t] !== before[t])
    // Exactly these tables grow (departments: the shared dept-projects container, first use only).
    expect(moved.sort()).toEqual(
      ['departments', 'mutation_audit_entries', 'project_seeds', 'project_squad_access', 'projects', 'squads', 'team_bootstrap_receipts']
        .filter((t) => moved.includes(t)).sort(),
    )
    for (const t of ['projects', 'squads', 'project_squad_access', 'project_seeds', 'mutation_audit_entries']) expect(after[t] - before[t]).toBe(1)
    // NOTHING that confers authority or capability changed.
    for (const t of ['capabilities', 'gate_grants', 'agents', 'routines', 'invites', 'agent_tokens', 'members']) {
      if (t in before) expect(after[t], t).toBe(before[t])
    }
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS n FROM capabilities WHERE capability LIKE 'gate:%'").get()).toEqual({ n: 0 })
    // The requests stay recorded as pending_human; nothing is accepted into effect.
    const row = harness.sqlite.prepare('SELECT * FROM project_seeds').get() as Record<string, string | number>
    expect(row).toMatchObject({ status: 'applied', seat_cap: 2, applied_by_member_id: 'adm', owner_label: 'site-owner', project_slug: 'mumega-com-prj' })
    const reqs = JSON.parse(row.requests_json as string) as Array<{ status: string }>
    expect(reqs.length).toBeGreaterThan(0)
    expect(reqs.every((r) => r.status === 'pending_human')).toBe(true)
    const proj = harness.sqlite.prepare("SELECT slug, created_by_member_id FROM projects WHERE slug = 'mumega-com-prj'").get()
    expect(proj).toEqual({ slug: 'mumega-com-prj', created_by_member_id: 'adm' })
    const squad = harness.sqlite.prepare('SELECT name, created_by_member_id FROM squads WHERE id = ?').get(row.squad_id as string)
    expect(squad).toEqual({ name: 'web', created_by_member_id: 'adm' })
    const edge = harness.sqlite.prepare('SELECT access_level FROM project_squad_access WHERE project_id = ?').get(row.project_id as string)
    expect(edge).toEqual({ access_level: 'admin' })
    const receipt = harness.sqlite.prepare("SELECT principal_id, evidence_json FROM mutation_audit_entries WHERE handler = 'seed_attach'").get() as { principal_id: string; evidence_json: string }
    expect(receipt.principal_id).toBe('adm')
    expect(JSON.parse(receipt.evidence_json)).toMatchObject({ seed_sha256: row.seed_sha256, grants: 'none' })
    expect(JSON.parse(receipt.evidence_json).accepted_keys.length).toBe(reqs.length)
  })

  it('stores only the canonical form: the raw source (comments) appears in no column of any table', async () => {
    okResult(await apply())
    expect(dump()).not.toContain(CANARY)
    expect(JSON.parse((harness.sqlite.prepare('SELECT canonical_json FROM project_seeds').get() as { canonical_json: string }).canonical_json).slug).toBe('mumega-com')
  })

  it('the owner label is never resolved to a member', async () => {
    const membersBefore = dump().length
    okResult(await apply(adm, seedText.replace('owner: site-owner', 'owner: m1')))
    expect(harness.sqlite.prepare("SELECT created_by_member_id FROM projects WHERE slug = 'mumega-com-prj'").get()).toEqual({ created_by_member_id: 'adm' })
    expect(harness.sqlite.prepare('SELECT owner_label FROM project_seeds').get()).toEqual({ owner_label: 'm1' })
    expect(membersBefore).toBeGreaterThan(0)
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS n FROM capabilities WHERE member_id = 'm1'").get()).toEqual({ n: 0 })
  })
})

describe('apply: idempotency', () => {
  it('a second apply of the same seed is a replay and changes no row anywhere', async () => {
    okResult(await apply())
    const after1 = dump()
    const again = okResult(await apply())
    expect(again).toMatchObject({ ok: true, replay: true, status: 'applied' })
    expect(dump()).toBe(after1)
  })

  it('YAML vs JSON form of the same seed replays (digest is the key)', async () => {
    okResult(await apply())
    const after1 = dump()
    const { parse } = await import('yaml')
    const asJson = JSON.stringify(parse(base))
    expect(okResult(await apply(adm, asJson))).toMatchObject({ replay: true })
    expect(dump()).toBe(after1)
  })

  it('the same slug with a different digest is 409 seed_digest_conflict and mutates nothing', async () => {
    okResult(await apply())
    const after1 = dump()
    const changed = seedText.replace('Publish and maintain the public site', 'Publish something else entirely')
    const r = await apply(adm, changed)
    expect(r).toMatchObject({ ok: false, status: 409, error: 'seed_digest_conflict' })
    expect(dump()).toBe(after1)
  })

  it('two concurrent applies (both reach the claim together): one project, one squad, one receipt, one replay', async () => {
    const accept = await keys()
    let arrived = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const barrier = async () => {
      arrived += 1
      if (arrived >= 2) release()
      await Promise.race([gate, new Promise((resolve) => setTimeout(resolve, 50))])
    }
    const real = env.DB
    const racing = new Proxy(real, {
      get(target, key) {
        if (key === 'prepare') {
          return (sql: string) => {
            const stmt = target.prepare(sql)
            if (!/INSERT INTO project_seeds/.test(sql)) return stmt
            return new Proxy(stmt, {
              get(st, k) {
                if (k === 'bind') {
                  return (...values: unknown[]) => {
                    const bound = st.bind(...values)
                    return new Proxy(bound, {
                      get(b, kk) {
                        if (kk === 'run') return async (...a: unknown[]) => { await barrier(); return (b.run as (...x: unknown[]) => Promise<unknown>)(...a) }
                        const v = Reflect.get(b, kk)
                        return typeof v === 'function' ? v.bind(b) : v
                      },
                    })
                  }
                }
                const v = Reflect.get(st, k)
                return typeof v === 'function' ? v.bind(st) : v
              },
            })
          }
        }
        const v = Reflect.get(target, key)
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
    const racingEnv = { ...env, DB: racing } as unknown as Env
    const args = { seed: seedText, dry_run: false, accept }
    const [a, b] = await Promise.all([
      invokeTool(adm, racingEnv, 'seed_attach', args, 'https://pot.test'),
      invokeTool(adm, racingEnv, 'seed_attach', args, 'https://pot.test'),
    ])
    const results = [okResult(a), okResult(b)]
    expect(results.filter((r) => r.replay === true)).toHaveLength(1)
    expect(results.filter((r) => r.replay === false)).toHaveLength(1)
    expect(count('project_seeds')).toBe(1)
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS n FROM projects WHERE slug = 'mumega-com-prj'").get()).toEqual({ n: 1 })
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS n FROM squads WHERE slug = 'mumega-com-sqd'").get()).toEqual({ n: 1 })
    expect(count('mutation_audit_entries')).toBe(1)
    expect(count('team_bootstrap_receipts')).toBe(1)
  })

  it('a crashed apply (lease lapsed) is resumed by the same member without duplicating anything', async () => {
    okResult(await apply())
    // Simulate a crash between create and flip: put the row back to applying with an expired lease.
    harness.sqlite.exec("UPDATE project_seeds SET status = 'applying', lease_token = 'dead', lease_expires_at = '2000-01-01T00:00:00.000Z', project_id = NULL, squad_id = NULL")
    const projects = count('projects'); const squads = count('squads')
    const resumed = okResult(await apply())
    expect(resumed).toMatchObject({ ok: true, replay: false, status: 'applied' })
    expect(count('projects')).toBe(projects)
    expect(count('squads')).toBe(squads)
    expect(count('mutation_audit_entries')).toBe(1)
  })
})

describe('apply: no takeover, no existence oracle', () => {
  const GENERIC = { ok: false, status: 409, error: 'seed_slug_unavailable' }

  it('an existing project of that slug created by someone else is refused with one generic body, no detail, nothing written', async () => {
    harness.sqlite.exec(`INSERT INTO projects (id, slug, name, goal, created_by_member_id) VALUES ('proj-hidden', 'mumega-com-prj', 'SECRET NAME', 'secret goal', 'adm2')`)
    const accept = await keys()
    const before = dump()
    const r = await call(adm, { seed: seedText, dry_run: false, accept })
    expect(r).toMatchObject(GENERIC)
    expect(JSON.stringify(r)).not.toMatch(/SECRET|proj-hidden|adm2/)
    expect(dump()).toBe(before)
    // team_bootstrap's own refusal path (which writes a failed receipt and names the creator) was never entered.
    expect(count('team_bootstrap_receipts')).toBe(0)
  })

  it('the refusal body is byte-identical whoever created the squatting project (creator or none)', async () => {
    harness.sqlite.exec(`INSERT INTO projects (id, slug, name, goal, created_by_member_id) VALUES ('p-other', 'mumega-com-prj', 'A', 'g', 'adm2')`)
    harness.sqlite.exec(`INSERT INTO projects (id, slug, name, goal) VALUES ('p-legacy', 'other-site-prj', 'B', 'g')`)
    const first = await call(adm, { seed: seedText, dry_run: false, accept: await keys() })
    const otherText = seedText.replace('slug: mumega-com', 'slug: other-site')
    const second = await call(adm, { seed: otherText, dry_run: false, accept: await keys(otherText) })
    expect(first).toMatchObject(GENERIC)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('a project the caller created before (provenance) is adopted, not duplicated', async () => {
    harness.sqlite.exec(`INSERT INTO projects (id, slug, name, goal, created_by_member_id) VALUES ('proj-mine', 'mumega-com-prj', 'Mine', 'g', 'adm')`)
    const res = okResult(await apply())
    expect(res).toMatchObject({ ok: true, replay: false })
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS n FROM projects WHERE slug = 'mumega-com-prj'").get()).toEqual({ n: 1 })
    expect((res.project as { created: boolean }).created).toBe(false)
  })

  it('a project with NULL provenance is never adopted by apply', async () => {
    harness.sqlite.exec(`INSERT INTO projects (id, slug, name, goal) VALUES ('proj-legacy', 'mumega-com-prj', 'Legacy', 'g')`)
    const before = dump()
    expect(await apply(adm)).toMatchObject({ ok: false, status: 409 })
    expect(dump()).toBe(before)
  })
})
