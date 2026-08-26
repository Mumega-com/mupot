// mupot — Cursor Cloud MCP tools.
//
// cursor_dispatch launches a Cursor Cloud agent (POST /v1/agents), then writes
// the matching mupot task + flight. cursor_run_status polls a run.

import { createCursorAgent, CursorApiError, getCursorRun, resolveCursorApiToken } from '../cursor/client'
import { recordCursorCloudWork } from '../cursor/dispatch'
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
  args: '{ name: string, repo_url: string, prompt: string, model?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      name: STRING_SCHEMA,
      repo_url: STRING_SCHEMA,
      prompt: STRING_SCHEMA,
      model: STRING_SCHEMA,
    },
    required: ['name', 'repo_url', 'prompt'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const name = str(args.name)
    const repoUrl = str(args.repo_url)
    const prompt = str(args.prompt)
    const model = str(args.model) ?? undefined
    if (!name || !repoUrl || !prompt) return fail(400, 'invalid_args')

    if (!auth.boundAgentId) return fail(409, 'agent_binding_required')
    const loaded = await getAgent(env, auth.boundAgentId)
    if (!loaded.ok) return loaded
    if (loaded.agent.status !== 'active') return fail(409, 'agent_binding_inactive')

    const denied = await requireSquadMember(env, auth, loaded.agent.squad_id, 'member')
    if (denied) return denied

    const token = resolveCursorApiToken(env)
    if (!token) return fail(503, 'cursor_token_missing')

    let launched
    try {
      launched = await createCursorAgent(token, { name, repoUrl, prompt, model })
    } catch (error) {
      return cursorFailure(error)
    }

    const actor = auth.memberId
      ? { kind: 'member' as const, id: auth.memberId }
      : { kind: 'agent' as const, id: loaded.agent.id }

    try {
      await recordCursorCloudWork(env, {
        name,
        repoUrl,
        prompt,
        squadId: loaded.agent.squad_id,
        agentId: loaded.agent.id,
        actor,
        cursor: {
          agentId: launched.agent.id,
          runId: launched.run.id,
          agentUrl: launched.agent.url,
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.startsWith('receipt_failed')) return fail(500, 'receipt_failed', message)
      return fail(500, 'cursor_record_failed')
    }

    return done({
      ok: true,
      agent_id: launched.agent.id,
      run_id: launched.run.id,
      agent_url: launched.agent.url,
    })
  },
}

export const toolCursorRunStatus: ToolSpec = {
  name: 'cursor_run_status',
  scope: 'squad',
  min: 'observer',
  args: '{ agent_id: string, run_id: string }',
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: STRING_SCHEMA,
      run_id: STRING_SCHEMA,
    },
    required: ['agent_id', 'run_id'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const agentId = str(args.agent_id)
    const runId = str(args.run_id)
    if (!agentId || !runId) return fail(400, 'invalid_args')

    if (auth.boundAgentId) {
      const loaded = await getAgent(env, auth.boundAgentId)
      if (!loaded.ok) return loaded
      const denied = await requireSquadMember(env, auth, loaded.agent.squad_id, 'observer')
      if (denied) return denied
    } else if (!hasWorkspaceAdmin(auth)) {
      return fail(409, 'agent_binding_required')
    }

    const token = resolveCursorApiToken(env)
    if (!token) return fail(503, 'cursor_token_missing')

    try {
      const run = await getCursorRun(token, agentId, runId)
      const branch = run.git?.branches?.[0]
      return done({
        status: run.status,
        pr_url: branch?.prUrl ?? null,
        branch: branch?.branch ?? null,
        result: run.result ?? null,
      })
    } catch (error) {
      return cursorFailure(error)
    }
  },
}

export const CURSOR_TOOLS: ToolSpec[] = [toolCursorDispatch, toolCursorRunStatus]
