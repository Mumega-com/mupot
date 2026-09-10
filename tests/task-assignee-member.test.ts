// tests/task-assignee-member.test.ts — a task can be owned by a HUMAN.
//
// squad-core P0 676ae5db: "Tasks can only be assigned to AGENTS, not humans — no
// assignee_member_id (Hadi can't own a task)."
//
// Why this is a P0 and not a nice-to-have. `tasks.assignee_agent_id REFERENCES
// agents(id)` was the only ownership column the table had, so anything that
// genuinely needed a person — a browser click, a credential decision, an approval —
// could only live as prose inside some agent's task body, where no query finds it
// and no lane surfaces it. Meanwhile agents cannot redistribute among themselves:
// an agent may not change the assignee on its own in_progress task
// (assignee_cannot_mutate_own_assignment) and cannot grant capability at all on the
// MCP plane (mupot#1357). Every redistribution therefore terminates at a human who
// could not be named as the owner of the thing being redistributed.
//
// These tests run against the REAL migration chain (helpers/migrations), never a
// hand-written fixture — a hand-written schema would happily contain the column
// whether or not migrations/0150 ships it.

import { describe, expect, it } from 'vitest'
import { resolveTaskAssignee, resolveTaskAssigneeMember } from '../src/tasks/assignee'
import { createTask } from '../src/tasks/service'
import { invokeTool } from '../src/mcp'
import { runTaskExecution } from '../src/agents/execute'
import { TASK_SELECT_COLUMNS } from '../src/tasks/ranking'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const DEPT = 'dept-eng'
const SQUAD = 'squad-core'
const OTHER_SQUAD = 'squad-elsewhere'
const HUMAN = 'mem-hadi'
const OUTSIDER = 'mem-outsider'
const SUSPENDED = 'mem-gone'
const AGENT = 'agent-kasra'

