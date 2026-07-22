// mupot — Workflow port adapters (Port 5).
//
// Each adapter implements the same run() contract. CF is the pot-native default
// (TASK_WORKFLOW / startTaskPipeline). n8n / zapier / make POST a webhook URL
// after the gate approves — secrets stay in Worker env, never in act payloads.

import type { Env } from '../types'
import { assertPublicHttpsUrl } from '../lib/ssrf'
import type {
  WorkflowAdapterKind,
  WorkflowRunInput,
  WorkflowRunResult,
} from './port'

export interface WorkflowAdapterDeps {
  fetch?: typeof fetch
  /** Override webhook URL resolution (tests). */
  resolveWebhookUrl?: (env: Env, kind: WorkflowAdapterKind, payloadUrl: string | undefined) => string | null
}

interface WorkflowAdapter {
  readonly kind: WorkflowAdapterKind
  run(env: Env, input: WorkflowRunInput, deps: WorkflowAdapterDeps): Promise<WorkflowRunResult>
}

/** Env keys holding the default webhook URL per external adapter. */
const WEBHOOK_ENV_KEYS: Record<Exclude<WorkflowAdapterKind, 'cf'>, keyof WorkflowSecrets> = {
  n8n: 'N8N_WEBHOOK_URL',
  zapier: 'ZAPIER_WEBHOOK_URL',
  make: 'MAKE_WEBHOOK_URL',
}

interface WorkflowSecrets {
  N8N_WEBHOOK_URL?: string
  ZAPIER_WEBHOOK_URL?: string
  MAKE_WEBHOOK_URL?: string
  N8N_WEBHOOK_AUTH?: string
  ZAPIER_WEBHOOK_AUTH?: string
  MAKE_WEBHOOK_AUTH?: string
}

function workflowSecrets(env: Env): WorkflowSecrets {
  return env as unknown as WorkflowSecrets
}

/**
 * Resolve the webhook URL: payload override (if present) else env default.
 * Returns null when neither is set — caller fails closed as not_configured.
 */
export function resolveWebhookUrl(
  env: Env,
  kind: WorkflowAdapterKind,
  payloadUrl: string | undefined,
): string | null {
  if (kind === 'cf') return null
  if (typeof payloadUrl === 'string' && payloadUrl.trim().length > 0) {
    return payloadUrl.trim()
  }
  const key = WEBHOOK_ENV_KEYS[kind]
  const fromEnv = workflowSecrets(env)[key]
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  return null
}

function authHeaderFor(env: Env, kind: WorkflowAdapterKind): string | null {
  if (kind === 'cf') return null
  const secrets = workflowSecrets(env)
  const map: Record<Exclude<WorkflowAdapterKind, 'cf'>, string | undefined> = {
    n8n: secrets.N8N_WEBHOOK_AUTH,
    zapier: secrets.ZAPIER_WEBHOOK_AUTH,
    make: secrets.MAKE_WEBHOOK_AUTH,
  }
  const auth = map[kind]
  return typeof auth === 'string' && auth.length > 0 ? auth : null
}

/**
 * POST the gated act to an external webhook manager (n8n / zapier / make).
 * SSRF-guards the URL. Never logs auth headers or webhook secrets.
 */
async function runWebhookAdapter(
  env: Env,
  input: WorkflowRunInput,
  deps: WorkflowAdapterDeps,
): Promise<WorkflowRunResult> {
  const resolve = deps.resolveWebhookUrl ?? resolveWebhookUrl
  const rawUrl = resolve(env, input.adapter, input.payload.webhook_url)
  if (!rawUrl) {
    return { ok: false, status: 'not_configured', detail: `${input.adapter}_webhook_not_configured` }
  }

  let url: URL
  try {
    url = assertPublicHttpsUrl(rawUrl)
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'url_invalid'
    return { ok: false, status: 'failed', detail: `webhook_${reason}` }
  }

  const doFetch = deps.fetch ?? fetch
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': 'mupot-workflow-port/1 (+gated-act)',
  }
  const auth = authHeaderFor(env, input.adapter)
  if (auth) headers.authorization = auth

  const body = {
    source: 'mupot',
    adapter: input.adapter,
    task_id: input.taskId,
    act_id: input.actId,
    label: input.payload.label ?? null,
    payload: input.payload.body ?? {},
  }

  let response: Response
  try {
    response = await doFetch(url.toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'manual', // SSRF defense-in-depth: never follow redirects
    })
  } catch {
    return { ok: false, status: 'failed', detail: 'webhook_fetch_failed' }
  }

  if (response.status >= 200 && response.status < 300) {
    let externalRef: string | undefined
    try {
      const json: unknown = await response.json()
      if (json && typeof json === 'object' && !Array.isArray(json)) {
        const rec = json as Record<string, unknown>
        const id = rec.executionId ?? rec.id ?? rec.execution_id
        if (typeof id === 'string' && id.length > 0 && id.length <= 128) {
          externalRef = id
        }
      }
    } catch {
      // Non-JSON 2xx is still success — many webhook managers return empty bodies.
    }
    return {
      ok: true,
      status: 'ok',
      detail: `http_${response.status}`,
      externalRef,
    }
  }

  // Sanitize: status code only — never echo response body (may contain secrets).
  return { ok: false, status: 'failed', detail: `http_${response.status}` }
}

/** CF adapter: external-act queue does not start pipelines; use /pipeline. */
const cfAdapter: WorkflowAdapter = {
  kind: 'cf',
  async run(_env, _input, _deps): Promise<WorkflowRunResult> {
    return {
      ok: false,
      status: 'not_configured',
      detail: 'cf_use_task_pipeline',
    }
  },
}

function webhookAdapter(kind: Exclude<WorkflowAdapterKind, 'cf'>): WorkflowAdapter {
  return {
    kind,
    run: (env, input, deps) => runWebhookAdapter(env, { ...input, adapter: kind }, deps),
  }
}

const ADAPTERS: Record<WorkflowAdapterKind, WorkflowAdapter> = {
  cf: cfAdapter,
  n8n: webhookAdapter('n8n'),
  zapier: webhookAdapter('zapier'),
  make: webhookAdapter('make'),
}

export function getWorkflowAdapter(kind: WorkflowAdapterKind): WorkflowAdapter {
  return ADAPTERS[kind]
}
