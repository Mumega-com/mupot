import { describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1 } from './helpers/sqlite-d1'

const doors = ['bearer', 'oauth', 'attached'] as const
type Door = typeof doors[number]
function fixture(door: Door) {
  const h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  h.sqlite.exec(`
    INSERT INTO departments(id,slug,name) VALUES ('d','d','D');
    INSERT INTO squads(id,department_id,slug,name) VALUES ('s','d','s','S'),('other-s','d','other','Other');
    INSERT INTO members(id,tenant,display_name,status) VALUES ('m','t','M','active'),('human','t','Human','active'),('other-m','t','Other','active');
    INSERT INTO agents(id,squad_id,slug,name,status) VALUES ('a','s','a','A','active'),('other','other-s','other','Other','active');
    INSERT INTO memberships(id,agent_id,squad_id,capability) VALUES ('am','a','s','member'),('other-am','other','other-s','member');
    INSERT INTO agent_member_bindings(tenant,agent_id,member_id,created_at) VALUES ('t','a','m','2026-01-01'),('t','other','other-m','2026-01-01');
    INSERT INTO capabilities(id,member_id,scope_type,scope_id,capability) VALUES ('c','m','squad','s','member'),('human-c','human','squad','s','member'),('other-c','other-m','squad','other-s','member');
    INSERT INTO member_tokens(id,member_id,token_hash,label,channel,agent_id,tenant,expires_at)
      VALUES ('tok','m','hash','','${door === 'bearer' ? 'workspace' : 'directory'}','a','t','2099-01-01');
    INSERT INTO agent_messages(id,tenant,to_agent,from_agent,from_member,kind,body) VALUES ('mail','t','a','sender','sender','message','hello');
  `)
  const auth: AuthContext = { userId: 'm', memberId: 'm', email: null, role: 'member', tenant: 't',
    channel: door === 'bearer' ? 'workspace' : 'directory', tokenId: 'tok', boundAgentId: 'a',
    capabilities: [{member_id:'m',scope_type:'squad',scope_id:'s',capability:'member'}],
    ...(door === 'bearer' ? {} : { consentedByMemberId: 'human' }),
    ...(door !== 'attached' ? {} : {seatBinding: {seatId:'seat',label:'chat',harnessId:'h',grantTokenId:'grant',humanMemberId:'human',source:'handle' as const,
      attached:{attachmentId:'att',admissionId:'adm',agentId:'a',seatAgentId:'seat-agent',ceiling:'member' as const}}}),
  }
  const env = {DB:h.db,TENANT_SLUG:'t',WEBHOOK_DOORBELL:'1'} as Env
  const call = (tool: string, args: Record<string,unknown> = {}, actor = auth) => invokeTool(actor,env,tool,args,{sideEffectFree:true})
  return {h,auth,env,call}
}
const objective = {squadId:'s',title:'Own work',successContract:'Reviewed',authorityEnvelope:{},policy:{},budgetMicroUsd:0,payload:{},idempotencyKey:'parity'}

