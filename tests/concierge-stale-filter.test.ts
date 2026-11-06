import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest'
import type { D1PreparedStatement } from '@cloudflare/workers-types'
import { runProjectConcierge,runConciergeTick,BUILD_CAPABILITY } from '../src/concierge/service'
import { registerModule,listPresence } from '../src/registry/service'
import type { Env,Project } from '../src/types'
import { createSqliteD1,type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
const NOW='2026-11-06T12:00:00.000Z'
const ago=(days:number)=>new Date(Date.parse(NOW)-days*86400000).toISOString()
let h:SqliteD1Harness,env:Env,hook:(()=>void)|undefined,claims:number
beforeEach(async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(NOW));h=createSqliteD1();applyAllMigrations(h.sqlite);hook=undefined;claims=0
 h.sqlite.exec(`INSERT INTO departments(id,slug,name) VALUES('d','d','D');
 INSERT INTO squads(id,department_id,slug,name) VALUES('own','d','own','Own'),('foreign','d','foreign','Foreign');
 INSERT INTO agents(id,squad_id,slug,name,status) VALUES('builder','own','builder','Builder','active'),('outsider','foreign','outsider','Outsider','active');
 INSERT INTO members(id,tenant,display_name,status) VALUES('outside-member','t','Outside','active');
 INSERT INTO agent_member_bindings(tenant,agent_id,member_id,created_at) VALUES('t','outsider','outside-member','${NOW}');
 INSERT INTO capabilities(id,member_id,scope_type,scope_id,capability) VALUES('cross-cap','outside-member','squad','own','member');
 INSERT INTO projects(id,slug,name,goal,status,assigned_squad_id) VALUES('p','p','Project','Ship work','active','own');
 INSERT INTO project_squad_access(project_id,squad_id,access_level) VALUES('p','own','write');
 INSERT INTO presence(tenant,member_id,display_name,source,label,agent_id,first_seen_at,last_seen_at) VALUES
 ('t','seat-own','Builder','test','test','builder','${NOW}','${NOW}'),('t','seat-other','Outsider','test','test','outsider','${NOW}','${NOW}');`)
 const wrap=(s:D1PreparedStatement,claim:boolean):D1PreparedStatement=>new Proxy(s,{get(target,key){
   if(key==='bind')return(...v:unknown[])=>wrap(target.bind(...v),claim)
   if(key==='run'&&claim)return async()=>{claims++;const f=hook;hook=undefined;f?.();return target.run()}
   const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v
 }})
 env={TENANT_SLUG:'t',DB:{...h.db,prepare:(sql:string)=>wrap(h.db.prepare(sql),/^\s*UPDATE tasks SET assignee_agent_id/.test(sql))},BUS:{send:async()=>{}}} as unknown as Env
 await online('builder')
})
afterEach(()=>{h.close();vi.useRealTimers()})
async function online(agent:string){expect((await registerModule(env,{identity:agent,kind:'agent_system',adapter:'cursor',projectId:null,capabilities:[BUILD_CAPABILITY]},new Date(NOW))).ok).toBe(true)}
function p(){return h.sqlite.prepare("SELECT * FROM projects WHERE id='p'").get() as unknown as Project}
function task(id:string,created=ago(1),body='Build the feature',result:string|null=null){h.sqlite.prepare("INSERT INTO tasks(id,squad_id,project_id,title,body,done_when,status,created_at,updated_at,result) VALUES(?,'own','p','Build work',?,'Done','open',?,?,?)").run(id,body,created,NOW,result)}
const run=()=>runProjectConcierge(env,p())
const owner=(id:string)=>h.sqlite.prepare('SELECT assignee_agent_id FROM tasks WHERE id=?').get(id)?.assignee_agent_id

