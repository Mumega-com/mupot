// mupot — squad-scoped agent-manager tools.
//
// This surface intentionally does NOT reuse the human owner/admin role. A caller
// must hold BOTH:
//   1. an exact/inherited member capability on the target squad, and
//   2. the explicit `agents:manage` surface grant on its authenticated member.
//
// The combination lets a trusted autonomous manager operate agent lifecycle only
// inside squads where it already belongs. Neither condition alone is sufficient.

import type { AuthContext, Env } from '../types'
import { hasCapability, resolveCapabilities } from '../auth/capability'
import { resolveAgentRef, resolveSquadRef } from '../org/resolve'
import { createAgent, isAgentStatus, setAgentStatus } from '../org/service'
import { mintAgentBoundToken, revokeMemberToken } from '../members/service'
import { type ToolSpec, done, fail, str } from './index'

export const AGENT_MANAGER_SURFACE = 'agents:manage'

type AgentManagerAuditAction = 'create' | 'set_status' | 'mint_token' | 'revoke_token'

type D1Statement = ReturnType<Env['DB']['prepare']>

function managerAuditStatement(
  auth: AuthContext,
  env: Env,
  requestId: string,
  squadId: string,
  action: AgentManagerAuditAction,
  target: { agentId?: string | null; tokenId?: string | null },
  detail: Record<string, unknown>,
): D1Statement {
  if (!auth.memberId || !auth.boundAgentId || !auth.channel) {
    throw new Error('manager audit requires a welded member credential with channel attribution')
  }
  return env.DB.prepare(
    `INSERT INTO agent_manager_audit
       (id, tenant, actor_id, actor_agent_id, channel, request_id, squad_id,
        agent_id, token_id, action, detail, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    env.TENANT_SLUG,
    auth.memberId,
    auth.boundAgentId,
    auth.channel,
    requestId,
    squadId,
    target.agentId ?? null,
    target.tokenId ?? null,
    action,
    JSON.stringify(detail),
    new Date().toISOString(),
  )
}

interface ManagedAgentRow {
  id: string
  squad_id: string
  slug: string
  name: string
  role: string
  model: string
  status: 'active' | 'paused'
  created_at: string
}

interface ManagedTokenMetadataRow {
  id: string
  agent_id: string
  label: string
  channel: string
  created_at: string
  revoked_at: string | null
}

interface MintReplayRow {
  agent_id: string
  token_id: string
  detail: string
  recorded_at: string
}

async function findMintReplay(
  env: Env,
  auth: AuthContext,
  requestId: string,
  squadId: string,
): Promise<MintReplayRow | null> {
  if (!auth.memberId) return null
  return env.DB.prepare(
    `SELECT agent_id, token_id, detail, recorded_at
       FROM agent_manager_audit
      WHERE tenant = ?1 AND actor_id = ?2 AND request_id = ?3
        AND squad_id = ?4 AND action = 'mint_token'
      LIMIT 1`,
  )
    .bind(env.TENANT_SLUG, auth.memberId, requestId, squadId)
    .first<MintReplayRow>()
}

function mintReplayOutcome(row: MintReplayRow): ReturnType<typeof done> {
  let detail: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(row.detail)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) detail = parsed
  } catch {
    // detail is constrained by json_valid; retain minimal safe metadata if a
    // legacy or fake row violates that contract.
  }
  return done({
    replayed: true,
    secret_available: false,
    token: {
      id: row.token_id,
      agent_id: row.agent_id,
      label: typeof detail.label === 'string' ? detail.label : null,
      capability: typeof detail.capability === 'string' ? detail.capability : 'member',
      created_at: row.recorded_at,
    },
    note: 'operation already committed; plaintext cannot be replayed',
  })
}

async function hasExplicitManagerGrant(env: Env, memberId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS allowed
       FROM gate_grants
      WHERE principal_type = 'member'
        AND principal_id = ?1
        AND capability = ?2
      LIMIT 1`,
  )
    .bind(memberId, AGENT_MANAGER_SURFACE)
    .first<{ allowed: number }>()
  return row !== null
}

