// tests/workflow-port.test.ts — Module Kernel Port 5:
// gated n8n workflow act → approved verdict → receipt.
//
// DONE WHEN: an external n8n workflow runs as a gated mupot act and returns a receipt.

import { describe, expect, it, vi } from 'vitest'
import { wireGatedAct } from '../src/loops/gate'
import type { LoopManifest } from '../src/loops/manifest'
import {
  createWorkflowAct,
  runApprovedWorkflowActs,
} from '../src/workflows/acts'
import { resolveWebhookUrl } from '../src/workflows/adapters'
import { marketingN8nWorkflowAct } from '../src/workflows/marketing'
import {
  isWorkflowActTool,
  resolveWorkflowAdapter,
  WORKFLOW_PORT_VERSION,
} from '../src/workflows/port'
import { getSurfacePanel, listSurfacePanels } from '../src/surfaces/port'
import '../src/surfaces/hermes'
import type { Env } from '../src/types'

const TASK_ID = 'task-wf-1'
const ACT_ID = 'act-wf-1'
const VERDICT_ID = 'verdict-wf-1'
const WEBHOOK = 'https://n8n.example.com/webhook/mupot-gate'

function makeLoop(over: Partial<LoopManifest> = {}): LoopManifest {
  return {
    id: 'loop-marketing',
    tenant: 't',
    squad_id: 'sq-marketing',
    agent_id: null,
    status: 'active',
    okr: 'grow conversions',
    kpi: { signal: 'avg_conversion_bps', target: 500 },
    sources: [],
    channels: [],
    gate: { require_approval: true },
    budget: {},
    cadence: {},
    stop: {},
    created_at: 'x',
    ...over,
  }
}

interface D1Opts {
  pendingActs?: Array<{ id: string; adapter: string; payload: string }>
  claimChanges?: number
}

function makeD1(opts: D1Opts = {}) {
  const writes: Array<{ sql: string; binds: unknown[] }> = []
  const pending = opts.pendingActs ?? []
  const claimChanges = opts.claimChanges ?? 1

  return {
    writes,
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return this
        },
        async first<T>() {
          if (sql.includes('FROM tasks') && sql.includes('project_id')) {
            return { project_id: 'proj-1' } as T
          }
          return null as T
        },
        async all<T>() {
          if (sql.includes('FROM workflow_acts') && sql.includes("status = 'pending'")) {
            if (sql.includes('SELECT id, adapter, payload')) {
              return { results: pending as T[] }
            }
            return { results: pending.map((a) => ({ id: a.id })) as T[] }
          }
          return { results: [] as T[] }
        },
        async run() {
          writes.push({ sql, binds: [] })
          const changes = sql.includes("status = 'sending'") ? claimChanges : 1
          return { meta: { changes } }
        },
      }
    },
  }
}

describe('workflow port contract', () => {
  it('exports WORKFLOW_PORT_VERSION = 1', () => {
    expect(WORKFLOW_PORT_VERSION).toBe(1)
  })

  it('recognizes workflow act tools', () => {
    expect(isWorkflowActTool('n8n_run_workflow')).toBe(true)
    expect(isWorkflowActTool('run_workflow')).toBe(true)
    expect(isWorkflowActTool('send_email')).toBe(false)
  })

  it('n8n_run_workflow pins the n8n adapter', () => {
    expect(resolveWorkflowAdapter('n8n_run_workflow', {})).toBe('n8n')
    expect(resolveWorkflowAdapter('run_workflow', { adapter: 'zapier' })).toBe('zapier')
    expect(resolveWorkflowAdapter('run_workflow', {})).toBe('n8n')
  })
})

describe('marketing proving-ground act', () => {
  it('builds a gated n8n_run_workflow ProposedAct', () => {
    const act = marketingN8nWorkflowAct({
      summary: 'CRO: fire n8n enrichment for /pricing',
      label: 'pricing-enrichment',
      body: { slug: 'pricing', conversion_bps: 80 },
      webhook_url: WEBHOOK,
    })
    expect(act.tool).toBe('n8n_run_workflow')
    expect(act.channel_index).toBe(-1)
    expect(act.args.adapter).toBe('n8n')
    expect(act.args.webhook_url).toBe(WEBHOOK)
    expect((act.args.body as { slug: string }).slug).toBe('pricing')
  })
})

describe('wireGatedAct — workflow tools', () => {
  it('queues a pending workflow_act for n8n_run_workflow (marketing proving ground)', async () => {
    const createTask = vi.fn(async () => ({ id: TASK_ID, squad_id: 'sq-marketing' }) as never)
    const createOutboundAct = vi.fn(async () => ({ id: 'ghl-x' }))
    const createWorkflowAct = vi.fn(async () => ({ id: ACT_ID }))
    const act = marketingN8nWorkflowAct({
      summary: 'Run n8n marketing workflow',
      label: 'mkt-n8n',
      body: { campaign: 'cro' },
      webhook_url: WEBHOOK,
    })

    await wireGatedAct(
      { TENANT_SLUG: 't' } as unknown as Env,
      makeLoop(),
      act,
      { createTask, createOutboundAct, createWorkflowAct },
    )

    expect(createTask).toHaveBeenCalledTimes(1)
    expect(createOutboundAct).not.toHaveBeenCalled()
    expect(createWorkflowAct).toHaveBeenCalledWith(
      expect.anything(),
      TASK_ID,
      'n8n',
      expect.objectContaining({
        label: 'mkt-n8n',
        webhook_url: WEBHOOK,
        body: { campaign: 'cro' },
      }),
    )
    const [, input, options] = createTask.mock.calls[0]
    expect(input.status).toBe('review')
    expect(input.gate_owner).toBe('gate:loops')
    expect(options?.skipMirror).toBe(true)
  })
})

