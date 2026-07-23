// Cursor Cloud Agents connector — launch via POST api.cursor.com/v1/agents.
// External system boundary (class allowed). Pure helpers stay outside.

import {
  CURSOR_AGENTS_API_VERSION,
  CURSOR_AGENTS_PATH,
  CURSOR_API_BASE,
} from './api-version'
import type { CursorLaunchInput, CursorLaunchResult } from './types'

export class CursorCloudClient {
  readonly baseUrl: string
  readonly apiVersion: typeof CURSOR_AGENTS_API_VERSION

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.apiVersion = CURSOR_AGENTS_API_VERSION
  }

  async launchAgent(input: CursorLaunchInput): Promise<CursorLaunchResult> {
    if (!input.apiKey) throw new Error('cursor_api_key_required')
    if (!input.promptText) throw new Error('cursor_prompt_required')
    if (!input.repositoryUrl) throw new Error('cursor_repository_required')
    if (!input.startingRef) throw new Error('cursor_starting_ref_required')

    const body: Record<string, unknown> = {
      prompt: { text: input.promptText },
      repos: [
        {
          url: input.repositoryUrl,
          startingRef: input.startingRef,
        },
      ],
      autoCreatePR: input.autoCreatePr,
      workOnCurrentBranch: false,
    }
    if (input.modelId !== null) {
      body.model = { id: input.modelId }
    }
    if (input.envVars !== null) {
      body.envVars = input.envVars
    }
    // Webhook registration: documented on legacy v0; v1 docs say "coming soon".
    // Include when configured so HMAC completion works once/if accepted.
    if (input.webhookUrl !== null && input.webhookSecret !== null) {
      body.webhook = { url: input.webhookUrl, secret: input.webhookSecret }
    }

    const res = await input.fetchImpl(`${this.baseUrl}${CURSOR_AGENTS_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        'content-type': 'application/json',
        'user-agent': 'mupot-vendor-cloud/1.0 (+runtime-adapter/v1)',
      },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    let json: unknown
    try {
      json = text ? JSON.parse(text) : {}
    } catch {
      throw new Error(`cursor_launch_non_json status=${res.status}`)
    }
    if (!res.ok) {
      throw new Error(`cursor_launch_failed status=${res.status} body=${text.slice(0, 300)}`)
    }
    return parseCursorLaunchResponse(json)
  }

  async getAgent(
    apiKey: string,
    agentId: string,
    fetchImpl: typeof fetch,
  ): Promise<{ id: string; status: string; raw: unknown }> {
    const res = await fetchImpl(`${this.baseUrl}${CURSOR_AGENTS_PATH}/${encodeURIComponent(agentId)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    const text = await res.text()
    const json = text ? JSON.parse(text) : {}
    if (!res.ok) {
      throw new Error(`cursor_get_agent_failed status=${res.status}`)
    }
    const obj = json as Record<string, unknown>
    const agent = (obj.agent as Record<string, unknown> | undefined) ?? obj
    const id = typeof agent.id === 'string' ? agent.id : agentId
    const status = typeof agent.status === 'string' ? agent.status : 'UNKNOWN'
    return { id, status, raw: json }
  }

  async streamRun(
    apiKey: string,
    agentId: string,
    runId: string,
    fetchImpl: typeof fetch,
  ): Promise<Response> {
    const url =
      `${this.baseUrl}${CURSOR_AGENTS_PATH}/${encodeURIComponent(agentId)}` +
      `/runs/${encodeURIComponent(runId)}/stream`
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'text/event-stream',
      },
    })
    if (!res.ok) {
      throw new Error(`cursor_stream_failed status=${res.status}`)
    }
    return res
  }
}

export function createCursorCloudClient(): CursorCloudClient {
  return new CursorCloudClient(CURSOR_API_BASE)
}

export function parseCursorLaunchResponse(json: unknown): CursorLaunchResult {
  if (typeof json !== 'object' || json === null) {
    throw new Error('cursor_launch_response_not_object')
  }
  const root = json as Record<string, unknown>
  const agent = (root.agent as Record<string, unknown> | undefined) ?? root
  const run = root.run as Record<string, unknown> | undefined
  const agentId = typeof agent.id === 'string' ? agent.id : null
  if (agentId === null) throw new Error('cursor_launch_missing_agent_id')
  const status = typeof agent.status === 'string' ? agent.status : 'UNKNOWN'
  const runId = typeof run?.id === 'string' ? run.id : null
  return {
    apiVersion: 'v1',
    agentId,
    runId,
    status,
    raw: json,
  }
}
