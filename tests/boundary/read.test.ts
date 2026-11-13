// tests/boundary/read.test.ts — cross-squad READ. Customer A's agent and human, who hold nothing on squad B,
// ask for customer B's tasks, projects, memory, flights and messages by id. Each answer must be exactly the
// answer for an id that does not exist (no existence oracle), and every list is scoped to the caller's own
// squads. Positive controls prove the fixture is live: the same call on A's own data, and an org admin on B's.
// (The registry sweep in sweep.test.ts covers every tool; this file names the ones that matter and pins the
// refusal shape.)
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildBoundary, leaksB, type Boundary } from './fixture'

let b: Boundary
beforeEach(async () => { b = await buildBoundary() })
afterEach(() => b.close())

describe('single-row reads answer a foreign id as a missing one', () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ['task_get', { task_id: 't-b' }, { task_id: 't-nope' }],
    ['project_get', { project_id: 'p-b' }, { project_id: 'p-nope' }],
    ['project_recall', { project_id: 'p-b', query: 'SECRET' }, { project_id: 'p-nope', query: 'SECRET' }],
    ['flight_get', { flight_id: 'f-b' }, { flight_id: 'f-nope' }],
    ['message_get', { id: 'msg-b' }, { id: 'msg-nope' }],
  ]
  it.each(cases)('%s', async (tool, foreign, missing) => {
    const a = await b.attacker()
    const hidden = await b.call(a, tool, foreign)
    const gone = await b.call(a, tool, missing)
    expect(hidden.ok).toBe(false)
    expect(hidden.status).toBe(gone.status)
    expect(hidden.error).toBe(gone.error)
    expect(leaksB(hidden)).toBe(false)
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

  it('naming squad B explicitly is refused, for lists and boards', async () => {
    const a = await b.attacker()
    for (const [tool, args] of [['task_list', { squad_id: 'sq-b' }], ['task_board', { squad_id: 'sq-b' }], ['flight_list', { squad_id: 'sq-b' }], ['squad_member_list', { squad: 'sq-b' }]] as const) {
      const r = await b.call(a, tool, args)
      expect(r.ok, tool).toBe(false)
      expect(r.status, tool).toBe(403)
      expect(leaksB(r), tool).toBe(false)
    }
  })

  it('a project_id filter to B\'s project, from A\'s squad, finds nothing', async () => {
    const a = await b.attacker()
    const r = await b.call(a, 'task_list', { squad_id: 'sq-a', project_id: 'p-b' })
    expect(leaksB(r)).toBe(false)
    expect((r.result as { tasks?: unknown[] } | undefined)?.tasks ?? []).toEqual([])
  })

  it('project_list and kanban_board name no project or squad of B', async () => {
    const a = await b.attacker()
    for (const [tool, args] of [['project_list', {}], ['kanban_board', { squad_id: 'sq-b' }], ['kanban_board', {}]] as const) {
      expect(leaksB(await b.call(a, tool, args)), tool).toBe(false)
    }
  })
})

describe('memory', () => {
  it('squad, project and member memory of B are not recallable from A', async () => {
    const a = await b.attacker()
    for (const [tool, args] of [
      ['squad_recall', { squad_id: 'sq-b', query: 'SECRET' }],
      ['project_recall', { project_id: 'p-b', query: 'SECRET' }],
      ['recall', { query: 'SECRET' }],
      ['memory_get', { id: 'e-member' }],
      ['project_memory_get', { id: 'e-proj' }],
    ] as const) {
      const r = await b.call(a, tool, args)
      expect(leaksB(r), tool).toBe(false)
    }
  })

  it('control: a member of B passes the grant gate on B\'s squad memory (vector search is stubbed, so only the gate is asserted)', async () => {
    const bob = await b.human('mem-b-human')
    const r = await b.call(bob, 'squad_recall', { squad_id: 'sq-b', query: 'SECRET' })
    expect(r.status).not.toBe(403)
  })
})

describe('orientation reads', () => {
  it('orient, status and peers refuse or omit a foreign agent', async () => {
    const a = await b.attacker()
    for (const [tool, args] of [['orient', { agent: 'b-bot' }], ['status', { agent_id: 'ag-b' }], ['fleet_agent_get', { agent_id: 'ag-b' }]] as const) {
      const r = await b.call(a, tool, args)
      expect(r.ok, tool).toBe(false)
      expect(leaksB(r), tool).toBe(false)
    }
    const peers = await b.call(a, 'peers')
    expect(peers.ok).toBe(true)
    expect(leaksB(peers)).toBe(false)
    expect(JSON.stringify(peers)).toContain('ag-a2')
  })
})
