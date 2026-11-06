import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { agentLiveness } from '../src/agents/liveness'
import { reclaimDeadAssignments } from '../src/tasks/dead-assignee-reclaim'
import { recordTaskDispatchRuntimeReceipt } from '../src/tasks/runtime-receipts'
import { evaluateReceiverLiveness, getFleetAgentLiveness } from '../src/fleet/registry'
import { resolveDispatchDeliveryMode } from '../src/bus/consumer'
import { MAINTENANCE_FIRING_MINUTES, maintenanceSlot } from '../src/scheduled/slots'
import type { Env } from '../src/types'
import * as messages from '../src/agents/messages'
const TENANT='liveness-pot',NOW=Date.parse('2026-11-05T20:00:00.000Z'),DAY=86400000
let h:SqliteD1Harness,env:Env,interleave:(()=>void)|undefined
beforeEach(()=>{
 h=createSqliteD1();applyAllMigrations(h.sqlite);interleave=undefined
 h.sqlite.exec(`INSERT INTO departments(id,slug,name) VALUES('d','d','D'); INSERT INTO squads(id,department_id,slug,name) VALUES('s','d','s','S');
 INSERT INTO members(id,tenant,display_name,status) VALUES('owner','${TENANT}','Owner','active');
 INSERT INTO agents(id,squad_id,slug,name,status,owner_member_id) VALUES('a','s','runner','Runner','active','owner'),('owner-inbox','s','owner-inbox','Owner inbox','active','owner');
 INSERT INTO presence(tenant,member_id,display_name,source,label,agent_id,first_seen_at,last_seen_at) VALUES('${TENANT}','owner','Owner','test','owner-inbox','owner-inbox','${new Date(NOW).toISOString()}','${new Date(NOW).toISOString()}');`)
 env={DB:{...h.db,batch:async statements=>{const hook=interleave;interleave=undefined;hook?.();return h.db.batch(statements)}},TENANT_SLUG:TENANT,BUS:{send:vi.fn(async()=>undefined)}} as unknown as Env
})
afterEach(()=>{vi.restoreAllMocks();h.close()})
function fleet(age:number,mode='resident',status='running',key='a',ttl=180){
 h.sqlite.prepare(`INSERT INTO fleet_agents(tenant,agent_id,display,runtime,squads,lifecycle,status,reported_by,last_reported_at,updated_at,presence_mode,presence_ttl_sec,connection_kind)
 VALUES(?,?,'Runner',?,'[]','always_on',?,'test',?,?,?,?,'fleet_attach') ON CONFLICT(tenant,agent_id) DO UPDATE SET runtime=excluded.runtime,status=excluded.status,last_reported_at=excluded.last_reported_at,presence_mode=excluded.presence_mode,presence_ttl_sec=excluded.presence_ttl_sec`)
 .run(TENANT,key,mode==='poll'?'':'claude-code',status,new Date(NOW-age).toISOString(),new Date(NOW-age).toISOString(),mode,ttl)
}
function task(id='t',status='open'){h.sqlite.prepare("INSERT INTO tasks(id,squad_id,title,done_when,status,assignee_agent_id,created_at,updated_at) VALUES(?,'s','Work','done',?,'a','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").run(id,status)}
function dead(){fleet(DAY+360000+1000)}
function row(id='t'){return h.sqlite.prepare('SELECT status,assignee_agent_id FROM tasks WHERE id=?').get(id) as {status:string;assignee_agent_id:string|null}}
const audit=()=>h.sqlite.prepare("SELECT * FROM mutation_audit_entries WHERE operation='dead_assignee_reclaim'").all()
const notices=()=>h.sqlite.prepare("SELECT * FROM agent_messages WHERE from_agent='mupot-task-reclaim'").all() as {to_agent:string;body:string}[]
const sweep=(opts:Record<string,unknown>={})=>reclaimDeadAssignments(env,{nowMs:NOW,...opts})
function pause(){h.sqlite.prepare("INSERT INTO execution_pauses(id,tenant,scope_type,scope_id,reason,paused_by_member_id,paused_at) VALUES('pause',?,'agent','a','Operator pause','owner',?)").run(TENANT,new Date(NOW).toISOString())}

