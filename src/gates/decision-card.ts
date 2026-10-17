// src/gates/decision-card.ts — deliver a compact "decision card" to the harness agent(s) that
// front a HUMAN gate holder, so the person is actually told a task awaits them.
//
// Why: when a task enters review and the gate capability is held by an active MEMBER, the old
// wake path returned 'requires_human' and created no delivery — the human only found the item if
// they opened /needs. This module notifies; it NEVER decides or grants anything:
//   - the message is from the informational system sender 'mupot-decision-card' (reply_via null,
//     expects_reply false): it tells the recipient a human has something to decide, never to act
//     with a tool;
//   - the "/muapprove <short_id>" lines are text for the HUMAN to type back. A /muapprove sent
//     through /im/webhook is written directly AS the member via their telegram_chat_id binding (the
//     IM verdict path, same gates as any member surface); an agent-relayed decision would instead
//     need the harness-attested human_origin path (#1425, verb-bound). Nothing in the card body is
//     read back as approval by any server code.
//
// Recipient choice (documented, deliberately narrow): ONLY active, unarchived agents whose
// agents.owner_member_id is the gate-holding member AND that hold a live (unrevoked, unexpired)
// member_tokens row whose id is on the operator's HUMAN_ORIGIN_ATTESTOR_TOKEN_IDS allowlist — the
// harness that stamps the member's own chat messages, i.e. the only seat whose answer mupot would
// accept. No attestor agent => no recipient => the caller keeps 'requires_human'. There is no
// all-owned-agents fallback: a coding/chat session owned by the member is not a human channel.

import type { Env } from '../types'
import { humanOriginAttestorTokenIds } from '../im/origin-attestors'
import { nowSqlUtc, TOKEN_LIVE_PREDICATE } from '../auth/token-lifecycle'
import { sendAgentMessage } from '../agents/messages'
import { DECISION_CARD_SENDER } from '../agents/system-senders'

const RESULT_EXCERPT_CHARS = 400
// Field caps so a plugin-side validator never rejects a legitimate long title/project/name.
const MAX_TITLE_CHARS = 300
const MAX_LABEL_CHARS = 120
const cap = (v: string | null, n: number): string | null => (v === null ? null : v.slice(0, n))
const MAX_CARD_RECIPIENTS = 5
// D1 caps bound parameters per statement; owned-agent lists are chunked to stay far below it.
const ID_CHUNK = 50

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
  // request_id must match [A-Za-z0-9_.:-]{1,128}; SQLite timestamps carry a space.
  const entered = reviewEnteredAt.replace(/ /g, 'T').replace(/[^A-Za-z0-9_.:-]/g, '')
  return `decision-card:${taskId}:${entered}:${agentId}`.slice(0, 128)
}

// TODO(decision-channel designation): each human designates ONE owned agent (any harness: Hermes,
// Muse, a ChatGPT dot, a Grok bot, ...) as their decision channel; cards go there and approvals are
// accepted only from there. When that per-member field lands, replace the body of this function with
// a lookup of it — deliverDecisionCard() and every caller stay untouched. Nothing here names a harness.
export async function resolveDecisionChannelAgents(env: Env, memberId: string): Promise<string[]> {
  const attestors = humanOriginAttestorTokenIds(env)
  if (attestors.size === 0) return []
  // No LIMIT here: the attestor filter must see every owned agent, or an attestor that sorts
  // late would be cut off. The cap applies to the FINAL recipient list only.
  const owned = await env.DB.prepare(
    `SELECT id FROM agents
      WHERE owner_member_id = ?1 AND status = 'active' AND archived_at IS NULL
      ORDER BY id ASC`,
  ).bind(memberId).all<{ id: string }>()
  const ids = (owned.results ?? []).map((r) => r.id)
  const attested = new Set<string>()
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK)
    const placeholders = chunk.map((_, j) => `?${j + 1}`).join(',')
    const tokens = await env.DB.prepare(
      `SELECT t.id, t.agent_id FROM member_tokens t
        WHERE t.agent_id IN (${placeholders}) AND ${TOKEN_LIVE_PREDICATE(`?${chunk.length + 1}`)}`,
    ).bind(...chunk, nowSqlUtc()).all<{ id: string; agent_id: string }>()
    for (const t of tokens.results ?? []) if (attestors.has(t.id)) attested.add(t.agent_id)
  }
  return ids.filter((id) => attested.has(id)).slice(0, MAX_CARD_RECIPIENTS)
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
    title: row.title.slice(0, MAX_TITLE_CHARS),
    priority: row.priority,
    project: cap(row.project_name, MAX_LABEL_CHARS),
    asked_by: cap(row.asked_by, MAX_LABEL_CHARS),
    result_excerpt: (row.result ?? '').slice(0, RESULT_EXCERPT_CHARS),
    approve: `/muapprove ${shortId}`,
    reject: `/mureject ${shortId}`,
    // Optional: a rejection needs a reason; `reject` stays exactly '/mureject <short_id>' (plugins match it by equality).
    reject_hint: `/mureject ${shortId} <reason>`,
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
          fromAgent: DECISION_CARD_SENDER,
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
      } else if (res.reason === 'request_id_conflict') {
        // Same review entry re-woken with a changed body (e.g. result edited): the first card is
        // already queued for this agent; that is queued, not failed.
        delivered.push(agentId)
        duplicates++
      } else failed.push(agentId)
    } catch {
      failed.push(agentId)
    }
  }
  if (delivered.length === 0) return { status: 'delivery_failed', agent_ids: failed }
  return { status: 'delivered', agent_ids: delivered, duplicates }
}
