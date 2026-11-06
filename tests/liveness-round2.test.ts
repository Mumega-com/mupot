import { afterEach,beforeEach,expect,it,vi } from 'vitest'
import { createSqliteD1,type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { agentLiveness } from '../src/agents/liveness'
import { reclaimDeadAssignments } from '../src/tasks/dead-assignee-reclaim'
import { selfReportAtBoot } from '../src/fleet/boot-self-report'
import { recordCheckin } from '../src/fleet/presence'
import { touchPollFleetPresence,reportFleetAgents } from '../src/fleet/registry'
import { fleetAttachApp } from '../src/fleet/attach-routes'
import * as messages from '../src/agents/messages'
import * as liveness from '../src/agents/liveness'
import type { Env } from '../src/types'
const TENANT='round2-pot',DAY=86400000
let h:SqliteD1Harness,env:Env,now:number,beforeBatch:(()=>void)|undefined
beforeEach(()=>{
 h=createSqliteD1();applyAllMigrations(h.sqlite);now=Date.now();beforeBatch=undefined
 h.sqlite.exec(`INSERT INTO departments(id,slug,name) VALUES('d','d','D'); INSERT INTO squads(id,department_id,slug,name) VALUES('s','d','s','S');
 INSERT INTO members(id,tenant,display_name,status) VALUES('owner','${TENANT}','Owner','active');
 INSERT INTO agents(id,squad_id,slug,name,status,owner_member_id) VALUES('a','s','runner','Runner','active','owner');`)
 env={DB:{...h.db,batch:async stmts=>{const hook=beforeBatch;beforeBatch=undefined;hook?.();return h.db.batch(stmts)}},TENANT_SLUG:TENANT,BUS:{send:vi.fn(async()=>undefined)}} as unknown as Env
})
afterEach(()=>{vi.restoreAllMocks();h.close()})
function work(id='t',status='in_progress'){h.sqlite.prepare("INSERT INTO tasks(id,squad_id,title,done_when,status,assignee_agent_id,created_at,updated_at) VALUES(?,'s','Work','Done',?,'a','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").run(id,status)}
function resident(){h.sqlite.prepare("INSERT INTO fleet_agents(tenant,agent_id,display,runtime,squads,lifecycle,status,reported_by,last_reported_at,updated_at,connection_kind) VALUES(?,'a','A','claude-code','[]','always_on','running','owner',?,?,'fleet_attach')").run(TENANT,new Date(now-3*DAY).toISOString(),new Date(now-3*DAY).toISOString())}
function presence(id='a',at=now){h.sqlite.prepare("INSERT INTO presence(tenant,member_id,display_name,source,label,agent_id,first_seen_at,last_seen_at) VALUES(?,'owner','A','mcp',?,?,?,?)").run(TENANT,id,id,new Date(at).toISOString(),new Date(at).toISOString())}
function session(until=now+3600000){
 h.sqlite.exec(`INSERT INTO members(id,tenant,display_name,status) VALUES('session-member','${TENANT}','Session','active');
 INSERT INTO agent_member_bindings(tenant,agent_id,member_id,created_at) VALUES('${TENANT}','a','session-member','2026-01-01T00:00:00Z');
 INSERT INTO member_tokens(id,member_id,token_hash,label,channel,agent_id,tenant,expires_at,created_at) VALUES('session-token','session-member','session-test-hash','test','workspace','a','${TENANT}','2099-01-01T00:00:00Z','2026-01-01T00:00:00Z');`)
 h.sqlite.prepare("INSERT INTO agent_sessions(id,tenant,agent_id,member_id,auth_kind,credential_id,created_at,last_seen_at,idle_expires_at,absolute_expires_at) VALUES('session',?,'a','session-member','workspace_token','session-token',?,?,?,?)").run(TENANT,new Date(now-DAY).toISOString(),new Date(now-60000).toISOString(),new Date(until).toISOString(),new Date(until+DAY).toISOString())
}
function module(){h.sqlite.prepare("INSERT INTO module_registry(id,tenant,identity,kind,adapter,project_id,status,capabilities,last_heartbeat,registered_at) VALUES('m',?,'a','agent_system','cursor',NULL,'online','[\"build\"]',?,?)").run(TENANT,new Date(now).toISOString(),new Date(now).toISOString())}
function seat(){h.sqlite.prepare("INSERT INTO runtime_seats(id,tenant,agent_id,seat_name,host_id,adapter_kind,state,last_heartbeat_at,created_at,updated_at) VALUES('seat',?,'a','seat','host','external','active',?,?,?)").run(TENANT,new Date(now).toISOString(),new Date(now-DAY).toISOString(),new Date(now).toISOString())}
const sweep=()=>reclaimDeadAssignments(env,{nowMs:now})
const row=()=>h.sqlite.prepare("SELECT status,assignee_agent_id FROM tasks WHERE id='t'").get()
it('gate A: boot-only MCP agent with fresh check_in is not reclaimed',async()=>{
 await selfReportAtBoot(env,'a',{runtime:'claude-code'},'agent_bound')
 h.sqlite.prepare('UPDATE fleet_agents SET last_reported_at=?').run(new Date(now-25*3600000).toISOString())
 await recordCheckin(env,{memberId:'owner',displayName:'Runner',boundAgentId:'a'} as never,{label:'seat1'})
 work();expect((await agentLiveness(env,['a'],now)).get('a')).toMatchObject({state:'live',assignmentEligible:true})
 expect((await sweep()).reclaimed).toBe(0);expect(row()).toEqual({status:'in_progress',assignee_agent_id:'a'})
})
it('gate B: MCP traffic after one boot stays live beyond a day',async()=>{
 await selfReportAtBoot(env,'a',{runtime:'claude-code',model:'claude-opus'},'agent_bound')
 await touchPollFleetPresence(env,'a');work();now+=DAY+400000;presence()
 expect((await agentLiveness(env,['a'],now)).get('a')).toMatchObject({state:'live',assignmentEligible:true,deadSinceMs:null})
 expect((await sweep()).reclaimed).toBe(0)
})
it.each(['presence','module','session','seat'])('a fresh %s source prevents resident death',async source=>{
 resident();work();if(source==='presence')presence();if(source==='module')module();if(source==='session')session();if(source==='seat')seat()
 expect((await agentLiveness(env,['a'],now)).get('a')).toMatchObject({state:'live',assignmentEligible:true,deadSinceMs:null})
 expect((await sweep()).reclaimed).toBe(0)
})
it.each(['presence','module','session','seat'])('new %s activity between selection and update wins',async source=>{
 resident();work();beforeBatch=()=>{if(source==='presence')presence();if(source==='module')module();if(source==='session')session();if(source==='seat')seat()}
 expect((await sweep()).reclaimed).toBe(0);expect(row()).toEqual({status:'in_progress',assignee_agent_id:'a'})
 expect(h.sqlite.prepare("SELECT count(*) n FROM mutation_audit_entries WHERE operation='dead_assignee_reclaim'").get()).toEqual({n:0})
})
it.each(['dispatch','flight'])('new %s custody between selection and update wins',async kind=>{
 resident();work();beforeBatch=()=>{
 if(kind==='dispatch')h.sqlite.prepare("INSERT INTO task_dispatch_receipts(id,tenant,task_id,squad_id,agent_id,actor_kind,actor_id,created_at) VALUES('d',?,'t','s','a','agent','a',?)").run(TENANT,new Date(now).toISOString())
 else h.sqlite.prepare("INSERT INTO flights(id,tenant,agent,goal,status,budget_micro_usd,cost_micro_usd,cost_metered,created_at,started_at,meta) VALUES('f',?,'a','G','running',100,0,1,?,?,?)").run(TENANT,now,now,JSON.stringify({task_ids:['t']}))
 }
 expect((await sweep()).reclaimed).toBe(0);expect(row()).toEqual({status:'in_progress',assignee_agent_id:'a'})
 expect(h.sqlite.prepare("SELECT count(*) n FROM mutation_audit_entries WHERE operation='dead_assignee_reclaim'").get()).toEqual({n:0})
})
it('never-connected agents have no auto-assignment proof',async()=>{
 expect((await agentLiveness(env,['a'],now)).get('a')).toMatchObject({assignmentEligible:false,deadSinceMs:null})
})
it('unsigned report alone cannot establish a resident obligation',async()=>{
 expect((await reportFleetAgents(env,'reporter',[{agent_id:'a',runtime:'claude-code',status:'running'}])).ok).toBe(true)
 h.sqlite.prepare('UPDATE fleet_agents SET last_reported_at=?').run(new Date(now-3*DAY).toISOString());work()
 expect((await sweep()).reclaimed).toBe(0)
 expect((await agentLiveness(env,['a'],now)).get('a')?.mode).not.toBe('resident')
})
it('one owner batch is sent to at most three live owned agents',async()=>{
 resident();for(let i=0;i<10;i++){const id=`owner-${i}`;h.sqlite.prepare("INSERT INTO agents(id,squad_id,slug,name,status,owner_member_id) VALUES(?,'s',?,'Inbox','active','owner')").run(id,id);presence(id)}
 for(let i=0;i<25;i++)work(`t${i}`,'open')
 expect((await sweep()).reclaimed).toBe(25)
 const notes=h.sqlite.prepare("SELECT body,to_agent FROM agent_messages WHERE from_agent='mupot-task-reclaim'").all() as {body:string;to_agent:string}[]
 expect(notes).toHaveLength(3)
 for(const note of notes)expect(JSON.parse(note.body).tasks.map((t:{task_id:string})=>t.task_id).sort()).toEqual(Array.from({length:25},(_,i)=>`t${i}`).sort())
})
it('stale or paused owned inboxes get no notice',async()=>{
 resident();work()
 h.sqlite.exec("INSERT INTO agents(id,squad_id,slug,name,status,owner_member_id) VALUES('old-inbox','s','old-inbox','Old','active','owner'),('paused-inbox','s','paused-inbox','Paused','paused','owner')")
 presence('paused-inbox')
 expect((await sweep()).reclaimed).toBe(1)
 expect(h.sqlite.prepare("SELECT count(*) n FROM agent_messages WHERE from_agent='mupot-task-reclaim'").get()).toEqual({n:0})
})

it('real attach records residency, boot removes it, and unsigned report cannot restore it',async()=>{
 session();h.sqlite.exec("INSERT INTO capabilities(id,member_id,scope_type,scope_id,capability) VALUES('session-cap','session-member','squad','s','member')");const raw='synthetic-attach-test-value';const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw)))).map(b=>b.toString(16).padStart(2,'0')).join('')
 h.sqlite.prepare("UPDATE member_tokens SET token_hash=? WHERE id='session-token'").run(hash)
 const attach=()=>fleetAttachApp.request('/attach',{method:'POST',headers:{authorization:`Bearer ${raw}`,'content-type':'application/json'},body:JSON.stringify({agent_id:'a',runtime:'claude-code',type:'builder',lifecycle:'always_on'})},env)
 expect((await attach()).status).toBe(200)
 expect(h.sqlite.prepare("SELECT connection_kind FROM fleet_agents WHERE agent_id='a'").get()).toEqual({connection_kind:'fleet_attach'})
 await selfReportAtBoot(env,'a',{runtime:'claude-code'},'agent_bound')
 expect(h.sqlite.prepare("SELECT connection_kind FROM fleet_agents WHERE agent_id='a'").get()).toEqual({connection_kind:'agent_bound'})
 await reportFleetAgents(env,'reporter',[{agent_id:'a',runtime:'claude-code',status:'running'}])
 expect(h.sqlite.prepare("SELECT connection_kind FROM fleet_agents WHERE agent_id='a'").get()).toEqual({connection_kind:'agent_bound'})
 expect((await attach()).status).toBe(200)
 expect(h.sqlite.prepare("SELECT connection_kind FROM fleet_agents WHERE agent_id='a'").get()).toEqual({connection_kind:'fleet_attach'})
})
it.each(['presence','module','session','seat'])('all-source cooldown includes an expired %s signal',async source=>{
 resident();work();const old=now-23*3600000
 if(source==='presence')presence('a',old)
 if(source==='module'){module();h.sqlite.prepare('UPDATE module_registry SET last_heartbeat=?').run(new Date(old).toISOString())}
 if(source==='session'){session(old);h.sqlite.prepare('UPDATE agent_sessions SET created_at=?,last_seen_at=?').run(new Date(now-4*DAY).toISOString(),new Date(now-3*DAY).toISOString())}
 if(source==='seat'){seat();h.sqlite.prepare('UPDATE runtime_seats SET last_heartbeat_at=?').run(new Date(old).toISOString())}
 expect((await sweep()).reclaimed).toBe(0)
})
it('owner delivery attempts stay capped globally and per owner even when sends fail',async()=>{
 for(let i=0;i<10;i++){
  const owner=`human-${i}`,agent=`dead-${i}`
  h.sqlite.prepare("INSERT INTO members(id,tenant,display_name,status) VALUES(?,?,'Owner','active')").run(owner,TENANT)
  h.sqlite.prepare("INSERT INTO agents(id,squad_id,slug,name,status,owner_member_id) VALUES(?,'s',?,'Dead','active',?)").run(agent,agent,owner)
  h.sqlite.prepare("INSERT INTO fleet_agents(tenant,agent_id,display,runtime,squads,lifecycle,status,reported_by,last_reported_at,updated_at,connection_kind) VALUES(?,?,'D','claude-code','[]','always_on','running','owner',?,?,'fleet_attach')").run(TENANT,agent,new Date(now-3*DAY).toISOString(),new Date(now-3*DAY).toISOString())
  h.sqlite.prepare("INSERT INTO tasks(id,squad_id,title,done_when,status,assignee_agent_id) VALUES(?,'s','T','D','open',?)").run(`task-${i}`,agent)
  for(let j=0;j<4;j++){const id=`inbox-${i}-${j}`;h.sqlite.prepare("INSERT INTO agents(id,squad_id,slug,name,status,owner_member_id) VALUES(?,'s',?,'Inbox','active',?)").run(id,id,owner);presence(id)}
 }
 const send=vi.spyOn(messages,'sendAgentMessage').mockResolvedValue({ok:false,reason:'inbox_full'})
 const result=await sweep();expect(result.reclaimed).toBe(10);expect(result.notified).toBe(0);expect(send).toHaveBeenCalledTimes(25)
 const counts=new Map<string,number>();for(const call of send.mock.calls){const task=JSON.parse(call[1].body).tasks[0].task_id;counts.set(task,(counts.get(task)??0)+1)}
 expect(Math.max(...counts.values())).toBeLessThanOrEqual(3)
})
it('notice liveness lookups examine at most 200 candidates per sweep',async()=>{
 resident();work();for(let i=0;i<205;i++){const id=`peer-${String(i).padStart(3,'0')}`;h.sqlite.prepare("INSERT INTO agents(id,squad_id,slug,name,status,owner_member_id) VALUES(?,'s',?,'Peer','active','owner')").run(id,id)}
 const read=vi.spyOn(liveness,'agentLiveness')
 expect((await sweep()).reclaimed).toBe(1)
 expect(Math.max(...read.mock.calls.map(call=>call[1].length))).toBeLessThanOrEqual(200)
})
it.each(['paused','stopped','dead'])('a %s owned recipient is never notified',async kind=>{
 resident();work();h.sqlite.exec("INSERT INTO agents(id,squad_id,slug,name,status,owner_member_id) VALUES('peer','s','peer','Peer','active','owner')")
 if(kind==='paused'){presence('peer');h.sqlite.prepare("INSERT INTO execution_pauses(id,tenant,scope_type,scope_id,reason,paused_by_member_id,paused_at) VALUES('pause',?,'agent','peer','test','owner',?)").run(TENANT,new Date(now).toISOString())}
 else h.sqlite.prepare("INSERT INTO fleet_agents(tenant,agent_id,display,runtime,squads,lifecycle,status,reported_by,last_reported_at,updated_at,connection_kind) VALUES(?,'peer','P','claude-code','[]','always_on',?,'owner',?,?,'fleet_attach')").run(TENANT,kind==='stopped'?'stopped':'running',new Date(now-3*DAY).toISOString(),new Date(now-3*DAY).toISOString())
 expect((await sweep()).reclaimed).toBe(1)
 expect(h.sqlite.prepare("SELECT count(*) n FROM agent_messages WHERE from_agent='mupot-task-reclaim'").get()).toEqual({n:0})
})
it.each(['0','1720000000000','now'])('non-timestamp %s is not liveness or death evidence',async stamp=>{
 resident();h.sqlite.prepare('UPDATE fleet_agents SET last_reported_at=?').run(stamp);work()
 expect((await agentLiveness(env,['a'],now)).get('a')).toMatchObject({state:'stale',assignmentEligible:false,deadSinceMs:null})
 expect((await sweep()).reclaimed).toBe(0)
})
it('revoked-session activity still contributes to the all-source cooldown',async()=>{
 resident();work();session();h.sqlite.prepare('UPDATE agent_sessions SET revoked_at=?,created_at=?,last_seen_at=?').run(new Date(now-22*3600000).toISOString(),new Date(now-4*DAY).toISOString(),new Date(now-23*3600000).toISOString())
 expect((await sweep()).reclaimed).toBe(0)
})
it('malformed secondary activity cannot establish all-source death',async()=>{
 resident();work();presence();h.sqlite.exec("UPDATE presence SET last_seen_at='0'")
 expect((await agentLiveness(env,['a'],now)).get('a')?.deadSinceMs).toBeNull()
 expect((await sweep()).reclaimed).toBe(0)
})
it.each(['session','credential','member'])('invalid %s state is not a live session',async kind=>{
 resident();work();session()
 if(kind==='session')h.sqlite.prepare('UPDATE agent_sessions SET revoked_at=?').run(new Date(now).toISOString())
 if(kind==='credential')h.sqlite.prepare('UPDATE member_tokens SET revoked_at=?').run(new Date(now).toISOString())
 if(kind==='member')h.sqlite.exec("UPDATE members SET status='suspended' WHERE id='session-member'")
 expect((await agentLiveness(env,['a'],now)).get('a')?.fresh).toBe(false)
})
it('a revived affected agent does not get its own owner notice',async()=>{
 resident();work();h.sqlite.exec("INSERT INTO agents(id,squad_id,slug,name,status,owner_member_id) VALUES('peer','s','peer','Peer','active','owner')");presence('peer')
 const db=env.DB;env={...env,DB:{...db,batch:async stmts=>{const result=await db.batch(stmts);h.sqlite.prepare("UPDATE fleet_agents SET last_reported_at=? WHERE agent_id='a'").run(new Date(now).toISOString());return result}}} as Env
 expect((await sweep()).reclaimed).toBe(1)
 expect(h.sqlite.prepare("SELECT to_agent FROM agent_messages WHERE from_agent='mupot-task-reclaim'").all()).toEqual([{to_agent:'peer'}])
})

