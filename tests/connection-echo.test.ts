import {afterEach,beforeEach,describe,expect,it} from 'vitest'
import type {Env} from '../src/types'
import {createSqliteD1,type SqliteD1Harness} from './helpers/sqlite-d1'
import {applyAllMigrations} from './helpers/migrations'
import {startConnectionEcho,finishConnectionEcho,loadConnectionEcho} from '../src/members/connection-echo'

const TENANT='tenant-wake'
const T0=Date.parse('2026-11-17T12:00:00.000Z')
const context={agentId:'agent-1',credentialId:'token-1',memberId:'member-1',harnessId:'harness-1'}
let db:SqliteD1Harness
let env:Env
function seed(): void {
  db.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'squad', 'Squad');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('member-1', 'Member', 'active', '${TENANT}');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-1', 'squad-1', 'agent', 'Agent', 'member', 'test', 'active');
    INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES ('membership-1', 'agent-1', 'squad-1', 'member');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', 'agent-1', 'member-1', '2026-01-01T00:00:00.000Z');
    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
      VALUES ('token-1', 'member-1', '${'a'.repeat(64)}', 'wake', 'workspace', '2026-01-01T00:00:00.000Z', 'agent-1', '${TENANT}');
    INSERT INTO fleet_agents (tenant, agent_id, runtime, status) VALUES ('${TENANT}', 'agent-1', 'codex', 'running');
  `)
}


async function challenge(at=T0):Promise<{message_id:string;nonce:string}> {
  const result=await startConnectionEcho(env,context,at);expect(result).toMatchObject({ok:true,state:'pending'})
  if(!result.ok)throw new Error(result.error)
  const body=await env.DB.prepare('SELECT body FROM agent_messages WHERE id=?1').bind(result.message_id).first<string>('body')
  const nonce=body!.match(/: ([0-9a-f-]{36})$/)![1]
  expect(JSON.stringify(result)).not.toContain(nonce)
  return {...result,nonce}
}
async function returnEcho(at=T0+2000) {
  const pending=await challenge();expect(await finishConnectionEcho(env,context,pending.nonce,at)).toMatchObject({ok:true,state:'echo_roundtrip'})
  return pending
}
/** Interleave an actual SQLite commit before the next write. No SQL parsing or result stubs. */
function beforeNextWrite(effect:()=>void):Env {
  let fired=false
  const wrap=(stmt:D1PreparedStatement):D1PreparedStatement=>new Proxy(stmt,{get(target,key){
    if(key==='bind') return (...args:unknown[])=>wrap(target.bind(...args))
    if(key==='run') return async()=>{if(!fired){fired=true;effect()}return target.run()}
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
  }})
  return {...env,DB:new Proxy(env.DB,{get(target,key){
    if(key==='prepare') return (sql:string)=>wrap(target.prepare(sql))
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
  }})}
}


describe('own connection inbox echo',()=>{
  beforeEach(()=>{db=createSqliteD1();applyAllMigrations(db.sqlite);env={DB:db.db,TENANT_SLUG:TENANT} as Env;seed()})
  afterEach(()=>db.close())

  it('returns only an inbox echo with challenge-to-reply latency and no poll witnesses',async()=>{
    const pending=await challenge();const {readAgentInbox}=await import('../src/agents/messages')
    const read=await readAgentInbox(env,{agent:'agent-1'},{now:()=>new Date(T0+100).toISOString()})
    expect(read).toMatchObject({ok:true});if(!read.ok)throw new Error(read.reason)
    expect(read.messages.some(m=>m.body.includes(pending.nonce))).toBe(true)
    const result=await finishConnectionEcho(env,context,pending.nonce,T0+2000)
    expect(result).toEqual({ok:true,state:'echo_roundtrip',echo_returned_at:new Date(T0+2000).toISOString(),path:'inbox_echo',latency_ms:2000,reason:'echo_returned'})
    expect(await loadConnectionEcho(env,context,T0+2001)).toMatchObject({state:'echo_roundtrip',path:'inbox_echo',latency_ms:2000})
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM agent_audit WHERE action='connection_wake_inbox_read'").first<number>('n')).toBe(0)
    const record=await env.DB.prepare("SELECT after_state FROM agent_audit WHERE action='connection_echo_returned'").first<string>('after_state')
    expect(JSON.parse(record!)).toMatchObject({state:'echo_roundtrip',path:'inbox_echo',latency_ms:2000})
  })
  it('wake_proven and native_wake are unreachable even with a successful native delivery receipt',async()=>{
    const pending=await challenge();const {eventIdFor}=await import('../src/bus/events-delivery')
    await env.DB.prepare("INSERT INTO event_subscriptions(id,tenant,agent_id,member_id,token_id,event_name,callback_url,secret_ciphertext,secret_fingerprint,status,refresh_before,created_at,last_refreshed_at) VALUES('native-sub',?1,'agent-1','member-1','token-1','message.created','https://wake.example','cipher','12345678','active','2030-01-01','2026-01-01','2026-01-01')").bind(TENANT).run()
    await env.DB.prepare("INSERT INTO event_delivery_receipts(id,subscription_id,event_id,attempt,outcome,http_status,created_at) VALUES('native-receipt','native-sub',?1,1,'delivered',204,?2)").bind(await eventIdFor('native-sub',pending.message_id),new Date(T0+1000).toISOString()).run()
    const result=await finishConnectionEcho(env,context,pending.nonce,T0+2000)
    const status=await loadConnectionEcho(env,context,T0+2001)
    expect(result).toMatchObject({ok:true,state:'echo_roundtrip',path:'inbox_echo',latency_ms:2000})
    expect(JSON.stringify({result,status})).not.toMatch(/wake_proven|native_wake|wake_proven_at|delivery_to_reply/)
  })
  it('does not depend on any native or doorbell receipt table',async()=>{
    const pending=await challenge()
    db.sqlite.exec('DROP TABLE event_delivery_receipts; DROP TABLE agent_webhook_doorbell_receipts;')
    expect(await finishConnectionEcho(env,context,pending.nonce,T0+2000)).toMatchObject({ok:true,state:'echo_roundtrip',path:'inbox_echo'})
  })
  it('reuses an unexpired pending challenge without exposing its nonce',async()=>{
    const pending=await challenge();const again=await startConnectionEcho(env,context,T0+1)
    expect(again).toMatchObject({ok:true,message_id:pending.message_id});expect(JSON.stringify(again)).not.toContain(pending.nonce)
    const audit=await env.DB.prepare("SELECT after_state FROM agent_audit WHERE action='connection_echo_challenge'").first<string>('after_state')
    expect(audit).not.toContain(pending.nonce)
  })
  it('the exact ten-minute expiry filter rejects a reply',async()=>{
    const pending=await challenge()
    expect(await finishConnectionEcho(env,context,pending.nonce,T0+600000)).toMatchObject({ok:false,error:'echo_challenge_expired'})
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM agent_audit WHERE action='connection_echo_returned'").first<number>('n')).toBe(0)
  })
  it('accepts a reply just before expiry',async()=>{
    const pending=await challenge();expect(await finishConnectionEcho(env,context,pending.nonce,T0+599999)).toMatchObject({ok:true,state:'echo_roundtrip'})
  })
  it('an expired pending challenge is replaced and its nonce cannot finish the replacement',async()=>{
    const pending=await challenge();const fresh=await startConnectionEcho(env,context,T0+600000)
    expect(fresh).toMatchObject({ok:true,state:'pending'});if(!fresh.ok)throw new Error(fresh.error)
    expect(fresh.message_id).not.toBe(pending.message_id)
    expect(await finishConnectionEcho(env,context,pending.nonce,T0+600001)).toMatchObject({ok:false,error:'echo_nonce_invalid'})
  })
  it('wrong nonce cannot consume the challenge, and a successful reply cannot be replayed',async()=>{
    const pending=await challenge()
    expect(await finishConnectionEcho(env,context,'wrong',T0+1000)).toMatchObject({ok:false,error:'echo_nonce_invalid'})
    expect(await finishConnectionEcho(env,context,pending.nonce,T0+2000)).toMatchObject({ok:true,state:'echo_roundtrip'})
    expect(await finishConnectionEcho(env,context,pending.nonce,T0+2001)).toMatchObject({ok:false,error:'echo_challenge_replayed'})
  })
  it('concurrent replies record at most one successful return',async()=>{
    const pending=await challenge();const results=await Promise.all([finishConnectionEcho(env,context,pending.nonce,T0+2000),finishConnectionEcho(env,context,pending.nonce,T0+2000)])
    expect(results.filter(x=>x.ok)).toHaveLength(1)
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM agent_audit WHERE action='connection_echo_returned'").first<number>('n')).toBe(1)
  })
  it.each(['revoked','expired','suspended','archived','inactive'] as const)('refuses a %s credential context',async mode=>{
    const pending=await challenge()
    if(mode==='revoked')db.sqlite.exec("UPDATE member_tokens SET revoked_at='2026-11-17T12:00:01Z'")
    if(mode==='expired')db.sqlite.exec("UPDATE member_tokens SET expires_at='2026-11-17T12:00:01Z'")
    if(mode==='suspended')db.sqlite.exec("UPDATE members SET status='suspended' WHERE id='member-1'")
    if(mode==='archived')db.sqlite.exec("UPDATE agents SET archived_at='2026-11-17T12:00:01Z' WHERE id='agent-1'")
    if(mode==='inactive')db.sqlite.exec("UPDATE agents SET status='inactive' WHERE id='agent-1'")
    expect(await finishConnectionEcho(env,context,pending.nonce,T0+2000)).toMatchObject({ok:false})
    expect(await startConnectionEcho(env,context,T0+2001)).toMatchObject({ok:false})
  })
  it.each(['credentialId','harnessId','attachmentId'] as const)('does not transfer a pending or returned echo to another %s',async key=>{
    const pending=await challenge()
    expect(await finishConnectionEcho(env,{...context,[key]:'other'},pending.nonce,T0+2000)).toMatchObject({ok:false})
    await finishConnectionEcho(env,context,pending.nonce,T0+2000)
    expect(await loadConnectionEcho(env,{agentId:'agent-1',[key]:'other'},T0+3000)).toMatchObject({state:'not_returned'})
  })
  it('a newly issued token invalidates the pending challenge and retained return',async()=>{
    const pending=await returnEcho()
    await env.DB.prepare("INSERT INTO member_tokens(id,member_id,token_hash,label,channel,agent_id,tenant) VALUES('new-token','member-1',?1,'new','workspace','agent-1',?2)").bind('b'.repeat(64),TENANT).run()
    expect(await loadConnectionEcho(env,context,T0+3000)).toMatchObject({state:'not_returned',reason:'echo_binding_changed'})
    expect(await finishConnectionEcho(env,context,pending.nonce,T0+3000)).toMatchObject({ok:false})
    db.sqlite.exec("UPDATE member_tokens SET revoked_at='2026-11-17T12:00:03Z' WHERE id='new-token'")
    expect(await loadConnectionEcho(env,context,T0+4000)).toMatchObject({state:'not_returned'})
  })
  it('runtime changes away and back cannot resurrect a returned echo; unchanged reports preserve it',async()=>{
    await returnEcho();const {selfReportAtBoot}=await import('../src/fleet/boot-self-report')
    await selfReportAtBoot(env,'agent-1',{runtime:'codex'},'agent_bound')
    expect(await loadConnectionEcho(env,context,T0+2500)).toMatchObject({state:'echo_roundtrip'})
    await selfReportAtBoot(env,'agent-1',{runtime:'claude-code'},'agent_bound');await selfReportAtBoot(env,'agent-1',{runtime:'codex'},'agent_bound')
    expect(await loadConnectionEcho(env,context,T0+3000)).toMatchObject({state:'not_returned',reason:'echo_binding_changed'})
  })
  it('a retained echo becomes stale after seven days without becoming a wake claim',async()=>{
    await returnEcho();expect(await loadConnectionEcho(env,context,T0+2000+7*86400000)).toMatchObject({state:'stale',path:'inbox_echo'})
  })
  it.each(['connection_echo_challenge','connection_echo_ready','connection_echo_returned'])('fails closed when %s cannot persist',async action=>{
    if(action==='connection_echo_returned') {
      const pending=await challenge();db.sqlite.exec("CREATE TRIGGER no_return BEFORE INSERT ON agent_audit WHEN NEW.action='connection_echo_returned' BEGIN SELECT RAISE(ABORT,'unavailable'); END;")
      expect(await finishConnectionEcho(env,context,pending.nonce,T0+2000)).toMatchObject({ok:false,error:'echo_record_failed'})
    } else {
      db.sqlite.exec(`CREATE TRIGGER no_challenge BEFORE INSERT ON agent_audit WHEN NEW.action='${action}' BEGIN SELECT RAISE(ABORT,'unavailable'); END;`)
      expect(await startConnectionEcho(env,context,T0)).toMatchObject({ok:false,error:'echo_challenge_audit_failed'})
      expect(await finishConnectionEcho(env,context,'any',T0+2000)).toMatchObject({ok:false})
    }
  })
  it.each(['revoked','token-issued','runtime','runtime-epoch'] as const)('rechecks %s atomically at return-record insertion',async mode=>{
    const pending=await challenge();let interleaved=false
    const raced=beforeNextWrite(()=>{
      if(mode==='revoked')db.sqlite.exec("UPDATE member_tokens SET revoked_at='2026-11-17T12:00:01Z'")
      if(mode==='token-issued')db.sqlite.exec(`INSERT INTO member_tokens(id,member_id,token_hash,label,channel,agent_id,tenant) VALUES('raced','member-1','${'c'.repeat(64)}','race','workspace','agent-1','${TENANT}')`)
      if(mode==='runtime')db.sqlite.exec("UPDATE fleet_agents SET runtime='claude-code' WHERE agent_id='agent-1'")
      if(mode==='runtime-epoch')db.sqlite.exec("INSERT INTO agent_audit(id,agent_id,actor_id,actor_type,action,fields_changed,before_state,after_state) VALUES('raced-epoch','agent-1','member-1','system','fleet_runtime_transition','[]','{}','{}')")
      interleaved=true
    })
    expect(await finishConnectionEcho(raced,context,pending.nonce,T0+2000)).toMatchObject({ok:false,error:'echo_record_failed'});expect(interleaved).toBe(true)
  })
  it('public status hides internal context and reports unavailable history honestly',async()=>{
    const pending=await returnEcho();const status=await loadConnectionEcho(env,context,T0+3000)
    expect(JSON.stringify(status)).not.toMatch(/nonce|binding_hash|token-1|harness-1/);expect(JSON.stringify(status)).not.toContain(pending.nonce)
    db.sqlite.exec('ALTER TABLE agent_audit RENAME TO unavailable_audit')
    expect(await loadConnectionEcho(env,context,T0+3000)).toMatchObject({state:'not_returned',reason:'echo_status_unavailable'})
  })
  it('agent page says echo returned and labels challenge-to-reply latency only',async()=>{
    await returnEcho();const {agentEchoStatus}=await import('../src/dashboard/agent-echo-status')
    const html=String(await agentEchoStatus(await loadConnectionEcho(env,context,T0+3000)))
    expect(html).toContain('Echo returned');expect(html).toContain('2000 ms');expect(html).not.toMatch(/Wake proven|native_wake|delivery to reply/)
  })
  it.each(['token','runtime'])('a pending challenge is invalidated by a %s change before reply',async mode=>{
    const pending=await challenge()
    if(mode==='token')await env.DB.prepare("INSERT INTO member_tokens(id,member_id,token_hash,label,channel,agent_id,tenant) VALUES('pending-token','member-1',?1,'new','workspace','agent-1',?2)").bind('d'.repeat(64),TENANT).run()
    else {const {selfReportAtBoot}=await import('../src/fleet/boot-self-report');await selfReportAtBoot(env,'agent-1',{runtime:'claude-code'},'agent_bound')}
    expect(await finishConnectionEcho(env,context,pending.nonce,T0+2000)).toMatchObject({ok:false,error:'echo_challenge_not_found'})
  })

})
