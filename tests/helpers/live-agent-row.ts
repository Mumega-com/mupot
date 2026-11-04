// mupot#983: hand-rolled D1 fakes that serve a bound agent through a real door must answer the live
// bound-agent read (src/auth/bound-agent-live.ts). This is its row for a live agent with no owner/consenter.
export const LIVE_BOUND_AGENT_ROW = { status: 'active', owner_member_id: null, owner_status: null, consenter_status: null } as const

/** True for the one statement boundAgentIsLive prepares. */
export const isLiveBoundAgentSql = (sql: string): boolean => sql.includes('consenter_status') && sql.includes('owner_status')
