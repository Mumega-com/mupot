#!/usr/bin/env node
// fleet-runtime cutover probe — queue live Mupot evidence for receipt-bundle.
//
// This command does not prove host execution by itself. It queues the inputs
// that runtime-receipt.mjs and control-receipt.mjs need to observe: a durable
// inbox probe message for the target agent and signed lifecycle control requests
// for the host control daemon. Tokens are read from environment variables and
// are never echoed in the receipt.

import { randomUUID } from 'node:crypto'

const CONTROL_VERBS = new Set(['start', 'stop', 'restart', 'status'])
const MESSAGE_KINDS = new Set(['message', 'request', 'ack'])
const DEFAULT_AGENT_TOKEN_ENV = 'MUPOT_AGENT_TOKEN'
const DEFAULT_OWNER_TOKEN_ENV = 'MUPOT_OWNER_TOKEN'
const HTTP_TIMEOUT_MS = 8000

function splitValues(v) {
  return String(v).split(',').map((s) => s.trim()).filter(Boolean)
}

function parseArgs(argv) {
  const opts = {
    baseUrl: process.env.MUPOT_BASE_URL ?? '',
    agent: '',
    queueInbox: false,
    controls: [],
    body: '',
    kind: 'request',
    requestId: '',
    agentTokenEnv: DEFAULT_AGENT_TOKEN_ENV,
    ownerTokenEnv: DEFAULT_OWNER_TOKEN_ENV,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) throw new Error(`${arg} requires a value`)
      return argv[i]
    }
    if (arg === '--base-url') opts.baseUrl = next()
    else if (arg === '--agent') opts.agent = next()
    else if (arg === '--queue-inbox') opts.queueInbox = true
    else if (arg === '--control') {
      const verbs = splitValues(next())
      for (const verb of verbs) {
        if (!CONTROL_VERBS.has(verb)) throw new Error(`unsupported control verb: ${verb}`)
      }
      opts.controls.push(...verbs)
    } else if (arg === '--body') opts.body = next()
    else if (arg === '--kind') {
      const kind = next()
      if (!MESSAGE_KINDS.has(kind)) throw new Error(`unsupported message kind: ${kind}`)
      opts.kind = kind
    } else if (arg === '--request-id') opts.requestId = next()
    else if (arg === '--agent-token-env') opts.agentTokenEnv = next()
    else if (arg === '--owner-token-env') opts.ownerTokenEnv = next()
    else if (arg === '--help' || arg === '-h') opts.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return opts
}

function usage() {
  return [
    'Usage: node fleet-runtime/cutover-probe.mjs --base-url <url> --agent <id-or-slug> [options]',
    '',
    'Options:',
    '  --queue-inbox                 queue one durable inbox probe message for the target agent',
    '  --control <verb>              queue lifecycle control; repeat or comma-separate values: start, stop, restart, status',
    '  --body <text>                 inbox probe body (default: generated cutover probe text)',
    '  --kind <kind>                 inbox message kind; message, request, or ack (default: request)',
    '  --request-id <id>             idempotency id prefix; defaults to a generated cutover-probe id',
    `  --agent-token-env <name>      env var holding welded sender token (default: ${DEFAULT_AGENT_TOKEN_ENV})`,
    `  --owner-token-env <name>      env var holding owner token for /api/fleet/control (default: ${DEFAULT_OWNER_TOKEN_ENV})`,
    '  -h, --help                    show this help',
    '',
    'Examples:',
    '  export MUPOT_AGENT_TOKEN',
    '  export MUPOT_OWNER_TOKEN',
    '  node ~/.fleet/runtime/cutover-probe.mjs --base-url https://mupot.example.com --agent my-agent --queue-inbox --control start',
    '  node ~/.fleet/runtime/cutover-probe.mjs --base-url https://mupot.example.com --agent my-agent --control stop',
  ].join('\n')
}

function normalizeBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
    return { ok: false, reason: 'base_url_required' }
  }
  try {
    const url = new URL(baseUrl.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'base_url_must_be_http' }
    return { ok: true, value: url.toString().replace(/\/$/, '') }
  } catch {
    return { ok: false, reason: 'base_url_invalid' }
  }
}

function summarize(checks) {
  const failed = checks.filter((c) => c.ok === false)
  const warnings = checks.filter((c) => c.ok === null)
  return {
    status: failed.length > 0 ? 'fail' : warnings.length > 0 ? 'warn' : 'pass',
    passed: checks.length - failed.length - warnings.length,
    failed: failed.length,
    warnings: warnings.length,
  }
}

async function postJson(fetchImpl, url, token, body) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text }
  }
  return { ok: res.ok, status: res.status, json }
}

function generatedRequestId(prefix, suffix) {
  return `${prefix}-${suffix}`
}

function defaultBody(agent, requestId) {
  return `mupot cutover probe for ${agent} (${requestId})`
}

