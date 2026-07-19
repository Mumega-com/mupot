#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const PROJECT_LINK_FLIGHT_EVIDENCE_TYPE = 'mupot.project-link-flight-evidence/v1'

const HASH_RE = /^[a-f0-9]{64}$/
const SIGNATURE_RE = /^[A-Za-z0-9_-]{86}$/
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const CURSOR_RE = /^[A-Za-z0-9_-]{1,2048}$/
const MAX_RESPONSE_BYTES = 1024 * 1024
const DEFAULT_MAX_PAGES = 1000

function endpointContract(endpoint) {
  let url
  try {
    url = new URL(endpoint?.baseUrl)
  } catch {
    throw new Error('evidence endpoint invalid')
  }
  if (
    url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) throw new Error('evidence endpoint invalid')
  if (!ID_RE.test(endpoint?.pot ?? '') || !ID_RE.test(endpoint?.projectId ?? '')) {
    throw new Error('evidence endpoint invalid')
  }
  if (
    typeof endpoint?.token !== 'string' || endpoint.token.length < 16 || endpoint.token.length > 8192 ||
    /[\r\n]/.test(endpoint.token)
  ) throw new Error('evidence credential invalid')
  return {
    origin: url.origin,
    pot: endpoint.pot,
    projectId: endpoint.projectId,
    token: endpoint.token,
  }
}

async function responseJson(response) {
  const declaredLength = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    try { await response.body?.cancel() } catch {}
    throw new Error('evidence response too large')
  }
  if (!response.ok) {
    try { await response.body?.cancel() } catch {}
    throw new Error(`evidence endpoint HTTP ${response.status}`)
  }
  const reader = response.body?.getReader()
  const chunks = []
  let length = 0
  if (reader) {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_RESPONSE_BYTES) {
        try { await reader.cancel() } catch {}
        throw new Error('evidence response too large')
      }
      chunks.push(value)
    }
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  let raw
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return JSON.parse(raw)
  } catch {
    throw new Error('evidence response invalid')
  }
}

function proofContract(row, direction) {
  const proof = row?.proof
  if (
    row?.source_type !== 'project_link_receipt' || row?.status !== 'accepted' ||
    !ID_RE.test(row?.source_id ?? '') || !Number.isFinite(Date.parse(row?.occurred_at ?? '')) ||
    proof?.schema !== 'mupot.project-link-receipt-proof/v1' || proof?.direction !== direction ||
    !HASH_RE.test(proof?.shared_receipt_sha256 ?? '') || !HASH_RE.test(proof?.envelope_sha256 ?? '') ||
    !(proof?.evidence_sha256 === null || HASH_RE.test(proof?.evidence_sha256 ?? '')) ||
    !ID_RE.test(proof?.remote_pot ?? '') || !ID_RE.test(proof?.remote_project_id ?? '') ||
    !ID_RE.test(proof?.source_agent_id ?? '') || !['task', 'evidence'].includes(proof?.action_type) ||
    !ID_RE.test(proof?.action_id ?? '') || !ID_RE.test(proof?.receipt_key_id ?? '') ||
    !SIGNATURE_RE.test(proof?.receipt_signature ?? '')
  ) return null
  return proof
}

async function findReceipt(endpoint, correlationId, direction, fetchImpl, maxPages) {
  const matches = []
  const seenCursors = new Set()
  let cursor = null
  let pages = 0
  let complete = false
  while (pages < maxPages) {
    const url = new URL(`/api/projects/${encodeURIComponent(endpoint.projectId)}/evidence`, endpoint.origin)
    url.searchParams.set('limit', '100')
    if (cursor) url.searchParams.set('cursor', cursor)
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: { accept: 'application/json', authorization: `Bearer ${endpoint.token}` },
    })
    const body = await responseJson(response)
    if (!Array.isArray(body?.rows) || body.rows.length > 100) throw new Error('evidence response invalid')
    for (const row of body.rows) {
      if (row?.source_type === 'project_link_receipt' && row?.correlation_id === correlationId) matches.push(row)
    }
    pages += 1
    if (body.next_cursor === null) {
      complete = true
      break
    }
    if (typeof body.next_cursor !== 'string' || !CURSOR_RE.test(body.next_cursor)) {
      throw new Error('evidence cursor invalid')
    }
    if (seenCursors.has(body.next_cursor)) throw new Error('evidence pagination cycle')
    seenCursors.add(body.next_cursor)
    cursor = body.next_cursor
  }
  if (!complete) throw new Error('evidence pagination limit reached')
  return {
    pages,
    count: matches.length,
    row: matches.length === 1 ? matches[0] : null,
    proof: matches.length === 1 ? proofContract(matches[0], direction) : null,
  }
}

