// mupot — Cursor Cloud MCP tools.
//
// Harness Adapter SPI v1 integration:
// cursor_dispatch reserves Task + Flight in Mupot D1 first, then attaches Cursor Cloud
// execution asynchronously (via ctx.waitUntil) or synchronously.
// cursor_run_status polls a run by vendor agent/run ID or reservation ID.

import { CursorApiError, resolveCursorApiToken } from '../cursor/client'
import { cursorCloudAdapter } from '../harness/adapters/cursor'
import type { AuthContext, Capability, Env } from '../types'
import {
  type ToolSpec,
  done,
  fail,
  getAgent,
  hasWorkspaceAdmin,
  memberCanOnSquad,
  str,
} from './index'

const STRING_SCHEMA = { type: 'string' }

function cursorFailure(error: unknown) {
  if (error instanceof CursorApiError) {
    if (error.status === 401 || error.status === 403) {
      return fail(403, 'cursor_unauthorized', { code: error.code })
    }
    if (error.status === 404) return fail(404, 'cursor_not_found', { code: error.code })
    if (error.status === 409) return fail(409, error.code)
    if (error.status >= 500) return fail(503, 'cursor_unavailable', { code: error.code })
    return fail(400, 'cursor_api_error', { code: error.code })
  }
  return fail(500, 'internal_error')
}

async function requireSquadMember(
  env: Env,
  auth: AuthContext,
  squadId: string,
  minimum: Capability,
) {
  const grants = auth.capabilities ?? []
  if (hasWorkspaceAdmin(auth)) return null
  if (await memberCanOnSquad(env, grants, squadId, minimum)) return null
  return fail(403, 'forbidden', { need: minimum, scope: 'squad' })
}

export const toolCursorDispatch: ToolSpec = {
  name: 'cursor_dispatch',
  scope: 'squad',
  min: 'member',
  args: '{ name: string, repo_url: string, prompt: string, model?: string, idempotency_key?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      name: STRING_SCHEMA,
      repo_url: STRING_SCHEMA,
      prompt: STRING_SCHEMA,
      model: STRING_SCHEMA,
      idempotency_key: STRING_SCHEMA,
    },
    required: ['name', 'repo_url', 'prompt'],
    additionalProperties: false,
  },
  async run(auth, env, args, ctx) {
    const name = str(args.name)
    const repoUrl = str(args.repo_url)
    const prompt = str(args.prompt)
    const model = str(args.model) ?? undefined
    const clientKey = str(args.idempotency_key)
    if (!name || !repoUrl || !prompt) return fail(400, 'invalid_args')

    if (!auth.boundAgentId) return fail(409, 'agent_binding_required')
    const loaded = await getAgent(env, auth.boundAgentId)
    if (!loaded.ok) return loaded
    if (loaded.agent.status !== 'active') return fail(409, 'agent_binding_inactive')

    const denied = await requireSquadMember(env, auth, loaded.agent.squad_id, 'member')
    if (denied) return denied

    const token = resolveCursorApiToken(env)
    if (!token) return fail(503, 'cursor_token_missing')

    const actor = auth.memberId
      ? { kind: 'member' as const, id: auth.memberId }
      : { kind: 'agent' as const, id: loaded.agent.id }

    const idempotencyKey = clientKey ?? crypto.randomUUID()

    const outcome = await cursorCloudAdapter.dispatch(
      env,
      {
        name,
        repoUrl,
        prompt,
        model,
        squadId: loaded.agent.squad_id,
        agentId: loaded.agent.id,
        actor,
        idempotencyKey,
      },
      ctx?.waitUntil ? { waitUntil: ctx.waitUntil } : undefined,
    )

    if (!outcome.accepted) {
      if (outcome.error === 'idempotency_key_conflict') {
        return fail(409, 'idempotency_key_conflict')
      }
      if (outcome.error === 'cursor_token_missing') {
        return fail(503, 'cursor_token_missing')
      }
      if (outcome.error === 'execution_paused') {
        return fail(409, 'execution_paused')
      }
      // outcome.error is already a fixed public code (publicHarnessError); raw DB/vendor text never reaches here.
      // mumega-com#1637 P2: an unconfirmed launch is not "nothing happened". Dropping the failure detail and the
      // reservation id here loses delivery:'unknown' and the row identity, so a client retry without an
      // idempotency_key can launch the vendor a second time. Carry them whenever the failure has them.
      return fail(400, 'cursor_dispatch_failed', {
        code: outcome.error,
        ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
        ...(outcome.reservationId ? { reservation_id: outcome.reservationId } : {}),
        ...(outcome.taskId ? { task_id: outcome.taskId } : {}),
        ...(outcome.flightId ? { flight_id: outcome.flightId } : {}),
      })
    }

    return done({
      ok: true,
      accepted: true,
      state: outcome.state,
      // The client-facing contract is the same as DispatchResult: branch on delivery, not on state.
      delivery: outcome.delivery,
      labels: outcome.labels,
      ...(outcome.unconfirmed ? { unconfirmed: true } : {}),
      reservation_id: outcome.reservationId,
      task_id: outcome.taskId,
      flight_id: outcome.flightId,
      idempotency_key: outcome.idempotencyKey,
      agent_id: outcome.vendorAgentId ?? null,
      run_id: outcome.vendorRunId ?? null,
      agent_url: outcome.vendorUrl ?? null,
      replay: outcome.replay,
    })
  },
}

