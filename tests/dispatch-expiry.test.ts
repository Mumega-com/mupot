import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {createSqliteD1,type SqliteD1Harness} from './helpers/sqlite-d1'
import {applyAllMigrations} from './helpers/migrations'
import {hasArchiveBlockingDispatch} from '../src/tasks/runtime-receipts'
import {deliverDispatchToInbox,DISPATCH_BRIDGE_SENDER,dispatchInboxRequestId} from '../src/bus/fleet-bridge'
import type {Env,BusEvent} from '../src/types'
import type {MessageBatch} from '@cloudflare/workers-types'
import {handleQueue} from '../src/bus/consumer'
const DAY=86400000,NOW=Date.now(),OLD=new Date(NOW-8*DAY).toISOString(),TENANT='expiry'
let h:SqliteD1Harness,env:Env
beforeEach(()=>{
 h=createSqliteD1();applyAllMigrations(h.sqlite);env={DB:h.db,TENANT_SLUG:TENANT} as Env
 h.sqlite.exec(`INSERT INTO departments(id,slug,name) VALUES('d','d','D');INSERT INTO squads(id,department_id,slug,name) VALUES('s','d','s','S');
 INSERT INTO members(id,tenant,display_name,status) VALUES('owner','expiry','Owner','active');
 INSERT INTO agents(id,squad_id,slug,name,status) VALUES('a','s','a','A','active'),('b','s','b','B','active');
 INSERT INTO tasks(id,squad_id,title,status,done_when,assignee_agent_id) VALUES('t','s','T','open','reviewed','a');`)
 fleet('a',NOW-2*DAY);fleet('b',NOW)
})
afterEach(()=>{vi.restoreAllMocks();h.close()})
function fleet(id:string,at:number){h.sqlite.prepare(`INSERT INTO fleet_agents(agent_id,tenant,display,runtime,squads,lifecycle,status,reported_by,last_reported_at,updated_at,presence_mode,presence_ttl_sec,connection_kind)
 VALUES(?,?,'Agent','claude-code','[]','always_on','running','host',?,?,'resident',180,'fleet_attach')
 ON CONFLICT(tenant,agent_id) DO UPDATE SET last_reported_at=excluded.last_reported_at,updated_at=excluded.updated_at`).run(id,TENANT,new Date(at).toISOString(),new Date(at).toISOString())}
