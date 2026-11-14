// tests/boundary/read.test.ts — cross-squad READ. Customer A's agent and human, who hold nothing on squad B,
// ask for customer B's tasks, projects, memory, flights and messages by id. Each answer must be exactly the
// answer for an id that does not exist (no existence oracle), and every list is scoped to the caller's own
// squads. Positive controls prove the fixture is live: the same call on A's own data, and an org admin on B's.
// (The registry sweep in sweep.test.ts covers every tool; this file names the ones that matter and pins the
// refusal shape.)
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildBoundary, expectBoundary, leaksB, type Boundary } from './fixture'

let b: Boundary
beforeEach(async () => { b = await buildBoundary() })
afterEach(() => b.close())

describe('single-row reads answer a foreign id as a missing one', () => {
  // [tool, B's id, a nonexistent id, the exact code, B's legitimate reader (the one the guard expects)]
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>, string, 'ag-b' | 'ag-b2' | 'bob']> = [
    ['task_get', { task_id: 't-b' }, { task_id: 't-nope' }, 'task_not_found', 'ag-b'],
    ['project_get', { project_id: 'p-b' }, { project_id: 'p-nope' }, 'project_not_found', 'ag-b'],
    ['project_recall', { project_id: 'p-b', query: 'SECRET' }, { project_id: 'p-nope', query: 'SECRET' }, 'project_not_found', 'ag-b'],
    ['flight_get', { flight_id: 'f-b' }, { flight_id: 'f-nope' }, 'flight_not_found', 'ag-b'],
    // msg-b was sent TO ag-b FROM ag-b2; message_get answers its sender (ag-b2), not the recipient's other callers.
    ['message_get', { id: 'msg-b' }, { id: 'msg-nope' }, 'message_not_found', 'ag-b2'],
  ]
  it.each(cases)('%s', async (tool, foreign, missing, code, reader) => {
    const a = await b.attacker()
    const owner = reader === 'bob' ? await b.human('mem-b-human') : await b.agent(reader, reader === 'ag-b' ? 'mem-b-agent' : 'mem-b-agent2')
    const { intruder } = await expectBoundary(b, tool, foreign, { owner, intruder: a, code, status: 404 })
    // and the refusal is byte-identical to the answer for an id that does not exist (no existence oracle)
    const gone = await b.call(a, tool, missing)
    expect(intruder.status).toBe(gone.status)
    expect(intruder.error).toBe(gone.error)
  })

  it('control: the same calls on A\'s own data succeed', async () => {
    const a = await b.attacker()
    expect((await b.call(a, 'task_get', { task_id: 't-a' })).ok).toBe(true)
    expect((await b.call(a, 'project_get', { project_id: 'p-a' })).ok).toBe(true)
  })

  it('control: an org admin reads B\'s task (the refusals above are standing, not a broken fixture)', async () => {
    const admin = await b.human('mem-admin')
    const r = await b.call(admin, 'task_get', { task_id: 't-b' })
    expect(r.ok).toBe(true)
    expect(leaksB(r)).toBe(true)
  })
})

