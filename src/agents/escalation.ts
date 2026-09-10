// mupot — escalation emit: the observer's escalate signal → one operator-facing task.
//
// EXTRACTED FROM AgentDO SO THAT IT CAN BE TESTED AT ALL.
//
// agent-do.ts imports DurableObject from 'cloudflare:workers', a module only the
// Workers runtime provides — scheme-prefixed bare specifiers are resolved upstream
// of Vite and cannot be aliased (proven in vitest.composition.config.ts). So no test
// under the default Node pool can import agent-do.ts, and the workerd pool cannot
// drive a real wake() without a model call. That is why this path carried ZERO tests
// while two TODOs claimed it was unimplemented — see task 00fe8477 and PR #1381.
//
// Keeping the emit here, in a module with no runtime-only imports, is what makes
// tests/agent-escalation-emit.test.ts possible.

import type { Env, Agent } from '../types'
import { createTask } from '../tasks/service'
import { GATE_ESCALATION } from '../gates/lanes'

/**
 * The done_when carried by an escalation task.
 *
 * This exact string must remain a registered placeholder sentinel in
 * src/tasks/service.ts — but NOT for the reason it looks like. createTask is
 * called below with allowDeferredPredicate, and that flag skips BOTH the
 * sentinel rejection and the minimum-length floor, so any non-empty string
 * would be accepted here. The sentinel is not what lets the emit through.
 *
 * What the registration actually buys is the exit: assertCompletableDoneWhen
 * refuses to mark a task done while its done_when is a sentinel. So an
 * escalation cannot be closed until a human replaces the placeholder with a
 * real predicate — which is precisely the behaviour wanted for a task that
 * exists because nothing automatic could resolve the situation.
 *
 * tests/agent-escalation-emit.test.ts pins that property.
 */
export const ESCALATION_DONE_WHEN = '(operator resolves — set via task update)'

export interface EscalationEmitResult {
  /** True when the operator-facing task was created. */
  emitted: boolean
  /** Present only when emitted is false. */
  error?: string
}

/** The exact task payload an escalation creates, and the options it creates it under. */
export interface EscalationTaskPlan {
  input: {
    squad_id: string
    title: string
    body: string
    done_when: string
    gate_owner: string
  }
  options: {
    actor: { kind: 'agent'; id: string }
    allowDeferredPredicate: true
  }
}

/**
 * Build the escalation payload without writing anything.
 *
 * Split out from the emit so a test can assert the payload FIELD BY FIELD
 * rather than by round-tripping it through D1 and checking the columns it
 * happens to SELECT. An adversarial gate on PR #1381 mutated the emitted
 * done_when off ESCALATION_DONE_WHEN and all six tests stayed green, because
 * they pinned properties of the CONSTANT while the row was free to stop using
 * it. Asserting the built plan closes that class: every field the emit depends
 * on is named in one place that a test can read.
 *
 * Note what is deliberately ABSENT from options: `skipMirror`. createTask
 * mirrors a task to a GitHub issue unless that flag is set, and for an
 * escalation the issue is the delivery path that actually reaches a person
 * (see the emit's doc below). Adding skipMirror here would silence escalations
 * on any tenant with GITHUB_REPO configured.
 */
export function buildEscalationTaskPlan(
  agent: Agent,
  reason: string | null,
  cycle: number,
): EscalationTaskPlan {
  return {
    input: {
      squad_id: agent.squad_id,
      title: `ESCALATION: agent ${agent.slug} stuck`,
      body: `Agent ${agent.slug} (${agent.id}) crossed the stuck threshold.\nReason: ${reason ?? 'unknown'}\nCycle: ${cycle}`,
      done_when: ESCALATION_DONE_WHEN,
      gate_owner: GATE_ESCALATION,
    },
    options: {
      actor: { kind: 'agent', id: agent.id },
      allowDeferredPredicate: true,
    },
  }
}

/**
 * Emit one operator-facing task for a stuck agent.
 *
 * Never throws: a failed emit must not kill the goal cycle, so the caller gets a
 * result to record and the next tick re-emits after the observer's cooldown.
 *
 * DELIVERY, measured 2026-09-10: the gate_owner tag drives no wake. The gate-owner
 * wake fires only on a transition INTO status 'review' and createTask never calls
 * it, so a task created 'open' never attempts one — independently of the fact that
 * GATE_ESCALATION currently has zero grant holders. needs_you_list and the approvals
 * queue also both filter to 'review'.
 *
 * What reaches a person is the GitHub issue mirror — and that is CONDITIONAL:
 * mirrorTaskCreate is inert unless GITHUB_REPO and an outbound token are
 * configured. On a tenant without them the only surface left is the squad task
 * list, which is a pull surface nobody is obliged to open. See mupot#1382 for the
 * re-fire amplification that rides on the mirror when it IS configured.
 */
export async function emitEscalation(
  env: Env,
  agent: Agent,
  reason: string | null,
  cycle: number,
): Promise<EscalationEmitResult> {
  const plan = buildEscalationTaskPlan(agent, reason, cycle)
  try {
    await createTask(env, plan.input, plan.options)
    return { emitted: true }
  } catch (emitErr) {
    return { emitted: false, error: emitErr instanceof Error ? emitErr.message : 'err' }
  }
}
