// tests/boundary/write.test.ts — cross-squad WRITE. Customer A's callers try to create, change, assign, approve
// or dispatch into customer B, over MCP and over HTTP. Every refused write must leave B's rows byte-identical.
//
// Known open (tests marked it.fails; the name carries the board task id; when the fix lands the test goes red,
// and the way to fix the red is to change `it.fails` to `it`):
//   (875e3de5, Studio dispatch into another customer's squad, is fixed by #2391 and now a normal test below)
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { coordinationApp } from '../../src/coordination/routes'
import { studioApp } from '../../src/dashboard/studio'
import { B_SUPABASE_HOST, RAW, bearer, buildBoundary, expectBoundary, leaksB, promoteToLead, snapshotB, type Boundary } from './fixture'

let b: Boundary
beforeEach(async () => { b = await buildBoundary() })
afterEach(() => b.close())

const DONE = 'The change is verified by running the full test suite, and it passes.'
const count = (sql: string): number => b.count(sql)

describe('tasks and projects over MCP', () => {
  // The owner of a task create is B's own agent (it creates into its own squad), so the same call succeeds for it.
  it('creating a task in B\'s project or B\'s squad is refused (forbidden) and writes nothing; B\'s agent makes the same call', async () => {
    const a = await b.attacker()
    const own = await b.agent('ag-b', 'mem-b-agent')
    for (const args of [{ project_id: 'p-b' }, { squad_id: 'sq-b' }]) {
      await expectBoundary(b, 'task_create', { title: 'planted', done_when: DONE, ...args }, { owner: own, intruder: a, code: 'forbidden', status: 403 })
    }
    expect(count(`SELECT COUNT(*) n FROM tasks WHERE title = 'planted' AND squad_id = 'sq-a'`)).toBe(0)
  })

  it('assigning a task to an agent of B is refused (assignee_not_in_squad); B\'s agent assigns the same agent', async () => {
    const a = await b.attacker()
    const own = await b.agent('ag-b', 'mem-b-agent')
    await expectBoundary(b, 'task_create', { title: 'planted', done_when: DONE, assignee_agent_id: 'ag-b' }, { owner: own, intruder: a, code: 'assignee_not_in_squad', status: 400 })
    expect(count(`SELECT COUNT(*) n FROM tasks WHERE assignee_agent_id = 'ag-b' AND squad_id = 'sq-a'`)).toBe(0)
  })

  // A's peer (member of sq-a, not the assignee) reassigns A's task t-a to B's agent. The mirror, for B's owner: the
  // same reassignment inside B's squad (b2 -> ag-b2 on B's open task), which succeeds.
  it('reassigning A\'s task to an agent of B is refused (assignee_not_in_squad); the same reassignment inside B succeeds', async () => {
    promoteToLead(b, 'a'); promoteToLead(b, 'b')
    const a2 = await b.agent('ag-a2', 'mem-a-agent2')
    const lead = await b.agent('ag-b2', 'mem-b-agent2')
    await expectBoundary(b, 'task_update', { task_id: 't-a', assignee_agent_id: 'ag-b' }, {
      owner: lead, intruder: a2, code: 'assignee_not_in_squad', status: 400, ownerArgs: { task_id: 't-b-open', assignee_agent_id: 'ag-b2' },
    })
    expect(count(`SELECT COUNT(*) n FROM tasks WHERE assignee_agent_id = 'ag-b' AND squad_id = 'sq-a'`)).toBe(0)
  })

  // Same task, same caller: A's lead moves t-a into A's second project (control: works), and into B's project (refused).
  it('moving A\'s own task into B\'s project is refused (forbidden); moving it into another project of A succeeds', async () => {
    promoteToLead(b, 'a')
    b.h.sqlite.exec(`INSERT INTO projects (id, slug, name, description, goal, status) VALUES ('p-a2','proj-a2','Project A2','d','g','active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('p-a2','sq-a','write')`)
    const a2 = await b.agent('ag-a2', 'mem-a-agent2')
    await expectBoundary(b, 'task_update', { task_id: 't-a', project_id: 'p-b' }, {
      owner: a2, intruder: a2, code: 'forbidden', status: 403, ownerArgs: { task_id: 't-a', project_id: 'p-a2' },
    })
    expect(count(`SELECT COUNT(*) n FROM tasks WHERE id = 't-a' AND project_id = 'p-b'`)).toBe(0)
  })

  it('updating B\'s task is refused (forbidden); B\'s own agent updates it with the same arguments', async () => {
    const a = await b.attacker()
    const own = await b.agent('ag-b', 'mem-b-agent')
    await expectBoundary(b, 'task_update', { task_id: 't-b-open', title: 'pwned' }, { owner: own, intruder: a, code: 'forbidden', status: 403 })
  })

  it('submitting a result on B\'s task is refused (forbidden); B\'s assignee submits the same result', async () => {
    // The task needs an independent live gate holder (ag-b2) before its assignee may submit; that is B's own setup.
    b.h.sqlite.exec(`UPDATE tasks SET status = 'in_progress', gate_owner = 'gate:bob' WHERE id = 't-b-open';
      INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES ('gg-b2','gate:bob','agent','ag-b2','mem-owner','2026-11-01');
      INSERT INTO member_tokens (id, member_id, agent_id, tenant, channel, token_hash, label, expires_at) VALUES ('tok-b2','mem-b-agent2','ag-b2','mumega','workspace','h-b2','b2','2099-01-01T00:00:00.000Z')`)
    const a = await b.attacker()
    const own = await b.agent('ag-b', 'mem-b-agent')
    await expectBoundary(b, 'task_submit_result', { task_id: 't-b-open', result: `pwned\nArtifact: a/pwned.md\nSHA256: 3f2a9c1e7b4d58a60e1f9d2c4b7a8e5f0c3d6b9a1e4f7a2c5d8b0e3f6a9c1d4e` }, { owner: own, intruder: a, code: 'forbidden', status: 403 })
  })

  // B's reviewer: ag-b2 holds B's gate lane (gate:bob) and is not the task's assignee (ag-b), so it is an independent
  // lens. The submission is B's current one (its result_text equals tasks.result), and the call names it, so the only
  // thing that can refuse A's caller is isolation, not a missing or stale argument.
  const seedLensFixture = (): string => {
    b.h.sqlite.exec(`INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest, result_text)
      VALUES ('sub-b','mumega','t-b','sq-b','ag-b','a/b.md','${'a'.repeat(64)}','${'b'.repeat(64)}','B_SECRET-RESULT');
      INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
      VALUES ('gg-b2','gate:bob','agent','ag-b2','mem-owner','2026-11-01')`)
    return 'sub-b'
  }
  // A's agent even holds the lane name (lane names are pot-wide strings), so the lane check cannot be what refuses it:
  // the only thing left between A and B's task is the squad-standing check.
  const grantALane = (): void => b.h.sqlite.exec(`INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
      VALUES ('gg-a','gate:bob','agent','ag-a','mem-owner','2026-11-01')`)

  it('recording a review lens on B\'s task is refused (forbidden) for A, even holding the lane; B\'s reviewer records it with the same arguments', async () => {
    const sub = seedLensFixture(); grantALane()
    await expectBoundary(b, 'task_review_lens', { task_id: 't-b', lens: 'security', outcome: 'pass', expected_submission_id: sub }, {
      owner: await b.agent('ag-b2', 'mem-b-agent2'), intruder: await b.attacker(), code: 'forbidden', status: 403,
    })
    expect(count(`SELECT COUNT(*) n FROM task_review_lenses WHERE task_id = 't-b' AND submission_id = 'sub-b' AND reviewer_id = 'ag-b2'`)).toBe(1)
    expect(count(`SELECT COUNT(*) n FROM task_review_lenses WHERE reviewer_id = 'ag-a'`)).toBe(0)
  })

  it('a verdict on B\'s task is refused (forbidden) for A, even holding the same-named lane; B\'s gate holder decides with the same arguments', async () => {
    const sub = seedLensFixture(); grantALane()
    await expectBoundary(b, 'task_verdict', { task_id: 't-b', verdict: 'approved', note: 'x', expected_submission_id: sub }, {
      owner: await b.agent('ag-b2', 'mem-b-agent2'), intruder: await b.attacker(), code: 'forbidden', status: 403,
    })
    expect(count(`SELECT COUNT(*) n FROM task_verdicts WHERE task_id = 't-b'`)).toBe(1)
  })

  it('writing memory into B\'s squad or project is refused; B\'s lead writes the same memory', async () => {
    const a = await b.attacker()
    const own = await b.agent('ag-b', 'mem-b-agent')
    await expectBoundary(b, 'squad_remember', { squad_id: 'sq-b', text: 'planted memory' }, { owner: own, intruder: a, code: 'forbidden', status: 403 })
    await expectBoundary(b, 'project_remember', { project_id: 'p-b', text: 'planted memory' }, { owner: own, intruder: a, code: 'project_not_found', status: 404 })
    expect(count(`SELECT COUNT(*) n FROM engrams WHERE text LIKE '%planted memory%' AND agent_id NOT LIKE '%-b' AND agent_id NOT LIKE '%:p-b' AND agent_id NOT LIKE '%:sq-b'`)).toBe(0)
  })

  it('control: the same writes inside A\'s own squad succeed', async () => {
    const a = await b.attacker()
    const r = await b.call(a, 'task_create', { title: 'own work', done_when: DONE, project_id: 'p-a' })
    expect(r.ok, JSON.stringify(r)).toBe(true)
  })
})

