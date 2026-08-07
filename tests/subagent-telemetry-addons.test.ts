import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import type { Env, BusEvent } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import {
  logSubagentTokenUsage,
  calculateTotalTokenMetrics,
  getSubagentTokenMetrics,
  listSubagentTokenUsage,
} from '../src/telemetry/subagent-usage'
import { sosApp } from '../src/addons/sos'
import { mirrorApp } from '../src/addons/mirror'
import { inkwellApp } from '../src/addons/inkwell'

let harness: SqliteD1Harness
let env: Env
let queueEvents: BusEvent[]

// Setup test router mounting all three sub-apps
const testApp = new Hono<{ Bindings: Env }>()
testApp.route('/api/sos', sosApp)
testApp.route('/api/mirror', mirrorApp)
testApp.route('/api/inkwell', inkwellApp)
testApp.route('/api/addons/sos', sosApp)
testApp.route('/api/addons/mirror', mirrorApp)
testApp.route('/api/addons/inkwell', inkwellApp)

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  queueEvents = []

  const mockQueue = {
    send: vi.fn(async (event: BusEvent) => {
      queueEvents.push(event)
    }),
  }

  env = {
    DB: harness.db,
    TENANT_SLUG: 'mumega',
    BUS: mockQueue as unknown as Env['BUS'],
    SOS_SECRET: 'test-sos-secret',
    MIRROR_SECRET: 'test-mirror-secret',
    INKWELL_SECRET: 'test-inkwell-secret',
  } as Env
})

// ── 1. Subagent Token Telemetry Service Tests ──────────────────────────────
describe('Subagent Token Telemetry (src/telemetry/subagent-usage.ts)', () => {
  it('logs token usage records into D1 subagent_token_usage table', async () => {
    const record1 = await logSubagentTokenUsage(env.DB, {
      subagentId: 'river-code',
      parentAgentId: 'river',
      modelSubstrate: '@cf/meta/llama-3.3',
      promptTokens: 500,
      completionTokens: 1200,
      taskId: 'task-001',
    })

    expect(record1.id).toBeDefined()
    expect(record1.subagent_id).toBe('river-code')
    expect(record1.parent_agent_id).toBe('river')
    expect(record1.prompt_tokens).toBe(500)
    expect(record1.completion_tokens).toBe(1200)
    expect(record1.task_id).toBe('task-001')

    const dbRow = await env.DB.prepare(
      'SELECT * FROM subagent_token_usage WHERE id = ?'
    ).bind(record1.id).first<Record<string, unknown>>()

    expect(dbRow).not.toBeNull()
    expect(dbRow?.subagent_id).toBe('river-code')
    expect(dbRow?.prompt_tokens).toBe(500)
    expect(dbRow?.completion_tokens).toBe(1200)
  })

  it('calculates total token metrics across subagents correctly', async () => {
    await logSubagentTokenUsage(env.DB, {
      subagentId: 'river-code',
      parentAgentId: 'river',
      modelSubstrate: '@cf/meta/llama-3.3',
      promptTokens: 500,
      completionTokens: 1000,
      taskId: 'task-A',
    })

    await logSubagentTokenUsage(env.DB, {
      subagentId: 'river-reviewer',
      parentAgentId: 'river',
      modelSubstrate: '@cf/meta/llama-3.3',
      promptTokens: 300,
      completionTokens: 600,
      taskId: 'task-A',
    })

    await logSubagentTokenUsage(env.DB, {
      subagentId: 'river-code',
      parentAgentId: 'river',
      modelSubstrate: '@cf/meta/llama-3.3',
      promptTokens: 200,
      completionTokens: 400,
      taskId: 'task-B',
    })

    const overallMetrics = await calculateTotalTokenMetrics(env.DB)
    expect(overallMetrics.totalPromptTokens).toBe(1000)
    expect(overallMetrics.totalCompletionTokens).toBe(2000)
    expect(overallMetrics.totalTokens).toBe(3000)
    expect(overallMetrics.recordCount).toBe(3)

    // Filter by subagent
    const codeMetrics = await getSubagentTokenMetrics(env.DB, 'river-code')
    expect(codeMetrics.totalPromptTokens).toBe(700)
    expect(codeMetrics.totalCompletionTokens).toBe(1400)
    expect(codeMetrics.totalTokens).toBe(2100)
    expect(codeMetrics.recordCount).toBe(2)

    // Filter by taskId
    const taskAMetrics = await calculateTotalTokenMetrics(env.DB, { taskId: 'task-A' })
    expect(taskAMetrics.totalPromptTokens).toBe(800)
    expect(taskAMetrics.totalCompletionTokens).toBe(1600)
    expect(taskAMetrics.totalTokens).toBe(2400)
    expect(taskAMetrics.recordCount).toBe(2)
  })

  it('lists token usage records with filtering and limits', async () => {
    await logSubagentTokenUsage(env.DB, {
      subagentId: 'river-frc',
      modelSubstrate: 'flash',
      promptTokens: 100,
      completionTokens: 200,
    })

    const list = await listSubagentTokenUsage(env.DB, { subagentId: 'river-frc' })
    expect(list).toHaveLength(1)
    expect(list[0].subagent_id).toBe('river-frc')
    expect(list[0].parent_agent_id).toBe('river')
  })
})

