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
const MASTER = 'a1'.repeat(32) // 64 hex chars, the CONNECTOR_MASTER_KEY shape
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
  env = { DB: harness.db, TENANT_SLUG: TENANT, CONNECTOR_MASTER_KEY: MASTER } as Env
}
beforeEach(setup)

const call = (a: AuthContext, args: unknown) => invokeTool(a, env, 'seed_attach', args, 'https://pot.test')
const count = (t: string) => (harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n
const tables = () => (harness.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name)
const counts = (): Record<string, number> => Object.fromEntries(tables().map((t) => [t, count(t)]))
const snapshot = () => JSON.stringify(counts())
const dump = () => JSON.stringify(tables().map((t) => [t, harness.sqlite.prepare(`SELECT * FROM "${t}"`).all()]))
// A successful apply refreshes presence (second-resolution timestamp); compare everything else.
const dumpNoPresence = () => JSON.stringify(tables().filter((t) => t !== 'presence').map((t) => [t, harness.sqlite.prepare(`SELECT * FROM "${t}"`).all()]))

type Out = Awaited<ReturnType<typeof call>>
const okResult = (r: Out): Record<string, unknown> => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`)
  return r.result as Record<string, unknown>
}
async function keys(text = seedText): Promise<string[]> {
  const res = okResult(await call(adm, { seed: text }))
  return (res.requests as Array<{ key: string }>).map((r) => r.key)
}
// Full apply arguments as the human would send them: keys + token come from that member's own dry run.
async function full(a: AuthContext, text = seedText, over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = okResult(await call(a, { seed: text }))
  return {
    seed: text, dry_run: false, accept: (res.requests as Array<{ key: string }>).map((r) => r.key),
    accept_token: res.accept_token, ...over,
  }
}
const apply = async (a: AuthContext = adm, text = seedText, over: Record<string, unknown> = {}) => call(a, await full(a, text, over))

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
    const args = await full(adm)
    const before = dump()
    const r = await call(agentBound, args)
    expect(r).toMatchObject({ ok: false, status: 403, error: 'human_accept_required' })
    expect(dump()).toBe(before)
  })

  it('refuses a non-admin member (the team_bootstrap floor) and writes nothing', async () => {
    const args = await full(adm)
    const before = dump()
    const r = await call(memberOnly, args)
    expect(r).toMatchObject({ ok: false, status: 403, error: 'forbidden' })
    expect(dump()).toBe(before)
  })

  it('refuses when ANY request key is not accepted (409, lists the missing) and writes nothing', async () => {
    const all = await keys()
    const before = dump()
    const r = await call(adm, await full(adm, seedText, { accept: all.slice(1) }))
    expect(r).toMatchObject({ ok: false, status: 409, error: 'requests_not_accepted' })
    expect((r as { detail: { missing: Array<{ key: string }> } }).detail.missing.map((m) => m.key)).toEqual([all[0]])
    expect(dump()).toBe(before)
    // accept omitted entirely is also refused, never read as "accept all"
    expect(await call(adm, await full(adm, seedText, { accept: undefined }))).toMatchObject({ ok: false, status: 400, error: 'invalid_args' })
    expect(dump()).toBe(before)
  })

  it('refuses an accept key the seed does not produce', async () => {
    const all = await keys()
    const before = dump()
    expect(await call(adm, await full(adm, seedText, { accept: [...all, 'gate:000000000000'] })))
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
    // Exactly these tables grow (departments: the shared dept-projects container, first use only;
    // team_bootstrap_receipts: the team_bootstrap core's own receipt row; presence: the framework's
    // post-call refresh, which an apply (unlike a dry run) performs). Nothing else.
    expect(moved.sort()).toEqual(
      ['departments', 'mutation_audit_entries', 'presence', 'project_seeds', 'project_squad_access', 'projects', 'squads', 'team_bootstrap_receipts'],
    )
    expect(after.team_bootstrap_receipts - before.team_bootstrap_receipts).toBe(1)
    expect(after.departments - before.departments).toBe(1)
    for (const t of ['projects', 'squads', 'project_squad_access', 'project_seeds', 'mutation_audit_entries']) expect(after[t] - before[t]).toBe(1)
    // NOTHING that confers authority or capability changed.
    for (const t of ['capabilities', 'gate_grants', 'channel_capability_grants', 'agents', 'agent_keys', 'member_tokens', 'routines', 'routine_runs', 'connectors', 'invites', 'members']) {
      expect(tables(), `${t} must exist (a missing table must fail loudly)`).toContain(t)
      expect(after[t], t).toBe(before[t])
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
    expect(squad).toEqual({ name: 'mumega-com: web', created_by_member_id: 'adm' })
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
    const after1 = dumpNoPresence()
    const again = okResult(await apply())
    expect(again).toMatchObject({ ok: true, replay: true, status: 'applied' })
    expect(dumpNoPresence()).toBe(after1)
  })

  it('YAML vs JSON form of the same seed replays (digest is the key)', async () => {
    okResult(await apply())
    const after1 = dumpNoPresence()
    const { parse } = await import('yaml')
    const asJson = JSON.stringify(parse(base))
    expect(okResult(await apply(adm, asJson))).toMatchObject({ replay: true })
    expect(dumpNoPresence()).toBe(after1)
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
    const args = await full(adm)
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
    const [a, b] = await Promise.all([
      invokeTool(adm, racingEnv, 'seed_attach', args, 'https://pot.test'),
      invokeTool(adm, racingEnv, 'seed_attach', args, 'https://pot.test'),
    ])
    // Exactly one winner; the loser is never success-shaped while the winner may still fail.
    const outs = [a, b]
    expect(outs.filter((r) => r.ok && (r.result as { replay: boolean }).replay === false)).toHaveLength(1)
    const loser = outs.find((r) => !(r.ok && (r.result as { replay: boolean }).replay === false))
    expect(loser).toMatchObject({ ok: false, status: 409, error: 'seed_apply_in_progress' })
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
    const before = dump()
    const r = await apply()
    expect(r).toMatchObject(GENERIC)
    expect(JSON.stringify(r)).not.toMatch(/SECRET|proj-hidden|adm2/)
    expect(dump()).toBe(before)
    // team_bootstrap's own refusal path (which writes a failed receipt and names the creator) was never entered.
    expect(count('team_bootstrap_receipts')).toBe(0)
  })

  it('the refusal body is byte-identical whoever created the squatting project (creator or none)', async () => {
    harness.sqlite.exec(`INSERT INTO projects (id, slug, name, goal, created_by_member_id) VALUES ('p-other', 'mumega-com-prj', 'A', 'g', 'adm2')`)
    harness.sqlite.exec(`INSERT INTO projects (id, slug, name, goal) VALUES ('p-legacy', 'other-site-prj', 'B', 'g')`)
    const first = await apply()
    const otherText = seedText.replace('slug: mumega-com', 'slug: other-site')
    const second = await apply(adm, otherText)
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

// ── round 2 ─────────────────────────────────────────────────────────────────────────────────────
const STALE = '2000-01-01T00:00:00.000Z'
const FUTURE = '2999-01-01T00:00:00.000Z'
async function plantClaim(by: string, lease: string, text = seedText, status = 'applying'): Promise<void> {
  const res = okResult(await call(adm, { seed: text }))
  harness.sqlite.prepare(
    `INSERT INTO project_seeds (id, tenant, project_slug, seed_sha256, canonical_json, requests_json, owner_label, seat_cap,
       applied_by_member_id, applied_at, status, lease_token, lease_expires_at)
     VALUES ('stale-claim', ?, 'mumega-com-prj', ?, '{}', '[]', 'x', 2, ?, ?, ?, 'dead', ?)`,
  ).run(TENANT, res.seed_sha256 as string, by, STALE, status, lease)
}
const claimRows = () => count('project_seeds')

describe('round 2: stale claim never wedges a slug', () => {
  it('(a) after the lease lapses with no project, another admin applies', async () => {
    await plantClaim('adm', STALE)
    expect(okResult(await apply(adm2))).toMatchObject({ ok: true, replay: false, status: 'applied' })
    expect(harness.sqlite.prepare("SELECT applied_by_member_id FROM project_seeds").get()).toEqual({ applied_by_member_id: 'adm2' })
    expect(claimRows()).toBe(1)
  })
  it('(b) the same member with a corrected seed applies', async () => {
    await plantClaim('adm', STALE)
    const corrected = seedText.replace('Publish and maintain', 'Publish and keep')
    expect(okResult(await apply(adm, corrected))).toMatchObject({ ok: true, replay: false })
    expect(claimRows()).toBe(1)
  })
  it('(c) before the lease lapses both are still refused and the row is untouched', async () => {
    await plantClaim('adm', FUTURE)
    const before = dump()
    expect(await apply(adm2)).toMatchObject({ ok: false, status: 409, error: 'seed_slug_unavailable' })
    expect(await apply(adm, seedText.replace('Publish and maintain', 'Publish and keep'))).toMatchObject({ ok: false, error: 'seed_digest_conflict' })
    expect(dump()).toBe(before)
  })
  it('(d) a stale row whose project exists is NOT deleted', async () => {
    harness.sqlite.exec(`INSERT INTO projects (id, slug, name, goal, created_by_member_id) VALUES ('p-adm', 'mumega-com-prj', 'N', 'g', 'adm')`)
    await plantClaim('adm', STALE)
    expect(await apply(adm2)).toMatchObject({ ok: false, error: 'seed_slug_unavailable' })
    expect(claimRows()).toBe(1)
    expect(harness.sqlite.prepare('SELECT id FROM project_seeds').get()).toEqual({ id: 'stale-claim' })
    expect(await apply(adm, seedText.replace('Publish and maintain', 'Publish and keep'))).toMatchObject({ ok: false, error: 'seed_digest_conflict' })
    expect(claimRows()).toBe(1)
  })
})

describe('round 2: no takeover on the resume path, no refusal that writes', () => {
  it('resume over a project another member created is refused generically; row unchanged, no edge, no new receipt', async () => {
    harness.sqlite.exec(`
      INSERT INTO projects (id, slug, name, goal, created_by_member_id) VALUES ('p-adm2', 'mumega-com-prj', 'N', 'g', 'adm2');
      INSERT INTO team_bootstrap_receipts (id, tenant, actor_member_id, slug_base, attempt_no, project_id, squad_id, disposition, invited_count, created_at)
        VALUES ('r1', '${TENANT}', 'adm2', 'mumega-com', 1, 'p-adm2', NULL, 'created', 0, '${STALE}');`)
    await plantClaim('adm', STALE)
    const before = dump()
    const r = await apply(adm)
    expect(r).toMatchObject({ ok: false, status: 409, error: 'seed_slug_unavailable' })
    expect(dump()).toBe(before)
    expect(count('project_squad_access')).toBe(0)
  })

  it('require_provenance: the core adopts only on provenance, never a bare receipt', async () => {
    harness.sqlite.exec(`
      INSERT INTO projects (id, slug, name, goal, created_by_member_id) VALUES ('p-adm2', 'mumega-com-prj', 'N', 'g', 'adm2');
      INSERT INTO team_bootstrap_receipts (id, tenant, actor_member_id, slug_base, attempt_no, project_id, squad_id, disposition, invited_count, created_at)
        VALUES ('r1', '${TENANT}', 'adm2', 'mumega-com', 1, 'p-adm2', NULL, 'created', 0, '${STALE}');`)
    const { teamBootstrap } = await import('../src/org/team-bootstrap')
    const input = { slug_base: 'mumega-com', name: 'N', department: 'dept', bot: { enabled: false }, humans: [] }
    expect(await teamBootstrap(env, adm, { ...input, require_provenance: true })).toMatchObject({ ok: false, error: 'project_slug_taken' })
    // without the flag the bare receipt IS adopted: this is exactly what the flag exists to stop.
    expect(await teamBootstrap(env, adm, input)).toMatchObject({ ok: true })
  })

  it('a foreign project that appears after the claim is never adopted on a bare receipt (require_provenance, end to end)', async () => {
    const args = await full(adm)
    const real = env.DB
    let planted = false
    env = { ...env, DB: new Proxy(real, {
      get(target, key) {
        if (key === 'prepare') {
          return (sql: string) => {
            if (!planted && /^\s*SELECT id FROM departments WHERE slug = \?1 LIMIT 1/.test(sql)) {
              planted = true
              harness.sqlite.exec(`
                INSERT INTO projects (id, slug, name, goal, created_by_member_id) VALUES ('p-late', 'mumega-com-prj', 'N', 'g', 'adm2');
                INSERT INTO team_bootstrap_receipts (id, tenant, actor_member_id, slug_base, attempt_no, project_id, squad_id, disposition, invited_count, created_at)
                  VALUES ('r-late', '${TENANT}', 'adm2', 'mumega-com', 1, 'p-late', NULL, 'created', 0, '${STALE}');`)
            }
            return target.prepare(sql)
          }
        }
        const v = Reflect.get(target, key)
        return typeof v === 'function' ? v.bind(target) : v
      },
    }) } as Env
    expect(await call(adm, args)).toMatchObject({ ok: false, error: 'seed_slug_unavailable' })
    expect(count('project_squad_access')).toBe(0)
    expect(planted).toBe(true)
  })

  it('a foreign squad at <slug>-sqd is refused at the claim: generic body, whole database unchanged', async () => {
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-p', 'dept-projects', 'Projects');
      INSERT INTO squads (id, department_id, slug, name, created_by_member_id) VALUES ('sq-foreign', 'dept-p', 'mumega-com-sqd', 'Foreign', 'adm2');`)
    const args = await full(adm)
    const before = dump()
    expect(await call(adm, args)).toMatchObject({ ok: false, status: 409, error: 'seed_slug_unavailable' })
    expect(dump()).toBe(before)
  })
})

