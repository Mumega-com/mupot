import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext, Env } from '../src/types'
import { invokeTool, advertisedTools } from '../src/mcp/index'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const NOW = Date.parse('2026-10-29T14:00:00Z')
// Commit predicates use the database clock, so live fixture deadlines must not expire as the calendar advances.
const LIVE_UNTIL = new Date(Date.now() + 7 * 86400_000).toISOString()
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
    VALUES (?,'test',?,?,?,'["action:project_lifecycle"]','squad','sq',15,'private-secret-source','pending','2026-10-29T13:59:00Z',?)`).run(id, `s-${agent}`, agent, `m-${agent}`, LIVE_UNTIL)
  h.sqlite.prepare(`INSERT INTO approval_bot_deliveries (id,tenant,request_id,member_id,chat_id,status,created_at) VALUES (?,'test',?,'human','private-chat','reserved','2026-10-29T13:59:00Z')`).run(`d-${id}`, id)
}
// Real migrated storage fixture with no requester/alias children: lets retention guards be tested independently of FKs.
function bareAsk(id: string, kind: 'access' | 'reauth' = 'access', sourceId='e1', createdAt='2026-10-29T14:00:00.000Z') {
  h.sqlite.prepare(`INSERT INTO owner_calls(id,tenant,owner_member_id,owner_revision,created_by_agent_id,source_agent_id,kind,action_type,action_id,action_version,reason_code,canonical_delivery_id,created_at)
    VALUES (?,'test','human',0,'a','a',?,?,?,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','access_required',?,?)`)
    .run(id,kind,kind==='access'?'elevation_request':'connection',kind==='access'?sourceId:'connection-fixture',kind==='access'?`d-${sourceId}`:null,createdAt)
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
      VALUES(?,'test',?,?,'workspace_token',?,'2026-10-29T13:59:00Z','2026-10-29T13:59:00Z',?,?)`).run(`s-${agent}`, agent, `m-${agent}`, `t-${agent}`, LIVE_UNTIL, LIVE_UNTIL)
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
    const winner=results.findIndex(r=>r.ok)
    expect(await call(`k${winner}`,`e${winner+1}`)).toMatchObject({ ok: true, result: { retry: true } })
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

  it('revoked actor session cannot use a peer source',async()=>{
    source('peer-session-source','b')
    h.sqlite.exec("UPDATE agent_sessions SET revoked_at='2026-10-29T14:00:00Z' WHERE id='s-a'")
    expect(await call('revoked-session','peer-session-source')).toMatchObject({ok:false,error:'agent_binding_required'})
    expect(count('owner_calls')).toBe(0)
  })
  it.each([
    "UPDATE member_tokens SET channel='directory' WHERE id='t-a'",
    "UPDATE agent_sessions SET auth_kind='oauth' WHERE id='s-a'",
    "UPDATE member_tokens SET channel='directory' WHERE id='t-a'; UPDATE agent_sessions SET auth_kind='oauth' WHERE id='s-a'",
  ])('workspace context rejects token/session channel mismatch: %s',async sql=>{
    source('peer-channel-source','b');h.sqlite.exec(sql)
    expect(await call('mismatch','peer-channel-source')).toMatchObject({ok:false,error:'agent_binding_required'})
    expect(count('owner_calls')).toBe(0)
  })
  it('directory context rejects a workspace credential even with a live consenter',async()=>{
    source('directory-peer','b')
    h.sqlite.exec("INSERT INTO capabilities(id,member_id,scope_type,scope_id,capability) VALUES('consenter-admin','human','squad','sq','admin')")
    expect(await call('directory-mismatch','directory-peer',auth('a',{channel:'directory',consentedByMemberId:'human'}))).toMatchObject({ok:false,error:'agent_binding_required'})
    expect(count('owner_calls')).toBe(0)
  })
  it('plain unattached seat is refused with a safe source refusal',async()=>{
    const attached=admittedAuth()
    const {attached:ignored,...plain}=attached.seatBinding!
    void ignored
    expect(await call('plain-seat','e1',{...attached,seatBinding:plain})).toMatchObject({ok:false,error:'owner_call_source_unavailable'})
    expect(count('owner_calls')).toBe(0)
  })
  it('DB closed-to-pending transition cannot resurrect an ask',async()=>{
    const out=await call();const id=(out as any).result.ask_id
    h.sqlite.prepare("UPDATE owner_calls SET state='closed' WHERE id=?").run(id)
    expect(()=>h.sqlite.prepare("UPDATE owner_calls SET state='pending' WHERE id=?").run(id)).toThrow(/owner_call_immutable/)
    expect(h.sqlite.prepare('SELECT state FROM owner_calls WHERE id=?').get(id)).toEqual({state:'closed'})
  })
  it('requester revision retry rejects owner changed and restored on a peer source',async()=>{
    const out=await call('requester-epoch','e1',auth('b'));expect(out.ok).toBe(true)
    h.sqlite.exec("UPDATE agents SET owner_member_id='m-c' WHERE id='b'; UPDATE agents SET owner_member_id='human' WHERE id='b'")
    expect(h.sqlite.prepare('SELECT state FROM owner_calls').get()).toEqual({state:'pending'})
    expect(await call('requester-epoch','e1',auth('b'))).toMatchObject({ok:false,error:'owner_setup_required'})
    expect(count('owner_calls')).toBe(1);expect(count('owner_call_key_aliases')).toBe(1)
  })
  it('same-key owner-changed-and-back retry never reopens the closed projection',async()=>{
    expect((await call()).ok).toBe(true)
    h.sqlite.exec("UPDATE agents SET owner_member_id='m-c' WHERE id='a'; UPDATE agents SET owner_member_id='human' WHERE id='a'")
    expect(await call()).toMatchObject({ok:false,error:'owner_setup_required'})
    expect(h.sqlite.prepare('SELECT state FROM owner_calls').get()).toEqual({state:'closed'})
  })
  it.each([
    "UPDATE members SET status='suspended' WHERE id='m-a'",
    "UPDATE members SET archived_at='2026-10-29T14:00:00Z' WHERE id='m-a'",
    "UPDATE agents SET status='paused' WHERE id='a'",
  ])('actor liveness cannot be masked by a live peer source: %s',async sql=>{
    source('independent-actor-member','b');h.sqlite.exec(sql)
    expect(await call('actor-member','independent-actor-member')).toMatchObject({ok:false,error:'agent_binding_required'})
    expect(count('owner_calls')).toBe(0)
  })
  it('commit refuses an owner welded to an agent after the pre-read',async()=>{
    source('nonhuman-owner-source','b')
    h.sqlite.exec("INSERT INTO agents(id,squad_id,slug,name,role,model) VALUES('owner-agent','sq','owner-agent','Owner agent','member','test')")
    const batch=h.db.batch.bind(h.db)
    vi.spyOn(h.db,'batch').mockImplementationOnce(async statements=>{
      h.sqlite.exec("INSERT INTO agent_member_bindings(tenant,agent_id,member_id,created_at) VALUES('test','owner-agent','human','2026-10-29T14:00:00Z')")
      return batch(statements)
    })
    expect((await call('nonhuman-owner','nonhuman-owner-source')).ok).toBe(false)
    expect(count('owner_calls')).toBe(0)
  })
  it('outbox kind trigger accepts inert reauth metadata and refuses access',()=>{
    bareAsk('oc-access');bareAsk('oc-reauth','reauth')
    h.sqlite.exec("INSERT INTO owner_call_outbox(ask_id,tenant,created_at) VALUES('oc-reauth','test','2026-10-29T14:00:00.000Z')")
    expect(()=>h.sqlite.exec("INSERT INTO owner_call_outbox(ask_id,tenant,created_at) VALUES('oc-access','test','2026-10-29T14:00:00.000Z')")).toThrow(/owner_call_outbox_kind/)
    expect(count('owner_call_outbox')).toBe(1)
  })
  it('owner_calls no-delete guard retains an unreferenced ask independently of FKs',()=>{
    bareAsk('oc-unreferenced')
    expect(()=>h.sqlite.exec("DELETE FROM owner_calls WHERE id='oc-unreferenced'")).toThrow(/owner_call_history_retained/)
    expect(count('owner_calls')).toBe(1)
  })
  it.each([
    "UPDATE owner_call_hmac_versions SET key_check='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'",
    "UPDATE owner_call_hmac_versions SET key_version='v-next'",
    "DELETE FROM owner_call_hmac_versions",
  ])('HMAC version history is immutable: %s',async sql=>{
    await call()
    expect(()=>h.sqlite.exec(sql)).toThrow(/owner_call_key_history/)
    expect(count('owner_call_hmac_versions')).toBe(1)
  })
  it.each(['approved','denied','revoked'])('canonical %s transition closes projections without requester retry',async status=>{
    const first=await call()
    h.sqlite.prepare('UPDATE elevation_requests SET status=? WHERE id=?').run(status,'e1')
    expect(h.sqlite.prepare('SELECT state FROM owner_calls WHERE id=?').get((first as any).result.ask_id)).toEqual({state:'closed'})
    expect(count('owner_call_requesters')).toBe(1);expect(count('owner_call_key_aliases')).toBe(1)
  })
  it('lazy expiry frees stale requester capacity before the next authorized creation',async()=>{
    for(let i=0;i<10;i++){
      source(`stale-${i}`)
      expect((await call(`stale-key-${i}`,`stale-${i}`)).ok).toBe(true)
      if(i%5===4)vi.advanceTimersByTime(900_001)
    }
    h.sqlite.exec("UPDATE elevation_requests SET decision_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second') WHERE id LIKE 'stale-%'")
    expect(h.sqlite.prepare("SELECT COUNT(*) n FROM owner_calls WHERE state='pending'").get()).toEqual({n:10})
    source('fresh-after-expiry')
    expect(await call('fresh-after-expiry','fresh-after-expiry')).toMatchObject({ok:true})
    expect(h.sqlite.prepare("SELECT COUNT(*) n FROM owner_calls WHERE state='pending'").get()).toEqual({n:1})
    expect(count('owner_calls')).toBe(11);expect(count('owner_call_requesters')).toBe(11)
  })
  it('alias budget bounds fresh keys while preserving retries and HMAC rotation at capacity',async()=>{
    let first:any
    for(let i=0;i<32;i++){
      const out=await call(`alias-${i}`);expect(out.ok).toBe(true)
      if(i===0)first=out
    }
    expect(await call('alias-over')).toMatchObject({ok:false,error:'owner_call_alias_limit'})
    expect(await call('alias-0')).toMatchObject({ok:true,result:{ask_id:first.result.ask_id,retry:true}})
    env.OWNER_CALL_HMAC_KEYS=JSON.stringify([{version:'v2',key:'rotation-test-key-at-least-32-bytes'},{version:'v1',key:'test-only-hmac-key-at-least-32-bytes'}])
    expect(await call('alias-0')).toMatchObject({ok:true,result:{ask_id:first.result.ask_id,retry:true}})
    expect(await call('alias-over')).toMatchObject({ok:false,error:'owner_call_alias_limit'})
    expect(count('owner_call_key_aliases')).toBe(33);expect(count('owner_calls')).toBe(1)
  })
  it.each(['agent','owner'])('%s rate trigger uses an indexed created_at range',scope=>{
    const row=h.sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(`owner_call_${scope}_rate`)!
    const when=String(row.sql).split('WHEN ')[1].split('BEGIN ')[0]
      .replaceAll('NEW.tenant',"'test'").replaceAll('NEW.created_by_agent_id',"'a'").replaceAll('NEW.owner_member_id',"'human'")
      .replaceAll('NEW.created_at',"'2026-10-29T14:00:00.000Z'")
    const plan=h.sqlite.prepare(`EXPLAIN QUERY PLAN SELECT 1 WHERE ${when}`).all()
    const column=scope==='agent'?'created_by_agent_id':'owner_member_id'
    expect(plan.some(r=>String(r.detail).includes(`${column}=?`) && /created_at>\?/.test(String(r.detail)))).toBe(true)
  })

  it('fresh keys reject retained requester revision mismatch without accepting an unstable retry',async()=>{
    expect((await call('retained-original','e1',auth('b'))).ok).toBe(true)
    h.sqlite.exec("UPDATE agents SET owner_member_id='m-c' WHERE id='b'; UPDATE agents SET owner_member_id='human' WHERE id='b'")
    expect(await call('retained-fresh','e1',auth('b'))).toMatchObject({ok:false,error:'owner_setup_required'})
    expect(await call('retained-fresh','e1',auth('b'))).toMatchObject({ok:false,error:'owner_setup_required'})
    expect(count('owner_call_key_aliases')).toBe(1)
    expect(h.sqlite.prepare("SELECT owner_revision FROM owner_call_requesters WHERE agent_id='b'").get()).toEqual({owner_revision:0})
  })
  it('retained requester revision is rechecked in the conditional commit before alias insertion',async()=>{
    const first=await call();const id=(first as any).result.ask_id
    h.sqlite.exec("UPDATE agents SET owner_member_id='m-c' WHERE id='b'; UPDATE agents SET owner_member_id='human' WHERE id='b'")
    const batch=h.db.batch.bind(h.db)
    vi.spyOn(h.db,'batch').mockImplementationOnce(async statements=>{
      h.sqlite.prepare("INSERT INTO owner_call_requesters(tenant,ask_id,agent_id,owner_revision,created_at) VALUES('test',?,'b',0,'2026-10-29T14:00:00.000Z')").run(id)
      return batch(statements)
    })
    expect((await call('retained-race','e1',auth('b'))).ok).toBe(false)
    expect(count('owner_calls')).toBe(1);expect(count('owner_call_key_aliases')).toBe(1)
    expect(count('owner_call_requesters')).toBe(2) // includes the independently committed stale association
  })
  it('reconciles legacy terminal sources before pending quotas even after their source session ends',async()=>{
    for(let i=0;i<10;i++){
      const sourceId=`legacy-terminal-${i}`;source(sourceId)
      h.sqlite.prepare("UPDATE elevation_requests SET status='denied' WHERE id=?").run(sourceId)
      const id=`oc-legacy-${i}`,createdAt=new Date(NOW-(40-i)*900_001).toISOString()
      bareAsk(id,'access',sourceId,createdAt)
      h.sqlite.prepare("INSERT INTO owner_call_requesters(tenant,ask_id,agent_id,owner_revision,created_at) VALUES('test',?,'a',0,?)").run(id,createdAt)
    }
    h.sqlite.exec("UPDATE agent_sessions SET revoked_at='2026-10-29T14:00:00Z' WHERE id='s-a'")
    h.sqlite.prepare(`INSERT INTO agent_sessions(id,tenant,agent_id,member_id,auth_kind,credential_id,created_at,last_seen_at,idle_expires_at,absolute_expires_at)
      VALUES('s-a-new','test','a','m-a','workspace_token','t-a','2026-10-29T14:00:00Z','2026-10-29T14:00:00Z',?,?)`).run(LIVE_UNTIL,LIVE_UNTIL)
    expect(h.sqlite.prepare("SELECT COUNT(*) n FROM owner_calls WHERE state='pending'").get()).toEqual({n:10})
    source('new-session-source')
    h.sqlite.exec("UPDATE elevation_requests SET agent_session_id='s-a-new' WHERE id='new-session-source'")
    expect(await call('new-session-source','new-session-source')).toMatchObject({ok:true})
    expect(h.sqlite.prepare("SELECT COUNT(*) n FROM owner_calls WHERE state='pending'").get()).toEqual({n:1})
    expect(count('owner_calls')).toBe(11);expect(count('owner_call_requesters')).toBe(11)
  })

})
