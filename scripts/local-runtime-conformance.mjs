#!/usr/bin/env node

import { randomUUID, webcrypto } from 'node:crypto'
import process from 'node:process'

const cryptoImpl = globalThis.crypto ?? webcrypto
const baseUrl = (process.env.MUPOT_LOCAL_URL || process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '')
const contract = 'runtime-adapter/v1'
const tenant = 'local'
const agentId = 'agent-conformance'
const agentType = 'builder'
const runtime = 'python'
const lifecycle = 'on_demand'
const senderToken = process.env.MUPOT_CONFORMANCE_SENDER_TOKEN || 'local-runtime-conformance-sender-token'

// Local-only deterministic key for scripts/local-test-seed.sql. This is not a
// production credential; it exists so the signed runtime path can be smoke-tested
// end to end against wrangler-local-test.toml.
const privateJwk = {
  kty: 'OKP',
  crv: 'Ed25519',
  x: '5hhsUxlkZWNACkMQjUFNIO1-e4bbFtTaLUd7_5L7sdU',
  d: '8HMGWlPR9d_UaJdSXZDImH431TLG9NNz7cerK-MNIlg',
  ext: true,
  key_ops: ['sign'],
}

const enc = new TextEncoder()

function b64url(bytes) {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString('base64url')
}

function nonce() {
  const bytes = new Uint8Array(24)
  cryptoImpl.getRandomValues(bytes)
  return b64url(bytes)
}

async function importPrivateKey() {
  return cryptoImpl.subtle.importKey('jwk', privateJwk, { name: 'Ed25519' }, false, ['sign'])
}

async function signLines(key, lines) {
  const sig = await cryptoImpl.subtle.sign({ name: 'Ed25519' }, key, enc.encode(lines.join('\n')))
  return b64url(sig)
}

function nowSec() {
  return Math.floor(Date.now() / 1000)
}

async function signedAttachBody(key, overrides = {}) {
  const body = {
    agent_id: agentId,
    type: agentType,
    runtime,
    lifecycle,
    ts: nowSec(),
    nonce: nonce(),
    ...overrides,
  }
  body.sig = await signLines(key, [
    'fleet-attach:v1',
    tenant,
    body.agent_id,
    body.type,
    body.runtime,
    body.lifecycle,
    String(body.ts),
    body.nonce,
  ])
  return body
}

async function signedInboxBody(key, { peek, limit = 10 }) {
  const body = {
    agent_id: agentId,
    peek,
    limit,
    ts: nowSec(),
    nonce: nonce(),
  }
  body.sig = await signLines(key, [
    'agent-inbox:v1',
    tenant,
    body.agent_id,
    body.peek ? '1' : '0',
    String(body.limit),
    String(body.ts),
    body.nonce,
  ])
  return body
}

async function signedDetachBody(key) {
  const body = {
    agent_id: agentId,
    ts: nowSec(),
    nonce: nonce(),
  }
  body.sig = await signLines(key, [
    'fleet-detach:v1',
    tenant,
    body.agent_id,
    String(body.ts),
    body.nonce,
  ])
  return body
}

async function requestJson(path, init = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { parse_error: text.slice(0, 240) }
  }
  return { status: res.status, json, text }
}

function expectStatus(step, actual, expected, detail) {
  if (actual !== expected) {
    const err = new Error(`${step}: expected HTTP ${expected}, got ${actual}`)
    err.detail = detail
    throw err
  }
}

function expect(condition, message, detail) {
  if (!condition) {
    const err = new Error(message)
    err.detail = detail
    throw err
  }
}

function findRequest(messages, requestId) {
  return Array.isArray(messages) ? messages.find((m) => m?.request_id === requestId) : null
}