describe('round 2: failures never reserve the slug', () => {
  function failOnce(re: RegExp): void {
    const real = env.DB
    let armed = true
    env = { ...env, DB: new Proxy(real, {
      get(target, key) {
        if (key === 'prepare') {
          return (sql: string) => {
            if (armed && re.test(sql)) { armed = false; throw new Error('injected D1 failure') }
            return target.prepare(sql)
          }
        }
        const v = Reflect.get(target, key)
        return typeof v === 'function' ? v.bind(target) : v
      },
    }) } as Env
  }

  it('an uncaught error before anything is created releases the claim; another admin applies at once', async () => {
    failOnce(/INSERT INTO projects/)
    const r = await apply(adm)
    expect(r).toMatchObject({ ok: false, status: 409, error: 'seed_apply_failed' })
    expect(claimRows()).toBe(0)
    env = { ...env, DB: harness.db } as Env
    expect(okResult(await apply(adm2))).toMatchObject({ ok: true, replay: false })
  })

  it('an error after the project exists leaves a resumable claim for the same member', async () => {
    failOnce(/INSERT INTO squads/)
    expect(await apply(adm)).toMatchObject({ ok: false, error: 'seed_apply_failed' })
    expect(claimRows()).toBe(1)
    env = { ...env, DB: harness.db } as Env
    expect(okResult(await apply(adm))).toMatchObject({ ok: true, replay: false, status: 'applied' })
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS n FROM projects WHERE slug = 'mumega-com-prj'").get()).toEqual({ n: 1 })
  })

  it('in-flight apply is 409 seed_apply_in_progress, never success-shaped', async () => {
    await plantClaim('adm', FUTURE)
    expect(await apply(adm)).toMatchObject({ ok: false, status: 409, error: 'seed_apply_in_progress' })
  })

  it('claim_lost: when the lease is taken before the flip, no receipt is written', async () => {
    const real = env.DB
    env = { ...env, DB: new Proxy(real, {
      get(target, key) {
        if (key === 'prepare') {
          return (sql: string) => {
            const stmt = target.prepare(sql)
            if (!/INSERT INTO team_bootstrap_receipts/.test(sql)) return stmt
            return new Proxy(stmt, { get(st, k) {
              if (k === 'bind') return (...v: unknown[]) => {
                const bound = st.bind(...v)
                return new Proxy(bound, { get(b, kk) {
                  if (kk === 'run') return async (...a: unknown[]) => {
                    harness.sqlite.exec("UPDATE project_seeds SET lease_token = 'stolen'")
                    return (b.run as (...x: unknown[]) => Promise<unknown>)(...a)
                  }
                  const x = Reflect.get(b, kk)
                  return typeof x === 'function' ? x.bind(b) : x
                } })
              }
              const x = Reflect.get(st, k)
              return typeof x === 'function' ? x.bind(st) : x
            } })
          }
        }
        const v = Reflect.get(target, key)
        return typeof v === 'function' ? v.bind(target) : v
      },
    }) } as Env
    expect(await apply(adm)).toMatchObject({ ok: false, status: 409, error: 'seed_apply_in_progress' })
    expect(count('mutation_audit_entries')).toBe(0)
    expect(harness.sqlite.prepare('SELECT status FROM project_seeds').get()).toEqual({ status: 'applying' })
  })
})

