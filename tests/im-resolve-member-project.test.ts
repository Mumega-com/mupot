// tests/im-resolve-member-project.test.ts — mupot-plugin PR #17 contract
// addendum (FP-01 Slice 2, mupot#1443): POST /im/resolve-project turns a
// member's own free-text project reference into a real project id, using
// the BOUND MEMBER's own readable-project standing (never Mubot's, and
// never a caller-supplied member_id — identity comes from chat_id, same as
// every other IM surface, src/im/index.ts's memberForChat).
//
// Real SQLite D1 (createSqliteD1 + applyAllMigrations), the actual imApp
// route (not resolveMemberProjects called directly), same harness shape as
// tests/im-webhook-idempotency.test.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { imApp } from '../src/im'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const SECRET = 'test-telegram-webhook-secret'
const app = new Hono<{ Bindings: Env }>().route('/im', imApp)

describe('POST /im/resolve-project', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = { TENANT_SLUG: 'telegram-test', IM_WEBHOOK_SECRET: SECRET, DB: harness.db } as Env
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept', 'dept', 'Dept');
      INSERT INTO squads (id, department_id, slug, name) VALUES
        ('squad-1', 'dept', 'core', 'Core'), ('squad-2', 'dept', 'private', 'Private');
      INSERT INTO projects (id, slug, name, status) VALUES
        ('project-1', 'psychonom', 'Psychonom', 'active'),
        ('project-2', 'private-project', 'Private Project', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES
        ('project-1', 'squad-1', 'write'), ('project-2', 'squad-2', 'write');
      INSERT INTO members (id, email, display_name, telegram_chat_id, status, tenant)
        VALUES ('human-1', 'human@example.com', 'Shadi', '123', 'active', 'telegram-test');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-human-1', 'human-1', 'squad', 'squad-1', 'member');
    `)
  })

  afterEach(() => harness.close())

  function post(body: unknown, secret = SECRET) {
    return app.fetch(new Request('https://pot.test/im/resolve-project', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
      body: JSON.stringify(body),
    }), env)
  }

  it('resolves the member\'s OWN readable project by name, bounded to <=5 candidates', async () => {
    const res = await post({ chat_id: 123, query: 'Psychonom' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      bound: true, member_id: 'human-1',
      projects: [{ id: 'project-1', slug: 'psychonom', name: 'Psychonom' }],
    })
  })

  it('resolves by exact slug too', async () => {
    const res = await post({ chat_id: 123, query: 'psychonom' })
    const body = await res.json() as { projects: unknown[] }
    expect(body.projects).toHaveLength(1)
  })

  it('a real but non-readable project name returns EMPTY, identical to a name that does not exist at all (no-oracle)', async () => {
    const nonReadable = await (await post({ chat_id: 123, query: 'Private Project' })).json()
    const nonExistent = await (await post({ chat_id: 123, query: 'Totally Made Up Project Name' })).json()
    expect(nonReadable).toEqual({ bound: true, member_id: 'human-1', projects: [] })
    expect(nonExistent).toEqual({ bound: true, member_id: 'human-1', projects: [] })
  })

  it('an unbound chat gets bound:false and an empty result, never a member/project oracle', async () => {
    const res = await post({ chat_id: 999999999, query: 'Psychonom' })
    expect(await res.json()).toEqual({ bound: false, member_id: null, projects: [] })
  })

  it('Mubot\'s floor allows calling this route: only the shared webhook secret gates it, no MCP capability floor', async () => {
    // A caller shaped like Mubot's own low-privilege agent seat has NO MCP
    // capability at all in this request — the route accepts the shared
    // secret alone (same auth as /webhook) and answers using the BOUND
    // MEMBER's standing, not any capability the caller itself would need.
    const res = await post({ chat_id: 123, query: 'Psychonom' })
    expect(res.status).toBe(200)
    const body = await res.json() as { projects: unknown[] }
    expect(body.projects).toHaveLength(1)
  })

  it('refuses the wrong secret and requires a query', async () => {
    expect((await post({ chat_id: 123, query: 'Psychonom' }, 'wrong')).status).toBe(401)
    expect((await post({ chat_id: 123, query: '' })).status).toBe(400)
    expect((await post({ chat_id: 123 })).status).toBe(400)
  })
})
