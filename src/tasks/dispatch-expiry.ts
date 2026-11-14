import type {Env} from '../types'
import {agentLiveness,livenessSnapshotMatchesSql} from '../agents/liveness'
import {DEAD_ASSIGNEE_RECLAIM_AFTER_MS} from './dead-assignee-reclaim'
import {inAirFlightForTaskSql} from '../hygiene/archive'
import {taskHeldSql} from '../agents/execution-brake-sql'
import {DISPATCH_BRIDGE_SENDER,DISPATCH_INBOX_PREFIX} from '../bus/fleet-bridge'

export const DISPATCH_EXPIRY_AGE_MS=7*86400000
export const DISPATCH_EXPIRY_LIMIT=25
export const DISPATCH_EXPIRY_SCAN_LIMIT=100
const REASON='dispatch_expired_no_receiver'
interface Row {seq:number;id:string;task_id:string;agent_id:string;created_at:string}
// No authority is inferred from elapsed time alone: retain all started/unknown custody.
function eligibleSql():string{
 return `d.settled_at IS NULL AND julianday(d.created_at)<julianday(?4)
  AND (d.delivered_via IS NULL OR d.delivered_via='inbox')
  AND (d.claim_expires_at IS NULL OR (typeof(d.claim_expires_at) IN ('integer','real') AND d.claim_expires_at<=?2))
  AND NOT EXISTS(SELECT 1 FROM task_dispatch_runtime_receipts r WHERE r.tenant=d.tenant AND r.dispatch_receipt_id=d.id)
  AND EXISTS(SELECT 1 FROM tasks t WHERE t.id=d.task_id AND t.workflow_instance_id IS NULL
    AND (t.execution_claim_expires_at IS NULL OR (typeof(t.execution_claim_expires_at) IN ('integer','real') AND t.execution_claim_expires_at<=?2))
    AND t.execution_receipt_id IS NULL
    AND NOT ${taskHeldSql('t.id')}
    AND NOT EXISTS(SELECT 1 FROM flights f WHERE f.tenant=d.tenant AND ${inAirFlightForTaskSql('t.id')}))
  AND NOT EXISTS(SELECT 1 FROM agent_messages m WHERE m.tenant=d.tenant AND m.from_agent='${DISPATCH_BRIDGE_SENDER}' AND m.request_id='${DISPATCH_INBOX_PREFIX}'||d.id
    AND (m.to_agent<>d.agent_id OR (m.read_at IS NOT NULL AND m.dead_lettered_at IS NULL)
      OR (m.lease_expires_at IS NOT NULL AND (julianday(m.lease_expires_at) IS NULL OR julianday(m.lease_expires_at)>julianday(?3)))))
  AND ((d.consumed_at IS NULL AND d.delivered_via IS NULL AND d.claimed_at IS NULL AND d.claim_expires_at IS NULL AND d.attempts=0) OR EXISTS(SELECT 1 FROM agent_messages m WHERE m.tenant=d.tenant
    AND m.from_agent='${DISPATCH_BRIDGE_SENDER}' AND m.request_id='${DISPATCH_INBOX_PREFIX}'||d.id AND m.to_agent=d.agent_id
    AND (m.read_at IS NULL OR m.dead_lettered_at IS NOT NULL)))`
}