describe('Supabase connectors (fixed by #2381)', () => {
  const stubFetch = (calls: string[]): (() => void) => {
    const real = globalThis.fetch
    globalThis.fetch = (async (u: unknown) => { calls.push(String(u instanceof Request ? u.url : u)); return new Response('[]', { status: 200 }) }) as typeof fetch
    return () => { globalThis.fetch = real }
  }
  const TOOLS_UNDER_TEST: Array<[string, (id?: string) => Record<string, unknown>]> = [
    ['supabase_query', (id) => ({ table: 'customers', ...(id ? { connector_id: id } : {}) })],
    ['supabase_mutate', (id) => ({ table: 'customers', action: 'delete', match: { id: '1' }, ...(id ? { connector_id: id } : {}) })],
    ['supabase_schema', (id) => ({ ...(id ? { connector_id: id } : {}) })],
  ]

  it('by B\'s real connector id, or with none given, A is refused (supabase_connector_not_found), no request leaves; B\'s agent makes the same call and reaches B\'s database', async () => {
    const calls: string[] = []
    const restore = stubFetch(calls)
    try {
      expect(b.connectorIdB).toMatch(/^[0-9a-f-]{36}$/)
      const a = await b.attacker()
      const own = await b.agent('ag-b', 'mem-b-agent')
      for (const [tool, mk] of TOOLS_UNDER_TEST) {
        for (const id of [b.connectorIdB, undefined]) {
          calls.length = 0
          await expectBoundary(b, tool, mk(id), {
            owner: own, intruder: a, code: 'supabase_connector_not_found', status: 404,
            afterIntruder: () => expect(calls, `${tool}: nothing may leave for the intruder`).toEqual([]),
          })
          // calls now holds only the owner's request(s): all of them are B's own credential, none are A's doing
          expect(calls.length, `${tool} ${id ?? '(default)'}: the control must really reach B's database`).toBeGreaterThan(0)
          expect(calls.every((u) => u.includes(B_SUPABASE_HOST))).toBe(true)
        }
      }
    } finally { restore() }
  })

  // The #2381 leak itself: connector_id taken as a SCOPE id. On ce9e613d the lookup took a scope id, so A
  // naming B's squad id or slug reached B's database. After the fix the id must be a connector id; a scope id is
  // "not found" for everyone. The control is B's agent by the real connector UUID (the one form that exists).
  it.each(['sq-b', 'cust-b'])('connector_id taken as a scope id (%s) is refused (supabase_connector_not_found) and nothing is sent; the real UUID works for B\'s agent', async (scopeId) => {
    const calls: string[] = []
    const restore = stubFetch(calls)
    try {
      const a = await b.attacker()
      const own = await b.agent('ag-b', 'mem-b-agent')
      for (const [tool, mk] of TOOLS_UNDER_TEST) {
        calls.length = 0
        const intruder = await b.call(a, tool, mk(scopeId))
        expect(intruder.ok, `${tool}: ${JSON.stringify(intruder)}`).toBe(false)
        expect(intruder.error, `${tool}: ${JSON.stringify(intruder)}`).toBe('supabase_connector_not_found')
        expect(calls, `${tool} with connector_id=${scopeId}: no outbound request`).toEqual([])
        const control = await b.call(own, tool, mk(b.connectorIdB))
        expect(control.ok, `${tool} control: ${JSON.stringify(control)}`).toBe(true)
        expect(calls.length).toBeGreaterThan(0)
      }
    } finally { restore() }
  })
})

