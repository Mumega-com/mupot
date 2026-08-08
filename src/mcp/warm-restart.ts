// mupot — MCP warm-restart + instinct tools (Module Kernel, Port 4).
//
// Design: docs/architecture/mupot-module-kernel.md (build-order item 3) +
// docs/architecture/mupot-agent-identity-memory-lifecycle.md §2.5 / §3.
// Ported from ECC continuous-learning-v2 + memory-persistence hooks.
//
// AUTHZ:
//   - session_save / session_resume act on the CALLER'S OWN agent identity only
//     (boundAgentId, else memberId). Never from an args field.
//   - project_id on save/resume/instinct is gated through readAccess +
//     readableProject (same chokepoint as presence / project memory).
//   - instinct_upsert with scope=project also requires project WRITE
//     (anySquadHasProjectWrite) — shared instincts steer peers.
//   - instinct_promote requires the promotion gate (pure shouldPromoteInstinct)
//     before writing a global row — no silent promotion.

import type { AuthContext, Env } from '../types'
import { anySquadHasProjectWrite } from '../projects/access'
import { readAccess, readableProject } from './projects'
import { type ToolSpec, fail, done, str, hasWorkspaceAdmin } from './index'
import {
  buildWarmResumeContext,
  handoffPreservesFineGrain,
  isHandoffReason,
} from '../memory/warm-restart'
import {
  defaultInstinctInjectOpts,
  filterInstinctsForInject,
  isInstinctScope,
  resolveInstinctPrecedence,
  shouldPromoteInstinct,
  summarizeInstinctsForInject,
} from '../memory/instinct'
import {
  findResumeHandoff,
  listInstinctsById,
  listInstinctsForResume,
  promoteInstinctToGlobal,
  saveSessionHandoff,
  upsertInstinct,
} from '../memory/session-service'

const STRING_SCHEMA = { type: 'string' }
const NULLABLE_STRING_SCHEMA = { type: ['string', 'null'] }
const OPTIONAL_STRING_ARRAY_SCHEMA = { type: 'array', items: { type: 'string' } }
const NUMBER_SCHEMA = { type: 'number' }
const HANDOFF_REASON_ENUM = ['stop', 'pre_compact', 'session_end']
const INSTINCT_SCOPE_ENUM = ['project', 'global', 'agent']

const RECENT_HANDOFF_SCAN = 20

function callerIdentity(auth: AuthContext): string | null {
  return auth.boundAgentId ?? auth.memberId ?? null
}

function readStringList(raw: unknown, field: string): string[] | ReturnType<typeof fail> {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return fail(400, 'invalid_args', `${field} must be string[]`)
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') return fail(400, 'invalid_args', `${field} must be string[]`)
    const trimmed = item.trim()
    if (trimmed.length > 0) out.push(trimmed)
  }
  return out
}

function readProjectId(args: Record<string, unknown>): string | null | undefined {
  if (args.project_id === undefined) return undefined
  if (args.project_id === null) return null
  return str(args.project_id) ?? undefined
}

async function gateProjectRead(
  auth: AuthContext,
  env: Env,
  projectId: string | null | undefined,
): Promise<ReturnType<typeof fail> | null> {
  if (projectId === undefined || projectId === null) return null
  const project = await readableProject(env, projectId, readAccess(auth))
  if (!project) return fail(404, 'project_not_found')
  return null
}