describe.each(doors)('%s bound-agent parity', door => {
  it('accepts and reads an objective and its receipt; other-squad resources stay hidden', async () => {
    const f=fixture(door)
    try {
      const accepted=await f.call('objective_accept',objective)
      expect(accepted).toMatchObject({ok:true})
      if (!accepted.ok) return
      const o=(accepted.result as {objective:{id:string;acceptanceReceiptId:string}}).objective
      expect(await f.call('objective_get',{objectiveId:o.id})).toMatchObject({ok:true})
      expect(await f.call('execution_receipt_get',{receiptId:o.acceptanceReceiptId})).toMatchObject({ok:true})
      expect(await f.call('objective_accept',{...objective,squadId:'other-s'})).toMatchObject({ok:false,status:403})
      const stranger={...f.auth,boundAgentId:'other',memberId:'other-m',userId:'other-m',consentedByMemberId:undefined,capabilities:[{member_id:'other-m',scope_type:'squad' as const,scope_id:'other-s',capability:'member' as const}]}
      expect(await f.call('objective_get',{objectiveId:o.id},stranger)).toMatchObject({ok:false,status:404})
      expect(await f.call('execution_receipt_get',{receiptId:o.acceptanceReceiptId},stranger)).toMatchObject({ok:false,status:404})
    } finally {f.h.close()}
  })
  it('leases, reconciles and acknowledges only the bound recipient attempt', async () => {
    const f=fixture(door)
    try {
      if(door==='attached') expect(await f.call('inbox_consumer_status')).toMatchObject({ok:true,result:{mode:'lease_only',can_consume:true}})
      expect(await f.call('inbox_lease',{limit:1,attempt_id:'attempt_parity_001'})).toMatchObject({ok:true,result:{messages:[{id:'mail'}]}})
      expect(await f.call('inbox_lease_reconcile',{attempt_id:'attempt_parity_001'})).toMatchObject({ok:true})
      expect(await f.call('inbox_lease_ack',{attempt_id:'attempt_parity_001'})).toMatchObject({ok:true,result:{consumed:true}})
      f.h.sqlite.exec(`INSERT INTO agent_inbox_fences(tenant,agent_id,mode,generation,updated_by_member_id,reason,updated_at,key_fingerprint) VALUES ('t','a','signed_only',1,'m','test','2026-01-01','${'a'.repeat(64)}')`)
      if(door==='attached') expect(await f.call('inbox_consumer_status')).toMatchObject({ok:true,result:{can_consume:false}})
      expect(await f.call('inbox_lease',{limit:1})).toMatchObject({ok:false,status:409,error:'consumer_fenced'})
    } finally {f.h.close()}
  })
  it.each(['get_agent_webhook_doorbell','list_agent_webhook_doorbell_receipts'])('reads own redacted %s and refuses another agent',async tool=>{
    const f=fixture(door)
    try {
      expect(await f.call(tool)).toMatchObject({ok:true})
      expect(await f.call(tool,{agent:'other'})).toMatchObject({ok:false,status:403})
    } finally {f.h.close()}
  })
  if(door === 'attached') it('refuses redirecting the host doorbell from an attached seat',async()=>{
    const f=fixture(door)
    try {
      expect(await f.call('set_agent_webhook_doorbell',{webhook_url:'https://hooks.example.test/wake',bearer:'test-only-doorbell-bearer'})).toMatchObject({ok:false,status:403})
    } finally {f.h.close()}
  })
  it.each(['paused','inactive'])('refuses %s agent on every parity tool',async status=>{
    const f=fixture(door)
    try {
      f.h.sqlite.prepare('UPDATE agents SET status=? WHERE id=?').run(status,'a')
      for(const [tool,args] of [['objective_accept',objective],['objective_get',{objectiveId:'missing'}],['execution_receipt_get',{receiptId:'missing'}],['inbox_lease',{}],['inbox_lease_reconcile',{attempt_id:'attempt_parity_001'}],['inbox_lease_ack',{attempt_id:'attempt_parity_001'}],['get_agent_webhook_doorbell',{}],['list_agent_webhook_doorbell_receipts',{}]] as const)
        expect(await f.call(tool,args),tool).toMatchObject({ok:false,status:403})
    } finally {f.h.close()}
  })
})

