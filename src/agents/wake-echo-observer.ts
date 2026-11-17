// Metadata-only witness for an agent's inbox polling during an active wake echo.
// Leaf module: inbox readers depend on it without depending on the echo sender.
import type { Env } from '../types'

export async function recordWakeInboxRead(
  env: Env, agentId: string, reader: 'bearer' | 'signed' | 'lease' | 'lease_attempt', peek: boolean, observedAt: string,
): Promise<void> {
  // Observe before exposing/consuming mail. If this write fails the caller must not
  // expose a nonce and later let an absent witness look like evidence of no poll.
  // This is conservative: a validated read attempt that later fails can only make
  // the current echo unproven. No proof or dispatch permission is created here.
  await env.DB.prepare(`INSERT INTO agent_audit
    (id,agent_id,actor_id,actor_type,action,fields_changed,before_state,after_state)
    SELECT ?1,?2,'system:wake_echo_observer','system','connection_wake_inbox_read','[]','{}',?3
    WHERE EXISTS (SELECT 1 FROM agent_audit c
      WHERE c.agent_id=?2 AND c.action='connection_wake_challenge'
        AND julianday(json_extract(CASE WHEN json_valid(c.after_state) THEN c.after_state ELSE '{}' END,'$.expires_at')) > julianday(?4))`)
    .bind(crypto.randomUUID(),agentId,JSON.stringify({ observed_at: observedAt, reader, peek }),observedAt).run()
}
