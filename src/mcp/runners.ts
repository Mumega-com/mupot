// src/mcp/runners.ts — Flight-004 TENTACLES: MCP tools for Runner Receipts

import { type ToolSpec, fail, done, str } from './index'
import { recordRunner, listRunners } from '../runners/service'
import type { RunnerStatus, ListRunnersFilter } from '../runners/types'
import { resolveAccessibleSquadIds } from '../projects/readable-squads'

const STRING_SCHEMA = { type: 'string' }
const NULLABLE_STRING_SCHEMA = { type: ['string', 'null'] }
const OPTIONAL_NUMBER_SCHEMA = { type: 'number' }

export const toolRunnerRecord: ToolSpec = {
  name: 'runner_record',
  scope: 'agent',
  min: 'member',
  args: '{ id?: string, seat_agent_id?: string, squad_id?: string|null, name: string, task: string, status: "running"|"landed"|"failed", started_at?: number, ended_at?: number|null, evidence_summary?: string|null, verdict_line?: string|null, log_url?: string|null }',
  inputSchema: {
    type: 'object',
    properties: {
      id: STRING_SCHEMA,
      seat_agent_id: STRING_SCHEMA,
      squad_id: NULLABLE_STRING_SCHEMA,
      name: STRING_SCHEMA,
      task: STRING_SCHEMA,
      status: { type: 'string', enum: ['running', 'landed', 'failed'] },
      started_at: OPTIONAL_NUMBER_SCHEMA,
      ended_at: OPTIONAL_NUMBER_SCHEMA,
      evidence_summary: NULLABLE_STRING_SCHEMA,
      verdict_line: NULLABLE_STRING_SCHEMA,
      log_url: NULLABLE_STRING_SCHEMA,
    },
    required: ['name', 'task', 'status'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const callerAgentId = auth.boundAgentId ?? undefined
    const name = str(args.name)
    const task = str(args.task)
    const status = str(args.status) as RunnerStatus
    if (!name || !task || !status) return fail(400, 'invalid_args')
    if (status !== 'running' && status !== 'landed' && status !== 'failed') {
      return fail(400, 'invalid_status')
    }

    try {
      const receipt = await recordRunner(
        env,
        {
          id: args.id ? str(args.id) || undefined : undefined,
          seat_agent_id: args.seat_agent_id ? str(args.seat_agent_id) || undefined : undefined,
          squad_id: args.squad_id === null ? null : (args.squad_id ? str(args.squad_id) : undefined),
          name,
          task,
          status,
          started_at: typeof args.started_at === 'number' ? args.started_at : undefined,
          ended_at: typeof args.ended_at === 'number' ? args.ended_at : (args.ended_at === null ? null : undefined),
          evidence_summary: args.evidence_summary === null ? null : (args.evidence_summary ? str(args.evidence_summary) : undefined),
          verdict_line: args.verdict_line === null ? null : (args.verdict_line ? str(args.verdict_line) : undefined),
          log_url: args.log_url === null ? null : (args.log_url ? str(args.log_url) : undefined),
        },
        callerAgentId,
      )
      return done({ receipt })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return fail(400, msg)
    }
  },
}

export const toolRunnerList: ToolSpec = {
  name: 'runner_list',
  scope: 'squad',
  min: 'observer',
  args: '{ seat_agent_id?: string, squad_id?: string, status?: "running"|"landed"|"failed", limit?: number }',
  inputSchema: {
    type: 'object',
    properties: {
      seat_agent_id: STRING_SCHEMA,
      squad_id: STRING_SCHEMA,
      status: { type: 'string', enum: ['running', 'landed', 'failed'] },
      limit: OPTIONAL_NUMBER_SCHEMA,
    },
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const accessibleSquadIds = await resolveAccessibleSquadIds(env, auth, 'observer')
    const reqSquadId = args.squad_id ? str(args.squad_id) : undefined
    if (reqSquadId) {
      if (accessibleSquadIds !== null && !accessibleSquadIds.includes(reqSquadId)) {
        return fail(403, 'forbidden', { need: 'observer', scope: 'squad' })
      }
    }

    const filter: ListRunnersFilter = {
      seat_agent_id: args.seat_agent_id ? str(args.seat_agent_id) || undefined : undefined,
      squad_id: reqSquadId,
      squad_ids: reqSquadId ? undefined : accessibleSquadIds,
      status: args.status ? (str(args.status) as RunnerStatus) : undefined,
      limit: typeof args.limit === 'number' ? args.limit : undefined,
    }

    const runners = await listRunners(env, filter)
    return done({ runners })
  },
}

export const RUNNER_TOOLS: ToolSpec[] = [toolRunnerRecord, toolRunnerList]
