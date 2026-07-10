// Tests for the GitHub Projects v2 ↔ pot bridge (src/integrations/github-projects.ts).

import { describe, it, expect } from 'vitest'
import { parseProjectItems, importProjectItems, parseSyncProject, syncGitHubProject } from '../src/integrations/github-projects'
import type { Env } from '../src/types'

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
