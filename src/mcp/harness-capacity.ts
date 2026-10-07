// src/mcp/harness-capacity.ts — mupot#1765 (epic #1590): harness capacity report/list tools.

import { type ToolSpec, fail, done, str } from './index'
import {
  COUNT_FIELDS, HARNESSES, listCapacity, parseCapacityArgs, toView, upsertCapacity,
  type Harness,
} from '../harness/capacity'

const COUNT_SCHEMA = { type: 'integer', minimum: 0 }

export const toolHarnessCapacityReport: ToolSpec = {
  name: 'harness_capacity_report',
  scope: 'agent (bound agent reports its own host; reporter is always the caller)',
  min: 'member',
  args: '{ harness: "orca"|"herdr", host_key: string (slug), observed_at: number (ms), live_terminals, agent_sessions, busy_recent, orphaned_terminals, workers_active, workers_release_unknown, worktrees_with_live: integer>=0, max_agents?: integer, summary?: {key: integer} (<=4KB, numbers only) }',
  inputSchema: {
    type: 'object',
    properties: {
      harness: { type: 'string', enum: [...HARNESSES] },
      host_key: { type: 'string' },
      observed_at: { type: 'integer', minimum: 0 },
      ...Object.fromEntries(COUNT_FIELDS.map((f) => [f, COUNT_SCHEMA])),
      max_agents: COUNT_SCHEMA,
      summary: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } },
    },
    required: ['harness', 'host_key', 'observed_at', ...COUNT_FIELDS],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    // The reporter identity is the authenticated bound agent. NEVER an argument.
    const reporter = auth.boundAgentId
    if (!reporter) return fail(403, 'forbidden: agent-bound caller required')
    const parsed = parseCapacityArgs(args, Date.now())
    if (!parsed.ok) return fail(400, parsed.error)
    const now = Date.now()
    const row = await upsertCapacity(env, reporter, parsed.value, now)
    if (!row) return fail(500, 'capacity_write_failed')
    return done({ snapshot: toView(row, now) })
  },
}

export const toolHarnessCapacityList: ToolSpec = {
  name: 'harness_capacity_list',
  scope: 'org',
  min: 'observer',
  args: '{ harness?: "orca"|"herdr", limit?: number }',
  inputSchema: {
    type: 'object',
    properties: {
      harness: { type: 'string', enum: [...HARNESSES] },
      limit: { type: 'number' },
    },
    additionalProperties: false,
  },
  async run(_auth, env, args) {
    const h = str(args.harness)
    if (h !== null && h !== 'orca' && h !== 'herdr') return fail(400, 'invalid_harness')
    const limit = typeof args.limit === 'number' ? args.limit : 100
    const snapshots = await listCapacity(env, Date.now(), (h as Harness | null) ?? undefined, limit)
    return done({ snapshots })
  },
}

export const HARNESS_CAPACITY_TOOLS: ToolSpec[] = [toolHarnessCapacityReport, toolHarnessCapacityList]