async function main() {
  const key = await importPrivateKey()
  const runId = randomUUID()
  const requestId = `local-runtime-conformance:${runId}`
  const messageBody = `Local runtime conformance ${runId}`
  const steps = []

  const health = await requestJson('/health')
  expectStatus('health', health.status, 200, health.json)
  expect(health.json?.ok === true && health.json?.tenant === tenant, 'health did not return the local tenant', health.json)
  steps.push({ name: 'health', status: 'passed' })

  const attachBody = await signedAttachBody(key)
  const attach = await requestJson('/api/fleet/attach-signed', {
    method: 'POST',
    body: JSON.stringify(attachBody),
  })
  expectStatus('signed attach', attach.status, 200, attach.json)
  expect(attach.json?.ok === true, 'signed attach did not return ok:true', attach.json)
  steps.push({ name: 'signed attach', status: 'passed', agent: agentId, runtime })

  const replay = await requestJson('/api/fleet/attach-signed', {
    method: 'POST',
    body: JSON.stringify(attachBody),
  })
  expectStatus('signed attach replay', replay.status, 409, replay.json)
  steps.push({ name: 'signed attach replay refusal', status: 'passed' })

  const send = await requestJson('/api/inbox/send', {
    method: 'POST',
    headers: { authorization: `Bearer ${senderToken}` },
    body: JSON.stringify({
      to: agentId,
      body: messageBody,
      kind: 'request',
      request_id: requestId,
    }),
  })
  expectStatus('bearer inbox send', send.status, 200, send.json)
  expect(send.json?.ok === true && send.json?.to === agentId, 'bearer send did not target the conformance agent', send.json)
  steps.push({ name: 'bearer send to runtime inbox', status: 'passed', request_id: requestId })

  const peekBody = await signedInboxBody(key, { peek: true })
  const peek = await requestJson('/api/inbox/signed', {
    method: 'POST',
    body: JSON.stringify(peekBody),
  })
  expectStatus('signed inbox peek', peek.status, 200, peek.json)
  expect(peek.json?.ok === true && peek.json?.consumed === false, 'signed inbox peek did not return an unconsumed batch', peek.json)
  expect(Boolean(findRequest(peek.json?.messages, requestId)), 'signed inbox peek did not include the conformance request', peek.json)
  steps.push({ name: 'signed inbox peek', status: 'passed', messages: peek.json.messages.length })

  const peekReplay = await requestJson('/api/inbox/signed', {
    method: 'POST',
    body: JSON.stringify(peekBody),
  })
  expectStatus('signed inbox replay', peekReplay.status, 409, peekReplay.json)
  steps.push({ name: 'signed inbox replay refusal', status: 'passed' })

  const consume = await requestJson('/api/inbox/signed', {
    method: 'POST',
    body: JSON.stringify(await signedInboxBody(key, { peek: false })),
  })
  expectStatus('signed inbox consume', consume.status, 200, consume.json)
  expect(consume.json?.ok === true && consume.json?.consumed === true, 'signed inbox consume did not consume', consume.json)
  expect(Boolean(findRequest(consume.json?.messages, requestId)), 'signed inbox consume did not return the conformance request', consume.json)
  steps.push({ name: 'signed inbox consume', status: 'passed', messages: consume.json.messages.length })

  const afterConsume = await requestJson('/api/inbox/signed', {
    method: 'POST',
    body: JSON.stringify(await signedInboxBody(key, { peek: true })),
  })
  expectStatus('signed inbox post-consume peek', afterConsume.status, 200, afterConsume.json)
  expect(!findRequest(afterConsume.json?.messages, requestId), 'consumed conformance request was still unread', afterConsume.json)
  steps.push({ name: 'consume-once confirmation', status: 'passed' })

  const detach = await requestJson('/api/fleet/detach-signed', {
    method: 'POST',
    body: JSON.stringify(await signedDetachBody(key)),
  })
  expectStatus('signed detach', detach.status, 200, detach.json)
  expect(detach.json?.ok === true, 'signed detach did not return ok:true', detach.json)
  steps.push({ name: 'signed detach', status: 'passed', agent: agentId })

  console.log(JSON.stringify({
    ok: true,
    contract,
    baseUrl,
    tenant,
    agent: agentId,
    runtime,
    lifecycle,
    steps,
  }, null, 2))
}

main().catch((err) => {
  console.error(JSON.stringify({
    ok: false,
    contract,
    baseUrl,
    error: err instanceof Error ? err.message : String(err),
    detail: err?.detail ?? null,
  }, null, 2))
  process.exit(1)
})
