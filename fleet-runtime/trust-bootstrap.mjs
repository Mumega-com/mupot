#!/usr/bin/env node
// Fetch public-only fleet trust metadata from a pot and install it on the host.
// The endpoint grants no authority and the panel private scalar never leaves the Worker.

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { importPanelPublicKey } from './control-request.mjs'

const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const TENANT_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const MAX_RESPONSE_BYTES = 16 * 1024

function expandHome(path) {
  return typeof path === 'string' && path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

function pathArg(path) {
  return resolve(expandHome(path))
}

function canonicalBaseUrl(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error('base URL must be an absolute URL')
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1'
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('base URL must use https (http is allowed only for localhost)')
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) {
    throw new Error('base URL must not contain credentials, a path, query, or fragment')
  }
  return url.origin
}

function readObject(path, label) {
  let value
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error(`${label} is missing or invalid JSON: ${path}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object: ${path}`)
  }
  return value
}

function writeJsonAtomic(path, value, mode) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp-${randomUUID()}`
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode })
    chmodSync(tmp, mode)
    renameSync(tmp, path)
    chmodSync(path, mode)
  } finally {
    rmSync(tmp, { force: true })
  }
}

async function readTrustResponse(response) {
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error('fleet trust response is too large')
  let body
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new Error('fleet trust response is not valid JSON')
  }
  if (!response.ok) {
    const code = body && typeof body.error === 'string' ? body.error : `http_${response.status}`
    throw new Error(`fleet trust request failed: ${code}`)
  }
  if (
    !body ||
    body.ok !== true ||
    typeof body.tenant !== 'string' ||
    !TENANT_RE.test(body.tenant) ||
    typeof body.consumer_agent_id !== 'string' ||
    !AGENT_ID_RE.test(body.consumer_agent_id) ||
    !body.panel_public_key ||
    typeof body.panel_public_key !== 'object' ||
    Array.isArray(body.panel_public_key) ||
    body.panel_public_key.d
  ) {
    throw new Error('fleet trust response has an invalid shape')
  }
  await importPanelPublicKey(JSON.stringify(body.panel_public_key))
  body.panel_public_key = {
    kty: 'OKP',
    crv: 'Ed25519',
    x: body.panel_public_key.x,
  }
  return body
}

export async function bootstrapFleetTrust(opts, deps = {}) {
  const baseUrl = canonicalBaseUrl(opts.baseUrl)
  const controlPath = pathArg(opts.controlPath ?? join(homedir(), '.fleet', 'control.json'))
  const panelKeyPath = pathArg(opts.panelKeyPath ?? join(homedir(), '.fleet', 'panel.pub.jwk'))
  if (controlPath === panelKeyPath) throw new Error('control config and panel key paths must differ')
  const fetchFn = deps.fetchFn ?? fetch

  const response = await fetchFn(`${baseUrl}/api/fleet/trust`, { redirect: 'error' })
  const trust = await readTrustResponse(response)
  const control = readObject(controlPath, 'control config')
  const updatedControl = {
    ...control,
    base_url: baseUrl,
    tenant: trust.tenant,
    consumer_agent_id: trust.consumer_agent_id,
    panel_public_key: panelKeyPath,
  }

  writeJsonAtomic(panelKeyPath, trust.panel_public_key, 0o644)
  writeJsonAtomic(controlPath, updatedControl, 0o600)

  return {
    receipt_type: 'mupot-fleet-trust-bootstrap/v1',
    status: 'pass',
    base_url: baseUrl,
    tenant: trust.tenant,
    consumer_agent_id: trust.consumer_agent_id,
    panel_public_key: panelKeyPath,
    control_config: controlPath,
    checks: [
      { ok: true, component: 'fleet-trust-bootstrap', check: 'public_trust_metadata_fetched' },
      { ok: true, component: 'fleet-trust-bootstrap', check: 'panel_public_key_public_only' },
      { ok: true, component: 'fleet-trust-bootstrap', check: 'consumer_agent_exact_match' },
      { ok: true, component: 'fleet-trust-bootstrap', check: 'control_config_updated' },
    ],
  }
}

function parseArgs(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) throw new Error(`${arg} requires a value`)
      return argv[i]
    }
    if (arg === '--base-url') opts.baseUrl = next()
    else if (arg === '--control') opts.controlPath = next()
    else if (arg === '--panel-key') opts.panelKeyPath = next()
    else if (arg === '--help' || arg === '-h') opts.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return opts
}

function usage() {
  return [
    'Usage: node trust-bootstrap.mjs --base-url <pot-url> [options]',
    '',
    'Options:',
    '  --control <path>    control config (default: ~/.fleet/control.json)',
    '  --panel-key <path>  public panel JWK destination (default: ~/.fleet/panel.pub.jwk)',
    '  -h, --help          show this help',
  ].join('\n')
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  if (!opts.baseUrl) throw new Error('--base-url is required')
  const receipt = await bootstrapFleetTrust(opts)
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`fleet trust bootstrap failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
