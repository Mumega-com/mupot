// GitHub webhook → ProjectOffice Notice (src/projects/office-intake.ts), against the real migrated D1 schema.
//
// The office on the other side is the REAL core (checkNotice + applyNotice + verifyOfficeBinding) over node:sqlite; the
// same facade running inside workerd is covered by workers/project-office/test/. Nothing here mocks a predicate:
// the repo → project mapping, the installation check and the tenant stamp all run against D1 rows.

import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { githubInboundApp } from '../src/integrations/github-routes'
import { NOTICE_CONTRACT_VERSION, buildNotice, checkNotice } from '../src/projects/office-contract'
import {
  applyNotice,
  ensureOfficeSchema,
  sweepRelinquishedScopes,
  verifyNoticeScope,
  verifyOfficeBinding,
  type NoticeResult,
  type OfficeEnv,
  type OfficeSql,
} from '../src/projects/office-core'
import { resolveRepoProject, routeGitHubNoticeToOffice } from '../src/projects/office-intake'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'pot-a'
const INSTALL = '4242'
const NOW = Date.parse('2026-10-22T09:00:00.000Z')

let harness: SqliteD1Harness
let offices: Map<string, OfficeSql>
let officeCalls: string[]
let kv: Map<string, string>
let officeThrows = false

function memoryOffice(name: string): OfficeSql {
  let sql = offices.get(name)
  if (!sql) {
    const db = new DatabaseSync(':memory:')
    sql = {
      exec: (q, ...b) => void db.prepare(q).run(...(b as (string | number | null)[])),
      all: (q, ...b) => db.prepare(q).all(...(b as (string | number | null)[])) as Record<string, unknown>[],
    }
    ensureOfficeSchema(sql)
    offices.set(name, sql)
  }
  return sql
}

/** A Durable Object namespace whose stubs run the real notice path: binding check, strict check, applyNotice. */
function namespace(env: () => OfficeEnv): DurableObjectNamespace {
  return {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      async notice(input: unknown): Promise<NoticeResult> {
        officeCalls.push(id.name)
        if (officeThrows) throw new Error('office down')
        const b = await verifyOfficeBinding(env(), id.name)
        if (!b.ok) return { ok: false, error: 'unbound', reason: b.reason }
        const c = await checkNotice(input, NOW)
        if (!c.ok) return { ok: false, error: 'invalid_notice', problem: c.problem }
        if (c.notice.tenant !== b.tenant) return { ok: false, error: 'invalid_notice', problem: 'tenant' }
        const scope = await verifyNoticeScope(env(), b.projectId, c.notice) // the facade asks D1 too
        if (!scope.ok) return { ok: false, error: 'invalid_notice', problem: scope.reason }
        return { ok: true, outcome: applyNotice(memoryOffice(id.name), c.notice, NOW) }
      },
    }),
  } as unknown as DurableObjectNamespace
}

function makeEnv(over: Partial<Record<string, unknown>> = {}): Env {
  const base = {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    PROJECT_OFFICE: '1',
    SESSIONS: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => void kv.set(k, v) },
    GITHUB_WEBHOOK_SECRET: 'webhook-secret',
    ...over,
  } as Record<string, unknown>
  const env = base as unknown as Env
  if (!('PROJECT_OFFICE_DO' in over)) base.PROJECT_OFFICE_DO = namespace(() => env as unknown as OfficeEnv)
  return env
}

function fixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', 'office', 'github-pull-request-opened.json'), 'utf8')) as Record<string, unknown>
}

/** A pull_request delivery for `repo`, version `sha`, updated `at` seconds after 08:00. */
function pr(repo: string, over: { action?: string; sha?: string; at?: number; title?: string; installation?: unknown; extra?: Record<string, unknown> } = {}): Record<string, unknown> {
  const f = fixture() as { pull_request: Record<string, unknown>; installation: unknown }
  return {
    ...f,
    action: over.action ?? 'synchronize',
    pull_request: {
      ...f.pull_request,
      title: over.title ?? 'feat: thing',
      updated_at: new Date(Date.parse('2026-10-22T08:00:00.000Z') + (over.at ?? 0) * 1000).toISOString().replace('.000Z', 'Z'),
      head: { sha: over.sha ?? 'sha-1' },
      html_url: `https://github.com/${repo}/pull/7`,
    },
    repository: { full_name: repo },
    installation: 'installation' in over ? over.installation : { id: Number(INSTALL) },
    ...over.extra,
  }
}

