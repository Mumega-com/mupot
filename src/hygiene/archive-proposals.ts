// src/hygiene/archive-proposals.ts: agents propose, humans archive (/board/cleanup).
//
// proposeArchives only WRITES archive_proposals rows; it never touches a task. decideProposals is the one place a
// proposal turns into an archive, and it archives ONLY by calling archiveRow (src/hygiene/archive.ts), so the
// expected_status drift check and every refusal (live execution claim, in-air flight, in-flight dispatch) are
// archiveRow's own, not re-derived here. Callers (the dashboard POST) own the human-operator + org-admin gate.

import type { Env } from '../types'
import type { AuthContext } from '../types'
import { archiveRow, type ArchiveOutcome } from './archive'

export const MAX_PROPOSE_IDS = 100
export const MAX_PENDING_PER_AGENT = 200
const REASON_MAX = 1000
const EVIDENCE_MAX = 4000

export interface ProposeInput {
  agentId: string
  taskIds: string[]
  reason: string
  evidence: string
}

export type ProposeResult =
  | { ok: true; proposed: string[]; already_pending: string[]; not_found: string[]; already_archived: string[] }
  | { ok: false; error: 'invalid_args' | 'too_many_pending'; detail?: string }

export async function proposeArchives(env: Env, input: ProposeInput): Promise<ProposeResult> {
  const reason = input.reason.trim()
  const evidence = input.evidence.trim()
  const ids = Array.from(new Set(input.taskIds.map((id) => id.trim()).filter((id) => id.length > 0)))
  if (ids.length === 0 || ids.length > MAX_PROPOSE_IDS) {
    return { ok: false, error: 'invalid_args', detail: `task_ids must hold 1-${MAX_PROPOSE_IDS} ids` }
  }
  if (reason.length === 0 || reason.length > REASON_MAX) {
    return { ok: false, error: 'invalid_args', detail: `reason must be 1-${REASON_MAX} characters` }
  }
  if (evidence.length > EVIDENCE_MAX) {
    return { ok: false, error: 'invalid_args', detail: `evidence must be at most ${EVIDENCE_MAX} characters` }
  }
  const pending = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM archive_proposals WHERE tenant = ?1 AND proposed_by_agent_id = ?2 AND decision IS NULL`,
  ).bind(env.TENANT_SLUG, input.agentId).first<{ n: number }>()
  if (Number(pending?.n ?? 0) + ids.length > MAX_PENDING_PER_AGENT) return { ok: false, error: 'too_many_pending' }

  const proposed: string[] = []
  const alreadyPending: string[] = []
  const notFound: string[] = []
  const alreadyArchived: string[] = []
  const now = new Date().toISOString()
  for (const taskId of ids) {
    const task = await env.DB.prepare(
      `SELECT t.status AS status, ta.task_id AS archived FROM tasks t
         LEFT JOIN tasks_archive_state ta ON ta.task_id = t.id WHERE t.id = ?1`,
    ).bind(taskId).first<{ status: string; archived: string | null }>()
    if (!task) { notFound.push(taskId); continue }
    if (task.archived) { alreadyArchived.push(taskId); continue }
    // The partial unique index makes a concurrent duplicate a no-op rather than a second pending row.
    const res = await env.DB.prepare(
      `INSERT INTO archive_proposals (id, tenant, task_id, proposed_by_agent_id, reason, evidence, task_status_at_proposal, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT DO NOTHING`,
    ).bind(crypto.randomUUID(), env.TENANT_SLUG, taskId, input.agentId, reason, evidence, task.status, now).run()
    if (Number(res.meta?.changes ?? 0) === 1) proposed.push(taskId)
    else alreadyPending.push(taskId)
  }
  return { ok: true, proposed, already_pending: alreadyPending, not_found: notFound, already_archived: alreadyArchived }
}

export interface PendingProposal {
  id: string
  task_id: string
  title: string | null
  current_status: string | null
  status_at_proposal: string
  reason: string
  evidence: string
  proposed_by: string
  created_at: string
}

export async function listPendingProposals(env: Env): Promise<PendingProposal[]> {
  const { results } = await env.DB.prepare(
    `SELECT p.id AS id, p.task_id AS task_id, t.title AS title, t.status AS current_status,
            p.task_status_at_proposal AS status_at_proposal, p.reason AS reason, p.evidence AS evidence,
            COALESCE(a.name, p.proposed_by_agent_id) AS proposed_by, p.created_at AS created_at
       FROM archive_proposals p
       LEFT JOIN tasks t ON t.id = p.task_id
       LEFT JOIN agents a ON a.id = p.proposed_by_agent_id
      WHERE p.tenant = ?1 AND p.decision IS NULL
        AND NOT EXISTS (SELECT 1 FROM tasks_archive_state ta WHERE ta.task_id = p.task_id)
      ORDER BY p.reason ASC, p.created_at ASC, p.id ASC
      LIMIT 500`,
  ).bind(env.TENANT_SLUG).all<PendingProposal>()
  return results ?? []
}

export async function countPendingProposals(env: Env): Promise<number> {
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM archive_proposals p
        WHERE p.tenant = ?1 AND p.decision IS NULL
          AND NOT EXISTS (SELECT 1 FROM tasks_archive_state ta WHERE ta.task_id = p.task_id)`,
    ).bind(env.TENANT_SLUG).first<{ n: number }>()
    return Number(row?.n ?? 0)
  } catch {
    return 0 // fail-soft: a link on another page must never break it (table absent before the migration is applied)
  }
}