function receipt(id='r',agent='a',at=OLD,tenant=TENANT){h.sqlite.prepare(`INSERT INTO task_dispatch_receipts(id,tenant,task_id,squad_id,agent_id,actor_kind,actor_id,created_at) VALUES(?,?,'t','s',?,'member','owner',?)`).run(id,tenant,agent,at)}
const sweep=async()=>{const {expireAbandonedDispatches}=await import('../src/tasks/dispatch-expiry');return expireAbandonedDispatches(env,{nowMs:NOW})}
const audit=()=>h.sqlite.prepare("SELECT * FROM mutation_audit_entries WHERE operation='dispatch_expired_no_receiver'").all()
const row=()=>h.sqlite.prepare("SELECT settled_stage,settled_reason FROM task_dispatch_receipts WHERE id='r'").get()
async function envelope(){await deliverDispatchToInbox(env,{agentId:'a',squadId:'s',taskId:'t',receiptId:'r',dispatchedByMemberId:'owner',receiverFenceAgentId:'a'})}
describe('dispatch expiry with proven receiver death',()=>{
 it('settles an abandoned pre-delivery receipt with one audit and unblocks the unchanged archive guard',async()=>{
  receipt();expect(await hasArchiveBlockingDispatch(env,'t')).toBe(true)
  const task=h.sqlite.prepare("SELECT * FROM tasks WHERE id='t'").get()
  expect(await sweep()).toMatchObject({expired:1,failed:0})
  expect(row()).toEqual({settled_stage:'failed',settled_reason:'dispatch_expired_no_receiver'})
  expect(audit()).toHaveLength(1);expect(await hasArchiveBlockingDispatch(env,'t')).toBe(false)
  expect(h.sqlite.prepare("SELECT * FROM tasks WHERE id='t'").get()).toEqual(task)
  expect(await sweep()).toMatchObject({expired:0});expect(audit()).toHaveLength(1)
 })
 it('dead-letters only its exact unread envelope and refuses late redelivery',async()=>{
  receipt();await envelope();expect(await hasArchiveBlockingDispatch(env,'t')).toBe(true)
  expect(await sweep()).toMatchObject({expired:1})
  expect(h.sqlite.prepare('SELECT dead_lettered_at FROM agent_messages WHERE request_id=?').get(dispatchInboxRequestId('r'))).toEqual({dead_lettered_at:new Date(NOW).toISOString()})
  expect(await hasArchiveBlockingDispatch(env,'t')).toBe(false)
  await expect(envelope()).rejects.toThrow(/dispatch_fenced/)
  expect(h.sqlite.prepare('SELECT count(*) AS n FROM agent_messages').get()).toEqual({n:1})
 })
 it.each(['fresh','poll','boot-only','paused','recent-death','recent-receipt','age-boundary','in-worker','missing-delivered-envelope','previous-queue-attempt','expired-pointer','queue-lease','message-lease','read-message','wrong-envelope','unknown-pointer','live-claim','workflow','flight','hold','runtime-receipt','settled','foreign'])('preserves %s custody or uncertainty',async kind=>{
  receipt()
  if(kind==='fresh')fleet('a',NOW)
  if(kind==='poll')h.sqlite.exec("UPDATE fleet_agents SET presence_mode='poll' WHERE agent_id='a'")
  if(kind==='boot-only')h.sqlite.exec("UPDATE fleet_agents SET connection_kind='' WHERE agent_id='a'")
  if(kind==='paused')h.sqlite.exec("UPDATE agents SET status='paused' WHERE id='a'")
  if(kind==='recent-death')fleet('a',NOW-360001)
  if(kind==='recent-receipt')h.sqlite.prepare("UPDATE task_dispatch_receipts SET created_at=? WHERE id='r'").run(new Date(NOW-DAY).toISOString())
  if(kind==='age-boundary')h.sqlite.prepare("UPDATE task_dispatch_receipts SET created_at=? WHERE id='r'").run(new Date(NOW-7*DAY).toISOString())
  if(kind==='in-worker')h.sqlite.exec("UPDATE task_dispatch_receipts SET delivered_via='in_worker' WHERE id='r'")
  if(kind==='missing-delivered-envelope')h.sqlite.prepare("UPDATE task_dispatch_receipts SET delivered_via='inbox',consumed_at=? WHERE id='r'").run(OLD)
  if(kind==='previous-queue-attempt')h.sqlite.exec("UPDATE task_dispatch_receipts SET attempts=1 WHERE id='r'")
  if(kind==='expired-pointer')h.sqlite.prepare("UPDATE tasks SET execution_receipt_id='old-execution',execution_claim_expires_at=? WHERE id='t'").run(NOW-1000)
  if(kind==='queue-lease'){await envelope();h.sqlite.prepare("UPDATE task_dispatch_receipts SET claim_expires_at=? WHERE id='r'").run(NOW+60000)}
  if(kind==='message-lease'||kind==='read-message'){await envelope();h.sqlite.prepare(`UPDATE agent_messages SET ${kind==='message-lease'?'lease_expires_at':'read_at'}=?`).run(new Date(kind==='message-lease'?NOW+60000:NOW-1000).toISOString())}
  if(kind==='wrong-envelope'){const {sendAgentMessage}=await import('../src/agents/messages');await sendAgentMessage(env,{fromAgent:DISPATCH_BRIDGE_SENDER,fromMember:'owner',toAgent:'b',kind:'request',requestId:dispatchInboxRequestId('r'),body:'other recipient envelope'},{system:true,reason:'recipient scope fixture'})}
  if(kind==='unknown-pointer')h.sqlite.exec("UPDATE tasks SET execution_receipt_id='unknown' WHERE id='t'")
  if(kind==='live-claim')h.sqlite.prepare("UPDATE tasks SET execution_claim_expires_at=? WHERE id='t'").run(NOW+60000)
  if(kind==='workflow')h.sqlite.exec("UPDATE tasks SET workflow_instance_id='workflow' WHERE id='t'")
  if(kind==='flight')h.sqlite.prepare("INSERT INTO flights(id,tenant,agent,goal,status,meta) VALUES('f',?,'a','work','running','{\"task_ids\":[\"t\"]}')").run(TENANT)
  if(kind==='hold')h.sqlite.prepare("INSERT INTO execution_holds(task_id,escalation_id,agent_id,refused_count,held_at) VALUES('t','escalation','a',1,?)").run(OLD)
  if(kind==='runtime-receipt'){
   await envelope()
   const msg=h.sqlite.prepare('SELECT id FROM agent_messages WHERE from_agent=? AND request_id=?').get(DISPATCH_BRIDGE_SENDER,dispatchInboxRequestId('r')) as {id:string}
   h.sqlite.exec(`INSERT INTO members(id,tenant,display_name,status) VALUES('runtime-member','expiry','Runtime','active');
     INSERT INTO agent_member_bindings(tenant,agent_id,member_id,created_at) VALUES('expiry','a','runtime-member',datetime('now'));
     INSERT INTO member_tokens(id,tenant,member_id,agent_id,token_hash,channel) VALUES('runtime-token','expiry','runtime-member','a','fixture','workspace');
     INSERT INTO mutation_audit_entries(id,tenant,principal_kind,principal_id,agent_id,member_id,credential_id,origin,handler,operation,target_kind,target_id,request_id,idempotency_key,evidence_json,recorded_at)
       VALUES('consume-audit','expiry','agent','a','a','runtime-member','runtime-token','mcp','runtime-receipt','runtime_consumed','dispatch_receipt','r','runtime-fixture','runtime-fixture','{}',datetime('now'));`)
   h.sqlite.prepare(`INSERT INTO task_dispatch_runtime_receipts(id,tenant,dispatch_receipt_id,task_id,agent_id,message_id,member_id,credential_id,stage,attempt,runtime_address,runtime_receipt_hash,request_digest,audit_entry_id,created_at)
     VALUES('runtime-row','expiry','r','t','a',?,'runtime-member','runtime-token','runtime_consumed',1,'host',?,?,'consume-audit',?)`).run(msg.id,'a'.repeat(64),'b'.repeat(64),new Date().toISOString())
  }
  if(kind==='settled')h.sqlite.exec("UPDATE task_dispatch_receipts SET settled_stage='completed',settled_at=datetime('now') WHERE id='r'")
  if(kind==='foreign')h.sqlite.exec("UPDATE task_dispatch_receipts SET tenant='foreign' WHERE id='r'")
  expect(await sweep()).toMatchObject({expired:0});expect(audit()).toHaveLength(0)
 })
 it.each(['revival','claim','message-lease','queue-lease','settled'])('the %s race wins at the batch fence',async kind=>{
  receipt();if(kind==='message-lease'||kind==='queue-lease')await envelope()
  const batch=h.db.batch.bind(h.db);let changed=false
  vi.spyOn(h.db,'batch').mockImplementation(async statements=>{
   if(!changed){changed=true;if(kind==='revival')fleet('a',NOW);if(kind==='settled')h.sqlite.prepare("UPDATE task_dispatch_receipts SET settled_stage='completed',settled_at=? WHERE id='r'").run(new Date(NOW).toISOString());if(kind==='claim')h.sqlite.prepare("UPDATE tasks SET execution_claim_expires_at=? WHERE id='t'").run(NOW+60000);if(kind==='message-lease')h.sqlite.prepare('UPDATE agent_messages SET lease_expires_at=?').run(new Date(NOW+60000).toISOString());if(kind==='queue-lease')h.sqlite.prepare("UPDATE task_dispatch_receipts SET claim_expires_at=? WHERE id='r'").run(NOW+60000)}
   return batch(statements)
  })
  expect(await sweep()).toMatchObject({expired:0});expect(changed).toBe(true);expect(audit()).toHaveLength(0)
 })
 it('does not dead-letter ordinary or foreign-tenant messages sharing the envelope key',async()=>{
  receipt();await envelope()
  const {sendAgentMessage}=await import('../src/agents/messages')
  for(const [e,from] of [[env,'b'],[{...env,TENANT_SLUG:'foreign'} as Env,DISPATCH_BRIDGE_SENDER]] as const)
   expect((await sendAgentMessage(e,{fromAgent:from,fromMember:'owner',toAgent:'a',kind:'message',requestId:dispatchInboxRequestId('r'),body:'quoted control reference'},{system:true,reason:'independent message scope fixture'})).ok).toBe(true)
  expect(await sweep()).toMatchObject({expired:1})
  expect(h.sqlite.prepare("SELECT dead_lettered_at FROM agent_messages WHERE tenant='foreign' OR from_agent='b'").all()).toEqual([{dead_lettered_at:null},{dead_lettered_at:null}])
 })
 it('settlement between bridge precheck and INSERT prevents an envelope from being recreated',async()=>{
  receipt();const prepare=h.db.prepare.bind(h.db);let changed=false
  vi.spyOn(h.db,'prepare').mockImplementation(query=>{
   if(!changed&&query.includes('INSERT INTO agent_messages')){changed=true;h.sqlite.prepare("UPDATE task_dispatch_receipts SET settled_stage='failed',settled_at=?,settled_reason='other settle' WHERE id='r'").run(new Date(NOW).toISOString())}
   return prepare(query)
  })
  const error=await envelope().then(()=>null,error=>error)
  expect(error).toBeInstanceOf(Error);expect(String(error)).toMatch(/dispatch_fenced/)
  expect(changed).toBe(true);expect(h.sqlite.prepare('SELECT count(*) AS n FROM agent_messages').get()).toEqual({n:0})
 })
 it('settlement between Queue read and claim wins without waking the agent',async()=>{
  receipt();const prepare=h.db.prepare.bind(h.db);let changed=false
  vi.spyOn(h.db,'prepare').mockImplementation(query=>{
   if(!changed&&query.includes('SET claimed_at = ?')){changed=true;h.sqlite.prepare("UPDATE task_dispatch_receipts SET settled_stage='failed',settled_at=?,settled_reason='other settle' WHERE id='r'").run(new Date(NOW).toISOString())}
   return prepare(query)
  })
  const item={id:'late',attempts:1,body:{type:'agent.wake',tenant:TENANT,squad_id:'s',agent_id:'a',actor:{kind:'member',id:'owner'},ts:new Date(NOW).toISOString(),payload:{task_id:'t',dispatch_receipt_id:'r',by:'owner'}} as BusEvent,ack:vi.fn(),retry:vi.fn()}
  await handleQueue({messages:[item]} as unknown as MessageBatch<BusEvent>,env)
  expect(changed).toBe(true);expect(item.ack).toHaveBeenCalledOnce();expect(item.retry).not.toHaveBeenCalled()
  expect(h.sqlite.prepare('SELECT count(*) AS n FROM agent_messages').get()).toEqual({n:0})
 })
 it('rolls back settlement when its audit receipt cannot be written',async()=>{
  receipt();h.sqlite.exec("CREATE TRIGGER fail_retirement_audit BEFORE INSERT ON mutation_audit_entries BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;")
  expect(await sweep()).toMatchObject({expired:0,failed:1});expect(row()).toEqual({settled_stage:null,settled_reason:null});expect(await hasArchiveBlockingDispatch(env,'t')).toBe(true)
 })
 it('does not fail after committing a retirement if cursor storage fails',async()=>{
  receipt();const prepare=h.db.prepare.bind(h.db)
  vi.spyOn(h.db,'prepare').mockImplementation(query=>{if(query.startsWith('INSERT INTO org_settings'))throw new Error('cursor unavailable');return prepare(query)})
  await expect(sweep()).resolves.toMatchObject({expired:1,cursor_failed:true})
  expect(audit()).toHaveLength(1);expect(row()).toEqual({settled_stage:'failed',settled_reason:'dispatch_expired_no_receiver'})
 })
 it('bounds writes to 25 and rotates past live-head scan windows',async()=>{
  for(let i=0;i<101;i++)receipt(`live-${i}`,'b')
  receipt('r');expect(await sweep()).toMatchObject({expired:0,scanned:100})
  expect(await sweep()).toMatchObject({expired:1})
  for(let i=0;i<30;i++)receipt(`dead-${i}`)
  expect((await sweep()).expired).toBeLessThanOrEqual(25)
 })
})
