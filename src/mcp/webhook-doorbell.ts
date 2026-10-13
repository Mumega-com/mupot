// mupot — MCP tools for the per-agent Grok Bot webhook doorbell.
//
// Self for own agent; org-admin for others. Never accepts an identity from
// args as the actor. Never returns the bearer or ciphertext.
//
// Companion: src/agents/webhook-doorbell.ts, docs/plugins/grokbot-webhook-spine.md.

import type { AuthContext, Env } from '../types'
import { resolveAgentRef } from '../org/resolve'
import { authorizeStructuralWrite } from '../operators/chokepoint'
import {
  clearAgentWebhookDoorbell,
  getAgentWebhookDoorbell,
  setAgentWebhookDoorbell,
} from '../agents/webhook-doorbell'
import { type ToolSpec, fail, done, str, memberCanOnSquadAuth } from './index'

const STRING_SCHEMA = { type: 'string' }
type ToolFailure = Extract<ReturnType<typeof fail>, { ok: false }>

/**
 * Who may touch an agent's doorbell (set / clear / get):
 *   - the AGENT ITSELF (agent-bound caller whose resolved target is its own row), or
 *   - a NON-agent-bound member holding admin on the target agent's SQUAD (org admin covers every squad).
 * An agent-bound caller aiming at ANOTHER agent is refused through the W0 chokepoint
 * (src/operators/chokepoint.ts, action set_agent_webhook_doorbell: not delegable, refuse lane), so the
 * answer is the same one every other structural tool gives, never a second rule here. A doorbell redirects an
 * agent's wake signal to an external URL, which is why a delegation can never buy it.
 * `gate` is passed for writes (set/clear) and asks the chokepoint from inside the tool's own block; a read by a non-self agent is a plain 403 (gate null).
 */
async function resolveDoorbellTarget(
  auth: AuthContext,
  env: Env,
  agentArg: unknown,
  gate: ((agent: { id: string; squad_id: string }) => ReturnType<typeof authorizeStructuralWrite>) | null,
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

  if (auth.boundAgentId) {
    if (auth.boundAgentId === resolved.value.id) return { ok: true, agentId: resolved.value.id }
    if (gate) {
      const verdict = await gate(resolved.value)
      if (verdict.kind === 'refused') return fail(verdict.status, verdict.error, verdict.detail) as ToolFailure
    }
    return fail(403, 'forbidden', { need: 'self_or_squad_admin' }) as ToolFailure
  }

  if (!(await memberCanOnSquadAuth(env, auth, resolved.value.squad_id, 'admin'))) {
    return fail(403, 'forbidden', { need: 'self_or_squad_admin' }) as ToolFailure
  }
  return { ok: true, agentId: resolved.value.id }
}

const toolSetAgentWebhookDoorbell: ToolSpec = {
  name: 'set_agent_webhook_doorbell',
  scope: "self (own agent) or admin of the agent's squad — register or clear an outbound wake webhook (flag WEBHOOK_DOORBELL)",
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

    // A human registers a doorbell on the dashboard (fresh session, key typed into a form), never through a bearer
    // token: a token has no re-auth freshness. Clearing only removes authority, so a human may still clear here.
    if (args.clear !== true && !auth.boundAgentId) {
      return fail(403, 'dashboard_only', 'a person registers a doorbell on the dashboard (/doorbells); an agent may set its own')
    }

    const target = await resolveDoorbellTarget(auth, env, args.agent, (agent) =>
      authorizeStructuralWrite(env, auth, 'set_agent_webhook_doorbell', { agentId: agent.id, squadId: agent.squad_id }),
    )
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
      if (result.error === 'webhook_doorbell_disabled') return fail(403, result.error, 'set WEBHOOK_DOORBELL=1 to enable')
      if (result.error === 'no_tenant') return fail(500, result.error)
      return fail(400, result.error, result.detail)
    }
    return done(result.doorbell)
  },
}

const toolGetAgentWebhookDoorbell: ToolSpec = {
  name: 'get_agent_webhook_doorbell',
  scope: "self (own agent) or admin of the agent's squad — read doorbell URL + last4, never the bearer",
  min: 'authenticated',
  args: '{ agent?: string }',
  inputSchema: {
    type: 'object',
    properties: { agent: STRING_SCHEMA },
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const target = await resolveDoorbellTarget(auth, env, args.agent, null)
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
