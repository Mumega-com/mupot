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
import { runTaskExecution } from '../src/agents/execute'
import { TASK_SELECT_COLUMNS } from '../src/tasks/ranking'
import type { Env } from '../src/types'
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
