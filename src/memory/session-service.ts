// Port 4 — durable session handoff + instinct persistence (D1).
// Tenant always = env.TENANT_SLUG. Identity is caller-derived at the MCP boundary.

import type { Env } from '../types'
import {
  buildSessionHandoffDocument,
  isHandoffReason,
  selectMatchingHandoff,
  type HandoffMatchQuery,
  type HandoffReason,
  type SessionHandoffParts,
  type StoredHandoff,
} from './warm-restart'
import {
  clampInstinctConfidence,
  isInstinctScope,
  validateInstinctId,
  type Instinct,
  type InstinctScope,
} from './instinct'

export type WarmRestartResult<T> = { ok: true; value: T } | { ok: false; error: string }

interface HandoffRow {
  id: string
  agent_id: string
  session_id: string
  project_id: string | null
  worktree: string | null
  branch: string | null
  reason: string
  body: string
  saved_at: string
}

interface InstinctRow {
  id: string
  agent_id: string | null
  project_id: string | null
  scope: string
  trigger_text: string
  confidence: number
  domain: string
  action_text: string
  evidence_json: string
  updated_at: string
  created_at: string
}

function rowToHandoff(row: HandoffRow): StoredHandoff {
  if (!isHandoffReason(row.reason)) {
    throw new Error(`warm-restart: corrupt reason in storage: ${row.reason}`)
  }
  return {
    id: row.id,
    agentId: row.agent_id,
    sessionId: row.session_id,
    projectId: row.project_id,
    worktree: row.worktree,
    branch: row.branch,
    reason: row.reason,
    body: row.body,
    savedAt: row.saved_at,
  }
}

function parseEvidence(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === 'string')
  } catch {
    return []
  }
}

function rowToInstinct(row: InstinctRow): Instinct {
  if (!isInstinctScope(row.scope)) {
    throw new Error(`instinct: corrupt scope in storage: ${row.scope}`)
  }
  return {
    id: row.id,
    trigger: row.trigger_text,
    confidence: row.confidence,
    domain: row.domain,
    scope: row.scope,
    action: row.action_text,
    evidence: parseEvidence(row.evidence_json),
    projectId: row.project_id,
    agentId: row.agent_id,
  }
}

export interface SaveHandoffInput {
  agentId: string
  sessionId: string
  projectId: string | null
  worktree: string | null
  branch: string | null
  reason: HandoffReason
  userMessages: string[]
  filesModified: string[]
  toolsUsed: string[]
  decisions: string[]
  openThreads: string[]
  summary: string
  savedAt: string
}

export async function saveSessionHandoff(
  env: Env,
  input: SaveHandoffInput,
): Promise<WarmRestartResult<StoredHandoff>> {
  const sessionId = input.sessionId.trim()
  if (sessionId.length === 0 || sessionId.length > 128) {
    return { ok: false, error: 'invalid_session_id' }
  }
  if (!isHandoffReason(input.reason)) {
    return { ok: false, error: 'invalid_reason' }
  }

  const parts: SessionHandoffParts = {
    sessionId,
    projectId: input.projectId,
    worktree: input.worktree,
    branch: input.branch,
    reason: input.reason,
    userMessages: input.userMessages,
    filesModified: input.filesModified,
    toolsUsed: input.toolsUsed,
    decisions: input.decisions,
    openThreads: input.openThreads,
    summary: input.summary,
    savedAt: input.savedAt,
  }
  const body = buildSessionHandoffDocument(parts)
  if (body.length > 100000) {
    return { ok: false, error: 'handoff_too_large' }
  }

  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO session_handoffs
       (id, tenant, agent_id, session_id, project_id, worktree, branch, reason, body, saved_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  )
    .bind(
      id,
      env.TENANT_SLUG,
      input.agentId,
      sessionId,
      input.projectId,
      input.worktree,
      input.branch,
      input.reason,
      body,
      input.savedAt,
    )
    .run()

  return {
    ok: true,
    value: {
      id,
      agentId: input.agentId,
      sessionId,
      projectId: input.projectId,
      worktree: input.worktree,
      branch: input.branch,
      reason: input.reason,
      body,
      savedAt: input.savedAt,
    },
  }
}

export async function listRecentHandoffs(
  env: Env,
  agentId: string,
  limit: number,
): Promise<StoredHandoff[]> {
  const rows = await env.DB.prepare(
    `SELECT id, agent_id, session_id, project_id, worktree, branch, reason, body, saved_at
       FROM session_handoffs
      WHERE tenant = ?1 AND agent_id = ?2
      ORDER BY saved_at DESC
      LIMIT ?3`,
  )
    .bind(env.TENANT_SLUG, agentId, limit)
    .all<HandoffRow>()

  return (rows.results ?? []).map(rowToHandoff)
}