export interface DecideRowResult {
  proposal_id: string
  task_id: string
  result: 'archived' | 'already_archived' | 'refused'
  error?: string
}

function terminalDecision(outcome: ArchiveOutcome): string | null {
  if (outcome.ok) return outcome.status === 'archived' ? 'archived' : 'already_archived'
  if (outcome.error === 'status_drift') return 'refused_status_drift'
  if (outcome.error === 'not_found') return 'refused_not_found'
  return null // transient refusal: stays pending so a later attempt can succeed
}

/** Archive the given pending proposals, each through archiveRow with its recorded status as expectedStatus. */
export async function decideProposals(
  env: Env,
  auth: AuthContext,
  actorMemberId: string,
  proposalIds: string[],
): Promise<DecideRowResult[]> {
  const out: DecideRowResult[] = []
  for (const proposalId of Array.from(new Set(proposalIds))) {
    const p = await env.DB.prepare(
      `SELECT id, task_id, reason, task_status_at_proposal AS status FROM archive_proposals
        WHERE id = ?1 AND tenant = ?2 AND decision IS NULL`,
    ).bind(proposalId, env.TENANT_SLUG).first<{ id: string; task_id: string; reason: string; status: string }>()
    if (!p) { out.push({ proposal_id: proposalId, task_id: '', result: 'refused', error: 'not_pending' }); continue }
    const outcome = await archiveRow(env, auth, {
      table: 'tasks',
      id: p.task_id,
      reason: `${p.reason} [archive_proposal:${p.id}]`.slice(0, 2000),
      actorMemberId,
      expectedStatus: p.status,
    })
    const decision = terminalDecision(outcome)
    if (decision) {
      await env.DB.prepare(
        `UPDATE archive_proposals SET decision = ?1, decided_at = ?2, decided_by_member_id = ?3
          WHERE id = ?4 AND decision IS NULL`,
      ).bind(decision, new Date().toISOString(), actorMemberId, p.id).run()
    }
    if (outcome.ok) {
      out.push({ proposal_id: p.id, task_id: p.task_id, result: outcome.status })
    } else {
      out.push({ proposal_id: p.id, task_id: p.task_id, result: 'refused', error: outcome.error })
    }
  }
  return out
}
