import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { D1PreparedStatement } from '@cloudflare/workers-types'
import { runProjectConcierge, BUILD_CAPABILITY } from '../src/concierge/service'
import { registerModule } from '../src/registry/service'
import { getAssignmentEligibleAgentIds } from '../src/tasks/assignment-eligibility'
import { runRouterTick } from '../src/router/engine'
import type { Env, Project } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'assignment-pot'
const SQUAD = 'assignment-squad'
const AGENT = 'agent-builder'
const TASK = 'assignment-task'
const GATE = 'gate:assignment-review'
let h: SqliteD1Harness
let env: Env
let beforeClaim: (() => void) | undefined
let claims: number
let claimErrors: unknown[]
let prepares: string[]
const send = vi.fn(async (_event: unknown) => undefined)

// Interleave real writes immediately before the real D1 UPDATE. No SQL is mocked
// or reimplemented: every statement executes against the complete migration chain.
function interleaved(statement: D1PreparedStatement, claim: boolean): D1PreparedStatement {
  return new Proxy(statement, {
    get(target, key) {
      if (key === 'bind') return (...args: unknown[]) => interleaved(target.bind(...args), claim)
      if (key === 'run' && claim) return async () => { claims++; const hook = beforeClaim; beforeClaim = undefined; try { hook?.(); return await target.run() } catch (error) { claimErrors.push(error); throw error } }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

beforeEach(async () => {
  h = createSqliteD1(); applyAllMigrations(h.sqlite)
  beforeClaim = undefined; claims = 0; claimErrors = []; prepares = []; send.mockClear()
  h.sqlite.exec(`
    INSERT INTO departments(id,slug,name) VALUES('assignment-dept','assignment-dept','Assignment');
    INSERT INTO squads(id,department_id,slug,name) VALUES('${SQUAD}','assignment-dept','assignment-squad','Assignment');
    INSERT INTO agents(id,squad_id,slug,name,status) VALUES('${AGENT}','${SQUAD}','builder','Builder','active');
    INSERT INTO members(id,tenant,display_name,status) VALUES('assignment-operator','${TENANT}','Operator','active');
    INSERT INTO capabilities(id,member_id,scope_type,scope_id,capability) VALUES('assignment-cap','assignment-operator','squad','${SQUAD}','lead');
    INSERT INTO projects(id,slug,name,goal,status) VALUES('assignment-project','assignment-project','Assignment','Ship work','active');
    INSERT INTO project_squad_access(project_id,squad_id,access_level) VALUES('assignment-project','${SQUAD}','write');
    INSERT INTO tasks(id,squad_id,project_id,title,done_when,status,updated_at) VALUES('${TASK}','${SQUAD}','assignment-project','Sitting work','done','open','2020-01-01T00:00:00.000Z');
    INSERT INTO presence(tenant,member_id,display_name,source,label,agent_id,first_seen_at,last_seen_at)
      VALUES('${TENANT}','assignment-seat','Builder','test','test','${AGENT}',datetime('now'),datetime('now'));
  `)
  env = { DB: { ...h.db, prepare: (sql: string) => { prepares.push(sql); return interleaved(h.db.prepare(sql), /^\s*UPDATE tasks\s+SET assignee_agent_id/i.test(sql)) } }, TENANT_SLUG: TENANT, BUS: { send } } as unknown as Env
  expect((await registerModule(env, { identity: AGENT, kind: 'agent_system', adapter: 'cursor', projectId: null, capabilities: [BUILD_CAPABILITY] })).ok).toBe(true)
})
afterEach(() => h.close())

function pause(scope: 'agent' | 'squad', id = 'assignment-pause'): void {
  h.sqlite.prepare('INSERT INTO execution_pauses(id,tenant,scope_type,scope_id,reason,paused_by_member_id,paused_at) VALUES(?,?,?,?,?,?,datetime(\'now\'))')
    .run(id,TENANT,scope,scope === 'agent' ? AGENT : SQUAD,'paused for review','assignment-operator')
}
function humanGate(): void {
  h.sqlite.prepare('UPDATE tasks SET gate_owner=? WHERE id=?').run(GATE,TASK)
  h.sqlite.exec(`INSERT INTO members(id,tenant,display_name,status) VALUES('assignment-reviewer','${TENANT}','Reviewer','active');
    INSERT INTO capabilities(id,member_id,scope_type,scope_id,capability) VALUES('assignment-reviewer-cap','assignment-reviewer','squad','${SQUAD}','member');
    INSERT INTO gate_grants(id,capability,principal_type,principal_id,granted_by,created_at) VALUES('assignment-gate','${GATE}','member','assignment-reviewer','assignment-operator',datetime('now'));`)
}
function selfGate(): void {
  h.sqlite.prepare('UPDATE tasks SET gate_owner=? WHERE id=?').run(GATE,TASK)
  h.sqlite.exec(`INSERT INTO members(id,tenant,display_name,status) VALUES('assignment-builder-member','${TENANT}','Builder member','active');
    INSERT INTO capabilities(id,member_id,scope_type,scope_id,capability) VALUES('assignment-builder-cap','assignment-builder-member','squad','${SQUAD}','member');
    INSERT INTO agent_member_bindings(tenant,agent_id,member_id,created_at) VALUES('${TENANT}','${AGENT}','assignment-builder-member',datetime('now'));
    INSERT INTO member_tokens(id,member_id,token_hash,label,channel,agent_id,tenant,expires_at,created_at)
      VALUES('assignment-token','assignment-builder-member','assignment-test-hash','test','workspace','${AGENT}','${TENANT}','2099-01-01T00:00:00.000Z',datetime('now'));
    INSERT INTO gate_grants(id,capability,principal_type,principal_id,granted_by,created_at) VALUES('assignment-self-gate','${GATE}','agent','${AGENT}','assignment-operator',datetime('now'));`)
}
function row() { return h.sqlite.prepare('SELECT assignee_agent_id,updated_at FROM tasks WHERE id=?').get(TASK) as {assignee_agent_id:string|null;updated_at:string} }
async function run(writer: 'concierge' | 'router'): Promise<number> {
  if (writer === 'concierge') {
    const p = h.sqlite.prepare('SELECT * FROM projects WHERE id=?').get('assignment-project') as unknown as Project
    const result = await runProjectConcierge(env,p)
    expect(claimErrors).toEqual([])
    return result.decision.action === 'route' ? result.decision.routed : 0
  }
  const result = await runRouterTick(env,{ok:true,tenant:TENANT,squadId:SQUAD,agentId:null,source:'principal'},{squadId:SQUAD,dryRun:false},{memberId:'assignment-operator'})
  expect(claimErrors).toEqual([])
  return result.assigned
}

for (const writer of ['concierge','router'] as const) describe(`assignment fence: ${writer}`, () => {
  it.each([null,'gate:agent-self-completion',GATE])('preserves eligible assignment with %s gate',async gate => {
    if (gate === GATE) humanGate(); else h.sqlite.prepare('UPDATE tasks SET gate_owner=? WHERE id=?').run(gate,TASK)
    expect(await run(writer)).toBe(1); expect(row().assignee_agent_id).toBe(AGENT)
  })
  it.each(['agent','squad'] as const)('refuses an already paused %s',async scope => {
    pause(scope); expect(await run(writer)).toBe(0); expect(row().assignee_agent_id).toBeNull(); expect(claims).toBe(0)
  })
  it('refuses the sole gate holder as assignee',async () => {
    selfGate(); expect(await run(writer)).toBe(0); expect(row().assignee_agent_id).toBeNull(); expect(claims).toBe(0)
  })
  it('refuses a missing independent gate',async () => {
    h.sqlite.prepare('UPDATE tasks SET gate_owner=? WHERE id=?').run(GATE,TASK)
    expect(await run(writer)).toBe(0); expect(row().assignee_agent_id).toBeNull()
  })
  it.each(['agent','squad'] as const)('fences a %s pause between selection and commit',async scope => {
    beforeClaim = () => pause(scope)
    expect(await run(writer)).toBe(0); expect(claims).toBe(1)
    expect(row()).toEqual({assignee_agent_id:null,updated_at:'2020-01-01T00:00:00.000Z'}); expect(send).not.toHaveBeenCalled()
  })
  it('fences an inactive candidate at commit',async () => {
    beforeClaim = () => { h.sqlite.prepare("UPDATE agents SET status='paused' WHERE id=?").run(AGENT) }
    expect(await run(writer)).toBe(0); expect(claims).toBe(1); expect(row().assignee_agent_id).toBeNull(); expect(send).not.toHaveBeenCalled()
  })
  it('fences a revoked gate grant at commit',async () => {
    humanGate(); beforeClaim = () => { h.sqlite.exec("DELETE FROM gate_grants WHERE id='assignment-gate'") }
    expect(await run(writer)).toBe(0); expect(claims).toBe(1); expect(row().assignee_agent_id).toBeNull(); expect(send).not.toHaveBeenCalled()
  })
  it('fences a changed gate owner using the current task row',async () => {
    humanGate(); beforeClaim = () => { h.sqlite.prepare('UPDATE tasks SET gate_owner=? WHERE id=?').run('gate:new-unheld',TASK) }
    expect(await run(writer)).toBe(0); expect(claims).toBe(1); expect(row().assignee_agent_id).toBeNull(); expect(send).not.toHaveBeenCalled()
  })
})

for (const writer of ['concierge','router'] as const) describe(`assignment fence follow-through: ${writer}`, () => {
  it('keeps a gate-holding candidate eligible when another independent holder exists',async () => {
    selfGate(); humanGate(); expect(await run(writer)).toBe(1); expect(row().assignee_agent_id).toBe(AGENT)
  })
  it('continues after a lost claim without charging that assignment to the candidate',async () => {
    humanGate()
    for (const id of ['next-task-a','next-task-b']) h.sqlite.prepare(`INSERT INTO tasks(id,squad_id,project_id,title,done_when,status,created_at)
      VALUES(?,?,'assignment-project','More sitting work','done','open','2099-01-01T00:00:00.000Z')`).run(id,SQUAD)
    beforeClaim = () => { h.sqlite.exec("DELETE FROM gate_grants WHERE id='assignment-gate'") }
    expect(await run(writer)).toBe(2); expect(row().assignee_agent_id).toBeNull()
    expect(h.sqlite.prepare("SELECT COUNT(*) AS n FROM tasks WHERE id IN ('next-task-a','next-task-b') AND assignee_agent_id=?").get(AGENT)).toEqual({n:2})
  })
})

it.each(['source_pot','external_source','project_id','squad_id'] as const)('concierge fences a changed %s at commit',async column => {
  h.sqlite.exec("INSERT INTO projects(id,slug,name,status) VALUES('other-project','other-project','Other','active'); INSERT INTO squads(id,department_id,slug,name) VALUES('other-squad','assignment-dept','other-squad','Other'); INSERT INTO project_squad_access(project_id,squad_id,access_level) VALUES('other-project','assignment-squad','write'),('assignment-project','other-squad','write');")
  const changed = column === 'project_id' ? 'other-project' : column === 'squad_id' ? 'other-squad' : 'external-origin'
  beforeClaim = () => { h.sqlite.prepare(`UPDATE tasks SET ${column}=? WHERE id=?`).run(changed,TASK) }
  expect(await run('concierge')).toBe(0); expect(claims).toBe(1); expect(row().assignee_agent_id).toBeNull(); expect(send).not.toHaveBeenCalled()
})

it('concierge skips a paused first candidate and routes to a live alternative',async () => {
  pause('agent')
  h.sqlite.exec(`INSERT INTO agents(id,squad_id,slug,name,status) VALUES('agent-other','${SQUAD}','other-builder','Other builder','active')`)
  await registerModule(env,{identity:'agent-other',kind:'agent_system',adapter:'cursor',projectId:null,capabilities:[BUILD_CAPABILITY]})
  expect(await run('concierge')).toBe(1); expect(row().assignee_agent_id).toBe('agent-other')
})

it('concierge preserves legally assignable cross-squad candidates without imposing router presence',async () => {
  selfGate(); h.sqlite.prepare('UPDATE tasks SET gate_owner=NULL WHERE id=?').run(TASK)
  h.sqlite.exec("INSERT INTO squads(id,department_id,slug,name) VALUES('other-squad','assignment-dept','other-squad','Other'); UPDATE agents SET squad_id='other-squad' WHERE id='agent-builder'; DELETE FROM presence;")
  expect(await run('concierge')).toBe(1); expect(row().assignee_agent_id).toBe(AGENT)
})

it('router dry run preserves eligible planning without claiming or waking',async () => {
  humanGate()
  const result = await runRouterTick(env,{ok:true,tenant:TENANT,squadId:SQUAD,agentId:null,source:'principal'},{squadId:SQUAD,dryRun:true},{memberId:'assignment-operator'})
  expect(result.decisions).toEqual([{task_id:TASK,outcome:'would_assign',agent_id:AGENT}]); expect(claims).toBe(0); expect(row().assignee_agent_id).toBeNull(); expect(send).not.toHaveBeenCalled()
})

it('concierge selection scopes the gate check to the requested task',async () => {
 h.sqlite.prepare('UPDATE tasks SET gate_owner=? WHERE id=?').run(GATE,TASK)
 h.sqlite.prepare("INSERT INTO tasks(id,squad_id,project_id,title,done_when,status,created_at) VALUES('ungated-other',?,'assignment-project','Other work','done','open','2099-01-01T00:00:00.000Z')").run(SQUAD)
 expect(await run('concierge')).toBe(1); expect(row().assignee_agent_id).toBeNull(); expect(claims).toBe(1)
})


describe('concierge round2 bounded task and candidate reads', () => {
 it('five older tasks with unheld gates do not starve newer ungated work',async () => {
  h.sqlite.prepare("UPDATE tasks SET created_at='2099-01-01T00:00:00.000Z' WHERE id=?").run(TASK)
  for(let i=0;i<5;i++) h.sqlite.prepare("INSERT INTO tasks(id,squad_id,project_id,title,done_when,status,gate_owner,created_at) VALUES(?,?,'assignment-project','Held work','done','open',?,'2020-01-01T00:00:00.000Z')").run(`held-${i}`,SQUAD,GATE)
  expect(await run('concierge')).toBe(1); expect(row().assignee_agent_id).toBe(AGENT)
  expect(h.sqlite.prepare("SELECT COUNT(*) AS n FROM tasks WHERE id LIKE 'held-%' AND assignee_agent_id IS NULL").get()).toEqual({n:5})
 })
 it('uses one eligibility SELECT per task and bounded prepares with forty online candidates',async () => {
  for(let i=0;i<39;i++){
   const id=`agent-candidate-${i}`
   h.sqlite.prepare("INSERT INTO agents(id,squad_id,slug,name,status) VALUES(?,?,?,'Candidate','active')").run(id,SQUAD,`candidate-${i}`)
   expect((await registerModule(env,{identity:id,kind:'agent_system',adapter:'cursor',projectId:null,capabilities:[BUILD_CAPABILITY]})).ok).toBe(true)
  }
  h.sqlite.prepare("INSERT INTO tasks(id,squad_id,project_id,title,done_when,status,created_at) VALUES('fanout-next',?,'assignment-project','Next work','done','open','2099-01-01T00:00:00.000Z')").run(SQUAD)
  prepares.length=0
  expect(await run('concierge')).toBe(2)
  const scan=prepares.findIndex(sql => /SELECT id, squad_id, title, body FROM tasks/.test(sql))
  expect(scan).toBeGreaterThanOrEqual(0)
  const loop=prepares.slice(scan+1)
  expect(loop.filter(sql => /FROM tasks assignment_task/.test(sql))).toHaveLength(2)
  expect(loop.length).toBeLessThanOrEqual(16*2)
  expect(h.sqlite.prepare("SELECT COUNT(*) AS n FROM tasks WHERE id IN (?,?) AND assignee_agent_id IS NOT NULL").get(TASK,'fanout-next')).toEqual({n:2})
 })
})

it('bulk eligibility is scoped to the requested task and online roster',async () => {
 h.sqlite.prepare("INSERT INTO agents(id,squad_id,slug,name,status) VALUES('off-roster',?,'off-roster','Other','active')").run(SQUAD)
 expect(await getAssignmentEligibleAgentIds(env,TASK,[AGENT])).toEqual(new Set([AGENT]))
 expect(await getAssignmentEligibleAgentIds(env,TASK,[])).toEqual(new Set())
 h.sqlite.prepare('UPDATE tasks SET gate_owner=? WHERE id=?').run(GATE,TASK)
 h.sqlite.prepare("INSERT INTO tasks(id,squad_id,project_id,title,done_when,status) VALUES('other-ungated',?,'assignment-project','Other','done','open')").run(SQUAD)
 expect(await getAssignmentEligibleAgentIds(env,TASK,[AGENT])).toEqual(new Set())
 expect(await getAssignmentEligibleAgentIds(env,'missing-task',[AGENT])).toEqual(new Set())
})
it('expired gate standing does not occupy the concierge task window',async () => {
 humanGate(); h.sqlite.exec("UPDATE capabilities SET expires_at='2026-07-01T00:00:00.000Z' WHERE id='assignment-reviewer-cap'")
 h.sqlite.prepare("UPDATE tasks SET gate_owner=NULL,created_at='2099-01-01T00:00:00.000Z' WHERE id=?").run(TASK)
 for(let i=0;i<5;i++) h.sqlite.prepare("INSERT INTO tasks(id,squad_id,project_id,title,done_when,status,gate_owner,created_at) VALUES(?,?,'assignment-project','Held','done','open',?,'2020-01-01T00:00:00.000Z')").run(`expired-gate-${i}`,SQUAD,GATE)
 expect(await run('concierge')).toBe(1); expect(row().assignee_agent_id).toBe(AGENT)
 expect(h.sqlite.prepare("SELECT COUNT(*) AS n FROM tasks WHERE id LIKE 'expired-gate-%' AND assignee_agent_id IS NULL").get()).toEqual({n:5})
})

function fleetPresence(mode: 'resident' | 'poll', status: string, ageMs: number): void {
 const stamp=new Date(Date.now()-ageMs).toISOString()
 h.sqlite.prepare(`INSERT INTO fleet_agents(tenant,agent_id,display,runtime,squads,lifecycle,status,reported_by,last_reported_at,updated_at,presence_mode,presence_ttl_sec)
   VALUES(?,?,'Builder',?,'[]','always_on',?,'test',?,?,?,180)`)
   .run(TENANT,AGENT,mode==='poll'?'':'claude-code',status,stamp,stamp,mode)
}
for(const writer of ['concierge','router'] as const) describe(`canonical candidate liveness: ${writer}`,()=>{
 it('does not assign an operator-stopped resident despite fresh legacy presence',async()=>{
  fleetPresence('resident','stopped',0)
  expect(await run(writer)).toBe(0);expect(row().assignee_agent_id).toBeNull()
 })
 it('assigns a stale polling seat even when both legacy clocks have expired',async()=>{
  fleetPresence('poll','running',20*60*1000)
  h.sqlite.exec("UPDATE presence SET last_seen_at='2000-01-01 00:00:00'; UPDATE module_registry SET last_heartbeat='2000-01-01T00:00:00.000Z'")
  expect(await run(writer)).toBe(1);expect(row().assignee_agent_id).toBe(AGENT)
 })
 it('does not assign a dead resident even when legacy presence is fresh',async()=>{
  fleetPresence('resident','running',20*60*1000)
  expect(await run(writer)).toBe(0);expect(row().assignee_agent_id).toBeNull()
 })
 it('does not require an external heartbeat for an in-Worker agent',async()=>{
  h.sqlite.exec("UPDATE presence SET last_seen_at='2000-01-01 00:00:00'; UPDATE module_registry SET last_heartbeat='2000-01-01T00:00:00.000Z'")
  expect(await run(writer)).toBe(1);expect(row().assignee_agent_id).toBe(AGENT)
 })
 it('fences an operator stop arriving between selection and commit',async()=>{
  fleetPresence('resident','running',0)
  beforeClaim=()=>{h.sqlite.prepare("UPDATE fleet_agents SET status='stopped' WHERE tenant=? AND agent_id=?").run(TENANT,AGENT)}
  expect(await run(writer)).toBe(0);expect(claims).toBe(1);expect(row().assignee_agent_id).toBeNull()
 })
})
it('concierge respects an explicit offline registration even when polling is fresh',async()=>{
 fleetPresence('poll','running',0);h.sqlite.exec("UPDATE module_registry SET status='offline'")
 expect(await run('concierge')).toBe(0);expect(row().assignee_agent_id).toBeNull()
})
