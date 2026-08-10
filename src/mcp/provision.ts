// mupot — MCP provision tools (SENSITIVE: org-structure writes + identity mint).
//
// These tools let an authenticated operator stand up a squad/agent/bound-token/key
// chain IN-BAND from any harness (Codex, Claude Code, …) instead of the dashboard.
// They MIRROR the dashboard creation path exactly — createSquad/createAgent live in
// src/org/service, mintMemberToken in src/members/service — so there is ONE source of
// truth for validation + the security discipline (tokens stored hashed, raw shown once).
//
// Sovereign-core discipline (same as src/mcp/index, src/auth/capability):
//   - AuthZ is OURS and server-derived. The caller's grants come from the token, never
//     from args. `agent`/`squad`/`department` args only NAME a target; the capability
//     check authorizes it.
//   - THE ESCALATION GUARD: mint_agent_token grants the new agent member a HARD-CAPPED
//     squad-scoped observer/member capability on the agent's OWN squad — never
//     org/department, never above 'member'. A minted agent token therefore can NEVER
//     inherit the operator's org-admin: it can only ever act at or below 'member' on
//     its one squad. This is the sovereign default and the reason mint is itself gated
//     at 'admin'.
//
// Tools (registered into the TOOLS array in src/mcp/index):
//   create_squad      — admin on the department (org inherits)
//   create_agent      — lead on the squad (org/department inherit)
//   mint_agent_token  — admin on the agent's squad (org/department inherit) → show-once raw
//   register_agent_key — admin on the agent's squad → public-only signed-runtime identity

import type { Capability, CapabilityGrant, Env, BusEvent, Squad } from '../types'
import { hasCapability } from '../auth/capability'
import {
  createDepartment,
  createSquad,
  createAgent,
  findAgentsByName,
  getAgentProfile,
  updateAgentProfile,
} from '../org/service'
import type { AgentProfilePatch } from '../org/service'
import {
  mintAgentBoundToken,
  isAgentTokenCapability,
  resolveAgentMemberBinding,
} from '../members/service'
import { revokeMemberToken } from '../members/service'
import { setAgentSquadAccess, type AgentAccessCapability } from '../members/agent-access'
import {
  provisionAgentConnection,
  type AgentConnectionOutcome,
} from '../members/agent-connection'
import { mcpEndpoint, requiredCanonicalOrigin, wakeContractForAgent } from '../dashboard/connect'
import { createBus } from '../bus'
import { resolveDepartmentRef, resolveSquadRef, resolveAgentRef } from '../org/resolve'
import { listAgentTokensQuery, revokeTokenOwnershipQuery } from './token-queries'
import { isValidEd25519PublicX, registerAgentPublicKey } from '../fleet/agent-keys'
import { assertWritten, rowsWritten } from '../lib/receipt'
import {
  type ToolSpec,
  fail,
  done,
  str,
  memberCanOnSquad,
} from './index'

const STRING_SCHEMA = { type: 'string' }
const OPTIONAL_NUMBER_SCHEMA = { type: 'number' }
const OPTIONAL_STRING_ARRAY_SCHEMA = { type: 'array', items: { type: 'string' } }
const OPTIONAL_BOOLEAN_SCHEMA = { type: 'boolean' }
// death_condition is a free-form lifecycle-policy object (validated as JSON in service).
const PROFILE_OBJECT_SCHEMA = { type: 'object' }
const AGENT_ACCESS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      squad: STRING_SCHEMA,
      capability: { type: 'string', enum: ['observer', 'member', 'lead', 'admin'] },
    },
    required: ['squad', 'capability'],
    additionalProperties: false,
  },
}
const GRANTABLE_AGENT_CAPABILITIES = new Set<Capability>(['observer', 'member', 'lead', 'admin'])

// Emit an attributed provision event so the activity feed/consumer knows a member
// caused a structural change (kasra-review W2 — the mint was previously unattributed
// on the bus). One event type carries the kind; payload names what was created.
async function emitProvisioned(
  env: Env,
  memberId: string,
  kind:
    | 'department'
    | 'squad'
    | 'agent'
    | 'token'
    | 'token_revoked'
    | 'key'
    | 'capability'
    | 'agent_deactivated'
    | 'agent_updated',
  id: string,
  extra: {
    squad_id?: string
    agent_id?: string
    member_id?: string
    capability?: Capability
    reason?: string
    // A profile correction keeps no history on the row (agents has no
    // updated_at), so the field-level before/after must ride on the event or
    // the change is unreversible from the trail.
    changed?: Record<string, { from: unknown; to: unknown }>
  } = {},
): Promise<void> {
  const event: BusEvent<{
    kind: string
    id: string
    by: string
    member_id?: string
    capability?: Capability
    reason?: string
    changed?: Record<string, { from: unknown; to: unknown }>
  }> = {
    type: 'org.provisioned',
    tenant: env.TENANT_SLUG,
    squad_id: extra.squad_id,
    agent_id: extra.agent_id,
    actor: { kind: 'member', id: memberId },
    payload: {
      kind,
      id,
      by: memberId,
      ...(extra.member_id ? { member_id: extra.member_id } : {}),
      ...(extra.capability ? { capability: extra.capability } : {}),
      ...(extra.reason ? { reason: extra.reason } : {}),
      ...(extra.changed ? { changed: extra.changed } : {}),
    },
    ts: new Date().toISOString(),
  }
  // The row is already committed; a bus failure must NOT 500 the caller and orphan a
  // successful create/mint (esp. the show-once token, which cannot be re-fetched).
  // Emit is best-effort: swallow + log, never throw.
  try {
    await createBus(env).emit(event)
  } catch {
    console.error('provision: org.provisioned emit failed (non-fatal)', {
      tenant: env.TENANT_SLUG,
      kind,
      id,
    })
  }
}

// Ref resolvers (id-first, slug-with-ambiguity-refusal) are shared in ../org/resolve
// so the mint path, the orient HTTP route, and the orient tool converge on ONE
// implementation (no third copy of the self-poisoning slug bug).

// Map a failed resolve to the right MCP error: ambiguous slug → 409 (caller must
// disambiguate with the id), absent → 404 not_found.
function resolveFail(reason: 'not_found' | 'ambiguous', notFoundCode: string) {
  if (reason === 'ambiguous') {
    return fail(409, 'ambiguous_slug', 'slug matches multiple rows — use the id instead')
  }
  return fail(404, notFoundCode)
}