export async function buildReceipt(opts) {
  const checks = []
  const fetchImpl = opts.fetchImpl ?? fetch
  const env = opts.env ?? process.env
  const now = opts.now ?? (() => new Date().toISOString())
  const generatedAt = now()
  const requestIdBase = opts.requestId || `cutover-probe-${randomUUID()}`
  const normalized = normalizeBaseUrl(opts.baseUrl)

  checks.push({
    ok: normalized.ok,
    component: 'cutover-probe',
    check: 'base_url_valid',
    reason: normalized.ok ? undefined : normalized.reason,
  })
  checks.push({
    ok: typeof opts.agent === 'string' && opts.agent.length > 0,
    component: 'cutover-probe',
    check: 'target_agent_present',
    agent: opts.agent || null,
  })
  checks.push({
    ok: opts.queueInbox || (opts.controls ?? []).length > 0,
    component: 'cutover-probe',
    check: 'probe_action_selected',
  })

  const actions = []

  if (normalized.ok && opts.agent && opts.queueInbox) {
    const token = env[opts.agentTokenEnv || DEFAULT_AGENT_TOKEN_ENV]
    checks.push({
      ok: typeof token === 'string' && token.length > 0,
      component: 'cutover-probe',
      check: 'agent_token_present',
      env: opts.agentTokenEnv || DEFAULT_AGENT_TOKEN_ENV,
    })
    if (token) {
      const requestId = generatedRequestId(requestIdBase, 'inbox')
      const body = {
        to: opts.agent,
        body: opts.body || defaultBody(opts.agent, requestId),
        kind: opts.kind || 'request',
        request_id: requestId,
      }
      try {
        const result = await postJson(fetchImpl, `${normalized.value}/api/inbox/send`, token, body)
        const ok = result.ok && result.json?.ok === true
        checks.push({
          ok,
          component: 'cutover-probe',
          check: 'inbox_probe_queued',
          status: result.status,
          response_ok: result.json?.ok ?? null,
          error: ok ? undefined : result.json?.error ?? null,
          detail: ok ? undefined : result.json?.detail ?? null,
        })
        actions.push({
          kind: 'inbox_probe',
          target_agent: opts.agent,
          request_id: requestId,
          status: result.status,
          ok,
          response: result.json,
        })
      } catch (err) {
        checks.push({
          ok: false,
          component: 'cutover-probe',
          check: 'inbox_probe_queued',
          reason: String(err && err.message ? err.message : err),
        })
      }
    }
  }

  const controls = [...new Set(opts.controls ?? [])]
  if (normalized.ok && opts.agent && controls.length > 0) {
    const token = env[opts.ownerTokenEnv || DEFAULT_OWNER_TOKEN_ENV]
    checks.push({
      ok: typeof token === 'string' && token.length > 0,
      component: 'cutover-probe',
      check: 'owner_token_present',
      env: opts.ownerTokenEnv || DEFAULT_OWNER_TOKEN_ENV,
    })
    if (token) {
      for (const verb of controls) {
        try {
          const result = await postJson(fetchImpl, `${normalized.value}/api/fleet/control`, token, {
            agent_id: opts.agent,
            verb,
          })
          const ok = result.ok && result.json?.ok === true
          checks.push({
            ok,
            component: 'cutover-probe',
            check: 'control_request_queued',
            agent_id: opts.agent,
            verb,
            status: result.status,
            response_ok: result.json?.ok ?? null,
            error: ok ? undefined : result.json?.error ?? null,
            detail: ok ? undefined : result.json?.detail ?? null,
          })
          actions.push({
            kind: 'control_request',
            target_agent: opts.agent,
            verb,
            status: result.status,
            ok,
            nonce: result.json?.nonce ?? null,
            response: result.json,
          })
        } catch (err) {
          checks.push({
            ok: false,
            component: 'cutover-probe',
            check: 'control_request_queued',
            agent_id: opts.agent,
            verb,
            reason: String(err && err.message ? err.message : err),
          })
        }
      }
    }
  }

  const summary = summarize(checks)
  return {
    receipt_type: 'mupot-fleet-cutover-probe/v1',
    generated_at: generatedAt,
    status: summary.status,
    summary,
    inputs: {
      base_url: normalized.ok ? normalized.value : opts.baseUrl || null,
      agent: opts.agent || null,
      queue_inbox: Boolean(opts.queueInbox),
      control_verbs: controls,
      inbox_kind: opts.kind || 'request',
      agent_token_env: opts.agentTokenEnv || DEFAULT_AGENT_TOKEN_ENV,
      owner_token_env: opts.ownerTokenEnv || DEFAULT_OWNER_TOKEN_ENV,
    },
    actions,
    checks,
  }
}

async function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`cutover-probe: ${err && err.message ? err.message : err}`)
    console.error(usage())
    process.exit(2)
  }
  if (opts.help) {
    console.log(usage())
    return
  }
  const receipt = await buildReceipt(opts)
  console.log(JSON.stringify(receipt, null, 2))
  process.exit(receipt.status === 'fail' ? 1 : 0)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}

export { parseArgs, normalizeBaseUrl, summarize }