const route = (env: Env, payload: unknown, delivery = 'd-1', event = 'pull_request') =>
  routeGitHubNoticeToOffice(env, event, payload, delivery, NOW)

const drops = (): Record<string, string> =>
  Object.fromEntries([...kv].filter(([k]) => k.startsWith('office-intake-drop:')).map(([k, v]) => [k.split(':')[1] as string, v]))

const itemsOf = (project: string) =>
  memoryOffice(`${TENANT}:${project}`).all('SELECT item_id, connection, version, title, url, kind FROM office_items')

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  offices = new Map()
  officeCalls = []
  kv = new Map()
  officeThrows = false
  harness.sqlite.exec(`
    INSERT INTO projects (id, slug, name, goal, status, repo_url) VALUES ('p1', 'p1', 'Project One', 'Ship', 'active', 'https://github.com/Mumega/mupot.git');
    INSERT INTO projects (id, slug, name, goal, status, repo_url) VALUES ('p2', 'p2', 'Project Two', 'Ship', 'active', 'git@github.com:mumega/mcpwp.git');
    INSERT INTO projects (id, slug, name, goal, status, repo_url) VALUES ('p-none', 'p-none', 'No repo', 'Ship', 'active', NULL);
    INSERT INTO github_installations (tenant, installation_id, account_login, installed_at, updated_at)
      VALUES ('${TENANT}', '${INSTALL}', NULL, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
  `)
})

describe('flag off: inert', () => {
  it.each([undefined, '0', 'true', ''])('PROJECT_OFFICE=%j: returns before D1, KV or the namespace is touched', async (flag) => {
    const boom = new Proxy({}, { get: () => { throw new Error('touched') } })
    const env = makeEnv({ PROJECT_OFFICE: flag, DB: boom, SESSIONS: boom })
    expect(await route(env, pr('mumega/mupot'))).toEqual({ routed: false, reason: 'flag_off' })
  })

  it('no namespace bound: off, even with the flag on', async () => {
    const env = makeEnv({ PROJECT_OFFICE_DO: undefined })
    expect(await route(env, pr('mumega/mupot'))).toEqual({ routed: false, reason: 'flag_off' })
  })

  it('events other than pull_request and issues are ignored without a D1 read', async () => {
    const boom = new Proxy({}, { get: () => { throw new Error('touched') } })
    const env = makeEnv({ DB: boom })
    for (const ev of ['push', 'workflow_run', 'ping', 'issue_comment', 'projects_v2_item']) {
      expect(await route(env, pr('mumega/mupot'), 'd', ev), ev).toEqual({ routed: false, reason: 'event_ignored' })
    }
  })
})

describe('actions the office does not follow are dropped before any I/O, and are not counted', () => {
  it.each([
    ['pull_request', 'assigned'], ['pull_request', 'review_requested'], ['pull_request', 'converted_to_draft'],
    ['pull_request', 'locked'], ['pull_request', 'auto_merge_enabled'], ['issues', 'assigned'], ['issues', 'milestoned'],
    ['issues', 'synchronize'], ['pull_request', ''],
  ])('%s.%s: event_ignored, no D1, no KV, no namespace, no counter', async (event, action) => {
    const boom = new Proxy({}, { get: () => { throw new Error('touched') } })
    const env = makeEnv({ DB: boom, SESSIONS: boom })
    expect(await route(env, pr('mumega/mupot', { action }), 'd', event)).toEqual({ routed: false, reason: 'event_ignored' })
  })

  it('a payload with no action at all is ignored the same way', async () => {
    const boom = new Proxy({}, { get: () => { throw new Error('touched') } })
    const payload = pr('mumega/mupot')
    delete payload.action
    expect(await route(makeEnv({ DB: boom, SESSIONS: boom }), payload)).toEqual({ routed: false, reason: 'event_ignored' })
  })

  it('an ignored action on an UNKNOWN repo is not a drop; a followed action on it is', async () => {
    const env = makeEnv()
    await route(env, pr('mumega/not-connected', { action: 'assigned' }), 'd-1')
    expect(drops()).toEqual({})
    await route(env, pr('mumega/not-connected', { action: 'opened' }), 'd-2')
    expect(drops()).toEqual({ unknown_repo: '1' })
  })
})

