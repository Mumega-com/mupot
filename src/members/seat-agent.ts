// seat-agent — ONE predicate for "this agent is a thread's seat identity, not a roster member".
//
// Every explicit (source 'select') or auto seat owns a kind=home agent (slug `seat-…`) that
// exists only so a chat thread can act. Strangers reading an agent roster (peers, squad_member_list)
// must not see them: they are per-conversation plumbing and they grow without bound. The authority
// is agent_seats (written by the server, never by a caller), not the slug prefix, which a human could
// imitate. The agent stays resolvable by slug/id (resolve_agent) and a member still sees their own
// seats through status.seat_roster; only roster LISTS use this fragment.

/** SQL fragment: true for agents that are NOT seat agents. `alias` is the agents table alias. Constant text, no binds. */
export function notSeatAgentSql(alias: string): string {
  if (!/^[a-z][a-z0-9_]*$/i.test(alias)) throw new Error('invalid sql alias')
  return `NOT EXISTS (SELECT 1 FROM agent_seats _sa WHERE _sa.agent_id = ${alias}.id)`
}
