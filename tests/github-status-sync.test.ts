// Tests for B3 inbound status sync (syncTaskStatusFromIssue in tasks/service.ts).

import { describe, it, expect } from 'vitest'
import { syncTaskStatusFromIssue } from '../src/tasks/service'
import type { Env } from '../src/types'

// DB stub capturing the UPDATE: records the SQL + bound args, returns a configurable changes count.
function dbEnv(changes: number) {
  const calls: Array<{ sql: string; args: unknown[] }> = []
  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          run: async () => {
            calls.push({ sql, args })
            return { meta: { changes } }
          },
        }),
      }),
    },
  } as unknown as Env
  return { env, calls }
}

describe('syncTaskStatusFromIssue', () => {
  it('closed → marks the mirrored task done (open/in_progress only)', async () => {
    const { env, calls } = dbEnv(1)
    const res = await syncTaskStatusFromIssue(env, 'https://github.com/o/r/issues/5', 'closed')
    expect(res.updated).toBe(true)
    expect(calls[0].sql).toContain("status = 'done'")
    expect(calls[0].sql).toContain("status IN ('open','in_progress')") // never clobbers gate states
    expect(calls[0].args).toContain('https://github.com/o/r/issues/5')
  })

  it('reopened → flips a done task back to open', async () => {
    const { env, calls } = dbEnv(1)
    const res = await syncTaskStatusFromIssue(env, 'https://github.com/o/r/issues/5', 'reopened')
    expect(res.updated).toBe(true)
    expect(calls[0].sql).toContain("status = 'open'")
    expect(calls[0].sql).toContain("status = 'done'") // only un-does our own close
  })

  it('no matching task → updated:false', async () => {
    const { env } = dbEnv(0)
    expect((await syncTaskStatusFromIssue(env, 'https://github.com/o/r/issues/9', 'closed')).updated).toBe(false)
  })

  it('empty issue url → no-op', async () => {
    const { env, calls } = dbEnv(1)
    const res = await syncTaskStatusFromIssue(env, '', 'closed')
    expect(res.updated).toBe(false)
    expect(calls.length).toBe(0) // never touches the DB
  })
})
