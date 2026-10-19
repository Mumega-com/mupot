// src/harness/kernel.ts — the provider kernel: ONE place that holds the policy for every vendor-hosted agent run.
//
// An adapter (harness/types.ts ProviderAdapter) is a thin vendor client. It never checks a budget, never mints a token and never
// decides who may dispatch. Every dispatch passes this pipeline instead:
//
//   1. kill switch     HARNESS_DISPATCH_DISABLED=1 (global) or org_settings `provider_disabled:<kind>` (per provider). Fails CLOSED.
//   2. budget          checkAndReserve BEFORE anything is launched or reserved (the dispatch count, the token cap and the dollar cap
//                      of agents/meter.ts). A refusal creates nothing and raises ONE decision card for the human (raise / stop):
//                      a cap hit is never a silent kill.
//   3. reservation     harness_reservations (mig 0206): the INSERT is the idempotency lock; the adapter's launch does it.
//   4. run token       only for an adapter with callback 'mcp_token': a member-tier mupot credential minted for THIS run, short TTL,
//                      handed to launch through ctx.runToken, revoked at finalize (or at once if launch is refused).
//   5. reconcile       reconcileProviderRuns: scheduled, closes terminal and stale runs (the missing caller of listReconcileBatch).
//   6. finalize        ONE idempotent settlement: book usage via recordTokens (vendor usage, or the pre-call ESTIMATE marked
//                      estimate=true), set the flight cost, revoke the token, run adapter.cleanup. Usage is never the model's
//                      self-report.
//
// A replay of an already-reserved idempotency key skips steps 1-2's SPEND (it is not a new run) but still honours the kill switch.
// RECONCILE NEVER LAUNCHES: it observes an attached run and closes a stuck or stale one. Only dispatchViaKernel (and kernelLaunchCursor, the
// Studio door) may put a request on the wire to a vendor, and both pass the kill switch and the budget gate first.
// The dollar cap is RESERVED at admission (the adapter's estimate is added to the agent's window cost) and ADJUSTED at finalize (actual
// minus estimate), so N in-flight runs cannot together exceed budget_cap_cents; a run that never launched refunds its whole slot.

import type { Agent, Env } from '../types'
import { buildAuthorizedExecution, checkAndReserve, meterWindowKeyAt, recordTokens, remainingCostMicroUsd } from '../agents/meter'
import { createTask } from '../tasks/service'
import type { FlightSignals } from '../flight/preflight'
import { mintRawToken, revokeMemberToken, sha256Hex } from '../members/service'
import { launchCursorAgent, type CursorLaunchOutcome } from '../cursor/client'
import {
  blockTaskForFailedReservation,
  getReservation,
  getReservationByIdempotency,
  LAUNCH_LEASE_EXPIRED_ERROR,
  listReconcileBatch,
  markReconciled,
  RESERVATION_STUCK_MS,
  type HarnessReservationRow,
} from './reservations'
import { getHarnessAdapter } from './registry'
import { isProviderAdapter } from './types'
import type { DispatchOutcome, DispatchRequest, HarnessContext, HarnessKind, ProviderAdapter } from './types'

export const RUN_TOKEN_MAX_TTL_MINUTES = 120
export const DEFAULT_RUN_MAX_AGE_HOURS = 24
export const DEFAULT_CURSOR_RUN_ESTIMATE_CENTS = 50
const MICRO_USD_PER_CENT = 10_000

// ── 1. kill switch ───────────────────────────────────────────────────────────────────────────────────────────

/** True when dispatch to this provider is switched off. A read failure counts as OFF: an outage must not open an unmetered door. */
export async function isProviderDisabled(env: Env, kind: HarnessKind): Promise<boolean> {
  if (env.HARNESS_DISPATCH_DISABLED === '1') return true
  try {
    const row = await env.DB.prepare(`SELECT value FROM org_settings WHERE key = ?1 LIMIT 1`)
      .bind(`provider_disabled:${kind}`)
      .first<{ value: string }>()
    return row?.value === '1'
  } catch {
    return true
  }
}

// ── 2. budget ────────────────────────────────────────────────────────────────────────────────────────────────

interface KernelAgent extends Pick<Agent, 'id' | 'squad_id' | 'slug' | 'name' | 'status' | 'budget_cap_cents' | 'budget_window'> {
  owner_member_id: string | null
}

