// src/hygiene/archive-proposals.ts: agents propose, humans archive (/board/cleanup).
//
// proposeArchives only WRITES archive_proposals rows; it never touches a task. decideProposals is the one place a
// proposal turns into an archive, and it archives ONLY by calling archiveRow (src/hygiene/archive.ts), so the
// expected_status drift check and every refusal (live execution claim, in-air flight, in-flight dispatch) are
// archiveRow's own, not re-derived here. Callers (the dashboard POST) own the human-operator + org-admin gate.

import type { Env } from '../types'
import type { AuthContext } from '../types'
import { canReadTask } from '../tasks/visibility'
import { archiveRow, taskArchiveEnabled, type ArchiveOutcome } from './archive'

export const MAX_PROPOSE_IDS = 100
export const MAX_PENDING_PER_AGENT = 200
const REASON_MAX = 1000
const EVIDENCE_MAX = 4000

export const PROPOSAL_TTL_MS = 14 * 24 * 60 * 60 * 1000
const LIST_LIMIT = 500

function ttlCutoffIso(nowMs: number = Date.now()): string {
  return new Date(nowMs - PROPOSAL_TTL_MS).toISOString()
}

export interface ProposeInput {
  agentId: string
  taskIds: string[]
  reason: string
  evidence: string
}

export type ProposeResult =
  | {
      ok: true
      proposed: string[]
      already_pending: string[]
      // One undifferentiated bucket: a missing id, an id the caller cannot read (canReadTask, the task_get predicate)
      // and an already-archived id are indistinguishable, so the response is not an id-existence oracle.
      not_proposable: string[]
      cap_reached: string[]
    }
  | { ok: false; error: 'invalid_args' | 'not_supported'; detail?: string }

export async function proposeArchives(env: Env, auth: AuthContext, input: ProposeInput): Promise<ProposeResult> {
  // With task archiving off nothing could ever be decided; refuse up front instead of queueing dead proposals.
  if (!taskArchiveEnabled(env)) return { ok: false, error: 'not_supported' }
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

  const proposed: string[] = []
  const alreadyPending: string[] = []
  const notProposable: string[] = []
  const capReached: string[] = []
  const now = new Date().toISOString()
  for (const taskId of ids) {
    const task = await env.DB.prepare(`SELECT id, squad_id, status, updated_at FROM tasks WHERE id = ?1`)
      .bind(taskId).first<{ id: string; squad_id: string; status: string; updated_at: string }>()
    if (!task || !(await canReadTask(env, auth, { id: task.id, squad_id: task.squad_id }))) {
      notProposable.push(taskId)
      continue
    }
    // The per-agent cap is part of the INSERT itself (one statement), so concurrent calls cannot overshoot it.
    // The partial unique index makes a duplicate pending proposal a no-op rather than a second row.
    const res = await env.DB.prepare(
      `INSERT INTO archive_proposals (id, tenant, task_id, proposed_by_agent_id, reason, evidence,
                                      task_status_at_proposal, task_updated_at_proposal, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
        WHERE (SELECT COUNT(*) FROM archive_proposals WHERE tenant = ?2 AND proposed_by_agent_id = ?4 AND decision IS NULL) < ${MAX_PENDING_PER_AGENT}
       ON CONFLICT DO NOTHING`,
    ).bind(crypto.randomUUID(), env.TENANT_SLUG, taskId, input.agentId, reason, evidence, task.status, task.updated_at, now).run()
    if (Number(res.meta?.changes ?? 0) === 1) { proposed.push(taskId); continue }
    const dup = await env.DB.prepare(
      `SELECT 1 AS x FROM archive_proposals WHERE tenant = ?1 AND task_id = ?2 AND decision IS NULL`,
    ).bind(env.TENANT_SLUG, taskId).first<{ x: number }>()
    if (dup) alreadyPending.push(taskId)
    else capReached.push(taskId)
  }
  return { ok: true, proposed, already_pending: alreadyPending, not_proposable: notProposable, cap_reached: capReached }
}

export interface PendingProposal {
  id: string
  task_id: string
  title: string | null
  current_status: string | null
  status_at_proposal: string
  squad: string | null
  project: string | null
  agent_id: string
  proposed_by: string
  reason: string
  evidence: string
  created_at: string
}

/** The ONE pending-proposals query: the page renders it and the Needs You count is its length. */
export async function listPendingProposals(env: Env, nowMs: number = Date.now()): Promise<PendingProposal[]> {
  const { results } = await env.DB.prepare(
    `SELECT p.id AS id, p.task_id AS task_id, t.title AS title, t.status AS current_status,
            p.task_status_at_proposal AS status_at_proposal, s.name AS squad, pr.name AS project,
            p.proposed_by_agent_id AS agent_id, COALESCE(a.name, p.proposed_by_agent_id) AS proposed_by,
            p.reason AS reason, p.evidence AS evidence, p.created_at AS created_at
       FROM archive_proposals p
       LEFT JOIN tasks t ON t.id = p.task_id
       LEFT JOIN squads s ON s.id = t.squad_id
       LEFT JOIN projects pr ON pr.id = t.project_id
       LEFT JOIN agents a ON a.id = p.proposed_by_agent_id
      WHERE p.tenant = ?1 AND p.decision IS NULL AND p.created_at > ?2
        AND NOT EXISTS (SELECT 1 FROM tasks_archive_state ta WHERE ta.task_id = p.task_id)
      ORDER BY p.created_at ASC, p.id ASC
      LIMIT ${LIST_LIMIT}`,
  ).bind(env.TENANT_SLUG, ttlCutoffIso(nowMs)).all<PendingProposal>()
  return results ?? []
}

export async function countPendingProposals(env: Env): Promise<number> {
  try {
    return (await listPendingProposals(env)).length
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
      `SELECT id, task_id, reason, task_status_at_proposal AS status, task_updated_at_proposal AS updated_at
         FROM archive_proposals
        WHERE id = ?1 AND tenant = ?2 AND decision IS NULL AND created_at > ?3`,
    ).bind(proposalId, env.TENANT_SLUG, ttlCutoffIso()).first<{ id: string; task_id: string; reason: string; status: string; updated_at: string | null }>()
    if (!p) { out.push({ proposal_id: proposalId, task_id: '', result: 'refused', error: 'not_pending' }); continue }
    // A retitled / re-bodied / touched task is no longer what the proposer reviewed (status alone is not enough).
    const live = await env.DB.prepare(`SELECT updated_at FROM tasks WHERE id = ?1`).bind(p.task_id).first<{ updated_at: string }>()
    if (live && p.updated_at !== null && live.updated_at !== p.updated_at) {
      await env.DB.prepare(
        `UPDATE archive_proposals SET decision = 'refused_task_changed', decided_at = ?1, decided_by_member_id = ?2
          WHERE id = ?3 AND decision IS NULL`,
      ).bind(new Date().toISOString(), actorMemberId, p.id).run()
      out.push({ proposal_id: p.id, task_id: p.task_id, result: 'refused', error: 'task_changed' })
      continue
    }
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
