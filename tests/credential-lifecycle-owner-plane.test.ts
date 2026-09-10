// tests/credential-lifecycle-owner-plane.test.ts — mupot#1366.
//
// PR #1359 raised mint_agent_token to see BOTH authority planes
// (memberCanOnSquadAuth), but the other six doors on the same credential
// surface still read `auth.capabilities ?? []` + memberCanOnSquad — blind to
// the legacy role plane where the org owner's authority actually lives.
// After #1359 merges without this, the org owner can mint a seat key and then
// cannot list it, cannot revoke it, cannot register the agent's key, cannot
// grant capabilities on its squad, cannot update its row, cannot deactivate it.
//
// The six doors, all in src/mcp/provision.ts:
//   list_agent_tokens / revoke_agent_token / grant_agent_capability /
//   register_agent_key / update_agent / deactivate_agent
//
// Fix shape (same seam, same bar, no new primitive): memberCanOnSquadAuth at
// each site. One place needed a second touch the issue's line-list did not
// name: grant_agent_capability's rank ceiling (callerCanGrantAgentCapability)
// asks the same standing-authority question grants-only, so the site fix opens
// the door and the ceiling shuts it again for the owner. It is raised to the
// same seam at the caller's own requested rank — the bar (rank X to grant rank
// X) is unchanged. Kasra gates; revert that hunk alone if the ruling differs.
//
// Discipline, copied from tests/enroll-mint-owner-plane.test.ts:
//   - real sqlite, ALL migrations in order (tests/helpers/migrations) — never a
//     hand-written CREATE TABLE (CI #711), never a string-matching DB mock (#721)
//   - the org owner as the bridge builds him: role 'owner' on the legacy plane,
//     capabilities UNDEFINED (never []), zero rows in `capabilities`
//   - every negative is PAIRED with a positive: a refusal test that passes
//     because the harness returned null for everything proves nothing

import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { createAgent, getAgentProfile } from '../src/org/service'
// Side-effect first: src/mcp/provision ↔ src/mcp/index form a cycle, and
// importing provision first leaves PROVISION_TOOLS undefined inside index's
// spread (see tests/provision-tools.test.ts import order for the same reason).
import '../src/mcp'
import { PROVISION_TOOLS } from '../src/mcp/provision'
import type { ToolCtx, ToolSpec } from '../src/mcp'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'tenant-credlife'
const DEPT = 'dept-eng'
const SQUAD = 'squad-crew'
const OTHER_SQUAD = 'squad-elsewhere'
const OWNER_MEMBER = 'mem-owner'
const WELD_MEMBER = 'mem-weld'
const CTX: ToolCtx = { origin: 'test', transport: 'mcp' }

function runTool(name: string): ToolSpec {
  const tool = PROVISION_TOOLS.find((t) => t.name === name)
  if (!tool) throw new Error(`tool not registered: ${name}`)
  return tool
}

interface Fixture {
  h: SqliteD1Harness
  env: Env
  agentId: string
  agentSlug: string
}