describe('a connected repo reaches its project’s office as a validated Notice', () => {
  it('records the item in the owning project’s office only', async () => {
    const r = await route(makeEnv(), pr('mumega/mupot', { action: 'opened', sha: 'sha-1', title: 'feat: thing' }))
    expect(r).toEqual({ routed: true, project_id: 'p1', outcome: 'applied' })
    expect(itemsOf('p1')).toEqual([
      { item_id: 'PR_kwDOExample2113', connection: INSTALL, version: 'sha-1', title: 'feat: thing', url: 'https://github.com/mumega/mupot/pull/7', kind: 'pr' },
    ])
    expect(officeCalls).toEqual(['pot-a:p1'])
    expect(drops()).toEqual({})
  })

  it('an issues event becomes an issue notice (version = updated_at)', async () => {
    const payload = {
      action: 'opened',
      issue: { node_id: 'I_1', html_url: 'https://github.com/mumega/mcpwp/issues/9', title: 'Bug', updated_at: '2026-10-22T08:30:00Z' },
      repository: { full_name: 'mumega/mcpwp' },
      sender: { login: 'someone' },
      installation: { id: 4242 },
    }
    expect(await route(makeEnv(), payload, 'd-9', 'issues')).toEqual({ routed: true, project_id: 'p2', outcome: 'applied' })
    expect(itemsOf('p2')).toMatchObject([{ kind: 'issue', version: '2026-10-22T08:30:00.000Z', title: 'Bug' }])
  })

  it('opened, synchronize and closed all land; closed does not rewind the item', async () => {
    const env = makeEnv()
    expect((await route(env, pr('mumega/mupot', { action: 'opened', at: 0 }), 'd-1')).routed).toBe(true)
    expect(await route(env, pr('mumega/mupot', { action: 'synchronize', sha: 'sha-2', at: 60 }), 'd-2')).toMatchObject({ outcome: 'applied' })
    expect(await route(env, pr('mumega/mupot', { action: 'closed', sha: 'sha-2', at: 120 }), 'd-3')).toMatchObject({ outcome: 'applied' })
    expect(itemsOf('p1')).toMatchObject([{ version: 'sha-2' }])
  })

  it('every spelling of the project’s repo_url finds it (https .git, scp, mixed case)', async () => {
    const env = makeEnv()
    expect(await route(env, pr('mumega/mupot'), 'a')).toMatchObject({ project_id: 'p1' }) // https://github.com/Mumega/mupot.git
    expect(await route(env, pr('MUMEGA/MCPWP'), 'b')).toMatchObject({ project_id: 'p2' }) // git@github.com:mumega/mcpwp.git
  })

  it('a repo on the project_repos allow-list is connected too', async () => {
    harness.sqlite.exec(`INSERT INTO project_repos (project_id, repo_key) VALUES ('p-none', 'github:mumega/extra')`)
    expect(await route(makeEnv(), pr('mumega/Extra'))).toMatchObject({ routed: true, project_id: 'p-none' })
  })
})