const toolSessionSave: ToolSpec = {
  name: 'session_save',
  scope: 'self (rich Stop / PreCompact handoff for warm restart)',
  min: 'authenticated',
  args: '{ session_id: string, reason: "stop"|"pre_compact"|"session_end", summary?: string, project_id?: string|null, worktree?: string|null, branch?: string|null, user_messages?: string[], files_modified?: string[], tools_used?: string[], decisions?: string[], open_threads?: string[] }',
  inputSchema: {
    type: 'object',
    properties: {
      session_id: STRING_SCHEMA,
      reason: { type: 'string', enum: HANDOFF_REASON_ENUM },
      summary: STRING_SCHEMA,
      project_id: NULLABLE_STRING_SCHEMA,
      worktree: NULLABLE_STRING_SCHEMA,
      branch: NULLABLE_STRING_SCHEMA,
      user_messages: OPTIONAL_STRING_ARRAY_SCHEMA,
      files_modified: OPTIONAL_STRING_ARRAY_SCHEMA,
      tools_used: OPTIONAL_STRING_ARRAY_SCHEMA,
      decisions: OPTIONAL_STRING_ARRAY_SCHEMA,
      open_threads: OPTIONAL_STRING_ARRAY_SCHEMA,
    },
    required: ['session_id', 'reason'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const identity = callerIdentity(auth)
    if (!identity) return fail(403, 'not_member_bound', 'session_save requires a member-token principal')

    const sessionId = str(args.session_id)
    if (!sessionId) return fail(400, 'invalid_args', 'session_id required')
    if (!isHandoffReason(args.reason)) {
      return fail(400, 'invalid_reason', { accepted: HANDOFF_REASON_ENUM })
    }

    const projectId = readProjectId(args)
    if (args.project_id !== undefined && args.project_id !== null && projectId === undefined) {
      return fail(400, 'invalid_project_id')
    }
    const projectGate = await gateProjectRead(auth, env, projectId)
    if (projectGate) return projectGate

    const userMessages = readStringList(args.user_messages, 'user_messages')
    if (!Array.isArray(userMessages)) return userMessages
    const filesModified = readStringList(args.files_modified, 'files_modified')
    if (!Array.isArray(filesModified)) return filesModified
    const toolsUsed = readStringList(args.tools_used, 'tools_used')
    if (!Array.isArray(toolsUsed)) return toolsUsed
    const decisions = readStringList(args.decisions, 'decisions')
    if (!Array.isArray(decisions)) return decisions
    const openThreads = readStringList(args.open_threads, 'open_threads')
    if (!Array.isArray(openThreads)) return openThreads

    const worktree = args.worktree === undefined || args.worktree === null
      ? null
      : (str(args.worktree) ?? null)
    const branch = args.branch === undefined || args.branch === null
      ? null
      : (str(args.branch) ?? null)
    const summary = str(args.summary) ?? ''

    const saved = await saveSessionHandoff(env, {
      agentId: identity,
      sessionId,
      projectId: projectId === undefined ? null : projectId,
      worktree,
      branch,
      reason: args.reason,
      userMessages,
      filesModified,
      toolsUsed,
      decisions,
      openThreads,
      summary,
      savedAt: new Date().toISOString(),
    })
    if (!saved.ok) return fail(400, saved.error)

    return done({
      handoff_id: saved.value.id,
      session_id: saved.value.sessionId,
      reason: saved.value.reason,
      fine_grain: handoffPreservesFineGrain(saved.value.body),
      saved_at: saved.value.savedAt,
    })
  },
}

const toolSessionResume: ToolSpec = {
  name: 'session_resume',
  scope: 'self (SessionStart re-inject: stale-replay-guarded handoff + instincts)',
  min: 'authenticated',
  args: '{ project_id?: string|null, worktree?: string|null }',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: NULLABLE_STRING_SCHEMA,
      worktree: NULLABLE_STRING_SCHEMA,
    },
    required: [],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const identity = callerIdentity(auth)
    if (!identity) return fail(403, 'not_member_bound', 'session_resume requires a member-token principal')

    const projectId = readProjectId(args)
    if (args.project_id !== undefined && args.project_id !== null && projectId === undefined) {
      return fail(400, 'invalid_project_id')
    }
    const projectGate = await gateProjectRead(auth, env, projectId)
    if (projectGate) return projectGate

    const worktree = args.worktree === undefined || args.worktree === null
      ? null
      : (str(args.worktree) ?? null)

    const resolvedProjectId = projectId === undefined ? null : projectId
    const handoff = await findResumeHandoff(
      env,
      identity,
      { worktree, projectId: resolvedProjectId },
      RECENT_HANDOFF_SCAN,
    )

    const instinctsRaw = await listInstinctsForResume(env, identity, resolvedProjectId)
    const instincts = filterInstinctsForInject(
      resolveInstinctPrecedence(instinctsRaw),
      defaultInstinctInjectOpts(),
    )
    const instinctSummary = summarizeInstinctsForInject(instincts)
    const context = buildWarmResumeContext({
      handoffBody: handoff?.body ?? null,
      instinctSummary: instinctSummary.length > 0 ? instinctSummary : null,
    })

    return done({
      warm: context.length > 0,
      stale_replay_guarded: handoff !== null,
      fine_grain_preserved: handoff ? handoffPreservesFineGrain(handoff.body) : false,
      handoff: handoff
        ? {
            id: handoff.id,
            session_id: handoff.sessionId,
            reason: handoff.reason,
            saved_at: handoff.savedAt,
            project_id: handoff.projectId,
            worktree: handoff.worktree,
          }
        : null,
      instincts: instincts.map((instinct) => ({
        id: instinct.id,
        trigger: instinct.trigger,
        confidence: instinct.confidence,
        scope: instinct.scope,
        domain: instinct.domain,
        action: instinct.action,
      })),
      context,
    })
  },
}