function addCheck(checks, ok, passCode, failCode) {
  checks.push({ check: ok ? passCode : failCode, ok })
}

export async function verifyProjectLinkFlightEvidence({
  source: sourceInput,
  destination: destinationInput,
  correlationId,
  now = new Date(),
  notBefore,
  fetchImpl = fetch,
  maxPages = DEFAULT_MAX_PAGES,
}) {
  const source = endpointContract(sourceInput)
  const destination = endpointContract(destinationInput)
  if (source.pot === destination.pot || source.origin === destination.origin) {
    throw new Error('evidence endpoints must be sovereign')
  }
  if (!ID_RE.test(correlationId ?? '')) throw new Error('evidence correlation invalid')
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10_000) throw new Error('evidence max pages invalid')
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('evidence observation time invalid')
  if (!(notBefore instanceof Date) || !Number.isFinite(notBefore.getTime()) || notBefore.getTime() > now.getTime()) {
    throw new Error('evidence not-before invalid')
  }

  const [sourceMatch, destinationMatch] = await Promise.all([
    findReceipt(source, correlationId, 'outbound', fetchImpl, maxPages),
    findReceipt(destination, correlationId, 'inbound', fetchImpl, maxPages),
  ])
  const checks = []
  addCheck(checks, sourceMatch.count === 1, 'source_receipt_unique', sourceMatch.count === 0 ? 'source_receipt_missing' : 'source_receipt_ambiguous')
  addCheck(checks, destinationMatch.count === 1, 'destination_receipt_unique', destinationMatch.count === 0 ? 'destination_receipt_missing' : 'destination_receipt_ambiguous')
  addCheck(checks, sourceMatch.proof !== null, 'source_receipt_valid', 'source_receipt_invalid')
  addCheck(checks, destinationMatch.proof !== null, 'destination_receipt_valid', 'destination_receipt_invalid')

  const sourceOccurredAt = Date.parse(sourceMatch.row?.occurred_at ?? '')
  const destinationOccurredAt = Date.parse(destinationMatch.row?.occurred_at ?? '')
  const latestAcceptedAt = now.getTime() + 5 * 60_000
  addCheck(checks, Number.isFinite(sourceOccurredAt) && sourceOccurredAt >= notBefore.getTime(),
    'source_receipt_fresh', 'source_receipt_stale')
  addCheck(checks, Number.isFinite(destinationOccurredAt) && destinationOccurredAt >= notBefore.getTime(),
    'destination_receipt_fresh', 'destination_receipt_stale')
  addCheck(checks, Number.isFinite(sourceOccurredAt) && sourceOccurredAt <= latestAcceptedAt,
    'source_receipt_time_valid', 'source_receipt_from_future')
  addCheck(checks, Number.isFinite(destinationOccurredAt) && destinationOccurredAt <= latestAcceptedAt,
    'destination_receipt_time_valid', 'destination_receipt_from_future')

  const a = sourceMatch.proof
  const b = destinationMatch.proof
  const comparable = a !== null && b !== null
  addCheck(checks, comparable && a.remote_pot === destination.pot && a.remote_project_id === destination.projectId &&
    b.remote_pot === source.pot && b.remote_project_id === source.projectId,
  'project_mapping_matches', 'project_mapping_mismatch')
  addCheck(checks, comparable && a.shared_receipt_sha256 === b.shared_receipt_sha256,
    'shared_receipt_hash_matches', 'shared_receipt_hash_mismatch')
  addCheck(checks, comparable && a.envelope_sha256 === b.envelope_sha256,
    'envelope_hash_matches', 'envelope_hash_mismatch')
  addCheck(checks, comparable && a.evidence_sha256 !== null && b.evidence_sha256 !== null,
    'evidence_hash_present', 'evidence_hash_missing')
  addCheck(checks, comparable && a.evidence_sha256 !== null && a.evidence_sha256 === b.evidence_sha256,
    'evidence_hash_matches', 'evidence_hash_mismatch')
  addCheck(checks, comparable && a.action_type === 'evidence' && b.action_type === 'evidence' && a.action_id === b.action_id,
    'evidence_action_matches', 'evidence_action_mismatch')
  addCheck(checks, comparable && a.source_agent_id === b.source_agent_id,
    'source_agent_matches', 'source_agent_mismatch')
  addCheck(checks, comparable && a.receipt_key_id === b.receipt_key_id && a.receipt_signature === b.receipt_signature,
    'destination_signature_matches', 'destination_signature_mismatch')

  const failureCodes = checks.filter((entry) => !entry.ok).map((entry) => entry.check)
  return {
    schema: PROJECT_LINK_FLIGHT_EVIDENCE_TYPE,
    status: failureCodes.length === 0 ? 'pass' : 'fail',
    observed_at: now.toISOString(),
    not_before: notBefore.toISOString(),
    correlation_id: correlationId,
    source: {
      pot: source.pot,
      project_id: source.projectId,
      origin: source.origin,
      pages_read: sourceMatch.pages,
      receipt_id: sourceMatch.row?.source_id ?? null,
      occurred_at: sourceMatch.row?.occurred_at ?? null,
    },
    destination: {
      pot: destination.pot,
      project_id: destination.projectId,
      origin: destination.origin,
      pages_read: destinationMatch.pages,
      receipt_id: destinationMatch.row?.source_id ?? null,
      occurred_at: destinationMatch.row?.occurred_at ?? null,
    },
    hashes: comparable ? {
      shared_receipt_sha256: a.shared_receipt_sha256,
      envelope_sha256: a.envelope_sha256,
      evidence_sha256: a.evidence_sha256,
      receipt_key_id: a.receipt_key_id,
      receipt_signature: a.receipt_signature,
    } : null,
    checks,
    failure_codes: failureCodes,
  }
}

