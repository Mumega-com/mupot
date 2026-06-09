// mupot — the outreach config: the reason + KPI seams that make an outreach loop DO
// work (P4, #35). These are passed to the runtime by the driver. The runtime/container
// stays generic; the outreach SPECIFICS live here (drafting, the reply KPI), as config.
//
// Productive-tick dedup (the P3 review's requirement): the reasoner CONSUMES a prospect
// by marking it 'drafted' once it proposes a send. listQueued only returns 'queued', so a
// prospect is drafted at most once — a loop cannot re-spam the same prospect every tick.

import type { Env, ModelPort, ModelMessage } from '../types'
import type { ProposedAct, RuntimeDeps } from './runtime'
import { createModel } from '../model'
import { claimProspect, countByStatus } from './prospects'

export interface OutreachReasonDeps {
  model?: ModelPort
  /** Atomically claim a prospect (queued→drafted); returns true iff this call won it. */
  markDrafted?: (env: Env, prospectId: string) => Promise<boolean>
}

/**
 * makeOutreachReason — a runtime `reason` seam. For each perceived prospect (up to the
 * effort budget) with an email, drafts a first-touch message and proposes a gated
 * send_email act, then consumes the prospect (→ 'drafted'). Items without an email
 * (non-prospect sources) are skipped, so this is a safe default for any loop.
 */
export function makeOutreachReason(deps: OutreachReasonDeps = {}): NonNullable<RuntimeDeps['reason']> {
  return async (env, input) => {
    const model = deps.model ?? createModel(env)
    const claim = deps.markDrafted ?? claimProspect
    const acts: ProposedAct[] = []

    for (const item of input.context.slice(0, input.budget)) {
      const email = typeof item.email === 'string' ? item.email : ''
      if (!email) continue

      const draft = await draftMessage(model, input.loop.okr, item)
      if (!draft) continue

      // CLAIM FIRST (structural dedup): only propose a send if we atomically won the
      // prospect (queued→drafted). A lost/failed claim → skip, so the same prospect can
      // never yield a duplicate act across ticks or concurrent runs.
      let won = false
      try {
        won = await claim(env, item.id)
      } catch {
        won = false
      }
      if (!won) continue

      acts.push({
        channel_index: 0,
        tool: 'send_email',
        args: {
          to: email,
          subject: draft.subject,
          body: draft.body,
          prospect_id: item.id,
          consent_basis: item.consent_basis ?? 'unknown', // surfaced to the approver (CASL)
        },
        summary: `Outreach: ${String(item.title ?? email).slice(0, 80)}`,
      })
    }

    return acts
  }
}

interface Draft {
  subject: string
  body: string
}

async function draftMessage(model: ModelPort, offer: string, item: Record<string, unknown>): Promise<Draft | null> {
  const messages: ModelMessage[] = [
    {
      role: 'system',
      content:
        'You write a short, specific, CASL/CAN-SPAM-compliant B2B outreach email. ' +
        'Respond ONLY with compact JSON {"subject": string, "body": string}. No hype, no ' +
        'false claims, reference a real detail about the prospect, include a clear one-line ' +
        'unsubscribe/opt-out at the end.',
    },
    {
      role: 'user',
      content:
        `Offer / goal: ${offer}\n` +
        `Prospect: ${JSON.stringify({ org: item.org, title: item.title, notes: item.text })}\n` +
        'Write the first-touch email as JSON only.',
    },
  ]

  let raw: string
  try {
    raw = await model.chat(messages, {})
  } catch {
    return null
  }
  const s = raw.indexOf('{')
  const e = raw.lastIndexOf('}')
  if (s < 0 || e <= s) return null
  try {
    const o = JSON.parse(raw.slice(s, e + 1)) as { subject?: unknown; body?: unknown }
    if (typeof o.subject !== 'string' || typeof o.body !== 'string') return null
    return { subject: o.subject.slice(0, 200), body: o.body.slice(0, 4000) }
  } catch {
    return null
  }
}

export interface OutreachKpiDeps {
  countReplied?: (env: Env) => Promise<number>
}

/**
 * makeOutreachObserveKpi — a runtime `observeKpi` seam. The OUTCOME signal is positive
 * replies (prospects in 'replied'), NOT activity: progress = replied ÷ kpi.target × 100.
 */
export function makeOutreachObserveKpi(deps: OutreachKpiDeps = {}): NonNullable<RuntimeDeps['observeKpi']> {
  const countReplied = deps.countReplied ?? ((env: Env) => countByStatus(env, 'replied'))
  return async (env, loop) => {
    const target = loop.kpi.target > 0 ? loop.kpi.target : 1
    const replied = await countReplied(env)
    return Math.max(0, Math.min(100, (replied / target) * 100))
  }
}