async function loadKernelAgent(env: Env, agentId: string): Promise<KernelAgent | null> {
  return env.DB.prepare(
    `SELECT id, squad_id, slug, name, status, budget_cap_cents, budget_window, owner_member_id FROM agents WHERE id = ?1 LIMIT 1`,
  ).bind(agentId).first<KernelAgent>()
}

/**
 * Real flight-preflight budget signals from the agent's own cap and spend (replaces the hardcoded 1,000,000 / 10,000 constants
 * cursor/dispatch.ts used to pass, which made the budget check always pass). No cap = effectively unlimited in dollars.
 */
export async function kernelFlightSignals(env: Env, agentId: string, estimateMicroUsd: number): Promise<FlightSignals> {
  const agent = await loadKernelAgent(env, agentId)
  const remaining = agent ? (await remainingCostMicroUsd(env, agent)).remainingMicroUsd : null
  return {
    contextComplete: true,
    toolsReachable: true,
    budgetRemainingMicroUsd: remaining === null ? Number.MAX_SAFE_INTEGER : remaining,
    budgetEstimateMicroUsd: estimateMicroUsd,
    recentProgress: 0.8,
    progressPerStep: 0.6,
    wastePerStep: 0.1,
    stepSeconds: 60,
  }
}

const CARD_TITLE_PREFIX = 'Budget cap reached:'

/**
 * A cap hit raises ONE open card for the human (deduped per agent): raise the cap or stop. Best effort, never throws: the refusal
 * stands whether or not the card could be written. It is assigned to the agent's owner when there is one, else it sits on the squad board.
 */
async function raiseBudgetDecisionCard(env: Env, agent: KernelAgent, reason: string, provider: HarnessKind, estimateMicroUsd: number): Promise<string | null> {
  try {
    const title = `${CARD_TITLE_PREFIX} ${agent.slug} cannot start ${provider} runs. Raise it or stop?`
    const open = await env.DB.prepare(
      `SELECT id FROM tasks WHERE squad_id = ?1 AND title = ?2 AND status NOT IN ('done','approved','rejected') LIMIT 1`,
    ).bind(agent.squad_id, title).first<{ id: string }>()
    if (open) return open.id
    const task = await createTask(env, {
      squad_id: agent.squad_id,
      title,
      body: [
        `A ${provider} dispatch for agent ${agent.slug} was refused before anything launched (reason: ${reason}).`,
        `The next run was estimated at ${(estimateMicroUsd / 1_000_000).toFixed(2)} USD.`,
        'RAISE: increase the agent budget cap (budget_cap_cents) or the day caps, then dispatch again.',
        'STOP: leave it; nothing runs until the window resets or a human raises the cap.',
      ].join('\n'),
      done_when: 'A human chose raise (the cap was increased) or stop (nothing to do), and said so on this card',
      priority: 'P2',
      ...(agent.owner_member_id ? { assignee_member_id: agent.owner_member_id } : {}),
    }, { actor: { kind: 'agent', id: agent.id }, skipMirror: true })
    return task.id
  } catch (error) {
    console.error('[provider-kernel] budget card failed', error instanceof Error ? error.message : String(error))
    return null
  }
}

// ── 4. run token ─────────────────────────────────────────────────────────────────────────────────────────────

