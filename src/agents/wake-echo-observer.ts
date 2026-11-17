// Shared read observation boundary for the advisory wake-echo proof.
// Leaf module: it never imports the sender or changes inbox authorization.
import type { Env } from '../types'

export const WAKE_ECHO_WINDOW_MS = 10 * 60_000
export type WakeInboxReader = 'bearer' | 'signed' | 'lease' | 'lease_attempt'

export function wakeChallengeCutoff(observedAt:string):string {
  return new Date(Date.parse(observedAt)-WAKE_ECHO_WINDOW_MS).toISOString()
}

/** Trusted placeholder fragments only. Every valid challenge is written by its canonical
 * agent member. The existing actor/time index bounds old history without a candidate LIMIT
 * that could hide an active challenge behind newer unrelated audit rows. */
export function activeWakeChallengesSql(p:{tenant:string;agent:string;observed:string;cutoff:string}):string {
  return `SELECT c.id,c.created_at FROM agent_audit c INDEXED BY idx_agent_audit_actor_changes
    WHERE c.actor_id=(SELECT b.member_id FROM agent_member_bindings b WHERE b.tenant=${p.tenant} AND b.agent_id=${p.agent})
      AND c.created_at>=${p.cutoff} AND c.agent_id=${p.agent} AND c.action='connection_wake_challenge'
      AND julianday(json_extract(CASE WHEN json_valid(c.after_state) THEN c.after_state ELSE '{}' END,'$.expires_at'))>julianday(${p.observed})`
}

export async function recordWakeInboxRead(
  env:Env, agentId:string, reader:WakeInboxReader, peek:boolean, observedAt:string,
):Promise<void> {
  // A challenge may be created during a read. Its nonce cannot have been read before its
  // creation: clamp that overlapping witness to T0 rather than backdating it out of the window.
  // INSERT OR IGNORE retains the earliest witness. Persistence failure must block exposure.
  await env.DB.prepare(`INSERT OR IGNORE INTO agent_audit
    (id,agent_id,actor_id,actor_type,action,fields_changed,before_state,after_state)
    SELECT active.id||':poll',?1,'system:wake_echo_observer','system','connection_wake_inbox_read','[]','{}',
      json_set(?2,'$.observed_at',CASE WHEN julianday(active.created_at)>julianday(?3) THEN active.created_at ELSE ?3 END)
    FROM (${activeWakeChallengesSql({tenant:'?5',agent:'?1',observed:'?3',cutoff:'?4'})}) active`)
    .bind(agentId,JSON.stringify({observed_at:observedAt,reader,peek}),observedAt,wakeChallengeCutoff(observedAt),env.TENANT_SLUG).run()
}

/** Observe both sides of a non-folded operation. A zero-row pre-witness is not proof that
 * no challenge can appear before its read. The post-witness must finish before results escape. */
export async function withWakeInboxObservation<T>(
  env:Env,agentId:string,reader:WakeInboxReader,peek:boolean,observedAt:string,read:()=>Promise<T>,
):Promise<T> {
  await recordWakeInboxRead(env,agentId,reader,peek,observedAt)
  try {return await read()}
  finally {await recordWakeInboxRead(env,agentId,reader,peek,observedAt)}
}