describe.each(doors)('%s live binding boundaries', door => {
  const tools: Array<[string,Record<string,unknown>]> = [
    ['objective_accept',objective],['objective_get',{objectiveId:'missing'}],['execution_receipt_get',{receiptId:'missing'}],
    ['inbox_lease',{}],['inbox_lease_reconcile',{attempt_id:'attempt_parity_001'}],['inbox_lease_ack',{attempt_id:'attempt_parity_001'}],
    ['get_agent_webhook_doorbell',{}],['list_agent_webhook_doorbell_receipts',{}],
  ]
  it('refuses an unbound directory session without consuming mail', async () => {
    const f=fixture(door)
    try {
      const unbound={...f.auth,boundAgentId:null,channel:'directory' as const,capabilities:[]}
      for(const [tool,args] of tools) expect(await f.call(tool,tool.includes('webhook_doorbell') ? {agent:'a'} : args,unbound),tool).toMatchObject({ok:false,status:403})
      expect(f.h.sqlite.prepare("SELECT read_at FROM agent_messages WHERE id='mail'").get()).toEqual({read_at:null})
    } finally {f.h.close()}
  })
  it('refuses every operation when the bound agent owner is suspended',async()=>{
    const f=fixture(door)
    try {
      f.h.sqlite.exec("UPDATE agents SET owner_member_id='human' WHERE id='a'; UPDATE members SET status='suspended' WHERE id='human'")
      for(const [tool,args] of tools) expect(await f.call(tool,args),tool).toMatchObject({ok:false,status:403})
    } finally {f.h.close()}
  })
  it('refuses a revoked live capability/consenter on every operation', async () => {
    const f=fixture(door)
    try {
      if(door==='bearer') f.h.sqlite.exec("DELETE FROM capabilities WHERE member_id='m'")
      else f.h.sqlite.exec("UPDATE members SET status='suspended' WHERE id='human'")
      for(const [tool,args] of tools) expect(await f.call(tool,args),tool).toMatchObject({ok:false,status:403})
    } finally {f.h.close()}
  })
})

describe('shared caller resolver',()=>{
  it('requires tenant, agent, member and a nonempty authenticated ceiling', async()=>{
    const {resolveBoundAgentCaller}=await import('../src/auth/bound-agent-caller')
    const f=fixture('bearer')
    try {
      for(const changed of [{tenant:'other'}, {boundAgentId:null}, {memberId:undefined}, {capabilities:[]}])
        expect(await resolveBoundAgentCaller(f.env,{...f.auth,...changed})).toMatchObject({ok:false,status:403})
      const unavailable={...f.env,DB:{prepare(){throw new Error('private DB detail')}}} as unknown as Env
      expect(await resolveBoundAgentCaller(unavailable,f.auth)).toEqual({ok:false,status:503,error:'agent_check_unavailable'})
    } finally {f.h.close()}
  })
  it('keeps cross-tenant objective and receipt reads absent',async()=>{
    const f=fixture('bearer')
    try {
      const other={...f.auth,tenant:'elsewhere'}
      expect(await f.call('objective_get',{objectiveId:'missing'},other)).toMatchObject({ok:false,status:404,error:'objective_not_found'})
      expect(await f.call('execution_receipt_get',{receiptId:'missing'},other)).toMatchObject({ok:false,status:404,error:'receipt_not_found'})
    } finally {f.h.close()}
  })
  it('keeps signed polling pause semantics while agent work requires active',async()=>{
    const {resolveBoundAgentCaller}=await import('../src/auth/bound-agent-caller')
    const {signerVerdict}=await import('../src/fleet/agent-keys')
    const f=fixture('bearer')
    try {
      const signed={tenant:'t',boundAgentId:'a',memberId:'m'}
      expect(await resolveBoundAgentCaller(f.env,signed)).toMatchObject({ok:true,agentId:'a'})
      expect(await signerVerdict(f.env,'a',{member_id:'m',pubkey:'already-verified-key',algo:'Ed25519'})).toBe('live')
      f.h.sqlite.exec("UPDATE agents SET status='paused' WHERE id='a'")
      expect(await resolveBoundAgentCaller(f.env,signed)).toMatchObject({ok:false,status:403})
      expect(await signerVerdict(f.env,'a',{member_id:'m',pubkey:'already-verified-key',algo:'Ed25519'})).toBe('live')
    } finally {f.h.close()}
  })
})