describe('round 2: accept_token binds apply to a dry run', () => {
  it('a dry run returns a token to a human member, null to an agent-bound caller', async () => {
    expect(typeof okResult(await call(adm, { seed: seedText })).accept_token).toBe('string')
    expect(okResult(await call(agentBound, { seed: seedText })).accept_token).toBeNull()
  })
  it('apply without or with a malformed token is 409 accept_token_invalid and writes nothing', async () => {
    const before = dump()
    expect(await call(adm, await full(adm, seedText, { accept_token: undefined }))).toMatchObject({ ok: false, status: 409, error: 'accept_token_invalid' })
    expect(await call(adm, await full(adm, seedText, { accept_token: 'nope' }))).toMatchObject({ error: 'accept_token_invalid' })
    expect(dump()).toBe(before)
  })
  it('a token cannot be replayed across members', async () => {
    const mine = await full(adm)
    const before = dump()
    expect(await call(adm2, { ...mine })).toMatchObject({ ok: false, error: 'accept_token_invalid' })
    expect(dump()).toBe(before)
  })
  it('a token cannot be replayed across digests', async () => {
    const mine = await full(adm)
    const other = seedText.replace('Publish and maintain', 'Publish and keep')
    const otherKeys = (okResult(await call(adm, { seed: other })).requests as Array<{ key: string }>).map((r) => r.key)
    const before = dump()
    expect(await call(adm, { ...mine, seed: other, accept: otherKeys })).toMatchObject({ ok: false, error: 'accept_token_invalid' })
    expect(dump()).toBe(before)
  })
  it('an expired token is refused', async () => {
    const { issueAcceptToken } = await import('../src/seeds/accept-token')
    const res = okResult(await call(adm, { seed: seedText }))
    const old = await issueAcceptToken(env, 'adm', res.seed_sha256 as string, Date.now() - 16 * 60_000)
    const args = await full(adm, seedText, { accept_token: old })
    expect(await call(adm, args)).toMatchObject({ ok: false, error: 'accept_token_invalid' })
  })
  it('without a server secret no token is issued and apply fails closed (503)', async () => {
    env = { ...env, CONNECTOR_MASTER_KEY: undefined } as Env
    expect(okResult(await call(adm, { seed: seedText })).accept_token).toBeNull()
    const before = dump()
    expect(await call(adm, await full(adm))).toMatchObject({ ok: false, status: 503, error: 'accept_token_unavailable' })
    expect(dump()).toBe(before)
  })
})

