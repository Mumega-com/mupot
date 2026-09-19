// agent_lifecycle — PILOT composite router for one tool family only.
//
// Wraps move_agent_squad / grant_agent_capability / deactivate_agent /
// mint_agent_token. Explicit `action` skips Jev and calls that tool's own
// run() unchanged. Free-text `intent` is classified by TypeSafe Jev and
// declined (not executed) when confidence is low. This file adds no
// authorization of its own — it is a router, not a gate.
//
// Do not generalize this pattern to other families in this change.

import type { AuthContext, Env } from '../types'
import {
  toolDeactivateAgent,
  toolGrantAgentCapability,
  toolMintAgentToken,
  toolMoveAgentSquad,
} from './provision'
import { done, fail, str, type ToolCtx, type ToolOutcome, type ToolSpec } from './index'

export const LIFECYCLE_ACTIONS = ['move_squad', 'grant_capability', 'deactivate', 'mint_token'] as const
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number]

export const LIFECYCLE_ACTION_TOOLS: Record<LifecycleAction, string> = {
  move_squad: 'move_agent_squad',
  grant_capability: 'grant_agent_capability',
  deactivate: 'deactivate_agent',
  mint_token: 'mint_agent_token',
}

export const LIFECYCLE_ACTION_PURPOSE: Record<LifecycleAction, string> = {
  move_squad: 'Move the agent to a different home squad (admin on current and destination).',
  grant_capability: 'Grant a squad capability to the agent without changing its home squad.',
  deactivate: 'Retire the agent: revoke live tokens and drop fleet presence.',
  mint_token: 'Mint an agent-bound bearer token (returned as a one-time claim).',
}

// Starting thresholds from task 73330fda, not a labeled-set tune.
// 0.6 top mass = majority-ish belief on a 4-way choice; 0.2 margin rejects
// near-ties between two lifecycle verbs (the actual failure mode in
// agents/kasra/docs/jev-mupot-model-ergonomics-case-20260919.md). Conservative
// on purpose: a confident-but-wrong route is worse than listing the four tools.
export const JEV_MIN_TOP_PROBABILITY = 0.6
export const JEV_MIN_MARGIN = 0.2

export const JEV_SYSTEMONE_URL = 'https://api.typesafe.ai/v1/systemone'
export const JEV_MODEL = 'jev-latest'

const LIFECYCLE_ACTION_SET = new Set<string>(LIFECYCLE_ACTIONS)

export function isLifecycleAction(value: unknown): value is LifecycleAction {
  return typeof value === 'string' && LIFECYCLE_ACTION_SET.has(value)
}

export type LifecycleDelegates = Record<LifecycleAction, ToolSpec>

export const DEFAULT_LIFECYCLE_DELEGATES: LifecycleDelegates = {
  move_squad: toolMoveAgentSquad,
  grant_capability: toolGrantAgentCapability,
  deactivate: toolDeactivateAgent,
  mint_token: toolMintAgentToken,
}

export interface JevChoiceAnswer {
  choice: string
  probabilities: Record<string, number>
  confidence?: number
  model?: string
}

export type ConfidenceGateResult =
  | {
      ok: true
      action: LifecycleAction
      topProbability: number
      margin: number
      confidence: number | null
    }
  | {
      ok: false
      reason: 'low_confidence' | 'unknown_action'
      top?: string
      topProbability: number
      margin: number
      confidence: number | null
    }