describe('the payload never selects the tenant or the project', () => {
  it('tenant, project and connection fields in the payload are ignored: they come from this pot and D1', async () => {
    const env = makeEnv()
    const payload = pr('mumega/mupot', {
      action: 'opened',
      extra: { tenant: 'attacker-pot', project_id: 'p2', project: 'p2', connection: 'evil', tenant_slug: 'attacker-pot' },
    })
    expect(await route(env, payload)).toMatchObject({ routed: true, project_id: 'p1' })
    expect(offices.has('pot-a:p2')).toBe(false)
    const held = memoryOffice('pot-a:p1').all('SELECT connection FROM office_items')
    expect(held).toEqual([{ connection: INSTALL }]) // the installation D1 recorded, not the payload's
  })

  it('an installation id that is not this pot’s is dropped and counted (another tenant’s event)', async () => {
    expect(await route(makeEnv(), pr('mumega/mupot', { installation: { id: 9999 } }))).toEqual({ routed: false, reason: 'installation_mismatch' })
    expect(drops()).toEqual({ installation_mismatch: '1' })
    expect(officeCalls).toEqual([])
  })

  it.each([[undefined], [null], [{}], [{ id: null }], [{ id: { toString: 'x' } }], [{ id: '4242 ' }]])('installation %j is dropped', async (inst) => {
    const r = await route(makeEnv(), pr('mumega/mupot', { installation: inst }))
    expect(r).toEqual({ routed: false, reason: 'installation_mismatch' })
    expect(officeCalls).toEqual([])
  })

  it('a pot with no recorded installation routes nothing', async () => {
    harness.sqlite.exec(`DELETE FROM github_installations`)
    expect(await route(makeEnv(), pr('mumega/mupot'))).toEqual({ routed: false, reason: 'no_installation' })
    expect(drops()).toEqual({ no_installation: '1' })
  })
})

describe('an unknown repo is dropped with a counter, never an error', () => {
  it('unknown repo: resolves normally, counts, creates no office', async () => {
    const env = makeEnv()
    expect(await route(env, pr('mumega/not-connected'))).toEqual({ routed: false, reason: 'unknown_repo' })
    expect(await route(env, pr('mumega/not-connected'), 'd-2')).toEqual({ routed: false, reason: 'unknown_repo' })
    expect(drops()).toEqual({ unknown_repo: '2' })
    expect(offices.size).toBe(0)
    expect(officeCalls).toEqual([])
  })

  it('a project with no repo, or an archived one, owns nothing', async () => {
    harness.sqlite.exec(`UPDATE projects SET status = 'archived' WHERE id = 'p1'`)
    expect(await route(makeEnv(), pr('mumega/mupot'))).toEqual({ routed: false, reason: 'unknown_repo' })
    harness.sqlite.exec(`UPDATE projects SET status = 'active', archived_at = '2026-10-01T00:00:00Z' WHERE id = 'p1'`)
    expect(await route(makeEnv(), pr('mumega/mupot'), 'd-2')).toEqual({ routed: false, reason: 'unknown_repo' })
  })

  it('a project_repos row of an archived project owns nothing (both ways a project is archived)', async () => {
    harness.sqlite.exec(`
      INSERT INTO projects (id, slug, name, goal, status) VALUES ('p-arch-a', 'p-arch-a', 'A', 'x', 'active');
      INSERT INTO projects (id, slug, name, goal, status) VALUES ('p-arch-b', 'p-arch-b', 'B', 'x', 'active');
      INSERT INTO project_repos (project_id, repo_key) VALUES ('p-arch-a', 'github:mumega/listed-a');
      INSERT INTO project_repos (project_id, repo_key) VALUES ('p-arch-b', 'github:mumega/listed-b');
    `)
    expect(await route(makeEnv(), pr('mumega/listed-a'), 'd-1')).toMatchObject({ routed: true, project_id: 'p-arch-a' }) // control: live
    harness.sqlite.exec(`UPDATE projects SET status = 'archived' WHERE id = 'p-arch-a'`)
    harness.sqlite.exec(`UPDATE projects SET archived_at = '2026-10-01T00:00:00Z' WHERE id = 'p-arch-b'`)
    expect(await route(makeEnv(), pr('mumega/listed-a'), 'd-2')).toEqual({ routed: false, reason: 'unknown_repo' })
    expect(await route(makeEnv(), pr('mumega/listed-b'), 'd-3')).toEqual({ routed: false, reason: 'unknown_repo' })
  })

  it('a wildcard-looking repo name matches only itself (lookup is by canonical key, not a pattern)', async () => {
    harness.sqlite.exec(`INSERT INTO projects (id, slug, name, goal, status, repo_url) VALUES ('p3', 'p3', 'P3', 'x', 'active', 'https://github.com/mumega/a_b')`)
    expect(await route(makeEnv(), pr('mumega/aXb'))).toEqual({ routed: false, reason: 'unknown_repo' })
    expect(await route(makeEnv(), pr('mumega/a_b'), 'd-2')).toMatchObject({ routed: true, project_id: 'p3' })
  })

  it('a longer repo name that merely contains this one is not this repo', async () => {
    harness.sqlite.exec(`INSERT INTO projects (id, slug, name, goal, status, repo_url) VALUES ('p-fork', 'p-fork', 'Fork', 'x', 'active', 'https://github.com/mumega/mupot-fork')`)
    expect(await route(makeEnv(), pr('mumega/mupot'))).toMatchObject({ routed: true, project_id: 'p1' }) // not ambiguous with p-fork
    expect(await route(makeEnv(), pr('mumega/mupot-fork'), 'd-2')).toMatchObject({ routed: true, project_id: 'p-fork' })
  })

  it('a repo two projects claim is ambiguous: dropped, never fanned out', async () => {
    harness.sqlite.exec(`INSERT INTO projects (id, slug, name, goal, status, repo_url) VALUES ('p-dup', 'p-dup', 'Dup', 'x', 'active', 'https://github.com/mumega/mupot')`)
    expect(await route(makeEnv(), pr('mumega/mupot'))).toEqual({ routed: false, reason: 'ambiguous_repo' })
    expect(officeCalls).toEqual([])
    expect(drops()).toEqual({ ambiguous_repo: '1' })
  })

  it.each(['', 'nosplit', 'a/b/c', '../etc/passwd', 'o/r name', 'o/'])('a malformed repository name %j is dropped', async (name) => {
    const payload = pr('mumega/mupot')
    payload.repository = { full_name: name }
    expect(await route(makeEnv(), payload)).toEqual({ routed: false, reason: 'bad_repo' })
  })

  it('resolveRepoProject answers from D1 only', async () => {
    expect(await resolveRepoProject({ DB: harness.db }, 'github:mumega/mupot')).toEqual({ ok: true, projectId: 'p1' })
    expect(await resolveRepoProject({ DB: harness.db }, 'github:mumega/zzz')).toEqual({ ok: false, reason: 'unknown_repo' })
  })

  it('a payload that does not map to a Notice (hostile link) is dropped and counted', async () => {
    const payload = pr('mumega/mupot')
    ;(payload.pull_request as Record<string, unknown>).html_url = 'javascript:alert(1)'
    expect(await route(makeEnv(), payload)).toEqual({ routed: false, reason: 'unmappable' })
    expect(drops()).toEqual({ unmappable: '1' })
  })
})