// ── 2. SOS Event Bus Bridge Sub-App Tests ──────────────────────────────────
describe('SOS Event Bus Bridge Sub-App (src/addons/sos.ts)', () => {
  it('GET /health returns 200 status', async () => {
    const res = await sosApp.request('/health', {}, env)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.addon).toBe('sos')
    expect(body.status).toBe('active')
  })

  it('enforces secret header authorization on publish endpoint', async () => {
    // Missing secret header -> 401
    const unauthRes = await sosApp.request('/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'task.created' }),
    }, env)
    expect(unauthRes.status).toBe(401)

    // Wrong secret token -> 401
    const wrongSecretRes = await sosApp.request('/publish', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer invalid-token',
      },
      body: JSON.stringify({ type: 'task.created' }),
    }, env)
    expect(wrongSecretRes.status).toBe(401)

    // Valid secret token -> 201
    const authRes = await sosApp.request('/publish', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer test-sos-secret',
      },
      body: JSON.stringify({ type: 'task.created', payload: { id: 't-01' } }),
    }, env)
    expect(authRes.status).toBe(201)
    expect(queueEvents).toHaveLength(1)
    expect(queueEvents[0].type).toBe('task.created')
  })

  it('returns HTTP 400 on invalid payload or json', async () => {
    const res = await sosApp.request('/publish', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-secret': 'test-sos-secret',
      },
      body: JSON.stringify({ payload: {} }), // Missing type
    }, env)
    expect(res.status).toBe(400)
    const body = await res.json() as Record<string, unknown>
    expect(body.error).toBe('invalid_payload')
  })

  it('fails closed with HTTP 500 when queue send throws an error', async () => {
    const failingBusEnv = {
      ...env,
      BUS: {
        send: vi.fn(async () => {
          throw new Error('Queue connection dropped')
        }),
      } as unknown as Env['BUS'],
    }

    const res = await sosApp.request('/publish', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-secret': 'test-sos-secret',
      },
      body: JSON.stringify({ type: 'agent.wake' }),
    }, failingBusEnv)

    expect(res.status).toBe(500)
    const body = await res.json() as Record<string, unknown>
    expect(body.error).toBe('bus_publish_failed')
    expect(body.detail).toContain('Queue connection dropped')
  })

  it('Flight F1: fails closed with HTTP 503 unconfigured_secret when SOS_SECRET is missing', async () => {
    const unconfiguredEnv = {
      DB: harness.db,
      TENANT_SLUG: 'mumega',
    } as Env

    const res = await sosApp.request('/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'test' }),
    }, unconfiguredEnv)

    expect(res.status).toBe(503)
    const body = await res.json() as Record<string, unknown>
    expect(body.error).toBe('unconfigured_secret')
  })
})