export function applyLifecycleConfidenceGate(answer: JevChoiceAnswer): ConfidenceGateResult {
  const ranked = Object.entries(answer.probabilities ?? {}).sort((a, b) => b[1] - a[1])
  const topProbability = ranked[0]?.[1] ?? 0
  const secondProbability = ranked[1]?.[1] ?? 0
  const margin = topProbability - secondProbability
  const confidence = typeof answer.confidence === 'number' ? answer.confidence : null

  if (!isLifecycleAction(answer.choice)) {
    return {
      ok: false,
      reason: 'unknown_action',
      top: answer.choice,
      topProbability,
      margin,
      confidence,
    }
  }

  // Gate on the probability mass + margin the task named. TypeSafe's derived
  // `confidence` is peakedness of the same distribution — recorded for the
  // caller, not used as a third bar (that would double-count).
  if (topProbability < JEV_MIN_TOP_PROBABILITY || margin < JEV_MIN_MARGIN) {
    return {
      ok: false,
      reason: 'low_confidence',
      top: answer.choice,
      topProbability,
      margin,
      confidence,
    }
  }

  return {
    ok: true,
    action: answer.choice,
    topProbability,
    margin,
    confidence,
  }
}

export class ClassifierUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClassifierUnavailableError'
  }
}

export type LifecycleClassifier = (env: Env, intent: string, agent: string) => Promise<JevChoiceAnswer>

const JEV_CRITERIA: Record<LifecycleAction, string> = {
  move_squad:
    'Change the agent\'s home squad — move, relocate, transfer, or re-home to another squad.',
  grant_capability:
    'Grant or raise a capability/access rank on a squad without changing the agent\'s home squad.',
  deactivate:
    'Retire, deactivate, disable, or turn off the agent and revoke its live credentials.',
  mint_token:
    'Mint, issue, or rotate an agent-bound bearer token or credential. Not a squad move.',
}

export async function classifyLifecycleIntentWithJev(
  env: Env,
  intent: string,
  agent: string,
): Promise<JevChoiceAnswer> {
  const key = typeof env.TYPESAFE_API_KEY === 'string' ? env.TYPESAFE_API_KEY.trim() : ''
  if (!key) throw new ClassifierUnavailableError('TYPESAFE_API_KEY unset')

  const response = await fetch(JEV_SYSTEMONE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: JEV_MODEL,
      state: { intent, agent },
      questions: {
        action: {
          type: 'choice',
          instructions:
            'Which single agent-lifecycle action does this intent ask for? Pick only if the intent clearly names one action. Do not guess between two.',
          criteria: JEV_CRITERIA,
        },
      },
    }),
  })

  if (!response.ok) {
    throw new ClassifierUnavailableError(`typesafe http ${response.status}`)
  }

  const body = (await response.json()) as {
    model?: string
    answers?: {
      action?: {
        choice?: unknown
        probabilities?: unknown
        confidence?: unknown
      }
    }
  }
  const answer = body.answers?.action
  if (!answer || typeof answer.choice !== 'string' || !answer.probabilities || typeof answer.probabilities !== 'object') {
    throw new ClassifierUnavailableError('typesafe response missing choice answer')
  }

  const probabilities: Record<string, number> = {}
  for (const [name, value] of Object.entries(answer.probabilities as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value)) probabilities[name] = value
  }

  return {
    choice: answer.choice,
    probabilities,
    confidence: typeof answer.confidence === 'number' ? answer.confidence : undefined,
    model: typeof body.model === 'string' ? body.model : undefined,
  }
}

function toolCatalog() {
  return LIFECYCLE_ACTIONS.map((action) => ({
    action,
    name: LIFECYCLE_ACTION_TOOLS[action],
    purpose: LIFECYCLE_ACTION_PURPOSE[action],
  }))
}

function ambiguousResult(
  reason: string,
  classification?: {
    choice?: string
    topProbability?: number
    margin?: number
    confidence?: number | null
    model?: string
  },
): ToolOutcome {
  return done({
    status: 'ambiguous',
    reason,
    tools: toolCatalog(),
    hint: 'Call the specific tool directly, or retry agent_lifecycle with an explicit action.',
    ...(classification ? { classification } : {}),
  })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateDelegateArgs(schema: ToolSpec['inputSchema'], args: Record<string, unknown>): string | null {
  for (const req of schema.required ?? []) {
    if (args[req] === undefined || args[req] === null) return `missing required field: ${req}`
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) {
        return `unknown field: ${key}`
      }
    }
  }
  return null
}

