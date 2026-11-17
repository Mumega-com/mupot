// tests/inbox-stream-poll-cost.test.ts — the SSE tick must stay cheap (prod 2026-10-25: 97% of D1 queries
// were /api/inbox/stream at 1 s x ~86 streams). Real migration schema; statements counted via a prepare proxy.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { STREAM_REVALIDATE_MS, streamInboxEvents, type InboxStreamEvent } from '../src/agents/inbox-routes'
import type { Env } from '../src/types'

const TENANT = 'mumega'
const AGENT = 'ag-poll-recipient'

let harness: SqliteD1Harness
let n = 0
let env: Env

// Virtual clock: sleep() advances time instantly, so 60 s of idle stream runs in ms.
function clock() {
  let t = 1_000_000
  const sleeps: number[] = []
  return {
    sleeps,
    sleep: async (ms: number) => { sleeps.push(ms); t += ms },
    nowMs: () => t,
  }
}

async function nextOf(gen: AsyncGenerator<InboxStreamEvent>): Promise<IteratorResult<InboxStreamEvent>> {
  return gen.next()
}

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  n = 0
  const wrapped = new Proxy(harness.db, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv)
      if (prop === 'prepare') return (sql: string) => { n++; return (v as (s: string) => unknown).call(target, sql) }
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
  env = { DB: wrapped, TENANT_SLUG: TENANT } as unknown as Env
})
afterEach(() => {harness.close();vi.useRealTimers()})

function canonicalAgent():void {
  harness.sqlite.exec(`INSERT INTO departments(id,slug,name) VALUES('audit-dept','audit-dept','Audit');
    INSERT INTO squads(id,department_id,slug,name) VALUES('audit-squad','audit-dept','audit-squad','Audit');
    INSERT INTO members(id,tenant,display_name,status) VALUES('audit-member','${TENANT}','Audit','active');
    INSERT INTO agents(id,squad_id,slug,name,role,model,status) VALUES('${AGENT}','audit-squad','audit-agent','Audit','member','test','active');
    INSERT INTO agent_member_bindings(tenant,agent_id,member_id,created_at) VALUES('${TENANT}','${AGENT}','audit-member','2026-01-01T00:00:00Z');`)
}

