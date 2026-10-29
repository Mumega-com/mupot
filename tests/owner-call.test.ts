import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext, Env } from '../src/types'
import { invokeTool, advertisedTools } from '../src/mcp/index'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const NOW = Date.parse('2026-10-29T14:00:00Z')
let h: SqliteD1Harness
let env: Env
function auth(agent = 'a', changes: Partial<AuthContext> = {}): AuthContext {
  return { userId: agent, tenant: 'test', role: 'member', memberId: `m-${agent}`, channel: 'workspace',
    boundAgentId: agent, tokenId: `t-${agent}`, capabilities: [{ member_id: `m-${agent}`, scope_type: 'squad', scope_id: 'sq', capability: 'admin' }], ...changes }
}
const args = (key = 'opaque', source = 'e1') => ({ ask_key: key, kind: 'access', action_ref: { type: 'elevation_request', id: source }, reason_code: 'access_required' })
const call = (key = 'opaque', source = 'e1', a = auth()) => invokeTool(a, env, 'owner_call', args(key, source), 'https://pot.test')
function count(table: string) { return h.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n }
function source(id: string, agent = 'a') {
  h.sqlite.prepare(`INSERT INTO elevation_requests (id,tenant,agent_session_id,agent_id,member_id,requested_actions_json,requested_scope_type,requested_scope_id,requested_duration_minutes,reason,status,created_at,decision_expires_at)
    VALUES (?,'test',?,?,?,'["action:project_lifecycle"]','squad','sq',15,'private-secret-source','pending','2026-10-29T13:59:00Z','2026-11-01T14:10:00Z')`).run(id, `s-${agent}`, agent, `m-${agent}`)
  h.sqlite.prepare(`INSERT INTO approval_bot_deliveries (id,tenant,request_id,member_id,chat_id,status,created_at) VALUES (?,'test',?,'human','private-chat','reserved','2026-10-29T13:59:00Z')`).run(`d-${id}`, id)
}
function admittedAuth(): AuthContext {
  env.SEAT_AUTO_ENROLL='1';env.SEAT_ATTACH='1'
  h.sqlite.exec(`
    INSERT INTO capabilities(id,member_id,scope_type,scope_id,capability) VALUES('human-admin','human','squad','sq','admin');
    INSERT INTO harnesses(id,tenant,member_id,oauth_client_id,credential_kind,grant_id) VALUES('hr','test','human','test-client','oauth','oauth:human-grant');
    INSERT INTO member_tokens(id,member_id,token_hash,channel,tenant) VALUES('human-grant','human','fake-human-token','directory','test');
    INSERT INTO agent_seats(id,tenant,member_id,harness_id,key_hash,agent_id,max_live,source,seat_token_id)
      VALUES('seat','test','human','hr','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','c',32,'select','t-c');
    INSERT INTO agent_seat_admissions(id,tenant,agent_id,human_member_id,harness_id,status,ceiling,requested_via,requested_seat_id,created_at,decided_at,decided_by_member_id,decided_via)
      VALUES('adm','test','a','human','hr','live','member','dashboard','seat','2026-10-29T13:00:00Z','2026-10-29T13:00:00Z','human','dashboard');
    INSERT INTO agent_seat_attachments(id,tenant,seat_id,human_member_id,harness_id,agent_id,admission_id,seat_token_id,created_at)
      VALUES('att','test','seat','human','hr','a','adm','t-a','2026-10-29T13:00:00Z');
    UPDATE member_tokens SET channel='directory' WHERE id='t-a';
    UPDATE agent_sessions SET auth_kind='oauth' WHERE id='s-a';
  `)
  return auth('a',{channel:'directory',consentedByMemberId:'human',seatBinding:{seatId:'seat',label:'label',harnessId:'hr',grantTokenId:'human-grant',humanMemberId:'human',source:'handle',attached:{attachmentId:'att',admissionId:'adm',agentId:'a',seatAgentId:'c',ceiling:'member'}}})
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW)
  h = createSqliteD1(); applyAllMigrations(h.sqlite)
  env = { DB: h.db, TENANT_SLUG: 'test', OWNER_CALL: '1', OWNER_CALL_HMAC_KEYS: JSON.stringify([{ version: 'v1', key: 'test-only-hmac-key-at-least-32-bytes' }]) } as Env
  h.sqlite.exec(`INSERT INTO departments(id,slug,name) VALUES('dept','dept','Dept');
    INSERT INTO squads(id,department_id,slug,name) VALUES('sq','dept','sq','Sq');
    INSERT INTO members(id,tenant,display_name) VALUES('human','test','Human');`)
  for (const agent of ['a', 'b', 'c', 'd', 'e', 'f']) {
    h.sqlite.prepare(`INSERT INTO agents(id,squad_id,slug,name,role,model,owner_member_id) VALUES(?,'sq',?,?,'member','test','human')`).run(agent, agent, agent)
    h.sqlite.prepare(`INSERT INTO members(id,tenant,display_name) VALUES(?,'test',?)`).run(`m-${agent}`, agent)
    h.sqlite.prepare(`INSERT INTO agent_member_bindings(tenant,agent_id,member_id,created_at) VALUES('test',?,?,'2026-10-29T13:00:00Z')`).run(agent, `m-${agent}`)
    h.sqlite.prepare(`INSERT INTO capabilities(id,member_id,scope_type,scope_id,capability) VALUES(?,?,'squad','sq','admin')`).run(`cap-${agent}`, `m-${agent}`)
    h.sqlite.prepare(`INSERT INTO member_tokens(id,member_id,token_hash,channel,tenant,agent_id) VALUES(?,?,?,'workspace','test',?)`).run(`t-${agent}`, `m-${agent}`, `fake-hash-${agent}`, agent)
    h.sqlite.prepare(`INSERT INTO agent_sessions(id,tenant,agent_id,member_id,auth_kind,credential_id,created_at,last_seen_at,idle_expires_at,absolute_expires_at)
      VALUES(?,'test',?,?,'workspace_token',?,'2026-10-29T13:59:00Z','2026-10-29T13:59:00Z','2026-11-01T15:00:00Z','2026-11-02T14:00:00Z')`).run(`s-${agent}`, agent, `m-${agent}`, `t-${agent}`)
  }
  source('e1')
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('outbound forbidden') }))
})
afterEach(() => { try { expect(count('owner_call_commit_guards')).toBe(0) } finally { h.close(); vi.unstubAllGlobals(); vi.useRealTimers() } })