/** Mint a per-run mupot credential for the dispatching agent: its own welded member, a workspace token that expires on its own. */
async function mintRunToken(env: Env, agentId: string): Promise<{ raw: string; id: string; memberId: string } | null> {
  const binding = await env.DB.prepare(
    `SELECT b.member_id AS member_id FROM agent_member_bindings b
       JOIN agents a ON a.id = b.agent_id AND a.status = 'active'
      WHERE b.tenant = ?1 AND b.agent_id = ?2 LIMIT 1`,
  ).bind(env.TENANT_SLUG, agentId).first<{ member_id: string }>()
  if (!binding) return null
  // Member tier, explicitly: a run token carries whatever its member's capability rows grant at auth time, so a member holding lead / admin /
  // owner anywhere gets NO run token (the dispatch is refused) rather than a credential stronger than the agent's own member tier.
  const above = await env.DB.prepare(
    `SELECT 1 AS x FROM capabilities WHERE member_id = ?1 AND capability IN ('lead','admin','owner') AND (expires_at IS NULL OR expires_at > ?2) LIMIT 1`,
  ).bind(binding.member_id, new Date().toISOString()).first<{ x: number }>()
  if (above) return null
  const ttl = Math.min(Math.max(Number(env.HARNESS_RUN_TOKEN_TTL_MINUTES) || RUN_TOKEN_MAX_TTL_MINUTES, 1), RUN_TOKEN_MAX_TTL_MINUTES)
  const raw = mintRawToken()
  const id = crypto.randomUUID()
  const res = await env.DB.prepare(
    `INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant, expires_at)
     SELECT ?1, ?2, ?3, ?4, 'workspace', ?5, ?6, ?7, ?8 WHERE EXISTS (SELECT 1 FROM agents WHERE id = ?6 AND status = 'active')`,
  ).bind(id, binding.member_id, await sha256Hex(raw), `run:${id.slice(0, 8)}`, new Date().toISOString(), agentId, env.TENANT_SLUG,
    new Date(Date.now() + ttl * 60_000).toISOString()).run()
  if ((res.meta?.changes ?? 0) !== 1) return null
  return { raw, id, memberId: binding.member_id }
}

async function recordRunToken(env: Env, reservationId: string, token: { id: string; memberId: string }): Promise<void> {
  await env.DB.prepare(`UPDATE harness_reservations SET run_token_id = ?3, run_token_member_id = ?4 WHERE tenant = ?1 AND id = ?2`)
    .bind(env.TENANT_SLUG, reservationId, token.id, token.memberId).run()
}

async function revokeRunToken(env: Env, row: Pick<HarnessReservationRow, 'run_token_id' | 'run_token_member_id'>): Promise<void> {
  if (!row.run_token_id || !row.run_token_member_id) return
  await revokeMemberToken(env, row.run_token_member_id, row.run_token_id)
}

// ── the meter slot: reserved at admission, settled at finalize ──────────────────────────────────────────────

/** Add `deltaMicroUsd` (may be negative) to the cost of the window a run was reserved in, never below zero. */
async function adjustWindowCost(env: Env, agentId: string, at: Date, deltaMicroUsd: number, deltaCount = 0): Promise<void> {
  if (deltaMicroUsd === 0 && deltaCount === 0) return
  const key = meterWindowKeyAt(env.TENANT_SLUG, agentId, at)
  await env.DB.prepare(
    `UPDATE execution_meter SET cost_micro_usd = MAX(cost_micro_usd + ?2, 0), count = MAX(count + ?3, 0) WHERE window_key = ?1`,
  ).bind(key, Math.round(deltaMicroUsd), deltaCount).run()
}

/** A slot that did not become a run (refused, thrown, or a concurrent duplicate that replayed another run): give the count and the estimate back. */
async function refundSlot(env: Env, agentId: string, estimateMicroUsd: number, at: Date): Promise<void> {
  try { await adjustWindowCost(env, agentId, at, -estimateMicroUsd, -1) } catch (error) {
    console.error('[provider-kernel] slot refund failed', error instanceof Error ? error.message : String(error))
  }
}

export interface KernelRefusal { accepted: false; error: 'provider_disabled' | 'budget_blocked' | 'agent_not_found' | 'agent_inactive'; detail?: Record<string, unknown> }

type Admission = { ok: true; agent: KernelAgent; estimate: number; at: Date } | { ok: false; refusal: KernelRefusal }

/**
 * Steps 1-2 for any vendor call: the kill switch, then the budget gate with the estimate RESERVED into the agent's cost window so
 * concurrent in-flight runs count against budget_cap_cents. A refusal creates nothing and raises the decision card.
 */
