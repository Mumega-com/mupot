import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import {
  createTask,
  assertValidIntakeContract,
  assertCompletableDoneWhen,
  isPlaceholderDoneWhen,
  TaskIntakeContractError,
} from '../src/tasks/service'
import type { Env } from '../src/types'

describe('Point-of-Capture Intake Contract Governance (Mupot #1040)', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = { DB: harness.db } as unknown as Env
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept-eng', 'Engineering');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('sq-1', 'dept-1', 'mmhq', 'Mumega HQ');
    `)
  })

  afterEach(() => {
    harness.close()
  })

  describe('assertValidIntakeContract', () => {
    it('rejects empty or whitespace-only done_when', () => {
      expect(() => {
        assertValidIntakeContract({
          title: 'Deploy gateway',
          done_when: '',
        })
      }).toThrowError(/done_when_required/)

      expect(() => {
        assertValidIntakeContract({
          title: 'Deploy gateway',
          done_when: '   \t\n  ',
        })
      }).toThrowError(/done_when_required/)
    })

    it('rejects all 4 known placeholder sentinels when allowDeferredPredicate is false', () => {
      const sentinels = [
        '(backfill required)',
        '(set via task update)',
        '(agent-generated — set via task update)',
        '(operator resolves — set via task update)',
        '  (backfill required)  ',
      ]

      for (const s of sentinels) {
        expect(isPlaceholderDoneWhen(s)).toBe(true)
        expect(() => {
          assertValidIntakeContract({
            title: 'Fix bridge timeout',
            done_when: s,
          })
        }).toThrowError(/done_when_placeholder_rejected/)
      }
    })

    it('accepts placeholder sentinels when allowDeferredPredicate is true', () => {
      expect(() => {
        assertValidIntakeContract(
          {
            title: 'Agent Propose Cycle',
            done_when: '(agent-generated — set via task update)',
          },
          { allowDeferredPredicate: true },
        )
      }).not.toThrow()
    })

    it('rejects trivially short done_when predicates', () => {
      expect(() => {
        assertValidIntakeContract({
          title: 'Fix bridge timeout',
          done_when: 'done', // 4 chars < 5 min
        })
      }).toThrowError(/done_when_insufficient/)
    })

    it('rejects P0 tasks with empty or insufficient justification body (<20 chars)', () => {
      expect(() => {
        assertValidIntakeContract({
          title: 'Security vulnerability in auth check',
          done_when: 'Unit test fails closed and patch is merged',
          body: 'Short text', // < 20 chars
          priority: 'P0',
        })
      }).toThrowError(/p0_justification_required/)

      expect(() => {
        assertValidIntakeContract({
          title: 'Outage on API',
          done_when: 'API returns 200 OK',
          body: '',
          priority: 'P0',
        })
      }).toThrowError(/p0_justification_required/)
    })

    it('accepts P0 tasks with non-trivial justification in body (>=20 chars)', () => {
      expect(() => {
        assertValidIntakeContract({
          title: 'Security vulnerability in auth check',
          done_when: 'Unit test fails closed and patch is merged',
          body: 'Critical bypass in member token resolution allows unauthenticated reads of private squad data.',
          priority: 'P0',
        })
      }).not.toThrow()
    })

    it('accepts standard P2/P3 tasks with valid verifiable predicates', () => {
      expect(() => {
        assertValidIntakeContract({
          title: 'Implement Kanban UI',
          done_when: 'GET /dashboard/kanban returns 200 with swimlanes',
          priority: 'P2',
        })
      }).not.toThrow()
    })

    it('rejects P1 tasks that lack both flight/project linkage and escape hatch', () => {
      expect(() => {
        assertValidIntakeContract({
          title: 'Unlinked critical finding',
          done_when: 'Unit test assertions verify fix',
          priority: 'P1',
        })
      }).toThrowError(/p1_linkage_required/)
    })

    it('accepts P1 tasks with project_id linkage', () => {
      expect(() => {
        assertValidIntakeContract({
          title: 'Flight blocker defect',
          done_when: 'Unit test assertions verify fix',
          priority: 'P1',
          project_id: 'proj-123',
        })
      }).not.toThrow()
    })

    it('accepts P1 tasks with parent_task_id linkage', () => {
      expect(() => {
        assertValidIntakeContract({
          title: 'Subtask blocker defect',
          done_when: 'Unit test assertions verify fix',
          priority: 'P1',
          parent_task_id: 'task-parent-123',
        })
      }).not.toThrow()
    })

    it('rejects unlinked P1 tasks with prose mentioning owner or ttl without the structured bracketed tag', () => {
      expect(() => {
        assertValidIntakeContract({
          title: 'Critical issue discovered',
          done_when: 'Unit test assertions verify fix',
          priority: 'P1',
          body: 'The owner of this task said ttl is 7d and re-review is needed',
        })
      }).toThrowError(/p1_linkage_required/)

      expect(() => {
        assertValidIntakeContract({
          title: 'Critical issue discovered',
          done_when: 'Unit test assertions verify fix',
          priority: 'P1',
          body: 'owner: kasra, ttl: 7d',
        })
      }).toThrowError(/p1_linkage_required/)
    })

    it('accepts P1 tasks with named owner and review TTL escape hatch in body', () => {
      expect(() => {
        assertValidIntakeContract({
          title: 'Discovered critical anomaly',
          done_when: 'Unit test assertions verify fix',
          priority: 'P1',
          body: 'Discovered during idle scan. [owner: @kasra, ttl: 7d]',
        })
      }).not.toThrow()
    })
  })

  describe('createTask integration & deferred predicate lifecycle with real D1 schema', () => {
    it('creates task when intake contract is fully satisfied', async () => {
      const task = await createTask(env, {
        squad_id: 'sq-1',
        title: 'Wire Hermes receiver',
        done_when: 'GET /health on port 8644 returns 200 OK',
        priority: 'P2',
      })

      expect(task.id).toBeDefined()
      expect(task.title).toBe('Wire Hermes receiver')
      expect(task.done_when).toBe('GET /health on port 8644 returns 200 OK')
      expect(task.status).toBe('open')
      expect(task.priority).toBe('P2')
    })

    it('allows internal system callers to create tasks with deferred predicates', async () => {
      const task = await createTask(
        env,
        {
          squad_id: 'sq-1',
          title: 'Agent Cortex Task',
          done_when: '(agent-generated — set via task update)',
        },
        { allowDeferredPredicate: true },
      )

      expect(task.id).toBeDefined()
      expect(task.done_when).toBe('(agent-generated — set via task update)')

      // But completion gate still blocks transitioning this task to done!
      expect(() => {
        assertCompletableDoneWhen(task.done_when)
      }).toThrowError(/done_when_placeholder/)
    })

    it('blocks public task creation in createTask when placeholder is passed without allowDeferredPredicate', async () => {
      await expect(
        createTask(env, {
          squad_id: 'sq-1',
          title: 'Wire Hermes receiver',
          done_when: '(backfill required)',
        }),
      ).rejects.toThrowError(TaskIntakeContractError)
    })

    it('enforces P1 discipline on task mutation / updates', () => {
      const existingTask: TaskIntakePayload = {
        title: 'Low priority chore',
        done_when: 'Chore completed and verified',
        priority: 'P3',
        project_id: null,
      }

      // Escalating to P1 without project linkage or escape hatch is rejected
      expect(() => {
        assertValidIntakeContract({
          ...existingTask,
          priority: 'P1',
        })
      }).toThrowError(/p1_linkage_required/)

      // Escalating to P1 with project linkage succeeds
      expect(() => {
        assertValidIntakeContract({
          ...existingTask,
          priority: 'P1',
          project_id: 'proj-flight-1',
        })
      }).not.toThrow()
    })

    it('persistTaskUpdate rejects escalating an unlinked task to P1', async () => {
      const task = await createTask(env, {
        squad_id: 'sq-1',
        title: 'Chore task',
        done_when: 'Chore verified',
        priority: 'P3',
      })

      const updatedTask = {
        ...task,
        priority: 'P1' as const,
        updated_at: new Date().toISOString(),
      }

      await expect(
        import('../src/tasks/service').then(m => m.persistTaskUpdate(env, task, updatedTask))
      ).rejects.toThrowError(TaskIntakeContractError)
    })
  })
})