const toolInstinctUpsert: ToolSpec = {
  name: 'instinct_upsert',
  scope: 'confidence (confidence-scored instinct; project write when scope=project)',
  min: 'authenticated',
  args: '{ id: string, trigger: string, action: string, confidence: number, scope: "project"|"global"|"agent", domain?: string, evidence?: string[], project_id?: string|null }',
  inputSchema: {
    type: 'object',
    properties: {
      id: STRING_SCHEMA,
      trigger: STRING_SCHEMA,
      action: STRING_SCHEMA,
      confidence: NUMBER_SCHEMA,
      scope: { type: 'string', enum: INSTINCT_SCOPE_ENUM },
      domain: STRING_SCHEMA,
      evidence: OPTIONAL_STRING_ARRAY_SCHEMA,
      project_id: NULLABLE_STRING_SCHEMA,
    },
    required: ['id', 'trigger', 'action', 'confidence', 'scope'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const identity = callerIdentity(auth)
    if (!identity) return fail(403, 'not_member_bound', 'instinct_upsert requires a member-token principal')

    if (!isInstinctScope(args.scope)) {
      return fail(400, 'invalid_scope', { accepted: INSTINCT_SCOPE_ENUM })
    }
    const trigger = str(args.trigger)
    const action = str(args.action)
    const id = str(args.id)
    if (!id || !trigger || !action) return fail(400, 'invalid_args', 'id, trigger, action required')
    if (typeof args.confidence !== 'number') return fail(400, 'invalid_confidence')

    const projectId = readProjectId(args)
    if (args.project_id !== undefined && args.project_id !== null && projectId === undefined) {
      return fail(400, 'invalid_project_id')
    }

    if (args.scope === 'project') {
      if (!projectId) return fail(400, 'project_id_required')
      const access = readAccess(auth)
      const project = await readableProject(env, projectId, access)
      if (!project) return fail(404, 'project_not_found')
      if (!access.workspaceAdmin && !(await anySquadHasProjectWrite(env, projectId, access.squadIds))) {
        return fail(403, 'forbidden', { need: 'project_write', scope: 'project' })
      }
    } else if (args.scope === 'global') {
      if (!hasWorkspaceAdmin(auth)) {
        return fail(403, 'forbidden', { need: 'org:admin', scope: 'global_instinct' })
      }
    }

    const evidence = readStringList(args.evidence, 'evidence')
    if (!Array.isArray(evidence)) return evidence

    const saved = await upsertInstinct(env, {
      id,
      trigger,
      action,
      confidence: args.confidence,
      domain: str(args.domain) ?? '',
      scope: args.scope,
      evidence,
      projectId: args.scope === 'project' ? projectId ?? null : null,
      agentId: args.scope === 'agent' ? identity : null,
      now: new Date().toISOString(),
    })
    if (!saved.ok) return fail(400, saved.error)

    return done({
      instinct: {
        id: saved.value.id,
        trigger: saved.value.trigger,
        confidence: saved.value.confidence,
        scope: saved.value.scope,
        domain: saved.value.domain,
        action: saved.value.action,
        evidence: saved.value.evidence,
        project_id: saved.value.projectId,
        agent_id: saved.value.agentId,
      },
    })
  },
}

const toolInstinctPromote: ToolSpec = {
  name: 'instinct_promote',
  scope: 'org (promote project instinct to global only when promotion gate passes)',
  min: 'authenticated',
  args: '{ id: string }',
  inputSchema: {
    type: 'object',
    properties: { id: STRING_SCHEMA },
    required: ['id'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    if (!hasWorkspaceAdmin(auth)) {
      return fail(403, 'forbidden', { need: 'org:admin', scope: 'instinct_promote' })
    }
    const id = str(args.id)
    if (!id) return fail(400, 'invalid_args', 'id required')

    const rows = await listInstinctsById(env, id)
    const projectRows = rows.filter((row) => row.scope === 'project')
    if (!shouldPromoteInstinct(projectRows)) {
      return fail(409, 'promotion_gate_failed', {
        need: '>=2 distinct projects AND avg confidence >= 0.8',
        project_count: new Set(projectRows.map((r) => r.projectId).filter(Boolean)).size,
      })
    }

    const strongest = projectRows
      .slice()
      .sort((a, b) => b.confidence - a.confidence)[0]
    if (!strongest) return fail(404, 'instinct_not_found')

    const promoted = await promoteInstinctToGlobal(env, strongest, new Date().toISOString())
    if (!promoted.ok) return fail(400, promoted.error)

    return done({
      promoted: true,
      instinct: {
        id: promoted.value.id,
        confidence: promoted.value.confidence,
        scope: promoted.value.scope,
        trigger: promoted.value.trigger,
        action: promoted.value.action,
      },
    })
  },
}

export const WARM_RESTART_TOOLS: ToolSpec[] = [
  toolSessionSave,
  toolSessionResume,
  toolInstinctUpsert,
  toolInstinctPromote,
]