describe('runApprovedWorkflowActs — gated n8n → receipt', () => {
  it('refuses pending acts when verdict is not approved (fetch never called)', async () => {
    const fetchFn = vi.fn()
    const db = makeD1({
      pendingActs: [
        {
          id: ACT_ID,
          adapter: 'n8n',
          payload: JSON.stringify({ webhook_url: WEBHOOK, label: 'x' }),
        },
      ],
    })
    const env = { TENANT_SLUG: 't', DB: db as unknown as Env['DB'] } as Env

    const result = await runApprovedWorkflowActs(env, TASK_ID, {
      readLatestVerdict: async () => ({ id: VERDICT_ID, verdict: 'rejected' }),
      fetch: fetchFn as unknown as typeof fetch,
    })

    expect(fetchFn).not.toHaveBeenCalled()
    expect(result.reason).toBe('gate_not_approved')
    expect(result.refused).toBe(1)
    expect(result.receipts).toEqual([])
  })

  it('fails closed (not_configured) when no webhook URL is set — leaves act pending', async () => {
    const fetchFn = vi.fn()
    const db = makeD1({
      pendingActs: [
        {
          id: ACT_ID,
          adapter: 'n8n',
          payload: JSON.stringify({ label: 'no-url' }),
        },
      ],
    })
    const env = { TENANT_SLUG: 't', DB: db as unknown as Env['DB'] } as Env

    const result = await runApprovedWorkflowActs(env, TASK_ID, {
      readLatestVerdict: async () => ({ id: VERDICT_ID, verdict: 'approved' }),
      fetch: fetchFn as unknown as typeof fetch,
    })

    expect(fetchFn).not.toHaveBeenCalled()
    expect(result.reason).toBe('not_configured')
    expect(result.sent).toBe(0)
  })

  it('DONE WHEN: approved verdict + n8n 2xx → act sent + workflow_receipt returned', async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ executionId: 'exec-9' }), { status: 200 }),
    )
    const receipts: string[] = []
    const db = makeD1({
      pendingActs: [
        {
          id: ACT_ID,
          adapter: 'n8n',
          payload: JSON.stringify({
            webhook_url: WEBHOOK,
            label: 'pricing-enrichment',
            body: { slug: 'pricing' },
          }),
        },
      ],
    })
    const env = {
      TENANT_SLUG: 't',
      DB: db as unknown as Env['DB'],
    } as Env

    const result = await runApprovedWorkflowActs(env, TASK_ID, {
      readLatestVerdict: async () => ({ id: VERDICT_ID, verdict: 'approved' }),
      fetch: fetchFn as unknown as typeof fetch,
      writeReceipt: async (_env, row) => {
        expect(row.stepName).toBe('adapter-run')
        expect(row.status).toBe('ok')
        expect(row.instanceId).toBe(ACT_ID)
        const id = 'receipt-wf-1'
        receipts.push(id)
        return id
      },
    })

    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe(WEBHOOK)
    expect((init as RequestInit).method).toBe('POST')
    expect((init as RequestInit).redirect).toBe('manual')
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.source).toBe('mupot')
    expect(body.adapter).toBe('n8n')
    expect(body.task_id).toBe(TASK_ID)
    expect(body.act_id).toBe(ACT_ID)

    expect(result.ok).toBe(true)
    expect(result.sent).toBe(1)
    expect(result.failed).toBe(0)
    expect(result.receipts).toEqual(['receipt-wf-1'])
    expect(receipts).toEqual(['receipt-wf-1'])
  })

  it('blocks private webhook hosts (SSRF)', async () => {
    const fetchFn = vi.fn()
    const db = makeD1({
      pendingActs: [
        {
          id: ACT_ID,
          adapter: 'n8n',
          payload: JSON.stringify({ webhook_url: 'https://127.0.0.1/hook' }),
        },
      ],
    })
    const env = { TENANT_SLUG: 't', DB: db as unknown as Env['DB'] } as Env

    const result = await runApprovedWorkflowActs(env, TASK_ID, {
      readLatestVerdict: async () => ({ id: VERDICT_ID, verdict: 'approved' }),
      fetch: fetchFn as unknown as typeof fetch,
    })

    expect(fetchFn).not.toHaveBeenCalled()
    expect(result.failed).toBe(1)
    expect(result.sent).toBe(0)
  })
})

describe('resolveWebhookUrl', () => {
  it('prefers payload URL, else env N8N_WEBHOOK_URL', () => {
    const env = { N8N_WEBHOOK_URL: 'https://n8n.env/hook' } as unknown as Env
    expect(resolveWebhookUrl(env, 'n8n', WEBHOOK)).toBe(WEBHOOK)
    expect(resolveWebhookUrl(env, 'n8n', undefined)).toBe('https://n8n.env/hook')
    expect(resolveWebhookUrl({} as Env, 'n8n', undefined)).toBeNull()
  })
})

describe('createWorkflowAct', () => {
  it('rejects queuing the cf adapter (use /pipeline)', async () => {
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }),
        }),
      },
    } as unknown as Env
    await expect(createWorkflowAct(env, TASK_ID, 'cf', {})).rejects.toMatchObject({
      code: 'cf_adapter_not_queued',
    })
  })
})

describe('surface port — Hermes panel', () => {
  it('registers the Hermes dashboard as a mupot surface panel', () => {
    const panel = getSurfacePanel('hermes')
    expect(panel).toBeDefined()
    expect(panel?.path).toBe('/surfaces/hermes')
    expect(panel?.adapter).toBe('hermes')
    expect(panel?.externalUrlEnvKey).toBe('HERMES_DASHBOARD_URL')
    expect(listSurfacePanels().some((p) => p.id === 'hermes')).toBe(true)
  })
})
