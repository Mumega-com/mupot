import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { D1PreparedStatement } from '@cloudflare/workers-types'
import { authApp } from '../src/auth'
import '../src/mcp/index'
import { tasksApp } from '../src/tasks'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { PRESENCE_ENV, enrolPasskey, realTap } from './helpers/presence'
import type { SoftAuthenticator } from './helpers/webauthn-authenticator'

const TENANT = 'local'
let harness: SqliteD1Harness
let env: Env
let cookie: string
let authenticator: SoftAuthenticator

function memoryKv() {
  const values = new Map<string, string>()
  return {
    async get(key: string) { return values.get(key) ?? null },
    async put(key: string, value: string) { values.set(key, value) },
    async delete(key: string) { values.delete(key) },
  }
}

async function verdict(body: Record<string, unknown>): Promise<Response> {
  return tasksApp.request('/task-1/verdict', {
    method: 'POST',
    headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, env)
}

beforeEach(async () => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  env = {
    TENANT_SLUG: TENANT,
    BRAND: 'Test Pot',
    LOCAL_TEST_AUTH: '1',
    LOCAL_TEST_AUTH_EMAIL: 'admin@example.test',
    SESSIONS: memoryKv(),
    DB: harness.db,
    ...PRESENCE_ENV,
  } as unknown as Env
  harness.sqlite.exec(`
    INSERT INTO users (id, email, role) VALUES ('u-seed', 'seed@example.test', 'member');
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'squad', 'Squad');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('member-1', 'admin@example.test', 'Admin', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-1', 'member-1', 'org', NULL, 'admin');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-2', 'member-1', 'squad', 'squad-1', 'admin');
    INSERT INTO tasks (id, squad_id, title, body, done_when, status, gate_owner, result, created_at, updated_at)
      VALUES ('task-1', 'squad-1', 'Approve this', 'body', 'done', 'review', 'gate:review', 'submitted work', datetime('now'), datetime('now'));
    INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
      VALUES ('grant-1', 'gate:review', 'member', 'member-1', 'seed', datetime('now'));
    INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest, result_text, created_at)
      VALUES ('submission-current', '${TENANT}', 'task-1', 'squad-1', 'agent-1', '/artifact', '${'a'.repeat(64)}', '${'a'.repeat(64)}', 'submitted work', datetime('now'));
  `)
  const login = await authApp.request('/dev-login', {}, env)
  const session = /mupot_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1]
  if (!session) throw new Error('missing dev session')
  cookie = `mupot_session=${session}`
  authenticator = await enrolPasskey(env, harness.sqlite, 'member-1')
  harness.sqlite.prepare("UPDATE web_sessions SET recent_reauth_at = ? WHERE member_id = 'member-1'").run(new Date().toISOString())
}, 30_000)

afterEach(() => harness.close())