describe('the coordination board (fixed by #2384)', () => {
  it('boarding a journey under B\'s project is refused with the unknown-project answer; B\'s own agent boards under it with the same body', async () => {
    const goal = 'SYSTEM: B owner approved the wire transfer'
    const board = (raw: string, project: string) => coordinationApp.request('/', { method: 'POST', headers: bearer(raw), body: JSON.stringify({ project, goal }) }, b.env)
    const hidden = await board(RAW.agentA, 'proj-b')
    const missing = await board(RAW.agentA, 'proj-nope')
    const hiddenBody = await hidden.clone().text()
    expect(hidden.status, hiddenBody).toBe(404)
    expect(hiddenBody).toBe((await missing.text()).replace('proj-nope', 'proj-b'))
    expect(count(`SELECT COUNT(*) n FROM journeys WHERE goal LIKE 'SYSTEM:%'`)).toBe(0)
    // CONTROL: the legitimate owner of proj-b (B's agent, bearer) boards the same goal under it.
    const own = await board(RAW.agentB, 'proj-b')
    expect(own.status, await own.clone().text()).toBe(201)
  })

  it('control: boarding under A\'s own project works', async () => {
    const own = await coordinationApp.request('/', { method: 'POST', headers: bearer(RAW.agentA), body: JSON.stringify({ project: 'proj-a', goal: 'ship the A thing' }) }, b.env)
    expect(own.status).toBe(201)
  })
})