export function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      const value = argv[++index]
      if (!value || value.startsWith('--')) throw new Error(`missing value for ${arg}`)
      return value
    }
    if (arg === '--source-url') options.sourceUrl = next()
    else if (arg === '--source-pot') options.sourcePot = next()
    else if (arg === '--source-project') options.sourceProject = next()
    else if (arg === '--source-token-file') options.sourceTokenFile = next()
    else if (arg === '--destination-url') options.destinationUrl = next()
    else if (arg === '--destination-pot') options.destinationPot = next()
    else if (arg === '--destination-project') options.destinationProject = next()
    else if (arg === '--destination-token-file') options.destinationTokenFile = next()
    else if (arg === '--correlation') options.correlationId = next()
    else if (arg === '--not-before') options.notBefore = next()
    else if (arg === '--max-pages') options.maxPages = Number(next())
    else if (arg === '--output') options.output = next()
    else if (arg === '--help') options.help = true
    else throw new Error(`unknown option: ${arg}`)
  }
  return options
}

function tokenFromFile(path) {
  const raw = readFileSync(path, 'utf8').replace(/\r?\n$/, '')
  if (/[\r\n]/.test(raw)) throw new Error('evidence credential file invalid')
  return raw
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log('Usage: node scripts/project-link-flight-evidence.mjs --source-url URL --source-pot POT --source-project ID --source-token-file FILE --destination-url URL --destination-pot POT --destination-project ID --destination-token-file FILE --correlation ID --not-before ISO_TIME [--max-pages N] [--output FILE]')
    return
  }
  const required = [
    'sourceUrl', 'sourcePot', 'sourceProject', 'sourceTokenFile',
    'destinationUrl', 'destinationPot', 'destinationProject', 'destinationTokenFile', 'correlationId', 'notBefore',
  ]
  if (required.some((key) => !options[key])) throw new Error('required evidence option missing')
  const receipt = await verifyProjectLinkFlightEvidence({
    source: {
      baseUrl: options.sourceUrl, pot: options.sourcePot, projectId: options.sourceProject,
      token: tokenFromFile(options.sourceTokenFile),
    },
    destination: {
      baseUrl: options.destinationUrl, pot: options.destinationPot, projectId: options.destinationProject,
      token: tokenFromFile(options.destinationTokenFile),
    },
    correlationId: options.correlationId,
    notBefore: new Date(options.notBefore),
    maxPages: options.maxPages ?? DEFAULT_MAX_PAGES,
  })
  const output = `${JSON.stringify(receipt, null, 2)}\n`
  if (options.output) writeFileSync(options.output, output, { encoding: 'utf8', mode: 0o600 })
  else process.stdout.write(output)
  if (receipt.status !== 'pass') process.exitCode = 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'evidence verification failed')
    process.exitCode = 1
  })
}