describe('round 3: fencing, recovery, token key derivation', () => {
  // Run `fn` (async) just before the bound statement matching `re` executes its `first()`.
  function stallBefore(re: RegExp, fn: () => Promise<void>): void {
    const real = env.DB
    let fired = false
    env = { ...env, DB: new Proxy(real, {
      get(target, key) {
        if (key === 'prepare') {
          return (sql: string) => {
            const stmt = target.prepare(sql)
            if (!re.test(sql)) return stmt
            return new Proxy(stmt, { get(st, k) {
              if (k === 'bind') return (...v: unknown[]) => {
                const bound = st.bind(...v)
                return new Proxy(bound, { get(b, kk) {
                  if (kk === 'first') return async (...a: unknown[]) => {
                    if (!fired) { fired = true; await fn() }
                    return (b.first as (...x: unknown[]) => Promise<unknown>)(...a)
                  }
                  const x = Reflect.get(b, kk)
                  return typeof x === 'function' ? x.bind(b) : x
                } })
              }
              const x = Reflect.get(st, k)
              return typeof x === 'function' ? x.bind(st) : x
            } })
          }
        }
        const v = Reflect.get(target, key)
        return typeof v === 'function' ? v.bind(target) : v
      },
    }) } as Env
  }

  it('stalled apply: A claims, its lease lapses, B sweeps + claims + finishes; A aborts and creates nothing', async () => {
    const argsA = await full(adm)
    const argsB = await full(adm2)
    const cleanEnv = { ...env } as Env
    stallBefore(/^\s*SELECT id FROM departments WHERE slug = \?1 LIMIT 1/, async () => {
      harness.sqlite.exec(`UPDATE project_seeds SET lease_expires_at = '${STALE}'`) // the clock passes A's lease
      const b = await invokeTool(adm2, cleanEnv, 'seed_attach', argsB, 'https://pot.test')
      expect(b).toMatchObject({ ok: true })
    })
    const a = await call(adm, argsA)
    expect(a).toMatchObject({ ok: false, status: 409, error: 'seed_apply_in_progress' })
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS n FROM projects WHERE slug = 'mumega-com-prj'").get()).toEqual({ n: 1 })
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS n FROM squads WHERE slug = 'mumega-com-sqd'").get()).toEqual({ n: 1 })
    expect(count('project_seeds')).toBe(1)
    expect(harness.sqlite.prepare('SELECT applied_by_member_id, status FROM project_seeds').get()).toEqual({ applied_by_member_id: 'adm2', status: 'applied' })
    expect(harness.sqlite.prepare("SELECT created_by_member_id FROM projects WHERE slug = 'mumega-com-prj'").get()).toEqual({ created_by_member_id: 'adm2' })
    expect(count('team_bootstrap_receipts')).toBe(1) // A's refused attempt wrote no failed receipt
    expect(count('mutation_audit_entries')).toBe(1)
  })

  it('fence is token-bound: a claim whose lease token was replaced aborts before creating anything', async () => {
    const args = await full(adm)
    stallBefore(/^\s*SELECT id FROM departments WHERE slug = \?1 LIMIT 1/, async () => {
      harness.sqlite.exec("UPDATE project_seeds SET lease_token = 'replaced'")
    })
    expect(await call(adm, args)).toMatchObject({ ok: false, status: 409, error: 'seed_apply_in_progress' })
    expect(count('projects')).toBe(0)
    expect(count('team_bootstrap_receipts')).toBe(0)
  })

  it('the split state (project under A, lapsed claim under B) is recoverable by A, creating nothing twice', async () => {
    harness.sqlite.exec(`INSERT INTO projects (id, slug, name, goal, created_by_member_id) VALUES ('p-a', 'mumega-com-prj', 'N', 'g', 'adm')`)
    await plantClaim('adm2', STALE)
    const projects = count('projects')
    expect(okResult(await apply(adm))).toMatchObject({ ok: true, replay: false, status: 'applied' })
    expect(count('projects')).toBe(projects)
    expect(harness.sqlite.prepare('SELECT applied_by_member_id, status FROM project_seeds').get()).toEqual({ applied_by_member_id: 'adm', status: 'applied' })
    expect(count('mutation_audit_entries')).toBe(1)
  })

  it('recovery is not takeover: B cannot take a lapsed claim over a project A created, and a live lease is untouched', async () => {
    harness.sqlite.exec(`INSERT INTO projects (id, slug, name, goal, created_by_member_id) VALUES ('p-a', 'mumega-com-prj', 'N', 'g', 'adm')`)
    await plantClaim('adm', STALE)
    const before = dump()
    expect(await apply(adm2)).toMatchObject({ ok: false, error: 'seed_slug_unavailable' })
    expect(dump()).toBe(before)
    harness.sqlite.exec(`UPDATE project_seeds SET applied_by_member_id = 'adm2', lease_expires_at = '${FUTURE}'`)
    const live = dump()
    expect(await apply(adm)).toMatchObject({ ok: false })
    expect(dump()).toBe(live)
  })

  it('tokens minted with the master key used directly no longer verify (HKDF-derived key)', async () => {
    const res = okResult(await call(adm, { seed: seedText }))
    const issued = Date.now()
    const raw = new Uint8Array(32)
    for (let i = 0; i < 32; i++) raw[i] = parseInt(MASTER.slice(i * 2, i * 2 + 2), 16)
    const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`mupot:seed-accept:v1|${res.seed_sha256}|adm|${issued}`))
    const old = `${issued}.${[...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')}`
    const before = dump()
    expect(await call(adm, await full(adm, seedText, { accept_token: old }))).toMatchObject({ ok: false, error: 'accept_token_invalid' })
    expect(dump()).toBe(before)
  })

  it('a malformed master key issues no token and fails closed', async () => {
    env = { ...env, CONNECTOR_MASTER_KEY: 'not-hex' } as Env
    expect(okResult(await call(adm, { seed: seedText })).accept_token).toBeNull()
    expect(await call(adm, await full(adm))).toMatchObject({ ok: false, status: 503, error: 'accept_token_unavailable' })
  })
})