export const toolCursorRunStatus: ToolSpec = {
  name: 'cursor_run_status',
  scope: 'squad',
  min: 'observer',
  args: '{ reservation_id: string } OR { agent_id: string, run_id: string }',
  // Not oneOf at the top level: several MCP clients reject a top-level combinator. The real
  // requirement is stated in descriptions and enforced in run() with a detail naming the fields (mupot#2310).
  inputSchema: {
    type: 'object',
    description: 'Provide reservation_id, OR both agent_id and run_id. All three are individually optional but one of those two forms is required.',
    properties: {
      agent_id: { type: 'string', description: 'Vendor agent id. Required together with run_id when reservation_id is not given.' },
      run_id: { type: 'string', description: 'Vendor run id. Required together with agent_id when reservation_id is not given.' },
      reservation_id: { type: 'string', description: 'Reservation id. Alone it is sufficient; omit agent_id and run_id.' },
    },
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const agentId = str(args.agent_id)
    const runId = str(args.run_id)
    const reservationId = str(args.reservation_id)

    if (!reservationId && (!agentId || !runId)) {
      const missing = [!agentId ? 'agent_id' : null, !runId ? 'run_id' : null].filter((f): f is string => f !== null)
      return fail(400, 'invalid_args', `provide reservation_id, or agent_id plus run_id; missing: ${missing.join(', ')}`)
    }

    if (auth.boundAgentId) {
      const loaded = await getAgent(env, auth.boundAgentId)
      if (!loaded.ok) return loaded
      const denied = await requireSquadMember(env, auth, loaded.agent.squad_id, 'observer')
      if (denied) return denied

      if (reservationId) {
        const row = await env.DB.prepare(
          `SELECT squad_id FROM harness_reservations WHERE tenant = ? AND id = ?`,
        )
          .bind(env.TENANT_SLUG, reservationId)
          .first<{ squad_id: string }>()
        if (row && row.squad_id !== loaded.agent.squad_id) {
          const crossDenied = await requireSquadMember(env, auth, row.squad_id, 'observer')
          if (crossDenied) return crossDenied
        }
      }
    } else if (!hasWorkspaceAdmin(auth)) {
      return fail(409, 'agent_binding_required')
    }

    try {
      const statusResult = await cursorCloudAdapter.status(env, {
        reservationId: reservationId ?? undefined,
        vendorAgentId: agentId ?? undefined,
        vendorRunId: runId ?? undefined,
      })

      return done({
        status: statusResult.vendorStatus ?? statusResult.state,
        pr_url: statusResult.prUrl ?? null,
        branch: statusResult.branch ?? null,
        result: statusResult.result ?? null,
        reservation_id: statusResult.reservationId,
        state: statusResult.state,
        delivery: statusResult.delivery,
        ...(statusResult.stuck ? { stuck: true } : {}),
      })
    } catch (error) {
      return cursorFailure(error)
    }
  },
}

export const CURSOR_TOOLS: ToolSpec[] = [toolCursorDispatch, toolCursorRunStatus]