describe('lists show only the caller\'s squads', () => {
  it('task_list and task_board default to the caller\'s own squad', async () => {
    const a = await b.attacker()
    for (const tool of ['task_list', 'task_board']) {
      const r = await b.call(a, tool)
      expect(r.ok, tool).toBe(true)
      expect(leaksB(r), tool).toBe(false)
      expect(JSON.stringify(r), tool).toContain('t-a')
    }
  })

  it('naming squad B explicitly is refused (forbidden), for lists and boards; B\'s agent gets them', async () => {
    const a = await b.attacker()
    const own = await b.agent('ag-b', 'mem-b-agent')
    for (const [tool, args] of [['task_list', { squad_id: 'sq-b' }], ['task_board', { squad_id: 'sq-b' }], ['flight_list', { squad_id: 'sq-b' }], ['squad_member_list', { squad: 'sq-b' }]] as const) {
      await expectBoundary(b, tool, args, { owner: own, intruder: a, code: 'forbidden', status: 403 })
    }
  })

  it('a project_id filter to B\'s project, from A\'s squad, is project_not_found; the same filter on B\'s squad finds B\'s task', async () => {
    const a = await b.attacker()
    const r = await b.call(a, 'task_list', { squad_id: 'sq-a', project_id: 'p-b' })
    expect(r.ok, JSON.stringify(r)).toBe(false)
    expect(r.error).toBe('project_not_found')
    expect(leaksB(r)).toBe(false)
    const control = await b.call(await b.agent('ag-b', 'mem-b-agent'), 'task_list', { squad_id: 'sq-b', project_id: 'p-b' })
    expect(control.ok, JSON.stringify(control)).toBe(true)
    expect(leaksB(control), 'control: B\'s own filtered list must show B\'s task, else the empty answer above is vacuous').toBe(true)
  })

  it('project_list and kanban_board name no project or squad of B (the tenant-wide kanban selector leak is the it.fails in http-sweep)', async () => {
    const a = await b.attacker()
    for (const [tool, args] of [['project_list', {}], ['kanban_board', { squad_id: 'sq-b' }], ['kanban_board', {}]] as const) {
      const r = await b.call(a, tool, args)
      expect(r.ok, tool).toBe(true)
      expect(leaksB(r), tool).toBe(false)
    }
    // control: the same tools show B's names to B's own agent
    const own = await b.agent('ag-b', 'mem-b-agent')
    expect(leaksB(await b.call(own, 'project_list', {})), 'project_list control').toBe(true)
  })
})

describe('memory', () => {
  it('B\'s squad, project and member memory are refused to A with the exact code; B\'s own agent reads them', async () => {
    const a = await b.attacker()
    const own = await b.agent('ag-b', 'mem-b-agent')
    await expectBoundary(b, 'squad_recall', { squad_id: 'sq-b', query: 'SECRET' }, { owner: own, intruder: a, code: 'forbidden', status: 403 })
    await expectBoundary(b, 'project_recall', { project_id: 'p-b', query: 'SECRET' }, { owner: own, intruder: a, code: 'project_not_found', status: 404 })
    await expectBoundary(b, 'memory_get', { id: 'e-member' }, { owner: own, intruder: a, code: 'not_found', status: 404 })
    await expectBoundary(b, 'project_memory_get', { project_id: 'p-b', id: 'e-proj' }, { owner: own, intruder: a, code: 'not_found', status: 404 })
  })

  it('recall with no scope returns none of B\'s memory to A (a scoping probe: the vector index is stubbed, so the control is memory_get above)', async () => {
    const r = await b.call(await b.attacker(), 'recall', { query: 'SECRET' })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(leaksB(r)).toBe(false)
  })

  it('control: a member of B passes the grant gate on B\'s squad memory', async () => {
    const bob = await b.human('mem-b-human')
    const r = await b.call(bob, 'squad_recall', { squad_id: 'sq-b', query: 'SECRET' })
    expect(r.ok, JSON.stringify(r)).toBe(true)
  })
})

describe('orientation reads', () => {
  it('orient, status and fleet_agent_get of a B agent are refused (forbidden); B\'s agent gets them; peers omits B', async () => {
    const a = await b.attacker()
    const own = await b.agent('ag-b', 'mem-b-agent')
    for (const [tool, args] of [['orient', { agent: 'b-bot' }], ['status', { agent_id: 'ag-b' }], ['fleet_agent_get', { agent_id: 'ag-b' }]] as const) {
      await expectBoundary(b, tool, args, { owner: own, intruder: a, code: 'forbidden', status: 403 })
    }
    const peers = await b.call(a, 'peers')
    expect(peers.ok).toBe(true)
    expect(leaksB(peers)).toBe(false)
    expect(JSON.stringify(peers)).toContain('ag-a2')
    expect(JSON.stringify(await b.call(own, 'peers'))).toContain('ag-b2')
  })
})