/** Fresh real-schema world per test: dept, two squads, one agent with a live seat token. */
async function fixture(): Promise<Fixture> {
  const h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('${DEPT}', 'eng', 'Engineering');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('${SQUAD}', '${DEPT}', 'crew', 'Crew'),
      ('${OTHER_SQUAD}', '${DEPT}', 'elsewhere', 'Elsewhere');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('${OWNER_MEMBER}', 'hadi@mumega.com', 'Hadi', 'active', '${TENANT}'),
      ('${WELD_MEMBER}', 'weld@test.local', 'Weld', 'active', '${TENANT}');
    INSERT INTO org_settings (key, value, updated_at)
      VALUES ('billing_state', '{"tier":"scale"}', '2026-07-22 00:00:00');
  `)
  const env = { DB: h.db, TENANT_SLUG: TENANT } as unknown as Env
  const created = await createAgent(env, SQUAD, {
    slug: 'seat-one',
    name: 'Seat One',
    role: 'member',
    model: 'deepseek-v4-flash',
  })
  if (!created.ok) throw new Error(`fixture agent create failed: ${created.error}`)
  const agentId = created.value.id
  h.sqlite.exec(`
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('${TENANT}', '${agentId}', '${WELD_MEMBER}', '2026-09-10T00:00:00.000Z');
    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
      VALUES ('tok-live', '${WELD_MEMBER}', 'hash-tok-live', 'seat', 'workspace', '2026-09-10T00:00:00.000Z', '${agentId}', '${TENANT}');
  `)
  return { h, env, agentId, agentSlug: created.value.slug }
}

/** The org owner as the bridge builds him: role on the legacy plane, capabilities UNDEFINED. */
function ownerAuth(): AuthContext {
  return {
    userId: OWNER_MEMBER,
    memberId: OWNER_MEMBER,
    email: 'hadi@mumega.com',
    role: 'owner',
    tenant: TENANT,
    channel: 'dashboard',
    boundAgentId: null,
    capabilities: undefined,
  } as unknown as AuthContext
}

function grantAuth(grants: CapabilityGrant[]): AuthContext {
  return {
    userId: 'mem-op',
    memberId: 'mem-op',
    email: 'someone@x.test',
    role: 'member',
    tenant: TENANT,
    channel: 'dashboard',
    boundAgentId: null,
    capabilities: grants,
  } as unknown as AuthContext
}

const squadAdmin = () =>
  grantAuth([{ member_id: 'mem-op', scope_type: 'squad', scope_id: SQUAD, capability: 'admin' }])
const squadLead = () =>
  grantAuth([{ member_id: 'mem-op', scope_type: 'squad', scope_id: SQUAD, capability: 'lead' }])
const otherSquadAdmin = () =>
  grantAuth([{ member_id: 'mem-op', scope_type: 'squad', scope_id: OTHER_SQUAD, capability: 'admin' }])
const grantless = () => grantAuth([])

/** Genuine Ed25519 public x — isValidEd25519PublicX does a real subtle.importKey. */
async function freshPublicX(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  return jwk.x as string
}

function noiseKey(): string {
  return randomBytes(32).toString('base64url')
}

describe('credential lifecycle sees the role-plane owner (mupot#1366)', () => {
  // ── list_agent_tokens ──────────────────────────────────────────────────
  it('owner LISTS the seat key he minted', async () => {
    const { h, env, agentId } = await fixture()
    try {
      const out = await runTool('list_agent_tokens').run(ownerAuth(), env, { agent: agentId }, CTX)
      expect(out.ok, JSON.stringify(out)).toBe(true)
      if (!out.ok) return
      const result = out.result as { tokens: Array<Record<string, unknown>> }
      expect(result.tokens.map((t) => t.id)).toContain('tok-live')
      // neither this tool nor any helper may emit a secret
      expect(JSON.stringify(out)).not.toContain('SECRET')
      expect(JSON.stringify(out)).not.toContain('hash-tok-live')
    } finally {
      h.sqlite.close()
    }
  })

  it('squad admin on THIS squad still lists, as before', async () => {
    const { h, env, agentId } = await fixture()
    try {
      const out = await runTool('list_agent_tokens').run(squadAdmin(), env, { agent: agentId }, CTX)
      expect(out.ok, JSON.stringify(out)).toBe(true)
    } finally {
      h.sqlite.close()
    }
  })

  it('squad LEAD is still refused list', async () => {
    const { h, env, agentId } = await fixture()
    try {
      const out = await runTool('list_agent_tokens').run(squadLead(), env, { agent: agentId }, CTX)
      expect(out.ok).toBe(false)
    } finally {
      h.sqlite.close()
    }
  })

  it('other-squad admin is still refused list', async () => {
    const { h, env, agentId } = await fixture()
    try {
      const out = await runTool('list_agent_tokens').run(otherSquadAdmin(), env, { agent: agentId }, CTX)
      expect(out.ok).toBe(false)
    } finally {
      h.sqlite.close()
    }
  })

  it('grantless member is still refused list', async () => {
    const { h, env, agentId } = await fixture()
    try {
      const out = await runTool('list_agent_tokens').run(grantless(), env, { agent: agentId }, CTX)
      expect(out.ok).toBe(false)
    } finally {
      h.sqlite.close()
    }
  })

  it('agent-bound caller is refused list first, owner role or not', async () => {
    const { h, env, agentId } = await fixture()
    try {
      const agentOwner = { ...ownerAuth(), boundAgentId: 'agent-other' } as unknown as AuthContext
      const out = await runTool('list_agent_tokens').run(agentOwner, env, { agent: agentId }, CTX)
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.error).toBe('operator_principal_required')
    } finally {
      h.sqlite.close()
    }
  })

  // ── revoke_agent_token ─────────────────────────────────────────────────
  it('owner REVOKES the seat key he minted, idempotently', async () => {
    const { h, env, agentId } = await fixture()
    try {
      const tool = runTool('revoke_agent_token')
      const first = await tool.run(ownerAuth(), env, { agent: agentId, token_id: 'tok-live' }, CTX)
      expect(first.ok, JSON.stringify(first)).toBe(true)
      if (!first.ok) return
      expect((first.result as { revoked: boolean }).revoked).toBe(true)
      const row = h.sqlite
        .prepare('SELECT revoked_at FROM member_tokens WHERE id = ?')
        .get('tok-live') as { revoked_at: string | null }
      expect(row.revoked_at).not.toBeNull()
      const second = await tool.run(ownerAuth(), env, { agent: agentId, token_id: 'tok-live' }, CTX)
      expect(second.ok).toBe(true)
      if (second.ok) expect((second.result as { already_revoked: boolean }).already_revoked).toBe(true)
    } finally {
      h.sqlite.close()
    }
  })

  it('squad LEAD is still refused revoke', async () => {
    const { h, env, agentId } = await fixture()
    try {
      const out = await runTool('revoke_agent_token').run(squadLead(), env, { agent: agentId, token_id: 'tok-live' }, CTX)
      expect(out.ok).toBe(false)
      const row = h.sqlite
        .prepare('SELECT revoked_at FROM member_tokens WHERE id = ?')
        .get('tok-live') as { revoked_at: string | null }
      expect(row.revoked_at).toBeNull() // the refusal revoked nothing
    } finally {
      h.sqlite.close()
    }
  })

  it('other-squad admin is still refused revoke', async () => {
    const { h, env, agentId } = await fixture()
    try {
      const out = await runTool('revoke_agent_token').run(otherSquadAdmin(), env, {
        agent: agentId,
        token_id: 'tok-live',
      }, CTX)
      expect(out.ok).toBe(false)
    } finally {
      h.sqlite.close()
    }
  })

  it('grantless member is still refused revoke', async () => {
    const { h, env, agentId } = await fixture()
    try {
      const out = await runTool('revoke_agent_token').run(grantless(), env, { agent: agentId, token_id: 'tok-live' }, CTX)
      expect(out.ok).toBe(false)
    } finally {
      h.sqlite.close()
    }
  })

  it('agent-bound caller is refused revoke first, owner role or not', async () => {
    const { h, env, agentId } = await fixture()
    try {
      const agentOwner = { ...ownerAuth(), boundAgentId: 'agent-other' } as unknown as AuthContext
      const out = await runTool('revoke_agent_token').run(agentOwner, env, { agent: agentId, token_id: 'tok-live' }, CTX)
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.error).toBe('operator_principal_required')
    } finally {
      h.sqlite.close()
    }
  })

  // ── grant_agent_capability ─────────────────────────────────────────────
  it('owner GRANTS member on the seat squad', async () => {
    const { h, env, agentId } = await fixture()
    try {
      const out = await runTool('grant_agent_capability').run(
        ownerAuth(),
        env,
        { agent: agentId, squad: SQUAD, capability: 'member' },
        CTX,
      )
      expect(out.ok, JSON.stringify(out)).toBe(true)
    } finally {
      h.sqlite.close()
    }
  })

  it('squad LEAD is still refused grant', async () => {
    const { h, env, agentId } = await fixture()
    try {
      const out = await runTool('grant_agent_capability').run(
        squadLead(),
        env,
        { agent: agentId, squad: SQUAD, capability: 'member' },
        CTX,
      )
      expect(out.ok).toBe(false)
    } finally {
      h.sqlite.close()
    }
  })

  it('other-squad admin is still refused grant on this squad', async () => {
    const { h, env, agentId } = await fixture()
    try {
      const out = await runTool('grant_agent_capability').run(
        otherSquadAdmin(),
        env,
        { agent: agentId, squad: SQUAD, capability: 'member' },
        CTX,
      )
      expect(out.ok).toBe(false)
    } finally {
      h.sqlite.close()
    }
  })

  it('grantless member is still refused grant', async () => {
    const { h, env, agentId } = await fixture()
    try {
      const out = await runTool('grant_agent_capability').run(
        grantless(),
        env,
        { agent: agentId, squad: SQUAD, capability: 'member' },
        CTX,
      )
      expect(out.ok).toBe(false)
    } finally {
      h.sqlite.close()
    }
  })

  it('agent-bound caller without a live grant is refused grant first', async () => {
    const { h, env, agentId } = await fixture()
    try {
      const agentCaller = {
        ...grantless(),
        memberId: WELD_MEMBER,
        boundAgentId: 'agent-other',
      } as unknown as AuthContext
      const out = await runTool('grant_agent_capability').run(
        agentCaller,
        env,
        { agent: agentId, squad: SQUAD, capability: 'member' },
        CTX,
      )
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.error).toBe('operator_principal_required')
    } finally {
      h.sqlite.close()
    }
  })

  // ── register_agent_key ─────────────────────────────────────────────────
  it('owner REGISTERS the seat key', async () => {
    const { h, env, agentId } = await fixture()
    try {
      const out = await runTool('register_agent_key').run(
        ownerAuth(),
        env,
        { agent: agentId, public_key: await freshPublicX(), key_id: agentId },
        CTX,
      )
      expect(out.ok, JSON.stringify(out)).toBe(true)
    } finally {
      h.sqlite.close()
    }
  })

  it('squad LEAD is still refused register', async () => {
    const { h, env, agentId } = await fixture()
    try {
      const out = await runTool('register_agent_key').run(
        squadLead(),
        env,
        { agent: agentId, public_key: noiseKey(), key_id: agentId },
        CTX,
      )
      expect(out.ok).toBe(false)
    } finally {
      h.sqlite.close()
    }
  })

  it('other-squad admin is still refused register', async () => {
    const { h, env, agentId } = await fixture()
    try {
      const out = await runTool('register_agent_key').run(
        otherSquadAdmin(),
        env,
        { agent: agentId, public_key: noiseKey(), key_id: agentId },
        CTX,
      )
      expect(out.ok).toBe(false)
    } finally {
      h.sqlite.close()
    }
  })

  it('grantless member is still refused register', async () => {
    const { h, env, agentId } = await fixture()
    try {
      const out = await runTool('register_agent_key').run(
        grantless(),
        env,
        { agent: agentId, public_key: noiseKey(), key_id: agentId },
        CTX,
      )
      expect(out.ok).toBe(false)
    } finally {
      h.sqlite.close()
    }
  })

  it('agent-bound caller is refused register first, owner role or not', async () => {
    const { h, env, agentId } = await fixture()
    try {
      const agentOwner = { ...ownerAuth(), boundAgentId: 'agent-other' } as unknown as AuthContext
      const out = await runTool('register_agent_key').run(
        agentOwner,
        env,
        { agent: agentId, public_key: noiseKey(), key_id: agentId },
        CTX,
      )
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.error).toBe('operator_principal_required')
    } finally {
      h.sqlite.close()
    }
  })

  // ── update_agent ───────────────────────────────────────────────────────
  it('owner UPDATES the seat row', async () => {
    const { h, env, agentId } = await fixture()
    try {
      const out = await runTool('update_agent').run(ownerAuth(), env, { agent: agentId, purpose: 'night watch' }, CTX)
      expect(out.ok, JSON.stringify(out)).toBe(true)
      const reread = await getAgentProfile(env, agentId)
      expect(reread?.purpose).toBe('night watch')
    } finally {
      h.sqlite.close()
    }
  })

  it('squad LEAD is still refused update', async () => {
    const { h, env, agentId } = await fixture()
    try {
      const out = await runTool('update_agent').run(squadLead(), env, { agent: agentId, purpose: 'x' }, CTX)
      expect(out.ok).toBe(false)
    } finally {
      h.sqlite.close()
    }
  })

  it('other-squad admin is still refused update', async () => {
    const { h, env, agentId } = await fixture()
    try {
      const out = await runTool('update_agent').run(otherSquadAdmin(), env, { agent: agentId, purpose: 'x' }, CTX)
      expect(out.ok).toBe(false)
    } finally {
      h.sqlite.close()
    }
  })

  it('grantless member is still refused update', async () => {
    const { h, env, agentId } = await fixture()
    try {
      const out = await runTool('update_agent').run(grantless(), env, { agent: agentId, purpose: 'x' }, CTX)
      expect(out.ok).toBe(false)
    } finally {
      h.sqlite.close()
    }
  })

  it('agent-bound caller on ANOTHER row is refused update', async () => {
    const { h, env, agentId } = await fixture()
    try {
      const agentCaller = {
        ...grantless(),
        memberId: WELD_MEMBER,
        boundAgentId: 'agent-other',
      } as unknown as AuthContext
      const out = await runTool('update_agent').run(agentCaller, env, { agent: agentId, purpose: 'x' }, CTX)
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.error).toBe('operator_principal_required')
    } finally {
      h.sqlite.close()
    }
  })

  // ── deactivate_agent ───────────────────────────────────────────────────
  it('owner DEACTIVATES the seat and its live token dies with it', async () => {
    const { h, env, agentId } = await fixture()
    try {
      const out = await runTool('deactivate_agent').run(ownerAuth(), env, { agent: agentId }, CTX)
      expect(out.ok, JSON.stringify(out)).toBe(true)
      const agent = h.sqlite.prepare('SELECT status FROM agents WHERE id = ?').get(agentId) as { status: string }
      expect(agent.status).toBe('inactive')
      const token = h.sqlite
        .prepare('SELECT revoked_at FROM member_tokens WHERE id = ?')
        .get('tok-live') as { revoked_at: string | null }
      expect(token.revoked_at).not.toBeNull()
    } finally {
      h.sqlite.close()
    }
  })

  it('squad LEAD is still refused deactivate', async () => {
    const { h, env, agentId } = await fixture()
    try {
      const out = await runTool('deactivate_agent').run(squadLead(), env, { agent: agentId }, CTX)
      expect(out.ok).toBe(false)
      const agent = h.sqlite.prepare('SELECT status FROM agents WHERE id = ?').get(agentId) as { status: string }
      expect(agent.status).not.toBe('inactive')
    } finally {
      h.sqlite.close()
    }
  })

  it('other-squad admin is still refused deactivate', async () => {
    const { h, env, agentId } = await fixture()
    try {
      const out = await runTool('deactivate_agent').run(otherSquadAdmin(), env, { agent: agentId }, CTX)
      expect(out.ok).toBe(false)
    } finally {
      h.sqlite.close()
    }
  })

  it('grantless member is still refused deactivate', async () => {
    const { h, env, agentId } = await fixture()
    try {
      const out = await runTool('deactivate_agent').run(grantless(), env, { agent: agentId }, CTX)
      expect(out.ok).toBe(false)
    } finally {
      h.sqlite.close()
    }
  })

  it('agent-bound caller is refused deactivate', async () => {
    const { h, env, agentId } = await fixture()
    try {
      const agentCaller = {
        ...grantless(),
        memberId: WELD_MEMBER,
        boundAgentId: 'agent-other',
      } as unknown as AuthContext
      const out = await runTool('deactivate_agent').run(agentCaller, env, { agent: agentId }, CTX)
      expect(out.ok).toBe(false)
    } finally {
      h.sqlite.close()
    }
  })
})