describe('agentLiveness contract',()=>{
 it.each([
  ['resident fresh',0,'resident','running','live'],['resident boundary',180000,'resident','running','live'],
  ['resident stale',180001,'resident','running','stale'],['resident second boundary',360000,'resident','running','stale'],
  ['resident dead',360001,'resident','running','dead'],['poll fresh',0,'poll','running','live'],
  ['poll stale',30*DAY,'poll','running','stale'],['stopped poll',0,'poll','stopped','paused'],['stopped resident',0,'resident','stopped','paused'],
 ] as const)('%s keeps delivery and eligibility consistent with dispatch',async(_name,age,mode,status,state)=>{
  fleet(age,mode,status)
  const result=(await agentLiveness(env,['a'],NOW)).get('a')!
  const fence=await evaluateReceiverLiveness(env,'a',NOW),route=await getFleetAgentLiveness(env,'a',NOW)
  expect(result.state).toBe(state);expect(result.executionEligible).toBe(fence.ok)
  expect(result.deliveryMode).toBe(resolveDispatchDeliveryMode(route,false));expect(result.fresh).toBe(route.live)
 })
 it('uses the registered per-row TTL',async()=>{fleet(3600000,'poll','running','a',7200);expect((await agentLiveness(env,['a'],NOW)).get('a')).toMatchObject({state:'live',ttlSeconds:7200})})
 it('unproven in-Worker fallback has no auto-assignment or death proof',async()=>{
  const r=(await agentLiveness(env,['a'],NOW)).get('a')!;expect(r).toMatchObject({state:'stale',mode:'in_worker',deliveryMode:'in_worker',executionEligible:true,assignmentEligible:false,deadSinceMs:null})
 })
 it('unknown agents and invalid stamps cannot supply reclaim evidence',async()=>{
  fleet(DAY*2)
  for(const stamp of ['not-a-date','']) {
   h.sqlite.prepare('UPDATE fleet_agents SET last_reported_at=?').run(stamp)
   expect((await agentLiveness(env,['a','missing'],NOW)).get('a')).toMatchObject({state:'stale',deadSinceMs:null})
  }
  expect((await agentLiveness(env,['missing'],NOW)).get('missing')).toMatchObject({state:'stale',executionEligible:false,deadSinceMs:null})
 })
 it('operator pause overrides heartbeat freshness',async()=>{fleet(0);pause();expect((await agentLiveness(env,['a'],NOW)).get('a')).toMatchObject({state:'paused',executionEligible:false})})
 it('exact UUID wins over a legacy slug row and ambiguous slugs never supply death proof',async()=>{
  fleet(0);fleet(DAY*3,'resident','running','runner')
  expect((await agentLiveness(env,['a'],NOW)).get('a')?.state).toBe('live')
  h.sqlite.exec("DELETE FROM fleet_agents WHERE agent_id='a'; INSERT INTO squads(id,department_id,slug,name) VALUES('s2','d','s2','S2'); INSERT INTO agents(id,squad_id,slug,name,status) VALUES('b','s2','runner','Other','active')")
  expect((await agentLiveness(env,['a'],NOW)).get('a')?.deadSinceMs).toBeNull()
 })
 it('batch reads are bounded independently of the number of agent IDs',async()=>{
  let reads=0;const db=env.DB;env={...env,DB:{...db,prepare:sql=>{reads++;return db.prepare(sql)}}} as Env
  for(let i=0;i<40;i++)h.sqlite.prepare("INSERT INTO agents(id,squad_id,slug,name,status) VALUES(?,'s',?,'A','active')").run(`x${i}`,`x${i}`)
  expect((await agentLiveness(env,Array.from({length:40},(_,i)=>`x${i}`),NOW)).size).toBe(40);expect(reads).toBeLessThanOrEqual(2)
 })
})

