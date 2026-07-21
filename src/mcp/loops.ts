// mupot — MCP loop lifecycle tools (SENSITIVE: org-admin promotes/pauses loops).
//
// Twin of GET /api/loops and POST /api/loops/:id/status. Addon-declared loops with
// approvalRequired insert as 'paused'; promotion to 'active' is an explicit admin
// action (never silent on activate). Shared storage: src/loops/service.ts.

import type { Env } from '../types'
import { getLoop, listLoops, setLoopStatus } from '../loops/service'
import { isLoopStatus } from '../loops/manifest'
import type { LoopStatus } from '../loops/manifest'
import { type ToolSpec, fail, done, str, hasWorkspaceAdmin } from './index'

const STRING_SCHEMA = { type: 'string' }

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

export const LOOP_TOOLS: ToolSpec[] = [
  toolLoopList,
  toolLoopSetStatus,
]
