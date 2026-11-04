import { describe, expect, it } from 'vitest'
import { displayRole } from '../src/auth/capability'
import { mcpApp } from '../src/mcp'
import type { AuthContext, Capability, CapabilityGrant, Env } from '../src/types'
import { mcpRequest } from './helpers/mcp-call'

function g(scope_type: CapabilityGrant['scope_type'], scope_id: string | null, capability: Capability): CapabilityGrant {
  return { member_id: 'member-1', scope_type, scope_id, capability }
}
function a(role: AuthContext['role'], capabilities: CapabilityGrant[] | undefined): AuthContext {
  return { userId: 'm', memberId: 'm', email: 'm@x.test', role, tenant: 't', channel: 'workspace', capabilities, boundAgentId: null }
}

describe('displayRole (mupot#2309)', () => {
  it.each([
    ['org owner grant on member role', a('member', [g('org', null, 'owner')]), 'owner'],
    ['org admin grant on member role', a('member', [g('org', null, 'admin')]), 'admin'],
    ['legacy owner role', a('owner', []), 'owner'],
    ['legacy admin role', a('admin', []), 'admin'],
    ['legacy admin role with org owner grant', a('admin', [g('org', null, 'owner')]), 'owner'],
    ['squad owner grant is not org owner', a('member', [g('squad', 's1', 'owner')]), 'member'],
    ['org lead grant stays member', a('member', [g('org', null, 'lead')]), 'member'],
    ['no grants', a('member', []), 'member'],
  ])('%s -> %s', (_l, auth, want) => {
    expect(displayRole(auth)).toBe(want)
  })
})

function makeEnv(grants: CapabilityGrant[], channel: 'workspace' | 'directory'): Env {
  const handler = (sql: string) => ({
    bind() {
      return {
        async first() {
          if (sql.includes('FROM member_tokens')) {
            return { member_id: 'member-1', email: null, display_name: 'P', telegram_chat_id: null, status: 'active', created_at: '2026-06-13 00:00:00', channel, bound_agent_id: null }
          }
          return null
        },
        async all() {
          if (sql.includes('FROM capabilities')) return { results: grants }
          return { results: [] }
        },
      }
    },
  })
  return { TENANT_SLUG: 'digid', BRAND: 'Digid', OAUTH_PROVIDER: 'google', DB: { prepare: (sql: string) => handler(sql) } } as unknown as Env
}

async function call(env: Env, name: string) {
  const res = await mcpRequest('https://agents.digid.ca/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }),
  }, env)
  const body = (await res.json()) as { result: { structuredContent: Record<string, unknown> } }
  return body.result.structuredContent
}

describe('status / boot_context show the real role and do not send an admin to an admin', () => {
  const ownerGrants = [g('org', null, 'owner')]
  const adminGrants = [g('org', null, 'admin')]
  const memberGrants = [g('org', null, 'member')]

  it('status shows owner / admin / member', async () => {
    expect((await call(makeEnv(ownerGrants, 'workspace'), 'status')).role).toBe('owner')
    expect((await call(makeEnv(adminGrants, 'workspace'), 'status')).role).toBe('admin')
    expect((await call(makeEnv(memberGrants, 'workspace'), 'status')).role).toBe('member')
  })

  it('boot_context shows owner / admin / member', async () => {
    expect((await call(makeEnv(ownerGrants, 'workspace'), 'boot_context')).role).toBe('owner')
    expect((await call(makeEnv(adminGrants, 'workspace'), 'boot_context')).role).toBe('admin')
    expect((await call(makeEnv(memberGrants, 'workspace'), 'boot_context')).role).toBe('member')
  })

  it('workspace door: owner/admin are not told to ask an org-admin; a member still is', async () => {
    for (const grants of [ownerGrants, adminGrants]) {
      const sc = await call(makeEnv(grants, 'workspace'), 'boot_context')
      const text = JSON.stringify(sc.available_doors)
      expect(text).toContain('mint_agent_token')
      expect(text).not.toMatch(/ask an org-admin/i)
    }
    const member = JSON.stringify((await call(makeEnv(memberGrants, 'workspace'), 'boot_context')).available_doors)
    expect(member).toMatch(/ask an org-admin/i)
  })

  it('directory door to_get_write_access: owner/admin are not told to ask an org-admin to mint', async () => {
    for (const grants of [ownerGrants, adminGrants]) {
      const sc = await call(makeEnv(grants, 'directory'), 'boot_context')
      const hint = JSON.stringify(sc.channel_limits ?? sc)
      expect(hint).not.toMatch(/ask an org-admin/i)
    }
  })
})

void mcpApp
