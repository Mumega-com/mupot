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
import { createDepartment, createSquad, createAgent, findAgentsByName, getAgentProfile } from '../org/service'
import {
  mintAgentBoundToken,
  isAgentTokenCapability,
  resolveActiveAgentMember,
  upsertActiveAgentCapabilityGrant,
} from '../members/service'
import { mcpEndpoint, wakeContractForAgent } from '../dashboard/connect'
import { createBus } from '../bus'
import { resolveDepartmentRef, resolveSquadRef, resolveAgentRef } from '../org/resolve'
import { isValidEd25519PublicX, registerAgentPublicKey } from '../fleet/agent-keys'
import { assertWritten, rowsWritten } from '../lib/receipt'
import {
  type ToolSpec,
  fail,
  done,
  str,
  memberCanOnSquad,
} from './index'
import { getHarnessPack, listShippableHarnesses, BYOA_HARNESSES } from '../byoa/catalog'

const STRING_SCHEMA = { type: 'string' }
const OPTIONAL_NUMBER_SCHEMA = { type: 'number' }
const OPTIONAL_STRING_ARRAY_SCHEMA = { type: 'array', items: { type: 'string' } }
const OPTIONAL_BOOLEAN_SCHEMA = { type: 'boolean' }
// death_condition is a free-form lifecycle-policy object (validated as JSON in service).
const PROFILE_OBJECT_SCHEMA = { type: 'object' }
const GRANTABLE_AGENT_CAPABILITIES = new Set<Capability>(['observer', 'member', 'lead', 'admin'])

// Emit an attributed provision event so the activity feed/consumer knows a member
// caused a structural change (kasra-review W2 — the mint was previously unattributed
// on the bus). One event type carries the kind; payload names what was created.
async function emitProvisioned(
  env: Env,
  memberId: string,
  kind: 'department' | 'squad' | 'agent' | 'token' | 'key' | 'capability' | 'agent_deactivated',
  id: string,
  extra: { squad_id?: string; agent_id?: string; member_id?: string; capability?: Capability; reason?: string } = {},
): Promise<void> {
  const event: BusEvent<{
    kind: string
    id: string
    by: string
    member_id?: string
    capability?: Capability
    reason?: string
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
  async run(auth, env, args, ctx) {
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

    // Delegate to the shared atomic-mint helper (members/service.ts).
    // Three rows in ONE D1 batch: member envelope + escalation-guard capability +
    // agent-weld token. Either all three land or none do — no orphan credentials.
    // The helper enforces: squad-scoped observer/member only, hash-only storage,
    // show-once raw.
    const minted = await mintAgentBoundToken(env, agent, label, grantCapability)

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
      mcp_endpoint: mcpEndpoint(ctx.origin),
      wake_contract: wakeContractForAgent(agent.id, agent.squad_id, env.TENANT_SLUG, ctx.origin),
      note: 'raw token is shown ONCE — store it now; it is never retrievable again',
    })
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

    const agentMemberId = await resolveActiveAgentMember(env, agent.id)
    if (agentMemberId === 'unminted') {
      return fail(409, 'agent_identity_unminted', 'call mint_agent_token before granting capabilities')
    }
    if (agentMemberId === 'ambiguous') {
      return fail(409, 'agent_identity_ambiguous', 'revoke stale agent tokens until one active member identity remains')
    }

    const outcome = await upsertActiveAgentCapabilityGrant(env, {
      agentId: agent.id,
      expectedMemberId: agentMemberId,
      squadId: squad.id,
      capability,
    })
    if (!outcome) {
      const currentIdentity = await resolveActiveAgentMember(env, agent.id)
      if (currentIdentity === 'unminted') {
        return fail(409, 'agent_identity_unminted', 'call mint_agent_token before granting capabilities')
      }
      if (currentIdentity === 'ambiguous') {
        return fail(409, 'agent_identity_ambiguous', 'revoke stale agent tokens until one active member identity remains')
      }
      if (currentIdentity === agentMemberId) {
        return fail(500, 'receipt_failed', 'capability grant returned no write receipt')
      }
      return fail(409, 'agent_identity_changed', 'agent member binding changed; retry the grant')
    }
    await emitProvisioned(env, auth.memberId as string, 'capability', squad.id, {
      squad_id: squad.id,
      agent_id: agent.id,
      member_id: agentMemberId,
      capability,
    })

    return done({
      agent: { id: agent.id },
      squad: { id: squad.id },
      member_id: agentMemberId,
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

// ── list_harness_packs / get_harness_pack (BYOA slice 5) ─────────────────────
// Discovery + download for per-harness install packs. AuthZ: any authenticated
// member may read pack templates (they contain placeholders, never secrets).
const toolListHarnessPacks: ToolSpec = {
  name: 'list_harness_packs',
  scope: 'org',
  min: 'observer',
  args: '{ }',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async run() {
    return done({
      flow: [
        'create_agent',
        'mint_agent_token',
        'register_agent_key (topology C)',
        'grant_agent_capability',
        'get_harness_pack',
      ],
      packs: listShippableHarnesses().map((h) => ({
        id: h.id,
        label: h.label,
        topology: h.topology,
        credential: h.credential,
        pack_dir: `packs/${h.packDir}/`,
        summary: h.summary,
        files: h.files.map((f) => f.path),
      })),
      docs_only: BYOA_HARNESSES.filter((h) => !h.shipPack).map((h) => ({
        id: h.id,
        label: h.label,
        topology: h.topology,
        summary: h.summary,
        doc: 'docs/byoa-claude-desktop.md',
      })),
      omitted: [{ id: 'codex-cloud', reason: 'no public launch/poll API (OpenAI #24777)' }],
    })
  },
}

const toolGetHarnessPack: ToolSpec = {
  name: 'get_harness_pack',
  scope: 'org',
  min: 'observer',
  args: '{ harness: string }',
  inputSchema: {
    type: 'object',
    properties: { harness: STRING_SCHEMA },
    required: ['harness'],
    additionalProperties: false,
  },
  async run(_auth, _env, args) {
    const harnessId = str(args.harness)
    if (!harnessId) return fail(400, 'invalid_args', 'harness required')
    const result = getHarnessPack(harnessId)
    if (!result.ok) {
      if (result.error === 'docs_only') {
        return fail(400, 'docs_only', 'Claude Desktop is docs-only — see docs/byoa-claude-desktop.md')
      }
      return fail(404, 'harness_not_found')
    }
    const { harness } = result
    return done({
      harness: harness.id,
      label: harness.label,
      topology: harness.topology,
      credential: harness.credential,
      pack_dir: `packs/${harness.packDir}/`,
      summary: harness.summary,
      files: harness.files.map((f) => ({ path: f.path, content: f.content })),
      next_steps: [
        'create_agent',
        'mint_agent_token',
        harness.credential === 'ed25519_key' ? 'register_agent_key' : null,
        'grant_agent_capability (additional squads only — mint already grants own squad)',
        'inject token into pack config; never commit secrets',
      ].filter(Boolean),
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
  toolGrantAgentCapability,
  toolRegisterAgentKey,
  toolDeactivateAgent,
  toolListHarnessPacks,
  toolGetHarnessPack,
]