describe('task approval presence binding', () => {
  it('uses the server current submission in the grant digest and refuses a client mismatch before filing one', async () => {
    const mismatch = await verdict({ verdict: 'approved', expected_submission_id: 'attacker-selected' })
    expect(mismatch.status, await mismatch.clone().text()).toBe(409)
    expect(await mismatch.json()).toMatchObject({ error: 'submission_mismatch' })
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM presence_grants').get()).toEqual({ n: 0 })

    const pending = await verdict({ verdict: 'approved' })
    expect(pending.status).toBe(403)
    const row = harness.sqlite.prepare("SELECT id, fields_json, action_path FROM presence_grants WHERE kind = 'task_verdict_approve'").get() as { id: string; fields_json: string; action_path: string }
    expect(JSON.parse(row.fields_json)).toMatchObject({ verdict: 'approved', expected_submission_id: 'submission-current' })

    const approveUrl = (await pending.clone().json() as { approve_url: string }).approve_url
    expect((await realTap(env, authenticator, approveUrl)).status).toBe(200)
    // A fresh result lands while the human is completing the passkey ceremony.
    // The satisfied grant remains bound to the prior submission and cannot
    // decide this newer work.
    harness.sqlite.exec(`
      UPDATE tasks SET result = 'newer work' WHERE id = 'task-1';
      INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest, result_text, created_at)
        VALUES ('submission-new', '${TENANT}', 'task-1', 'squad-1', 'agent-2', '/artifact-new', '${'b'.repeat(64)}', '${'b'.repeat(64)}', 'newer work', datetime('now', '+1 second'));
    `)
    const stale = await tasksApp.request(`/task-1/verdict?presence_grant=${encodeURIComponent(row.id)}`, {
      method: 'POST', headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify({ verdict: 'approved' }),
    }, env)
    expect(stale.status).toBe(403)
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS n FROM task_verdicts WHERE task_id = 'task-1'").get()).toEqual({ n: 0 })
  })

  it('preserves an explicit null submission in the presence grant', async () => {
    harness.sqlite.exec(`
      INSERT INTO tasks (id, squad_id, title, body, done_when, status, gate_owner, result, created_at, updated_at)
        VALUES ('task-null', 'squad-1', 'Approve no submission', 'body', 'done', 'review', 'gate:review', NULL, datetime('now'), datetime('now'));
    `)
    const response = await tasksApp.request('/task-null/verdict', {
      method: 'POST', headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'approved', expected_submission_id: null }),
    }, env)
    expect(response.status).toBe(403)
    const row = harness.sqlite.prepare("SELECT fields_json FROM presence_grants WHERE subject_id = 'task-null'").get() as { fields_json: string }
    expect(JSON.parse(row.fields_json)).toMatchObject({ expected_submission_id: null })
  })

  it('refuses a submission that arrives after grant redemption and before the verdict write', async () => {
    const pending = await verdict({ verdict: 'approved' })
    expect(pending.status).toBe(403)
    const grantId = pending.headers.get('x-presence-grant')
    const approveUrl = (await pending.clone().json() as { approve_url: string }).approve_url
    expect(grantId).not.toBeNull()
    expect((await realTap(env, authenticator, approveUrl)).status).toBe(200)

    const originalDb = env.DB
    let injected = false
    const interceptedDb = new Proxy(originalDb, {
      get(target, property, receiver) {
        if (property !== 'prepare') return Reflect.get(target, property, receiver)
        return (sql: string) => {
          const statement = target.prepare(sql)
          if (!sql.includes("UPDATE presence_grants SET status = 'consumed'")) return statement
          const wrap = (bound: D1PreparedStatement): D1PreparedStatement => new Proxy(bound, {
            get(statementTarget, statementProperty, statementReceiver) {
              if (statementProperty === 'bind') {
                return (...args: unknown[]) => wrap(statementTarget.bind(...args))
              }
              if (statementProperty !== 'run') return Reflect.get(statementTarget, statementProperty, statementReceiver)
              return async (...args: unknown[]) => {
                const result = await statementTarget.run(...args)
                if (!injected) {
                  injected = true
                  harness.sqlite.exec(`
                    UPDATE tasks SET result = 'raced work' WHERE id = 'task-1';
                    INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest, result_text, created_at)
                      VALUES ('submission-race', '${TENANT}', 'task-1', 'squad-1', 'agent-2', '/raced', '${'c'.repeat(64)}', '${'c'.repeat(64)}', 'raced work', datetime('now', '+1 second'));
                  `)
                }
                return result
              }
            },
          })
          return wrap(statement)
        }
      },
    })
    env = { ...env, DB: interceptedDb as unknown as Env['DB'] }

    const result = await tasksApp.request(`/task-1/verdict?presence_grant=${encodeURIComponent(grantId ?? '')}`, {
      method: 'POST', headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify({ verdict: 'approved' }),
    }, env)
    expect(injected).toBe(true)
    expect(result.status).toBe(409)
    expect(await result.json()).toMatchObject({ error: 'submission_mismatch' })
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS n FROM task_verdicts WHERE task_id = 'task-1'").get()).toEqual({ n: 0 })
  })
})
