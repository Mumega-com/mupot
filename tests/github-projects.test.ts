// Tests for the GitHub Projects v2 ↔ pot bridge (src/integrations/github-projects.ts).

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { parseProjectItems, importProjectItems, parseSyncProject, syncGitHubProject } from '../src/integrations/github-projects'
import { runTaskExecution } from '../src/agents/execute'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import type { Agent, Env, ModelPort } from '../src/types'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

// A Projects v2 GraphQL response shape with two items: one assigned to "kasra" via the Agent
// single-select field, one with no Agent value.
function projectData() {
  return {
    organization: {
      projectV2: {
        items: {
          nodes: [
            {
              id: 'ITEM_1',
              content: { number: 7, title: 'Fix the parser', url: 'https://github.com/o/r/issues/7' },
              fieldValues: {
                nodes: [
                  { __typename: 'ProjectV2ItemFieldSingleSelectValue', name: 'kasra', field: { name: 'Agent' } },
                  { __typename: 'ProjectV2ItemFieldSingleSelectValue', name: 'Todo', field: { name: 'Status' } },
                ],
              },
            },
            {
              id: 'ITEM_2',
              content: { number: 8, title: 'Unassigned thing', url: 'https://github.com/o/r/issues/8' },
              fieldValues: { nodes: [{ __typename: 'ProjectV2ItemFieldSingleSelectValue', name: 'Todo', field: { name: 'Status' } }] },
            },
          ],
        },
      },
    },
  }
}

function paginatedProjectData() {
  const first = projectData()
  first.organization.projectV2.items.nodes = [first.organization.projectV2.items.nodes[1]]
  ;(first.organization.projectV2.items as unknown as { pageInfo: unknown }).pageInfo = { hasNextPage: true, endCursor: 'cursor-1' }
  const second = projectData()
  second.organization.projectV2.items.nodes = [second.organization.projectV2.items.nodes[0]]
  ;(second.organization.projectV2.items as unknown as { pageInfo: unknown }).pageInfo = { hasNextPage: false, endCursor: null }
  return { first, second }
}

describe('parseProjectItems', () => {
  it('extracts items + the Agent field value (case-insensitive field name)', () => {
    const items = parseProjectItems(projectData(), 'Agent')
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ itemId: 'ITEM_1', number: 7, title: 'Fix the parser', agentValue: 'kasra' })
    expect(items[1].agentValue).toBeNull()
  })
  it('returns [] for an empty/odd response', () => {
    expect(parseProjectItems({}, 'Agent')).toEqual([])
    expect(parseProjectItems({ organization: {} }, 'Agent')).toEqual([])
  })
})

// env: agents table resolves 'kasra' → {id,squad}; tracks created tasks; KV dedup store.
function env(opts: { hasAgent?: boolean; token?: string | null } = {}) {
  const hasAgent = opts.hasAgent !== false
  const kv = new Map<string, string>()
  const tasks: Array<Record<string, unknown>> = []
  const DB = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => (sql.includes('FROM agents') && hasAgent ? { id: 'A1', squad_id: 'SQ1' } : null),
        run: async () => {
          if (sql.startsWith('INSERT INTO tasks')) tasks.push({ args })
          return { meta: { changes: 1 } }
        },
        all: async () => ({ results: [] }),
      }),
    }),
  }
  const e = {
    TENANT_SLUG: 't', DB, GITHUB_TOKEN: 'token' in opts ? opts.token : 'ghp_x',
    SESSIONS: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => void kv.set(k, v) },
    BUS: { send: async () => {} }, // createTask emits a task.created bus event
  } as unknown as Env
  return { e, tasks, kv }
}

function gqlFetch(data: unknown, status = 200) {
  return (async () => new Response(JSON.stringify({ data }), { status })) as unknown as typeof fetch
}

