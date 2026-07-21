// mupot — MCP gate grant tools (SENSITIVE: org-admin delegates verdict authority).
//
// Twin of POST/DELETE /api/gates/grants. Shared write path: src/gates/grants.ts.
// Callers must hold org:admin (hasWorkspaceAdmin). Capability names must match
// `gate:<owner>` so arbitrary capability strings cannot be stuffed into gate_grants.

import type { AuthContext, Env } from '../types'
import {
  grantGateCapability,
  parseGateGrantArgs,
  revokeGateCapability,
} from '../gates/grants'
import { type ToolSpec, fail, done, hasWorkspaceAdmin } from './index'

const STRING_SCHEMA = { type: 'string' }

function requireOrgAdmin(auth: AuthContext) {
  if (!hasWorkspaceAdmin(auth)) return fail(403, 'forbidden', { need: 'org:admin' })
  return null
}

function grantedBy(auth: AuthContext): string | null {
  return auth.memberId ?? auth.userId ?? null
}

const toolGrantGateCapability: ToolSpec = {
  name: 'grant_gate_capability',
  scope: 'org (org-admin grants gate:<owner> verdict authority to a principal)',
  min: 'admin',
  args: '{ capability: string (gate:<owner>), principal_type: "member"|"agent", principal_id: string }',
  inputSchema: {
    type: 'object',
    properties: {
      capability: STRING_SCHEMA,
      principal_type: { type: 'string', enum: ['member', 'agent'] },
      principal_id: STRING_SCHEMA,
    },
    required: ['capability', 'principal_type', 'principal_id'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const denied = requireOrgAdmin(auth)
    if (denied) return denied
    const by = grantedBy(auth)
    if (!by) return fail(403, 'forbidden', { need: 'member_identity' })

    const parsed = parseGateGrantArgs({
      capability: args.capability,
      principal_type: args.principal_type,
      principal_id: args.principal_id,
    })
    if (!parsed.ok) {
      if (parsed.error === 'invalid_principal_type') {
        return fail(400, parsed.error, { accepted: ['member', 'agent'] })
      }
      return fail(400, parsed.error)
    }

    const grant = await grantGateCapability(env as Env, {
      capability: parsed.capability,
      principalType: parsed.principalType,
      principalId: parsed.principalId,
      grantedBy: by,
    })
    return done({ grant })
  },
}

const toolRevokeGateCapability: ToolSpec = {
  name: 'revoke_gate_capability',
  scope: 'org (org-admin revokes a gate:<owner> grant)',
  min: 'admin',
  args: '{ capability: string (gate:<owner>), principal_type: "member"|"agent", principal_id: string }',
  inputSchema: {
    type: 'object',
    properties: {
      capability: STRING_SCHEMA,
      principal_type: { type: 'string', enum: ['member', 'agent'] },
      principal_id: STRING_SCHEMA,
    },
    required: ['capability', 'principal_type', 'principal_id'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const denied = requireOrgAdmin(auth)
    if (denied) return denied

    const parsed = parseGateGrantArgs({
      capability: args.capability,
      principal_type: args.principal_type,
      principal_id: args.principal_id,
    })
    if (!parsed.ok) {
      if (parsed.error === 'invalid_principal_type') {
        return fail(400, parsed.error, { accepted: ['member', 'agent'] })
      }
      return fail(400, parsed.error)
    }

    await revokeGateCapability(env as Env, {
      capability: parsed.capability,
      principalType: parsed.principalType,
      principalId: parsed.principalId,
    })
    return done({ ok: true })
  },
}

export const GATE_GRANT_TOOLS: ToolSpec[] = [
  toolGrantGateCapability,
  toolRevokeGateCapability,
]
