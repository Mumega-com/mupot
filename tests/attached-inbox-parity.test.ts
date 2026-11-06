// Regression derived from the private #2356 gate probe; migration-backed, no real transport.
import { describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp'
import { leaseAgentInbox } from '../src/agents/messages'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1 } from './helpers/sqlite-d1'

function fixture() {
  const h = createSqliteD1(); applyAllMigrations(h.sqlite)
  h.sqlite.exec(`
    INSERT INTO departments(id,slug,name) VALUES ('d','d','D');
    INSERT INTO squads(id,department_id,slug,name) VALUES ('s','d','s','S');
    INSERT INTO members(id,tenant,display_name,status) VALUES ('m','t','M','active'),('human','t','Human','active');
    INSERT INTO agents(id,squad_id,slug,name,status) VALUES ('a','s','a','A','active');
    INSERT INTO memberships(id,agent_id,squad_id,capability) VALUES ('am','a','s','member');
    INSERT INTO agent_member_bindings(tenant,agent_id,member_id,created_at) VALUES ('t','a','m','2026-01-01');
    INSERT INTO capabilities(id,member_id,scope_type,scope_id,capability) VALUES ('c','m','squad','s','member');
    INSERT INTO member_tokens(id,member_id,token_hash,label,channel,agent_id,tenant,expires_at)
      VALUES ('tok','m','hash','attach:a:xyz','directory','a','t','2099-01-01');
    INSERT INTO agent_messages(id,tenant,to_agent,from_agent,from_member,kind,body,target_seat) VALUES
      ('host-mail','t','a','sender','sender','message','host-only work',NULL),
      ('host-targeted','t','a','sender','sender','message','host-targeted work','daemon'),
      ('other-chat','t','a','sender','sender','message','another chat work','attach:a:other'),
      ('own-mail','t','a','sender','sender','message','chat work','attach:a:xyz');
  `)
  const auth: AuthContext = { userId:'m',memberId:'m',email:null,role:'member',tenant:'t',channel:'directory',tokenId:'tok',boundAgentId:'a',
    capabilities:[{member_id:'m',scope_type:'squad',scope_id:'s',capability:'member'}],consentedByMemberId:'human',
    seatBinding:{seatId:'seat',label:'chat',harnessId:'h',grantTokenId:'grant',humanMemberId:'human',source:'handle',
      attached:{attachmentId:'att',admissionId:'adm',agentId:'a',seatAgentId:'sa',ceiling:'member'}} }
  const env={DB:h.db,TENANT_SLUG:'t'} as Env
  const call=(tool:string,args:Record<string,unknown>={},actor=auth)=>invokeTool(actor,env,tool,args,{sideEffectFree:true})
  const hostRows=()=>h.sqlite.prepare("SELECT id,read_at,delivery_attempts,lease_expires_at,dead_lettered_at FROM agent_messages WHERE id <> 'own-mail' ORDER BY id").all()
  return {h,auth,env,call,hostRows}
}
describe('attached inbox ownership',()=>{
  it('repeated short non-attempt leases cannot advance or dead-letter host mail',async()=>{
    const f=fixture()
    try {
      const before=f.hostRows()
      for(let i=0;i<6;i++) expect(await f.call('inbox_lease',{limit:100,lease_seconds:1})).toMatchObject({ok:false,status:403,error:'attached_seat_attempt_required'})
      expect(await f.call('inbox_ack',{ids:['host-mail']})).toMatchObject({ok:false,error:'attached_seat_peek_only'})
      expect(f.hostRows()).toEqual(before)
    } finally {f.h.close()}
  })
  it('leases only the exact authenticated seat target and can ack its durable attempt',async()=>{
    const f=fixture()
    try {
      const before=f.hostRows()
      expect(await f.call('inbox_lease',{limit:1,attempt_id:'own_attempt_00001'})).toMatchObject({ok:true,result:{messages:[{id:'own-mail'}]}})
      expect(await f.call('inbox_lease_reconcile',{attempt_id:'own_attempt_00001'})).toMatchObject({ok:true,result:{messages:[{id:'own-mail'}]}})
      expect(await f.call('inbox_lease_ack',{attempt_id:'own_attempt_00001'})).toMatchObject({ok:true,result:{consumed:true}})
      expect(await f.call('inbox_lease',{limit:1,attempt_id:'own_attempt_00002'})).toMatchObject({ok:true,result:{messages:[]}})
      expect(f.hostRows()).toEqual(before)
    } finally {f.h.close()}
  })
  it.each(['inbox_lease_reconcile','inbox_lease_ack'])('%s cannot read or ack an old broad attempt that holds untargeted host mail',async tool=>{
    const f=fixture()
    try {
      const old=await leaseAgentInbox(f.env,{agent:'a',seat:'attach:a:xyz',limit:1,attemptId:'old_attempt_00001'})
      expect(old).toMatchObject({ok:true,messages:[{id:'host-mail'}]})
      const before=f.hostRows()
      const response=await f.call(tool,{attempt_id:'old_attempt_00001'})
      expect(JSON.stringify(response)).not.toContain('host-only work')
      expect(response).not.toMatchObject({ok:true,result:{consumed:true}})
      expect(f.hostRows()).toEqual(before)
    } finally {f.h.close()}
  })
  it.each(['inbox_lease','inbox_lease_reconcile','inbox_lease_ack'])('%s fails closed if the attachment token has no bound seat label',async tool=>{
    const f=fixture()
    try {
      f.h.sqlite.exec("UPDATE member_tokens SET label='' WHERE id='tok'")
      expect(await f.call(tool,tool==='inbox_lease'?{limit:1,attempt_id:'own_attempt_00001'}:{attempt_id:'own_attempt_00001'})).toMatchObject({ok:false,status:403,error:'seat_not_bound'})
      expect(f.hostRows().every(r=>r.delivery_attempts===0)).toBe(true)
    } finally {f.h.close()}
  })
  it('does not let another attachment token spoof the first chats seat label',async()=>{
    const f=fixture()
    try {
      f.h.sqlite.exec(`INSERT INTO member_tokens(id,member_id,token_hash,label,channel,agent_id,tenant,expires_at) VALUES ('tok-other','m','hash-other','attach:a:other','directory','a','t','2099-01-01')`)
      const other={...f.auth,tokenId:'tok-other',seatBinding:{...f.auth.seatBinding!,seatId:'other-seat',label:'attach:a:xyz',attached:{...f.auth.seatBinding!.attached!,attachmentId:'other-att'}}}
      expect(await f.call('inbox_lease',{limit:1,attempt_id:'other_attempt_0001',seat:'attach:a:xyz'},other)).toMatchObject({ok:false})
      expect(await f.call('inbox_lease',{limit:1,attempt_id:'other_attempt_0001'},other)).toMatchObject({ok:true,result:{effective_inbox_seat:'attach:a:other',messages:[{id:'other-chat'}]}})
      expect(f.h.sqlite.prepare("SELECT delivery_attempts FROM agent_messages WHERE id='own-mail'").get()).toEqual({delivery_attempts:0})
    } finally {f.h.close()}
  })
  it('keeps host bearer broad leasing unchanged',async()=>{
    const f=fixture()
    try {
      const host={...f.auth,channel:'workspace' as const,seatBinding:undefined,consentedByMemberId:undefined}
      expect(await f.call('inbox_lease',{limit:100},host)).toMatchObject({ok:true,result:{messages:[{id:'host-mail'},{id:'own-mail'}]}})
    } finally {f.h.close()}
  })
  it('refuses pre-pause attempt ACK explicitly until the operator resumes the agent',async()=>{
    const f=fixture()
    try {
      expect(await f.call('inbox_lease',{limit:1,attempt_id:'own_attempt_00001'})).toMatchObject({ok:true})
      f.h.sqlite.exec("UPDATE agents SET status='paused' WHERE id='a'")
      expect(await f.call('inbox_lease_ack',{attempt_id:'own_attempt_00001'})).toMatchObject({ok:false,status:403,error:'agent_paused',detail:{next_step:expect.stringMatching(/resume.*retry/i)}})
      expect(f.h.sqlite.prepare("SELECT read_at FROM agent_messages WHERE id='own-mail'").get()).toEqual({read_at:null})
      f.h.sqlite.exec("UPDATE agents SET status='active' WHERE id='a'")
      expect(await f.call('inbox_lease_ack',{attempt_id:'own_attempt_00001'})).toMatchObject({ok:true,result:{consumed:true}})
    } finally {f.h.close()}
  })
})


