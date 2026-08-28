// tests/flight-sec-02-squad-oauth.test.ts — FLIGHT SEC-02 / #1162 & #1161
//
// Dynamic Squad Memberships & OAuth Consent Visibility Verification Suite.
// Real SQLite D1 migration chain schema.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { invokeTool } from '../src/mcp'
import {
  buildAuthContextFromProps,
  handleOAuthAuthorize,
  listConsentableAgents,
  memberMayConsentToAgent,
} from '../src/mcp/oauth-authorize'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TENANT = 'mumega'
const DEPT_ID = 'dept-core'
const SQUAD_A_ID = 'squad-alpha'
const SQUAD_B_ID = 'squad-beta'

const OPERATOR_MEMBER_ID = 'member-operator'
const HUMAN_ADMIN_ID = 'member-human-admin'
const AGENT_MINTED_ID = 'agent-minted-kasra'
const AGENT_MINTED_MEMBER_ID = 'member-kasra'
const AGENT_UNMINTED_ID = 'agent-unminted-river'
const AGENT_INACTIVE_ID = 'agent-inactive-ghost'

function applyAllMigrations(sqlite: SqliteD1Harness['sqlite']): void {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    try {
      sqlite.exec(sql)
    } catch (err) {
      const msg = String(err)
      if (!/already exists|duplicate column|no such (function|module)|near "PRAGMA"/i.test(msg)) {
        throw new Error(`migration ${file}: ${msg}`)
      }
    }
  }
}

