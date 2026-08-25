// mupot — MCP loop lifecycle tools (SENSITIVE: org-admin promotes/pauses loops).
//
// Twin of GET /api/loops and POST /api/loops/:id/status. Addon-declared loops with
// approvalRequired insert as 'paused'; promotion to 'active' is an explicit admin
// action (never silent on activate). Shared storage: src/loops/service.ts.
//
// loop_control is the governor-signal twin of POST /brain/loops/:id/control — it
// writes loop_controls (the live one-shot the driver honors) plus an append-only
// receipt. loop_set_status writes loops.status and does NOT govern a running tick.

import type { AuthContext, Env } from '../types'
import type { LoopManifest } from '../loops/manifest'
import { getLoop, listLoops, setLoopStatus } from '../loops/service'
import { isLoopStatus } from '../loops/manifest'
import type { LoopStatus } from '../loops/manifest'
import { isLoopControlAction, setLoopControl } from '../loops/decisions'
import {
  type ToolSpec,
  fail,
  done,
  str,
  hasWorkspaceAdmin,
  isOrgOwnerAdmin,
  memberCanOnSquad,
} from './index'

const STRING_SCHEMA = { type: 'string' }

const LOOP_CONTROL_ACTIONS = ['pause', 'kill', 'budget_override'] as const

/** Squad that owns the loop: its squad_id, or the owning agent's squad. */
async function resolveLoopOwningSquadId(env: Env, loop: LoopManifest): Promise<string | null> {
  if (loop.squad_id) return loop.squad_id
  if (!loop.agent_id) return null
  const row = await env.DB.prepare('SELECT squad_id FROM agents WHERE id = ? LIMIT 1')
    .bind(loop.agent_id)
    .first<{ squad_id: string }>()
  return row?.squad_id ?? null
}

/**
 * Governor authz: org-admin, or at least lead on the loop's owning squad.
 * Fail-closed when the owning squad cannot be resolved.
 */
async function callerCanControlLoop(auth: AuthContext, env: Env, loop: LoopManifest): Promise<boolean> {
  if (isOrgOwnerAdmin(auth) || hasWorkspaceAdmin(auth)) return true
  const squadId = await resolveLoopOwningSquadId(env, loop)
  if (!squadId) return false
  return memberCanOnSquad(env, auth.capabilities ?? [], squadId, 'lead')
}

const toolLoopList: ToolSpec = {
  name: 'loop_list',
  scope: 'org (org-admin lists this tenant\'s loops)',
  min: 'admin',
  args: '{ status?: "active"|"paused"|"done"|"killed" }',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['active', 'paused', 'done', 'killed'] },
    },
    additionalProperties: false,
  },
  async run(auth, env, args) {
    if (!hasWorkspaceAdmin(auth)) return fail(403, 'forbidden', { need: 'org:admin' })
    const statusRaw = str(args.status)
    const status = statusRaw && isLoopStatus(statusRaw) ? statusRaw : undefined
    const loops = await listLoops(env as Env, status ? { status } : {})
    return done({ loops })
  },
}

const toolLoopSetStatus: ToolSpec = {
  name: 'loop_set_status',
  scope: 'org (org-admin promotes/pauses/kills a loop — paused→active is the marketing promote path)',
  min: 'admin',
  args: '{ loop_id: string, status: "active"|"paused"|"done"|"killed" }',
  inputSchema: {
    type: 'object',
    properties: {
      loop_id: STRING_SCHEMA,
      status: { type: 'string', enum: ['active', 'paused', 'done', 'killed'] },
    },
    required: ['loop_id', 'status'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    if (!hasWorkspaceAdmin(auth)) return fail(403, 'forbidden', { need: 'org:admin' })
    const loopId = str(args.loop_id)
    if (!loopId) return fail(400, 'invalid_args', 'loop_id required')
    const statusRaw = str(args.status)
    if (!statusRaw || !isLoopStatus(statusRaw)) {
      return fail(400, 'invalid_status', { accepted: ['active', 'paused', 'done', 'killed'] })
    }
    const existing = await getLoop(env as Env, loopId)
    if (!existing) return fail(404, 'not_found')
    const ok = await setLoopStatus(env as Env, loopId, statusRaw as LoopStatus)
    if (!ok) return fail(409, 'terminal_or_missing', 'loop is killed/done or vanished')
    const loop = await getLoop(env as Env, loopId)
    return done({ ok: true, loop })
  },
}

const toolLoopControl: ToolSpec = {
  name: 'loop_control',
  scope: 'squad:lead / org:admin (governor signal — pause|kill|budget_override a running loop)',
  min: 'lead',
  args: '{ loop_id: string, action: "pause"|"kill"|"budget_override", reason?: string, value?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      loop_id: STRING_SCHEMA,
      action: { type: 'string', enum: [...LOOP_CONTROL_ACTIONS] },
      reason: STRING_SCHEMA,
      value: STRING_SCHEMA,
    },
    required: ['loop_id', 'action'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const loopId = str(args.loop_id)
    if (!loopId) return fail(400, 'invalid_args', 'loop_id required')

    const actionRaw = str(args.action)
    if (!actionRaw || !isLoopControlAction(actionRaw)) {
      return fail(400, 'invalid_action', { accepted: [...LOOP_CONTROL_ACTIONS] })
    }

    const existing = await getLoop(env as Env, loopId)
    if (!existing) return fail(404, 'not_found')

    if (!(await callerCanControlLoop(auth, env as Env, existing))) {
      return fail(403, 'forbidden', { need: 'squad:lead or org:admin' })
    }

    const reason = str(args.reason)
    if (actionRaw === 'kill' && !reason) {
      return fail(400, 'invalid_args', 'reason required for kill')
    }

    let value: string | null = null
    if (actionRaw === 'budget_override') {
      const raw = str(args.value)
      if (!raw) {
        return fail(400, 'invalid_args', 'budget_override requires value (micro-USD integer string)')
      }
      const parsed = parseInt(raw, 10)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return fail(400, 'invalid_args', 'budget_override value must be a positive integer (micro-USD)')
      }
      value = raw
    }

    const actor = auth.email ?? auth.userId ?? auth.memberId ?? 'unknown'
    const { receipt_id } = await setLoopControl(
      env as Env,
      loopId,
      actionRaw,
      actor,
      value,
      reason,
    )
    return done({ ok: true, action: actionRaw, loop_id: loopId, receipt_id })
  },
}

export const LOOP_TOOLS: ToolSpec[] = [
  toolLoopList,
  toolLoopSetStatus,
  toolLoopControl,
]
