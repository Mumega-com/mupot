// Claude Managed Agents connector — poll/SSE only (no webhook).
// Flow: agents → environments → sessions → events (+ stream).
// Beta header: managed-agents-2026-04-01 (live-verified path exists → 401).

import {
  ANTHROPIC_API_BASE,
  ANTHROPIC_MANAGED_AGENTS_BETA,
  ANTHROPIC_VERSION_HEADER,
} from './api-version'
import type { ClaudeManagedLaunchInput, ClaudeManagedLaunchResult } from './types'

export class ClaudeManagedAgentsClient {
  readonly baseUrl: string
  readonly betaHeader: string

  constructor(baseUrl: string, betaHeader: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.betaHeader = betaHeader
  }

  private headers(apiKey: string): Record<string, string> {
    return {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION_HEADER,
      'anthropic-beta': this.betaHeader,
      'content-type': 'application/json',
      'user-agent': 'mupot-vendor-cloud/1.0 (+runtime-adapter/v1)',
    }
  }

  async launchSession(input: ClaudeManagedLaunchInput): Promise<ClaudeManagedLaunchResult> {
    if (!input.apiKey) throw new Error('anthropic_api_key_required')
    if (!input.userMessage) throw new Error('claude_managed_user_message_required')

    const agentRes = await input.fetchImpl(`${this.baseUrl}/v1/agents`, {
      method: 'POST',
      headers: this.headers(input.apiKey),
      body: JSON.stringify({
        model: input.model,
        system: input.systemPrompt,
      }),
    })
    const agentJson = await readJson(agentRes, 'claude_managed_create_agent')
    const agentId = requireId(agentJson, 'id', 'claude_managed_agent_id')

    const envRes = await input.fetchImpl(`${this.baseUrl}/v1/environments`, {
      method: 'POST',
      headers: this.headers(input.apiKey),
      body: JSON.stringify({ name: 'mupot-vendor-cloud' }),
    })
    const envJson = await readJson(envRes, 'claude_managed_create_environment')
    const environmentId = requireId(envJson, 'id', 'claude_managed_environment_id')

    const sessionRes = await input.fetchImpl(`${this.baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: this.headers(input.apiKey),
      body: JSON.stringify({
        agent_id: agentId,
        environment_id: environmentId,
      }),
    })
    const sessionJson = await readJson(sessionRes, 'claude_managed_create_session')
    const sessionId = requireId(sessionJson, 'id', 'claude_managed_session_id')

    const eventsRes = await input.fetchImpl(
      `${this.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/events`,
      {
        method: 'POST',
        headers: this.headers(input.apiKey),
        body: JSON.stringify({
          events: [{ type: 'user.message', content: input.userMessage }],
        }),
      },
    )
    if (!eventsRes.ok) {
      const text = await eventsRes.text()
      throw new Error(`claude_managed_post_events_failed status=${eventsRes.status} body=${text.slice(0, 300)}`)
    }

    return {
      agentId,
      environmentId,
      sessionId,
      raw: { agent: agentJson, environment: envJson, session: sessionJson },
    }
  }

  async getSession(
    apiKey: string,
    sessionId: string,
    fetchImpl: typeof fetch,
  ): Promise<{ id: string; status: string; raw: unknown }> {
    const res = await fetchImpl(
      `${this.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'GET', headers: this.headers(apiKey) },
    )
    const json = await readJson(res, 'claude_managed_get_session')
    const obj = json as Record<string, unknown>
    const id = typeof obj.id === 'string' ? obj.id : sessionId
    const status = typeof obj.status === 'string' ? obj.status : 'UNKNOWN'
    return { id, status, raw: json }
  }

  async streamSessionEvents(
    apiKey: string,
    sessionId: string,
    fetchImpl: typeof fetch,
  ): Promise<Response> {
    const res = await fetchImpl(
      `${this.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/events`,
      {
        method: 'GET',
        headers: {
          ...this.headers(apiKey),
          Accept: 'text/event-stream',
        },
      },
    )
    if (!res.ok) {
      throw new Error(`claude_managed_stream_failed status=${res.status}`)
    }
    return res
  }
}

export function createClaudeManagedAgentsClient(): ClaudeManagedAgentsClient {
  return new ClaudeManagedAgentsClient(ANTHROPIC_API_BASE, ANTHROPIC_MANAGED_AGENTS_BETA)
}

async function readJson(res: Response, label: string): Promise<unknown> {
  const text = await res.text()
  let json: unknown
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`${label}_non_json status=${res.status}`)
  }
  if (!res.ok) {
    throw new Error(`${label}_failed status=${res.status} body=${text.slice(0, 300)}`)
  }
  return json
}

function requireId(json: unknown, field: string, err: string): string {
  if (typeof json !== 'object' || json === null) throw new Error(err)
  const value = (json as Record<string, unknown>)[field]
  if (typeof value !== 'string' || value.length === 0) throw new Error(err)
  return value
}