// Map the shared CreateResult error code to an MCP fail() with the right status.
// slug_taken → 409 conflict; every other validation code → 400 invalid_args.
function createErrorToFail(error: string) {
  const status = error === 'slug_taken' ? 409 : 400
  return fail(status, error)
}

/** Check whether the caller's effective target-squad grant covers a requested capability. */
export function callerCanGrantAgentCapability(
  grants: CapabilityGrant[],
  squad: Pick<Squad, 'id' | 'department_id'>,
  capability: Capability,
): boolean {
  return hasCapability(grants, 'squad', squad.id, capability, squad.department_id)
}

// ── create_department ───────────────────────────────────────────────────────────
// The zero-state root: lets an org-admin build the org from nothing in-band (a
// department is the parent scope create_squad needs). Gate: admin on org scope.
const toolCreateDepartment: ToolSpec = {
  name: 'create_department',
  scope: 'org',
  min: 'admin',
  args: '{ slug: string, name: string }',
  inputSchema: {
    type: 'object',
    properties: { slug: STRING_SCHEMA, name: STRING_SCHEMA },
    required: ['slug', 'name'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    // Gate: org admin (a department is org-structure; only org-admin creates one).
    const grants = auth.capabilities ?? []
    if (!hasCapability(grants, 'org', null, 'admin')) {
      return fail(403, 'forbidden', { need: 'admin', scope: 'org' })
    }

    const result = await createDepartment(env, { slug: args.slug, name: args.name })
    if (!result.ok) return createErrorToFail(result.error)
    await emitProvisioned(env, auth.memberId as string, 'department', result.value.id)
    return done({ department: result.value })
  },
}

// ── create_squad ──────────────────────────────────────────────────────────────
const toolCreateSquad: ToolSpec = {
  name: 'create_squad',
  scope: 'department',
  min: 'admin',
  args:
    '{ department: string (id|slug), slug: string, name: string, charter?, role?, okr?, kpi_target?, effort?, autonomy?, budget_cap_cents?, budget_window? }',
  inputSchema: {
    type: 'object',
    properties: {
      department: STRING_SCHEMA,
      slug: STRING_SCHEMA,
      name: STRING_SCHEMA,
      charter: STRING_SCHEMA,
      role: STRING_SCHEMA,
      okr: STRING_SCHEMA,
      kpi_target: STRING_SCHEMA,
      effort: STRING_SCHEMA,
      autonomy: STRING_SCHEMA,
      budget_cap_cents: OPTIONAL_NUMBER_SCHEMA,
      budget_window: STRING_SCHEMA,
    },
    required: ['department', 'slug', 'name'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const deptRef = str(args.department)
    if (!deptRef) return fail(400, 'invalid_args', 'department required')

    const deptResult = await resolveDepartmentRef(env, deptRef)
    if (!deptResult.ok) return resolveFail(deptResult.reason, 'department_not_found')
    const dept = deptResult.value

    // Gate: admin on the department (an org-admin grant inherits to every scope).
    const grants = auth.capabilities ?? []
    if (!hasCapability(grants, 'department', dept.id, 'admin')) {
      return fail(403, 'forbidden', { need: 'admin', scope: 'department' })
    }

    const result = await createSquad(env, dept.id, {
      slug: args.slug,
      name: args.name,
      charter: args.charter,
      role: args.role,
      okr: args.okr,
      kpi_target: args.kpi_target,
      effort: args.effort,
      autonomy: args.autonomy,
      budget_cap_cents: args.budget_cap_cents,
      budget_window: args.budget_window,
    })
    if (!result.ok) return createErrorToFail(result.error)
    await emitProvisioned(env, auth.memberId as string, 'squad', result.value.id, {
      squad_id: result.value.id,
    })
    return done({ squad: result.value })
  },
}

// ── create_agent ────────────────────────────────────────────────────────────────
const toolCreateAgent: ToolSpec = {
  name: 'create_agent',
  scope: 'squad',
  min: 'lead',
  args:
    '{ squad: string (id|slug), slug: string, name: string, role?, model?, okr?, kpi_target?, effort?, autonomy?, budget_cap_cents?, budget_window?, purpose?, owner?, model_fallback?, capabilities?: string[], skills?: string[], parent_agent_id?, qnft_ref?, death_condition?: object }',
  inputSchema: {
    type: 'object',
    properties: {
      squad: STRING_SCHEMA,
      slug: STRING_SCHEMA,
      name: STRING_SCHEMA,
      role: STRING_SCHEMA,
      model: STRING_SCHEMA,
      okr: STRING_SCHEMA,
      kpi_target: STRING_SCHEMA,
      effort: STRING_SCHEMA,
      autonomy: STRING_SCHEMA,
      budget_cap_cents: OPTIONAL_NUMBER_SCHEMA,
      budget_window: STRING_SCHEMA,
      // profile (0068, Port 1.3)
      purpose: STRING_SCHEMA,
      owner: STRING_SCHEMA,
      model_fallback: STRING_SCHEMA,
      capabilities: OPTIONAL_STRING_ARRAY_SCHEMA,
      skills: OPTIONAL_STRING_ARRAY_SCHEMA,
      parent_agent_id: STRING_SCHEMA,
      qnft_ref: STRING_SCHEMA,
      death_condition: PROFILE_OBJECT_SCHEMA,
    },
    required: ['squad', 'slug', 'name'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const squadRef = str(args.squad)
    if (!squadRef) return fail(400, 'invalid_args', 'squad required')

    const squadResult = await resolveSquadRef(env, squadRef)
    if (!squadResult.ok) return resolveFail(squadResult.reason, 'squad_not_found')
    const squad = squadResult.value

    // Gate: lead on the squad (org/department admin inherit down via memberCanOnSquad).
    const grants = auth.capabilities ?? []
    if (!(await memberCanOnSquad(env, grants, squad.id, 'lead'))) {
      return fail(403, 'forbidden', { need: 'lead', scope: 'squad' })
    }

    const result = await createAgent(env, squad.id, {
      slug: args.slug,
      name: args.name,
      role: args.role,
      model: args.model,
      okr: args.okr,
      kpi_target: args.kpi_target,
      effort: args.effort,
      autonomy: args.autonomy,
      budget_cap_cents: args.budget_cap_cents,
      budget_window: args.budget_window,
      // profile (0068, Port 1.3)
      purpose: args.purpose,
      owner: args.owner,
      model_fallback: args.model_fallback,
      capabilities: args.capabilities,
      skills: args.skills,
      parent_agent_id: args.parent_agent_id,
      qnft_ref: args.qnft_ref,
      death_condition: args.death_condition,
    })
    if (!result.ok) return createErrorToFail(result.error)
    await emitProvisioned(env, auth.memberId as string, 'agent', result.value.id, {
      squad_id: squad.id,
      agent_id: result.value.id,
    })
    return done({ agent: result.value })
  },
}

// ── resolve_agent ───────────────────────────────────────────────────────────────
// resolve-before-mint (Port 1.3): before minting a new agent, search existing agents
// by name/slug across the whole pot so onboarding SEES the roles that already exist
// and doesn't fork a duplicate identity. This is the anti-sprawl primitive — the
// 2026-07-21 3-hermes incident (agent-hermes + kayhermes + hadi-hermes, distinct
// roles, retired as "duplicates") is exactly what pot-wide resolve prevents.
//
// Scope: observer FLOOR (not 'authenticated'). Deliberately pot-wide (not caller-
// squad-scoped): the sprawl this fixes spans squads, so a squad-scoped search would
// miss the case. Agents live in a single-tenant pot (the `agents` table has no tenant
// column — one pot = one tenant), so this discloses no cross-tenant data, only agent
// metadata (name/role/purpose/model/capabilities/lineage). It is min:'observer', NOT
// 'authenticated': `min:'authenticated'` would SKIP the AAGATE capability floor
// (src/mcp/index.ts) and let a ZERO-GRANT OAuth member enumerate the whole pot's agent
// inventory — a broadening a grantless token should not have (cursor gate,
// 2026-07-22; the earlier "presence-roster parity" claim was wrong — a grantless
// member never gets the roster either). 'observer' requires the caller hold observer
// on SOME scope, enforced centrally at the dispatch chokepoint.
const toolResolveAgent: ToolSpec = {
  name: 'resolve_agent',
  scope: 'org (read)',
  min: 'observer',
  args: '{ query: string, include_inactive?: boolean, limit?: number }',
  inputSchema: {
    type: 'object',
    properties: {
      query: STRING_SCHEMA,
      include_inactive: OPTIONAL_BOOLEAN_SCHEMA,
      limit: OPTIONAL_NUMBER_SCHEMA,
    },
    required: ['query'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    if (!auth.memberId) return fail(403, 'unauthenticated')
    const query = str(args.query)
    if (!query) return fail(400, 'invalid_args', 'query required')
    const includeInactive = args.include_inactive === true
    let limit: number | undefined
    if (args.limit !== undefined) {
      if (typeof args.limit !== 'number' || !Number.isFinite(args.limit)) {
        return fail(400, 'invalid_args', 'limit must be a number')
      }
      limit = args.limit
    }
    const matches = await findAgentsByName(env, query, { includeInactive, limit })
    return done({ matches })
  },
}

// ── get_agent_profile ───────────────────────────────────────────────────────────
// Read one agent's full profile by id. Same pot-internal, metadata-only disclosure
// rationale as resolve_agent above — and the same observer FLOOR: min:'observer' so
// the AAGATE capability floor rejects a zero-grant member (min:'authenticated' would
// skip it). cursor gate, 2026-07-22.
const toolGetAgentProfile: ToolSpec = {
  name: 'get_agent_profile',
  scope: 'org (read)',
  min: 'observer',
  args: '{ agent_id: string }',
  inputSchema: {
    type: 'object',
    properties: { agent_id: STRING_SCHEMA },
    required: ['agent_id'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    if (!auth.memberId) return fail(403, 'unauthenticated')
    const agentId = str(args.agent_id)
    if (!agentId) return fail(400, 'invalid_args', 'agent_id required')
    const profile = await getAgentProfile(env, agentId)
    if (!profile) return fail(404, 'agent_not_found')
    return done({ profile })
  },
}

// ── mint_agent_token ─────────────────────────────────────────────────────────────
// Creates a DEDICATED member for the agent, grants it a HARD-CAPPED squad-scoped
// capability on the agent's own squad, binds a fresh token to the agent (the weld:
// member_tokens.agent_id), and returns the raw token EXACTLY ONCE. Default grant is
// 'member'; callers may lower to 'observer' but never above member.
const toolMintAgentToken: ToolSpec = {
  name: 'mint_agent_token',
  scope: "agent's squad",
  min: 'admin',
  args: '{ agent: string (id|slug), label?, capability?: "observer"|"member" }',
  inputSchema: {
    type: 'object',
    properties: { agent: STRING_SCHEMA, label: STRING_SCHEMA, capability: STRING_SCHEMA },
    required: ['agent'],
    additionalProperties: false,
  },
  async run(auth, env, args, _ctx) {
    if (auth.boundAgentId) return fail(403, 'operator_principal_required')
    const agentRef = str(args.agent)
    if (!agentRef) return fail(400, 'invalid_args', 'agent required')

    const agentResult = await resolveAgentRef(env, agentRef)
    if (!agentResult.ok) return resolveFail(agentResult.reason, 'agent_not_found')
    const agent = agentResult.value

    // Gate: admin on the agent's squad (org/department admin inherit). Minting a
    // credential that IS an agent is an org-trust act → admin, never lead/member.
    const grants = auth.capabilities ?? []
    if (!(await memberCanOnSquad(env, grants, agent.squad_id, 'admin'))) {
      return fail(403, 'forbidden', { need: 'admin', scope: 'squad' })
    }

    // Cap the label length (parity with the HTTP mint path, members/index.ts) — a
    // member-supplied free field on a credential write; bound it to 64 chars.
    const label = (str(args.label) ?? agent.slug).trim().slice(0, 64)
    const grantCapability = args.capability === undefined || args.capability === null
      ? 'member'
      : args.capability
    if (!isAgentTokenCapability(grantCapability)) {
      return fail(400, 'invalid_capability', 'capability must be observer or member')
    }

    const canonical = requiredCanonicalOrigin(env)
    if (!canonical.ok) return fail(503, canonical.error)

    // Delegate to the shared atomic-mint helper (members/service.ts).
    // A first mint atomically creates the member envelope, canonical binding,
    // home capability, and agent-weld token; later mints add only the token.
    // Either the complete mint lands or none of it does — no orphan credentials.
    // The helper enforces: squad-scoped observer/member only, hash-only storage,
    // show-once raw.
    // Surface the one expected identity precondition as a NAMED failure. Left
    // unhandled it reaches the caller as a bare `internal_error`, which is what
    // made mupot#890 cost hours: the message said nothing, so the actual cause
    // (a missing home-squad grant on the canonical member) was invisible.
    let minted
    try {
      minted = await mintAgentBoundToken(env, agent, label, grantCapability)
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('agent_home_capability_missing')) {
        return fail(409, 'agent_home_capability_missing', {
          detail: 'canonical agent member has no home-squad grant; grant one before minting',
          agent_id: agent.id,
          squad_id: agent.squad_id,
        })
      }
      throw err
    }

    await emitProvisioned(env, auth.memberId as string, 'token', minted.tokenId, {
      squad_id: agent.squad_id,
      agent_id: agent.id,
    })

    // SECURITY: `raw` is the show-once token — returned as a BARE field, never woven
    // into a reusable config snippet (see src/dashboard/connect security note). The
    // caller renders its own client config from raw + mcp_endpoint + wake_contract.
    //
    // wake_contract (#115): the machine-readable spec for waking this agent via the
    // bus HTTP surface. Returned alongside mcp_endpoint so the operator has the full
    // self-serve picture in one flow — no manual tmux or shell access required.
    return done({
      token: {
        id: minted.tokenId,
        member_id: minted.memberId,
        agent_id: agent.id,
        label,
        channel: 'workspace',
        capability: minted.grantCapability,
        created_at: minted.createdAt,
        raw: minted.raw,
      },
      agent: { id: agent.id, slug: agent.slug, name: agent.name },
      mcp_endpoint: mcpEndpoint(canonical.origin),
      wake_contract: wakeContractForAgent(
        agent.id,
        agent.squad_id,
        env.TENANT_SLUG,
        canonical.origin,
      ),
      note: 'raw token is shown ONCE — store it now; it is never retrievable again',
    })
  },
}

// ── token lifecycle: list + revoke ────────────────────────────────────────────
//
// mupot#682. mint_agent_token existed with NO counterpart: the pot could ISSUE a
// credential through its own surface but not SEE or WITHDRAW one. Cleaning up four
// tokens I had minted on 2026-08-05 required dropping to raw D1 — i.e. the product
// could not operate its own credential lifecycle, which is the exact failure the
// standing goal names ("an agent can join, work, and be trusted on mupot without a
// human debugging it").
//
// Revoke is gated identically to mint (admin on the agent's squad, operator principal
// only). Withdrawing a credential must never be HARDER than issuing one, or the safe
// action becomes the inconvenient one and people leave credentials live.

const toolListAgentTokens: ToolSpec = {
  name: 'list_agent_tokens',
  scope: "agent's squad",
  min: 'admin',
  args: '{ agent: string (id|slug), include_revoked?: boolean }',
  inputSchema: {
    type: 'object',
    properties: { agent: STRING_SCHEMA, include_revoked: { type: 'boolean' } },
    required: ['agent'],
    additionalProperties: false,
  },
  async run(auth, env, args, _ctx) {
    if (auth.boundAgentId) return fail(403, 'operator_principal_required')
    const agentRef = str(args.agent)
    if (!agentRef) return fail(400, 'invalid_args', 'agent required')

    const agentResult = await resolveAgentRef(env, agentRef)
    if (!agentResult.ok) return resolveFail(agentResult.reason, 'agent_not_found')
    const agent = agentResult.value

    const grants = auth.capabilities ?? []
    if (!(await memberCanOnSquad(env, grants, agent.squad_id, 'admin'))) {
      return fail(403, 'forbidden', { need: 'admin', scope: 'squad' })
    }

    const includeRevoked = args.include_revoked === true
    // NEVER select token_hash. There is no path from this tool to a usable secret —
    // raw is show-once at mint and is not stored.
    const rows = await env.DB.prepare(
      listAgentTokensQuery(includeRevoked),
    )
      .bind(agent.id, env.TENANT_SLUG)
      .all<{ id: string; member_id: string; label: string; channel: string; created_at: string; revoked_at: string | null }>()

    // Project EXPLICITLY in code, not only in the SQL above. Relying on the SELECT list
    // means a later "SELECT *" — or a helper that widens the query — silently leaks
    // token_hash through this tool, and no test that asserts on happy-path fields would
    // notice. The allow-list here is the actual guarantee; the SQL projection is an
    // optimisation on top of it.
    const tokens = (rows.results ?? []).map((t) => ({
      id: t.id,
      member_id: t.member_id,
      label: t.label,
      channel: t.channel,
      created_at: t.created_at,
      revoked_at: t.revoked_at,
    }))
    return done({
      agent: { id: agent.id, slug: agent.slug, name: agent.name },
      tokens,
      live_count: tokens.filter((t) => !t.revoked_at).length,
    })
  },
}

const toolRevokeAgentToken: ToolSpec = {
  name: 'revoke_agent_token',
  scope: "agent's squad",
  min: 'admin',
  args: '{ agent: string (id|slug), token_id: string }',
  inputSchema: {
    type: 'object',
    properties: { agent: STRING_SCHEMA, token_id: STRING_SCHEMA },
    required: ['agent', 'token_id'],
    additionalProperties: false,
  },
  async run(auth, env, args, _ctx) {
    if (auth.boundAgentId) return fail(403, 'operator_principal_required')
    const agentRef = str(args.agent)
    const tokenId = str(args.token_id)
    if (!agentRef) return fail(400, 'invalid_args', 'agent required')
    if (!tokenId) return fail(400, 'invalid_args', 'token_id required')

    const agentResult = await resolveAgentRef(env, agentRef)
    if (!agentResult.ok) return resolveFail(agentResult.reason, 'agent_not_found')
    const agent = agentResult.value

    const grants = auth.capabilities ?? []
    if (!(await memberCanOnSquad(env, grants, agent.squad_id, 'admin'))) {
      return fail(403, 'forbidden', { need: 'admin', scope: 'squad' })
    }

    // The token must belong to THIS agent. Without this, admin on squad A could revoke
    // a token welded to an agent on squad B by guessing its id — authorization would be
    // checked against the agent the caller NAMED rather than the one that actually owns
    // the credential.
    const row = await env.DB.prepare(
      revokeTokenOwnershipQuery(),
    )
      .bind(tokenId, env.TENANT_SLUG)
      .first<{ id: string; member_id: string; agent_id: string | null; label: string; revoked_at: string | null }>()

    if (!row || row.agent_id !== agent.id) {
      // Same 404 whether the token is absent or belongs elsewhere — do not turn this
      // into an oracle for token ids on other squads.
      return fail(404, 'token_not_found', `No token "${tokenId}" belongs to agent "${agent.slug}".`)
    }

    // Idempotent: revoking an already-revoked token succeeds and reports revoked:false.
    const revoked = await revokeMemberToken(env, row.member_id, tokenId)

    await emitProvisioned(env, auth.memberId as string, 'token_revoked', tokenId, {
      squad_id: agent.squad_id,
      agent_id: agent.id,
      member_id: row.member_id,
    })

    return done({
      token: { id: tokenId, label: row.label, agent_id: agent.id },
      revoked,
      already_revoked: !revoked,
      note: revoked
        ? 'Token revoked. It fails authentication immediately — grants are re-resolved per request.'
        : 'Token was already revoked; no change.',
    })
  },
}

function connectionErrorToFail(outcome: Extract<AgentConnectionOutcome, { status: 'error' }>) {
  const code = outcome.error
  if (code === 'forbidden' || code === 'capability_ceiling') {
    return fail(403, code, outcome.details)
  }
  if (code === 'agent_not_found' || code === 'squad_not_found') {
    return fail(404, code)
  }
  if (code === 'public_origin_unconfigured') return fail(503, code)
  if (
    code === 'request_id_conflict'
    || code === 'agent_setup_in_progress'
    || code === 'ambiguous_slug'
    || code === 'agent_already_connected'
    || code === 'agent_identity_conflict'
    || code === 'agent_identity_unminted'
    || code === 'replace_token_not_found'
    || code === 'slug_taken'
  ) {
    return fail(409, code)
  }
  if (code === 'provisioning_failed' || code === 'receipt_not_found') {
    return fail(500, code)
  }
  return fail(400, code, outcome.details)
}

// ── provision_agent_connection ───────────────────────────────────────────────
// High-level, retry-safe owner workflow. This is the only surface that composes
// reservation + optional create + canonical identity + synchronized access +
// credential + immutable receipt into one provisioning transaction.
const toolProvisionAgentConnection: ToolSpec = {
  name: 'provision_agent_connection',
  scope: 'home and additional squads',
  min: 'admin',
  args:
    '{ request_id, existing_agent XOR new_agent, additional_access?, credential }',
  inputSchema: {
    type: 'object',
    properties: {
      request_id: STRING_SCHEMA,
      existing_agent: STRING_SCHEMA,
      new_agent: {
        type: 'object',
        properties: {
          home_squad: STRING_SCHEMA,
          slug: STRING_SCHEMA,
          name: STRING_SCHEMA,
          role: STRING_SCHEMA,
          model: STRING_SCHEMA,
        },
        required: ['home_squad', 'slug', 'name'],
        additionalProperties: false,
      },
      additional_access: AGENT_ACCESS_SCHEMA,
      credential: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['issue_if_missing', 'add', 'replace'] },
          label: STRING_SCHEMA,
          home_capability: { type: 'string', enum: ['observer', 'member'] },
          replace_token_id: STRING_SCHEMA,
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    required: ['request_id', 'credential'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    if (auth.boundAgentId) return fail(403, 'operator_principal_required')
    const requestId = str(args.request_id)
    const existingRef = str(args.existing_agent)
    const newAgent = args.new_agent
    if (!requestId || Boolean(existingRef) === Boolean(newAgent)) {
      return fail(400, 'invalid_args', 'provide request_id and exactly one of existing_agent or new_agent')
    }
    if (!auth.memberId) return fail(403, 'forbidden', { need: 'member_identity' })

    let target: Parameters<typeof provisionAgentConnection>[2]['target']
    if (existingRef) {
      const resolved = await resolveAgentRef(env, existingRef)
      if (!resolved.ok) return resolveFail(resolved.reason, 'agent_not_found')
      target = { kind: 'existing', agentRef: resolved.value.id }
    } else {
      if (!newAgent || typeof newAgent !== 'object' || Array.isArray(newAgent)) {
        return fail(400, 'invalid_args', 'new_agent must be an object')
      }
      const value = newAgent as Record<string, unknown>
      const homeSquadRef = str(value.home_squad)
      const slug = str(value.slug)
      const name = str(value.name)
      if (!homeSquadRef || !slug || !name) {
        return fail(400, 'invalid_args', 'new_agent.home_squad, slug, and name are required')
      }
      const homeSquad = await resolveSquadRef(env, homeSquadRef)
      if (!homeSquad.ok) return resolveFail(homeSquad.reason, 'squad_not_found')
      target = {
        kind: 'new',
        homeSquadId: homeSquad.value.id,
        agent: {
          slug,
          name,
          ...(str(value.role) ? { role: str(value.role) } : {}),
          ...(str(value.model) ? { model: str(value.model) } : {}),
        },
      }
    }

    const additionalArgs = args.additional_access ?? []
    if (!Array.isArray(additionalArgs)) {
      return fail(400, 'invalid_args', 'additional_access must be an array')
    }
    const additionalAccess: Parameters<typeof provisionAgentConnection>[2]['additionalAccess'] = []
    for (const entry of additionalArgs) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return fail(400, 'invalid_args', 'additional_access entries must be objects')
      }
      const value = entry as Record<string, unknown>
      const squadRef = str(value.squad)
      const capability = str(value.capability)
      if (
        !squadRef
        || !capability
        || !GRANTABLE_AGENT_CAPABILITIES.has(capability as Capability)
      ) {
        return fail(400, 'invalid_args', 'invalid additional squad or capability')
      }
      const squad = await resolveSquadRef(env, squadRef)
      if (!squad.ok) return resolveFail(squad.reason, 'squad_not_found')
      additionalAccess.push({
        squadId: squad.value.id,
        capability: capability as AgentAccessCapability,
      })
    }

    const credentialArg = args.credential
    if (!credentialArg || typeof credentialArg !== 'object' || Array.isArray(credentialArg)) {
      return fail(400, 'invalid_args', 'credential must be an object')
    }
    const credential = credentialArg as Record<string, unknown>
    const action = str(credential.action)
    if (!action || !['issue_if_missing', 'add', 'replace'].includes(action)) {
      return fail(400, 'invalid_args', 'invalid credential action')
    }

    const outcome = await provisionAgentConnection(env, {
      kind: 'member',
      id: auth.memberId,
      grants: auth.capabilities ?? [],
    }, {
      requestId,
      target,
      additionalAccess,
      credential: {
        action: action as 'issue_if_missing' | 'add' | 'replace',
        label: str(credential.label)
          ?? (target.kind === 'new' ? String(target.agent.slug) : 'workspace'),
        ...(str(credential.home_capability)
          ? { homeCapability: str(credential.home_capability) as 'observer' | 'member' }
          : {}),
        ...(str(credential.replace_token_id)
          ? { replaceTokenId: str(credential.replace_token_id) as string }
          : {}),
      },
    })

    if (outcome.status === 'error') return connectionErrorToFail(outcome)
    if (outcome.status === 'in_progress') return fail(409, 'agent_setup_in_progress')
    return done(outcome)
  },
}

// ── grant_agent_capability ───────────────────────────────────────────────────
// Grants the one active member identity welded to an existing agent a capability
// on another squad. It never mints or returns a credential.
const toolGrantAgentCapability: ToolSpec = {
  name: 'grant_agent_capability',
  scope: 'target squad',
  min: 'admin',
  args: '{ agent: string (id|slug), squad: string (id|slug), capability: "observer"|"member"|"lead"|"admin" }',
  inputSchema: {
    type: 'object',
    properties: {
      agent: STRING_SCHEMA,
      squad: STRING_SCHEMA,
      capability: { type: 'string', enum: ['observer', 'member', 'lead', 'admin'] },
    },
    required: ['agent', 'squad', 'capability'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    if (auth.boundAgentId) return fail(403, 'operator_principal_required')
    const agentRef = str(args.agent)
    if (!agentRef) return fail(400, 'invalid_args', 'agent required')
    const squadRef = str(args.squad)
    if (!squadRef) return fail(400, 'invalid_args', 'squad required')
    const requestedCapability = str(args.capability)
    if (!requestedCapability || !GRANTABLE_AGENT_CAPABILITIES.has(requestedCapability as Capability)) {
      return fail(400, 'invalid_capability', 'capability must be observer, member, lead, or admin')
    }
    const capability = requestedCapability as Capability

    const agentResult = await resolveAgentRef(env, agentRef)
    if (!agentResult.ok) return resolveFail(agentResult.reason, 'agent_not_found')
    const agent = agentResult.value

    const squadResult = await resolveSquadRef(env, squadRef)
    if (!squadResult.ok) return resolveFail(squadResult.reason, 'squad_not_found')
    const squad = squadResult.value

    const grants = auth.capabilities ?? []
    if (!(await memberCanOnSquad(env, grants, squad.id, 'admin'))) {
      return fail(403, 'forbidden', { need: 'admin', scope: 'squad' })
    }
    if (!callerCanGrantAgentCapability(grants, squad, capability)) {
      return fail(403, 'cannot_grant_above_own_rank')
    }

    const binding = await resolveAgentMemberBinding(env, agent.id)
    if (binding.kind === 'unminted') {
      return fail(409, 'agent_identity_unminted', 'call mint_agent_token before granting capabilities')
    }

    const outcome = await setAgentSquadAccess(env, {
      agentId: agent.id,
      memberId: binding.memberId,
      squadId: squad.id,
      capability: capability as AgentAccessCapability,
    })
    if (!outcome.ok) {
      if (outcome.error === 'agent_not_found') return fail(404, outcome.error)
      if (outcome.error === 'squad_not_found') return fail(404, outcome.error)
      if (outcome.error === 'receipt_failed') return fail(500, outcome.error)
      return fail(409, outcome.error)
    }
    await emitProvisioned(env, auth.memberId as string, 'capability', squad.id, {
      squad_id: squad.id,
      agent_id: agent.id,
      member_id: binding.memberId,
      capability,
    })

    return done({
      agent: { id: agent.id },
      squad: { id: squad.id },
      member_id: binding.memberId,
      grant: outcome.grant,
      result: outcome.result,
    })
  },
}

// ── register_agent_key ────────────────────────────────────────────────────────
// Stores only a host-generated Ed25519 PUBLIC key. The key is bound to the one
// active member identity already welded to this agent by mint_agent_token.
const toolRegisterAgentKey: ToolSpec = {
  name: 'register_agent_key',
  scope: "agent's squad",
  min: 'admin',
  args: '{ agent: string (id|slug), public_key: string (Ed25519 JWK x), key_id?: exact agent id (default; slug only for legacy compatibility) }',
  inputSchema: {
    type: 'object',
    properties: { agent: STRING_SCHEMA, public_key: STRING_SCHEMA, key_id: STRING_SCHEMA },
    required: ['agent', 'public_key'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    if (auth.boundAgentId) return fail(403, 'operator_principal_required')
    const agentRef = str(args.agent)
    if (!agentRef) return fail(400, 'invalid_args', 'agent required')

    const agentResult = await resolveAgentRef(env, agentRef)
    if (!agentResult.ok) return resolveFail(agentResult.reason, 'agent_not_found')
    const agent = agentResult.value

    const grants = auth.capabilities ?? []
    if (!(await memberCanOnSquad(env, grants, agent.squad_id, 'admin'))) {
      return fail(403, 'forbidden', { need: 'admin', scope: 'squad' })
    }

    const publicKey = str(args.public_key)
    if (!publicKey || !(await isValidEd25519PublicX(publicKey))) {
      return fail(400, 'invalid_public_key', 'public_key must be a canonical Ed25519 JWK x value')
    }

    // Signed inbox delivery addresses the canonical agent ID. Defaulting runtime
    // keys to that same ID keeps attach, inbox, and lifecycle control aligned.
    const keyId = str(args.key_id) ?? agent.id
    if (keyId !== agent.slug && keyId !== agent.id) {
      return fail(400, 'invalid_key_id', 'key_id must exactly match the resolved agent slug or id')
    }

    const registered = await registerAgentPublicKey(env, keyId, agent.id, publicKey)
    if (!registered.ok) {
      if (registered.reason === 'identity_unminted') {
        return fail(409, 'agent_identity_unminted', 'call mint_agent_token before registering the key')
      }
      if (registered.reason === 'identity_ambiguous') {
        return fail(409, 'agent_identity_ambiguous', 'revoke stale agent tokens until one active member identity remains')
      }
      return fail(409, 'agent_key_conflict', 'a different key or member binding already exists; implicit rotation is refused')
    }

    if (registered.status !== 'already_registered') {
      await emitProvisioned(env, auth.memberId as string, 'key', agent.id, {
        squad_id: agent.squad_id,
        agent_id: agent.id,
      })
    }
    return done({
      status: registered.status,
      agent: { id: agent.id, slug: agent.slug, name: agent.name },
      key_id: keyId,
      member_id: registered.memberId,
      public_key: publicKey,
      note: 'only public Ed25519 material is stored; the private key remains on the host',
    })
  },
}

/**
 * Read the before/after diff back out of the committed audit row.
 *
 * The audit is the authoritative record — it is written in the same transaction
 * as the update. Deriving the event payload from it (instead of from a separate
 * pre-read) means the notification and the trail always tell the same story.
 *
 * Returns an empty diff if the row cannot be read or parsed. That is not a
 * silent swallow: the audit itself is already committed and durable, so this
 * only degrades the advisory event payload, never the record.
 */
async function readAuditDiff(
  env: Env,
  auditId: string,
  fields: string[],
): Promise<Record<string, { from: unknown; to: unknown }>> {
  const row = await env.DB.prepare('SELECT before_state, after_state FROM agent_audit WHERE id = ?')
    .bind(auditId)
    .first<{ before_state: string; after_state: string }>()
  if (!row) return {}

  let before: Record<string, unknown>
  let after: Record<string, unknown>
  try {
    before = JSON.parse(row.before_state) as Record<string, unknown>
    after = JSON.parse(row.after_state) as Record<string, unknown>
  } catch {
    return {}
  }

  const changed: Record<string, { from: unknown; to: unknown }> = {}
  for (const key of fields) changed[key] = { from: before[key] ?? null, to: after[key] ?? null }
  return changed
}

// ── update_agent ──────────────────────────────────────────────────────────────
// Correct a live agent's profile row. Added because the registry drifts and had
// no repair path: before this, the only writes to `agents` were status and
// kpi_progress, so a re-harnessed or re-modelled seat kept asserting whatever
// was true the day it was created, and the only fix was direct database access
// — which is why it never stayed fixed. Partial patch: absent keys are left
// alone, so correcting a model cannot blank a purpose. `status` is NOT settable
// here (deactivate_agent owns retirement, with its token/presence/key teardown)
// and neither is squad_id (moving squads changes capability scope — that is a
// re-provision, not an edit).
const toolUpdateAgent: ToolSpec = {
  name: 'update_agent',
  scope: "agent's squad",
  min: 'admin',
  args:
    '{ agent: string (id|slug), slug?, name?, role?, model?, model_fallback?, purpose?, owner?, qnft_ref?, capabilities?: string[], skills?: string[], reason?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      agent: STRING_SCHEMA,
      slug: STRING_SCHEMA,
      name: STRING_SCHEMA,
      role: STRING_SCHEMA,
      model: STRING_SCHEMA,
      model_fallback: STRING_SCHEMA,
      purpose: STRING_SCHEMA,
      owner: STRING_SCHEMA,
      // parent_agent_id is NOT patchable here. additionalProperties:false makes a
      // caller that still sends it fail loudly at the schema instead of silently
      // dropping the field. See UPDATABLE_TEXT_COLUMNS in src/org/service.ts.
      qnft_ref: STRING_SCHEMA,
      capabilities: { type: 'array', items: STRING_SCHEMA },
      skills: { type: 'array', items: STRING_SCHEMA },
      reason: STRING_SCHEMA,
    },
    required: ['agent'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    if (auth.boundAgentId) return fail(403, 'operator_principal_required')
    const agentRef = str(args.agent)
    if (!agentRef) return fail(400, 'invalid_args', 'agent required')

    const agentResult = await resolveAgentRef(env, agentRef)
    if (!agentResult.ok) return resolveFail(agentResult.reason, 'agent_not_found')
    const agent = agentResult.value

    // Gate: admin on the agent's squad, same rank as create/deactivate. A
    // profile row is identity — who an agent claims to be is what every
    // downstream router, gate, and dispatcher reads.
    const grants = auth.capabilities ?? []
    if (!(await memberCanOnSquad(env, grants, agent.squad_id, 'admin'))) {
      return fail(403, 'forbidden', { need: 'admin', scope: 'squad' })
    }

    const PATCHABLE = [
      'slug',
      'name',
      'role',
      'model',
      'model_fallback',
      'purpose',
      'owner',
      'qnft_ref',
      'capabilities',
      'skills',
    ] as const

    const patch: AgentProfilePatch = {}
    for (const key of PATCHABLE) {
      if (key in args) patch[key] = args[key]
    }
    if (!Object.keys(patch).length) {
      return fail(400, 'invalid_args', 'at least one field to update is required')
    }

    const result = await updateAgentProfile(env, agent.id, patch, {
      id: auth.memberId as string,
      type: 'user',
    })
    if (!result.ok) {
      if (result.error === 'slug_taken') return fail(409, 'slug_taken', { slug: str(args.slug) })
      if (result.error === 'not_found') return fail(404, 'agent_not_found', { agent: agentRef })
      return fail(400, 'invalid_args', { reason: result.error })
    }

    // The durable record is agent_audit, written inside the same transaction as
    // the update (see updateAgentProfile). `changed` below is derived FROM that
    // committed row rather than from a separate pre-read, so the event and the
    // audit cannot disagree — and a concurrent write cannot make either of them
    // report a diff that never happened.
    const changed = await readAuditDiff(env, result.auditId, Object.keys(patch))

    // Best-effort by design, and now safe to be: a bus failure loses a
    // notification, not the audit trail. It used to lose both.
    await emitProvisioned(env, auth.memberId as string, 'agent_updated', agent.id, {
      agent_id: agent.id,
      squad_id: agent.squad_id,
      changed,
      reason: str(args.reason) || undefined,
    })

    return done({ agent: result.value, changed, audit_id: result.auditId })
  },
}

// ── deactivate_agent ──────────────────────────────────────────────────────────
// The inverse of create_agent: retires a dead/junk agent (or a duplicate
// identity) auditably, without a raw-D1 hand-edit. SOFT delete only —
// agents.status flips to 'inactive' (migration 0049 widened the CHECK; a hard
// DELETE FROM agents would cascade/null out task and membership history that
// should survive retirement, and forecloses ever reversing the call). But a
// status flip alone would be cosmetic: the agent must actually lose the
// ability to ACT, so this also revokes every live member_tokens row welded to
// it (it can no longer authenticate as itself), clears its fleet_agents
// presence row(s) (drops off the fleet/radar roster), and removes its
// signed-runtime public key(s) (agent_keys — a future signed-attach fails
// closed with no key to verify against).
const toolDeactivateAgent: ToolSpec = {
  name: 'deactivate_agent',
  scope: "agent's squad",
  min: 'admin',
  args: '{ agent: string (id|slug), reason?: string }',
  inputSchema: {
    type: 'object',
    properties: { agent: STRING_SCHEMA, reason: STRING_SCHEMA },
    required: ['agent'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const agentRef = str(args.agent)
    if (!agentRef) return fail(400, 'invalid_args', 'agent required')

    const agentResult = await resolveAgentRef(env, agentRef)
    if (!agentResult.ok) return resolveFail(agentResult.reason, 'agent_not_found')
    const agent = agentResult.value

    // Gate: admin on the agent's squad (org/department admin inherit) — same
    // rank as mint/register; retiring a credentialed identity is an org-trust
    // act, not a routine edit.
    const grants = auth.capabilities ?? []
    if (!(await memberCanOnSquad(env, grants, agent.squad_id, 'admin'))) {
      return fail(403, 'forbidden', { need: 'admin', scope: 'squad' })
    }

    // HARD GUARD: the pot's own fleet-control identities are load-bearing —
    // deactivating the consumer daemon or the ops agent breaks fleet control
    // for every other agent on the pot. Fleet's identifier space is the SLUG,
    // not the uuid (see the id↔slug bridge note in src/fleet/registry.ts), so
    // match the env-configured identity against both.
    const consumerAgent = env.FLEET_CONSUMER_AGENT?.trim()
    if (consumerAgent && (consumerAgent === agent.id || consumerAgent === agent.slug)) {
      return fail(409, 'protected_agent', { reason: 'fleet_consumer_agent', agent: agent.slug })
    }
    const opsAgent = env.FLEET_OPS_AGENT?.trim()
    if (opsAgent && (opsAgent === agent.id || opsAgent === agent.slug)) {
      return fail(409, 'protected_agent', { reason: 'fleet_ops_agent', agent: agent.slug })
    }

    // HARD GUARD: an agent-bound token cannot deactivate the very agent it is
    // bound to — the caller would be cutting off its own credential mid-call.
    if (auth.boundAgentId && auth.boundAgentId === agent.id) {
      return fail(409, 'cannot_deactivate_self')
    }

    const reason = str(args.reason) ?? undefined

    // fleet_agents / agent_keys rows may be keyed by agent.id OR agent.slug
    // (external runtimes attach/report under the human-readable slug — see the
    // bridge note in src/fleet/registry.ts). Sweeping by the bare slug is only
    // SAFE when it names this one agent tenant-wide: agents.slug is
    // UNIQUE(squad_id, slug), NOT globally unique, so two agents in different
    // squads can share a slug (the exact self-poisoning class the 2026-07-14
    // fleet bridge fix addressed). Ambiguous → skip the slug-keyed cleanup;
    // the id-keyed cleanup below still always runs.
    const dupes = await env.DB.prepare('SELECT COUNT(*) AS n FROM agents WHERE slug = ?1')
      .bind(agent.slug)
      .first<{ n: number }>()
    const safeSlug = Number(dupes?.n ?? 0) === 1 ? agent.slug : null

    const now = new Date().toISOString()
    const stmts = [
      // 1) SOFT retire — reversible flag, never a hard delete.
      env.DB.prepare(`UPDATE agents SET status = 'inactive' WHERE id = ?1`).bind(agent.id),
      // 2) Revoke every live credential welded to this agent (tenant-scoped;
      //    member_tokens.agent_id is the mint_agent_token weld).
      env.DB.prepare(
        `UPDATE member_tokens SET revoked_at = ?1 WHERE tenant = ?2 AND agent_id = ?3 AND revoked_at IS NULL`,
      ).bind(now, env.TENANT_SLUG, agent.id),
      // 3) Drop its fleet/radar presence row, id-keyed.
      env.DB.prepare(`DELETE FROM fleet_agents WHERE tenant = ?1 AND agent_id = ?2`).bind(env.TENANT_SLUG, agent.id),
      // 4) Remove its signed-runtime public key, id-keyed — signed-attach fails closed.
      env.DB.prepare(`DELETE FROM agent_keys WHERE tenant = ?1 AND agent_id = ?2`).bind(env.TENANT_SLUG, agent.id),
    ]
    if (safeSlug) {
      stmts.push(
        env.DB.prepare(`DELETE FROM fleet_agents WHERE tenant = ?1 AND agent_id = ?2`).bind(env.TENANT_SLUG, safeSlug),
        env.DB.prepare(`DELETE FROM agent_keys WHERE tenant = ?1 AND agent_id = ?2`).bind(env.TENANT_SLUG, safeSlug),
      )
    }

    const results = await env.DB.batch(stmts)
    // The agent row itself MUST flip — a 0-row UPDATE means the id vanished
    // between resolve and write (TOCTOU); nothing else in this batch is safe
    // to report as effective if that happened.
    assertWritten(results[0], 'deactivate_agent.agents', 1)

    const tokensRevoked = rowsWritten(results[1])
    const detached = rowsWritten(results[2]) + (safeSlug ? rowsWritten(results[4]) : 0)
    const keysRemoved = rowsWritten(results[3]) + (safeSlug ? rowsWritten(results[5]) : 0)

    await emitProvisioned(env, auth.memberId as string, 'agent_deactivated', agent.id, {
      squad_id: agent.squad_id,
      agent_id: agent.id,
      ...(reason ? { reason } : {}),
    })

    return done({
      status: 'deactivated',
      agent: { id: agent.id, slug: agent.slug, name: agent.name },
      detached,
      tokens_revoked: tokensRevoked,
      keys_removed: keysRemoved,
      // Ambiguous slug (shared with an agent in another squad) → the
      // slug-keyed fleet_agents/agent_keys sweep above was skipped on
      // purpose (never sweep another agent's row). That means a signed
      // runtime key or fleet presence row registered under the bare slug
      // (see the id↔slug bridge note in src/fleet/registry.ts) can survive
      // this deactivation and let the retired agent still attach. Surface
      // it so the operator knows manual cleanup is needed — this must not
      // be silently invisible in the tool result.
      ...(safeSlug ? {} : { slug_sweep_skipped: true }),
    })
  },
}

export const PROVISION_TOOLS: ToolSpec[] = [
  toolCreateDepartment,
  toolCreateSquad,
  toolCreateAgent,
  toolResolveAgent,
  toolGetAgentProfile,
  toolMintAgentToken,
  toolListAgentTokens,
  toolRevokeAgentToken,
  toolProvisionAgentConnection,
  toolGrantAgentCapability,
  toolRegisterAgentKey,
  toolDeactivateAgent,
  toolUpdateAgent,
]