describe('dead-assignee reclaim',()=>{
 it.each(['open','in_progress'])('reopens long-dead %s work with audit and owner inbox note',async status=>{
  dead();task('t',status);expect((await sweep()).reclaimed).toBe(1)
  expect(row()).toEqual({status:'open',assignee_agent_id:null});expect(audit()).toHaveLength(1)
  expect(notices()).toHaveLength(1);expect(notices()[0].to_agent).toBe('owner-inbox');expect(notices()[0].body).toContain('t')
  expect((await sweep()).reclaimed).toBe(0);expect(notices()).toHaveLength(1)
 })
 it.each(['stale','young-dead','poll','worker','paused','stopped','invalid'] as const)('leaves %s agents alone',async kind=>{
  if(kind==='stale')fleet(240000);else if(kind==='young-dead')fleet(DAY-1);else if(kind==='poll')fleet(30*DAY,'poll');else if(kind==='stopped')fleet(30*DAY,'resident','stopped');else if(kind!=='worker')dead()
  if(kind==='paused')pause();if(kind==='invalid')h.sqlite.exec("UPDATE fleet_agents SET last_reported_at='invalid'")
  task();expect((await sweep()).reclaimed).toBe(0);expect(row().assignee_agent_id).toBe('a');expect(audit()).toHaveLength(0)
 })
 it('requires strictly more than 24 hours of proven dead state',async()=>{
  fleet(DAY+360000);task();expect((await sweep()).reclaimed).toBe(0);expect((await sweep({nowMs:NOW+1})).reclaimed).toBe(1)
 })
 it.each(['review','approved','done','blocked','rejected'])('never touches %s work',async status=>{dead();task('t',status);h.sqlite.prepare("UPDATE tasks SET gate_owner='gate:review' WHERE id='t'").run();expect((await sweep()).reclaimed).toBe(0);expect(row()).toEqual({status,assignee_agent_id:'a'})})
 it.each(['live-claim','unaccounted-receipt','dispatch','flight','archived'])('respects %s custody',async kind=>{
  dead();task('t','in_progress')
  if(kind==='live-claim')h.sqlite.prepare('UPDATE tasks SET execution_claim_expires_at=? WHERE id=\'t\'').run(NOW+1000)
  if(kind==='unaccounted-receipt')h.sqlite.exec("UPDATE tasks SET execution_receipt_id='receipt' WHERE id='t'")
  if(kind==='dispatch')h.sqlite.prepare("INSERT INTO task_dispatch_receipts(id,tenant,task_id,squad_id,agent_id,actor_kind,actor_id,created_at) VALUES('dispatch',?,'t','s','a','agent','a',?)").run(TENANT,new Date(NOW).toISOString())
  if(kind==='flight')h.sqlite.prepare("INSERT INTO flights(id,tenant,agent,goal,status,budget_micro_usd,cost_micro_usd,cost_metered,created_at,started_at,meta) VALUES('flight',?,'a','G','running',100,0,1,?,?,?)").run(TENANT,NOW,NOW,JSON.stringify({task_ids:['t']}))
  if(kind==='archived')h.sqlite.prepare("INSERT INTO tasks_archive_state(task_id,archived_at,archived_reason,archived_by_member_id,prior_status) VALUES('t',?,'x','owner','in_progress')").run(new Date(NOW).toISOString())
  expect((await sweep()).reclaimed).toBe(0);expect(row().assignee_agent_id).toBe('a');expect(audit()).toHaveLength(0)
  if(kind==='live-claim')expect(h.sqlite.prepare("SELECT execution_claim_expires_at FROM tasks WHERE id='t'").get()).toEqual({execution_claim_expires_at:NOW+1000})
  if(kind==='unaccounted-receipt')expect(h.sqlite.prepare("SELECT execution_receipt_id FROM tasks WHERE id='t'").get()).toEqual({execution_receipt_id:'receipt'})
 })
 it('may reclaim an expired execution receipt when no other custody remains',async()=>{dead();task('t','in_progress');h.sqlite.prepare("UPDATE tasks SET execution_receipt_id='old',execution_claim_expires_at=? WHERE id='t'").run(NOW-1);expect((await sweep()).reclaimed).toBe(1)})
 it.each(['assignment','heartbeat','pause','claim','review','owner','rowedit','archived','stopped','agent-paused','ttl'])('a concurrent %s change wins without audit or notice',async kind=>{
  dead();task()
  interleave=()=>{
   if(kind==='assignment')h.sqlite.exec("UPDATE tasks SET assignee_agent_id='owner-inbox' WHERE id='t'")
   if(kind==='heartbeat')h.sqlite.prepare("UPDATE fleet_agents SET last_reported_at=? WHERE agent_id='a'").run(new Date(NOW).toISOString())
   if(kind==='pause')pause();if(kind==='claim')h.sqlite.prepare("UPDATE tasks SET execution_claim_expires_at=? WHERE id='t'").run(NOW+1000)
   if(kind==='review')h.sqlite.exec("UPDATE tasks SET status='review' WHERE id='t'")
   if(kind==='owner')h.sqlite.exec("UPDATE agents SET owner_member_id=NULL WHERE id='a'")
   if(kind==='rowedit')h.sqlite.exec("UPDATE tasks SET updated_at='2026-11-05T19:59:59Z' WHERE id='t'")
   if(kind==='stopped')h.sqlite.exec("UPDATE fleet_agents SET status='stopped' WHERE agent_id='a'")
   if(kind==='agent-paused')h.sqlite.exec("UPDATE agents SET status='paused' WHERE id='a'")
   if(kind==='ttl')h.sqlite.exec("UPDATE fleet_agents SET presence_ttl_sec=7200 WHERE agent_id='a'")
   if(kind==='archived')h.sqlite.prepare("INSERT INTO tasks_archive_state(task_id,archived_at,archived_reason,archived_by_member_id,prior_status) VALUES('t',?,'x','owner','open')").run(new Date(NOW).toISOString())
  }
  expect((await sweep()).reclaimed).toBe(0);expect(audit()).toHaveLength(0);expect(notices()).toHaveLength(0)
 })
 it('never records a reclaim when its audit insert fails',async()=>{dead();task();h.sqlite.exec("CREATE TRIGGER fail_reclaim_audit BEFORE INSERT ON mutation_audit_entries BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;");const result=await sweep();expect(result.reclaimed).toBe(0);expect(result.failed).toBe(1);expect(row().assignee_agent_id).toBe('a')})
 it('owner inbox failures do not undo committed reclaim',async()=>{dead();task();h.sqlite.exec("CREATE TRIGGER fail_reclaim_note BEFORE INSERT ON agent_messages BEGIN SELECT RAISE(ABORT,'inbox unavailable'); END;");expect((await sweep()).reclaimed).toBe(1);expect(audit()).toHaveLength(1);expect(row().assignee_agent_id).toBeNull()})
 it.each(['no-owner','no-other-agent'])('keeps an audit-only record for %s',async mode=>{dead();task();if(mode==='no-owner')h.sqlite.exec("UPDATE agents SET owner_member_id=NULL WHERE id='a'");else h.sqlite.exec("UPDATE agents SET owner_member_id=NULL WHERE id='owner-inbox'");expect((await sweep()).reclaimed).toBe(1);expect(audit()).toHaveLength(1);expect(notices()).toHaveLength(0)})
 it('reclaims at most 25 tasks per tick and makes progress on the next tick',async()=>{dead();for(let i=0;i<28;i++)task(`t${i}`);expect((await sweep()).reclaimed).toBe(25);expect((await sweep()).reclaimed).toBe(3);expect(audit()).toHaveLength(28)})
 it('retains reclaim at slot 19 and pins the 22-job maintenance cadence',()=>{
  const source=readFileSync(new URL('../src/index.ts',import.meta.url),'utf8');const list=source.slice(source.indexOf('const maintenance:'))
  const names=[...list.matchAll(/\['([^']+)',/g)].map(m=>m[1]);expect(names).toHaveLength(22);expect(names[19]).toBe('dead-assignee-reclaim');expect(names.slice(20)).toEqual(['archive-proposal-expiry','elevation-expiry']); for(let slot=0;slot<22;slot++)expect(MAINTENANCE_FIRING_MINUTES.filter(m=>maintenanceSlot(m,22)===slot)).toHaveLength(slot<18?2:1)
  expect(MAINTENANCE_FIRING_MINUTES.filter(m=>maintenanceSlot(m,names.length)===19)).toEqual([24])
  expect(MAINTENANCE_FIRING_MINUTES.filter(m=>maintenanceSlot(m,names.length)===20)).toEqual([30])
  expect(MAINTENANCE_FIRING_MINUTES.filter(m=>maintenanceSlot(m,names.length)===21)).toEqual([31])
 })
})

it('owner notices reach every other owned agent and no foreign owner',async()=>{
 dead();task();h.sqlite.exec("INSERT INTO members(id,tenant,display_name,status) VALUES('foreign','liveness-pot','Foreign','active'); INSERT INTO agents(id,squad_id,slug,name,status,owner_member_id) VALUES('other-inbox','s','other-inbox','Other','active','owner'),('foreign-inbox','s','foreign-inbox','Foreign','active','foreign')")
 h.sqlite.prepare("INSERT INTO presence(tenant,member_id,display_name,source,label,agent_id,first_seen_at,last_seen_at) VALUES(?,'owner','Other','test','other-inbox','other-inbox',?,?)").run(TENANT,new Date(NOW).toISOString(),new Date(NOW).toISOString())
 expect((await sweep()).reclaimed).toBe(1);expect(notices().map(n=>n.to_agent).sort()).toEqual(['other-inbox','owner-inbox'])
})
it('a foreign-tenant fleet row cannot establish death',async()=>{
 dead();h.sqlite.exec("UPDATE fleet_agents SET tenant='foreign-pot'");task()
 expect((await agentLiveness(env,['a'],NOW)).get('a')).toMatchObject({mode:'in_worker',state:'stale',assignmentEligible:false,deadSinceMs:null})
 expect((await sweep()).reclaimed).toBe(0)
})
it('batch chunking returns every requested identity without silent truncation',async()=>{
 const ids=Array.from({length:201},(_,i)=>`bulk-${i}`)
 for(const id of ids)h.sqlite.prepare("INSERT INTO agents(id,squad_id,slug,name,status) VALUES(?,'s',?,'Agent','active')").run(id,id)
 expect((await agentLiveness(env,ids,NOW)).size).toBe(201)
})

it('a canonical ID reserving a legacy slug prevents fallback death proof',async()=>{
 fleet(3*DAY,'resident','running','runner')
 h.sqlite.exec("INSERT INTO agents(id,squad_id,slug,name,status) VALUES('runner','s','reserved-agent','Reserved','active')")
 expect((await agentLiveness(env,['a'],NOW)).get('a')).toMatchObject({mode:'in_worker',deadSinceMs:null})
})
it('agent pause and archival intent block automatic assignment',async()=>{
 h.sqlite.exec("UPDATE agents SET status='paused' WHERE id='a'")
 expect((await agentLiveness(env,['a'],NOW)).get('a')).toMatchObject({state:'paused',assignmentEligible:false})
 h.sqlite.exec("UPDATE agents SET status='active',archived_at='2026-11-05T19:00:00Z' WHERE id='a'")
 expect((await agentLiveness(env,['a'],NOW)).get('a')).toMatchObject({assignmentEligible:false,executionEligible:false})
})

it('an owner in another tenant receives no reclaim note',async()=>{
 dead();task();h.sqlite.exec("UPDATE members SET tenant='foreign-pot' WHERE id='owner'")
 expect((await sweep()).reclaimed).toBe(1);expect(notices()).toHaveLength(0)
})
it('a rejected notification target does not prevent later owner targets',async()=>{
 dead();task();h.sqlite.exec("INSERT INTO agents(id,squad_id,slug,name,status,owner_member_id) VALUES('z-owner-inbox','s','z-owner-inbox','Other','active','owner')")
 h.sqlite.prepare("INSERT INTO presence(tenant,member_id,display_name,source,label,agent_id,first_seen_at,last_seen_at) VALUES(?,'owner','Other','test','z-owner-inbox','z-owner-inbox',?,?)").run(TENANT,new Date(NOW).toISOString(),new Date(NOW).toISOString())
 vi.spyOn(messages,'sendAgentMessage').mockRejectedValueOnce(new Error('delivery unavailable'))
 const r=await sweep();expect(r.reclaimed).toBe(1);expect(r.failed).toBe(0);expect(r.notified).toBe(1);expect(notices().map(n=>n.to_agent)).toEqual(['z-owner-inbox'])
})
it('an owner lookup failure after commit is best effort',async()=>{
 dead();task();let fail=false;const db=env.DB
 env={...env,DB:{...db,prepare:(sql:string)=>{if(fail){fail=false;throw new Error('lookup unavailable')}return db.prepare(sql)},batch:async statements=>{const r=await db.batch(statements);fail=true;return r}}} as Env
 const r=await sweep();expect(r.reclaimed).toBe(1);expect(r.failed).toBe(0);expect(r.notified).toBe(0);expect(audit()).toHaveLength(1)
})

it('clears only proved-expired execution markers and retains their audit evidence',async()=>{
 dead();task('t','in_progress');h.sqlite.prepare("UPDATE tasks SET execution_receipt_id='old-worker',execution_claim_expires_at=? WHERE id='t'").run(NOW-1)
 expect((await sweep()).reclaimed).toBe(1)
 expect(h.sqlite.prepare("SELECT execution_receipt_id,execution_claim_expires_at FROM tasks WHERE id='t'").get()).toEqual({execution_receipt_id:null,execution_claim_expires_at:null})
 const evidence=JSON.parse((audit()[0] as {evidence_json:string}).evidence_json)
 expect(evidence).toMatchObject({previous_execution_receipt_id:'old-worker',previous_execution_claim_expires_at:NOW-1})
})
it.each(['receipt','claim'])('a concurrent expired %s marker change wins so audit evidence stays exact',async kind=>{
 dead();task();h.sqlite.prepare("UPDATE tasks SET execution_receipt_id='old-worker',execution_claim_expires_at=? WHERE id='t'").run(NOW-1)
 interleave=()=>{if(kind==='receipt')h.sqlite.exec("UPDATE tasks SET execution_receipt_id='other-old-worker' WHERE id='t'");else h.sqlite.prepare("UPDATE tasks SET execution_claim_expires_at=? WHERE id='t'").run(NOW-2)}
 expect((await sweep()).reclaimed).toBe(0);expect(audit()).toHaveLength(0)
})
it('a reclaimed task can subsequently be claimed by an external inbox runtime',async()=>{
 dead();task('t','in_progress');h.sqlite.prepare("UPDATE tasks SET execution_receipt_id='orphan-worker',execution_claim_expires_at=? WHERE id='t'").run(NOW-1)
 expect((await sweep()).reclaimed).toBe(1)
 h.sqlite.exec(`INSERT INTO members(id,tenant,display_name,status) VALUES('external-member','${TENANT}','External','active');
 INSERT INTO capabilities(id,member_id,scope_type,scope_id,capability) VALUES('external-cap','external-member','squad','s','member');
 INSERT INTO agent_member_bindings(tenant,agent_id,member_id,created_at) VALUES('${TENANT}','owner-inbox','external-member','2026-01-01T00:00:00Z');
 INSERT INTO member_tokens(id,member_id,token_hash,label,channel,created_at,agent_id,tenant,expires_at) VALUES('external-token','external-member','external-test-hash','test','workspace','2026-01-01T00:00:00Z','owner-inbox','${TENANT}','2099-01-01T00:00:00Z');
 UPDATE tasks SET assignee_agent_id='owner-inbox' WHERE id='t';`)
 fleet(0,'poll','running','owner-inbox')
 h.sqlite.prepare("INSERT INTO task_dispatch_receipts(id,tenant,task_id,squad_id,agent_id,actor_kind,actor_id,created_at,claimed_at,consumed_at,attempts) VALUES('external-dispatch',?,'t','s','owner-inbox','member','external-member',?,?,?,1)").run(TENANT,new Date(NOW).toISOString(),new Date(NOW).toISOString(),new Date(NOW).toISOString())
 h.sqlite.prepare("INSERT INTO agent_messages(id,tenant,to_agent,from_agent,from_member,kind,body,request_id,created_at,delivery_attempts,lease_expires_at) VALUES('external-message',?,'owner-inbox','mupot-dispatch','external-member','request',?,'dispatch-inbox:external-dispatch',?,1,'2099-01-01T00:00:00Z')")
 .run(TENANT,JSON.stringify({version:'runtime.dispatch/v1',type:'task_dispatch',task_id:'t',dispatch_receipt_id:'external-dispatch',squad_id:'s',runtime_address:'owner-inbox'}),new Date(NOW).toISOString())
 const auth={userId:'external-member',tenant:TENANT,channel:'workspace' as const,role:'member' as const,memberId:'external-member',tokenId:'external-token',boundAgentId:'owner-inbox',capabilities:[{member_id:'external-member',scope_type:'squad' as const,scope_id:'s',capability:'member' as const}]}
 const result=await recordTaskDispatchRuntimeReceipt(env,auth,{taskId:'t',dispatchReceiptId:'external-dispatch',messageId:'external-message',stage:'runtime_consumed',runtimeReceiptHash:'a'.repeat(64),attempt:1})
 expect(result.task_status).toBe('in_progress')
 expect(h.sqlite.prepare("SELECT execution_receipt_id FROM tasks WHERE id='t'").get()).toEqual({execution_receipt_id:'external-dispatch'})
})
