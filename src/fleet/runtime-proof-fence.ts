import type { Env } from '../types'

/** Keep runtime transitions durable even if the label later changes back. The witness and
 * registry write commit together; unchanged reports do not invalidate wake evidence. */
export async function writeRuntimeWithProofFence(env:Env, input:{agentId:string;runtime:string|null;actorId:string;source:string;insertOnly?:boolean}, mutation:D1PreparedStatement) {
  if(input.runtime===null) return mutation.run()
  // Fleet discovery also holds external/unresolved labels. They have no canonical agent or wake proof.
  const canonical=await env.DB.prepare('SELECT 1 FROM agents WHERE id = ?1 LIMIT 1').bind(input.agentId).first()
  if(!canonical) return mutation.run()
  const audit=env.DB.prepare(`INSERT INTO agent_audit
    (id,agent_id,actor_id,actor_type,action,fields_changed,before_state,after_state)
    SELECT ?1,?2,?3,'system','fleet_runtime_transition','["runtime"]','{}',?4
    WHERE EXISTS (SELECT 1 FROM agents WHERE id=?2)
      AND (SELECT runtime FROM fleet_agents WHERE tenant=?5 AND agent_id=?2 LIMIT 1) IS NOT ?6
      AND (?7=0 OR NOT EXISTS (SELECT 1 FROM fleet_agents WHERE tenant=?5 AND agent_id=?2))`)
    .bind(crypto.randomUUID(),input.agentId,input.actorId,JSON.stringify({runtime:input.runtime,source:input.source}),env.TENANT_SLUG,input.runtime,input.insertOnly?1:0)
  const results=await env.DB.batch([audit,mutation])
  return results[1]
}
