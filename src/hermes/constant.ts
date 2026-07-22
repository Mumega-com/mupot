// mupot — Hermes-Sol constant agent (Port 3).
//
// Always-on chat front-door: Luna heartbeat triage → GPT-5.6 Sol reasoning →
// wake Opus (Kasra) for hard calls. Dispatches board tasks when Sol emits a
// TASK: trailer. This is the surface the dashboard /hermes panel and the
// Hermes daemon both call — the daemon stays the mouth/ears; the pot owns
// the governed act (createTask / agent.wake).
//
// Idempotent by construction for wakes/tasks within a single turn (one action
// max). Rank, never act-loop — same brain=ATC discipline as the concierge.

import type { BusEvent, Env, ModelMessage, ModelPort, Task } from '../types'
import { createBus } from '../bus'
import { createModel } from '../model'
import { createTask, type CreateTaskInput } from '../tasks/service'
import {
  classifyHermesTurn,
  HERMES_TIER_MODELS,
  parseSolAction,
  stripSolActionTrailer,
  type HermesRouteDecision,
} from './model-route'

/** Capability / identity markers for presence registration (hermes-worker). */
export const HERMES_ADAPTER = 'hermes'
export const HERMES_CAPABILITIES: readonly string[] = ['chat', 'dispatch', 'gate']

/** Default squad for tasks the constant agent mints when no project squad is known. */
export const HERMES_DEFAULT_SQUAD_ID = 'squad-core'

/** Default Opus (hard-call) agent slug — Kasra is the live prefrontal. */
export const HERMES_OPUS_AGENT_SLUG = 'kasra'

/** Gate owner stamped on Hermes-dispatched tasks (same as concierge / cursor-worker). */
export const HERMES_GATE_OWNER = 'gate:kasra-core'

export interface HermesChatInput {
  message: string
  /** Member who is chatting — attribution for bus events / task actor. */
  memberId: string
  /** Optional project scope for the turn (roster / future memory). */
  projectId: string | null
  /** Override squad for TASK: dispatches. */
  squadId: string | null
}

export interface HermesChatResult {
  reply: string
  route: HermesRouteDecision
  taskId: string | null
  wokeOpusAgentId: string | null
}

export interface HermesConstantDeps {
  chat?: ModelPort['chat']
  createTask?: (env: Env, input: CreateTaskInput) => Promise<Task>
  resolveOpusAgentId?: (env: Env) => Promise<string | null>
  wakeAgent?: (env: Env, agentId: string, reason: string, memberId: string) => Promise<void>
  now?: () => Date
}

