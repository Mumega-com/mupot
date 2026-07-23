import { describe, expect, it, vi } from 'vitest'
import { CURSOR_AGENTS_API_VERSION, CURSOR_AGENTS_PATH, probeCursorApiVersions } from '../src/runtime/vendor-cloud/api-version'
import {
  awaitPollSseCompletion,
  createVendorCloudAdapterDeps,
  launchClaudeManagedWork,
  launchCursorBackgroundWork,
} from '../src/runtime/vendor-cloud/adapter'
import { buildSignedAttachBackPlan } from '../src/runtime/vendor-cloud/attach-back'
import { parseCursorLaunchResponse } from '../src/runtime/vendor-cloud/cursor-client'

describe('Cursor v1 launch', () => {
  it('pins launch path to live-verified v1', () => {
    expect(CURSOR_AGENTS_API_VERSION).toBe('v1')
    expect(CURSOR_AGENTS_PATH).toBe('/v1/agents')
  })

  it('probeCursorApiVersions prefers v1 when both routes exist', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const path = String(url)
      if (path.includes('/v1/agents') || path.includes('/v0/agents')) {
        return new Response(JSON.stringify({ code: 'error', message: 'Invalid User API Key' }), {
          status: 401,
        })
      }
      return new Response('missing', { status: 404 })
    }) as unknown as typeof fetch
    const probe = await probeCursorApiVersions(fetchImpl)
    expect(probe.preferredLaunchVersion).toBe('v1')
    expect(probe.cursorV1Agents).toBe(401)
    expect(probe.webhookOnV1).toBe('coming_soon_per_docs')
  })

  it('launchCursorBackgroundWork POSTs /v1/agents with repo/branch + attach instructions', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null
      calls.push({ url: String(url), body })
      return new Response(
        JSON.stringify({
          agent: { id: 'bc-111', status: 'ACTIVE' },
          run: { id: 'run-222', status: 'CREATING' },
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const deps = createVendorCloudAdapterDeps(fetchImpl, async () => undefined)
    const bundle = await launchCursorBackgroundWork(deps, {
      apiKey: 'ck_test',
      promptText: 'Fix the bug',
      repositoryUrl: 'https://github.com/org/repo',
      startingRef: 'main',
      modelId: null,
      autoCreatePr: false,
      potBaseUrl: 'https://pot.example.com',
      agentId: 'agent-1',
      tenant: 'mumega',
      taskId: 'task-9',
      gateOwner: 'gate:kasra-core',
      webhookUrl: 'https://pot.example.com/api/runtime/vendor-cloud/cursor/webhook',
      webhookSecret: 'whsec',
      pollIntervalMs: 1000,
      timeoutMs: 60_000,
      envVars: null,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.cursor.com/v1/agents')
    const body = calls[0]!.body as {
      prompt: { text: string }
      repos: Array<{ url: string; startingRef: string }>
      webhook: { url: string; secret: string }
    }
    expect(body.repos[0]).toEqual({
      url: 'https://github.com/org/repo',
      startingRef: 'main',
    })
    expect(body.prompt.text).toContain('fleet-attach:v1')
    expect(body.prompt.text).toContain('/api/fleet/attach-signed')
    expect(body.prompt.text).toContain('NEVER merge')
    expect(body.webhook).toEqual({
      url: 'https://pot.example.com/api/runtime/vendor-cloud/cursor/webhook',
      secret: 'whsec',
    })
    expect(bundle.completionPort.kind).toBe('webhook')
    expect(bundle.attachPlan.signedAttachDomain).toBe('fleet-attach:v1')
    expect(bundle.attachPlan.runtime).toBe('cursor')
    expect((bundle.launch as { apiVersion: string }).apiVersion).toBe('v1')
  })

  it('parseCursorLaunchResponse reads agent+run ids', () => {
    const parsed = parseCursorLaunchResponse({
      agent: { id: 'bc-a', status: 'ACTIVE' },
      run: { id: 'run-b', status: 'RUNNING' },
    })
    expect(parsed).toMatchObject({ agentId: 'bc-a', runId: 'run-b', apiVersion: 'v1' })
  })
})

describe('Claude Managed Agents poll/SSE launch path', () => {
  it('launches agents→environments→sessions→events and forces poll_sse', async () => {
    const paths: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url)
      paths.push(u.replace('https://api.anthropic.com', ''))
      if (u.endsWith('/v1/agents')) {
        return new Response(JSON.stringify({ id: 'agent_1' }), { status: 200 })
      }
      if (u.endsWith('/v1/environments')) {
        return new Response(JSON.stringify({ id: 'env_1' }), { status: 200 })
      }
      if (u.endsWith('/v1/sessions')) {
        return new Response(JSON.stringify({ id: 'sess_1' }), { status: 200 })
      }
      if (u.includes('/events')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      return new Response('nope', { status: 404 })
    }) as unknown as typeof fetch

    const deps = createVendorCloudAdapterDeps(fetchImpl, async () => undefined)
    const bundle = await launchClaudeManagedWork(deps, {
      apiKey: 'sk-ant',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: 'You are a technician.',
      userMessage: 'Implement the fix',
      potBaseUrl: 'https://pot.example.com',
      agentId: 'agent-cma',
      tenant: 'mumega',
      taskId: 'task-cma',
      gateOwner: 'gate:kasra-core',
      pollIntervalMs: 100,
      timeoutMs: 10_000,
    })

    expect(paths).toEqual([
      '/v1/agents',
      '/v1/environments',
      '/v1/sessions',
      '/v1/sessions/sess_1/events',
    ])
    expect(bundle.completionPort.kind).toBe('poll_sse')
    expect(bundle.attachPlan.runtime).toBe('claude-code')
    expect(bundle.attachPlan.instructions).toContain('fleet-attach:v1')
  })

  it('awaitPollSseCompletion lands at review for CMA', async () => {
    let polls = 0
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('/v1/sessions/sess_1') && !String(url).includes('/events')) {
        polls += 1
        const status = polls < 2 ? 'running' : 'completed'
        return new Response(JSON.stringify({ id: 'sess_1', status }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    const deps = createVendorCloudAdapterDeps(fetchImpl, async () => undefined)
    const bundle = {
      vendor: 'claude-managed' as const,
      launch: {
        agentId: 'agent_1',
        environmentId: 'env_1',
        sessionId: 'sess_1',
        raw: {},
      },
      attachPlan: buildSignedAttachBackPlan(
        'claude-managed',
        'https://pot.example.com',
        'a1',
        't',
        'task',
      ),
      completionPort: {
        kind: 'poll_sse' as const,
        vendor: 'claude-managed' as const,
        pollIntervalMs: 1,
        timeoutMs: 5_000,
      },
      gateOwner: 'gate:kasra-core',
    }
    const { event, land } = await awaitPollSseCompletion(deps, bundle, 'sk-ant')
    expect(event.status).toBe('FINISHED')
    expect(land.status).toBe('review')
    expect(land.forbidden).toContain('merge')
  })
})

describe('signed attach-back plan', () => {
  it('documents PR-comment-delivery risk and review-only rails', () => {
    const plan = buildSignedAttachBackPlan(
      'cursor-background',
      'https://pot.example.com',
      'agent-x',
      'mumega',
      'task-x',
    )
    expect(plan.contractId).toBe('runtime-adapter/v1')
    expect(plan.signedAttachDomain).toBe('fleet-attach:v1')
    expect(plan.path).toBe('/api/fleet/attach-signed')
    expect(plan.instructions).toMatch(/PR-comment delivery/)
    expect(plan.instructions).toMatch(/NEVER merge/)
  })
})
