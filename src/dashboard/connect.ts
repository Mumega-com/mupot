// mupot — connect-config helpers (PURE, dashboard-local).
//
// These build the copy-paste MCP client config a member pastes into their own
// workspace to reach this pot. They are PURE string builders (no DB, no env, no
// secret) so they can be unit-tested and reused by the dashboard Connect card.
//
// SECURITY: the snippets ALWAYS carry a literal `<MEMBER_TOKEN>` placeholder —
// never a real token. A raw token is shown EXACTLY ONCE on the mint show-once
// page, never woven into a reusable config snippet.

import type { WakeContract } from '../types'

/** The pot's MCP endpoint, derived from the request origin (never hardcoded). */
export function mcpEndpoint(origin: string): string {
  // origin is the scheme+host the browser reached us on (e.g. https://pot.example).
  // We mount the MCP component at ROUTES.mcp ('/mcp'); join without a double slash.
  return `${origin.replace(/\/+$/, '')}/mcp`
}

/** The canonical origin for a brief/directive surface: the env-pinned PUBLIC_ORIGIN
 *  when configured (and parseable), else the request origin. The Host header is
 *  client-influenceable, so any value rendered INTO a directive (the orient brief's
 *  MCP endpoint) must prefer the operator-pinned origin. #88. */
export function canonicalOrigin(env: { PUBLIC_ORIGIN?: string }, requestOrigin: string): string {
  const pinned = env.PUBLIC_ORIGIN?.trim()
  if (pinned) {
    try {
      const u = new URL(pinned)
      // Only an http(s) origin is valid here. A non-special scheme (e.g. javascript:)
      // parses without throwing and serializes .origin to the literal "null" — reject
      // it and fall back rather than render "null/mcp" into the brief.
      if (u.protocol === 'https:' || u.protocol === 'http:') return u.origin
    } catch {
      // misconfigured PUBLIC_ORIGIN → fall back to the request origin (never throw)
    }
  }
  return requestOrigin
}

/** Claude Code `.mcp.json` snippet — streamable-HTTP, Bearer placeholder.
 *  The pot's /mcp is POST JSON-RPC (streamable-http), NOT an SSE GET stream — so the
 *  client transport MUST be `http`. `type:"sse"` does a GET that the dashboard catch-all
 *  302s to /auth/login. Keep the token on ONE line (header values reject newlines). */
export function claudeCodeSnippet(slug: string, origin: string): string {
  const key = mcpServerKey(slug)
  const config = {
    mcpServers: {
      [key]: {
        type: 'http',
        url: mcpEndpoint(origin),
        headers: {
          Authorization: 'Bearer <MEMBER_TOKEN>',
        },
      },
    },
  }
  return JSON.stringify(config, null, 2)
}

/** Codex `~/.codex/config.toml` snippet — `[mcp_servers.<slug>]` block.
 *  Codex uses streamable-http (the default for a `url`) — do NOT set transport="sse".
 *  The bearer comes from an env var (bearer_token_env_var) so the raw token is never
 *  in the file and can't pick up a paste-wrap newline inside the config. */
export function codexSnippet(slug: string, origin: string): string {
  const key = mcpServerKey(slug)
  const envVar = `${key.toUpperCase().replace(/-/g, '_')}_MCP_TOKEN`
  return [
    `[mcp_servers.${key}]`,
    `url = "${mcpEndpoint(origin)}"`,
    `bearer_token_env_var = "${envVar}"`,
    `# then: export ${envVar}=<MEMBER_TOKEN>   (one line, no quotes/newline)`,
  ].join('\n')
}

/** Normalize a tenant slug into a config-key-safe server name (fallback 'mupot'). */
export function mcpServerKey(slug: string): string {
  const cleaned = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned.length > 0 ? cleaned : 'mupot'
}

/**
 * wakeContractForAgent — build the WakeContract for an agent.
 *
 * Returns the machine-readable specification of HOW to fire an agent.wake event
 * at this specific agent via the mupot bus HTTP surface. Returned alongside
 * mcp_endpoint from mint_agent_token so the operator has everything in one flow.
 *
 * PURE: no DB, no env, no secrets. Accepts the resolved agent row fields and
 * the request origin (scheme+host only; used the same way as mcpEndpoint).
 *
 * The emit_url is the bus emit endpoint: POST /bus/emit with the body shape
 * filled in. The caller supplies the operator bearer token as the Authorization
 * header (never embedded in this contract).
 *
 * Cross-project boundary note (#115 / S175): this contract is for callers
 * within the SAME tenant pot. Waking agents across tenant boundaries (e.g.
 * kasra@mumega -> agent:dgd.admin) requires S175 cross-project bus multiplex
 * opt-in on the SOS layer — that is a runtime/infra change that this contract
 * documents but does not implement (see note field).
 */
export function wakeContractForAgent(
  agentId: string,
  squadId: string,
  tenant: string,
  origin: string,
): WakeContract {
  const base = origin.replace(/\/+$/, '')
  return {
    emit_url: `${base}/bus/emit`,
    auth_header: 'Authorization',
    body_shape: {
      type: 'agent.wake',
      agent_id: agentId,
      tenant,
      squad_id: squadId,
      payload: { reason: '<caller-supplied reason>', context: '<optional context string>' },
    },
    note:
      'POST emit_url with Authorization: Bearer <OPERATOR_TOKEN> and the body_shape JSON (fill in payload.reason). ' +
      'The bus consumer routes agent.wake to the AgentDO.wake() cycle immediately. ' +
      'Cross-tenant wake (S175) requires additional bus-layer opt-in — see issue #115.',
  }
}