describe('owner_call contract and storage', () => {
  it('flag off hides tool and writes nothing', async () => {
    delete env.OWNER_CALL
    expect(advertisedTools(env).some(t => t.name === 'owner_call')).toBe(false)
    expect(await call()).toMatchObject({ ok: false, error: 'owner_call_disabled' })
    expect(count('owner_calls')).toBe(0)
  })
  it('persists one safe projection of the canonical elevation and never sends', async () => {
    const out = await call()
    expect(out).toMatchObject({ ok: true, result: { state: 'pending', delivery_state: 'canonical_pending', next_step: 'await_canonical_elevation', retry: false } })
    expect(count('owner_calls')).toBe(1); expect(count('elevation_requests')).toBe(1)
    expect(count('owner_call_outbox')).toBe(0)
    expect(h.sqlite.prepare('SELECT canonical_delivery_id FROM owner_calls').get()).toEqual({ canonical_delivery_id: 'd-e1' })
    expect(JSON.stringify(out)).not.toMatch(/private-secret|private-chat|fake-hash|test-only-hmac|opaque/)
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each([{ boundAgentId: null }, { tokenId: null }, { memberId: undefined }])('rejects unbound identity %j', async override => {
    expect(await call('opaque', 'e1', auth('a', override))).toMatchObject({ ok: false, error: 'agent_binding_required' })
    expect(count('owner_calls')).toBe(0)
  })
  it.each(['owner', 'agent', 'route', 'url', 'parent', 'priority', 'text'])('rejects caller-selected %s without echo', async key => {
    const result = await invokeTool(auth(), env, 'owner_call', { ...args(), [key]: 'secret-injected' }, 'https://pot.test')
    expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain('secret-injected'); expect(count('owner_calls')).toBe(0)
  })
  it.each(['credential', 'money'])('keeps %s disabled with no digest or outbox', async kind => {
    expect(await invokeTool(auth(), env, 'owner_call', { ...args(), kind }, 'https://pot.test')).toMatchObject({ ok: false, error: 'owner_call_kind_disabled' })
    expect(count('owner_calls')).toBe(0); expect(count('owner_call_outbox')).toBe(0)
  })
  it.each([
    "UPDATE agents SET status='inactive' WHERE id='a'",
    "UPDATE member_tokens SET revoked_at='2026-10-29T14:00:00Z' WHERE id='t-a'",
    "UPDATE agent_sessions SET revoked_at='2026-10-29T14:00:00Z' WHERE id='s-a'",
    "UPDATE members SET status='suspended' WHERE id='m-a'",
  ])('requires live actor: %s', async sql => {
    h.sqlite.exec(sql); expect((await call()).ok).toBe(false); expect(count('owner_calls')).toBe(0)
  })
  it.each([
    "UPDATE members SET tenant='foreign' WHERE id='human'",
    "UPDATE members SET status='suspended' WHERE id='human'",
    "UPDATE members SET archived_at='now' WHERE id='human'",
    "UPDATE agents SET owner_member_id='m-b' WHERE id='a'",
    "UPDATE agents SET owner_member_id=NULL WHERE id='a'",
  ])('requires same-tenant active human owner: %s', async sql => {
    h.sqlite.exec(sql); expect(await call()).toMatchObject({ ok: false, error: 'owner_setup_required' }); expect(count('owner_calls')).toBe(0)
  })
  it('returns the same refusal for invisible and nonexistent references', async () => {
    h.sqlite.exec("UPDATE elevation_requests SET tenant='foreign' WHERE id='e1'")
    const invisible = await call(); const missing = await call('opaque', 'absent')
    expect(invisible).toMatchObject({ ok: false, error: 'owner_call_source_unavailable' }); expect(missing).toEqual(invisible)
  })
  it('intersects authenticated and live agent rights', async () => {
    expect((await call('opaque', 'e1', auth('a', { capabilities: [] }))).ok).toBe(false)
    h.sqlite.exec("DELETE FROM capabilities WHERE id='cap-a'")
    expect((await call()).ok).toBe(false); expect(count('owner_calls')).toBe(0)
  })
  it('blocks a missing or different-owner canonical dispatch', async () => {
    h.sqlite.exec("UPDATE approval_bot_deliveries SET member_id='m-b' WHERE request_id='e1'")
    expect(await call()).toMatchObject({ ok: false, error: 'owner_call_source_unavailable' }); expect(count('owner_calls')).toBe(0)
  })
  it('retains key history after terminal state and HMAC rotation', async () => {
    const first = await call()
    h.sqlite.exec("UPDATE owner_calls SET state='closed'")
    env.OWNER_CALL_HMAC_KEYS = JSON.stringify([{ version: 'v2', key: 'second-test-key-at-least-32-bytes' }, { version: 'v1', key: 'test-only-hmac-key-at-least-32-bytes' }])
    const retry = await call()
    expect(retry).toMatchObject({ ok: true, result: { ask_id: (first as any).result.ask_id, state: 'closed', retry: true } })
    expect(count('owner_call_key_aliases')).toBe(2); expect(count('owner_calls')).toBe(1)
    source('e2')
    expect(await call('opaque', 'e2')).toMatchObject({ ok: false, error: 'ask_key_conflict' })
    expect(count('owner_calls')).toBe(1)
  })
  it('changed server source version conflicts with retained key', async () => {
    await call()
    h.sqlite.exec("UPDATE elevation_requests SET requested_duration_minutes=60 WHERE id='e1'")
    expect(await call()).toMatchObject({ ok: false, error: 'ask_key_conflict' })
    expect(count('owner_calls')).toBe(1)
  })
  it('coalesces concurrent keys and authorized agents without private requester context', async () => {
    const results = await Promise.all([call('key-a'), call('key-b', 'e1', auth('b')), call('key-c')])
    expect(results.every(r => r.ok)).toBe(true)
    expect(new Set(results.map(r => (r as any).result.ask_id)).size).toBe(1)
    expect(count('owner_calls')).toBe(1); expect(count('owner_call_requesters')).toBe(2)
    expect(JSON.stringify(results)).not.toMatch(/key-a|key-b|key-c|m-a|m-b|private-secret/)
  })
  it.each([
    "UPDATE member_tokens SET revoked_at='now' WHERE id='t-a'",
    "UPDATE agents SET status='inactive' WHERE id='a'",
    "UPDATE agents SET owner_member_id='m-b' WHERE id='a'",
    "UPDATE elevation_requests SET requested_duration_minutes=60 WHERE id='e1'",
    "DELETE FROM capabilities WHERE id='cap-a'",
  ])('refuses change between read and commit: %s', async sql => {
    const batch = h.db.batch.bind(h.db)
    vi.spyOn(h.db, 'batch').mockImplementationOnce(async statements => { h.sqlite.exec(sql); return batch(statements) })
    expect((await call()).ok).toBe(false)
    expect(count('owner_calls')).toBe(0); expect(count('owner_call_key_aliases')).toBe(0)
  })
  it('atomic agent creation ceiling survives competing new keys; retries cost zero', async () => {
    for (let i = 2; i <= 7; i++) source(`e${i}`)
    const results = await Promise.all(Array.from({ length: 7 }, (_, i) => call(`k${i}`, `e${i + 1}`)))
    expect(results.filter(r => r.ok)).toHaveLength(5); expect(count('owner_calls')).toBe(5)
    expect(await call('k0')).toMatchObject({ ok: true, result: { retry: true } })
  })
  it('atomic owner creation ceiling spans agents', async () => {
    const results = []
    for (const a of ['a', 'b', 'c', 'd', 'e']) for (let i = 0; i < 5; i++) {
      const id = `${a}-${i}`; source(id, a); results.push(call(id, id, auth(a)))
    }
    expect((await Promise.all(results)).filter(r => r.ok)).toHaveLength(20)
    expect(count('owner_calls')).toBe(20)
  })
  it('joined associations count toward the 10 unresolved agent cap', async () => {
    for (let i = 0; i < 10; i++) {
      const id = `cap-${i}`; source(id, 'b')
      expect((await call(id, id, auth('b'))).ok).toBe(true)
      if (i % 5 === 4) vi.advanceTimersByTime(900_001)
    }
    for (let i = 0; i < 10; i++) expect((await call(`join-${i}`, `cap-${i}`)).ok).toBe(true)
    source('over', 'c'); expect((await call('over', 'over', auth('c'))).ok).toBe(true)
    expect(await call('join-over', 'over')).toMatchObject({ ok: false, error: 'owner_call_limit', detail: { retry_after: 900 } })
    expect(count('owner_call_requesters')).toBe(21)
  })
  it('ordinary owner queue stops at 40 and cannot use reserved human headroom', async () => {
    for (const agent of ['a','b','c','d']) for (let i=0;i<10;i++) {
      const id=`pending-${agent}-${i}`; source(id,agent)
      expect((await call(id,id,auth(agent))).ok).toBe(true)
      if(i%5===4) vi.advanceTimersByTime(900_001)
    }
    source('ordinary-over','e')
    expect(await call('ordinary-over','ordinary-over',auth('e'))).toMatchObject({ok:false,error:'owner_call_limit'})
    expect(count('owner_calls')).toBe(40)
    expect(h.sqlite.prepare('SELECT SUM(priority) n FROM owner_calls').get()).toEqual({n:0})
  })
  it('cannot discard historical HMAC keys or silently reuse a version with different material', async () => {
    await call()
    env.OWNER_CALL_HMAC_KEYS=JSON.stringify([{version:'v2',key:'another-test-key-at-least-32-bytes'}])
    expect(await call()).toMatchObject({ok:false,error:'owner_call_setup_required'})
    env.OWNER_CALL_HMAC_KEYS=JSON.stringify([{version:'v1',key:'another-test-key-at-least-32-bytes'}])
    expect(await call()).toMatchObject({ok:false,error:'owner_call_setup_required'})
    expect(count('owner_calls')).toBe(1)
  })
  it('owner revision catches replacement and restoration between read and write', async () => {
    const batch=h.db.batch.bind(h.db)
    vi.spyOn(h.db,'batch').mockImplementationOnce(async statements=>{
      h.sqlite.exec("UPDATE agents SET owner_member_id='m-b' WHERE id='a'; UPDATE agents SET owner_member_id='human' WHERE id='a'")
      return batch(statements)
    })
    expect((await call()).ok).toBe(false);expect(count('owner_calls')).toBe(0)
  })
  it('concurrent same key with different payloads rolls back the losing ask and association',async()=>{
    source('other')
    const out=await Promise.all([call('same'),call('same','other')])
    expect(out.filter(r=>r.ok)).toHaveLength(1)
    expect(out.find(r=>!r.ok)).toMatchObject({ok:false,error:'ask_key_conflict'})
    expect(count('owner_calls')).toBe(1);expect(count('owner_call_requesters')).toBe(1)
  })
  it('new key or another requester cannot reopen a terminal source',async()=>{
    const first=await call()
    h.sqlite.exec("UPDATE elevation_requests SET status='denied' WHERE id='e1'")
    expect(await call()).toMatchObject({ok:true,result:{ask_id:(first as any).result.ask_id,state:'closed',next_step:'source_terminal'}})
    expect((await call('fresh','e1',auth('b'))).ok).toBe(false)
    expect(count('owner_calls')).toBe(1)
  })

  it('a new source version explicitly closes the old projection',async()=>{
    const old=await call()
    h.sqlite.exec("UPDATE elevation_requests SET requested_duration_minutes=60 WHERE id='e1'")
    const next=await call('next-version')
    expect(next.ok).toBe(true)
    expect(h.sqlite.prepare('SELECT state FROM owner_calls WHERE id=?').get((old as any).result.ask_id)).toEqual({state:'closed'})
    expect(count('owner_calls')).toBe(2)
  })

  it('sharing an owner/squad grants no visibility to an ordinary peer',async()=>{
    h.sqlite.exec("UPDATE capabilities SET capability='member' WHERE id='cap-b'")
    expect(await call('peer','e1',auth('b',{capabilities:[{member_id:'m-b',scope_type:'squad',scope_id:'sq',capability:'member'}]}))).toMatchObject({ok:false,error:'owner_call_source_unavailable'})
    expect(count('owner_calls')).toBe(0)
  })
  it('a live admitted effective agent can file its own source projection without widening its ceiling',async()=>{
    const a=admittedAuth()
    expect(await call('admitted','e1',a)).toMatchObject({ok:true})
    source('peer-source','b')
    expect(await call('admitted-peer','peer-source',a)).toMatchObject({ok:false,error:'owner_call_source_unavailable'})
  })
  it.each([
    "UPDATE agent_seat_admissions SET status='revoked',revoked_at='2026-10-29T14:00:00Z' WHERE id='adm'",
    "UPDATE member_tokens SET revoked_at='2026-10-29T14:00:00Z' WHERE id='human-grant'",
    "UPDATE agent_seats SET retired_at='2026-10-29T14:00:00Z' WHERE id='seat'",
    "DELETE FROM capabilities WHERE id='human-admin'",
    "UPDATE members SET status='suspended' WHERE id='human'",
  ])('admitted authority is reasserted at commit: %s',async sql=>{
    const a=admittedAuth(),batch=h.db.batch.bind(h.db)
    vi.spyOn(h.db,'batch').mockImplementationOnce(async statements=>{h.sqlite.exec(sql);return batch(statements)})
    expect((await call('admitted','e1',a)).ok).toBe(false)
    expect(count('owner_calls')).toBe(0);expect(count('owner_call_key_aliases')).toBe(0)
  })

  it('database active-action uniqueness independently rejects a duplicate reservation',async()=>{
    await call()
    expect(()=>h.sqlite.exec(`INSERT INTO owner_calls(id,tenant,owner_member_id,owner_revision,created_by_agent_id,source_agent_id,kind,action_type,action_id,action_version,reason_code,canonical_delivery_id,created_at)
      SELECT 'oc-duplicate',tenant,owner_member_id,owner_revision,created_by_agent_id,source_agent_id,kind,action_type,action_id,action_version,reason_code,canonical_delivery_id,created_at FROM owner_calls LIMIT 1`)).toThrow(/UNIQUE/)
    expect(count('owner_calls')).toBe(1)
  })
  it('database key-history conflict independently refuses an altered alias payload',async()=>{
    await call()
    expect(()=>h.sqlite.exec("UPDATE owner_call_key_aliases SET payload_digest='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'")).toThrow(/ask_key_conflict/)
    expect(count('owner_call_key_aliases')).toBe(1)
  })
  it('a requester cannot remove another association or its history',async()=>{
    const first=await call();await call('joined','e1',auth('b'))
    h.sqlite.prepare("INSERT INTO owner_call_requesters(tenant,ask_id,agent_id,owner_revision,created_at) VALUES('test',?,'c',0,'2026-10-29T14:00:00Z')").run((first as any).result.ask_id)
    expect(()=>h.sqlite.exec("DELETE FROM owner_call_requesters WHERE agent_id='c'")).toThrow(/owner_call_requester_immutable/)
    expect(()=>h.sqlite.exec("DELETE FROM owner_call_key_aliases WHERE agent_id='b'")).toThrow(/owner_call_history_retained/)
    expect(count('owner_call_requesters')).toBe(3)
  })
  it.each([
    "UPDATE members SET status='suspended' WHERE id='human'",
    "UPDATE members SET tenant='foreign' WHERE id='human'",
  ])('owner human predicate is checked at commit: %s',async sql=>{
    const batch=h.db.batch.bind(h.db)
    vi.spyOn(h.db,'batch').mockImplementationOnce(async statements=>{h.sqlite.exec(sql);return batch(statements)})
    expect((await call()).ok).toBe(false);expect(count('owner_calls')).toBe(0)
  })

  it('joined retry identity tracks its own owner revision independently of the first requester',async()=>{
    await call()
    h.sqlite.exec("UPDATE agents SET owner_member_id='m-c' WHERE id='b'; UPDATE agents SET owner_member_id='human' WHERE id='b'")
    const first=await call('joined-revision','e1',auth('b'))
    expect(first.ok).toBe(true)
    expect(await call('joined-revision','e1',auth('b'))).toMatchObject({ok:true,result:{retry:true}})
  })

  it('a dead source session cannot be projected by another authorized requester',async()=>{
    source('ended-source','b')
    h.sqlite.exec("UPDATE agent_sessions SET revoked_at='2026-10-29T14:00:00Z' WHERE id='s-b'")
    expect(await call('ended','ended-source')).toMatchObject({ok:false,error:'owner_call_source_unavailable'})
    expect(count('owner_calls')).toBe(0)
  })
  it('source session revocation between pre-read and commit refuses creation',async()=>{
    source('source-race','b')
    const batch=h.db.batch.bind(h.db)
    vi.spyOn(h.db,'batch').mockImplementationOnce(async statements=>{h.sqlite.exec("UPDATE agent_sessions SET revoked_at='2026-10-29T14:00:00Z' WHERE id='s-b'");return batch(statements)})
    expect((await call('source-race','source-race')).ok).toBe(false);expect(count('owner_calls')).toBe(0)
  })

  it('an expired canonical request returns renewal-required without sending or reopening',async()=>{
    vi.useRealTimers()
    h.sqlite.exec("UPDATE elevation_requests SET decision_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 second') WHERE id='e1'")
    const first=await call()
    await new Promise(resolve=>setTimeout(resolve,1100))
    expect(await call()).toMatchObject({ok:true,result:{ask_id:(first as any).result.ask_id,state:'closed',next_step:'renew_elevation_request'}})
    expect(count('owner_calls')).toBe(1);expect(fetch).not.toHaveBeenCalled()
  })

  it('a promoted live admission retains canonical validity after its old pending deadline',async()=>{
    const a=admittedAuth()
    h.sqlite.exec("UPDATE agent_seat_admissions SET expires_at='2026-10-28T14:00:00Z' WHERE id='adm'")
    expect(await call('old-pending-deadline','e1',a)).toMatchObject({ok:true})
  })
  it('a capability expiring between read and commit is not frozen into authority',async()=>{
    vi.useRealTimers()
    h.sqlite.exec("UPDATE capabilities SET expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 second') WHERE id='cap-a'")
    const batch=h.db.batch.bind(h.db)
    vi.spyOn(h.db,'batch').mockImplementationOnce(async statements=>{await new Promise(resolve=>setTimeout(resolve,1100));return batch(statements)})
    expect((await call()).ok).toBe(false);expect(count('owner_calls')).toBe(0)
  })

  it('source owner revision ABA is fenced for an authorized cross-agent requester',async()=>{
    source('owner-aba-source','b')
    const batch=h.db.batch.bind(h.db)
    vi.spyOn(h.db,'batch').mockImplementationOnce(async statements=>{
      h.sqlite.exec("UPDATE agents SET owner_member_id='m-c' WHERE id='b'; UPDATE agents SET owner_member_id='human' WHERE id='b'")
      return batch(statements)
    })
    expect((await call('owner-aba','owner-aba-source')).ok).toBe(false);expect(count('owner_calls')).toBe(0)
  })
  it('source owner change closes the old owner projection while preserving associations',async()=>{
    source('owner-change-source','b')
    const first=await call('owner-change','owner-change-source')
    h.sqlite.exec("INSERT INTO members(id,tenant,display_name) VALUES('next-human','test','Next human'); UPDATE agents SET owner_member_id='next-human' WHERE id='b'")
    expect(h.sqlite.prepare('SELECT state FROM owner_calls WHERE id=?').get((first as any).result.ask_id)).toEqual({state:'closed'})
    expect(count('owner_call_requesters')).toBe(1);expect(count('owner_call_key_aliases')).toBe(1)
  })
  it('natural source expiry before commit creates no pending projection',async()=>{
    vi.useRealTimers()
    h.sqlite.exec("UPDATE elevation_requests SET decision_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 second') WHERE id='e1'")
    const batch=h.db.batch.bind(h.db)
    vi.spyOn(h.db,'batch').mockImplementationOnce(async statements=>{await new Promise(resolve=>setTimeout(resolve,1100));return batch(statements)})
    expect((await call()).ok).toBe(false);expect(count('owner_calls')).toBe(0)
  })
  it('source credential revocation before commit removes canonical source visibility',async()=>{
    source('source-token-race','b')
    const batch=h.db.batch.bind(h.db)
    vi.spyOn(h.db,'batch').mockImplementationOnce(async statements=>{h.sqlite.exec("UPDATE member_tokens SET revoked_at='2026-10-29T14:00:00Z' WHERE id='t-b'");return batch(statements)})
    expect((await call('source-token-race','source-token-race')).ok).toBe(false);expect(count('owner_calls')).toBe(0)
  })

  it('source welded member suspension before commit removes canonical source visibility',async()=>{
    source('source-member-race','b')
    const batch=h.db.batch.bind(h.db)
    vi.spyOn(h.db,'batch').mockImplementationOnce(async statements=>{h.sqlite.exec("UPDATE members SET status='suspended' WHERE id='m-b'");return batch(statements)})
    expect((await call('source-member-race','source-member-race')).ok).toBe(false);expect(count('owner_calls')).toBe(0)
  })

  it('actor credential revocation with independent source is fenced at commit',async()=>{
    source('independent-source','b')
    const batch=h.db.batch.bind(h.db)
    vi.spyOn(h.db,'batch').mockImplementationOnce(async statements=>{h.sqlite.exec("UPDATE member_tokens SET revoked_at='2026-10-29T14:00:00Z' WHERE id='t-a'");return batch(statements)})
    expect((await call('independent-actor','independent-source')).ok).toBe(false);expect(count('owner_calls')).toBe(0)
  })

})
