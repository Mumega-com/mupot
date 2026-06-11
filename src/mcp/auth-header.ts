// auth-header.ts — internal header key for pre-resolved AuthContext.
//
// Split into its own module (no cloudflare:workers import) so Vitest can
// import this constant without pulling in the CF runtime. The header is set
// by McpOAuthApiHandler (src/mcp/oauth-api-handler.ts) and read by resolveAuth
// in src/mcp/index.ts.
//
// SECURITY: this header is Worker-internal only. External clients POST directly
// to the OAuthProvider wrapper which validates the token before dispatching to
// McpOAuthApiHandler. An external client setting this header cannot reach mcpApp
// directly without going through the OAuthProvider.

export const AUTH_CONTEXT_HEADER = 'x-mupot-auth-context'