async function admit(env: Env, adapter: ProviderAdapter, req: DispatchRequest, spend: boolean): Promise<Admission> {
  if (await isProviderDisabled(env, adapter.kind)) return { ok: false, refusal: { accepted: false, error: 'provider_disabled' } }
  const agent = await loadKernelAgent(env, req.agentId)
  if (!agent) return { ok: false, refusal: { accepted: false, error: 'agent_not_found' } }
  if (agent.status !== 'active') return { ok: false, refusal: { accepted: false, error: 'agent_inactive' } }
  const estimate = Math.max(Math.round(adapter.estimate(env, req)), 0)
  const at = new Date()
  if (spend) {
    const gate = await checkAndReserve(env, buildAuthorizedExecution(env, agent, null, estimate))
    if (!gate.ok) {
      const card = await raiseBudgetDecisionCard(env, agent, gate.reason, adapter.kind, estimate)
      return { ok: false, refusal: { accepted: false, error: 'budget_blocked', detail: { reason: gate.reason, retry_after_seconds: gate.retryAfterSec, ...(card ? { decision_card: card } : {}) } } }
    }
    await recordTokens(env, agent.id, 0, estimate) // reserve the dollars NOW (cost only; the slot count was taken by checkAndReserve)
  }
  return { ok: true, agent, estimate, at }
}

// ── the pipeline ─────────────────────────────────────────────────────────────────────────────────────────────

/** Dispatch through the kernel. THE entry point for every provider run: nothing else may call adapter.launch for a vendor run. */
export async function dispatchViaKernel(
  env: Env,
  adapter: ProviderAdapter,
  req: DispatchRequest,
  ctx?: HarnessContext,
): Promise<DispatchOutcome | KernelRefusal> {
  // A local adapter's dry run writes nothing (grok-cli default): there is nothing to meter, reserve or mint.
  if (!adapter.capabilities().requiresApiToken && req.dryRun !== false) return adapter.launch(env, req, ctx)

  const existing = await getReservationByIdempotency(env, adapter.kind, req.squadId, req.idempotencyKey)
  const replay = existing !== null
  const admission = await admit(env, adapter, req, !replay)
  if (!admission.ok) return admission.refusal
  const { agent, estimate, at } = admission

  let runToken: { raw: string; id: string; memberId: string } | null = null
  if (!replay && adapter.capabilities().callback === 'mcp_token') {
    runToken = await mintRunToken(env, agent.id)
    if (!runToken) {
      await refundSlot(env, agent.id, estimate, at)
      return { accepted: false, error: 'budget_blocked', detail: { reason: 'run_token_unavailable' } }
    }
  }

  let outcome: DispatchOutcome
  try {
    outcome = await adapter.launch(env, req, { ...ctx, ...(runToken ? { runToken: { raw: runToken.raw, id: runToken.id } } : {}) })
  } catch (error) {
    // A throw after the credential was minted must not leave it live (it is TTL-bounded, but nothing used it): revoke, refund, rethrow.
    if (runToken) { try { await revokeMemberToken(env, runToken.memberId, runToken.id) } catch { /* TTL still bounds it */ } }
    if (!replay) await refundSlot(env, agent.id, estimate, at)
    throw error
  }

  if (runToken) {
    if (outcome.accepted && !outcome.replay) await recordRunToken(env, outcome.reservationId, runToken)
    else await revokeMemberToken(env, runToken.memberId, runToken.id) // refused or replayed: the credential was never used
  }
  if (!replay) {
    // Not a new run (refused, or a concurrent duplicate that replayed the winner's reservation): the slot and the estimate go back, so the
    // same idempotency key counts exactly once however many callers race it.
    if (!outcome.accepted || outcome.replay) await refundSlot(env, agent.id, estimate, at)
    else {
      await env.DB.prepare(`UPDATE harness_reservations SET estimate_micro_usd = ?3 WHERE tenant = ?1 AND id = ?2 AND estimate_micro_usd IS NULL`)
        .bind(env.TENANT_SLUG, outcome.reservationId, estimate).run()
    }
  }
  return outcome
}

/**
 * The Studio door: Studio launches a Cursor agent for a member without a reservation row of its own, so it cannot ride dispatchViaKernel,
 * but it MUST NOT be a way around the kill switch or the meter. Same admission (kill switch, budget gate, estimate reserved, card on a cap
 * hit); the slot is refunded when nothing launched and stays reserved for a launched or maybe-launched agent (it may be running).
 */
