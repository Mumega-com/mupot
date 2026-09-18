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
    return fail(400, 'cursor_api_error', { code: error.code, message: error.message })
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
      return fail(400, 'cursor_dispatch_failed', outcome.error)
    }

    return done({
      ok: true,
      accepted: true,
      state: outcome.state,
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
  args: '{ agent_id?: string, run_id?: string, reservation_id?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: STRING_SCHEMA,
      run_id: STRING_SCHEMA,
      reservation_id: STRING_SCHEMA,
    },
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const agentId = str(args.agent_id)
    const runId = str(args.run_id)
    const reservationId = str(args.reservation_id)

    if (!reservationId && (!agentId || !runId)) {
      return fail(400, 'invalid_args')
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
      })
    } catch (error) {
      return cursorFailure(error)
    }
  },
}

export const CURSOR_TOOLS: ToolSpec[] = [toolCursorDispatch, toolCursorRunStatus]
