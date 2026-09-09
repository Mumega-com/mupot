// mupot — SQL for the agent-token lifecycle tools.
//
// THIS FILE EXISTS SO PRODUCTION AND ITS TEST CONSUME ONE QUERY SOURCE.
//
// mupot#684: list_agent_tokens shipped naming `member_tokens.capability`, a column
// that does not exist — a token's capability lives in `capabilities`, keyed by the
// token's member. D1 rejected the query and the tool returned internal_error on its
// first live call, while TWELVE unit tests passed. The mock returned canned rows and
// never executed the SQL.
//
// The first fix added a real-schema test — which HAND-COPIED the query. It therefore
// validated the copy. An adversarial gate mutated the handler's query only, recreating
// the exact outage, and the suite stayed 55/55 GREEN. A guard that reads a duplicate of
// the artifact is not a guard; it is a second place for the assumption to live.
//
// Hence a module with NO imports: `src/mcp/provision.ts` pulls the tool surface from
// `./index`, so importing provision from a test creates a cycle (PROVISION_TOOLS is not
// iterable). A dependency-free query module is importable by both without one.
//
// Rule for anything added here: the production handler must EXECUTE the exported string,
// and the real-schema test must EXECUTE THE SAME EXPORT — never a transcription of it.

/** The query `list_agent_tokens` executes. Bind: ?1 = agent id, ?2 = tenant. */
export function listAgentTokensQuery(includeRevoked: boolean): string {
  return `SELECT id, member_id, label, channel, created_at, revoked_at
       FROM member_tokens
      WHERE agent_id = ?1 AND tenant = ?2
        ${includeRevoked ? '' : 'AND revoked_at IS NULL'}
      ORDER BY created_at ASC`
}

/** The ownership lookup `revoke_agent_token` executes. Bind: ?1 = token id, ?2 = tenant.
 *  `channel` was added for Delivery Sequence step 2 (mumega-com#1173): revoking a
 *  token must also retire the agent_sessions row keyed to that SAME credential
 *  (src/auth/agent-sessions.ts deriveAgentAuthKind needs the channel to know
 *  which auth_kind bucket to look in). */
export function revokeTokenOwnershipQuery(): string {
  return `SELECT id, member_id, agent_id, label, channel, revoked_at
       FROM member_tokens WHERE id = ?1 AND tenant = ?2 LIMIT 1`
}