it('live credential-bound sessions preserve the existing binding floor',async()=>{
 resident();work();session();expect(()=>h.sqlite.exec("DELETE FROM agent_member_bindings WHERE agent_id='a'")).toThrow('agent_identity_conflict')
 expect((await agentLiveness(env,['a'],now)).get('a')).toMatchObject({state:'live',assignmentEligible:true,deadSinceMs:null})
 expect((await sweep()).reclaimed).toBe(0)
})
it('a sibling live credential does not revive a session whose credential was revoked',async()=>{
 resident();session();h.sqlite.prepare("UPDATE member_tokens SET revoked_at=? WHERE id='session-token'").run(new Date(now).toISOString())
 h.sqlite.prepare("INSERT INTO member_tokens(id,member_id,token_hash,label,channel,agent_id,tenant,expires_at,created_at) VALUES('sibling-token','session-member','sibling-test-hash','test','workspace','a',?,'2099-01-01T00:00:00Z','2026-01-01T00:00:00Z')").run(TENANT)
 expect((await agentLiveness(env,['a'],now)).get('a')?.fresh).toBe(false)
})
it('boot-only rows never become resident obligations merely by ageing',async()=>{
 await selfReportAtBoot(env,'a',{runtime:'claude-code'},'agent_bound');h.sqlite.prepare('UPDATE fleet_agents SET last_reported_at=?').run(new Date(now-3*DAY).toISOString());work()
 expect((await agentLiveness(env,['a'],now)).get('a')?.mode).not.toBe('resident')
 expect((await sweep()).reclaimed).toBe(0)
})