describe('concierge stale route eligibility',()=>{
 it.each(['age','artifact','steward'])('five %s exclusions cannot occupy the fresh tasks scan window',async kind=>{
  for(let i=0;i<5;i++)task(`excluded-${i}`,kind==='age'?ago(60):ago(2),kind==='steward'?'Earlier context\nsteward-reissue-of:old-card\nBuild it':'Build it',kind==='artifact'?'artifact_verification_failed: missing receipt':null)
  task('fresh',ago(1))
  expect(await run()).toMatchObject({decision:{action:'route',routed:1,skipReasons:['stale_excluded']}})
  expect(owner('fresh')).toBe('builder')
  for(let i=0;i<5;i++)expect(owner(`excluded-${i}`)).toBeNull()
 })
 it('uses creation age even when an old card has just been touched',async()=>{
  task('old',ago(60));expect(await run()).toMatchObject({decision:{action:'noop',reason:'stale_excluded'}});expect(owner('old')).toBeNull()
 })
 it('keeps fresh work routable even when updated_at is old',async()=>{
  task('fresh');h.sqlite.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run(ago(90),'fresh')
  expect(await run()).toMatchObject({decision:{action:'route',routed:1}});expect(owner('fresh')).toBe('builder')
 })
 it('includes the 30-day boundary and excludes a task one millisecond older',async()=>{
  task('boundary',ago(30));task('older',new Date(Date.parse(ago(30))-1).toISOString())
  expect(await run()).toMatchObject({decision:{action:'route',routed:1}});expect(owner('boundary')).toBe('builder');expect(owner('older')).toBeNull()
 })
 it('only excludes an artifact failure at the start of the result',async()=>{
  task('resolved',ago(1),'Build it','Resolved artifact_verification_failed from a previous run')
  expect(await run()).toMatchObject({decision:{action:'route',routed:1}})
 })
 it.each(['age','artifact','steward'])('rechecks %s eligibility at claim commit',async kind=>{
  task('racing')
  hook=()=>{
   if(kind==='age')h.sqlite.prepare('UPDATE tasks SET created_at=? WHERE id=?').run(ago(60),'racing')
   if(kind==='artifact')h.sqlite.prepare('UPDATE tasks SET result=? WHERE id=?').run('artifact_verification_failed: changed','racing')
   if(kind==='steward')h.sqlite.prepare('UPDATE tasks SET body=? WHERE id=?').run('steward-reissue-of:old-card','racing')
  }
  expect(await run()).toMatchObject({decision:{action:'noop',reason:'stale_excluded'}})
  expect(claims).toBe(1);expect(owner('racing')).toBeNull()
 })
 it('retains the stale skip reason when the tick also routes fresh work',async()=>{
  task('old',ago(60));task('fresh')
  expect(await runConciergeTick(env,{listProjects:async()=>[p()]})).toMatchObject({routed:1,skippedProjects:{stale_excluded:1}})
 })
 it('reports stale exclusions in the tick summary by project, not by card',async()=>{
  for(let i=0;i<5;i++)task(`old-${i}`,ago(60));expect(await runConciergeTick(env,{listProjects:async()=>[p()]})).toMatchObject({routed:0,skippedProjects:{stale_excluded:1}})
 })
})
describe('starter project ownership fallback',()=>{
 it('does not use a foreign builder just because it is live and legally assignable',async()=>{
  h.sqlite.exec("UPDATE module_registry SET status='offline' WHERE identity='builder'");await online('outsider')
  expect(await run()).toMatchObject({decision:{action:'noop',reason:'starter_no_operator'}})
  expect(h.sqlite.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({n:0})
 })
 it('chooses a project squad builder over an earlier foreign candidate and leaves the gate unset',async()=>{
  await online('outsider')
  h.sqlite.prepare("UPDATE module_registry SET last_heartbeat=? WHERE identity='outsider'").run(new Date(Date.parse(NOW)+1000).toISOString())
  expect((await listPresence(env,{projectId:null}))[0].identity).toBe('outsider')
  const result=await run();expect(result).toMatchObject({decision:{action:'dispatch',agentId:'builder'}})
  expect(h.sqlite.prepare('SELECT gate_owner FROM tasks WHERE id=?').get(result.taskId!)).toEqual({gate_owner:null})
 })
 it('prefers the assigned project squad over another explicitly linked squad',async()=>{
  await online('outsider')
  h.sqlite.exec("INSERT INTO project_squad_access(project_id,squad_id,access_level) VALUES('p','foreign','admin')")
  expect(await run()).toMatchObject({decision:{action:'dispatch',agentId:'builder'}})
 })
 it('does not invent an owning squad from the old core default',async()=>{
  h.sqlite.exec("UPDATE projects SET assigned_squad_id=NULL; DELETE FROM project_squad_access")
  expect(await run()).toMatchObject({decision:{action:'noop',reason:'starter_no_operator'}})
 })
 it.each(['write','admin'])('uses an explicit project %s squad when assigned_squad_id is absent',async level=>{
  h.sqlite.prepare('UPDATE project_squad_access SET access_level=?').run(level)
  h.sqlite.exec('UPDATE projects SET assigned_squad_id=NULL')
  expect(await run()).toMatchObject({decision:{action:'dispatch',agentId:'builder'}})
 })
 it('does not treat read-only project access as an owning squad',async()=>{
  h.sqlite.exec("UPDATE projects SET assigned_squad_id=NULL; UPDATE project_squad_access SET access_level='read'")
  expect(await run()).toMatchObject({decision:{action:'noop',reason:'starter_no_operator'}})
 })
 it('accepts an explicitly live member of the project squad',async()=>{
  h.sqlite.exec("UPDATE module_registry SET status='offline' WHERE identity='builder'; INSERT INTO memberships(id,agent_id,squad_id,capability) VALUES('member-other','outsider','own','member')")
  await online('outsider');expect(await run()).toMatchObject({decision:{action:'dispatch',agentId:'outsider'}})
 })
 it('refuses expired or observer-only memberships as the starter ownership ground',async()=>{
  h.sqlite.exec("UPDATE module_registry SET status='offline' WHERE identity='builder'; INSERT INTO memberships(id,agent_id,squad_id,capability,expires_at) VALUES('member-other','outsider','own','member','2000-01-01')")
  await online('outsider');expect(await run()).toMatchObject({decision:{action:'noop',reason:'starter_no_operator'}})
  h.sqlite.exec("UPDATE memberships SET expires_at=NULL,capability='observer' WHERE id='member-other'")
  expect(await run()).toMatchObject({decision:{action:'noop',reason:'starter_no_operator'}})
 })
 it('reports the missing operator ground in the tick summary',async()=>{
  h.sqlite.exec("UPDATE projects SET assigned_squad_id=NULL; DELETE FROM project_squad_access")
  expect(await runConciergeTick(env,{listProjects:async()=>[p()]})).toMatchObject({dispatched:0,skippedProjects:{starter_no_operator:1}})
 })
})