describe('round 3b: races on the create path, accept-token edges', () => {
  // Plant SQL just before the statement matching `re` is prepared: the row appears AFTER the lookup.
  function plantBefore(re: RegExp, sql: string): void {
    const real = env.DB
    let done = false
    env = { ...env, DB: new Proxy(real, {
      get(target, key) {
        if (key === 'prepare') {
          return (q: string) => {
            if (!done && re.test(q)) { done = true; harness.sqlite.exec(sql) }
            return target.prepare(q)
          }
        }
        const v = Reflect.get(target, key)
        return typeof v === 'function' ? v.bind(target) : v
      },
    }) } as Env
  }

  it('project race: a competitor project created just before our INSERT is never adopted', async () => {
    plantBefore(/INSERT INTO projects/, `INSERT INTO projects (id, slug, name, goal, created_by_member_id) VALUES ('p-race', 'mumega-com-prj', 'R', 'g', 'adm2')`)
    const r = await apply(adm)
    expect(r).toMatchObject({ ok: false, status: 409, error: 'seed_slug_unavailable' })
    expect(count('project_squad_access')).toBe(0)
    expect(count('mutation_audit_entries')).toBe(0)
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS n FROM project_seeds WHERE project_id IS NOT NULL").get()).toEqual({ n: 0 })
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS n FROM squads WHERE slug = 'mumega-com-sqd'").get()).toEqual({ n: 0 })
  })

  it('squad race: a competitor squad created just before our INSERT is never adopted and gains no admin edge', async () => {
    plantBefore(/INSERT INTO squads/, `INSERT INTO squads (id, department_id, slug, name, created_by_member_id)
      SELECT 'sq-race', id, 'mumega-com-sqd', 'Racer', 'adm2' FROM departments WHERE slug = 'dept-projects'`)
    const r = await apply(adm)
    expect(r).toMatchObject({ ok: false, status: 409, error: 'seed_slug_unavailable' })
    expect(count('project_squad_access')).toBe(0)
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS n FROM project_seeds WHERE squad_id IS NOT NULL").get()).toEqual({ n: 0 })
    expect(count('mutation_audit_entries')).toBe(0)
  })

  it('squad race: a home squad the caller itself created is still refused (home fence on the race branch)', async () => {
    plantBefore(/INSERT INTO squads/, `INSERT INTO squads (id, department_id, slug, name, kind, created_by_member_id)
      SELECT 'sq-home', id, 'mumega-com-sqd', 'Home', 'home', 'adm' FROM departments WHERE slug = 'dept-projects'`)
    expect(await apply(adm)).toMatchObject({ ok: false, error: 'seed_slug_unavailable' })
    expect(count('project_squad_access')).toBe(0)
  })

  it('require_provenance also disables the org-admin adopt override (project and squad limbs)', async () => {
    harness.sqlite.exec(`INSERT INTO projects (id, slug, name, goal, created_by_member_id) VALUES ('p-x', 'mumega-com-prj', 'X', 'g', 'adm2')`)
    const { teamBootstrap } = await import('../src/org/team-bootstrap')
    const base = { slug_base: 'mumega-com', name: 'N', department: 'dept', bot: { enabled: false }, humans: [], adopt: true }
    expect(await teamBootstrap(env, adm, { ...base, require_provenance: true })).toMatchObject({ ok: false, error: 'project_slug_taken' })
    harness.sqlite.exec(`DELETE FROM project_squad_access; DELETE FROM projects WHERE id = 'p-x';
      INSERT INTO squads (id, department_id, slug, name, created_by_member_id) VALUES ('sq-x', 'dept', 'mumega-com-sqd', 'X', 'adm2')`)
    expect(await teamBootstrap(env, adm, { ...base, require_provenance: true })).toMatchObject({ ok: false, error: 'squad_slug_taken' })
    expect(count('project_squad_access')).toBe(0)
  })

  it('the same race without require_provenance still adopts (non-seed callers unchanged)', async () => {
    plantBefore(/INSERT INTO projects/, `INSERT INTO projects (id, slug, name, goal, created_by_member_id) VALUES ('p-race', 'mumega-com-prj', 'R', 'g', 'adm2')`)
    const { teamBootstrap } = await import('../src/org/team-bootstrap')
    expect(await teamBootstrap(env, adm, { slug_base: 'mumega-com', name: 'N', department: 'dept', bot: { enabled: false }, humans: [] })).toMatchObject({ ok: true })
  })

  it('a flip that loses its claim after creating the project is recoverable by the creator once the other claim lapses', async () => {
    const real = env.DB
    env = { ...env, DB: new Proxy(real, {
      get(target, key) {
        if (key === 'prepare') {
          return (sql: string) => {
            const stmt = target.prepare(sql)
            if (!/INSERT INTO team_bootstrap_receipts/.test(sql)) return stmt
            return new Proxy(stmt, { get(st, k) {
              if (k === 'bind') return (...v: unknown[]) => {
                const bound = st.bind(...v)
                return new Proxy(bound, { get(b, kk) {
                  if (kk === 'run') return async (...a: unknown[]) => {
                    harness.sqlite.exec(`UPDATE project_seeds SET lease_token = 'stolen', applied_by_member_id = 'adm2', lease_expires_at = '${STALE}'`)
                    return (b.run as (...x: unknown[]) => Promise<unknown>)(...a)
                  }
                  const x = Reflect.get(b, kk)
                  return typeof x === 'function' ? x.bind(b) : x
                } })
              }
              const x = Reflect.get(st, k)
              return typeof x === 'function' ? x.bind(st) : x
            } })
          }
        }
        const v = Reflect.get(target, key)
        return typeof v === 'function' ? v.bind(target) : v
      },
    }) } as Env
    expect(await apply(adm)).toMatchObject({ ok: false, status: 409, error: 'seed_apply_in_progress' })
    env = { ...env, DB: harness.db } as Env
    expect(okResult(await apply(adm))).toMatchObject({ ok: true, replay: false, status: 'applied' })
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS n FROM projects WHERE slug = 'mumega-com-prj'").get()).toEqual({ n: 1 })
    expect(harness.sqlite.prepare('SELECT applied_by_member_id, status FROM project_seeds').get()).toEqual({ applied_by_member_id: 'adm', status: 'applied' })
  })

  it('accept-token skew boundary: +60 s accepted, +60.001 s refused', async () => {
    const { issueAcceptToken, verifyAcceptToken } = await import('../src/seeds/accept-token')
    const now = 1_800_000_000_000
    const sha = 'a'.repeat(64)
    const ok = await issueAcceptToken(env, 'adm', sha, now + 60_000)
    const bad = await issueAcceptToken(env, 'adm', sha, now + 60_001)
    expect(await verifyAcceptToken(env, 'adm', sha, ok, now)).toBe('ok')
    expect(await verifyAcceptToken(env, 'adm', sha, bad, now)).toBe('invalid')
  })

  it('accept-token has one spelling: a leading-zero timestamp is refused', async () => {
    const { issueAcceptToken, verifyAcceptToken } = await import('../src/seeds/accept-token')
    const now = 1_800_000_000_000
    const sha = 'b'.repeat(64)
    const t = await issueAcceptToken(env, 'adm', sha, now)
    expect(await verifyAcceptToken(env, 'adm', sha, t, now)).toBe('ok')
    expect(await verifyAcceptToken(env, 'adm', sha, `0${t}`, now)).toBe('invalid')
  })
})