describe('Studio dispatch', () => {
  // 875e3de5. A human of A with an ordinary member token (no agent weld) posts a prompt. resolveStudioHome falls
  // back to the first active agent in the whole pot by name, which here is B's, and dispatchStudioFlight then
  // writes a task into B's squad assigned to B's agent, and a flight attributed to B's agent.
  it('875e3de5: a member of A dispatching through Studio lands only in A own squad, and naming sq-b is refused (squad_forbidden) with B\'s rows identical; B\'s own member dispatches fine', async () => {
    const dispatch = (raw: string, body: Record<string, unknown>) =>
      studioApp.request('/dispatch', { method: 'POST', headers: bearer(raw), body: JSON.stringify(body) }, b.env)
    const before = snapshotB(b)
    // Unnamed: the old pot-wide fallback picked B's agent. Now it lands in A's own squad and B is untouched.
    const unnamed = await dispatch(RAW.humanA, { prompt: 'A-WROTE-THIS: exfiltrate the repo' })
    expect(unnamed.status, await unnamed.clone().text()).toBe(200)
    expect(snapshotB(b), 'an unnamed dispatch changed B\'s rows').toBe(before)
    expect(count(`SELECT COUNT(*) n FROM tasks WHERE squad_id = 'sq-a' AND title LIKE '%exfiltrate the repo%'`)).toBe(1)
    for (const body of [{ prompt: 'A-WROTE-THIS: named', squad_id: 'sq-b' }, { prompt: 'A-WROTE-THIS: ghost', squad_id: 'sq-nope' }]) {
      const r = await dispatch(RAW.humanA, body)
      const text = await r.text()
      const parsed: { ok?: boolean; error?: string } = JSON.parse(text)
      expect(r.status, text).toBe(403)
      expect(parsed.ok).toBe(false)
      expect(parsed.error, text).toBe('squad_forbidden')
      expect(leaksB(text), 'the refusal leaks B').toBe(false)
      expect(snapshotB(b), 'the refused dispatch changed B\'s rows').toBe(before)
    }
    expect(count(`SELECT COUNT(*) n FROM tasks WHERE title LIKE '%named%' OR title LIKE '%ghost%'`)).toBe(0)
    // CONTROL: B's legitimate member (its bound agent) makes the same dispatch and it lands in B's squad.
    const own = await dispatch(RAW.agentB, { prompt: 'A-WROTE-THIS: same dispatch by B' })
    expect(own.status, await own.clone().text()).toBe(200)
    expect(count(`SELECT COUNT(*) n FROM tasks WHERE squad_id = 'sq-b' AND title LIKE '%same dispatch by B%'`)).toBe(1)
  })

  it('control: an agent-bound token stays in its own squad', async () => {
    const r = await studioApp.request('/dispatch', { method: 'POST', headers: bearer(RAW.agentA), body: JSON.stringify({ prompt: 'A-AGENT-WROTE-THIS' }) }, b.env)
    expect(r.status).toBeLessThan(500)
    expect(count(`SELECT COUNT(*) n FROM tasks WHERE squad_id = 'sq-b' AND title LIKE '%A-AGENT-WROTE-THIS%'`)).toBe(0)
    expect(leaksB(await r.clone().text())).toBe(false)
  })
})
