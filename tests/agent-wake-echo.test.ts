import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { finishWakeEcho, loadWakeProof, startWakeEcho } from '../src/members/wake-echo'

const TENANT = 'tenant-wake'
const T0 = Date.parse('2026-11-17T12:00:00.000Z')
const context = { agentId: 'agent-1', credentialId: 'token-1', memberId: 'member-1', harnessId: 'harness-1' }
let db: SqliteD1Harness
let env: Env

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

async function challenge(): Promise<{ message_id: string; nonce: string }> {
  const result = await startWakeEcho(env, context, T0)
  expect(result).toMatchObject({ ok: true, state: 'pending' })
  if (!result.ok) throw new Error(result.error)
  const body = await env.DB.prepare(`SELECT body FROM agent_messages WHERE id = ?1`).bind(result.message_id).first<string>('body')
  const nonce = body?.match(/: ([0-9a-f-]{36})$/)?.[1]
  if (!nonce) throw new Error('missing challenge nonce')
  expect(JSON.stringify(result)).not.toContain(nonce)
  return { ...result, nonce }
}

async function receipt(messageId: string, atMs: number, overrides: Partial<{ tenant: string; agentId: string; messageId: string; outcome: string; status: number; tag: string; signedAt:string; tokenId:string }> = {}): Promise<void> {
  const tag = overrides.tag ?? '1'
  const subscriptionId = `sub-${tag}`
  await env.DB.prepare(`INSERT INTO event_subscriptions (id, tenant, agent_id, member_id, token_id, event_name, callback_url, secret_ciphertext, secret_fingerprint, status, refresh_before, created_at, last_refreshed_at)
    VALUES (?1, ?2, ?3, 'member-1', ?4, 'message.created', 'https://wake.example', 'x', '12345678', 'active', '2027-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  ).bind(subscriptionId, overrides.tenant ?? TENANT, overrides.agentId ?? 'agent-1',overrides.tokenId ?? 'token-1').run()
  const { eventIdFor } = await import('../src/bus/events-delivery')
  await env.DB.prepare(`INSERT INTO event_delivery_receipts (id, subscription_id, event_id, attempt, outcome, http_status, created_at,signed_at) VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6,?7)`)
    .bind(`receipt-${tag}`, subscriptionId, await eventIdFor(subscriptionId, overrides.messageId ?? messageId), overrides.outcome ?? 'delivered', overrides.status ?? 204, new Date(atMs).toISOString(),overrides.signedAt ?? null).run()
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

describe('wake echo proof', () => {
  beforeEach(() => {
    db = createSqliteD1()
    applyAllMigrations(db.sqlite)
    env = { DB: db.db, TENANT_SLUG: TENANT } as Env
    seed()
  })
  afterEach(() => db.close())

  it('proves only a matching post-challenge native delivery followed by nonce reply', async () => {
    const pending = await challenge()
    await receipt(pending.message_id, T0 + 1_000)
    const result = await finishWakeEcho(env, context, pending.nonce, T0 + 2_000)
    expect(result).toMatchObject({ ok: true, state: 'wake_proven', path: 'native_wake' })
  })

  it('records a nonce reply with no exact delivery receipt as echo roundtrip, never proof', async () => {
    const pending = await challenge()
    const result = await finishWakeEcho(env, context, pending.nonce, T0 + 1_000)
    expect(result).toMatchObject({ ok: true, state: 'echo_roundtrip', path: 'none', reason: 'no_matching_delivery_receipt' })
    expect(await loadWakeProof(env, { agentId: 'agent-1' }, T0 + 1_001)).toMatchObject({ state: 'unproven' })
  })

  it('downgrades a matching receipt when this agent read the inbox before delivery', async () => {
    const pending = await challenge()
    await env.DB.prepare(`INSERT INTO agent_audit (id, agent_id, actor_id, actor_type, action, fields_changed, before_state, after_state)
      VALUES ('poll-1', 'agent-1', 'agent-1', 'agent', 'connection_wake_inbox_read', '[]', '{}', ?1)`)
      .bind(JSON.stringify({ observed_at: new Date(T0 + 500).toISOString(), reader: 'bearer', peek: true })).run()
    await receipt(pending.message_id, T0 + 1_000)
    expect(await finishWakeEcho(env, context, pending.nonce, T0 + 2_000)).toMatchObject({ ok: true, state: 'echo_roundtrip', reason: 'inbox_read_before_delivery' })
  })

  it('ignores receipt rows for another message, tenant, agent, failed outcome, or non-2xx response', async () => {
    const pending = await challenge()
    await receipt('other-message', T0 + 100, { tag: 'message' })
    await receipt(pending.message_id, T0 + 200, { tag: 'tenant', tenant: 'other-tenant' })
    await receipt(pending.message_id, T0 + 300, { tag: 'agent', agentId: 'other-agent' })
    await receipt(pending.message_id, T0 + 400, { tag: 'failed', outcome: 'failed' })
    await receipt(pending.message_id, T0 + 500, { tag: 'status', status: 500 })
    expect(await finishWakeEcho(env, context, pending.nonce, T0 + 1_000)).toMatchObject({ ok: true, state: 'echo_roundtrip' })
  })

  it('allows an own inbox read after delivery and rejects replay and exact expiry', async () => {
    const pending = await challenge()
    await receipt(pending.message_id, T0 + 1_000)
    await env.DB.prepare(`INSERT INTO agent_audit (id, agent_id, actor_id, actor_type, action, fields_changed, before_state, after_state)
      VALUES ('poll-after', 'agent-1', 'agent-1', 'agent', 'connection_wake_inbox_read', '[]', '{}', ?1)`)
      .bind(JSON.stringify({ observed_at: new Date(T0 + 1_500).toISOString(), reader: 'bearer', peek: false })).run()
    expect(await finishWakeEcho(env, context, pending.nonce, T0 + 2_000)).toMatchObject({ ok: true, state: 'wake_proven' })
    expect(await finishWakeEcho(env, context, pending.nonce, T0 + 2_001)).toMatchObject({ ok: false, error: 'wake_challenge_replayed' })
    const second = await startWakeEcho(env, context, T0 + 2_002)
    expect(second).toMatchObject({ ok: true })
    if (!second.ok) throw new Error(second.error)
    const nonce = (await env.DB.prepare(`SELECT body FROM agent_messages WHERE id=?1`).bind(second.message_id).first<string>('body'))?.match(/: ([0-9a-f-]{36})$/)?.[1] ?? ''
    expect(await finishWakeEcho(env, context, nonce, T0 + 2_002 + 600_000)).toMatchObject({ ok: false, error: 'wake_challenge_expired' })
  })

  it('refuses a changed credential, harness, token set, or runtime and makes seven-day proof stale', async () => {
    const pending = await challenge()
    await receipt(pending.message_id, T0 + 1_000)
    expect(await finishWakeEcho(env, { ...context, harnessId: 'other' }, pending.nonce, T0 + 2_000)).toMatchObject({ ok: false })
    expect(await finishWakeEcho(env, context, pending.nonce, T0 + 2_000)).toMatchObject({ ok: true, state: 'wake_proven' })
    expect(await loadWakeProof(env, { agentId: 'agent-1' }, T0 + 8 * 24 * 60 * 60_000)).toMatchObject({ state: 'stale' })
    await env.DB.prepare(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant) VALUES ('token-2','member-1',?1,'other','workspace',?2,'agent-1',?3)`)
      .bind('b'.repeat(64), new Date(T0).toISOString(), TENANT).run()
    expect(await loadWakeProof(env, { agentId: 'agent-1' }, T0 + 3_000)).toMatchObject({ state: 'unproven', reason: 'wake_binding_changed' })
    await env.DB.prepare(`DELETE FROM member_tokens WHERE id='token-2'`).run()
    await env.DB.prepare(`UPDATE fleet_agents SET runtime='claude' WHERE tenant=?1 AND agent_id=?2`).bind(TENANT, 'agent-1').run()
    expect(await loadWakeProof(env, { agentId: 'agent-1' }, T0 + 3_001)).toMatchObject({ state: 'unproven', reason: 'wake_binding_changed' })
  })

  it('never exposes a nonce or hash in pending, audit, or public proof output', async () => {
    const pending = await challenge()
    const publicPending = await startWakeEcho(env, context, T0 + 1)
    expect(JSON.stringify(publicPending)).not.toContain(pending.nonce)
    const audit = await env.DB.prepare(`SELECT after_state FROM agent_audit WHERE action = 'connection_wake_challenge'`).first<{ after_state: string }>()
    expect(audit?.after_state).not.toContain(pending.nonce)
    expect(JSON.stringify(await loadWakeProof(env, { agentId: 'agent-1' }, T0))).not.toMatch(/nonce|hash|token-1/i)
  })
  it('polls during message publication are witnessed before a later delivery',async()=>{
    const {readAgentInbox}=await import('../src/agents/messages')
    const early={...env,BUS:{async send(){await readAgentInbox(env,{agent:'agent-1',peek:true},{now:()=>new Date(T0+100).toISOString()})}}} as unknown as Env
    const start=await startWakeEcho(early,context,T0);expect(start).toMatchObject({ok:true})
    if(!start.ok)throw new Error(start.error)
    const body=await env.DB.prepare('SELECT body FROM agent_messages WHERE id=?1').bind(start.message_id).first<string>('body')
    const nonce=body?.match(/: ([0-9a-f-]{36})$/)?.[1]??''
    await receipt(start.message_id,T0+1000)
    expect(await finishWakeEcho(env,context,nonce,T0+2000)).toMatchObject({ok:true,state:'echo_roundtrip',reason:'inbox_read_before_delivery'})
  })
  it('a read at T0 after challenge creation prevents proof',async()=>{
    const pending=await challenge();const {recordWakeInboxRead}=await import('../src/agents/wake-echo-observer')
    await recordWakeInboxRead(env,'agent-1','bearer',true,new Date(T0).toISOString());await receipt(pending.message_id,T0+1000)
    expect(await finishWakeEcho(env,context,pending.nonce,T0+2000)).toMatchObject({state:'echo_roundtrip'})
  })
  it('a delivery at the reply timestamp does not establish that reply followed delivery',async()=>{
    const pending=await challenge();await receipt(pending.message_id,T0+1000)
    expect(await finishWakeEcho(env,context,pending.nonce,T0+1000)).toMatchObject({state:'echo_roundtrip'})
  })
  it('a proof becomes stale at exactly seven days',async()=>{
    const pending=await challenge();await receipt(pending.message_id,T0+1000);await finishWakeEcho(env,context,pending.nonce,T0+2000)
    expect(await loadWakeProof(env,{agentId:'agent-1'},T0+2000+7*86400000)).toMatchObject({state:'stale'})
  })
  it('an expired credential is not a valid echo context',async()=>{
    const pending=await challenge();await receipt(pending.message_id,T0+1000)
    await env.DB.prepare('UPDATE member_tokens SET expires_at=?1 WHERE id=?2').bind(new Date(T0+1500).toISOString(),'token-1').run()
    expect(await finishWakeEcho(env,context,pending.nonce,T0+2000)).toMatchObject({ok:false})
  })
  it('audit failure cannot return wake proven',async()=>{
    const pending=await challenge();await receipt(pending.message_id,T0+1000)
    db.sqlite.exec("CREATE TRIGGER test_no_proof BEFORE INSERT ON agent_audit WHEN NEW.action='connection_wake_proof' BEGIN SELECT RAISE(ABORT,'proof unavailable'); END;")
    expect(await finishWakeEcho(env,context,pending.nonce,T0+2000)).toMatchObject({ok:false,error:'wake_proof_audit_failed'})
  })
  it('two concurrent replies can write at most one successful proof',async()=>{
    const pending=await challenge();await receipt(pending.message_id,T0+1000)
    const results=await Promise.all([finishWakeEcho(env,context,pending.nonce,T0+2000),finishWakeEcho(env,context,pending.nonce,T0+2000)])
    expect(results.filter(r=>r.ok)).toHaveLength(1)
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM agent_audit WHERE action='connection_wake_proof'").first<number>('n')).toBe(1)
  })
  it('a later roundtrip does not delete a still-valid earlier proof',async()=>{
    const pending=await challenge();await receipt(pending.message_id,T0+1000);await finishWakeEcho(env,context,pending.nonce,T0+2000)
    const next=await startWakeEcho(env,context,T0+3000);if(!next.ok)throw new Error(next.error)
    const body=await env.DB.prepare('SELECT body FROM agent_messages WHERE id=?1').bind(next.message_id).first<string>('body');const nonce=body?.match(/: ([0-9a-f-]{36})$/)?.[1]??''
    expect(await finishWakeEcho(env,context,nonce,T0+4000)).toMatchObject({state:'echo_roundtrip'})
    expect(await loadWakeProof(env,{agentId:'agent-1'},T0+5000)).toMatchObject({state:'proven',wake_proven_at:new Date(T0+2000).toISOString()})
  })
  it.each([false,true])('matching signed=%s doorbell receipts prove the ordered echo',async signed=>{
    const pending=await challenge()
    await env.DB.prepare("INSERT INTO agent_webhook_doorbell_receipts(id,tenant,agent_id,event_type,ref_id,outcome,http_status,attempted_at,signed_at) VALUES(?,?,?,?,?,?,?,?,?)").bind('doorbell',TENANT,'agent-1','mupot.inbox.wake',pending.message_id,'posted',204,new Date(T0+1000).toISOString(),signed?new Date(T0+900).toISOString():null).run()
    expect(await finishWakeEcho(env,context,pending.nonce,T0+2000)).toMatchObject({state:'echo_roundtrip',path:'webhook_doorbell',reason:'delivery_timestamp_unavailable',delivery_to_reply_ms:null,t0_to_delivery_ms:null})
  })

  it.each(['bearer-peek','bearer-consume','signed','lease','lease_attempt'] as const)('observes %s reads before delivery',async mode=>{
    const pending=await challenge()
    const {readAgentInbox,readVerifiedSignedAgentInbox,leaseAgentInbox}=await import('../src/agents/messages')
    const clock={now:()=>new Date(T0+100).toISOString()}
    if(mode==='signed') {
      await env.DB.prepare("INSERT INTO agent_inbox_fences(tenant,agent_id,mode,key_fingerprint,updated_by_member_id,updated_at,reason) VALUES(?,?,?,?,?,'2026-11-17T12:00:00Z','test')").bind(TENANT,'agent-1','signed_only','f'.repeat(64),'member-1').run()
      await readVerifiedSignedAgentInbox(env,{agent:'agent-1',peek:true,keyFingerprint:'f'.repeat(64)},clock)
    } else if(mode==='lease' || mode==='lease_attempt') await leaseAgentInbox(env,{agent:'agent-1',limit:1,...(mode==='lease_attempt'?{attemptId:'attempt_observed_0001'}:{})},clock)
    else await readAgentInbox(env,{agent:'agent-1',peek:mode==='bearer-peek'},clock)
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM agent_audit WHERE action='connection_wake_inbox_read'").first<number>('n')).toBe(1)
    await receipt(pending.message_id,T0+1000)
    expect(await finishWakeEcho(env,context,pending.nonce,T0+2000)).toMatchObject({state:'echo_roundtrip',reason:'inbox_read_before_delivery'})
  })
  it.each(['bearer','signed','lease','lease_attempt'] as const)('fails %s before exposing or consuming the nonce when observation cannot persist',async mode=>{
    const pending=await challenge()
    const {readAgentInbox,readVerifiedSignedAgentInbox,leaseAgentInbox}=await import('../src/agents/messages')
    if(mode==='signed') await env.DB.prepare("INSERT INTO agent_inbox_fences(tenant,agent_id,mode,key_fingerprint,updated_by_member_id,updated_at,reason) VALUES(?,?,?,?,?,'2026-11-17T12:00:00Z','test')").bind(TENANT,'agent-1','signed_only','f'.repeat(64),'member-1').run()
    db.sqlite.exec("CREATE TRIGGER test_no_poll BEFORE INSERT ON agent_audit WHEN NEW.action='connection_wake_inbox_read' BEGIN SELECT RAISE(ABORT,'observation unavailable'); END;")
    const clock={now:()=>new Date(T0+100).toISOString()}
    const result=mode==='signed' ? await readVerifiedSignedAgentInbox(env,{agent:'agent-1',peek:false,keyFingerprint:'f'.repeat(64)},clock)
      : mode==='bearer' ? await readAgentInbox(env,{agent:'agent-1',peek:false},clock)
      : await leaseAgentInbox(env,{agent:'agent-1',limit:1,...(mode==='lease_attempt'?{attemptId:'attempt_unavailable_01'}:{})},clock)
    expect(result).toMatchObject({ok:false,reason:'db_error'})
    const row=await env.DB.prepare('SELECT read_at,lease_expires_at FROM agent_messages WHERE id=?1').bind(pending.message_id).first<{read_at:string|null;lease_expires_at:string|null}>()
    expect(row).toMatchObject({read_at:null,lease_expires_at:null})
    expect(JSON.stringify(result)).not.toContain(pending.nonce)
  })
  it('renders recorded proof and stale history without exposing internal context',async()=>{
    const {agentWakeProof}=await import('../src/dashboard/agent-wake-proof')
    const pending=await challenge();await receipt(pending.message_id,T0+1000);await finishWakeEcho(env,context,pending.nonce,T0+2000)
    const html=String(await agentWakeProof(await loadWakeProof(env,{agentId:'agent-1'},T0+3000),T0+3000))
    expect(html).toContain('Wake proven');expect(html).toContain('Native wake');expect(html).toContain('delivery to reply 1000 ms')
    expect(html).not.toMatch(/token-1|harness-1|nonce_hash/)
    const stale=String(await agentWakeProof(await loadWakeProof(env,{agentId:'agent-1'},T0+2000+7*86400000),T0+2000+7*86400000))
    expect(stale).toContain('7d ago, re-prove')
  })

  it('does not resurrect proof after runtime changes away and back through boot reporting',async()=>{
    const pending=await challenge();await receipt(pending.message_id,T0+1000);await finishWakeEcho(env,context,pending.nonce,T0+2000)
    const {selfReportAtBoot}=await import('../src/fleet/boot-self-report')
    await selfReportAtBoot(env,'agent-1',{runtime:'claude'},'agent_bound')
    await selfReportAtBoot(env,'agent-1',{runtime:'codex'},'agent_bound')
    expect(await loadWakeProof(env,{agentId:'agent-1'},T0+3000)).toMatchObject({state:'unproven',reason:'wake_binding_changed'})
  })
  it('reports unavailable proof storage explicitly',async()=>{
    db.sqlite.exec('ALTER TABLE agent_audit RENAME TO unavailable_audit')
    expect(await loadWakeProof(env,{agentId:'agent-1'},T0)).toMatchObject({state:'unproven',reason:'wake_proof_unavailable'})
  })

  it.each(['revoked','expired','suspended','archived','inactive'] as const)('refuses a %s credential context',async mode=>{
    const pending=await challenge();await receipt(pending.message_id,T0+1000)
    if(mode==='revoked') db.sqlite.exec("UPDATE member_tokens SET revoked_at='2026-11-17T12:00:01Z'")
    if(mode==='expired') db.sqlite.exec("UPDATE member_tokens SET expires_at='2026-11-17T12:00:01Z'")
    if(mode==='suspended') db.sqlite.exec("UPDATE members SET status='suspended' WHERE id='member-1'")
    if(mode==='archived') db.sqlite.exec("UPDATE agents SET archived_at='2026-11-17T12:00:01Z' WHERE id='agent-1'")
    if(mode==='inactive') db.sqlite.exec("UPDATE agents SET status='inactive' WHERE id='agent-1'")
    expect(await finishWakeEcho(env,context,pending.nonce,T0+2000)).toMatchObject({ok:false})
    expect(await startWakeEcho(env,context,T0+2001)).toMatchObject({ok:false})
  })
  it('rejects wrong nonce without consuming the challenge',async()=>{
    const pending=await challenge();await receipt(pending.message_id,T0+1000)
    expect(await finishWakeEcho(env,context,'wrong-nonce',T0+2000)).toMatchObject({ok:false,error:'wake_nonce_invalid'})
    expect(await finishWakeEcho(env,context,pending.nonce,T0+2001)).toMatchObject({state:'wake_proven'})
  })
  it.each(['connection_wake_challenge','connection_wake_ready'])('requires durable %s before a reply can prove anything',async action=>{
    db.sqlite.exec(`CREATE TRIGGER test_no_challenge BEFORE INSERT ON agent_audit WHEN NEW.action='${action}' BEGIN SELECT RAISE(ABORT,'challenge unavailable'); END;`)
    expect(await startWakeEcho(env,context,T0)).toMatchObject({ok:false,error:'wake_challenge_audit_failed'})
    expect(await finishWakeEcho(env,context,'any',T0+2000)).toMatchObject({ok:false})
    if(action==='connection_wake_challenge') expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM agent_messages').first<number>('n')).toBe(0)
  })
  it.each(['credentialId','harnessId','attachmentId'] as const)('does not transfer a proof to another %s',async key=>{
    const pending=await challenge();await receipt(pending.message_id,T0+1000);await finishWakeEcho(env,context,pending.nonce,T0+2000)
    expect(await loadWakeProof(env,{agentId:'agent-1',[key]:'other'},T0+3000)).toMatchObject({state:'unproven'})
  })
  it('an unchanged runtime boot preserves proof, while daemon transitions cannot resurrect it',async()=>{
    const pending=await challenge();await receipt(pending.message_id,T0+1000);await finishWakeEcho(env,context,pending.nonce,T0+2000)
    const {selfReportAtBoot}=await import('../src/fleet/boot-self-report')
    await selfReportAtBoot(env,'agent-1',{runtime:'codex'},'agent_bound')
    expect(await loadWakeProof(env,{agentId:'agent-1'},T0+2500)).toMatchObject({state:'proven'})
    const {reportFleetAgents}=await import('../src/fleet/registry')
    const report=(runtime:string)=>reportFleetAgents(env,'reporter',[{agent_id:'agent-1',display:'Agent',runtime,squads:['squad'],lifecycle:'on_demand',status:'running'}])
    expect(await report('claude-code')).toMatchObject({ok:true});expect(await report('codex')).toMatchObject({ok:true})
    expect(await loadWakeProof(env,{agentId:'agent-1'},T0+3000)).toMatchObject({state:'unproven',reason:'wake_binding_changed'})
  })

  it.each(['revoked','token-issued','runtime','runtime-epoch','poll'] as const)('rechecks %s atomically at the proof write',async mode=>{
    const pending=await challenge();await receipt(pending.message_id,T0+1000)
    let interleaved=false
    const raced=beforeNextWrite(()=>{
      if(mode==='revoked') db.sqlite.exec("UPDATE member_tokens SET revoked_at='2026-11-17T12:00:01Z'")
      if(mode==='token-issued') db.sqlite.exec(`INSERT INTO member_tokens(id,member_id,token_hash,label,channel,tenant,agent_id) VALUES('race-token','member-1','${'c'.repeat(64)}','new','workspace','${TENANT}','agent-1')`)
      if(mode==='runtime') db.sqlite.exec("UPDATE fleet_agents SET runtime='claude' WHERE agent_id='agent-1'")
      if(mode==='runtime-epoch') db.sqlite.exec("INSERT INTO agent_audit(id,agent_id,actor_id,actor_type,action,fields_changed,before_state,after_state) VALUES('transition-race','agent-1','member-1','system','fleet_runtime_transition','[]','{}','{}')")
      if(mode==='poll') db.sqlite.exec(`INSERT INTO agent_audit(id,agent_id,actor_id,actor_type,action,fields_changed,before_state,after_state) VALUES('poll-race','agent-1','member-1','system','connection_wake_inbox_read','[]','{}','{"observed_at":"2026-11-17T12:00:00.100Z"}')`)
      interleaved=true
    })
    expect(await finishWakeEcho(raced,context,pending.nonce,T0+2000)).toMatchObject({ok:false,error:'wake_proof_audit_failed'})
    expect(interleaved).toBe(true)
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM agent_audit WHERE action='connection_wake_proof'").first<number>('n')).toBe(0)
  })

  it.each(['at_t0','after_reply','signed_before','signed_after','signed_invalid'] as const)('rejects receipt chronology %s',async mode=>{
    const pending=await challenge()
    await receipt(pending.message_id,mode==='at_t0'?T0:mode==='after_reply'?T0+3000:T0+1000,mode.startsWith('signed')?{signedAt:mode==='signed_before'?new Date(T0-1).toISOString():mode==='signed_after'?new Date(T0+3000).toISOString():'not-a-date'}:{})
    expect(await finishWakeEcho(env,context,pending.nonce,T0+2000)).toMatchObject({state:'echo_roundtrip'})
  })
  it.each(['tenant','agent','message','failed','status','signed_before','signed_after','signed_invalid'] as const)('refuses a doorbell receipt with %s mismatch',async mode=>{
    const pending=await challenge()
    await env.DB.prepare("INSERT INTO agent_webhook_doorbell_receipts(id,tenant,agent_id,event_type,ref_id,outcome,http_status,attempted_at,signed_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .bind('doorbell-bad',mode==='tenant'?'other':TENANT,mode==='agent'?'other':'agent-1','mupot.inbox.wake',mode==='message'?'other-message':pending.message_id,mode==='failed'?'failed':'posted',mode==='status'?500:204,new Date(T0+1000).toISOString(),mode==='signed_before'?new Date(T0-1).toISOString():mode==='signed_after'?new Date(T0+3000).toISOString():mode==='signed_invalid'?'invalid':null).run()
    expect(await finishWakeEcho(env,context,pending.nonce,T0+2000)).toMatchObject({state:'echo_roundtrip',path:'none'})
  })
  it('does not substitute an earlier doorbell attempt for native delivery completion',async()=>{
    const pending=await challenge();await receipt(pending.message_id,T0+1500)
    await env.DB.prepare("INSERT INTO agent_webhook_doorbell_receipts(id,tenant,agent_id,event_type,ref_id,outcome,http_status,attempted_at) VALUES(?,?,?,?,?,?,?,?)").bind('earlier-doorbell',TENANT,'agent-1','mupot.inbox.wake',pending.message_id,'posted',204,new Date(T0+500).toISOString()).run()
    const {recordWakeInboxRead}=await import('../src/agents/wake-echo-observer')
    await recordWakeInboxRead(env,'agent-1','bearer',true,new Date(T0+1000).toISOString())
    expect(await finishWakeEcho(env,context,pending.nonce,T0+2000)).toMatchObject({state:'echo_roundtrip',path:'native_wake',reason:'inbox_read_before_delivery'})
  })

  it('does not use another connection token native subscription to prove this connection',async()=>{
    await env.DB.prepare("INSERT INTO member_tokens(id,member_id,token_hash,label,channel,tenant,agent_id) VALUES('sibling','member-1',?1,'other','workspace',?2,'agent-1')").bind('d'.repeat(64),TENANT).run()
    const pending=await challenge();await receipt(pending.message_id,T0+1000,{tokenId:'sibling'})
    expect(await finishWakeEcho(env,context,pending.nonce,T0+2000)).toMatchObject({state:'echo_roundtrip'})
  })

  it.each(['token','runtime'])('refuses a %s transition since the challenge even before reply validation',async mode=>{
    const pending=await challenge();await receipt(pending.message_id,T0+1000)
    if(mode==='token') db.sqlite.exec(`INSERT INTO member_tokens(id,member_id,token_hash,label,channel,tenant,agent_id) VALUES('new-token','member-1','${'e'.repeat(64)}','new','workspace','${TENANT}','agent-1')`)
    else {const {selfReportAtBoot}=await import('../src/fleet/boot-self-report');await selfReportAtBoot(env,'agent-1',{runtime:'claude-code'},'agent_bound')}
    expect(await finishWakeEcho(env,context,pending.nonce,T0+2000)).toMatchObject({ok:false,error:'wake_challenge_not_found'})
  })

  it('rolls back a runtime update when its transition witness cannot persist',async()=>{
    const pending=await challenge();await receipt(pending.message_id,T0+1000);await finishWakeEcho(env,context,pending.nonce,T0+2000)
    db.sqlite.exec("CREATE TRIGGER test_runtime_audit BEFORE INSERT ON agent_audit WHEN NEW.action='fleet_runtime_transition' BEGIN SELECT RAISE(ABORT,'transition unavailable'); END;")
    const {selfReportAtBoot}=await import('../src/fleet/boot-self-report')
    await expect(selfReportAtBoot(env,'agent-1',{runtime:'claude-code'},'agent_bound')).rejects.toThrow('transition unavailable')
    expect(await env.DB.prepare("SELECT runtime FROM fleet_agents WHERE agent_id='agent-1'").first<string>('runtime')).toBe('codex')
    expect(await loadWakeProof(env,{agentId:'agent-1'},T0+3000)).toMatchObject({state:'proven'})
  })
  it('bearer fleet attach records runtime transitions that cannot resurrect proof',async()=>{
    const {sha256Hex}=await import('../src/members/service')
    const raw='mupot_private_test_wake_token'
    await env.DB.prepare("UPDATE member_tokens SET token_hash=?1 WHERE id='token-1'").bind(await sha256Hex(raw)).run()
    await env.DB.prepare("INSERT INTO capabilities(id,member_id,scope_type,scope_id,capability) VALUES('own-cap','member-1','squad','squad-1','member')").run()
    const pending=await challenge();await receipt(pending.message_id,T0+1000);await finishWakeEcho(env,context,pending.nonce,T0+2000)
    const {fleetAttachApp}=await import('../src/fleet/attach-routes')
    for(const runtime of ['claude-code','codex']) {
      const response=await fleetAttachApp.request('https://pot.test/attach',{method:'POST',headers:{authorization:`Bearer ${raw}`,'content-type':'application/json'},body:JSON.stringify({agent_id:'agent-1',type:'builder',runtime})},env)
      expect(response.status).toBe(200)
    }
    expect(await loadWakeProof(env,{agentId:'agent-1'},T0+3000)).toMatchObject({state:'unproven',reason:'wake_binding_changed'})
  })

  it('accepts the native signature second bucket when delivery completion is strictly ordered',async()=>{
    const pending=await challenge()
    const {signedHeaders}=await import('../src/mcp/events-webhook')
    const signed=await signedHeaders(['whsec_'+btoa('test-secret-32-characters-long-123')],'event-test','sub-1','{}',T0+100)
    expect(signed.signedAtIso).toBe(new Date(T0).toISOString())
    await receipt(pending.message_id,T0+500,{signedAt:signed.signedAtIso})
    expect(await finishWakeEcho(env,context,pending.nonce,T0+800)).toMatchObject({state:'wake_proven',path:'native_wake',delivery_to_reply_ms:300})
  })

})