describe('round 5', () => {
  function hookRun(re: RegExp, fn: () => Promise<void>): void {
    const real = env.DB
    let fired = false
    env = { ...env, DB: new Proxy(real, {
      get(target, key) {
        if (key === 'prepare') {
          return (sql: string) => {
            const stmt = target.prepare(sql)
            if (!re.test(sql)) return stmt
            return new Proxy(stmt, { get(st, k) {
              if (k === 'bind') return (...v: unknown[]) => {
                const bound = st.bind(...v)
                return new Proxy(bound, { get(b, kk) {
                  if (kk === 'run' || kk === 'first') return async (...a: unknown[]) => {
                    if (!fired) { fired = true; await fn() }
                    return (b[kk] as (...x: unknown[]) => Promise<unknown>)(...a)
                  }
                  const x = Reflect.get(b, kk)
                  return typeof x === 'function' ? x.bind(b) : x
                } })
              }
              const x = Reflect.get(st, k)
              return typeof x === 'function' ? x.bind(st) : x
            } })
          }
        }
        const v = Reflect.get(target, key)
        return typeof v === 'function' ? v.bind(target) : v
      },
    }) } as Env
  }
  const DEPT_FIND = /^\s*SELECT id FROM departments WHERE slug = \?1 LIMIT 1/

  it('FIX-1: an apply fenced out of its flip returns 409 in_progress, not a success; exactly one audit receipt', async () => {
    const args = await full(adm)
    const resumerArgs = await full(adm)
    const clean = { ...env } as Env
    const real = env.DB
    let armed = false
    let fired = false
    env = { ...env, DB: new Proxy(real, {
      get(target, key) {
        if (key === 'prepare') {
          return (sql: string) => {
            if (/UPDATE project_seeds SET status = 'applied'/.test(sql)) armed = true // the flip batch is next
            return target.prepare(sql)
          }
        }
        if (key === 'batch') {
          return async (stmts: unknown[]) => {
            if (armed && !fired) {
              fired = true
              // A resume by the same member (new lease token) commits before the original reaches its flip.
              harness.sqlite.exec(`UPDATE project_seeds SET lease_expires_at = '${STALE}'`)
              expect(await invokeTool(adm, clean, 'seed_attach', resumerArgs, 'https://pot.test')).toMatchObject({ ok: true })
            }
            return (target.batch as (s: unknown[]) => Promise<unknown>)(stmts)
          }
        }
        const v = Reflect.get(target, key)
        return typeof v === 'function' ? v.bind(target) : v
      },
    }) } as Env
    expect(await call(adm, args)).toMatchObject({ ok: false, status: 409, error: 'seed_apply_in_progress' })
    expect(fired).toBe(true)
    expect(count('mutation_audit_entries')).toBe(1)
    expect(harness.sqlite.prepare('SELECT status FROM project_seeds').get()).toEqual({ status: 'applied' })
  })

  it('FIX-2: a pre-existing weaker edge is refused (footprint incompatible), never finalized as applied', async () => {
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-p', 'dept-projects', 'Projects');
      INSERT INTO projects (id, slug, name, goal, created_by_member_id) VALUES ('p-mine', 'mumega-com-prj', 'N', 'g', 'adm');
      INSERT INTO squads (id, department_id, slug, name, created_by_member_id) VALUES ('sq-mine', 'dept-p', 'mumega-com-sqd', 'S', 'adm');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('p-mine', 'sq-mine', 'read');`)
    const r = await apply(adm)
    expect(r).toMatchObject({ ok: false, status: 409, error: 'seed_footprint_incompatible', detail: { existing_edge: 'read' } })
    expect(harness.sqlite.prepare('SELECT status FROM project_seeds').get()).toEqual({ status: 'applying' })
    expect(count('mutation_audit_entries')).toBe(0)
    expect(harness.sqlite.prepare('SELECT access_level FROM project_squad_access').get()).toEqual({ access_level: 'read' })
  })

  it('FIX-3: a caller-owned ARCHIVED project or squad is refused generically at the claim, nothing written', async () => {
    harness.sqlite.exec(`INSERT INTO projects (id, slug, name, goal, created_by_member_id, status) VALUES ('p-arch', 'mumega-com-prj', 'N', 'g', 'adm', 'archived')`)
    const before = dump()
    expect(await apply(adm)).toMatchObject({ ok: false, error: 'seed_slug_unavailable' })
    expect(dump()).toBe(before)
    harness.sqlite.exec(`DELETE FROM projects WHERE id = 'p-arch';
      INSERT INTO departments (id, slug, name) VALUES ('dept-p', 'dept-projects', 'Projects');
      INSERT INTO squads (id, department_id, slug, name, created_by_member_id, status) VALUES ('sq-arch', 'dept-p', 'mumega-com-sqd', 'S', 'adm', 'archived')`)
    const before2 = dump()
    expect(await apply(adm)).toMatchObject({ ok: false, error: 'seed_slug_unavailable' })
    expect(dump()).toBe(before2)
  })

  it('FIX-4: a foreign project that appears after the claim releases the claim; the slug is not reserved', async () => {
    const args = await full(adm)
    hookRun(DEPT_FIND, async () => {
      harness.sqlite.exec(`INSERT INTO projects (id, slug, name, goal, created_by_member_id) VALUES ('p-f', 'mumega-com-prj', 'F', 'g', 'adm2')`)
    })
    expect(await call(adm, args)).toMatchObject({ ok: false, error: 'seed_slug_unavailable' })
    expect(claimRows()).toBe(0)
    env = { ...env, DB: harness.db } as Env
    harness.sqlite.exec(`DELETE FROM projects WHERE id = 'p-f'`)
    const other = seedText.replace('Publish and maintain', 'Publish and keep')
    expect(okResult(await apply(adm, other))).toMatchObject({ ok: true, replay: false })
  })

  it('FIX-5: NFC-equivalent / trailing-space variants of one seed persist identically whichever form applies first', async () => {
    const variant = (name: string, owner: string, action: string) =>
      seedText.replace('name: Mumega.com', `name: "${name}"`).replace('owner: site-owner', `owner: "${owner}"`).replace('action: publish_post', `action: "${action}"`)
    const composed = variant('Café Site', 'René', 'publísh')
    const decomposed = variant('Café Site ', 'René ', 'publísh')
    async function snapshotAfter(text: string) {
      setup()
      okResult(await apply(adm, text))
      return {
        seed: harness.sqlite.prepare('SELECT seed_sha256, canonical_json, requests_json, owner_label FROM project_seeds').get(),
        project: harness.sqlite.prepare("SELECT name FROM projects WHERE slug = 'mumega-com-prj'").get(),
        squad: harness.sqlite.prepare("SELECT name FROM squads WHERE slug = 'mumega-com-sqd'").get(),
      }
    }
    const a = await snapshotAfter(composed)
    const b = await snapshotAfter(decomposed)
    expect(b).toEqual(a)
    expect((a.project as { name: string }).name).toBe('Café Site')
  })

  it('FIX-6: identical requests get distinct keys; path and type direct surfaces on one target do not collapse', async () => {
    const { parse } = await import('yaml')
    const doc = parse(base) as Record<string, unknown>
    doc.surfaces = [{ path: 'wp.media', mode: 'direct' }, { type: 'wp.media', mode: 'direct' }]
    doc.risk = { class: 'medium', allow_direct: ['wp.media'] }
    const dupText = JSON.stringify(doc)
    const all = await keys(dupText)
    const direct = all.filter((k) => k.startsWith('direct_surface:'))
    expect(direct).toHaveLength(2)
    expect(new Set(all).size).toBe(all.length)
    expect(direct[1]).toBe(`${direct[0]}#2`)
    const r = await call(adm, await full(adm, dupText, { accept: all.filter((k) => k !== direct[1]) }))
    expect(r).toMatchObject({ ok: false, error: 'requests_not_accepted', detail: { missing: [{ key: direct[1] }] } })
    expect(okResult(await apply(adm, dupText))).toMatchObject({ ok: true })
    // non-duplicate seeds keep plain keys
    expect((await keys()).every((k) => !k.includes('#'))).toBe(true)
  })

  it('FIX-7: a dry run writes nothing at all (presence included); an apply refreshes presence', async () => {
    const before = dump()
    okResult(await call(adm, { seed: seedText }))
    expect(dump()).toBe(before)
    expect(count('presence')).toBe(0)
    okResult(await apply(adm))
    expect(count('presence')).toBe(1)
  })
})
