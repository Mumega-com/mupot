// tests/tasks-done-when.test.ts — #142 capsule keystone: verifiable done_when contract.
//
// Proves:
//  (a) createTask rejects missing / blank done_when (throws before touching DB)
//  (b) createTask accepts and persists a valid done_when
//  (c) isDoneWhenValid type guard
//
// Uses the same D1/bus stub pattern as tasks-service.test.ts.

import { describe, expect, it, vi } from 'vitest'
import { createTask, isDoneWhenValid } from '../src/tasks/service'
import type { Env } from '../src/types'

// ── Minimal stub env ──────────────────────────────────────────────────────────

function makeEnv() {
  const inserts: unknown[][] = []
  const env = {
    TENANT_SLUG: 'test',
    // No GITHUB_TOKEN/GITHUB_REPO → mirrorTaskCreate returns null (skipMirror path for free)
    BUS: { send: vi.fn(async () => {}) },
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async run() {
                if (sql.includes('INSERT INTO tasks')) inserts.push(args)
                return { meta: { changes: 1 } }
              },
            }
          },
        }
      },
    },
  } as unknown as Env
  return { env, inserts }
}

// ── isDoneWhenValid ───────────────────────────────────────────────────────────

describe('isDoneWhenValid', () => {
  it('accepts a non-empty string', () => {
    expect(isDoneWhenValid('test X passes')).toBe(true)
  })

  it('accepts a single non-whitespace character', () => {
    expect(isDoneWhenValid('x')).toBe(true)
  })

  it('rejects an empty string', () => {
    expect(isDoneWhenValid('')).toBe(false)
  })

  it('rejects a whitespace-only string', () => {
    expect(isDoneWhenValid('   ')).toBe(false)
  })

  it('rejects null', () => {
    expect(isDoneWhenValid(null)).toBe(false)
  })

  it('rejects undefined', () => {
    expect(isDoneWhenValid(undefined)).toBe(false)
  })

  it('rejects a number', () => {
    expect(isDoneWhenValid(42)).toBe(false)
  })

  it('rejects an object', () => {
    expect(isDoneWhenValid({})).toBe(false)
  })
})

// ── createTask — done_when enforcement ───────────────────────────────────────

describe('createTask — done_when required', () => {
  it('(a) throws when done_when is missing (empty string)', async () => {
    const { env, inserts } = makeEnv()
    await expect(
      createTask(env, {
        squad_id: 'sq-1',
        title: 'A task without a predicate',
        done_when: '',
      }),
    ).rejects.toThrow('done_when_required')
    // Must not have inserted anything
    expect(inserts).toHaveLength(0)
  })

  it('(a) throws when done_when is whitespace-only', async () => {
    const { env, inserts } = makeEnv()
    await expect(
      createTask(env, {
        squad_id: 'sq-1',
        title: 'Whitespace predicate',
        done_when: '   ',
      }),
    ).rejects.toThrow('done_when_required')
    expect(inserts).toHaveLength(0)
  })

  it('(b) accepts and persists a valid done_when', async () => {
    const { env, inserts } = makeEnv()
    const task = await createTask(env, {
      squad_id: 'sq-1',
      title: 'Capsule task',
      done_when: 'GET /health returns 200',
    })

    // Returned task carries the predicate
    expect(task.done_when).toBe('GET /health returns 200')
    expect(task.title).toBe('Capsule task')

    // Exactly one INSERT was issued
    expect(inserts).toHaveLength(1)
    // done_when must be in the INSERT binds
    expect(inserts[0]).toContain('GET /health returns 200')
    // done_when is at the 5th bind position (after id, squad_id, title, body)
    // Bind order: id, squad_id, title, body, done_when, status, assignee_agent_id,
    //             github_issue_url, result, completed_at, gate_owner, created_at, updated_at
    expect(inserts[0][4]).toBe('GET /health returns 200')
  })

  it('(b) trims leading/trailing whitespace from done_when before storing', async () => {
    const { env } = makeEnv()
    const task = await createTask(env, {
      squad_id: 'sq-1',
      title: 'Trim test',
      done_when: '  migration applied  ',
    })
    expect(task.done_when).toBe('migration applied')
  })

  it('(b) stores done_when alongside other fields — gate_owner, assignee unaffected', async () => {
    const { env, inserts } = makeEnv()
    const task = await createTask(env, {
      squad_id: 'sq-1',
      title: 'Gated task',
      done_when: 'PR merged and CI green',
      gate_owner: 'gate:review',
    })
    expect(task.done_when).toBe('PR merged and CI green')
    expect(task.gate_owner).toBe('gate:review')
    expect(inserts[0]).toContain('gate:review')
    expect(inserts[0]).toContain('PR merged and CI green')
  })
})
