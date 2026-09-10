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
 * queue also both filter to 'review'. What DOES reach a human is the GitHub issue
 * mirror (createTask mirrors unless skipMirror is set, and it is not set here) and
 * the squad task list. See mupot#1382 for the re-fire amplification that follows.
 */
export async function emitEscalation(
  env: Env,
  agent: Agent,
  reason: string | null,
  cycle: number,
): Promise<EscalationEmitResult> {
  try {
    await createTask(
      env,
      {
        squad_id: agent.squad_id,
        title: `ESCALATION: agent ${agent.slug} stuck`,
        body: `Agent ${agent.slug} (${agent.id}) crossed the stuck threshold.\nReason: ${reason ?? 'unknown'}\nCycle: ${cycle}`,
        done_when: ESCALATION_DONE_WHEN,
        gate_owner: GATE_ESCALATION,
      },
      { actor: { kind: 'agent', id: agent.id }, allowDeferredPredicate: true },
    )
    return { emitted: true }
  } catch (emitErr) {
    return { emitted: false, error: emitErr instanceof Error ? emitErr.message : 'err' }
  }
}
