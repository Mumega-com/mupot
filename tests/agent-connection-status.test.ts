import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dashboardApp } from '../src/dashboard'
import {
  provisionAgentConnection,
  type AgentConnectionIssued,
} from '../src/members/agent-connection'
import { loadAgentConnectionStatus } from '../src/members/agent-connection-status'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TENANT = 'tenant-a'
const NOW = new Date('2026-07-24T12:00:00.000Z')

function applyMigrations(sqlite: SqliteD1Harness['sqlite']): void {
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
}

function seed(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Department');
    INSERT INTO squads (id, department_id, slug, name)
      VALUES ('squad-home', 'dept-1', 'home', 'Home');
    INSERT INTO org_settings (key, value, updated_at)
      VALUES ('billing_state', '{"tier":"scale"}', '2026-07-24T00:00:00.000Z');
  `)
}

function auth(
  userId: string,
  options: {
    role?: AuthContext['role']
    memberId?: string
    grants?: CapabilityGrant[]
    tenant?: string
  } = {},
): AuthContext {
  return {
    userId,
    email: null,
    role: options.role ?? 'member',
    tenant: options.tenant ?? TENANT,
    ...(options.memberId ? { memberId: options.memberId } : {}),
    ...(options.grants ? { capabilities: options.grants } : {}),
  }
}

describe('agent connection public status', () => {
  let harness: SqliteD1Harness
  let env: Env
  let issued: AgentConnectionIssued

  beforeEach(async () => {
    harness = createSqliteD1()
    applyMigrations(harness.sqlite)
    seed(harness.sqlite)
    env = {
      DB: harness.db,
      TENANT_SLUG: TENANT,
      PUBLIC_ORIGIN: 'https://pot.example',
      SESSIONS: {
        get: async () => JSON.stringify({
          userId: 'owner-1',
          email: null,
          role: 'owner',
          createdAt: NOW.toISOString(),
        }),
      },
    } as unknown as Env
    const outcome = await provisionAgentConnection(env, {
      kind: 'user',
      id: 'owner-1',
      grants: [],
      legacyOrgRole: 'owner',
    }, {
      requestId: 'status-request',
      target: {
        kind: 'new',
        homeSquadId: 'squad-home',
        agent: { slug: 'status-agent', name: 'Status Agent' },
      },
      additionalAccess: [],
      credential: {
        action: 'issue_if_missing',
        label: 'workspace',
        homeCapability: 'member',
      },
    }, NOW)
    if (outcome.status !== 'credential_issued') throw new Error(outcome.status)
    issued = outcome
  })

  afterEach(() => harness.close())

  it('allows the issuing user and returns sanitized snapshot plus labelled current state', async () => {
    const result = await loadAgentConnectionStatus(
      env,
      auth('owner-1'),
      issued.receipt.id,
    )
    expect(result).toMatchObject({
      ok: true,
      value: {
        receipt_id: issued.receipt.id,
        request_id: 'status-request',
        issuance: {
          agent: {
            id: issued.receipt.agent_id,
            slug: 'status-agent',
            status_at_issue: 'active',
          },
          home_squad_id: 'squad-home',
          token_id_suffix: issued.receipt.token_id.slice(-4),
        },
        verification: { status: 'pending', attempts: 0 },
        current: {
          agent_status: 'active',
          token_revoked: false,
          access: [{
            squad_id: 'squad-home',
            membership_capability: 'member',
            member_capability: 'member',
            synchronized: true,
          }],
        },
      },
    })
    if (!result.ok) throw new Error(result.error)
    const serialized = JSON.stringify(result.value)
    expect(serialized).not.toContain(issued.credential.raw)
    expect(serialized).not.toContain(issued.verification.challenge)
    expect(serialized).not.toContain(issued.receipt.verification_challenge_hash as string)
    expect(serialized).not.toContain(issued.receipt.actor_id)
    expect(serialized).not.toContain(issued.receipt.token_id)
    expect(serialized).not.toContain(issued.receipt.request_fingerprint)
    expect(serialized).not.toContain('Mupot agent connection verification')
  })

  it('allows the issuing member and effective home admin through scope inheritance', async () => {
    harness.sqlite.exec(`
      INSERT INTO members (id, display_name, email, status, tenant) VALUES
        ('issuing-member', 'Issuer', 'issuer@example.com', 'active', '${TENANT}'),
        ('squad-admin', 'Squad Admin', 'admin@example.com', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
        ('issuer-admin', 'issuing-member', 'squad', 'squad-home', 'admin'),
        ('admin-dept', 'squad-admin', 'department', 'dept-1', 'admin');
    `)
    const memberIssued = await provisionAgentConnection(env, {
      kind: 'member',
      id: 'issuing-member',
      grants: [{
        member_id: 'issuing-member',
        scope_type: 'squad',
        scope_id: 'squad-home',
        capability: 'admin',
      }],
    }, {
      requestId: 'member-status-request',
      target: {
        kind: 'new',
        homeSquadId: 'squad-home',
        agent: { slug: 'member-status-agent', name: 'Member Status Agent' },
      },
      additionalAccess: [],
      credential: { action: 'issue_if_missing', label: 'workspace' },
    }, NOW)
    if (memberIssued.status !== 'credential_issued') throw new Error(memberIssued.status)

    await expect(loadAgentConnectionStatus(
      env,
      auth('web-issuer', {
        memberId: 'issuing-member',
        grants: [{
          member_id: 'issuing-member',
          scope_type: 'squad',
          scope_id: 'squad-home',
          capability: 'admin',
        }],
      }),
      memberIssued.receipt.id,
    )).resolves.toMatchObject({ ok: true })

    await expect(loadAgentConnectionStatus(
      env,
      auth('web-admin', {
        memberId: 'squad-admin',
        grants: [{
          member_id: 'squad-admin',
          scope_type: 'department',
          scope_id: 'dept-1',
          capability: 'admin',
        }],
      }),
      issued.receipt.id,
    )).resolves.toMatchObject({ ok: true })
  })

  it('returns the same not_found for unauthorized, cross-tenant, and absent receipts', async () => {
    const unauthorized = auth('stranger', {
      memberId: 'stranger-member',
      grants: [],
    })
    await expect(
      loadAgentConnectionStatus(env, unauthorized, issued.receipt.id),
    ).resolves.toEqual({ ok: false, error: 'not_found' })

    const otherTenantEnv = { ...env, TENANT_SLUG: 'tenant-b' } as Env
    await expect(
      loadAgentConnectionStatus(
        otherTenantEnv,
        auth('owner-1', { tenant: 'tenant-b' }),
        issued.receipt.id,
      ),
    ).resolves.toEqual({ ok: false, error: 'not_found' })

    await expect(
      loadAgentConnectionStatus(env, auth('owner-1'), 'missing-receipt'),
    ).resolves.toEqual({ ok: false, error: 'not_found' })
  })

  it('labels current token revocation and access drift separately from issuance', async () => {
    harness.sqlite.prepare(
      'UPDATE member_tokens SET revoked_at = ? WHERE id = ?',
    ).run('2026-07-24T13:00:00.000Z', issued.receipt.token_id)
    harness.sqlite.prepare(
      `UPDATE capabilities
          SET capability = 'observer'
        WHERE member_id = ? AND scope_type = 'squad' AND scope_id = 'squad-home'`,
    ).run(issued.receipt.member_id)

    const result = await loadAgentConnectionStatus(
      env,
      auth('owner-1'),
      issued.receipt.id,
    )
    expect(result).toMatchObject({
      ok: true,
      value: {
        issuance: { home_capability: 'member' },
        current: {
          token_revoked: true,
          access: [{
            squad_id: 'squad-home',
            membership_capability: 'member',
            member_capability: 'observer',
            synchronized: false,
          }],
        },
      },
    })
  })

  it('serves the issuing actor through the authenticated dashboard route across refreshes', async () => {
    for (let refresh = 0; refresh < 2; refresh += 1) {
      const response = await dashboardApp.request(
        `https://pot.example/api/agent-connections/${issued.receipt.id}/status`,
        { headers: { Cookie: 'mupot_session=session-1' } },
        env,
      )
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        receipt_id: issued.receipt.id,
        verification: { status: 'pending' },
      })
    }
  })

  // #847 P2-2: the dashboard-wide capability floor (dashboard/index.ts) used to
  // exempt this route entirely, reasoning the issuer "may hold ZERO standing
  // capabilities." That premise does not hold in production (provision_agent_
  // connection always requires — and the issuer therefore always holds — a real
  // admin-rank grant on the receipt's home squad before a receipt is written),
  // so the exemption was removed and this route now sits behind the SAME floor
  // every other dashboard GET/HEAD route does.
  it('a session with ZERO capabilities anywhere is blocked by the floor before the route runs (403)', async () => {
    env = {
      ...env,
      SESSIONS: {
        get: async () => JSON.stringify({
          userId: 'stranger',
          email: null,
          role: 'member',
          createdAt: NOW.toISOString(),
        }),
      },
    } as unknown as Env
    const response = await dashboardApp.request(
      // ?format=json — same content-negotiation precedent as every other floor-gated
      // GET route (dashboard/index.ts): a bearerless browser navigation gets the
      // rendered deny page, an API-style caller asking for JSON gets a JSON 403.
      `https://pot.example/api/agent-connections/${issued.receipt.id}/status?format=json`,
      { headers: { Cookie: 'mupot_session=session-1' } },
      env,
    )
    // Blocked by the dashboard-wide floor, not the route's own not-found shape —
    // this caller never reaches callerMayPoll at all.
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: 'forbidden', need: 'capability' })
  })

  // Proves callerMayPoll's own per-receipt authorization is still the real
  // enforcement point for a caller who clears the floor (holds SOME capability
  // somewhere) but is not the issuer and not admin on THIS receipt's home
  // squad — the floor removal above does not turn this into a rubber stamp.
  it('a session that clears the floor but is unauthorized for this receipt still gets 404 (not-found contract intact)', async () => {
    harness.sqlite.exec(`
      INSERT INTO members (id, display_name, email, status, tenant) VALUES
        ('unrelated-admin', 'Unrelated Admin', 'unrelated@example.com', 'active', '${TENANT}');
      INSERT INTO squads (id, department_id, slug, name) VALUES
        ('squad-unrelated', 'dept-1', 'unrelated', 'Unrelated');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
        ('unrelated-admin-cap', 'unrelated-admin', 'squad', 'squad-unrelated', 'admin');
    `)
    env = {
      ...env,
      SESSIONS: {
        get: async () => JSON.stringify({
          userId: 'unrelated-admin',
          email: 'unrelated@example.com',
          role: 'member',
          createdAt: NOW.toISOString(),
        }),
      },
    } as unknown as Env
    const response = await dashboardApp.request(
      `https://pot.example/api/agent-connections/${issued.receipt.id}/status`,
      { headers: { Cookie: 'mupot_session=session-1' } },
      env,
    )
    // Clears the dashboard floor (holds an admin grant on squad-unrelated), but
    // callerMayPoll denies: not the issuer, not org-admin, not admin on
    // squad-home. The route's own not-found (never 403) contract holds here.
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'not_found' })
  })
})