// ── 3. Mirror 16D RRF Memory Search Sub-App Tests ──────────────────────────
describe('Mirror 16D RRF Memory Search Sub-App (src/addons/mirror.ts)', () => {
  it('GET /health returns status', async () => {
    const res = await mirrorApp.request('/health', {}, env)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.engine).toBe('16d-rrf')
  })

  it('enforces secret header authorization', async () => {
    const res = await mirrorApp.request('/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'telemetry' }),
    }, env)
    expect(res.status).toBe(401)
  })

  it('Flight F1: fails closed with HTTP 503 unconfigured_secret when MIRROR_SECRET is missing', async () => {
    const unconfiguredEnv = {
      DB: harness.db,
      TENANT_SLUG: 'mumega',
    } as Env

    const res = await mirrorApp.request('/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'telemetry' }),
    }, unconfiguredEnv)

    expect(res.status).toBe(503)
    const body = await res.json() as Record<string, unknown>
    expect(body.error).toBe('unconfigured_secret')
  })

  it('stores engrams and performs 16D RRF memory search', async () => {
    // 1. Store engrams via POST /engrams
    const storeRes1 = await mirrorApp.request('/engrams', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer test-mirror-secret',
      },
      body: JSON.stringify({
        text: 'Hono edge route synthesis and Vitest integration test suite',
        agent_id: 'river-code',
        concepts: ['hono', 'vitest', 'testing'],
      }),
    }, env)
    expect(storeRes1.status).toBe(201)

    const storeRes2 = await mirrorApp.request('/engrams', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-secret': 'test-mirror-secret',
      },
      body: JSON.stringify({
        text: 'Cloudflare workerd edge sub-apps and fail-closed D1 storage',
        agent_id: 'river-code',
        concepts: ['cloudflare', 'd1'],
      }),
    }, env)
    expect(storeRes2.status).toBe(201)

    // 2. Perform RRF memory search
    const searchRes = await mirrorApp.request('/search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer test-mirror-secret',
      },
      body: JSON.stringify({ query: 'Vitest integration' }),
    }, env)

    expect(searchRes.status).toBe(200)
    const body = await searchRes.json() as { ok: boolean; hits: Array<{ text: string; rrfScore: number }> }
    expect(body.ok).toBe(true)
    expect(body.hits.length).toBeGreaterThan(0)
    expect(body.hits[0].text).toContain('Vitest integration')
    expect(body.hits[0].rrfScore).toBeGreaterThan(0)
  })

  it('returns HTTP 400 on invalid query payload', async () => {
    const res = await mirrorApp.request('/search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-secret': 'test-mirror-secret',
      },
      body: JSON.stringify({ query: '' }),
    }, env)
    expect(res.status).toBe(400)
  })

  it('fails closed with HTTP 500 when database statement fails', async () => {
    const brokenDbEnv = {
      ...env,
      DB: {
        prepare: () => {
          throw new Error('D1 execution fatal error')
        },
      } as unknown as Env['DB'],
    }

    const res = await mirrorApp.request('/search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-secret': 'test-mirror-secret',
      },
      body: JSON.stringify({ query: 'test' }),
    }, brokenDbEnv)

    expect(res.status).toBe(500)
    const body = await res.json() as Record<string, unknown>
    expect(body.error).toBe('mirror_search_failed')
  })
})

