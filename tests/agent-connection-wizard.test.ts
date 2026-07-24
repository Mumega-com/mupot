import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  agentConnectionWizardApp,
  type AgentConnectionWizardAppEnv,
} from '../src/dashboard/agent-connection-wizard'
import { dashboardApp } from '../src/dashboard'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TENANT = 'tenant-a'
const OWNER: AuthContext = {
  userId: 'owner-1',
  email: 'owner@example.test',
  role: 'owner',
  tenant: TENANT,
}

function applyMigrations(sqlite: SqliteD1Harness['sqlite']): void {
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
}

function seed(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('squad-home', 'dept-1', 'home', 'Home'),
      ('squad-extra', 'dept-1', 'extra', 'Extra');
    INSERT INTO org_settings (key, value, updated_at)
      VALUES ('billing_state', '{"tier":"scale"}', '2026-07-24T00:00:00.000Z');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status)
      VALUES ('agent-existing', 'squad-home', 'existing', 'Existing Agent', 'member', 'test', 'active');
    INSERT INTO memberships (id, agent_id, squad_id, capability)
      VALUES ('membership-existing', 'agent-existing', 'squad-home', 'member');
    INSERT INTO members (id, display_name, status, tenant)
      VALUES ('member-existing', 'Existing Agent', 'active', '${TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('${TENANT}', 'agent-existing', 'member-existing', '2026-07-24T00:00:00.000Z');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('grant-existing', 'member-existing', 'squad', 'squad-home', 'member');
    INSERT INTO member_tokens
      (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
    VALUES
      ('token-existing', 'member-existing', '${'a'.repeat(64)}', 'old laptop', 'workspace',
       '2026-07-24T00:00:00.000Z', 'agent-existing', '${TENANT}');
  `)
}

function appFor(auth: AuthContext) {
  const app = new Hono<AgentConnectionWizardAppEnv>()
  app.use('*', async (c, next) => {
    c.set('auth', auth)
    await next()
  })
  app.route('/agents/connect', agentConnectionWizardApp)
  return app
}

function postJson(
  app: ReturnType<typeof appFor>,
  path: string,
  body: unknown,
  env: Env,
): Promise<Response> {
  return app.request(
    `https://malicious-host.example${path}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  )
}

describe('agent connection owner wizard', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    applyMigrations(harness.sqlite)
    seed(harness.sqlite)
    env = {
      DB: harness.db,
      TENANT_SLUG: TENANT,
      PUBLIC_ORIGIN: 'https://pot.example',
      BRAND: 'Mupot',
    } as Env
  })

  afterEach(() => harness.close())

  it('allows human owners and refuses members and bound-agent sessions', async () => {
    const owner = await appFor(OWNER).request('/agents/connect', {}, env)
    expect(owner.status).toBe(200)
    expect(await owner.text()).toContain('Create or connect agent')

    const member = await appFor({ ...OWNER, role: 'member' }).request('/agents/connect', {}, env)
    expect(member.status).toBe(403)

    const bound = await appFor({
      ...OWNER,
      boundAgentId: 'agent-existing',
    }).request('/agents/connect', {}, env)
    expect(bound.status).toBe(403)
  })

  it('allows legacy admins and current fine-grained org admins', async () => {
    expect((await appFor({ ...OWNER, role: 'admin' }).request(
      '/agents/connect',
      {},
      env,
    )).status).toBe(200)

    harness.sqlite.exec(`
      INSERT INTO members (id, display_name, status, tenant)
        VALUES ('operator-member', 'Operator', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('operator-admin', 'operator-member', 'org', NULL, 'admin');
    `)
    const fineGrained: AuthContext = {
      ...OWNER,
      role: 'member',
      memberId: 'operator-member',
    }
    expect((await appFor(fineGrained).request(
      '/agents/connect',
      {},
      env,
    )).status).toBe(200)
  })

  it('is mounted behind dashboard session auth with no-store browser headers', async () => {
    const dashboardEnv = {
      ...env,
      SESSIONS: {
        get: async () => JSON.stringify({
          userId: OWNER.userId,
          email: OWNER.email,
          role: OWNER.role,
          createdAt: '2026-07-24T00:00:00.000Z',
        }),
        delete: async () => undefined,
      },
    } as unknown as Env
    const response = await dashboardApp.fetch(
      new Request('https://pot.example/agents/connect', {
        headers: { Cookie: 'mupot_session=owner-session' },
      }),
      dashboardEnv,
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(await response.text()).toContain('Create or connect agent')

    const unauthenticated = await dashboardApp.fetch(
      new Request('https://pot.example/agents/connect'),
      dashboardEnv,
    )
    expect(unauthenticated.status).toBe(302)
    expect(unauthenticated.headers.get('location')).toBe('/auth/login')
  })

  it('returns searchable non-secret candidates with immutable home and live token metadata', async () => {
    const response = await appFor(OWNER).request(
      '/agents/connect/search?q=existing',
      {},
      env,
    )
    expect(response.status).toBe(200)
    const body = await response.json() as {
      candidates: Array<Record<string, unknown>>
    }
    expect(body.candidates).toEqual([expect.objectContaining({
      id: 'agent-existing',
      slug: 'existing',
      status: 'active',
      home_squad: expect.objectContaining({
        id: 'squad-home',
        name: 'Home',
        immutable: true,
      }),
      connected: true,
      live_tokens: [{
        id: 'token-existing',
        label: 'old laptop',
        created_at: '2026-07-24T00:00:00.000Z',
        id_suffix: 'ting',
      }],
    })])
    expect(JSON.stringify(body)).not.toContain('a'.repeat(64))
    expect(JSON.stringify(body)).not.toContain('token_hash')
  })

  it('enforces resolve-before-create on an exact active name or slug match', async () => {
    const response = await postJson(
      appFor(OWNER),
      '/agents/connect/provision',
      {
        request_id: 'duplicate-attempt',
        target: {
          kind: 'new',
          home_squad_id: 'squad-home',
          agent: {
            name: 'Existing Agent',
            slug: 'different-slug',
            role: 'member',
            model: 'test',
          },
        },
        additional_access: [],
        credential: {
          action: 'issue_if_missing',
          label: 'Codex',
          home_capability: 'member',
        },
      },
      env,
    )
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: 'existing_agent_match',
      candidate_ids: ['agent-existing'],
    })
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM agents').get()).toEqual({ n: 1 })
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM agent_connection_requests').get())
      .toEqual({ n: 0 })
  })

  it('provisions through the shared service and returns show-once values separately', async () => {
    const app = appFor(OWNER)
    const response = await postJson(
      app,
      '/agents/connect/provision',
      {
        request_id: 'wizard-new',
        target: {
          kind: 'new',
          home_squad_id: 'squad-home',
          agent: {
            name: 'Wizard Agent',
            slug: 'wizard-agent',
            role: 'member',
            model: 'test',
          },
        },
        additional_access: [{
          squad_id: 'squad-extra',
          capability: 'member',
        }],
        credential: {
          action: 'issue_if_missing',
          label: 'Codex',
          home_capability: 'member',
        },
      },
      env,
    )
    expect(response.status).toBe(201)
    const body = await response.json() as {
      status: string
      show_once: { credential: string; challenge: string }
      endpoint: string
      receipt_url: string
      configuration: Record<string, string>
      receipt: { id: string }
    }
    expect(body.status).toBe('credential_issued')
    expect(body.show_once.credential).toMatch(/^mupot_/)
    expect(body.show_once.challenge).toMatch(/^[0-9a-f]{48}$/)
    expect(body.endpoint).toBe('https://pot.example/mcp')
    expect(body.receipt_url).toBe(
      `https://pot.example/agents/connect/receipts/${body.receipt.id}`,
    )
    expect(JSON.stringify(body.configuration)).not.toContain(body.show_once.credential)
    expect(JSON.stringify(body)).not.toContain('malicious-host.example')

    const receipt = await app.request(
      `/agents/connect/receipts/${body.receipt.id}`,
      {},
      env,
    )
    expect(receipt.status).toBe(200)
    const receiptHtml = await receipt.text()
    expect(receiptHtml).toContain('Credential issued')
    expect(receiptHtml).not.toContain(body.show_once.credential)
    expect(receiptHtml).not.toContain(body.show_once.challenge)
    expect(receiptHtml).not.toContain('<MEMBER_TOKEN>')
  })

  it('connects an existing agent without creating a duplicate identity', async () => {
    const response = await postJson(
      appFor(OWNER),
      '/agents/connect/provision',
      {
        request_id: 'wizard-existing',
        target: {
          kind: 'existing',
          agent_ref: 'agent-existing',
        },
        additional_access: [],
        credential: {
          action: 'add',
          label: 'Second workspace',
          home_capability: 'member',
        },
      },
      env,
    )
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      status: 'credential_issued',
      receipt: {
        agent_id: 'agent-existing',
        agent_disposition: 'reused',
      },
    })
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM agents').get()).toEqual({ n: 1 })
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM agent_member_bindings').get())
      .toEqual({ n: 1 })
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM member_tokens').get()).toEqual({ n: 2 })
  })

  it('retries one stable request without returning or minting a second key', async () => {
    const request = {
      request_id: 'wizard-retry',
      target: {
        kind: 'new',
        home_squad_id: 'squad-home',
        agent: {
          name: 'Retry Agent',
          slug: 'retry-agent',
          role: 'member',
          model: 'test',
        },
      },
      additional_access: [],
      credential: {
        action: 'issue_if_missing',
        label: 'Retry workspace',
        home_capability: 'member',
      },
    }
    const app = appFor(OWNER)
    const first = await postJson(app, '/agents/connect/provision', request, env)
    const firstBody = await first.json() as { show_once: { credential: string } }
    expect(first.status).toBe(201)

    const replay = await postJson(app, '/agents/connect/provision', request, env)
    expect(replay.status).toBe(200)
    const replayBody = await replay.json() as Record<string, unknown>
    expect(replayBody).toMatchObject({ status: 'credential_already_issued' })
    expect(replayBody).not.toHaveProperty('show_once')
    expect(JSON.stringify(replayBody)).not.toContain(firstBody.show_once.credential)
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM member_tokens').get()).toEqual({ n: 2 })
  })

  it('cancels only the current operator pending request', async () => {
    harness.sqlite.prepare(
      `INSERT INTO agent_connection_requests
        (tenant, actor_kind, actor_id, request_id, request_fingerprint, target_key,
         agent_mode, credential_action, status, created_at, updated_at, expires_at)
       VALUES (?, 'user', ?, 'abandoned', ?, 'agent:abandoned',
               'existing', 'add', 'pending', ?, ?, ?)`,
    ).run(
      TENANT,
      OWNER.userId,
      'b'.repeat(64),
      '2026-07-24T12:00:00.000Z',
      '2026-07-24T12:00:00.000Z',
      '2026-07-25T12:00:00.000Z',
    )

    const recoveryPage = await appFor(OWNER).request('/agents/connect', {}, env)
    expect(recoveryPage.status).toBe(200)
    const recoveryHtml = await recoveryPage.text()
    expect(recoveryHtml).toContain('Abandoned setup recovery')
    expect(recoveryHtml).toContain('data-cancel-request="abandoned"')

    const response = await postJson(
      appFor(OWNER),
      '/agents/connect/cancel',
      { request_id: 'abandoned' },
      env,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, status: 'cancelled' })
  })
})
