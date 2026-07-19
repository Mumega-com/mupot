#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const MAX_INPUT_BYTES = 256 * 1024
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const TOKEN_FILE = '/run/secrets/mupot-agent/token'
const HERMES_ENV = Object.freeze([
  'HOME', 'PATH', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  'HERMES_HOME', 'HERMES_WRITE_SAFE_ROOT', 'HERMES_DISABLE_LAZY_INSTALLS',
  'HERMES_LAZY_INSTALL_TARGET', 'HERMES_WEB_DIST', 'HERMES_TUI_DIR',
  'PLAYWRIGHT_BROWSERS_PATH', 'MUPOT_PLUGIN_MODE',
])

function validBatch(batch) {
  if (!batch || typeof batch !== 'object' || Array.isArray(batch)) return false
  if (typeof batch.tenant !== 'string' || !REF_RE.test(batch.tenant)) return false
  if (typeof batch.agent_id !== 'string' || !REF_RE.test(batch.agent_id)) return false
  if (!Array.isArray(batch.messages) || batch.messages.length < 1 || batch.messages.length > 100) return false
  for (const message of batch.messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return false
    if (message.kind !== 'message' && message.kind !== 'request') return false
    if (typeof message.body !== 'string' || message.body.length > 8000) return false
    if (typeof message.project_id !== 'string' || !REF_RE.test(message.project_id)) return false
    if (message.request_id != null && !REF_RE.test(String(message.request_id))) return false
    if (message.in_reply_to != null && !REF_RE.test(String(message.in_reply_to))) return false
  }
  try {
    return Buffer.byteLength(JSON.stringify(batch)) <= MAX_INPUT_BYTES
  } catch {
    return false
  }
}

function promptFor(batch) {
  return [
    'You were activated by a governed Mupot project request.',
    'Use only the mupot-operator tools and the authority of your welded identity.',
    'Preserve project_id, request_id, and in_reply_to in durable updates and correlated replies.',
    'Do not reveal credentials or copy customer data outside the destination project.',
    '<mupot_batch>',
    JSON.stringify(batch),
    '</mupot_batch>',
  ].join('\n')
}

function hermesEnv(source, readToken = readFileSync) {
  if (source?.MUPOT_AGENT_TOKEN_FILE !== TOKEN_FILE) return null
  let token
  try {
    token = readToken(TOKEN_FILE, 'utf8').trim()
  } catch {
    return null
  }
  if (token.length < 16 || token.length > 4096 || /[\u0000-\u0020\u007f]/.test(token)) return null
  const env = { MUPOT_AGENT_TOKEN: token }
  for (const name of HERMES_ENV) {
    if (typeof source?.[name] === 'string' && source[name]) env[name] = source[name]
  }
  return env
}

export function runHermesBatch(batch, options = {}) {
  if (!validBatch(batch)) return Promise.resolve({ ok: false, reason: 'invalid_batch' })
  const env = hermesEnv(options.env ?? process.env, options.readFileSyncImpl ?? readFileSync)
  if (!env) return Promise.resolve({ ok: false, reason: 'credential_unavailable' })
  const spawnImpl = options.spawnImpl ?? spawn
  return new Promise((resolve) => {
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      resolve(result)
    }
    let child
    try {
      child = spawnImpl('/opt/hermes/.venv/bin/python3', [
        '/opt/mupot/hermes-query-stdin.py',
      ], {
        env,
        shell: false,
        detached: false,
        stdio: ['pipe', 'inherit', 'inherit'],
      })
    } catch {
      return finish({ ok: false, reason: 'spawn_failed' })
    }
    child.on('error', () => finish({ ok: false, reason: 'spawn_failed' }))
    child.on('exit', (code) => finish(code === 0
      ? { ok: true, code: 0 }
      : { ok: false, reason: 'exit_nonzero', code }))
    child.stdin.on('error', () => finish({ ok: false, reason: 'stdin_failed' }))
    try {
      child.stdin.end(promptFor(batch))
    } catch {
      finish({ ok: false, reason: 'stdin_failed' })
    }
  })
}

async function readStdin() {
  return await new Promise((resolve, reject) => {
    let value = ''
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      process.stdin.destroy()
      reject(error)
    }
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      if (settled) return
      value += chunk
      if (Buffer.byteLength(value) > MAX_INPUT_BYTES) fail(new Error('input_too_large'))
    })
    process.stdin.on('error', fail)
    process.stdin.on('end', () => {
      if (settled) return
      settled = true
      resolve(value)
    })
  })
}

async function main() {
  try {
    const batch = JSON.parse(await readStdin())
    const result = await runHermesBatch(batch)
    if (!result.ok) console.error(`hermes-inbox-adapter: ${result.reason}`)
    process.exitCode = result.ok ? 0 : 1
  } catch {
    console.error('hermes-inbox-adapter: invalid_input')
    process.exitCode = 1
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