describe('inbox stream poll cost', () => {
  it('idle stream over 60 s: 1 statement per tick after the connect flush, one revalidate', async () => {
    const c = clock()
    let revalidations = 0
    const gen = streamInboxEvents(env, { agent: AGENT, since: 0, revalidate: async () => { revalidations++; return true } }, { sleep: c.sleep, nowMs: c.nowMs })
    // No initial frame (empty inbox): the first next() runs the connect flush then the first tick.
    const afterConnect = n
    for (let i = 0; i < 6; i++) {
      const ev = await nextOf(gen)
      expect((ev.value as InboxStreamEvent).type).toBe('heartbeat')
    }
    const total = n
    expect(c.sleeps).toEqual([10000, 10000, 10000, 10000, 10000, 10000])
    // connect flush = SELECT + fence + COUNT (3); then 6 ticks x 1 SELECT. Before: 6 x 3 = 18 tick statements.
    expect(total).toBeLessThanOrEqual(3 + 6)
    expect(total - afterConnect).toBeLessThanOrEqual(9)
    expect(revalidations).toBe(1)
    await gen.return(undefined)
  })

  it('records active empty polls with two statements, then returns to one after expiry',async()=>{
    vi.useFakeTimers();const t0=Date.parse('2026-11-17T12:00:00Z');vi.setSystemTime(t0);canonicalAgent()
    harness.sqlite.prepare("INSERT INTO agent_audit(id,agent_id,actor_id,actor_type,action,fields_changed,before_state,after_state,created_at) VALUES('active-echo',?,'audit-member','system','connection_wake_challenge','[]','{}',?,?)").run(AGENT,JSON.stringify({expires_at:new Date(t0+600000).toISOString()}),new Date(t0).toISOString())
    const c=clock();const gen=streamInboxEvents(env,{agent:AGENT,since:0},{sleep:c.sleep,nowMs:c.nowMs})
    await nextOf(gen);let before=n
    expect(((await nextOf(gen)).value as InboxStreamEvent).type).toBe('heartbeat');expect(n-before).toBe(2)
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_audit WHERE action='connection_wake_inbox_read'").get()).toMatchObject({n:1})
    vi.setSystemTime(t0+600001);before=n
    expect(((await nextOf(gen)).value as InboxStreamEvent).type).toBe('heartbeat');expect(n-before).toBe(1)
    await gen.return(undefined)
  })

  it('delivers a new message on the next tick', async () => {
    const c = clock()
    const gen = streamInboxEvents(env, { agent: AGENT, since: 0 }, { sleep: c.sleep, nowMs: c.nowMs })
    expect(((await nextOf(gen)).value as InboxStreamEvent).type).toBe('heartbeat')
    await harness.db.prepare(
      `INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, kind, body, created_at)
       VALUES ('m1', ?1, ?2, 'ag-s', 'mem-s', 'message', 'hello', datetime('now'))`,
    ).bind(TENANT, AGENT).run()
    const ev = (await nextOf(gen)).value as InboxStreamEvent
    expect(ev.type).toBe('message')
    if (ev.type === 'message') expect(ev.message.body).toBe('hello')
    await gen.return(undefined)
  })

  it('a revoked token ends the stream within 60 s + one tick, and not before the window', async () => {
    const c = clock()
    let valid = true
    const gen = streamInboxEvents(env, { agent: AGENT, since: 0, revalidate: async () => valid }, { sleep: c.sleep, nowMs: c.nowMs })
    const start = c.nowMs()
    valid = false // revoked right after connect
    let ticks = 0
    for (;;) {
      const ev = await nextOf(gen)
      if (ev.done) break
      ticks++
      expect(ticks).toBeLessThan(20)
    }
    const elapsed = c.nowMs() - start
    expect(elapsed).toBeGreaterThanOrEqual(STREAM_REVALIDATE_MS)
    expect(elapsed).toBeLessThanOrEqual(STREAM_REVALIDATE_MS + 10000)
  })

  it('clamps poll_ms: below 5000 up to 5000, above 30000 down to 30000, default 10000', async () => {
    for (const [ask, want] of [[250, 5000], [1000, 5000], [7000, 7000], [999999, 30000], [undefined, 10000]] as const) {
      const c = clock()
      const gen = streamInboxEvents(env, { agent: AGENT, since: 0, pollMs: ask }, { sleep: c.sleep, nowMs: c.nowMs })
      await nextOf(gen)
      expect(c.sleeps[0]).toBe(want)
      await gen.return(undefined)
    }
  })

  async function insertMsg(id: string): Promise<void> {
    await harness.db.prepare(
      `INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, kind, body, created_at)
       VALUES (?1, ?2, ?3, 'ag-s', 'mem-s', 'message', 'secret body', datetime('now'))`,
    ).bind(id, TENANT, AGENT).run()
  }

  it('P1: token revoked at t=1 s, message lands at t=15 s -> zero message events, stream ends', async () => {
    const c = clock()
    let valid = true
    const gen = streamInboxEvents(env, { agent: AGENT, since: 0, revalidate: async () => valid }, { sleep: c.sleep, nowMs: c.nowMs })
    expect(((await nextOf(gen)).value as InboxStreamEvent).type).toBe('heartbeat') // t=10 s
    valid = false // revoked (~t=1 s relative to connect, well inside the 60 s idle window)
    await insertMsg('late') // arrives before the t=20 s tick; far from the 60 s cadence
    const events: string[] = []
    for (let i = 0; i < 20; i++) {
      const ev = await nextOf(gen)
      if (ev.done) break
      events.push((ev.value as InboxStreamEvent).type)
    }
    expect(events).not.toContain('message')
    expect(events).toEqual([]) // the very next tick revalidates, fails, ends with no frames
  })

  it('P2: a signed_only fence row + unread message -> zero message events on the stream path', async () => {
    await insertMsg('fenced')
    harness.sqlite.exec('PRAGMA foreign_keys = OFF') // fence FKs (agents/members) are irrelevant to the read predicate
    await harness.db.prepare(
      `INSERT INTO agent_inbox_fences (tenant, agent_id, mode, key_fingerprint, generation, updated_by_member_id, updated_at, reason)
       VALUES (?1, ?2, 'signed_only', ?3, 1, 'mem-x', '2026-01-01T00:00:00.000Z', 'test')`,
    ).bind(TENANT, AGENT, 'a'.repeat(64)).run()
    const c = clock()
    const gen = streamInboxEvents(env, { agent: AGENT, since: 0 }, { sleep: c.sleep, nowMs: c.nowMs })
    for (let i = 0; i < 3; i++) expect(((await nextOf(gen)).value as InboxStreamEvent).type).toBe('heartbeat')
    await gen.return(undefined)
  })
  it.each(['folded','observer'] as const)('round2: %s audit lookup uses an actor/time range instead of scanning old history',async mode=>{
    canonicalAgent();const at='2026-11-17T12:00:00.000Z'
    const insert=harness.sqlite.prepare("INSERT INTO agent_audit(id,agent_id,actor_id,actor_type,action,fields_changed,before_state,after_state,created_at) VALUES(?,?,?,'system','update_agent','[]','{}','{}',?)")
    harness.sqlite.exec('BEGIN')
    for(let i=0;i<5000;i++)insert.run('old-'+i,AGENT,'audit-member','2026-11-16T12:00:00.000Z')
    harness.sqlite.exec('COMMIT')
    const trace:Array<{sql:string;values:unknown[];method:string}>=[]
    const wrap=(stmt:D1PreparedStatement,sql:string,values:unknown[]=[]):D1PreparedStatement=>new Proxy(stmt,{get(target,key){
      if(key==='bind')return (...args:unknown[])=>wrap(target.bind(...args),sql,args)
      if(key==='all'||key==='run'||key==='first')return async(...args:unknown[])=>{trace.push({sql,values,method:String(key)});return (target[key] as (...a:unknown[])=>Promise<unknown>).apply(target,args)}
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
    }})
    const traced={...env,DB:new Proxy(env.DB,{get(target,key){
      if(key==='prepare')return (sql:string)=>wrap(target.prepare(sql),sql)
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
    }})} as Env
    if(mode==='folded') {const {readAgentInbox}=await import('../src/agents/messages');expect(await readAgentInbox(traced,{agent:AGENT,peek:true,skipRemaining:true},{now:()=>at})).toMatchObject({ok:true,messages:[]})}
    else {const {recordWakeInboxRead}=await import('../src/agents/wake-echo-observer');await recordWakeInboxRead(traced,AGENT,'bearer',true,at)}
    const lookup=trace.find(x=>x.sql.includes('connection_wake_challenge'));expect(lookup).toBeDefined()
    const plan=await harness.db.prepare('EXPLAIN QUERY PLAN '+lookup!.sql).bind(...lookup!.values).all<{detail:string}>()
    const details=(plan.results??[]).map(x=>x.detail).join('\n')
    expect(details).toMatch(/SEARCH c USING INDEX idx_agent_audit_actor_changes \(actor_id=\? AND created_at>\?\)/)
    expect(details).not.toMatch(/SEARCH c USING INDEX idx_agent_audit_agent \(agent_id=\?\)/)
  })
  it('round2: dense recent audit rows cannot hide an active challenge behind a candidate limit',async()=>{
    canonicalAgent();const at='2026-11-17T12:00:00.000Z'
    harness.sqlite.prepare("INSERT INTO agent_audit(id,agent_id,actor_id,actor_type,action,fields_changed,before_state,after_state,created_at) VALUES('dense-challenge',?,'audit-member','system','connection_wake_challenge','[]','{}',?,?)").run(AGENT,JSON.stringify({expires_at:'2026-11-17T12:10:00Z'}),at)
    const insert=harness.sqlite.prepare("INSERT INTO agent_audit(id,agent_id,actor_id,actor_type,action,fields_changed,before_state,after_state,created_at) VALUES(?,?,'audit-member','system','update_agent','[]','{}','{}','2026-11-17T12:00:01Z')")
    for(let i=0;i<300;i++)insert.run('recent-'+i,AGENT)
    const {readAgentInbox}=await import('../src/agents/messages')
    const before=n;expect(await readAgentInbox(env,{agent:AGENT,peek:true,skipRemaining:true},{now:()=> '2026-11-17T12:00:02Z'})).toMatchObject({ok:true,messages:[]})
    expect(n-before).toBe(2)
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_audit WHERE action='connection_wake_inbox_read'").get()).toMatchObject({n:1})
  })

})
