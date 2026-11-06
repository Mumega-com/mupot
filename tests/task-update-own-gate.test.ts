vi.mock('../src/auth', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/auth')>(),
  requireAuth: async (c: {req:{header:(n:string)=>string|undefined};set:(k:string,v:unknown)=>void},next:()=>Promise<void>)=>{
    c.set('auth',JSON.parse(c.req.header('x-test-auth')??'{}'));await next()
  },
}))
import { tasksApp } from '../src/tasks'
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest'
import { invokeTool } from '../src/mcp'
import { getRule,registeredRefusalCodes } from '../src/policy/registry'
import type { AuthContext,Capability,Env } from '../src/types'
import { createSqliteD1,type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
let h:SqliteD1Harness,env:Env
beforeEach(()=>{
 h=createSqliteD1();applyAllMigrations(h.sqlite)
 h.sqlite.exec(`INSERT INTO departments(id,slug,name) VALUES('d','d','D');
 INSERT INTO squads(id,department_id,slug,name) VALUES('s','d','s','S'),('other','d','other','Other');
 INSERT INTO agents(id,squad_id,slug,name,status) VALUES('a','s','a','A','active'),('b','s','b','B','active');
 INSERT INTO members(id,tenant,display_name,status) VALUES('m-a','t','A','active'),('m-b','t','B','active'),('human','t','Human','active');
 INSERT INTO agent_member_bindings(tenant,agent_id,member_id,created_at) VALUES('t','a','m-a',datetime('now')),('t','b','m-b',datetime('now'));
 INSERT INTO capabilities(id,member_id,scope_type,scope_id,capability) VALUES('ca','m-a','squad','s','member'),('cb','m-b','squad','s','member'),('ch','human','squad','s','member');
 INSERT INTO tasks(id,squad_id,title,body,done_when,status,assignee_agent_id) VALUES('task','s','Work','Build','Done','open','a');`)
 env={DB:h.db,TENANT_SLUG:'t',BUS:{send:async()=>{}}} as unknown as Env
})
afterEach(()=>h.close())
function actor(agent:string|null='a',rank:Capability='member',scope='s'):AuthContext {
 const member=agent?`m-${agent}`:'human'
 return {userId:member,memberId:member,email:null,tenant:'t',role:'member',channel:'workspace',boundAgentId:agent,
  capabilities:[{member_id:member,scope_type:'squad',scope_id:'s',capability:'member'},...(rank==='member'?[]:[{member_id:member,scope_type:'squad' as const,scope_id:scope,capability:rank}])]}
}
const call=(auth=actor(),args:Record<string,unknown>={gate_owner:'gate:peer'})=>invokeTool(auth,env,'task_update',{task_id:'task',...args},{sideEffectFree:true})
const row=()=>h.sqlite.prepare("SELECT assignee_agent_id,assignee_member_id,gate_owner FROM tasks WHERE id='task'").get()
describe('task_update assignee gate selection',()=>{
 it('refuses a member assignee setting its own reviewer lane',async()=>{
  const before=row();expect(await call()).toMatchObject({ok:false,status:403,error:'gate_owner_assignee_requires_lead'});expect(row()).toEqual(before)
 })
 it.each(['lead','admin'] as const)('allows task-squad %s to set an initially NULL gate',async rank=>{
  expect(await call(actor('a',rank))).toMatchObject({ok:true});expect(row()?.gate_owner).toBe('gate:peer')
 })
 it('leaves a non-assignee member able to set an initial gate',async()=>{
  expect(await call(actor('b'))).toMatchObject({ok:true});expect(row()?.gate_owner).toBe('gate:peer')
 })
 it('does not borrow lead standing from another squad',async()=>{
  expect(await call(actor('a','lead','other'))).toMatchObject({ok:false,status:403,error:'gate_owner_assignee_requires_lead'})
 })
 it('refuses setting assignee=self and gate in one update',async()=>{
  h.sqlite.exec("UPDATE tasks SET assignee_agent_id=NULL WHERE id='task'")
  const before=row();expect(await call(actor(),{assignee_agent_id:'a',gate_owner:'gate:peer'})).toMatchObject({ok:false,error:'gate_owner_assignee_requires_lead'});expect(row()).toEqual(before)
 })
 it('refuses laundering the current assignee by unassigning self and setting a gate in one update',async()=>{
  const before=row();expect(await call(actor(),{assignee_agent_id:null,gate_owner:'gate:peer'})).toMatchObject({ok:false,error:'assignee_cannot_mutate_own_assignment'});expect(row()).toEqual(before)
 })
 it('applies the rule to a human assignee',async()=>{
  h.sqlite.exec("UPDATE tasks SET assignee_agent_id=NULL,assignee_member_id='human' WHERE id='task'")
  expect(await call(actor(null))).toMatchObject({ok:false,error:'gate_owner_assignee_requires_lead'})
  expect(await call(actor(null,'lead'))).toMatchObject({ok:true})
 })
 it('applies the rule to a resulting human assignee',async()=>{
  h.sqlite.exec("UPDATE tasks SET assignee_agent_id=NULL WHERE id='task'")
  expect(await call(actor(null),{assignee_member_id:'human',gate_owner:'gate:peer'})).toMatchObject({ok:false,error:'gate_owner_assignee_requires_lead'})
 })
 it('allows harmless same-value gate echoes by the assignee',async()=>{
  h.sqlite.exec("UPDATE tasks SET gate_owner='gate:peer' WHERE id='task'")
  expect(await call()).toMatchObject({ok:true})
 })
 it('preserves existing immutability for a squad lead replacing a set gate',async()=>{
  h.sqlite.exec("UPDATE tasks SET gate_owner='gate:original' WHERE id='task'")
  expect(await call(actor('a','lead'))).toMatchObject({ok:false,error:'gate_owner_immutable'});expect(row()?.gate_owner).toBe('gate:original')
 })
 it('registers the new refusal as a strict Security Bar floor',()=>{
  expect(getRule('task.update.gate-owner-assignee')).toMatchObject({floor:true,values:{onboarding:'strict',operating:'strict',under_attack:'strict'},refusalCodes:['gate_owner_assignee_requires_lead']})
  expect(registeredRefusalCodes().has('gate_owner_assignee_requires_lead')).toBe(true)
 })
})


async function http(auth:AuthContext,args:Record<string,unknown>){
 const r=await tasksApp.fetch(new Request('https://pot.test/task',{method:'PATCH',headers:{'content-type':'application/json','origin':'https://pot.test','x-test-auth':JSON.stringify(auth)},body:JSON.stringify(args)}),env)
 return {status:r.status,body:await r.json()}
}
describe('REST task gate selection parity',()=>{
 it('refuses a human member choosing the gate for their own task',async()=>{
  h.sqlite.exec("UPDATE tasks SET assignee_agent_id=NULL,assignee_member_id='human' WHERE id='task'")
  expect(await http(actor(null),{gate_owner:'gate:peer'})).toMatchObject({status:403,body:{error:'gate_owner_assignee_requires_lead'}})
 })
 it('allows a human squad lead to set the initial gate',async()=>{
  h.sqlite.exec("UPDATE tasks SET assignee_agent_id=NULL,assignee_member_id='human' WHERE id='task'")
  expect(await http(actor(null,'lead'),{gate_owner:'gate:peer'})).toMatchObject({status:200});expect(row()?.gate_owner).toBe('gate:peer')
 })
 it('does not use lead standing from a different squad on REST',async()=>{
  h.sqlite.exec("UPDATE tasks SET assignee_agent_id=NULL,assignee_member_id='human' WHERE id='task'")
  expect(await http(actor(null,'lead','other'),{gate_owner:'gate:peer'})).toMatchObject({status:403,body:{error:'gate_owner_assignee_requires_lead'}})
 })
 it('preserves a non-assignee human members initial gate selection',async()=>{
  expect(await http(actor(null),{gate_owner:'gate:peer'})).toMatchObject({status:200})
 })
 it('refuses resulting human self-assignment plus gate selection in one PATCH',async()=>{
  h.sqlite.exec("UPDATE tasks SET assignee_agent_id=NULL WHERE id='task'")
  expect(await http(actor(null),{assignee_member_id:'human',gate_owner:'gate:peer'})).toMatchObject({status:403,body:{error:'gate_owner_assignee_requires_lead'}})
 })
 it('cannot evade the current human-assignee check by unassigning in the same PATCH',async()=>{
  h.sqlite.exec("UPDATE tasks SET assignee_agent_id=NULL,assignee_member_id='human' WHERE id='task'")
  expect(await http(actor(null),{assignee_member_id:null,gate_owner:'gate:peer'})).toMatchObject({status:403,body:{error:'gate_owner_assignee_requires_lead'}})
 })
})


describe('shared gate ownership predicate',()=>{
 it.each([
  ['current agent',{boundAgentId:'a'},'a',null,null,null],
  ['resulting agent',{boundAgentId:'a'},null,'a',null,null],
  ['current human',{memberId:'human'},null,null,'human',null],
  ['resulting human',{memberId:'human'},null,null,null,'human'],
 ] as const)('counts the %s as a work owner',async(_name,auth,currentAgent,nextAgent,currentHuman,nextHuman)=>{
  const {assigneeChangesOwnGate}=await import('../src/tasks/assignee')
  expect(assigneeChangesOwnGate(auth,{gate_owner:null,assignee_agent_id:currentAgent,assignee_member_id:currentHuman},{gate_owner:'gate:peer',assignee_agent_id:nextAgent,assignee_member_id:nextHuman})).toBe(true)
 })
 it('preserves a trusted org-owner authority plane for initial gate selection',async()=>{
  h.sqlite.exec("UPDATE tasks SET assignee_agent_id=NULL,assignee_member_id='human' WHERE id='task'")
  expect(await call({...actor(null),role:'owner'})).toMatchObject({ok:true})
 })
})