describe('at-least-once delivery', () => {
  it('replaying the same delivery is a no-op', async () => {
    const env = makeEnv()
    const payload = pr('mumega/mupot', { action: 'opened' })
    expect(await route(env, payload, 'same')).toMatchObject({ outcome: 'applied' })
    const before = JSON.stringify(memoryOffice('pot-a:p1').all('SELECT * FROM office_items'))
    for (let i = 0; i < 3; i++) expect(await route(env, payload, 'same')).toMatchObject({ routed: true, outcome: 'duplicate' })
    expect(JSON.stringify(memoryOffice('pot-a:p1').all('SELECT * FROM office_items'))).toBe(before)
  })

  it('an older version never overwrites a newer one, whatever the delivery order', async () => {
    const env = makeEnv()
    expect(await route(env, pr('mumega/mupot', { sha: 'sha-new', at: 120, title: 'newest' }), 'd-new')).toMatchObject({ outcome: 'applied' })
    expect(await route(env, pr('mumega/mupot', { sha: 'sha-old', at: 10, title: 'stale' }), 'd-old')).toMatchObject({ outcome: 'stale' })
    expect(itemsOf('p1')).toMatchObject([{ version: 'sha-new', title: 'newest' }])
  })

  it('a future-dated updated_at is refused by the office and counted as a refusal', async () => {
    const payload = pr('mumega/mupot')
    ;(payload.pull_request as Record<string, unknown>).updated_at = '2999-01-01T00:00:00Z'
    expect(await route(makeEnv(), payload)).toEqual({ routed: false, reason: 'office_refused' })
    expect(drops()).toEqual({ office_refused: '1' })
    expect(memoryOffice('pot-a:p1').all('SELECT * FROM office_items')).toEqual([])
  })

  it('a refused or failing office never throws into the webhook', async () => {
    officeThrows = true
    expect(await route(makeEnv(), pr('mumega/mupot'))).toEqual({ routed: false, reason: 'office_error' })
    expect(drops()).toEqual({ office_error: '1' })
  })

  it('an archived project’s office refuses', async () => {
    const env = makeEnv()
    harness.sqlite.exec(`UPDATE projects SET status = 'archived' WHERE id = 'p1'`)
    // the repo no longer resolves, so the office is not even asked
    expect(await route(env, pr('mumega/mupot'))).toEqual({ routed: false, reason: 'unknown_repo' })
  })
})