describe('importProjectItems', () => {
  it('imports an agent-assigned item as a routed task', async () => {
    const { e, tasks } = env()
    const res = await importProjectItems(e, { owner: 'Mumega-com', projectNumber: 1 }, { fetchImpl: gqlFetch(projectData()) })
    expect(res.ok).toBe(true)
    expect(res.imported).toBe(1)
    expect(tasks).toHaveLength(1)
    expect(res.items.find((i) => i.agent === 'kasra')?.status).toBe('created')
    expect(res.items.find((i) => i.title === 'Unassigned thing')?.status).toBe('no_agent')
  })

  it('dry-run reports without creating tasks', async () => {
    const { e, tasks } = env()
    const res = await importProjectItems(e, { owner: 'o', projectNumber: 1, dryRun: true }, { fetchImpl: gqlFetch(projectData()) })
    expect(res.imported).toBe(1)
    expect(tasks).toHaveLength(0)
  })

  it('imports an assigned item from a later Project page', async () => {
    const { e, tasks } = env()
    const { first, second } = paginatedProjectData()
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { variables?: { after?: string | null } }
      return new Response(JSON.stringify({ data: body.variables?.after === 'cursor-1' ? second : first }), { status: 200 })
    }) as unknown as typeof fetch

    const res = await importProjectItems(e, { owner: 'Mumega-com', projectNumber: 1 }, { fetchImpl })
    expect(res.imported).toBe(1)
    expect(tasks).toHaveLength(1)
    expect(res.items.find((item) => item.title === 'Fix the parser')?.status).toBe('created')
  })

  it('dedups already-imported items (idempotent)', async () => {
    const { e, tasks } = env()
    const f = gqlFetch(projectData())
    await importProjectItems(e, { owner: 'o', projectNumber: 1 }, { fetchImpl: f })
    const res2 = await importProjectItems(e, { owner: 'o', projectNumber: 1 }, { fetchImpl: f })
    expect(res2.skipped).toBe(1)
    expect(tasks).toHaveLength(1) // not re-created
  })

  it('unknown agent value → unknown_agent, no task', async () => {
    const { e, tasks } = env({ hasAgent: false })
    const res = await importProjectItems(e, { owner: 'o', projectNumber: 1 }, { fetchImpl: gqlFetch(projectData()) })
    expect(res.imported).toBe(0)
    expect(res.items.find((i) => i.agent === 'kasra')?.status).toBe('unknown_agent')
    expect(tasks).toHaveLength(0)
  })

  it('fail-closed when Projects read is unavailable (403)', async () => {
    const { e } = env()
    const res = await importProjectItems(e, { owner: 'o', projectNumber: 1 }, { fetchImpl: gqlFetch({}, 403) })
    expect(res).toMatchObject({ ok: false, error: 'projects_unavailable' })
  })

  it('rejects bad owner / project before network', async () => {
    const { e } = env()
    expect((await importProjectItems(e, { owner: 'bad owner!', projectNumber: 1 })).error).toBe('invalid_owner')
    expect((await importProjectItems(e, { owner: 'o', projectNumber: 0 })).error).toBe('invalid_project')
  })

  // ── PR #659 P0 fix, widened (kasra-core parallel-audit finding) ─────────────────
  //
  // Pre-fix, confirmed live on main: this adapter resolved the "Agent" project field to a
  // REAL pot agent and passed it straight to createTask as assignee_agent_id with NO
  // skipEvent — task.created fired, dispatchSquad woke that agent, and executeTaskAsPR
  // shipped work authored as that agent, from attacker-editable field/title text, with ZERO
  // human step. This bypassed the unassigned-auto-pickup check entirely (the task was never
  // unassigned) — the exact "ASSIGNED path" gap the widened brief flagged as new since the
  // Linear-only fix. These tests prove the property against the real INSERT (args[7] =
  // assignee_agent_id, args[14] = external_source — see createTask's column order,
  // src/tasks/service.ts) and, end to end, against the real canAgentExecuteTask.
  it('imports an agent-named item UNASSIGNED, carrying external_source — never auto-assigned to the resolved agent', async () => {
    const { e, tasks } = env()
    const res = await importProjectItems(e, { owner: 'Mumega-com', projectNumber: 1 }, { fetchImpl: gqlFetch(projectData()) })
    expect(res.ok).toBe(true)
    expect(res.imported).toBe(1)
    expect(tasks).toHaveLength(1)
    const args = tasks[0].args as unknown[]
    expect(args[7]).toBeNull() // assignee_agent_id — NEVER set, even though 'kasra' resolved to a real agent
    expect(args[14]).toBe('github-projects:Mumega-com/1') // external_source — the structural marker
  })

  it('end to end: a GitHub-Projects-origin task is refused by canAgentExecuteTask for the exact agent the field named', async () => {
    const harness = createSqliteD1()
    for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
      harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
    }
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'squad-a', 'Squad A');
      INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-kasra', 'squad-a', 'kasra', 'Kasra', 'active');
    `)
    const realEnv = {
      TENANT_SLUG: 't',
      DB: harness.db,
      GITHUB_TOKEN: 'ghp_x',
      SESSIONS: { get: async () => null, put: async () => {} },
      BUS: { send: async () => {} },
    } as unknown as Env

    const res = await importProjectItems(realEnv, { owner: 'Mumega-com', projectNumber: 1 }, { fetchImpl: gqlFetch(projectData()) })
    expect(res).toMatchObject({ ok: true, imported: 1 })

    const row = harness.sqlite.prepare('SELECT id, assignee_agent_id, external_source FROM tasks WHERE title = ?')
      .get('Fix the parser') as { id: string; assignee_agent_id: string | null; external_source: string | null }
    expect(row.assignee_agent_id).toBeNull()
    expect(row.external_source).toBe('github-projects:Mumega-com/1')

    // 'kasra' is EXACTLY the agent the "Agent" field named — proving it cannot self-pick-up
    // the very task that named it, which is the concrete shape of the confirmed-live bug.
    const agent: Agent = { id: 'agent-kasra', squad_id: 'squad-a', slug: 'kasra', name: 'Kasra', role: null, model: null, status: 'active', created_at: 'now' }
    const model: ModelPort = { chat: vi.fn(async () => 'should never run') }
    const r = await runTaskExecution(realEnv, agent, row.id, { model, emit: async () => {} })

    expect(r.ok).toBe(false)
    expect(r.error).toBe('task_not_found')
    expect(model.chat).not.toHaveBeenCalled()
  })
})

describe('parseSyncProject (#23)', () => {
  it('parses owner/number', () => {
    expect(parseSyncProject('Mumega-com/1')).toEqual({ owner: 'Mumega-com', projectNumber: 1 })
  })
  it('null for unset/invalid', () => {
    expect(parseSyncProject(undefined)).toBeNull()
    expect(parseSyncProject('noslash')).toBeNull()
    expect(parseSyncProject('o/x')).toBeNull()
    expect(parseSyncProject('bad owner!/1')).toBeNull()
  })
})

describe('syncGitHubProject (#23 cron/webhook entry)', () => {
  it('no-op when GITHUB_SYNC_PROJECT unset', async () => {
    const { e } = env()
    expect(await syncGitHubProject(e)).toEqual({ ok: false, reason: 'not_configured' })
  })
  it('runs the import for the configured board', async () => {
    const { e, tasks } = env()
    ;(e as unknown as { GITHUB_SYNC_PROJECT: string }).GITHUB_SYNC_PROJECT = 'Mumega-com/1'
    const res = await syncGitHubProject(e, { fetchImpl: gqlFetch(projectData()) })
    expect(res.ok).toBe(true)
    expect(res.imported).toBe(1)
    expect(tasks).toHaveLength(1)
  })
  it('surfaces projects_unavailable as the reason (fail-closed)', async () => {
    const { e } = env()
    ;(e as unknown as { GITHUB_SYNC_PROJECT: string }).GITHUB_SYNC_PROJECT = 'o/1'
    const res = await syncGitHubProject(e, { fetchImpl: gqlFetch({}, 403) })
    expect(res).toEqual({ ok: false, reason: 'projects_unavailable' })
  })
})