export async function kernelLaunchCursor(
  env: Env,
  adapter: ProviderAdapter,
  admissionReq: DispatchRequest,
  token: string,
  launch: { name: string; repoUrl: string; prompt: string; model?: string },
): Promise<{ ok: true; outcome: CursorLaunchOutcome } | { ok: false; refusal: KernelRefusal }> {
  const admission = await admit(env, adapter, admissionReq, true)
  if (!admission.ok) return { ok: false, refusal: admission.refusal }
  let outcome: CursorLaunchOutcome
  try {
    outcome = await launchCursorAgent(token, launch)
  } catch (error) {
    await refundSlot(env, admission.agent.id, admission.estimate, admission.at)
    throw error
  }
  if (outcome.state !== 'launched' && outcome.state !== 'maybe_launched') await refundSlot(env, admission.agent.id, admission.estimate, admission.at)
  return { ok: true, outcome }
}

// ── 5 + 6. reconcile and finalize ────────────────────────────────────────────────────────────────────────────

export interface FinalizeResult { reservationId: string; finalized: boolean; costMicroUsd: number; estimated: boolean }

/**
 * THE settlement, idempotent: the first caller to set finalized_at books; every other call is a no-op. Only terminal rows
 * (reconciled / failed) settle. Never throws into the cron: a failure leaves finalized_at NULL so the next tick retries.
 */
export async function finalizeRun(env: Env, reservationId: string): Promise<FinalizeResult> {
  const none: FinalizeResult = { reservationId, finalized: false, costMicroUsd: 0, estimated: false }
  const row = await getReservation(env, reservationId)
  if (!row || row.finalized_at || (row.state !== 'reconciled' && row.state !== 'failed')) return none

  const adapter = getHarnessAdapter(row.adapter)
  const provider = adapter && isProviderAdapter(adapter) ? adapter : null
  const ref = { reservationId, vendorAgentId: row.vendor_agent_id, vendorRunId: row.vendor_run_id }

  let usage = null
  if (provider && row.vendor_run_id) {
    try { usage = await provider.usage(env, ref) } catch { usage = null }
  }
  // Nothing was launched (failed before the vendor call): nothing was spent, nothing is booked. A launched run with no vendor usage
  // books the pre-call estimate, marked estimated.
  const launched = Boolean(row.vendor_run_id)
  const estimated = launched && usage === null
  const cost = usage ? Math.max(Math.round(usage.costMicroUsd), 0) : launched ? Math.max(row.estimate_micro_usd ?? 0, 0) : 0

  // Claim first: exactly one finalizer books. (A crash after the claim loses the booking, never doubles it; the token is still revoked below.)
  const claimed = await env.DB.prepare(
    `UPDATE harness_reservations SET finalized_at = ?3, usage_cost_micro_usd = ?4, usage_estimated = ?5
      WHERE tenant = ?1 AND id = ?2 AND finalized_at IS NULL AND state IN ('reconciled','failed')`,
  ).bind(env.TENANT_SLUG, reservationId, new Date().toISOString(), cost, estimated ? 1 : 0).run()
  if ((claimed.meta?.changes ?? 0) !== 1) return none

  try {
    // The estimate was RESERVED into the window at admission; settle by the difference (a run that never launched refunds all of it).
    const reserved = Math.max(row.estimate_micro_usd ?? 0, 0)
    await adjustWindowCost(env, row.agent_id, new Date(row.reserved_at), cost - reserved)
    if (usage) {
      const tokens = (usage.input ?? 0) + (usage.output ?? 0)
      await recordTokens(env, row.agent_id, tokens, 0, { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite })
    }
    if (row.flight_id && launched) {
      // cost_metered = 1 only for a vendor-measured cost; an estimate stays 0 so a dashboard shows it as an estimate.
      await env.DB.prepare(`UPDATE flights SET cost_micro_usd = ?3, cost_metered = ?4 WHERE id = ?1 AND tenant = ?2`)
        .bind(row.flight_id, env.TENANT_SLUG, cost, estimated ? 0 : 1).run()
    }
  } catch (error) {
    console.error('[provider-kernel] booking failed', reservationId, error instanceof Error ? error.message : String(error))
  }
  try { await revokeRunToken(env, row) } catch (error) { console.error('[provider-kernel] token revoke failed', reservationId, error instanceof Error ? error.message : String(error)) }
  if (provider?.cleanup) { try { await provider.cleanup(env, ref) } catch { /* vendor artefacts are best effort */ } }
  return { reservationId, finalized: true, costMicroUsd: cost, estimated }
}

export interface ReconcileSweepResult { examined: number; reconciled: number; staleClosed: number; released: number; finalized: number }

