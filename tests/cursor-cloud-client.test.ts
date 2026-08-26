import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CURSOR_API_BASE,
  createCursorAgent,
  dispatchCursorRun,
  getCursorAgent,
  getCursorRun,
} from '../src/cursor/client'
import { invokeTool, TOOLS } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TOKEN = 'cursor-test-token'
const AGENT_ID = 'bc-00000000-0000-0000-0000-000000000001'
const RUN_ID = 'run-00000000-0000-0000-0000-000000000001'
const AGENT_URL = `https://cursor.com/agents/${AGENT_ID}`

const SAMPLE_AGENT = {
  id: AGENT_ID,
  name: 'Add README',
  status: 'ACTIVE',
  url: AGENT_URL,
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-26T00:00:00.000Z',
  latestRunId: RUN_ID,
  repos: [{ url: 'https://github.com/acme/widgets' }],
}

const SAMPLE_RUN = {
  id: RUN_ID,
  agentId: AGENT_ID,
  status: 'CREATING',
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-26T00:00:00.000Z',
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function readJson(init: RequestInit | undefined): Promise<Record<string, unknown>> {
  const raw = init?.body
  expect(typeof raw).toBe('string')
  return JSON.parse(raw as string) as Record<string, unknown>
}

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'squad-a', 'Squad Alpha');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('agent-a', 'squad-a', 'agent-a', 'Agent Alpha', 'operator', 'test', 'active');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('member-squad-a', 'squad-a@test.com', 'Squad A Member', 'active', 'mumega');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('cap-squad-a', 'member-squad-a', 'squad', 'squad-a', 'member');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES
      ('mumega', 'agent-a', 'member-squad-a', datetime('now'));
  `)
  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  return {
    DB: harness.db,
    TENANT_SLUG: 'mumega',
    CURSOR_API_TOKEN: TOKEN,
    BUS: { send: async () => {} },
  } as unknown as Env
}

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: 'member-squad-a',
    memberId: 'member-squad-a',
    email: 'squad-a@test.com',
    role: 'member',
    tenant: 'mumega',
    channel: 'workspace',
    boundAgentId: 'agent-a',
    capabilities: [
      { member_id: 'member-squad-a', scope_type: 'squad', scope_id: 'squad-a', capability: 'member' },
    ],
    ...overrides,
  }
}

describe('Cursor Cloud client', () => {
  it('createCursorAgent parses the durable agent and initial run from a mocked fetch', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`${CURSOR_API_BASE}/agents`)
      expect(init?.method).toBe('POST')
      const headers = new Headers(init?.headers)
      expect(headers.get('Authorization')).toBe(`Bearer ${TOKEN}`)
      const payload = await readJson(init)
      expect(payload).toEqual({
        name: 'Add README',
        prompt: { text: 'Write a setup README' },
        repos: [{ url: 'https://github.com/acme/widgets' }],
        model: { id: 'composer-2' },
      })
      return jsonResponse({ agent: SAMPLE_AGENT, run: SAMPLE_RUN })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await createCursorAgent(TOKEN, {
      name: 'Add README',
      repoUrl: 'https://github.com/acme/widgets',
      prompt: 'Write a setup README',
      model: 'composer-2',
    })

    expect(result.agent).toMatchObject({
      id: AGENT_ID,
      name: 'Add README',
      status: 'ACTIVE',
      url: AGENT_URL,
      latestRunId: RUN_ID,
    })
    expect(result.run).toMatchObject({
      id: RUN_ID,
      agentId: AGENT_ID,
      status: 'CREATING',
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('dispatchCursorRun sends a follow-up prompt payload to the agent runs endpoint', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`${CURSOR_API_BASE}/agents/${AGENT_ID}/runs`)
      expect(init?.method).toBe('POST')
      const headers = new Headers(init?.headers)
      expect(headers.get('Authorization')).toBe(`Bearer ${TOKEN}`)
      expect(headers.get('Content-Type')).toBe('application/json')
      const payload = await readJson(init)
      expect(payload).toEqual({ prompt: { text: 'Also add troubleshooting' } })
      return jsonResponse({
        run: {
          ...SAMPLE_RUN,
          id: 'run-00000000-0000-0000-0000-000000000002',
          status: 'CREATING',
        },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await dispatchCursorRun(TOKEN, AGENT_ID, 'Also add troubleshooting')
    expect(result.run.id).toBe('run-00000000-0000-0000-0000-000000000002')
    expect(result.run.agentId).toBe(AGENT_ID)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('getCursorAgent and getCursorRun read the documented paths', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `${CURSOR_API_BASE}/agents/${AGENT_ID}`) return jsonResponse(SAMPLE_AGENT)
      if (url === `${CURSOR_API_BASE}/agents/${AGENT_ID}/runs/${RUN_ID}`) {
        return jsonResponse({
          ...SAMPLE_RUN,
          status: 'FINISHED',
          result: 'Added README.md',
          git: {
            branches: [{
              repoUrl: 'github.com/acme/widgets',
              branch: 'cursor/add-readme',
              prUrl: 'https://github.com/acme/widgets/pull/1',
            }],
          },
        })
      }
      throw new Error(`unexpected url ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(getCursorAgent(TOKEN, AGENT_ID)).resolves.toMatchObject({ id: AGENT_ID, url: AGENT_URL })
    const run = await getCursorRun(TOKEN, AGENT_ID, RUN_ID)
    expect(run.status).toBe('FINISHED')
    expect(run.git?.branches?.[0]?.prUrl).toBe('https://github.com/acme/widgets/pull/1')
  })
})

describe('Cursor Cloud MCP tools', () => {
  it('registers cursor_dispatch and cursor_run_status on the MCP surface', () => {
    expect(TOOLS.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['cursor_dispatch', 'cursor_run_status']),
    )
  })

  it('cursor_dispatch creates a task/flight and returns agent_url', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    const fetchMock = vi.fn(async () => jsonResponse({ agent: SAMPLE_AGENT, run: SAMPLE_RUN }))
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await invokeTool(auth(), env, 'cursor_dispatch', {
      name: 'Add README',
      repo_url: 'https://github.com/acme/widgets',
      prompt: 'Write a setup README',
      model: 'composer-2',
    })

    expect(outcome.ok, JSON.stringify(outcome)).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result).toEqual({
      ok: true,
      agent_id: AGENT_ID,
      run_id: RUN_ID,
      agent_url: AGENT_URL,
    })

    const tasks = harness.sqlite.prepare('SELECT id, title, status, assignee_agent_id, body FROM tasks').all()
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      title: 'Add README',
      status: 'in_progress',
      assignee_agent_id: 'agent-a',
    })
    expect(String(tasks[0]?.body)).toContain(AGENT_URL)

    const flights = harness.sqlite.prepare(
      'SELECT id, agent, goal, status, trigger_source, meta FROM flights',
    ).all()
    expect(flights).toHaveLength(1)
    expect(flights[0]).toMatchObject({
      agent: 'agent-a',
      goal: 'Add README',
      status: 'running',
      trigger_source: 'api',
    })
    const meta = JSON.parse(String(flights[0]?.meta)) as { task_ids: string[] }
    expect(meta.task_ids).toEqual([tasks[0]?.id])
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