describe('through the real webhook route', () => {
  async function hmacHex(secret: string, msg: string): Promise<string> {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)))].map((b) => b.toString(16).padStart(2, '0')).join('')
  }
  /** Deliver through the real route with an ExecutionContext; waits for waitUntil work unless `settle` is false. */
  async function deliver(env: Env, event: string, payload: unknown, delivery: string, settle = true): Promise<Response> {
    const body = JSON.stringify(payload)
    const pending: Promise<unknown>[] = []
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext
    const res = await githubInboundApp.fetch(
      new Request('https://pot.test/', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': `sha256=${await hmacHex('webhook-secret', body)}`,
          'x-github-event': event,
          'x-github-delivery': delivery,
        },
        body,
      }),
      env,
      ctx,
    )
    if (settle) await Promise.all(pending)
    return res
  }

  it('the answer is exactly what it was without the office; the notice reaches the office; a redelivery is dropped by the ledger', async () => {
    const env = makeEnv()
    const payload = pr('mumega/mupot', { action: 'synchronize', sha: 'sha-9' })
    const a = await deliver(env, 'pull_request', payload, 'deliv-1')
    expect(a.status).toBe(200)
    expect(await a.json()).toEqual({ ok: true, ignored: 'pull_request.synchronize' }) // the pre-existing answer
    expect(itemsOf('p1')).toMatchObject([{ version: 'sha-9' }])

    const b = await deliver(env, 'pull_request', payload, 'deliv-1')
    expect(await b.json()).toEqual({ ok: true, duplicate: true })
    expect(officeCalls).toEqual(['pot-a:p1']) // the replay never reached the office
  })

  it('a hung office RPC neither delays nor alters the webhook answer, and the existing handlers still run', async () => {
    // issues.closed has an existing handler with an observable answer (syncTaskStatusFromIssue).
    const issue = {
      action: 'closed',
      issue: { node_id: 'I_9', html_url: 'https://github.com/mumega/mupot/issues/9', title: 'Done', updated_at: '2026-10-22T08:50:00Z' },
      repository: { full_name: 'mumega/mupot' },
      sender: { login: 'someone' },
      installation: { id: 4242 },
    }
    const baseline = await (await deliver(makeEnv({ PROJECT_OFFICE: undefined }), 'issues', issue, 'deliv-base')).json()
    expect(baseline).toEqual({ ok: true, synced: false, action: 'closed' })

    let rpcStarted = false
    const hung = {
      idFromName: (name: string) => ({ name }),
      get: () => ({ notice: () => { rpcStarted = true; return new Promise(() => {}) } }),
    } as unknown as DurableObjectNamespace
    const env = makeEnv({ PROJECT_OFFICE_DO: hung })
    const started = Date.now()
    const res = await Promise.race([
      deliver(env, 'issues', issue, 'deliv-hung', false),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 3000)),
    ])
    expect(res).not.toBe('timeout')
    expect(Date.now() - started).toBeLessThan(3000)
    expect(await (res as Response).json()).toEqual(baseline) // same answer as with the office off
    await new Promise((r) => setTimeout(r, 50))
    expect(rpcStarted).toBe(true) // the intake did start; the response just did not wait for it
  })

  it('with the flag off the same delivery changes nothing in any office', async () => {
    const env = makeEnv({ PROJECT_OFFICE: undefined })
    const res = await deliver(env, 'pull_request', pr('mumega/mupot'), 'deliv-2')
    expect(await res.json()).toEqual({ ok: true, ignored: 'pull_request.synchronize' })
    expect(officeCalls).toEqual([])
    expect(offices.size).toBe(0)
    expect(drops()).toEqual({})
  })

  it('an unknown repo gets the same answer as a known one', async () => {
    const env = makeEnv()
    const known = await (await deliver(env, 'pull_request', pr('mumega/mupot'), 'deliv-3')).json()
    const unknown = await (await deliver(env, 'pull_request', pr('mumega/secret-repo'), 'deliv-4')).json()
    expect(unknown).toEqual(known)
    expect(drops()).toEqual({ unknown_repo: '1' })
  })

  it('an issues.edited delivery is recorded and the pre-existing answer is unchanged', async () => {
    const env = makeEnv()
    const payload = {
      action: 'edited',
      issue: { node_id: 'I_7', html_url: 'https://github.com/mumega/mupot/issues/7', title: 'Edited', updated_at: '2026-10-22T08:40:00Z' },
      repository: { full_name: 'mumega/mupot' },
      sender: { login: 'someone' },
      installation: { id: 4242 },
    }
    expect(await (await deliver(env, 'issues', payload, 'deliv-5')).json()).toEqual({ ok: true, ignored: 'issues.edited' })
    expect(itemsOf('p1')).toMatchObject([{ kind: 'issue', title: 'Edited' }])
  })
})

