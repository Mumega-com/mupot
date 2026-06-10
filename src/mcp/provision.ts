// mupot — MCP provision tools (SENSITIVE: org-structure writes + identity mint).
//
// These three tools let an authenticated operator stand up a squad/agent/bound-token
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
//     squad-scoped 'member' capability on the agent's OWN squad — never org/department,
//     never above 'member'. A minted agent token therefore can NEVER inherit the
//     operator's org-admin: it can only ever act as 'member' on its one squad. This is
//     the sovereign default and the reason mint is itself gated at 'admin'.
//
// Tools (registered into the TOOLS array in src/mcp/index):
//   create_squad      — admin on the department (org inherits)
//   create_agent      — lead on the squad (org/department inherit)
//   mint_agent_token  — admin on the agent's squad (org/department inherit) → show-once raw

import type { Env, BusEvent } from '../types'
import { hasCapability } from '../auth/capability'
import { createDepartment, createSquad, createAgent } from '../org/service'
import { mintRawToken, sha256Hex } from '../members/service'
import { mcpEndpoint } from '../dashboard/connect'
import { createBus } from '../bus'
import { resolveDepartmentRef, resolveSquadRef, resolveAgentRef } from '../org/resolve'
import {
  type ToolSpec,
  fail,
  done,
  str,
  memberCanOnSquad,
} from './index'

const STRING_SCHEMA = { type: 'string' }
const OPTIONAL_NUMBER_SCHEMA = { type: 'number' }

// Emit an attributed provision event so the activity feed/consumer knows a member
// caused a structural change (kasra-review W2 — the mint was previously unattributed
// on the bus). One event type carries the kind; payload names what was created.
async function emitProvisioned(
  env: Env,
  memberId: string,
  kind: 'department' | 'squad' | 'agent' | 'token',
  id: string,
  extra: { squad_id?: string; agent_id?: string } = {},
): Promise<void> {
  const event: BusEvent<{ kind: string; id: string; by: string }> = {
    type: 'org.provisioned',
    tenant: env.TENANT_SLUG,
    squad_id: extra.squad_id,
    agent_id: extra.agent_id,
    actor: { kind: 'member', id: memberId },
    payload: { kind, id, by: memberId },
    ts: new Date().toISOString(),
  }
  await createBus(env).emit(event)
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
    '{ squad: string (id|slug), slug: string, name: string, role?, model?, okr?, kpi_target?, effort?, autonomy?, budget_cap_cents?, budget_window? }',
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
    })
    if (!result.ok) return createErrorToFail(result.error)
    await emitProvisioned(env, auth.memberId as string, 'agent', result.value.id, {
      squad_id: squad.id,
      agent_id: result.value.id,
    })
    return done({ agent: result.value })
  },
}

// ── mint_agent_token ─────────────────────────────────────────────────────────────
// Creates a DEDICATED member for the agent, grants it a HARD-CAPPED squad-scoped
// 'member' capability on the agent's own squad, binds a fresh token to the agent
// (the weld: member_tokens.agent_id), and returns the raw token EXACTLY ONCE.
const toolMintAgentToken: ToolSpec = {
  name: 'mint_agent_token',
  scope: "agent's squad",
  min: 'admin',
  args: '{ agent: string (id|slug), label? }',
  inputSchema: {
    type: 'object',
    properties: { agent: STRING_SCHEMA, label: STRING_SCHEMA },
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
    const label = (str(args.label) ?? agent.slug).slice(0, 64)

    // ATOMIC mint (kasra-review: was 3 sequential writes → orphan-on-partial-failure).
    // member + capability + token go in ONE D1 batch (a transaction): either all three
    // land or none do — no member without a grant, no grant without a token. We compose
    // the token row inline using the SAME security primitives as the single mint path
    // (mintRawToken + sha256Hex from members/service) so the discipline is preserved:
    // only the hash is stored, the raw is returned exactly once.
    const memberId = crypto.randomUUID()
    const tokenId = crypto.randomUUID()
    const rawToken = mintRawToken()
    const tokenHash = await sha256Hex(rawToken)
    const createdAt = new Date().toISOString()

    await env.DB.batch([
      // 1) dedicated member envelope for the agent (no email, no IM — it is not a human).
      env.DB.prepare(
        `INSERT INTO members (id, email, display_name, telegram_chat_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(memberId, null, agent.name, null, 'active', createdAt),
      // 2) THE ESCALATION GUARD: squad-scoped 'member' on the agent's OWN squad only.
      //    Hard-coded scope + capability — never widened from args, never inherits the
      //    operator's standing. The agent token's authority is exactly this one row.
      env.DB.prepare(
        `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
         VALUES (?, ?, 'squad', ?, 'member')`,
      ).bind(crypto.randomUUID(), memberId, agent.squad_id),
      // 3) the weld: bind the token to the agent (agent_id set). Only the hash is stored.
      env.DB.prepare(
        `INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id)
         VALUES (?, ?, ?, ?, 'workspace', ?, ?)`,
      ).bind(tokenId, memberId, tokenHash, label, createdAt, agent.id),
    ])

    await emitProvisioned(env, auth.memberId as string, 'token', tokenId, {
      squad_id: agent.squad_id,
      agent_id: agent.id,
    })

    // SECURITY: `raw` is the show-once token — returned as a BARE field, never woven
    // into a reusable config snippet (see src/dashboard/connect security note). The
    // caller renders its own client config from raw + mcp_endpoint.
    return done({
      token: {
        id: tokenId,
        member_id: memberId,
        agent_id: agent.id,
        label,
        channel: 'workspace',
        created_at: createdAt,
        raw: rawToken,
      },
      agent: { id: agent.id, slug: agent.slug, name: agent.name },
      mcp_endpoint: mcpEndpoint(ctx.origin),
      note: 'raw token is shown ONCE — store it now; it is never retrievable again',
    })
  },
}

export const PROVISION_TOOLS: ToolSpec[] = [
  toolCreateDepartment,
  toolCreateSquad,
  toolCreateAgent,
  toolMintAgentToken,
]
