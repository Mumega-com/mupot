// mupot — MCP tools for HUMANS to manage delegated operators (Operators + Admission W0, mumega-com#1386).
//
// operator_delegate / operator_revoke / operator_list. All three go through the structural chokepoint with a
// non-delegable action, so an agent-bound caller is refused as operator_principal_required before any argument is
// read, whether or not it holds a delegation, an elevation grant or org admin. The writers in
// src/operators/delegations.ts re-check "human" themselves (defence in depth: they are reachable from no other tool).

import { authorizeStructuralWrite } from '../operators/chokepoint'
import {
  capabilityScopeForDelegation,
  createDelegation,
  delegatedOperatorsEnabled,
  listDelegations,
  revokeDelegation,
  type DelegationError,
} from '../operators/delegations'
import { resolveAgentRef } from '../org/resolve'
import { actorRankOnScopeFor, capabilityRank } from '../auth/capability'
import { done, fail, hasWorkspaceAdmin, str, type ToolSpec } from './index'

const STRING_SCHEMA = { type: 'string' }

function errorStatus(error: DelegationError): 400 | 403 | 404 | 409 {
  switch (error) {
    case 'invalid_scope_type':
    case 'invalid_scope_id':
    case 'invalid_max_grant':
      return 400
    case 'scope_not_found':
    case 'agent_not_found':
    case 'delegation_not_found':
      return 404
    case 'delegation_exists':
    case 'agent_inactive':
    case 'agent_identity_unminted':
      return 409
    default:
      return 403
  }
}

function disabled() {
  return fail(403, 'delegated_operators_disabled', 'Delegated operators are not enabled on this pot.')
}

const toolOperatorDelegate: ToolSpec = {
  name: 'operator_delegate',
  scope: 'the delegated scope (the caller must hold admin over it, as a human)',
  min: 'admin',
  args:
    '{ agent: string (id|slug), scope_type: "org"|"department"|"squad"|"project", scope_id?: string (omit for org), max_grant: "member"|"lead" }' +
    ' -- a HUMAN lets one agent organise structure inside one scope, capped at max_grant (never admin or owner).',
  inputSchema: {
    type: 'object',
    properties: {
      agent: STRING_SCHEMA,
      scope_type: { type: 'string', enum: ['org', 'department', 'squad', 'project'] },
      scope_id: STRING_SCHEMA,
      max_grant: { type: 'string', enum: ['member', 'lead'] },
    },
    required: ['agent', 'scope_type', 'max_grant'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const gate = await authorizeStructuralWrite(env, auth, 'manage_delegations', {})
    if (gate.kind === 'refused') return fail(gate.status, gate.error, gate.detail)
    if (!delegatedOperatorsEnabled(env)) return disabled()
    const agentRef = str(args.agent)
    if (!agentRef) return fail(400, 'invalid_args', 'agent required')
    const agent = await resolveAgentRef(env, agentRef)
    if (!agent.ok) {
      return agent.reason === 'ambiguous'
        ? fail(409, 'ambiguous_slug', 'slug matches multiple rows — use the id instead')
        : fail(404, 'agent_not_found')
    }
    const result = await createDelegation(env, auth, {
      agentId: agent.value.id,
      scopeType: args.scope_type,
      scopeId: args.scope_id,
      maxGrant: args.max_grant,
    })
    if (!result.ok) return fail(errorStatus(result.error), result.error)
    return done({ delegation: result.delegation })
  },
}

const toolOperatorRevoke: ToolSpec = {
  name: 'operator_revoke',
  scope: 'the delegated scope (the delegator, or a human with admin over it)',
  // 'authenticated', NOT 'admin' (W0.1): the dispatcher's admin floor would stop a delegator who has since been demoted
  // from withdrawing their own delegation, which must always work. The authority check is revokeDelegation's own: a HUMAN
  // (never an agent: the chokepoint above refuses every agent-bound caller first), and either the original delegator or
  // someone holding admin over the delegation's scope.
  min: 'authenticated',
  args: '{ delegation_id: string } -- takes effect on the agent\'s very next request.',
  inputSchema: {
    type: 'object',
    properties: { delegation_id: STRING_SCHEMA },
    required: ['delegation_id'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const gate = await authorizeStructuralWrite(env, auth, 'manage_delegations', {})
    if (gate.kind === 'refused') return fail(gate.status, gate.error, gate.detail)
    const id = str(args.delegation_id)
    if (!id) return fail(400, 'invalid_args', 'delegation_id required')
    const result = await revokeDelegation(env, auth, id.trim())
    if (!result.ok) return fail(errorStatus(result.error), result.error)
    return done({ delegation: result.delegation })
  },
}

const toolOperatorList: ToolSpec = {
  name: 'operator_list',
  scope: 'delegations the caller made or administers the scope of (a workspace admin sees all)',
  min: 'admin',
  args: '{ agent?: string (id|slug), include_revoked?: boolean }',
  inputSchema: {
    type: 'object',
    properties: { agent: STRING_SCHEMA, include_revoked: { type: 'boolean' } },
    required: [],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const gate = await authorizeStructuralWrite(env, auth, 'manage_delegations', {})
    if (gate.kind === 'refused') return fail(gate.status, gate.error, gate.detail)
    let agentId: string | undefined
    const agentRef = str(args.agent)
    if (agentRef) {
      const agent = await resolveAgentRef(env, agentRef)
      if (!agent.ok) return fail(404, 'agent_not_found')
      agentId = agent.value.id
    }
    const all = await listDelegations(env, { agentId, includeRevoked: args.include_revoked === true })
    // Visible to a workspace admin, or filtered to the delegations the caller made or administers the scope of: a plain
    // member must not be able to enumerate who may act for whom.
    const delegations = []
    for (const d of all) {
      if (hasWorkspaceAdmin(auth) || d.delegator_member_id === auth.memberId) {
        delegations.push(d)
        continue
      }
      const cap = capabilityScopeForDelegation(d.scope_type, d.scope_id)
      if ((await actorRankOnScopeFor(env, auth, cap.type, cap.id)) >= capabilityRank('admin')) delegations.push(d)
    }
    return done({ delegations, count: delegations.length })
  },
}

export const OPERATOR_TOOLS: ToolSpec[] = [toolOperatorDelegate, toolOperatorRevoke, toolOperatorList]