async function authorizeSquadManager(
  auth: AuthContext,
  env: Env,
  squadRef: string,
): Promise<
  | { ok: true; squad: { id: string; department_id: string } }
  | { ok: false; outcome: ReturnType<typeof fail> }
> {
  if (!auth.memberId) {
    return { ok: false, outcome: fail(403, 'forbidden', { need: AGENT_MANAGER_SURFACE }) }
  }

  const resolved = await resolveSquadRef(env, squadRef)
  if (!resolved.ok) {
    return {
      ok: false,
      outcome: fail(404, resolved.reason === 'ambiguous' ? 'squad_ref_ambiguous' : 'squad_not_found'),
    }
  }

  const grants = auth.capabilities ?? (await resolveCapabilities(env, auth.memberId))
  if (!hasCapability(grants, 'squad', resolved.value.id, 'member', resolved.value.department_id)) {
    return { ok: false, outcome: fail(403, 'forbidden', { need: 'member', scope: 'squad' }) }
  }
  // The generic hasSurfaceCap helper lets owner/admin bypass named grants.
  // Autonomous manager authority must always be represented by an exact row.
  if (!(await hasExplicitManagerGrant(env, auth.memberId))) {
    return { ok: false, outcome: fail(403, 'forbidden', { need: AGENT_MANAGER_SURFACE }) }
  }

  return { ok: true, squad: resolved.value }
}

