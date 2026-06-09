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
