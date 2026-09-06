// mupot — MCP tools for the per-agent Grok Bot webhook doorbell.
//
// Self for own agent; org-admin for others. Never accepts an identity from
// args as the actor. Never returns the bearer or ciphertext.
//
// Companion: src/agents/webhook-doorbell.ts, docs/plugins/grokbot-webhook-spine.md.

import type { AuthContext, Env } from '../types'
import { resolveAgentRef } from '../org/resolve'
import {
  clearAgentWebhookDoorbell,
  getAgentWebhookDoorbell,
  setAgentWebhookDoorbell,
} from '../agents/webhook-doorbell'
import { type ToolSpec, fail, done, str, hasWorkspaceAdmin } from './index'

const STRING_SCHEMA = { type: 'string' }
type ToolFailure = Extract<ReturnType<typeof fail>, { ok: false }>

async function resolveDoorbellTarget(
  auth: AuthContext,
  env: Env,
  agentArg: unknown,
): Promise<{ ok: true; agentId: string } | ToolFailure> {
  const requested = str(agentArg)
  const targetRef = requested ?? auth.boundAgentId
  if (!targetRef) {
    return fail(400, 'invalid_args', 'agent required when caller is not agent-bound') as ToolFailure
  }

  const resolved = await resolveAgentRef(env, targetRef)
  if (!resolved.ok) {
    return (resolved.reason === 'ambiguous'
      ? fail(409, 'ambiguous_slug', 'slug matches multiple agents — use the id instead')
      : fail(404, 'agent_not_found')) as ToolFailure
  }

  const self = auth.boundAgentId === resolved.value.id
  if (!self && !hasWorkspaceAdmin(auth)) {
    return fail(403, 'forbidden', { need: 'self_or_org_admin' }) as ToolFailure
  }
  return { ok: true, agentId: resolved.value.id }
}

const toolSetAgentWebhookDoorbell: ToolSpec = {
  name: 'set_agent_webhook_doorbell',
  scope: 'self (own agent) or org-admin (any agent) — register or clear an outbound inbox-wake webhook',
  min: 'authenticated',
  args: '{ agent?: string, webhook_url?: string, bearer?: string, clear?: boolean }',
  inputSchema: {
    type: 'object',
    properties: {
      agent: STRING_SCHEMA,
      webhook_url: STRING_SCHEMA,
      bearer: STRING_SCHEMA,
      clear: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const actor = auth.memberId ?? auth.userId
    if (!actor) return fail(403, 'unauthenticated')

    const target = await resolveDoorbellTarget(auth, env, args.agent)
    if (!target.ok) return target

    if (args.clear === true) {
      await clearAgentWebhookDoorbell(env, target.agentId)
      return done({ configured: false, agent_id: target.agentId })
    }

    const webhookUrl = str(args.webhook_url)
    const bearer = typeof args.bearer === 'string' ? args.bearer : ''
    if (!webhookUrl) return fail(400, 'invalid_args', 'webhook_url required unless clear is true')
    if (!bearer.trim()) return fail(400, 'invalid_args', 'bearer required unless clear is true')

    const result = await setAgentWebhookDoorbell(env, {
      agentId: target.agentId,
      webhookUrl,
      bearer,
      createdByMemberId: actor,
    })
    if (!result.ok) {
      if (result.error === 'doorbell_crypto_unavailable') {
        return fail(503, result.error, 'CONNECTOR_MASTER_KEY Worker secret is required to store a doorbell bearer')
      }
      if (result.error === 'no_tenant') return fail(500, result.error)
      return fail(400, result.error, result.detail)
    }
    return done(result.doorbell)
  },
}

const toolGetAgentWebhookDoorbell: ToolSpec = {
  name: 'get_agent_webhook_doorbell',
  scope: 'self (own agent) or org-admin (any agent) — read doorbell URL + last4, never the bearer',
  min: 'authenticated',
  args: '{ agent?: string }',
  inputSchema: {
    type: 'object',
    properties: { agent: STRING_SCHEMA },
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const target = await resolveDoorbellTarget(auth, env, args.agent)
    if (!target.ok) return target

    const doorbell = await getAgentWebhookDoorbell(env, target.agentId)
    if (!doorbell) return done({ configured: false, agent_id: target.agentId })
    return done(doorbell)
  },
}

export const WEBHOOK_DOORBELL_TOOLS: ToolSpec[] = [
  toolSetAgentWebhookDoorbell,
  toolGetAgentWebhookDoorbell,
]