describe('the notice carries the repository D1 vouched for, and the contract version (#2137 items 2, 6)', () => {
  it('scope is the canonical key intake resolved the owner by, whatever spelling the payload used', async () => {
    expect(await route(makeEnv(), pr('MUMEGA/Mupot'))).toMatchObject({ routed: true, project_id: 'p1' })
    expect(memoryOffice('pot-a:p1').all('SELECT scope FROM office_items')).toEqual([{ scope: 'github:mumega/mupot' }])
  })

  it('what the office receives is stamped with the current contract version', async () => {
    const seen: unknown[] = []
    const env = makeEnv()
    const ns = env.PROJECT_OFFICE_DO as unknown as { get: (id: { name: string }) => { notice: (n: unknown) => Promise<NoticeResult> } }
    const inner = ns.get
    ns.get = (id) => {
      const stub = inner(id)
      return { notice: (n: unknown) => (seen.push(n), stub.notice(n)) }
    }
    expect((await route(env, pr('mumega/mupot'))).routed).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ contract: NOTICE_CONTRACT_VERSION, scope: 'github:mumega/mupot' })
  })

  it('a repository the project gave up is not routed to it any more, and its office sweeps the old items', async () => {
    const env = makeEnv()
    expect((await route(env, pr('mumega/mupot'), 'd-1')).routed).toBe(true)
    harness.sqlite.exec(`UPDATE projects SET repo_url = 'https://github.com/mumega/elsewhere' WHERE id = 'p1'`)
    expect(await route(env, pr('mumega/mupot'), 'd-2')).toEqual({ routed: false, reason: 'unknown_repo' })
    const swept = await sweepRelinquishedScopes(env, memoryOffice('pot-a:p1'), 'p1', NOW)
    expect(swept.purged).toBe(1)
    expect(itemsOf('p1')).toEqual([])
  })

  it('the office refuses a scope D1 does not give it, whatever the caller routed (defence in depth)', async () => {
    const env = makeEnv()
    const forged = await buildNotice({
      tenant: TENANT, connection: INSTALL, scope: 'github:mumega/mcpwp', provider: 'github', item_id: 'X', event_id: 'forged',
      version: 'v', kind: 'pr', state: 'open', url: 'https://github.com/mumega/mcpwp/pull/1', title: 't', actor: 'a', updated_at: '2026-10-22T08:00:00.000Z',
    })
    const ns = env.PROJECT_OFFICE_DO as unknown as DurableObjectNamespace
    const stub = ns.get(ns.idFromName(`${TENANT}:p1`)) as unknown as { notice: (n: unknown) => Promise<NoticeResult> }
    expect(await stub.notice(forged)).toEqual({ ok: false, error: 'invalid_notice', problem: 'scope_not_owned' }) // mcpwp is p2's
    expect(offices.get('pot-a:p1')?.all('SELECT * FROM office_items') ?? []).toEqual([])
  })
})