export interface AgentLifecycleDeps {
  classify?: LifecycleClassifier
  delegates?: LifecycleDelegates
}

export async function runAgentLifecycle(
  auth: AuthContext,
  env: Env,
  args: Record<string, unknown>,
  ctx: ToolCtx,
  deps: AgentLifecycleDeps = {},
): Promise<ToolOutcome> {
  const agent = str(args.agent)
  if (!agent) return fail(400, 'invalid_args', 'agent required')

  const actionArg = args.action === undefined || args.action === null ? null : str(args.action)
  if (args.action !== undefined && args.action !== null && !isLifecycleAction(actionArg)) {
    return fail(400, 'invalid_args', `action must be one of: ${LIFECYCLE_ACTIONS.join(', ')}`)
  }

  const intent = str(args.intent)
  if (args.params !== undefined && args.params !== null && !isPlainObject(args.params)) {
    return fail(400, 'invalid_args', 'params must be an object')
  }
  const params = isPlainObject(args.params) ? args.params : {}

  let action: LifecycleAction
  if (isLifecycleAction(actionArg)) {
    // Explicit action wins. Intent is ignored for routing — not logged.
    action = actionArg
  } else if (intent) {
    const classify = deps.classify ?? classifyLifecycleIntentWithJev
    let answer: JevChoiceAnswer
    try {
      answer = await classify(env, intent, agent)
    } catch (err) {
      const detail = err instanceof ClassifierUnavailableError ? err.message : 'classifier failed'
      return fail(503, 'classifier_unavailable', {
        detail,
        tools: toolCatalog(),
        hint: 'Retry with an explicit action, or call the specific tool directly.',
      })
    }
    const gated = applyLifecycleConfidenceGate(answer)
    if (!gated.ok) {
      return ambiguousResult(gated.reason, {
        choice: gated.top,
        topProbability: gated.topProbability,
        margin: gated.margin,
        confidence: gated.confidence,
        model: answer.model,
      })
    }
    action = gated.action
  } else {
    return fail(400, 'invalid_args', 'action or intent required')
  }

  const delegates = deps.delegates ?? DEFAULT_LIFECYCLE_DELEGATES
  const spec = delegates[action]
  const delegatedArgs = { ...params, agent }
  const schemaError = validateDelegateArgs(spec.inputSchema, delegatedArgs)
  if (schemaError) return fail(400, 'invalid_args', schemaError)

  return spec.run(auth, env, delegatedArgs, ctx)
}

export const toolAgentLifecycle: ToolSpec = {
  name: 'agent_lifecycle',
  scope: "agent's squad (delegates; each underlying tool re-enforces its own admin bar)",
  // All four wrapped tools declare min: 'admin'. The composite matches that
  // shared floor — the loosest and the tightest of the family are the same.
  // Lowering it to 'authenticated' would let a member spend a Jev call just
  // to be refused by the delegate; it would not add power. Raising it would
  // be new authz. Each delegate's run() is the real gate.
  min: 'admin',
  args:
    '{ agent: string (id|slug), action?: "move_squad"|"grant_capability"|"deactivate"|"mint_token", intent?: string, params?: object }' +
    ' -- explicit action skips Jev and calls that tool\'s run() unchanged;' +
    ' free-text intent is classified by Jev and declined on low confidence.' +
    ' PILOT: this family only. The four flat tools stay.',
  inputSchema: {
    type: 'object',
    properties: {
      agent: { type: 'string' },
      action: { type: 'string', enum: [...LIFECYCLE_ACTIONS] },
      intent: { type: 'string' },
      params: { type: 'object' },
    },
    required: ['agent'],
    additionalProperties: false,
  },
  run(auth, env, args, ctx) {
    return runAgentLifecycle(auth, env, args, ctx)
  },
}