// ── 4. Inkwell Publishing Sub-App Tests ─────────────────────────────────────
describe('Inkwell Publishing Sub-App (src/addons/inkwell.ts)', () => {
  it('GET /health returns 200 status', async () => {
    const res = await inkwellApp.request('/health', {}, env)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.addon).toBe('inkwell')
  })

  it('enforces secret header authorization', async () => {
    const res = await inkwellApp.request('/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'T', slug: 's', content: 'c' }),
    }, env)
    expect(res.status).toBe(401)
  })

  it('Flight F1: fails closed with HTTP 503 unconfigured_secret when INKWELL_SECRET is missing', async () => {
    const unconfiguredEnv = {
      DB: harness.db,
      TENANT_SLUG: 'mumega',
    } as Env

    const res = await inkwellApp.request('/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'T', slug: 's', content: 'c' }),
    }, unconfiguredEnv)

    expect(res.status).toBe(503)
    const body = await res.json() as Record<string, unknown>
    expect(body.error).toBe('unconfigured_secret')
  })

  it('publishes content and creates draft items', async () => {
    // POST /publish
    const pubRes = await inkwellApp.request('/publish', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer test-inkwell-secret',
      },
      body: JSON.stringify({
        title: 'Sovereign Addons Architecture',
        slug: 'v028-sovereign-addons',
        content: 'Mupot v0.28 introduces modular sub-apps and token telemetry.',
        targetSite: 'mumega.com',
      }),
    }, env)

    expect(pubRes.status).toBe(201)
    const pubBody = await pubRes.json() as { ok: boolean; publicationId: string; url: string; status: string }
    expect(pubBody.ok).toBe(true)
    expect(pubBody.publicationId).toContain('ink-')
    expect(pubBody.url).toBe('https://mumega.com/v028-sovereign-addons')
    expect(pubBody.status).toBe('published')

    // POST /draft
    const draftRes = await inkwellApp.request('/draft', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-secret': 'test-inkwell-secret',
      },
      body: JSON.stringify({
        title: 'Draft Post',
        slug: 'draft-post',
        content: 'Work in progress content...',
      }),
    }, env)

    expect(draftRes.status).toBe(200)
    const draftBody = await draftRes.json() as { ok: boolean; status: string }
    expect(draftBody.ok).toBe(true)
    expect(draftBody.status).toBe('draft')
  })

  it('returns HTTP 400 when required fields are missing', async () => {
    const res = await inkwellApp.request('/publish', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-secret': 'test-inkwell-secret',
      },
      body: JSON.stringify({ title: 'No Content' }),
    }, env)
    expect(res.status).toBe(400)
    const body = await res.json() as Record<string, unknown>
    expect(body.error).toBe('invalid_payload')
  })

  it('fails closed with HTTP 500 when service fetcher throws an error', async () => {
    const failingServiceEnv = {
      ...env,
      INKWELL_SVC: {
        fetch: vi.fn(async () => {
          throw new Error('Inkwell worker unreachable')
        }),
      } as unknown as Env['INKWELL_SVC'],
    }

    const res = await inkwellApp.request('/publish', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-secret': 'test-inkwell-secret',
      },
      body: JSON.stringify({ title: 'Title', slug: 'slug', content: 'Content' }),
    }, failingServiceEnv)

    expect(res.status).toBe(500)
    const body = await res.json() as Record<string, unknown>
    expect(body.error).toBe('publishing_failed')
    expect(body.detail).toContain('Inkwell worker unreachable')
  })
})

// ── 5. Main App Route Mounting Integration Tests ────────────────────────────
describe('App Route Mounting Integration', () => {
  it('routes /api/sos, /api/mirror, /api/inkwell via testApp router', async () => {
    const sosRes = await testApp.request('http://localhost/api/sos/health', {}, env)
    expect(sosRes.status).toBe(200)
    expect((await sosRes.json() as Record<string, unknown>).addon).toBe('sos')

    const mirrorRes = await testApp.request('http://localhost/api/mirror/health', {}, env)
    expect(mirrorRes.status).toBe(200)
    expect((await mirrorRes.json() as Record<string, unknown>).addon).toBe('mirror')

    const inkwellRes = await testApp.request('http://localhost/api/inkwell/health', {}, env)
    expect(inkwellRes.status).toBe(200)
    expect((await inkwellRes.json() as Record<string, unknown>).addon).toBe('inkwell')
  })

  it('routes /api/addons/sos, /api/addons/mirror, /api/addons/inkwell via testApp router', async () => {
    const sosRes = await testApp.request('http://localhost/api/addons/sos/health', {}, env)
    expect(sosRes.status).toBe(200)

    const mirrorRes = await testApp.request('http://localhost/api/addons/mirror/health', {}, env)
    expect(mirrorRes.status).toBe(200)

    const inkwellRes = await testApp.request('http://localhost/api/addons/inkwell/health', {}, env)
    expect(inkwellRes.status).toBe(200)
  })
})