function harness(): { h: SqliteD1Harness; env: Env } {
  const h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('${DEPT}', 'eng', 'Engineering');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('${SQUAD}', '${DEPT}', 'core', 'Core'),
      ('${OTHER_SQUAD}', '${DEPT}', 'elsewhere', 'Elsewhere');
    INSERT INTO members (id, email, display_name, status) VALUES
      ('${HUMAN}', 'hadi@mumega.com', 'Hadi', 'active'),
      ('${OUTSIDER}', 'nobody@x.test', 'Outsider', 'active'),
      ('${SUSPENDED}', 'gone@x.test', 'Gone', 'suspended');
    INSERT INTO capabilities (member_id, scope_type, scope_id, capability) VALUES
      ('${HUMAN}', 'squad', '${SQUAD}', 'admin'),
      ('${SUSPENDED}', 'squad', '${SQUAD}', 'admin');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES
      ('${AGENT}', '${SQUAD}', 'kasra', 'Kasra', 'active');
  `)
  return { h, env: { DB: h.db, TENANT_SLUG: 'mumega' } as unknown as Env }
}

describe('migrations/0150 — the tasks table has a human ownership axis', () => {
  it('assignee_member_id exists and is nullable', async () => {
    const { h } = harness()
    try {
      const cols = h.sqlite.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string; notnull: number }>
      const col = cols.find((c) => c.name === 'assignee_member_id')
      expect(col, 'migrations/0150 did not add assignee_member_id').toBeDefined()
      // Nullable is load-bearing: 25 of 40 open tasks were unassigned when this
      // shipped, and both-null is the normal state, not an error.
      expect(col?.notnull).toBe(0)
    } finally {
      h.sqlite.close()
    }
  })

  it('the DB REFUSES a row that names two owners — on insert AND on update', () => {
    const { h } = harness()
    try {
      h.sqlite.exec(`
        INSERT INTO tasks (id, squad_id, title, body, status, done_when)
        VALUES ('t-ok', '${SQUAD}', 'one owner', '', 'open', 'pred');
      `)

      expect(() =>
        h.sqlite.exec(`
          INSERT INTO tasks (id, squad_id, title, body, status, done_when, assignee_agent_id, assignee_member_id)
          VALUES ('t-two', '${SQUAD}', 'two owners', '', 'open', 'pred', '${AGENT}', '${HUMAN}');
        `),
      ).toThrow(/task_single_assignee/)

      // The UPDATE trigger is a SEPARATE trigger and needs its own proof: a row
      // may be written legally with one owner and then have the second added.
      h.sqlite.exec(`UPDATE tasks SET assignee_agent_id = '${AGENT}' WHERE id = 't-ok';`)
      expect(() =>
        h.sqlite.exec(`UPDATE tasks SET assignee_member_id = '${HUMAN}' WHERE id = 't-ok';`),
      ).toThrow(/task_single_assignee/)
    } finally {
      h.sqlite.close()
    }
  })

  it('both-null stays legal — unassigned is a real state, not a violation', () => {
    const { h } = harness()
    try {
      expect(() =>
        h.sqlite.exec(`
          INSERT INTO tasks (id, squad_id, title, body, status, done_when)
          VALUES ('t-none', '${SQUAD}', 'nobody yet', '', 'open', 'pred');
        `),
      ).not.toThrow()
    } finally {
      h.sqlite.close()
    }
  })
})

describe('resolveTaskAssigneeMember — the human axis, same bar as the agent axis', () => {
  it('accepts a member holding member+ on the task squad', async () => {
    const { h, env } = harness()
    try {
      expect(await resolveTaskAssigneeMember(env, HUMAN, SQUAD)).toEqual({ value: HUMAN })
    } finally {
      h.sqlite.close()
    }
  })

  it('refuses a member with NO grant on that squad — assignment is not a visibility side channel', async () => {
    const { h, env } = harness()
    try {
      const out = await resolveTaskAssigneeMember(env, OUTSIDER, SQUAD)
      expect(out.value).toBeNull()
      expect(out.error).toBe('assignee_not_in_squad')
    } finally {
      h.sqlite.close()
    }
  })

  it('refuses a SUSPENDED member even though the grant row survives', async () => {
    // The grant row is deliberately present in the fixture. A revoked colleague
    // whose capabilities were never cleaned up must not keep receiving work.
    const { h, env } = harness()
    try {
      const out = await resolveTaskAssigneeMember(env, SUSPENDED, SQUAD)
      expect(out.value).toBeNull()
      expect(out.error).toBe('assignee_not_in_squad')
    } finally {
      h.sqlite.close()
    }
  })

  it('distinguishes a WRONG id from a real id that may not hold the work', async () => {
    // Collapsing these would make a typo and a revoked colleague look identical
    // to whoever is trying to hand off.
    const { h, env } = harness()
    try {
      expect((await resolveTaskAssigneeMember(env, 'no-such-member', SQUAD)).error).toBe('invalid_assignee')
      expect((await resolveTaskAssigneeMember(env, OUTSIDER, SQUAD)).error).toBe('assignee_not_in_squad')
    } finally {
      h.sqlite.close()
    }
  })

  it('a grant on ANOTHER squad does not carry', async () => {
    const { h, env } = harness()
    try {
      const out = await resolveTaskAssigneeMember(env, HUMAN, OTHER_SQUAD)
      expect(out.value).toBeNull()
      expect(out.error).toBe('assignee_not_in_squad')
    } finally {
      h.sqlite.close()
    }
  })

  it('a DEPARTMENT grant inherits down, exactly as the agent axis does', async () => {
    const { h, env } = harness()
    try {
      h.sqlite.exec(
        `INSERT INTO capabilities (member_id, scope_type, scope_id, capability) VALUES ('${OUTSIDER}', 'department', '${DEPT}', 'member');`,
      )
      expect(await resolveTaskAssigneeMember(env, OUTSIDER, SQUAD)).toEqual({ value: OUTSIDER })
    } finally {
      h.sqlite.close()
    }
  })

  it('absent is not an error — omitting an owner leaves the task unassigned', async () => {
    const { h, env } = harness()
    try {
      expect(await resolveTaskAssigneeMember(env, undefined, SQUAD)).toEqual({ value: null })
      expect(await resolveTaskAssigneeMember(env, null, SQUAD)).toEqual({ value: null })
    } finally {
      h.sqlite.close()
    }
  })

  it('POSITIVE CONTROL — the agent axis still resolves, so the refusals above are not a dead harness', async () => {
    // Without this, every assertion in this describe would also pass against an
    // env whose DB simply returned nothing for every query.
    const { h, env } = harness()
    try {
      expect(await resolveTaskAssignee(env, AGENT, SQUAD)).toEqual({ value: AGENT })
    } finally {
      h.sqlite.close()
    }
  })
})

describe('createTask — a human owner persists, and cannot be forged from outside', () => {
  it('writes assignee_member_id and leaves the agent axis null', async () => {
    const { h, env } = harness()
    try {
      const task = await createTask(env, {
        squad_id: SQUAD,
        title: 'grant cairn lead on the MCPWP squad',
        done_when: 'cairn holds lead on that squad',
        assignee_member_id: HUMAN,
      }, { skipEvent: true })

      expect(task.assignee_member_id).toBe(HUMAN)
      expect(task.assignee_agent_id).toBeNull()

      const row = h.sqlite
        .prepare('SELECT assignee_member_id, assignee_agent_id FROM tasks WHERE id = ?')
        .get(task.id) as { assignee_member_id: string | null; assignee_agent_id: string | null }
      // Read it back from the table, not from the returned object: the object is
      // what we intended, the row is what actually landed.
      expect(row.assignee_member_id).toBe(HUMAN)
      expect(row.assignee_agent_id).toBeNull()
    } finally {
      h.sqlite.close()
    }
  })

  it('an EXTERNAL-source task cannot arrive pre-assigned to a human', async () => {
    // Parity with the PR #659 P0 clamp on the agent axis. An external-origin task
    // that arrives pre-assigned skips every gate: the unassigned-auto-pickup check
    // does not apply once an owner is set, and the admin-gated reassignment check
    // only fires on a LATER update, never on the create. On the human axis it would
    // be worse — an attacker-editable external field could put fabricated work
    // under a NAMED PERSON's ownership, which is exactly what a reviewer reads as
    // provenance.
    const { h, env } = harness()
    try {
      const task = await createTask(env, {
        squad_id: SQUAD,
        title: 'from a linear webhook',
        done_when: 'the row is written and readable',
        assignee_member_id: HUMAN,
      }, { skipEvent: true, externalSource: 'linear' })

      expect(task.assignee_member_id).toBeNull()

      const row = h.sqlite
        .prepare('SELECT assignee_member_id FROM tasks WHERE id = ?')
        .get(task.id) as { assignee_member_id: string | null }
      expect(row.assignee_member_id).toBeNull()
    } finally {
      h.sqlite.close()
    }
  })

  it('POSITIVE CONTROL — the same create WITHOUT an external marker does keep the human owner', async () => {
    // Proves the assertion above measures the clamp and not a broken write path.
    const { h, env } = harness()
    try {
      const task = await createTask(env, {
        squad_id: SQUAD,
        title: 'first-party',
        done_when: 'the row is written and readable',
        assignee_member_id: HUMAN,
      }, { skipEvent: true })
      expect(task.assignee_member_id).toBe(HUMAN)
    } finally {
      h.sqlite.close()
    }
  })
})

describe('every reader knows the member axis exists — gate BLOCK on PR #1373', () => {
  // MUTATION NOTE, recorded because it nearly misled me. Each defect below is guarded at
  // TWO layers, and reverting ONE layer does NOT turn the corresponding test red — the
  // other layer rescues it into a graceful refusal. Only reverting BOTH (the true
  // pre-fix state) fails:
  //
  //   B1  concierge SELECT alone reverted    -> still green (UPDATE guard -> changes=0, skip)
  //       concierge SELECT + UPDATE reverted -> RED, "stalled the router"
  //   B2  pickup guard alone reverted        -> still green (claim WHERE -> changes=0, false)
  //       pickup guard + claim WHERE reverted-> RED, the model ran on a human-owned task
  //   B3  projection column reverted         -> RED on its own (single layer, by nature)
  //
  // The first reading of that is "the tests are weak". The correct reading, sharpened by
  // the gate: single-layer green is the EXPECTED SIGNATURE OF CHECK-THEN-ENFORCE, not
  // evidence of redundancy. Each layer justifies itself by its FAILURE MODE rather than by
  // test colour:
  //   - concierge SELECT filter: without it the LIMIT window is burned on unroutable rows
  //     every tick and doomed writes are re-attempted;
  //   - concierge UPDATE guard: without it the read-to-write race reopens as a THROW;
  //   - pickup check: without it every encounter with a member-owned task is an exception
  //     instead of a refusal;
  //   - claim WHERE: without it that race reopens as a throw too.
  // The pairs match this repo's established shape — floor plus handler, chokepoint plus
  // trigger. When mutating a layered fix, mutate the LAYER SET, not one line.

  // Found by the hermes seat gating this PR. The four things I asked it to attack were
  // all clean; the block was what they did not cover — NOTHING THAT READS TASKS KNEW
  // THE MEMBER AXIS EXISTED. Adding an ownership column silently changed the meaning
  // of every pre-existing `assignee_agent_id IS NULL`, which used to mean "unassigned"
  // and now means "not owned by an AGENT". Each such site had to be re-read, not just
  // the ones this PR touched.

  it('B3: TASK_SELECT_COLUMNS carries the member axis', () => {
    // This is the projection every downstream reader is built from — dashboard board,
    // MCP task_list, IM reads, routines. Two failures follow from omitting it, and the
    // second is silent data loss rather than a wrong render:
    //   - the board shows a human-owned task as UNASSIGNED, which is precisely the
    //     invisibility this column was added to end;
    //   - routines/actions.ts spread-loads a Task and persists it back, so a column
    //     absent from the projection is written back as NULL, stripping the human
    //     owner. The one-owner trigger cannot catch that: NULL is legal.
    // A string assertion is crude, and deliberately so — it is the same instrument as
    // the positional bind assertion in mcp-task-tools: brittle on purpose, because the
    // failure it guards is silent.
    expect(TASK_SELECT_COLUMNS).toContain('assignee_member_id')
  })

  it('B2: an agent will not pick up a task owned by a human', async () => {
    const { h, env } = harness()
    try {
      const task = await createTask(env, {
        squad_id: SQUAD,
        title: 'needs an authenticated browser session',
        done_when: 'the owner mints a seat through the enrollment page',
        assignee_member_id: HUMAN,
      }, { skipEvent: true })

      const agent = {
        id: AGENT, squad_id: SQUAD, slug: 'kasra', name: 'Kasra',
        role: null, model: null, status: 'active', created_at: 'now',
      }
      const model = { chat: async () => 'this must never run' }
      let chatCalls = 0
      const countingModel = { chat: async (...args: unknown[]) => { chatCalls += 1; return model.chat(args) } }

      const r = await runTaskExecution(env, agent as never, task.id, {
        model: countingModel as never,
        emit: async () => {},
      })

      // Refused, and refused BEFORE the model is reached. Reaching the model would mean
      // the pickup decision had already been made and only the write failed.
      expect(r.ok).toBe(false)
      expect(chatCalls, 'the model ran on a human-owned task').toBe(0)

      // And the human still owns it — no partial write.
      const row = h.sqlite
        .prepare('SELECT assignee_agent_id, assignee_member_id FROM tasks WHERE id = ?')
        .get(task.id) as { assignee_agent_id: string | null; assignee_member_id: string | null }
      expect(row.assignee_agent_id).toBeNull()
      expect(row.assignee_member_id).toBe(HUMAN)
    } finally {
      h.sqlite.close()
    }
  })

  it('POSITIVE CONTROL — the same agent DOES pick up an unowned task', async () => {
    // Without this the test above passes against any breakage that refuses everything,
    // which is the failure mode that makes a refusal test worthless.
    const { h, env } = harness()
    try {
      const task = await createTask(env, {
        squad_id: SQUAD,
        title: 'ordinary agent work',
        done_when: 'the thing is done',
      }, { skipEvent: true })

      const agent = {
        id: AGENT, squad_id: SQUAD, slug: 'kasra', name: 'Kasra',
        role: null, model: null, status: 'active', created_at: 'now',
      }
      let chatCalls = 0
      const countingModel = { chat: async () => { chatCalls += 1; return 'did the work' } }

      await runTaskExecution(env, agent as never, task.id, {
        model: countingModel as never,
        emit: async () => {},
      })

      expect(chatCalls, 'the agent could not pick up ordinary unowned work either').toBeGreaterThan(0)
    } finally {
      h.sqlite.close()
    }
  })
})

// ── task_list must be able to FIND the human's work ───────────────────────────
//
// Task 676ae5db's done_when has three clauses, and the third is the one that was
// missing: "a task can be created/updated with a human assignee AND SHOWS UP IN
// THAT PERSON'S QUEUE."
//
// Measured 2026-09-10 on 65758b44: task_create and task_update both accept
// assignee_member_id, the single-assignee triggers enforce it, ranking selects
// it — and NOTHING read BY it. Zero references in src/attention/service.ts
// (needs_you_list), zero in src/dashboard/*, and task_list exposed only
// assignee_agent_id. The column was WRITE-ONLY: a person could be given work
// they had no way to query.
//
// That is the same shape as the escalation gate_owner defect found the same
// night (mupot#1381): the write path lands, every layer reports success, and the
// read path does not exist.
//
// These tests enter through invokeTool, never a ToolSpec's run() — the min
// capability floor is enforced BEFORE run(), so calling run() directly would
// test a path production never takes (and scripts/check-mcp-tool-seam.mjs
// enforces the same rule).

describe('task_list — the human axis is readable, not just writable', () => {
  function memberAuth(): AuthContext {
    return {
      userId: HUMAN,
      memberId: HUMAN,
      email: 'hadi@mumega.com',
      role: 'member',
      tenant: 'mumega',
      channel: 'dashboard',
      boundAgentId: null,
      capabilities: [
        { member_id: HUMAN, scope_type: 'squad', scope_id: SQUAD, capability: 'admin' },
      ],
    } as unknown as AuthContext
  }

  async function seedTwoTasks(env: Env): Promise<void> {
    await createTask(env, {
      squad_id: SQUAD,
      title: 'Human-owned: editorial gate',
      body: 'Hadi retains editorial authority',
      done_when: 'Hadi approves the draft',
      assignee_member_id: HUMAN,
    }, { actor: { kind: 'agent', id: AGENT } })

    await createTask(env, {
      squad_id: SQUAD,
      title: 'Agent-owned: ship the fix',
      body: 'routine agent work',
      done_when: 'PR merged',
      assignee_agent_id: AGENT,
    }, { actor: { kind: 'agent', id: AGENT } })
  }

  it('returns the human-owned task and EXCLUDES the agent-owned one', async () => {
    const { h, env } = harness()
    try {
      await seedTwoTasks(env)

      const res = await invokeTool(
        memberAuth(),
        env,
        'task_list',
        { squad_id: SQUAD, assignee_member_id: HUMAN },
        'https://pot.example',
      )

      expect(res.ok, `task_list failed: ${JSON.stringify(res)}`).toBe(true)
      const tasks = (res.result as { tasks: { title: string; assignee_member_id: string | null }[] }).tasks

      // Both halves matter. Returning the human's task proves the filter reads
      // the column; excluding the agent's proves it is a FILTER and not a
      // squad-wide list that happens to contain the row.
      expect(tasks.map((t) => t.title)).toEqual(['Human-owned: editorial gate'])
      expect(tasks[0].assignee_member_id).toBe(HUMAN)
    } finally {
      h.close()
    }
  })

  it('a DIFFERENT member id returns nothing — the filter is not decorative', async () => {
    const { h, env } = harness()
    try {
      await seedTwoTasks(env)

      const res = await invokeTool(
        memberAuth(),
        env,
        'task_list',
        { squad_id: SQUAD, assignee_member_id: OUTSIDER },
        'https://pot.example',
      )

      expect(res.ok).toBe(true)
      expect((res.result as { tasks: unknown[] }).tasks).toEqual([])
    } finally {
      h.close()
    }
  })

  it('POSITIVE CONTROL — the agent axis still filters, so the above is not a dead harness', async () => {
    const { h, env } = harness()
    try {
      await seedTwoTasks(env)

      const res = await invokeTool(
        memberAuth(),
        env,
        'task_list',
        { squad_id: SQUAD, assignee_agent_id: AGENT },
        'https://pot.example',
      )

      expect(res.ok).toBe(true)
      const tasks = (res.result as { tasks: { title: string }[] }).tasks
      expect(tasks.map((t) => t.title)).toEqual(['Agent-owned: ship the fix'])
    } finally {
      h.close()
    }
  })

  // Rejected rather than silently empty. A task has exactly one owner, so this
  // combination can never match — and a zero-row success reads as "no such work"
  // rather than "impossible query", which is the success-shaped no-op again.
  it('REFUSES both axes at once instead of returning an empty list', async () => {
    const { h, env } = harness()
    try {
      const res = await invokeTool(
        memberAuth(),
        env,
        'task_list',
        { squad_id: SQUAD, assignee_member_id: HUMAN, assignee_agent_id: AGENT },
        'https://pot.example',
      )

      expect(res.ok).toBe(false)
      expect(JSON.stringify(res)).toContain('task_single_assignee')
    } finally {
      h.close()
    }
  })
})

// ── The four mutations that survived the first version of these tests ─────────
//
// An adversarial gate on PR #1384 found no defect in the code — every authz,
// bind-index and starvation attack held — but it broke the TESTS four times.
// Each mutation below is a real production break that ran 21/21 green.
//
// The two structural lessons, which generalise past this tool:
//
//  1. task_list fans ONE clause set into THREE queries: an explicit-status
//     query, an actionable fetch and a terminal fetch. Fixtures that seed only
//     'open' rows exercise exactly one of them, and the other two will accept a
//     dropped filter in silence.
//
//  2. A dynamically computed bind index (`?${binds.length + 1}`) is
//     unfalsifiable by any test that never supplies two optional filters at
//     once. Hardcoding `?2` passes every single-filter test.

describe('task_list member filter — the branches and orderings the first tests missed', () => {
  function memberAuth2(): AuthContext {
    return {
      userId: HUMAN,
      memberId: HUMAN,
      email: 'hadi@mumega.com',
      role: 'member',
      tenant: 'mumega',
      channel: 'dashboard',
      boundAgentId: null,
      capabilities: [
        { member_id: HUMAN, scope_type: 'squad', scope_id: SQUAD, capability: 'admin' },
      ],
    } as unknown as AuthContext
  }

  // M1 — kills a hardcoded bind index. With `?2` literal instead of
  // `?${baseBinds.length + 1}`, the member filter compares assignee_member_id
  // against the PROJECT ID and returns zero rows with no error.
  it('filters correctly when project_id and assignee_member_id are BOTH supplied', async () => {
    const { h, env } = harness()
    try {
      h.sqlite.exec(`
        INSERT INTO projects (id, slug, name, status) VALUES ('proj-1', 'proj-1', 'Project One', 'active');
        INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('proj-1', '${SQUAD}', 'write');
      `)

      await createTask(env, {
        squad_id: SQUAD,
        project_id: 'proj-1',
        title: 'Human-owned inside the project',
        body: 'editorial',
        done_when: 'Hadi approves',
        assignee_member_id: HUMAN,
      }, { actor: { kind: 'agent', id: AGENT } })

      const res = await invokeTool(
        memberAuth2(),
        env,
        'task_list',
        { squad_id: SQUAD, project_id: 'proj-1', assignee_member_id: HUMAN },
        'https://pot.example',
      )

      expect(res.ok, `task_list failed: ${JSON.stringify(res)}`).toBe(true)
      const tasks = (res.result as { tasks: { title: string }[] }).tasks
      expect(
        tasks.map((t) => t.title),
        'the member filter bound against the wrong parameter — a hardcoded index ' +
          'silently compares assignee_member_id to the project id',
      ).toEqual(['Human-owned inside the project'])
    } finally {
      h.close()
    }
  })

  // M6 — the worst of the four. Dropping the member clause from the TERMINAL
  // fetch only leaves the actionable fetch correct, so a "my queue" listing
  // silently carries other people's done/review/approved rows.
  it('excludes another member’s TERMINAL rows, not just their open ones', async () => {
    const { h, env } = harness()
    try {
      const mine = await createTask(env, {
        squad_id: SQUAD,
        title: 'Mine and open',
        body: 'b',
        done_when: 'the owner marks this resolved',
        assignee_member_id: HUMAN,
      }, { actor: { kind: 'agent', id: AGENT } })

      const theirs = await createTask(env, {
        squad_id: SQUAD,
        title: 'Theirs and DONE',
        body: 'b',
        done_when: 'the owner marks this resolved',
        assignee_member_id: OUTSIDER,
      }, { actor: { kind: 'agent', id: AGENT } })

      // Terminal status is what routes the row into the second, separately
      // bounded query. Set directly: the point is the read path, not the
      // completion gate.
      h.sqlite.exec(`UPDATE tasks SET status = 'done' WHERE id = '${theirs.id}'`)
      expect(mine.id).not.toBe(theirs.id)

      const res = await invokeTool(
        memberAuth2(),
        env,
        'task_list',
        { squad_id: SQUAD, assignee_member_id: HUMAN },
        'https://pot.example',
      )

      expect(res.ok).toBe(true)
      const titles = (res.result as { tasks: { title: string }[] }).tasks.map((t) => t.title)
      expect(
        titles,
        'a terminal row owned by someone else leaked into this member’s list — ' +
          'the filter is missing from the terminal fetch branch',
      ).toEqual(['Mine and open'])
    } finally {
      h.close()
    }
  })

  // Same branch split, the explicit-status query this time.
  it('applies the member filter on the explicit-status query too', async () => {
    const { h, env } = harness()
    try {
      await createTask(env, {
        squad_id: SQUAD, title: 'Mine and open', body: 'b', done_when: 'the owner marks this resolved',
        assignee_member_id: HUMAN,
      }, { actor: { kind: 'agent', id: AGENT } })
      await createTask(env, {
        squad_id: SQUAD, title: 'Theirs and open', body: 'b', done_when: 'the owner marks this resolved',
        assignee_member_id: OUTSIDER,
      }, { actor: { kind: 'agent', id: AGENT } })

      const res = await invokeTool(
        memberAuth2(),
        env,
        'task_list',
        { squad_id: SQUAD, status: 'open', assignee_member_id: HUMAN },
        'https://pot.example',
      )

      expect(res.ok).toBe(true)
      expect((res.result as { tasks: { title: string }[] }).tasks.map((t) => t.title))
        .toEqual(['Mine and open'])
    } finally {
      h.close()
    }
  })

  // M2 — pins the EMPTY-STRING boundary of the both-axes refusal. A UI that
  // always sends both fields, one blank, must not be refused. Note this
  // predicate deliberately differs from task_create/task_update, which reject
  // on defined-ness rather than on non-emptiness; the divergence is real and is
  // recorded on the task.
  it('an EMPTY other-axis does not trip the both-axes refusal', async () => {
    const { h, env } = harness()
    try {
      await createTask(env, {
        squad_id: SQUAD, title: 'Human-owned', body: 'b', done_when: 'the owner marks this resolved',
        assignee_member_id: HUMAN,
      }, { actor: { kind: 'agent', id: AGENT } })

      const res = await invokeTool(
        memberAuth2(),
        env,
        'task_list',
        { squad_id: SQUAD, assignee_agent_id: '', assignee_member_id: HUMAN },
        'https://pot.example',
      )

      expect(res.ok, 'a blank agent axis was treated as a second owner').toBe(true)
      expect((res.result as { tasks: unknown[] }).tasks).toHaveLength(1)
    } finally {
      h.close()
    }
  })

  // M3 — the bind must be trimmed, as the agent axis already is.
  it('trims the member id before binding', async () => {
    const { h, env } = harness()
    try {
      await createTask(env, {
        squad_id: SQUAD, title: 'Human-owned', body: 'b', done_when: 'the owner marks this resolved',
        assignee_member_id: HUMAN,
      }, { actor: { kind: 'agent', id: AGENT } })

      const res = await invokeTool(
        memberAuth2(),
        env,
        'task_list',
        { squad_id: SQUAD, assignee_member_id: `  ${HUMAN}  ` },
        'https://pot.example',
      )

      expect(res.ok).toBe(true)
      expect((res.result as { tasks: unknown[] }).tasks).toHaveLength(1)
    } finally {
      h.close()
    }
  })
})