const toolAgentManagerStatus: ToolSpec = {
  name: 'agent_manager_status',
  scope: 'target squad plus explicit agents:manage surface grant',
  min: 'member',
  args: '{ squad_id: string }',
  inputSchema: {
    type: 'object',
    properties: { squad_id: { type: 'string' } },
    required: ['squad_id'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const squadRef = str(args.squad_id)
    if (!squadRef) return fail(400, 'invalid_args', 'squad_id required')
    const authorization = await authorizeSquadManager(auth, env, squadRef)
    if (!authorization.ok) return authorization.outcome
    return done({
      enabled: true,
      surface: AGENT_MANAGER_SURFACE,
      squad_id: authorization.squad.id,
      actor_member_id: auth.memberId,
      bound_agent_id: auth.boundAgentId,
    })
  },
}

const toolAgentManagerList: ToolSpec = {
  name: 'agent_manager_list',
  scope: 'target squad plus explicit agents:manage surface grant',
  min: 'member',
  args: '{ squad_id: string }',
  inputSchema: {
    type: 'object',
    properties: { squad_id: { type: 'string' } },
    required: ['squad_id'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const squadRef = str(args.squad_id)
    if (!squadRef) return fail(400, 'invalid_args', 'squad_id required')

    const authorization = await authorizeSquadManager(auth, env, squadRef)
    if (!authorization.ok) return authorization.outcome

    const rows = await env.DB.prepare(
      `SELECT id, squad_id, slug, name, role, model, status, created_at
         FROM agents
        WHERE squad_id = ?1
        ORDER BY name ASC, id ASC`,
    )
      .bind(authorization.squad.id)
      .all<ManagedAgentRow>()

    const tokens = await env.DB.prepare(
      `SELECT id, agent_id, label, channel, created_at, revoked_at
         FROM member_tokens
        WHERE agent_id IN (SELECT id FROM agents WHERE squad_id = ?1)
          AND tenant = ?2
        ORDER BY created_at DESC, id ASC`,
    )
      .bind(authorization.squad.id, env.TENANT_SLUG)
      .all<ManagedTokenMetadataRow>()

    return done({
      squad_id: authorization.squad.id,
      agents: rows.results ?? [],
      tokens: tokens.results ?? [],
    })
  },
}

const toolAgentManagerCreate: ToolSpec = {
  name: 'agent_manager_create',
  scope: 'target squad plus explicit agents:manage surface grant',
  min: 'member',
  args: '{ squad_id: string, slug: string, name: string, model?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      squad_id: { type: 'string' },
      slug: { type: 'string' },
      name: { type: 'string' },
      model: { type: 'string' },
    },
    required: ['squad_id', 'slug', 'name'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const squadRef = str(args.squad_id)
    if (!squadRef) return fail(400, 'invalid_args', 'squad_id required')

    const authorization = await authorizeSquadManager(auth, env, squadRef)
    if (!authorization.ok) return authorization.outcome

    const requestId = crypto.randomUUID()
    const created = await createAgent(
      env,
      authorization.squad.id,
      {
        slug: args.slug,
        name: args.name,
        model: args.model,
        role: 'member',
        status: 'active',
      },
      (agent) => [managerAuditStatement(auth, env, requestId, authorization.squad.id, 'create', { agentId: agent.id }, {
        slug: agent.slug,
        role: agent.role,
        status: agent.status,
      })],
    )
    if (!created.ok) return fail(created.error === 'slug_taken' ? 409 : 400, created.error)

    return done({ agent: created.value })
  },
}

const toolAgentManagerSetStatus: ToolSpec = {
  name: 'agent_manager_set_status',
  scope: 'configured squad plus explicit agents:manage surface grant',
  min: 'member',
  args: '{ squad_id: string, agent_id: string, status: "active" | "paused" }',
  inputSchema: {
    type: 'object',
    properties: {
      squad_id: { type: 'string' },
      agent_id: { type: 'string' },
      status: { type: 'string', enum: ['active', 'paused'] },
    },
    required: ['squad_id', 'agent_id', 'status'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const squadRef = str(args.squad_id)
    const agentRef = str(args.agent_id)
    if (!squadRef || !agentRef) return fail(400, 'invalid_args', 'squad_id and agent_id required')
    if (!isAgentStatus(args.status)) return fail(400, 'invalid_status')

    const authorization = await authorizeSquadManager(auth, env, squadRef)
    if (!authorization.ok) return authorization.outcome

    const resolved = await resolveAgentRef(env, agentRef)
    if (!resolved.ok) {
      return fail(resolved.reason === 'ambiguous' ? 409 : 404, resolved.reason === 'ambiguous' ? 'agent_ref_ambiguous' : 'agent_not_found')
    }
    if (resolved.value.squad_id !== authorization.squad.id) return fail(404, 'agent_not_found')
    // Do not let a manager strand itself by pausing the agent identity that
    // authenticates this call. A human owner can still perform emergency recovery.
    if (resolved.value.id === auth.boundAgentId) {
      return fail(409, 'self_management_forbidden')
    }

    const requestId = crypto.randomUUID()
    const updated = await setAgentStatus(env, resolved.value.id, args.status, [
      managerAuditStatement(auth, env, requestId, resolved.value.squad_id, 'set_status', { agentId: resolved.value.id }, {
        status: args.status,
      }),
    ])
    if (!updated.ok) return fail(404, 'agent_not_found')

    return done({
      agent: {
        id: resolved.value.id,
        squad_id: resolved.value.squad_id,
        status: args.status,
      },
    })
  },
}

const toolAgentManagerMintToken: ToolSpec = {
  name: 'agent_manager_mint_token',
  scope: 'configured squad plus explicit agents:manage surface grant',
  min: 'member',
  args: '{ squad_id: string, agent_id: string, request_id: string, label?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      squad_id: { type: 'string' },
      agent_id: { type: 'string' },
      request_id: { type: 'string', minLength: 8, maxLength: 128 },
      label: { type: 'string' },
    },
    required: ['squad_id', 'agent_id', 'request_id'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const squadRef = str(args.squad_id)
    const agentRef = str(args.agent_id)
    const requestId = str(args.request_id)
    if (!squadRef || !agentRef || !requestId) {
      return fail(400, 'invalid_args', 'squad_id, agent_id, and request_id required')
    }
    if (!/^[A-Za-z0-9:_-]{8,128}$/.test(requestId)) return fail(400, 'invalid_request_id')

    const authorization = await authorizeSquadManager(auth, env, squadRef)
    if (!authorization.ok) return authorization.outcome

    const prior = await findMintReplay(env, auth, requestId, authorization.squad.id)
    if (prior) return mintReplayOutcome(prior)

    const resolved = await resolveAgentRef(env, agentRef)
    if (!resolved.ok) {
      return fail(resolved.reason === 'ambiguous' ? 409 : 404, resolved.reason === 'ambiguous' ? 'agent_ref_ambiguous' : 'agent_not_found')
    }
    if (resolved.value.squad_id !== authorization.squad.id) return fail(404, 'agent_not_found')

    const label = str(args.label) ?? resolved.value.slug
    let minted
    try {
      minted = await mintAgentBoundToken(env, resolved.value, label, 'member', (receipt) => [
        managerAuditStatement(auth, env, requestId, resolved.value.squad_id, 'mint_token', {
          agentId: resolved.value.id,
          tokenId: receipt.tokenId,
        }, {
          label: receipt.label,
          capability: receipt.grantCapability,
        }),
      ])
    } catch (error) {
      // A concurrent retry may win the unique audit request key after our first
      // lookup. Return its safe receipt rather than minting again.
      const replay = await findMintReplay(env, auth, requestId, authorization.squad.id)
      if (replay) return mintReplayOutcome(replay)
      throw error
    }
    return done({
      replayed: false,
      secret_available: true,
      token: {
        id: minted.tokenId,
        member_id: minted.memberId,
        agent_id: resolved.value.id,
        label: minted.label,
        capability: minted.grantCapability,
        created_at: minted.createdAt,
        raw: minted.raw,
      },
      note: 'raw token is shown once and is never retrievable again',
    })
  },
}

interface ManagedTokenRow {
  id: string
  member_id: string
  agent_id: string
  squad_id: string
  revoked_at: string | null
}

const toolAgentManagerRevokeToken: ToolSpec = {
  name: 'agent_manager_revoke_token',
  scope: 'configured squad plus explicit agents:manage surface grant',
  min: 'member',
  args: '{ squad_id: string, token_id: string }',
  inputSchema: {
    type: 'object',
    properties: {
      squad_id: { type: 'string' },
      token_id: { type: 'string' },
    },
    required: ['squad_id', 'token_id'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const squadRef = str(args.squad_id)
    const tokenId = str(args.token_id)
    if (!squadRef || !tokenId) return fail(400, 'invalid_args', 'squad_id and token_id required')

    const authorization = await authorizeSquadManager(auth, env, squadRef)
    if (!authorization.ok) return authorization.outcome

    // The JOIN is a security boundary: only a token welded to a real agent can be
    // managed here. Human member tokens do not resolve through this query.
    const token = await env.DB.prepare(
      `SELECT t.id, t.member_id, t.agent_id, a.squad_id, t.revoked_at
         FROM member_tokens t
         JOIN agents a ON a.id = t.agent_id
        WHERE t.id = ?1 AND t.tenant = ?2
        LIMIT 1`,
    )
      .bind(tokenId, env.TENANT_SLUG)
      .first<ManagedTokenRow>()
    if (!token) return fail(404, 'agent_token_not_found')

    if (token.squad_id !== authorization.squad.id) return fail(404, 'agent_token_not_found')
    // The bearer token is represented by this authenticated member envelope.
    // Refuse to revoke it from underneath the current manager session.
    if (token.member_id === auth.memberId) {
      return fail(409, 'self_management_forbidden')
    }

    const requestId = crypto.randomUUID()
    const revoked = token.revoked_at === null
      ? await revokeMemberToken(env, token.member_id, token.id, [
          managerAuditStatement(auth, env, requestId, token.squad_id, 'revoke_token', {
            agentId: token.agent_id,
            tokenId: token.id,
          }, { status: 'revoked' }),
        ])
      : false
    return done({
      token: {
        id: token.id,
        agent_id: token.agent_id,
        status: revoked ? 'revoked' : 'already_revoked',
      },
    })
  },
}

export const AGENT_MANAGER_TOOLS: ToolSpec[] = [
  toolAgentManagerStatus,
  toolAgentManagerList,
  toolAgentManagerCreate,
  toolAgentManagerSetStatus,
  toolAgentManagerMintToken,
  toolAgentManagerRevokeToken,
]