describe('pause refusal contract',()=>{
  it.each([
    ['objective_accept',{squadId:'s',title:'Work',successContract:'Done',authorityEnvelope:{},policy:{},budgetMicroUsd:0,payload:{},idempotencyKey:'paused'}],
    ['objective_get',{objectiveId:'missing'}],['execution_receipt_get',{receiptId:'missing'}],
    ['inbox_lease',{limit:1,attempt_id:'pause_attempt_0001'}],['inbox_lease_reconcile',{attempt_id:'pause_attempt_0001'}],['inbox_lease_ack',{attempt_id:'pause_attempt_0001'}],
    ['get_agent_webhook_doorbell',{}],['list_agent_webhook_doorbell_receipts',{}],
  ] as Array<[string,Record<string,unknown>]>)('%s distinguishes a pause from revocation',async(tool,args)=>{
    const f=fixture()
    try {
      f.env.WEBHOOK_DOORBELL='1'
      f.h.sqlite.exec("UPDATE agents SET status='paused' WHERE id='a'")
      expect(await f.call(tool,args)).toMatchObject({ok:false,status:403,error:'agent_paused',detail:{next_step:expect.stringMatching(/resume.*retry/i)}})
      f.h.sqlite.exec("UPDATE members SET status='suspended' WHERE id='human'")
      expect(await f.call(tool,args)).toMatchObject({ok:false,status:403,error:'agent_not_authorized'})
    } finally {f.h.close()}
  })
})

describe('exact-seat service boundary',()=>{
  it('fails closed before a direct service caller can use exact-seat mode without seat and durable attempt',async()=>{
    const f=fixture()
    try {
      const before=f.hostRows()
      expect(await leaseAgentInbox(f.env,{agent:'a',seat:'attach:a:xyz',exactSeatOnly:true})).toMatchObject({ok:false,reason:'invalid_attempt'})
      expect(await leaseAgentInbox(f.env,{agent:'a',limit:1,attemptId:'own_attempt_00001',exactSeatOnly:true})).toMatchObject({ok:false,reason:'invalid_attempt'})
      expect(f.hostRows()).toEqual(before)
    } finally {f.h.close()}
  })
})