/** Bounded dispatch-side retirement. No task state/pointer write, runtime impersonation or mail. */
export async function expireAbandonedDispatches(env:Env,opts:{nowMs?:number}={}){
 const now=opts.nowMs??Date.now(),iso=new Date(now).toISOString(),cut=new Date(now-DISPATCH_EXPIRY_AGE_MS).toISOString()
 const result={scanned:0,attempted:0,expired:0,lost:0,failed:0,cursor_failed:false}
 // Numeric cursor is progress metadata, not an enforcement flag. It prevents live head rows starving later candidates.
 const key=`maintenance:dispatch-expiry-cursor:${env.TENANT_SLUG}`
 const prior=await env.DB.prepare('SELECT value FROM org_settings WHERE key=?1').bind(key).first<{value:string}>()
 const parsed=Number(prior?.value??0),cursor=Number.isSafeInteger(parsed)&&parsed>=0?parsed:0
 const page=async(after:number)=>(await env.DB.prepare(`SELECT d.rowid AS seq,d.id,d.task_id,d.agent_id,d.created_at FROM task_dispatch_receipts d
   JOIN tasks t ON t.id=d.task_id WHERE d.tenant=?1 AND d.settled_at IS NULL AND julianday(d.created_at)<julianday(?2)
   AND d.rowid>?3 ORDER BY d.rowid LIMIT ${DISPATCH_EXPIRY_SCAN_LIMIT}`).bind(env.TENANT_SLUG,cut,after).all<Row>()).results??[]
 let rows=await page(cursor);if(!rows.length&&cursor>0)rows=await page(0)
 result.scanned=rows.length
 const states=await agentLiveness(env,[...new Set(rows.map(r=>r.agent_id))],now)
 for(const row of rows){
  if(result.attempted>=DISPATCH_EXPIRY_LIMIT)break
  const state=states.get(row.agent_id)
  if(!state||state.state!=='dead'||state.mode!=='resident'||state.operatorPaused||state.deadSinceMs===null||state.deadSinceMs>=now-DEAD_ASSIGNEE_RECLAIM_AFTER_MS||state.snapshot===null)continue
  result.attempted++
  const auditId=crypto.randomUUID(),request=`dispatch-expiry:${row.id}`
  try {
   const writes=await env.DB.batch([
    env.DB.prepare(`UPDATE task_dispatch_receipts AS d SET settled_stage='failed',settled_at=?3,settled_reason='${REASON}',claim_expires_at=NULL
      WHERE d.tenant=?1 AND d.id=?5 AND d.agent_id=?6 AND ${eligibleSql()}
      AND ${livenessSnapshotMatchesSql(env,{tenant:'?1',agentId:'?6',snapshot:'?7',now:'?2'})}`)
      .bind(env.TENANT_SLUG,now,iso,cut,row.id,row.agent_id,state.snapshot),
    env.DB.prepare(`INSERT INTO mutation_audit_entries(id,tenant,principal_kind,principal_id,agent_id,origin,handler,operation,target_kind,target_id,task_id,request_id,idempotency_key,evidence_json,recorded_at)
      SELECT ?1,?2,'system','dispatch-expiry',?3,'scheduled_job','dispatch-expiry','${REASON}','dispatch_receipt',?4,?5,?8,?8,?7,?6 WHERE changes()=1`)
      .bind(auditId,env.TENANT_SLUG,row.agent_id,row.id,row.task_id,iso,JSON.stringify({reason:REASON,stage:'failed',created_at:row.created_at,age_window_ms:DISPATCH_EXPIRY_AGE_MS,dead_since_ms:state.deadSinceMs,receiver_snapshot:state.snapshot}),request),
    env.DB.prepare(`UPDATE agent_messages SET dead_lettered_at=?3,dead_letter_reason='${REASON}',lease_expires_at=NULL,lease_attempt_id=NULL
      WHERE tenant=?1 AND from_agent='${DISPATCH_BRIDGE_SENDER}' AND request_id='${DISPATCH_INBOX_PREFIX}'||?2 AND to_agent=?5
      AND read_at IS NULL AND dead_lettered_at IS NULL
      AND EXISTS(SELECT 1 FROM mutation_audit_entries WHERE id=?4 AND tenant=?1)
      AND EXISTS(SELECT 1 FROM task_dispatch_receipts WHERE id=?2 AND tenant=?1 AND settled_stage='failed' AND settled_at=?3 AND settled_reason='${REASON}')`)
      .bind(env.TENANT_SLUG,row.id,iso,auditId,row.agent_id),
   ])
   if(Number(writes[0].meta?.changes??0)===1)result.expired++;else result.lost++
  }catch{result.failed++}
 }
 // CAS avoids a slower concurrent scanner overwriting a newer cursor. Wrap is intentional.
 try {
 await env.DB.prepare(`INSERT INTO org_settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE org_settings.value IS ?3`)
   .bind(key,String(rows.at(-1)?.seq??0),prior?.value??null).run()
 }catch{result.cursor_failed=true}
 return result
}
