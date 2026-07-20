// Tests for B3 inbound status sync (syncTaskStatusFromIssue) and the GH PR
// mirror close routine (closeGitHubPrMirrorTasks) in tasks/service.ts.

import { describe, it, expect } from 'vitest'
import { syncTaskStatusFromIssue, closeGitHubPrMirrorTasks } from '../src/tasks/service'
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

describe('closeGitHubPrMirrorTasks', () => {
  it('closes open/in_progress ungated mirrors matched by html_url or title prefix', async () => {
    const { env, calls } = dbEnv(3)
    const res = await closeGitHubPrMirrorTasks(env, {
      htmlUrl: 'https://github.com/Mumega-com/mupot/pull/418',
      repo: 'Mumega-com/mupot',
      prNumber: 418,
    })
    expect(res.updated).toBe(3)
    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toContain("status = 'done'")
    expect(calls[0].sql).toContain("status IN ('open','in_progress')")
    expect(calls[0].sql).toContain('gate_owner')
    expect(calls[0].args[1]).toBe('https://github.com/Mumega-com/mupot/pull/418')
    expect(calls[0].args[2]).toBe('https://github.com/Mumega-com/mupot/pull/418\n%')
    expect(calls[0].args[3]).toBe('[GH Mumega-com/mupot] PR #418 %')
  })

  it('bad args → no-op', async () => {
    const { env, calls } = dbEnv(1)
    expect((await closeGitHubPrMirrorTasks(env, { htmlUrl: '', repo: 'a/b', prNumber: 1 })).updated).toBe(0)
    expect((await closeGitHubPrMirrorTasks(env, { htmlUrl: 'u', repo: '', prNumber: 1 })).updated).toBe(0)
    expect((await closeGitHubPrMirrorTasks(env, { htmlUrl: 'u', repo: 'a/b', prNumber: 0 })).updated).toBe(0)
    expect(calls.length).toBe(0)
  })
})