async function listUnfinalizedTerminal(env: Env, limit: number): Promise<HarnessReservationRow[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM harness_reservations WHERE tenant = ?1 AND state IN ('reconciled','failed') AND finalized_at IS NULL
       AND (vendor_run_id IS NOT NULL OR run_token_id IS NOT NULL OR estimate_micro_usd IS NOT NULL)
      ORDER BY updated_at ASC LIMIT ?2`,
  ).bind(env.TENANT_SLUG, limit).all<HarnessReservationRow>()
  return res.results ?? []
}

/**
 * Release a reserved/attaching row that has outlived the stuck horizon. It is CLOSED, never attached: reconcile must not put a request on
 * the wire. An 'attaching' row may have reached the vendor (the lease holder died mid-call), so it is closed exactly the way an expired lease
 * is (launch_unconfirmed: lease_expired, never re-launched); a 'reserved' row was never leased, so nothing was launched.
 */
async function releaseStuckReservation(env: Env, row: HarnessReservationRow): Promise<boolean> {
  const error = row.state === 'attaching' ? LAUNCH_LEASE_EXPIRED_ERROR : 'reserve_failed: released_unlaunched'
  const res = await env.DB.prepare(
    `UPDATE harness_reservations SET state = 'failed', last_error = ?3, attach_lease_until = NULL, updated_at = ?4
      WHERE tenant = ?1 AND id = ?2 AND state IN ('reserved','attaching')`,
  ).bind(env.TENANT_SLUG, row.id, error, new Date().toISOString()).run()
  if ((res.meta?.changes ?? 0) !== 1) return false
  if (row.task_id) await blockTaskForFailedReservation(env, row.task_id, row.id, error)
  return true
}

/**
 * The scheduled reconcile (rides the maintenance cron). RECONCILE NEVER LAUNCHES. For every open reservation:
 *   - reserved / attaching: if older than the stuck horizon it is released (closed), otherwise left to its attacher. Never attached here.
 *   - attached: the adapter observes the vendor run (read-only) and closes it when terminal; one the vendor never reports terminal past
 *     HARNESS_RUN_MAX_AGE_HOURS is closed as stale.
 * Every terminal run is then finalized. Rows are stamped reconcile_checked_at and served least-recently-checked first, so a long-running
 * run cannot starve newer rows. Bounded per tick, fail-soft per row.
 */
export async function reconcileProviderRuns(env: Env, limit = 25): Promise<ReconcileSweepResult> {
  const out: ReconcileSweepResult = { examined: 0, reconciled: 0, staleClosed: 0, released: 0, finalized: 0 }
  const maxAgeMs = (Number(env.HARNESS_RUN_MAX_AGE_HOURS) > 0 ? Number(env.HARNESS_RUN_MAX_AGE_HOURS) : DEFAULT_RUN_MAX_AGE_HOURS) * 3_600_000
  const open = await listReconcileBatch(env, limit)
  for (const row of open) {
    out.examined++
    try {
      await env.DB.prepare(`UPDATE harness_reservations SET reconcile_checked_at = ?3 WHERE tenant = ?1 AND id = ?2`)
        .bind(env.TENANT_SLUG, row.id, new Date().toISOString()).run()
      if (row.state === 'reserved' || row.state === 'attaching') {
        if (Date.now() - Date.parse(row.updated_at) > RESERVATION_STUCK_MS && await releaseStuckReservation(env, row)) out.released++
        continue
      }
      const adapter = getHarnessAdapter(row.adapter)
      if (!adapter) continue
      const result = await adapter.reconcile(env, row.id) // 'attached' only: observation, never a launch
      if (result.nextState === 'reconciled' && result.changed) out.reconciled++
      if (result.nextState === 'attached' && Date.now() - Date.parse(row.reserved_at) > maxAgeMs) {
        if (await markReconciled(env, row.id, 'stale_timeout')) out.staleClosed++
      }
    } catch (error) {
      console.error('[provider-kernel] reconcile failed', row.id, error instanceof Error ? error.message : String(error))
    }
  }
  for (const row of await listUnfinalizedTerminal(env, limit)) {
    const fin = await finalizeRun(env, row.id)
    if (fin.finalized) out.finalized++
  }
  return out
}

export { MICRO_USD_PER_CENT }