async function defaultResolveOpusAgentId(env: Env): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT id FROM agents WHERE slug = ?1 AND status = 'active' LIMIT 1`,
  )
    .bind(HERMES_OPUS_AGENT_SLUG)
    .first<{ id: string }>()
  return row?.id ?? null
}

async function defaultWakeAgent(
  env: Env,
  agentId: string,
  reason: string,
  memberId: string,
): Promise<void> {
  const agent = await env.DB.prepare(
    `SELECT id, squad_id, status FROM agents WHERE id = ?1 LIMIT 1`,
  )
    .bind(agentId)
    .first<{ id: string; squad_id: string; status: string }>()
  if (!agent) throw new Error('opus_agent_not_found')
  if (agent.status !== 'active') throw new Error('opus_agent_paused')

  const event: BusEvent<{ by: string; reason: string; source: string }> = {
    type: 'agent.wake',
    tenant: env.TENANT_SLUG,
    squad_id: agent.squad_id,
    agent_id: agent.id,
    actor: { kind: 'member', id: memberId },
    payload: { by: memberId, reason, source: 'hermes.constant' },
    ts: new Date().toISOString(),
  }
  await createBus(env).emit(event)

  const stub = env.AGENT.get(env.AGENT.idFromName(agent.id))
  const res = await stub.fetch('https://agent/wake', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      agent_id: agent.id,
      reason,
      squad_id: agent.squad_id,
      context: reason,
    }),
  })
  if (!res.ok) throw new Error(`opus_wake_failed:${res.status}`)
}

function lunaReply(message: string): string {
  const lower = message.trim().toLowerCase()
  if (!lower) return 'Hermes here — send a message and I will triage it.'
  if (/^(status|help|\?)/i.test(lower)) {
    return (
      'Hermes-Sol constant agent. I triage cheaply (Luna), reason on Sol, ' +
      'and wake Kasra (Opus) for hard calls. Say what you need, or ask me to ' +
      'dispatch a task.'
    )
  }
  if (/^(hi|hello|hey|yo|ping|gm|gn|good\s+)/i.test(lower)) {
    return 'Here. Luna-idle; Sol on demand. What do you need?'
  }
  return 'Acknowledged.'
}

const SOL_SYSTEM = [
  'You are Hermes-Sol, the always-on front-door of this mupot.',
  'Answer helpfully and briefly. You may dispatch work or escalate hard calls.',
  'If the user needs a board task created, end your reply with exactly one line:',
  'TASK: <short title>',
  'If the user needs the Opus/Kasra decider woken for a hard call, end with:',
  'WAKE_OPUS: <short reason>',
  'Otherwise do not emit those trailers. Never invent secrets or claim a merge/deploy happened.',
].join(' ')

/**
 * handleHermesTurn — one chat turn through the constant agent.
 *
 * Luna path: no model spend.
 * Sol path: ModelPort(gpt-5.6-sol) + optional TASK:/WAKE_OPUS: action.
 * Opus path: wake Kasra immediately (hard-call pattern), no Sol spend.
 */
export async function handleHermesTurn(
  env: Env,
  input: HermesChatInput,
  deps: HermesConstantDeps = {},
): Promise<HermesChatResult> {
  const message = input.message.trim()
  const route = classifyHermesTurn(message)
  const chat = deps.chat ?? ((messages: ModelMessage[], opts) => createModel(env).chat(messages, opts))
  const create = deps.createTask ?? createTask
  const resolveOpus = deps.resolveOpusAgentId ?? defaultResolveOpusAgentId
  const wake = deps.wakeAgent ?? defaultWakeAgent
  const squadId = input.squadId?.trim() || HERMES_DEFAULT_SQUAD_ID

  if (route.tier === 'luna') {
    return {
      reply: lunaReply(message),
      route,
      taskId: null,
      wokeOpusAgentId: null,
    }
  }

  if (route.tier === 'opus') {
    const opusId = await resolveOpus(env)
    if (!opusId) {
      return {
        reply: 'Hard call detected, but no active Kasra (Opus) agent is registered to wake.',
        route,
        taskId: null,
        wokeOpusAgentId: null,
      }
    }
    await wake(env, opusId, `hermes hard-call: ${message.slice(0, 200)}`, input.memberId)
    return {
      reply: `Hard call — woke Kasra (Opus) for: ${route.reason}. I stay on Luna/Sol for the rest.`,
      route,
      taskId: null,
      wokeOpusAgentId: opusId,
    }
  }

  // Sol reasoning path.
  const raw = await chat(
    [
      { role: 'system', content: SOL_SYSTEM },
      { role: 'user', content: message },
    ],
    { model: HERMES_TIER_MODELS.sol, maxTokens: 1024 },
  )
  const action = parseSolAction(raw)
  const visible = stripSolActionTrailer(raw) || 'Done.'

  if (action.kind === 'wake_opus') {
    const opusId = await resolveOpus(env)
    if (!opusId) {
      return {
        reply: `${visible}\n\n(Could not wake Opus — no active Kasra agent.)`,
        route: { tier: 'sol', reason: 'sol_requested_wake_opus_missing', wakeOpus: true },
        taskId: null,
        wokeOpusAgentId: null,
      }
    }
    await wake(env, opusId, action.reason, input.memberId)
    return {
      reply: visible,
      route: { tier: 'sol', reason: 'sol_requested_wake_opus', wakeOpus: true },
      taskId: null,
      wokeOpusAgentId: opusId,
    }
  }

  if (action.kind === 'task') {
    const task = await create(env, {
      squad_id: squadId,
      project_id: input.projectId,
      title: action.title,
      body: `Dispatched by Hermes-Sol constant agent from chat.\n\nUser: ${message.slice(0, 500)}\n\n[hermes-dispatch]`,
      done_when: `Task completed: ${action.title}`,
      assignee_agent_id: null,
      gate_owner: HERMES_GATE_OWNER,
      status: 'open',
    })
    return {
      reply: `${visible}\n\nDispatched task ${task.id.slice(0, 8)}: ${action.title}`,
      route,
      taskId: task.id,
      wokeOpusAgentId: null,
    }
  }

  return {
    reply: visible,
    route,
    taskId: null,
    wokeOpusAgentId: null,
  }
}
