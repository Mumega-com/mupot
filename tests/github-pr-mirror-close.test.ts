// tests/github-pr-mirror-close.test.ts — closeGitHubPrMirrorTasks (ECC close-stale).

import { describe, expect, it } from 'vitest'
import { closeGitHubPrMirrorTasks } from '../src/tasks/service'
import type { Env } from '../src/types'

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

describe('closeGitHubPrMirrorTasks', () => {
  it('closes ungated open/in_progress mirrors matching repo+PR number', async () => {
    const { env, calls } = dbEnv(2)
    const res = await closeGitHubPrMirrorTasks(env, 'Mumega-com/mupot', 437)
    expect(res.closed).toBe(2)
    expect(calls[0].sql).toContain("status = 'done'")
    expect(calls[0].sql).toContain('gate_owner IS NULL')
    // #455: bulk WHERE must exclude project-attached rows structurally — this SET
    // clause never touches squad_id/project_id so 0061's trigger can't fence it.
    expect(calls[0].sql).toContain('project_id IS NULL')
    expect(calls[0].sql).toContain("ESCAPE '\\'")
    expect(calls[0].args[1]).toBe('[GH Mumega-com/mupot] PR #437 %')
  })

  it('escapes LIKE wildcards in repo names containing _ or %', async () => {
    const { env, calls } = dbEnv(1)
    await closeGitHubPrMirrorTasks(env, 'org/foo_bar', 12)
    expect(calls[0].args[1]).toBe('[GH org/foo\\_bar] PR #12 %')
  })

  it('no-ops on invalid input', async () => {
    const { env, calls } = dbEnv(1)
    expect((await closeGitHubPrMirrorTasks(env, '', 1)).closed).toBe(0)
    expect((await closeGitHubPrMirrorTasks(env, 'o/r', 0)).closed).toBe(0)
    expect(calls).toHaveLength(0)
  })
})
