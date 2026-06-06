// mupot — connect-config helpers (PURE, dashboard-local).
//
// These build the copy-paste MCP client config a member pastes into their own
// workspace to reach this pot. They are PURE string builders (no DB, no env, no
// secret) so they can be unit-tested and reused by the dashboard Connect card.
//
// SECURITY: the snippets ALWAYS carry a literal `<MEMBER_TOKEN>` placeholder —
// never a real token. A raw token is shown EXACTLY ONCE on the mint show-once
// page, never woven into a reusable config snippet.

/** The pot's MCP endpoint, derived from the request origin (never hardcoded). */
export function mcpEndpoint(origin: string): string {
  // origin is the scheme+host the browser reached us on (e.g. https://pot.example).
  // We mount the MCP component at ROUTES.mcp ('/mcp'); join without a double slash.
  return `${origin.replace(/\/+$/, '')}/mcp`
}

/** Claude Code `.mcp.json` snippet — SSE transport, Bearer placeholder. */
export function claudeCodeSnippet(slug: string, origin: string): string {
  const key = mcpServerKey(slug)
  const config = {
    mcpServers: {
      [key]: {
        type: 'sse',
        url: mcpEndpoint(origin),
        headers: {
          Authorization: 'Bearer <MEMBER_TOKEN>',
        },
      },
    },
  }
  return JSON.stringify(config, null, 2)
}

/** Codex `~/.codex/config.toml` snippet — `[mcp_servers.<slug>]` block. */
export function codexSnippet(slug: string, origin: string): string {
  const key = mcpServerKey(slug)
  // TOML: a table header plus url + a bearer header. The header value carries the
  // placeholder only — the member swaps in their real token locally, never here.
  return [
    `[mcp_servers.${key}]`,
    `url = "${mcpEndpoint(origin)}"`,
    `transport = "sse"`,
    `[mcp_servers.${key}.headers]`,
    `Authorization = "Bearer <MEMBER_TOKEN>"`,
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
