import { describe, expect, it } from 'vitest'
import { displayRole } from '../src/auth/capability'
import type { AuthContext, Capability, CapabilityGrant, Env } from '../src/types'
import { createHash } from 'node:crypto'
import { holdsAdminStanding } from '../src/mcp'
import { mcpRequest } from './helpers/mcp-call'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

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

// Real SQL: schema from the migrations, a real member + bearer-token row + capability rows (mupot test-schema-source rule).
async function makeEnv(grants: CapabilityGrant[], channel: 'workspace' | 'directory'): Promise<Env> {
  const h: SqliteD1Harness = createSqliteD1()
  applyAllMigrations(h.sqlite)
  const tokenHash = createHash('sha256').update('test-token').digest('hex')
  h.sqlite.exec(`
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('member-1', 'member-1@x.test', 'P', 'active', 'digid');
    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, tenant) VALUES ('tok-1', 'member-1', '${tokenHash}', 't', '${channel}', 'digid');
  `)
  grants.forEach((gr, i) => {
    h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-${i}', 'member-1', '${gr.scope_type}', ${gr.scope_id === null ? 'NULL' : `'${gr.scope_id}'`}, '${gr.capability}')`)
  })
  return { TENANT_SLUG: 'digid', BRAND: 'Digid', OAUTH_PROVIDER: 'google', DB: h.db } as unknown as Env
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

const ASK_ADMIN = /ask an org[- ]admin/i // both spellings: doors say 'org-admin', whoami says 'org admin'

describe('status / boot_context show the real role and do not send an admin to an admin', () => {
  const ownerGrants = [g('org', null, 'owner')]
  const adminGrants = [g('org', null, 'admin')]
  const memberGrants = [g('org', null, 'member')]

  it('status shows owner / admin / member', async () => {
    expect((await call(await makeEnv(ownerGrants, 'workspace'), 'status')).role).toBe('owner')
    expect((await call(await makeEnv(adminGrants, 'workspace'), 'status')).role).toBe('admin')
    expect((await call(await makeEnv(memberGrants, 'workspace'), 'status')).role).toBe('member')
  })

  it('boot_context shows owner / admin / member', async () => {
    expect((await call(await makeEnv(ownerGrants, 'workspace'), 'boot_context')).role).toBe('owner')
    expect((await call(await makeEnv(adminGrants, 'workspace'), 'boot_context')).role).toBe('admin')
    expect((await call(await makeEnv(memberGrants, 'workspace'), 'boot_context')).role).toBe('member')
  })

  it('workspace door: owner/admin are not told to ask an org-admin; a member still is', async () => {
    for (const grants of [ownerGrants, adminGrants]) {
      const sc = await call(await makeEnv(grants, 'workspace'), 'boot_context')
      expect(JSON.stringify(sc.available_doors)).toContain('mint_agent_token')
      expect(JSON.stringify(sc)).not.toMatch(ASK_ADMIN) // the WHOLE boot_context output, incl. the whoami first line
    }
    const member = await call(await makeEnv(memberGrants, 'workspace'), 'boot_context')
    expect(JSON.stringify(member.available_doors)).toMatch(ASK_ADMIN) // positive control
    expect(JSON.stringify(member.whoami)).toMatch(ASK_ADMIN)
  })

  it('directory door to_get_write_access: owner/admin are not told to ask an org-admin to mint', async () => {
    for (const grants of [ownerGrants, adminGrants]) {
      const sc = await call(await makeEnv(grants, 'directory'), 'boot_context')
      expect(JSON.stringify(sc)).not.toMatch(ASK_ADMIN)
    }
  })

  it('directory door positive control: a plain member DOES see the ask-an-admin hint', async () => {
    const sc = await call(await makeEnv(memberGrants, 'directory'), 'boot_context')
    expect(JSON.stringify(sc.channel_limits)).toMatch(ASK_ADMIN)
  })
})

// holdsAdminStanding, driven directly against real SQL (hint-only helper; never a permission decision).
async function standingEnv(rows: Array<{ member: string; capability: Capability; scope_type?: 'org' | 'squad'; scope_id?: string | null }>): Promise<Env> {
  const h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  for (const m of new Set(rows.map((r) => r.member))) {
    h.sqlite.exec(`INSERT INTO members (id, email, display_name, status, tenant) VALUES ('${m}', '${m}@x.test', '${m}', 'active', 'digid')`)
  }
  rows.forEach((r, i) => {
    const sid = r.scope_id === undefined || r.scope_id === null ? 'NULL' : `'${r.scope_id}'`
    h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('c${i}', '${r.member}', '${r.scope_type ?? 'org'}', ${sid}, '${r.capability}')`)
  })
  return { TENANT_SLUG: 'digid', DB: h.db } as unknown as Env
}
function who(over: Partial<AuthContext>): AuthContext {
  return { userId: 'x', memberId: 'x', email: null, role: 'member', tenant: 'digid', channel: 'directory', capabilities: [], boundAgentId: null, ...over } as AuthContext // email null is valid on the AuthContext shape used by bearer sessions
}
// Minimal seat binding: only humanMemberId is read by the helper under test.
const seat = (humanMemberId: string): AuthContext['seatBinding'] => ({ seatId: 's', label: 'l', harnessId: 'h', grantTokenId: 'g', humanMemberId, source: 'handle' }) as unknown as AuthContext['seatBinding'] // test-only partial; other fields unused by holdsAdminStanding

describe('holdsAdminStanding (hint-only)', () => {
  it('plain directory bearer: reads the member own rows (owner yes, member no)', async () => {
    const env = await standingEnv([{ member: 'own', capability: 'owner' }, { member: 'mem', capability: 'member' }])
    expect(await holdsAdminStanding(env, who({ memberId: 'own' }))).toBe(true)
    expect(await holdsAdminStanding(env, who({ memberId: 'mem' }))).toBe(false)
  })

  it('OAuth directory session: grants parked in latentCapabilities count, with no DB rows at all', async () => {
    const env = await standingEnv([])
    const latentOwner = [g('org', null, 'owner')]
    expect(await holdsAdminStanding(env, who({ memberId: 'ghost', latentCapabilities: latentOwner }))).toBe(true)
    expect(await holdsAdminStanding(env, who({ memberId: 'ghost', latentCapabilities: [g('org', null, 'member')] }))).toBe(false)
  })

  it('harness credential gets no standing from the member rows, even for an owner', async () => {
    const env = await standingEnv([{ member: 'own', capability: 'owner' }])
    expect(await holdsAdminStanding(env, who({ memberId: 'own', harnessCredential: true }))).toBe(false)
    expect(await holdsAdminStanding(env, who({ memberId: 'own' }))).toBe(true) // control: same member without the harness flag
  })

  it('seat session: standing is the HUMAN (seatBinding.humanMemberId), not the seat agent member', async () => {
    const env = await standingEnv([{ member: 'human-owner', capability: 'owner' }, { member: 'seat-agent', capability: 'member' }, { member: 'human-plain', capability: 'member' }])
    expect(await holdsAdminStanding(env, who({ memberId: 'seat-agent', channel: 'workspace', seatBinding: seat('human-owner') }))).toBe(true)
    expect(await holdsAdminStanding(env, who({ memberId: 'seat-agent', channel: 'workspace', seatBinding: seat('human-plain') }))).toBe(false)
  })

  it('OAuth consenter standing is used when there is no seat', async () => {
    const env = await standingEnv([{ member: 'consenter', capability: 'admin' }, { member: 'agent-m', capability: 'member' }])
    expect(await holdsAdminStanding(env, who({ memberId: 'agent-m', channel: 'workspace', consentedByMemberId: 'consenter' }))).toBe(true)
    expect(await holdsAdminStanding(env, who({ memberId: 'agent-m', channel: 'workspace' }))).toBe(false)
  })
})

