// src/gates/decision-card.ts — deliver a compact "decision card" to the harness agent(s) that
// front a HUMAN gate holder, so the person is actually told a task awaits them.
//
// Why: when a task enters review and the gate capability is held by an active MEMBER, the old
// wake path returned 'requires_human' and created no delivery — the human only found the item if
// they opened /needs. This module notifies; it NEVER decides or grants anything:
//   - the message is a system-sender (mupot-review-gate) 'request' whose response tool is
//     task_verdict (informational for the recipient: expects_reply is false);
//   - the "/muapprove <short_id>" lines are text for the HUMAN to type back; a verdict still has to
//     arrive through the existing human_origin path (harness-attested, #1425) or the member's own
//     surface. Nothing in the card body is read back as approval by any server code.
//
// Recipient choice (documented, deliberately narrow): ACTIVE, non-archived agents whose
// agents.owner_member_id is the gate-holding member. If any of those holds a LIVE (unrevoked,
// unexpired) member_tokens row whose id is on the operator's HUMAN_ORIGIN_ATTESTOR_TOKEN_IDS
// allowlist, only those agents are used — they are the member's declared human channel (the
// harness that stamps the member's chat messages). Otherwise every active owned agent is used.

import type { Env } from '../types'
import { humanOriginAttestorTokenIds } from '../im/origin-attestors'
import { nowSqlUtc, TOKEN_LIVE_PREDICATE } from '../auth/token-lifecycle'
import { sendAgentMessage } from '../agents/messages'
import { REVIEW_WAKE_SENDER } from '../agents/system-senders'

const RESULT_EXCERPT_CHARS = 400
const MAX_CARD_RECIPIENTS = 5

export interface DecisionCardTask {
  id: string
  squad_id?: string | null
}

export type DecisionCardOutcome =
  | { status: 'no_owned_agent' }
  | { status: 'delivered'; agent_ids: string[]; duplicates: number }
  | { status: 'delivery_failed'; agent_ids: string[] }

// request_id uniqueness is per SENDER (agent_messages), so the recipient must be part of the key or
// a second recipient of the same card collides with request_id_conflict.
export function decisionCardRequestId(taskId: string, reviewEnteredAt: string, agentId: string): string {
  return `decision-card:${taskId}:${reviewEnteredAt}:${agentId}`
}

// TODO(decision-channel designation): each human designates ONE owned agent (any harness: Hermes,
// Muse, a ChatGPT dot, a Grok bot, ...) as their decision channel; cards go there and approvals are
// accepted only from there. When that per-member field lands, replace the body of this function with
// a lookup of it — deliverDecisionCard() and every caller stay untouched. Nothing here names a harness.
export async function resolveDecisionChannelAgents(env: Env, memberId: string): Promise<string[]> {
  const owned = await env.DB.prepare(
    `SELECT id FROM agents
      WHERE owner_member_id = ?1 AND status = 'active' AND archived_at IS NULL
      ORDER BY id ASC LIMIT ?2`,
  ).bind(memberId, MAX_CARD_RECIPIENTS).all<{ id: string }>()
  const ids = (owned.results ?? []).map((r) => r.id)
  if (ids.length === 0) return []

  const attestors = humanOriginAttestorTokenIds(env)
  if (attestors.size === 0) return ids
  const placeholders = ids.map((_, i) => `?${i + 1}`).join(',')
  const tokens = await env.DB.prepare(
    `SELECT t.id, t.agent_id FROM member_tokens t
      WHERE t.agent_id IN (${placeholders}) AND ${TOKEN_LIVE_PREDICATE(`?${ids.length + 1}`)}`,
  ).bind(...ids, nowSqlUtc()).all<{ id: string; agent_id: string }>()
  const attested = new Set(
    (tokens.results ?? []).filter((t) => attestors.has(t.id)).map((t) => t.agent_id),
  )
  const preferred = ids.filter((id) => attested.has(id))
  return preferred.length > 0 ? preferred : ids
}

interface TaskCardRow {
  title: string
  priority: string | null
  result: string | null
  project_name: string | null
  asked_by: string | null
  entered: string | null
}

export async function deliverDecisionCard(
  env: Env,
  task: DecisionCardTask,
  memberId: string,
  byId: string,
  origin?: string,
): Promise<DecisionCardOutcome> {
  const agentIds = await resolveDecisionChannelAgents(env, memberId)
  if (agentIds.length === 0) return { status: 'no_owned_agent' }

  const row = await env.DB.prepare(
    `SELECT t.title, t.priority, t.result, p.name AS project_name,
            COALESCE(a.name, a.slug) AS asked_by,
            COALESCE(t.review_entered_at, t.updated_at, t.created_at) AS entered
       FROM tasks t
       LEFT JOIN projects p ON p.id = t.project_id
       LEFT JOIN agents a ON a.id = t.assignee_agent_id
      WHERE t.id = ?1`,
  ).bind(task.id).first<TaskCardRow>()
  if (!row) return { status: 'delivery_failed', agent_ids: agentIds }

  const shortId = task.id.slice(0, 8)
  const base = origin ?? env.PUBLIC_ORIGIN ?? ''
  const card = {
    type: 'decision_card',
    task_id: task.id,
    short_id: shortId,
    title: row.title,
    priority: row.priority,
    project: row.project_name,
    asked_by: row.asked_by,
    result_excerpt: (row.result ?? '').slice(0, RESULT_EXCERPT_CHARS),
    approve: `/muapprove ${shortId}`,
    reject: `/mureject ${shortId}`,
    dashboard_url: base ? `${base.replace(/\/$/, '')}/approvals` : null,
  }

  const delivered: string[] = []
  const failed: string[] = []
  let duplicates = 0
  for (const agentId of agentIds) {
    try {
      const res = await sendAgentMessage(
        env,
        {
          fromAgent: REVIEW_WAKE_SENDER,
          fromMember: byId,
          toAgent: agentId,
          kind: 'request',
          body: JSON.stringify(card),
          requestId: decisionCardRequestId(task.id, row.entered ?? '', agentId),
        },
        { system: true, reason: 'recipient is an agent owned by the gate-holding member, resolved server-side' },
      )
      if (res.ok) {
        delivered.push(agentId)
        if (res.duplicate) duplicates++
      } else failed.push(agentId)
    } catch {
      failed.push(agentId)
    }
  }
  if (delivered.length === 0) return { status: 'delivery_failed', agent_ids: failed }
  return { status: 'delivered', agent_ids: delivered, duplicates }
}
