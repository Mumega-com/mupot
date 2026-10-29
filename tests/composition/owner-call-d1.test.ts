// Official local workerd/Miniflare D1, not a deployed Cloudflare database. Concurrent tool-service calls, real migration chain.
import { env as bindings, applyD1Migrations as applyAllMigrations } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ownerCall } from '../../src/owner-call/service'
import type { AuthContext, Env } from '../../src/types'

const testBindings = bindings as unknown as { MUPOT_DB: Env['DB']; TEST_MIGRATIONS: Parameters<typeof applyAllMigrations>[1] }
beforeAll(async () => { await applyAllMigrations(testBindings.MUPOT_DB, testBindings.TEST_MIGRATIONS) })
afterEach(async()=>{expect(await testBindings.MUPOT_DB.prepare('SELECT COUNT(*) n FROM owner_call_commit_guards').first()).toEqual({n:0})})
async function fixture() {
  const tenant = `oc-${crypto.randomUUID()}`
  const db = testBindings.MUPOT_DB
  const now = new Date().toISOString(), future = new Date(Date.now() + 86400_000).toISOString()
  const env = { DB: db, TENANT_SLUG: tenant, OWNER_CALL: '1', OWNER_CALL_HMAC_KEYS: JSON.stringify([{ version: 'v1', key: 'only-a-fixture-key-at-least-32-bytes' }]) } as Env
  const sq = `${tenant}-sq`, human = `${tenant}-human`
  await db.batch([
    db.prepare('INSERT INTO departments(id,slug,name) VALUES(?,?,?)').bind(`${tenant}-dept`,`${tenant}-dept`,'Dept'),
    db.prepare('INSERT INTO squads(id,department_id,slug,name) VALUES(?,?,?,?)').bind(sq,`${tenant}-dept`,sq,'Sq'),
    db.prepare('INSERT INTO members(id,tenant,display_name) VALUES(?,?,?)').bind(human,tenant,'Human'),
  ])
  const actors: AuthContext[] = []
  for (let i=0;i<6;i++) {
    const a=`${tenant}-a${i}`, m=`${a}-member`, token=`${a}-token`, session=`${a}-session`
    await db.batch([
      db.prepare("INSERT INTO agents(id,squad_id,slug,name,role,model,owner_member_id) VALUES(?,?,?,?,'member','test',?)").bind(a,sq,a,'Agent',human),
      db.prepare('INSERT INTO members(id,tenant,display_name) VALUES(?,?,?)').bind(m,tenant,'Agent member'),
      db.prepare('INSERT INTO agent_member_bindings(tenant,agent_id,member_id,created_at) VALUES(?,?,?,?)').bind(tenant,a,m,now),
      db.prepare("INSERT INTO capabilities(id,member_id,scope_type,scope_id,capability) VALUES(?,?,'squad',?,'admin')").bind(`${a}-cap`,m,sq),
      db.prepare("INSERT INTO member_tokens(id,member_id,token_hash,channel,tenant,agent_id) VALUES(?,?,?,'workspace',?,?)").bind(token,m,`${a}-fake-hash`,tenant,a),
      db.prepare("INSERT INTO agent_sessions(id,tenant,agent_id,member_id,auth_kind,credential_id,created_at,last_seen_at,idle_expires_at,absolute_expires_at) VALUES(?,?,?,?,'workspace_token',?,?,?,?,?)").bind(session,tenant,a,m,token,now,now,future,future),
    ])
    actors.push({userId:a,role:'member',email:null,tenant,memberId:m,boundAgentId:a,tokenId:token,channel:'workspace',capabilities:[{member_id:m,scope_type:'squad',scope_id:sq,capability:'admin'}]})
  }
  async function source(a=actors[0]) {
    const id=crypto.randomUUID(), delivery=crypto.randomUUID()
    await db.batch([
      db.prepare(`INSERT INTO elevation_requests(id,tenant,agent_session_id,agent_id,member_id,requested_actions_json,requested_scope_type,requested_scope_id,requested_duration_minutes,reason,status,created_at,decision_expires_at)
        VALUES(?,?,?,?,?,'["action:project_lifecycle"]','squad',?,15,'private','pending',?,?)`).bind(id,tenant,`${a.boundAgentId}-session`,a.boundAgentId,a.memberId,sq,now,future),
      db.prepare("INSERT INTO approval_bot_deliveries(id,tenant,request_id,member_id,chat_id,status,created_at) VALUES(?,?,?,?,?,'reserved',?)").bind(delivery,tenant,id,human,'private-chat',now),
    ])
    return id
  }
  const call=(id:string,key=crypto.randomUUID(),a=actors[0])=>ownerCall(env,a,{ask_key:key,kind:'access',action_ref:{type:'elevation_request',id},reason_code:'access_required'})
  const count=async(table:string)=>Number((await db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE tenant=?`).bind(tenant).first<{n:number}>())?.n)
  return {env,db,tenant,actors,source,call,count}
}
describe('owner_call local D1 conditional commits',()=>{
  it('competing keys and agents share one unresolved reservation',async()=>{
    const f=await fixture(), id=await f.source()
    const out=await Promise.all(Array.from({length:12},(_,i)=>f.call(id,`key-${i}`,f.actors[i%6])))
    expect(out[0]).toMatchObject({ok:true});expect(out.every(r=>r.ok)).toBe(true)
    expect(new Set(out.flatMap(r=>r.ok?[r.result.ask_id]:[])).size).toBe(1)
    expect(await f.count('owner_calls')).toBe(1);expect(await f.count('owner_call_requesters')).toBe(6)
    expect(await f.count('owner_call_outbox')).toBe(0)
  })
  it('competing creates cannot pass 5 per agent',async()=>{
    const f=await fixture(), ids=await Promise.all(Array.from({length:9},()=>f.source()))
    const out=await Promise.all(ids.map(id=>f.call(id)))
    expect(out.filter(r=>r.ok)).toHaveLength(5);expect(await f.count('owner_calls')).toBe(5)
    expect(await f.count('owner_call_requesters')).toBe(5)
  })
  it('competing agents cannot pass 20 per owner',async()=>{
    const f=await fixture()
    const jobs=await Promise.all(Array.from({length:30},async(_,i)=>({a:f.actors[i%6],id:await f.source(f.actors[i%6])})))
    const out=await Promise.all(jobs.map(({a,id})=>f.call(id,crypto.randomUUID(),a)))
    expect(out.filter(r=>r.ok)).toHaveLength(20);expect(await f.count('owner_calls')).toBe(20)
    expect(await f.count('owner_call_requesters')).toBe(20)
  })
  it('concurrent changed payloads for one key leave no orphan ask or association',async()=>{
    const f=await fixture(), ids=await Promise.all([f.source(),f.source()])
    const out=await Promise.all(ids.map(id=>f.call(id,'same-key')))
    expect(out.filter(r=>r.ok)).toHaveLength(1)
    expect(out.find(r=>!r.ok)).toMatchObject({ok:false,error:'ask_key_conflict'})
    expect(await f.count('owner_calls')).toBe(1);expect(await f.count('owner_call_requesters')).toBe(1)
  })
  it('10 unresolved requester associations hold under concurrent local D1 writes',async()=>{
    const f=await fixture(),a=f.actors[0],ids=await Promise.all(Array.from({length:12},()=>f.source()))
    const old=new Date(Date.now()-3600_000).toISOString()
    for(const [i,id] of ids.slice(0,9).entries()) await f.db.batch([
      f.db.prepare(`INSERT INTO owner_calls(id,tenant,owner_member_id,owner_revision,created_by_agent_id,source_agent_id,kind,action_type,action_id,action_version,reason_code,canonical_delivery_id,created_at)
        SELECT ?,?,member_id,0,?,?,'access','elevation_request',?,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','access_required',id,? FROM approval_bot_deliveries WHERE tenant=? AND request_id=?`)
        .bind(`oc-${id}`,f.tenant,a.boundAgentId,a.boundAgentId,id,new Date(Date.now()-(40-i)*900_001).toISOString(),f.tenant,id),
      f.db.prepare('INSERT INTO owner_call_requesters(tenant,ask_id,agent_id,owner_revision,created_at) VALUES(?,?,?,0,?)').bind(f.tenant,`oc-${id}`,a.boundAgentId,old),
    ])
    const out=await Promise.all(ids.slice(9).map(id=>f.call(id)))
    expect(out.filter(r=>r.ok)).toHaveLength(1)
    expect(await f.count('owner_calls')).toBe(10);expect(await f.count('owner_call_requesters')).toBe(10)
  })
  it('40 ordinary owner slots hold under competing local D1 writes and roll back losers',async()=>{
    const f=await fixture(),old=new Date(Date.now()-3600_000).toISOString()
    for(let i=0;i<39;i++){
      const a=f.actors[i%6],id=await f.source(a)
      await f.db.batch([
        f.db.prepare(`INSERT INTO owner_calls(id,tenant,owner_member_id,owner_revision,created_by_agent_id,source_agent_id,kind,action_type,action_id,action_version,reason_code,canonical_delivery_id,created_at)
          SELECT ?,?,member_id,0,?,?,'access','elevation_request',?,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','access_required',id,? FROM approval_bot_deliveries WHERE tenant=? AND request_id=?`)
          .bind(`oc-${id}`,f.tenant,a.boundAgentId,a.boundAgentId,id,new Date(Date.now()-(40-i)*900_001).toISOString(),f.tenant,id),
        f.db.prepare('INSERT INTO owner_call_requesters(tenant,ask_id,agent_id,owner_revision,created_at) VALUES(?,?,?,0,?)').bind(f.tenant,`oc-${id}`,a.boundAgentId,old),
      ])
    }
    const jobs=await Promise.all(f.actors.map(async a=>({a,id:await f.source(a)})))
    const out=await Promise.all(jobs.map(({a,id})=>f.call(id,crypto.randomUUID(),a)))
    expect(out.filter(r=>r.ok)).toHaveLength(1)
    expect(await f.count('owner_calls')).toBe(40);expect(await f.count('owner_call_requesters')).toBe(40)
  })

  it('an admitted effective agent uses canonical live attachment predicates on local D1',async()=>{
    const f=await fixture(),a=f.actors[0],seatAgent=f.actors[2].boundAgentId!,human=`${f.tenant}-human`,hr=`${f.tenant}-hr`,seat=`${f.tenant}-seat`,grant=`${f.tenant}-grant`,adm=`${f.tenant}-adm`,att=`${f.tenant}-att`,now=new Date().toISOString()
    await f.db.batch([
      f.db.prepare("INSERT INTO capabilities(id,member_id,scope_type,scope_id,capability) VALUES(?,?,'squad',?,'admin')").bind(`${f.tenant}-human-admin`,human,a.capabilities![0].scope_id),
      f.db.prepare("INSERT INTO harnesses(id,tenant,member_id,oauth_client_id,credential_kind,grant_id) VALUES(?,?,?,?,'oauth',?)").bind(hr,f.tenant,human,`${f.tenant}-client`,`oauth:${grant}`),
      f.db.prepare("INSERT INTO member_tokens(id,member_id,token_hash,channel,tenant) VALUES(?,?,?,'directory',?)").bind(grant,human,`${f.tenant}-fake-grant-hash`,f.tenant),
      f.db.prepare("INSERT INTO agent_seats(id,tenant,member_id,harness_id,key_hash,agent_id,max_live,source,seat_token_id) VALUES(?,?,?,?,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',?,32,'select',?)").bind(seat,f.tenant,human,hr,seatAgent,`${seatAgent}-token`),
      f.db.prepare("INSERT INTO agent_seat_admissions(id,tenant,agent_id,human_member_id,harness_id,status,ceiling,requested_via,requested_seat_id,created_at,decided_at,decided_by_member_id,decided_via) VALUES(?,?,?,?,?,'live','member','dashboard',?,?,?,?,'dashboard')").bind(adm,f.tenant,a.boundAgentId,human,hr,seat,now,now,human),
      f.db.prepare('INSERT INTO agent_seat_attachments(id,tenant,seat_id,human_member_id,harness_id,agent_id,admission_id,seat_token_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(att,f.tenant,seat,human,hr,a.boundAgentId,adm,a.tokenId,now),
      f.db.prepare("UPDATE member_tokens SET channel='directory' WHERE id=?").bind(a.tokenId),
      f.db.prepare("UPDATE agent_sessions SET auth_kind='oauth' WHERE id=?").bind(`${a.boundAgentId}-session`),
    ])
    const bound:AuthContext={...a,channel:'directory',consentedByMemberId:human,seatBinding:{seatId:seat,label:'Fixture',harnessId:hr,grantTokenId:grant,humanMemberId:human,source:'handle',attached:{attachmentId:att,admissionId:adm,agentId:a.boundAgentId!,seatAgentId:seatAgent,ceiling:'member'}}}
    const id=await f.source(a)
    expect(await f.call(id,'admitted',bound)).toMatchObject({ok:true})
    await f.db.prepare("UPDATE agent_seat_admissions SET status='revoked',revoked_at=? WHERE id=?").bind(now,adm).run()
    expect(await f.call(id,'admitted',bound)).toMatchObject({ok:false,error:'agent_binding_required'})
  })

})