export async function findResumeHandoff(
  env: Env,
  agentId: string,
  query: HandoffMatchQuery,
  limit: number,
): Promise<StoredHandoff | null> {
  const recent = await listRecentHandoffs(env, agentId, limit)
  return selectMatchingHandoff(recent, query)
}

export interface UpsertInstinctInput {
  id: string
  trigger: string
  confidence: number
  domain: string
  scope: InstinctScope
  action: string
  evidence: string[]
  projectId: string | null
  agentId: string | null
  now: string
}

export async function upsertInstinct(
  env: Env,
  input: UpsertInstinctInput,
): Promise<WarmRestartResult<Instinct>> {
  let id: string
  try {
    id = validateInstinctId(input.id)
  } catch {
    return { ok: false, error: 'invalid_instinct_id' }
  }
  if (!isInstinctScope(input.scope)) {
    return { ok: false, error: 'invalid_scope' }
  }
  if (input.scope === 'project' && !input.projectId) {
    return { ok: false, error: 'project_id_required' }
  }
  if (input.scope === 'agent' && !input.agentId) {
    return { ok: false, error: 'agent_id_required' }
  }

  const trigger = input.trigger.trim()
  const action = input.action.trim()
  const domain = input.domain.trim()
  if (trigger.length === 0 || trigger.length > 500) {
    return { ok: false, error: 'invalid_trigger' }
  }
  if (action.length === 0 || action.length > 2000) {
    return { ok: false, error: 'invalid_action' }
  }
  if (domain.length > 64) {
    return { ok: false, error: 'invalid_domain' }
  }

  let confidence: number
  try {
    confidence = clampInstinctConfidence(input.confidence)
  } catch {
    return { ok: false, error: 'invalid_confidence' }
  }

  const evidence = input.evidence.filter((e) => typeof e === 'string' && e.trim().length > 0)
  const evidenceJson = JSON.stringify(evidence)
  const projectId = input.scope === 'project' ? input.projectId : null
  const agentId = input.scope === 'agent' ? input.agentId : null

  await env.DB.prepare(
    `INSERT INTO instincts
       (id, tenant, agent_id, project_id, scope, trigger_text, confidence, domain,
        action_text, evidence_json, updated_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
     ON CONFLICT (tenant, id, scope, project_key, agent_key) DO UPDATE SET
       trigger_text = excluded.trigger_text,
       confidence = excluded.confidence,
       domain = excluded.domain,
       action_text = excluded.action_text,
       evidence_json = excluded.evidence_json,
       updated_at = excluded.updated_at`,
  )
    .bind(
      id,
      env.TENANT_SLUG,
      agentId,
      projectId,
      input.scope,
      trigger,
      confidence,
      domain,
      action,
      evidenceJson,
      input.now,
    )
    .run()

  return {
    ok: true,
    value: {
      id,
      trigger,
      confidence,
      domain,
      scope: input.scope,
      action,
      evidence,
      projectId,
      agentId,
    },
  }
}

export async function listInstinctsForResume(
  env: Env,
  agentId: string,
  projectId: string | null,
): Promise<Instinct[]> {
  // Global + this agent + this project (when set).
  const rows = await env.DB.prepare(
    `SELECT id, agent_id, project_id, scope, trigger_text, confidence, domain,
            action_text, evidence_json, updated_at, created_at
       FROM instincts
      WHERE tenant = ?1
        AND (
          scope = 'global'
          OR (scope = 'agent' AND agent_id = ?2)
          OR (scope = 'project' AND project_id IS NOT NULL AND project_id = ?3)
        )
      ORDER BY confidence DESC, id ASC`,
  )
    .bind(env.TENANT_SLUG, agentId, projectId)
    .all<InstinctRow>()

  return (rows.results ?? []).map(rowToInstinct)
}

export async function listInstinctsById(
  env: Env,
  instinctId: string,
): Promise<Instinct[]> {
  const rows = await env.DB.prepare(
    `SELECT id, agent_id, project_id, scope, trigger_text, confidence, domain,
            action_text, evidence_json, updated_at, created_at
       FROM instincts
      WHERE tenant = ?1 AND id = ?2`,
  )
    .bind(env.TENANT_SLUG, instinctId)
    .all<InstinctRow>()

  return (rows.results ?? []).map(rowToInstinct)
}

export async function promoteInstinctToGlobal(
  env: Env,
  source: Instinct,
  now: string,
): Promise<WarmRestartResult<Instinct>> {
  return upsertInstinct(env, {
    id: source.id,
    trigger: source.trigger,
    confidence: source.confidence,
    domain: source.domain,
    scope: 'global',
    action: source.action,
    evidence: source.evidence,
    projectId: null,
    agentId: null,
    now,
  })
}