function seedTestData(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    INSERT INTO org_settings (key, value, updated_at) VALUES ('billing_state', '{"tier":"scale"}', '2026-08-01T00:00:00.000Z');

    INSERT INTO departments (id, slug, name)
    VALUES ('${DEPT_ID}', 'core', 'Core Department');

    INSERT INTO squads (id, department_id, slug, name)
    VALUES
      ('${SQUAD_A_ID}', '${DEPT_ID}', 'alpha', 'Alpha Squad'),
      ('${SQUAD_B_ID}', '${DEPT_ID}', 'beta', 'Beta Squad');

    -- Agents
    INSERT INTO agents (id, squad_id, slug, name, status, autonomy, budget_cap_cents, budget_window)
    VALUES
      ('${AGENT_MINTED_ID}', '${SQUAD_A_ID}', 'kasra', 'Kasra Gate', 'active', 'execute', 5000, 'week'),
      ('${AGENT_UNMINTED_ID}', '${SQUAD_A_ID}', 'river', 'River Lead', 'active', 'execute', 5000, 'week'),
      ('${AGENT_INACTIVE_ID}', '${SQUAD_A_ID}', 'ghost', 'Ghost Agent', 'inactive', 'execute', 5000, 'week');

    -- Members
    INSERT INTO members (id, email, display_name, status, created_at, tenant)
    VALUES
      ('${OPERATOR_MEMBER_ID}', 'operator@mumega.com', 'Operator', 'active', '2026-08-01T00:00:00.000Z', '${TENANT}'),
      ('${HUMAN_ADMIN_ID}', 'hadi@mumega.com', 'Hadi', 'active', '2026-08-01T00:00:00.000Z', '${TENANT}'),
      ('${AGENT_MINTED_MEMBER_ID}', NULL, 'Kasra Gate Member', 'active', '2026-08-01T00:00:00.000Z', '${TENANT}');

    -- Agent Member Binding (only kasra is minted initially; river is unminted)
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
    VALUES
      ('${TENANT}', '${AGENT_MINTED_ID}', '${AGENT_MINTED_MEMBER_ID}', '2026-08-01T00:00:00.000Z');

    -- Capabilities
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
    VALUES
      ('cap-op-org', '${OPERATOR_MEMBER_ID}', 'org', NULL, 'owner'),
      ('cap-human-squad-a', '${HUMAN_ADMIN_ID}', 'squad', '${SQUAD_A_ID}', 'admin'),
      ('cap-kasra-home', '${AGENT_MINTED_MEMBER_ID}', 'squad', '${SQUAD_A_ID}', 'member');

    -- Memberships
    INSERT INTO memberships (id, agent_id, squad_id, capability)
    VALUES
      ('mem-kasra-home', '${AGENT_MINTED_ID}', '${SQUAD_A_ID}', 'member');
  `)
}

function operatorAuth(): AuthContext {
  return {
    userId: OPERATOR_MEMBER_ID,
    memberId: OPERATOR_MEMBER_ID,
    email: 'operator@mumega.com',
    role: 'owner',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: null,
    capabilities: [
      {
        member_id: OPERATOR_MEMBER_ID,
        scope_type: 'org',
        scope_id: null,
        capability: 'owner',
      },
    ],
  }
}

function stubOAuthProvider() {
  const completeAuthorization = vi.fn().mockResolvedValue({ redirectTo: 'https://client.test/callback?code=abc' })
  const parseAuthRequest = vi.fn().mockResolvedValue({
    clientId: 'test-client',
    redirectUri: 'https://client.test/callback',
    scope: ['mcp:read', 'mcp:write'],
    state: 'client-state-1',
  })
  return { completeAuthorization, parseAuthRequest }
}

function stubFetch() {
  const originalFetch = globalThis.fetch
  globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
    if (urlStr.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'mock-google-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (urlStr.includes('googleapis.com/oauth2/v2/userinfo')) {
      return new Response(
        JSON.stringify({
          id: 'google-sub-hadi',
          name: 'Hadi',
          email: 'hadi@mumega.com',
          verified_email: true,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    return originalFetch(url)
  })
}

let harness: SqliteD1Harness
let env: Env

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  seedTestData(harness.sqlite)
  stubFetch()
  env = {
    TENANT_SLUG: TENANT,
    DB: harness.db,
    SESSIONS: {
      storage: new Map<string, string>(),
      async get(k: string, type?: string) {
        const val = this.storage.get(k)
        if (!val) return null
        if (type === 'json') return JSON.parse(val)
        return val
      },
      async put(k: string, v: string) {
        this.storage.set(k, v)
      },
      async delete(k: string) {
        this.storage.delete(k)
      },
    },
    GOOGLE_CLIENT_ID: 'mock-google-client-id',
    GOOGLE_CLIENT_SECRET: 'mock-google-client-secret',
    BUS: { send: async () => {}, emit: async () => {} },
  } as unknown as Env
})

afterEach(() => {
  harness.sqlite.close()
  vi.unstubAllGlobals()
})

describe('FLIGHT SEC-02 / #1161 — Dynamic Squad Membership Tools & Receipts', () => {
  it('squad_member_add grants capability on target squad and creates audit receipt', async () => {
    const result = await invokeTool(
      operatorAuth(),
      env,
      'squad_member_add',
      { agent: AGENT_MINTED_ID, squad: SQUAD_B_ID, capability: 'lead' },
      'https://pot.test',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.result).toMatchObject({
      agent: { id: AGENT_MINTED_ID },
      squad: { id: SQUAD_B_ID },
      capability: 'lead',
      result: 'created',
    })

    // Verify membership record
    const membership = harness.sqlite.prepare(
      'SELECT capability FROM memberships WHERE agent_id = ? AND squad_id = ?',
    ).get(AGENT_MINTED_ID, SQUAD_B_ID) as { capability: string }
    expect(membership.capability).toBe('lead')

    // Verify RBAC capability grant
    const grant = harness.sqlite.prepare(
      `SELECT capability FROM capabilities WHERE member_id = ? AND scope_type = 'squad' AND scope_id = ?`,
    ).get(AGENT_MINTED_MEMBER_ID, SQUAD_B_ID) as { capability: string }
    expect(grant.capability).toBe('lead')

    // Verify membership receipt
    const receipt = harness.sqlite.prepare(
      `SELECT action, target_agent_id, squad_id, capability, result
         FROM membership_receipts WHERE target_agent_id = ? AND squad_id = ?`,
    ).get(AGENT_MINTED_ID, SQUAD_B_ID) as { action: string; target_agent_id: string; squad_id: string; capability: string; result: string }
    expect(receipt.action).toBe('add')
    expect(receipt.capability).toBe('lead')
    expect(receipt.result).toBe('created')
  })

  it('squad_member_list returns current squad members with both membership and grant capability', async () => {
    await invokeTool(
      operatorAuth(),
      env,
      'squad_member_add',
      { agent: AGENT_MINTED_ID, squad: SQUAD_B_ID, capability: 'lead' },
      'https://pot.test',
    )

    const listed = await invokeTool(
      operatorAuth(),
      env,
      'squad_member_list',
      { squad: SQUAD_B_ID },
      'https://pot.test',
    )
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    const members = (listed.result as { members: Array<{ agent_id: string; membership_capability: string; grant_capability: string }> }).members
    expect(members).toHaveLength(1)
    expect(members[0].agent_id).toBe(AGENT_MINTED_ID)
    expect(members[0].membership_capability).toBe('lead')
    expect(members[0].grant_capability).toBe('lead')
  })

  it('squad_member_remove deletes membership, removes grant, and creates removal audit receipt', async () => {
    await invokeTool(
      operatorAuth(),
      env,
      'squad_member_add',
      { agent: AGENT_MINTED_ID, squad: SQUAD_B_ID, capability: 'member' },
      'https://pot.test',
    )

    const removed = await invokeTool(
      operatorAuth(),
      env,
      'squad_member_remove',
      { agent: AGENT_MINTED_ID, squad: SQUAD_B_ID },
      'https://pot.test',
    )
    expect(removed.ok).toBe(true)

    const membership = harness.sqlite.prepare(
      'SELECT id FROM memberships WHERE agent_id = ? AND squad_id = ?',
    ).get(AGENT_MINTED_ID, SQUAD_B_ID)
    expect(membership).toBeUndefined()

    const grant = harness.sqlite.prepare(
      `SELECT id FROM capabilities WHERE member_id = ? AND scope_type = 'squad' AND scope_id = ?`,
    ).get(AGENT_MINTED_MEMBER_ID, SQUAD_B_ID)
    expect(grant).toBeUndefined()

    const removalReceipt = harness.sqlite.prepare(
      `SELECT action, target_agent_id, squad_id, result
         FROM membership_receipts WHERE target_agent_id = ? AND squad_id = ? AND action = 'remove'`,
    ).get(AGENT_MINTED_ID, SQUAD_B_ID) as { action: string; target_agent_id: string; squad_id: string; result: string }
    expect(removalReceipt.action).toBe('remove')
    expect(removalReceipt.result).toBe('removed')
  })

  it('bound agents holding action:manage_access can execute squad_member mutations', async () => {
    const boundAgentAuth: AuthContext = {
      userId: AGENT_MINTED_MEMBER_ID,
      memberId: AGENT_MINTED_MEMBER_ID,
      email: null,
      role: 'member',
      tenant: TENANT,
      channel: 'workspace',
      boundAgentId: AGENT_MINTED_ID,
      capabilities: [
        {
          member_id: AGENT_MINTED_MEMBER_ID,
          scope_type: 'squad',
          scope_id: SQUAD_A_ID,
          capability: 'admin',
        },
      ],
    }

    // Without action:manage_access → 403 operator_principal_required
    const unprivileged = await invokeTool(
      boundAgentAuth,
      env,
      'squad_member_add',
      { agent: AGENT_UNMINTED_ID, squad: SQUAD_A_ID, capability: 'member' },
      'https://pot.test',
    )
    expect(unprivileged.ok).toBe(false)
    if (unprivileged.ok) return
    expect(unprivileged.error).toBe('operator_principal_required')

    // Grant action:manage_access to AGENT_MINTED_ID
    harness.sqlite.exec(`
      INSERT INTO gate_grants (id, principal_type, principal_id, capability, granted_by, created_at)
      VALUES ('grant-action-manage-access', 'agent', '${AGENT_MINTED_ID}', 'action:manage_access', '${OPERATOR_MEMBER_ID}', datetime('now'));
    `)

    // With action:manage_access → authorized (target unminted check applies honestly)
    const privileged = await invokeTool(
      boundAgentAuth,
      env,
      'squad_member_add',
      { agent: AGENT_UNMINTED_ID, squad: SQUAD_A_ID, capability: 'member' },
      'https://pot.test',
    )
    expect(privileged.ok).toBe(false)
    if (privileged.ok) return
    // Bypassed operator_principal_required; failed honestly on unminted target
    expect(privileged.error).toBe('agent_identity_unminted')
  })
})

describe('FLIGHT SEC-02 / #1162 — OAuth Consent Convergence & Unminted Agent Auto-Mint', () => {
  it('listConsentableAgents displays both minted and unminted agents on accessible squads', async () => {
    const list = await listConsentableAgents(env, HUMAN_ADMIN_ID)
    const agentIds = list.map((a) => a.id).sort()
    expect(agentIds).toEqual([AGENT_MINTED_ID, AGENT_UNMINTED_ID].sort())

    const mintedAgent = list.find((a) => a.id === AGENT_MINTED_ID)
    const unmintedAgent = list.find((a) => a.id === AGENT_UNMINTED_ID)
    expect(mintedAgent?.minted).toBe(true)
    expect(unmintedAgent?.minted).toBe(false)

    // Preview shows prospective member grant for unminted agent
    expect(unmintedAgent?.capabilities).toEqual([
      { member_id: '', scope_type: 'squad', scope_id: SQUAD_A_ID, capability: 'member' },
    ])

    // Inactive ghost agent is excluded
    expect(list.map((a) => a.id)).not.toContain(AGENT_INACTIVE_ID)
  })

  it('memberMayConsentToAgent returns true for unminted agent when human has admin on squad', async () => {
    expect(await memberMayConsentToAgent(env, HUMAN_ADMIN_ID, AGENT_UNMINTED_ID)).toBe(true)
  })

  it('auto-mints dedicated member and binding when consenting to an unminted agent', async () => {
    const oauthProvider = stubOAuthProvider()
    const testEnv = { ...env, OAUTH_PROVIDER: oauthProvider } as unknown as Env

    // 1. Initiate OAuth authorization
    const authReq = new Request('https://pot.test/authorize?client_id=test-client&response_type=code', {
      method: 'GET',
    })
    const authRes = await handleOAuthAuthorize(authReq, testEnv)
    expect(authRes.status).toBe(302)
    const authCookies = authRes.headers.get('Set-Cookie') ?? ''
    const nonceMatch = authCookies.match(/mupot_oauth_nonce=([^;]+)/)
    const nonce = nonceMatch ? nonceMatch[1] : ''
    expect(nonce).toBeTruthy()

    // 2. Google callback
    const cbReq = new Request(`https://pot.test/oauth/google-callback?code=mock-code&state=${nonce}`, {
      method: 'GET',
      headers: { Cookie: `mupot_oauth_nonce=${nonce}` },
    })
    const cbRes = await handleOAuthAuthorize(cbReq, testEnv)
    expect(cbRes.status).toBe(200)
    const cbCookies = cbRes.headers.get('Set-Cookie') ?? ''
    const consentNonceMatch = cbCookies.match(/mupot_oauth_consent=([^;]+)/)
    const consentNonce = consentNonceMatch ? consentNonceMatch[1] : ''
    expect(consentNonce).toBeTruthy()

    // 3. Submit consent with unminted agent
    const consentForm = new URLSearchParams({
      consent_nonce: consentNonce,
      action: 'continue',
      agent_id: AGENT_UNMINTED_ID,
    })
    const consentReq = new Request('https://pot.test/oauth/consent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: `mupot_oauth_consent=${consentNonce}`,
      },
      body: consentForm.toString(),
    })
    const consentRes = await handleOAuthAuthorize(consentReq, testEnv)
    expect(consentRes.status).toBe(302)

    // Verify River is now minted with binding in D1
    const binding = harness.sqlite.prepare(
      'SELECT member_id FROM agent_member_bindings WHERE agent_id = ? AND tenant = ?',
    ).get(AGENT_UNMINTED_ID, TENANT) as { member_id: string }
    expect(binding).toBeDefined()
    expect(binding.member_id).toBeDefined()

    // Verify dedicated member row
    const memberRow = harness.sqlite.prepare(
      'SELECT status, display_name FROM members WHERE id = ?',
    ).get(binding.member_id) as { status: string; display_name: string }
    expect(memberRow.status).toBe('active')
    expect(memberRow.display_name).toBe('River Lead')

    // Verify capability grant
    const grant = harness.sqlite.prepare(
      'SELECT capability FROM capabilities WHERE member_id = ? AND scope_type = ? AND scope_id = ?',
    ).get(binding.member_id, 'squad', SQUAD_A_ID) as { capability: string }
    expect(grant.capability).toBe('member')

    // Verify OAuth consent receipt
    const receipt = harness.sqlite.prepare(
      'SELECT agent_id, consenting_member_id, agent_member_id FROM oauth_consent_receipts WHERE agent_id = ?',
    ).get(AGENT_UNMINTED_ID) as { agent_id: string; consenting_member_id: string; agent_member_id: string }
    expect(receipt.agent_id).toBe(AGENT_UNMINTED_ID)
    expect(receipt.consenting_member_id).toBe(HUMAN_ADMIN_ID)
    expect(receipt.agent_member_id).toBe(binding.member_id)

    // Verify completeAuthorization props and live AuthContext
    const call = oauthProvider.completeAuthorization.mock.calls[0][0]
    expect(call.props.boundAgentId).toBe(AGENT_UNMINTED_ID)
    expect(call.props.memberId).toBe(binding.member_id)
    expect(call.props.consentedByMemberId).toBe(HUMAN_ADMIN_ID)

    const authCtx = await buildAuthContextFromProps(testEnv, call.props)
    expect(authCtx?.boundAgentId).toBe(AGENT_UNMINTED_ID)
    expect(authCtx?.capabilities).toEqual([
      { member_id: binding.member_id, scope_type: 'squad', scope_id: SQUAD_A_ID, capability: 'member' },
    ])
  })
})
