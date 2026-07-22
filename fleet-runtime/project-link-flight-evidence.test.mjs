import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PROJECT_LINK_FLIGHT_EVIDENCE_TYPE,
  parseArgs,
  verifyProjectLinkFlightEvidence,
} from '../scripts/project-link-flight-evidence.mjs'
import { readFileSync } from 'node:fs'

const HASHES = {
  shared: 'a'.repeat(64),
  envelope: 'b'.repeat(64),
  evidence: 'c'.repeat(64),
}
const NOW = new Date('2026-07-19T04:05:00.000Z')
const NOT_BEFORE = new Date('2026-07-19T03:55:00.000Z')

function receiptRow(direction, overrides = {}) {
  return {
    source_type: 'project_link_receipt',
    source_id: `receipt-${direction}`,
    occurred_at: '2026-07-19T04:00:00.000Z',
    title: `${direction} evidence`,
    detail: 'bounded display text',
    status: 'accepted',
    actor: 'dme-hermes-k8s',
    correlation_id: 'flight-dme-live-001',
    proof: {
      schema: 'mupot.project-link-receipt-proof/v1',
      direction,
      shared_receipt_sha256: HASHES.shared,
      envelope_sha256: HASHES.envelope,
      evidence_sha256: HASHES.evidence,
      evidence_url: 'https://evidence.dme.test/receipts/flight-dme-live-001',
      remote_pot: direction === 'outbound' ? 'dme' : 'mumega',
      remote_project_id: direction === 'outbound' ? 'dme-project' : 'mumega-project',
      source_pot: 'mumega',
      destination_pot: 'dme',
      authorization_result: 'authorized',
      source_agent_id: 'dme-hermes-k8s',
      action_type: 'task',
      action_id: 'task-live-001',
      receipt_key_id: 'dme-key',
      receipt_signature: 's'.repeat(86),
      ...overrides,
    },
  }
}

function endpoint(pot, projectId, token) {
  return { baseUrl: `https://${pot}.example`, pot, projectId, token }
}

test('proves matching destination-signed evidence across both project views', async () => {
  const requests = []
  const fetchImpl = async (input, init) => {
    const url = new URL(String(input))
    requests.push({ url: url.toString(), authorization: init?.headers?.authorization })
    if (url.hostname === 'mumega.example' && !url.searchParams.has('cursor')) {
      return Response.json({ rows: [], next_cursor: 'opaque-source-cursor' })
    }
    if (url.hostname === 'mumega.example') {
      return Response.json({ rows: [receiptRow('outbound')], next_cursor: null })
    }
    return Response.json({ rows: [receiptRow('inbound')], next_cursor: null })
  }

  const receipt = await verifyProjectLinkFlightEvidence({
    source: endpoint('mumega', 'mumega-project', 'source-token-value'),
    destination: endpoint('dme', 'dme-project', 'destination-token-value'),
    correlationId: 'flight-dme-live-001',
    now: NOW,
    notBefore: NOT_BEFORE,
    maxPages: 2,
    fetchImpl,
  })

  assert.equal(receipt.schema, PROJECT_LINK_FLIGHT_EVIDENCE_TYPE)
  assert.equal(receipt.status, 'pass')
  assert.deepEqual(receipt.failure_codes, [])
  assert.deepEqual(receipt.hashes, {
    shared_receipt_sha256: HASHES.shared,
    envelope_sha256: HASHES.envelope,
    evidence_sha256: HASHES.evidence,
    evidence_url: 'https://evidence.dme.test/receipts/flight-dme-live-001',
    source_pot: 'mumega',
    destination_pot: 'dme',
    authorization_result: 'authorized',
    receipt_key_id: 'dme-key',
    receipt_signature: 's'.repeat(86),
  })
  assert.equal(requests.length, 3)
  assert.ok(requests.some((request) => /mumega\.example.*cursor=opaque-source-cursor/.test(request.url)))
  assert.ok(requests.filter((request) => request.url.includes('mumega.example'))
    .every((request) => request.authorization === 'Bearer source-token-value'))
  assert.ok(requests.filter((request) => request.url.includes('dme.example'))
    .every((request) => request.authorization === 'Bearer destination-token-value'))
  assert.equal(JSON.stringify(receipt).includes('source-token-value'), false)
  assert.equal(JSON.stringify(receipt).includes('destination-token-value'), false)
})

test('fails when the two pots expose different signed receipt hashes', async () => {
  const fetchImpl = async (input) => Response.json({
    rows: [new URL(String(input)).hostname === 'mumega.example'
      ? receiptRow('outbound')
      : receiptRow('inbound', { shared_receipt_sha256: 'f'.repeat(64) })],
    next_cursor: null,
  })

  const receipt = await verifyProjectLinkFlightEvidence({
    source: endpoint('mumega', 'mumega-project', 'source-token-value'),
    destination: endpoint('dme', 'dme-project', 'destination-token-value'),
    correlationId: 'flight-dme-live-001',
    now: NOW,
    notBefore: NOT_BEFORE,
    fetchImpl,
  })

  assert.equal(receipt.status, 'fail')
  assert.ok(receipt.failure_codes.includes('shared_receipt_hash_mismatch'))
})

test('fails closed on missing evidence hashes and repeated cursors', async () => {
  const missingEvidence = await verifyProjectLinkFlightEvidence({
    source: endpoint('mumega', 'mumega-project', 'source-token-value'),
    destination: endpoint('dme', 'dme-project', 'destination-token-value'),
    correlationId: 'flight-dme-live-001',
    now: NOW,
    notBefore: NOT_BEFORE,
    fetchImpl: async (input) => Response.json({
      rows: [new URL(String(input)).hostname === 'mumega.example'
        ? receiptRow('outbound', { evidence_sha256: null })
        : receiptRow('inbound', { evidence_sha256: null })],
      next_cursor: null,
    }),
  })
  assert.equal(missingEvidence.status, 'fail')
  assert.ok(missingEvidence.failure_codes.includes('evidence_hash_missing'))

  await assert.rejects(
    verifyProjectLinkFlightEvidence({
      source: endpoint('mumega', 'mumega-project', 'source-token-value'),
      destination: endpoint('dme', 'dme-project', 'destination-token-value'),
      correlationId: 'flight-dme-live-001',
      now: NOW,
      notBefore: NOT_BEFORE,
      fetchImpl: async () => Response.json({ rows: [], next_cursor: 'same-cursor' }),
    }),
    /evidence pagination cycle/,
  )
})

test('rejects unsafe endpoint and credential inputs before network access', async () => {
  let called = false
  await assert.rejects(
    verifyProjectLinkFlightEvidence({
      source: { ...endpoint('mumega', 'mumega-project', 'source-token-value'), baseUrl: 'http://mumega.example' },
      destination: endpoint('dme', 'dme-project', 'destination-token-value'),
      correlationId: 'flight-dme-live-001',
      fetchImpl: async () => { called = true; return Response.json({}) },
    }),
    /endpoint invalid/,
  )
  await assert.rejects(
    verifyProjectLinkFlightEvidence({
      source: endpoint('mumega', 'mumega-project', 'bad\r\ntoken'),
      destination: endpoint('dme', 'dme-project', 'destination-token-value'),
      correlationId: 'flight-dme-live-001',
      fetchImpl: async () => { called = true; return Response.json({}) },
    }),
    /credential invalid/,
  )
  await assert.rejects(
    verifyProjectLinkFlightEvidence({
      source: endpoint('mumega', 'mumega-project', 'source-token-value'),
      destination: { ...endpoint('dme', 'dme-project', 'destination-token-value'), baseUrl: 'https://mumega.example' },
      correlationId: 'flight-dme-live-001',
      fetchImpl: async () => { called = true; return Response.json({}) },
    }),
    /endpoints must be sovereign/,
  )
  await assert.rejects(
    verifyProjectLinkFlightEvidence({
      source: endpoint('mumega', 'mumega-project', 'source-token-value'),
      destination: { ...endpoint('dme', 'dme-project', 'destination-token-value'), pot: 'mumega' },
      correlationId: 'flight-dme-live-001',
      fetchImpl: async () => { called = true; return Response.json({}) },
    }),
    /endpoints must be sovereign/,
  )
  assert.equal(called, false)
})

test('fails when matching receipts predate the declared live flight window', async () => {
  const fetchImpl = async (input) => {
    const row = new URL(String(input)).hostname === 'mumega.example'
      ? receiptRow('outbound')
      : receiptRow('inbound')
    row.occurred_at = '2026-07-19T03:30:00.000Z'
    return Response.json({ rows: [row], next_cursor: null })
  }

  const receipt = await verifyProjectLinkFlightEvidence({
    source: endpoint('mumega', 'mumega-project', 'source-token-value'),
    destination: endpoint('dme', 'dme-project', 'destination-token-value'),
    correlationId: 'flight-dme-live-001',
    now: NOW,
    notBefore: NOT_BEFORE,
    fetchImpl,
  })

  assert.equal(receipt.status, 'fail')
  assert.ok(receipt.failure_codes.includes('source_receipt_stale'))
  assert.ok(receipt.failure_codes.includes('destination_receipt_stale'))
})

test('cancels a chunked response as soon as it crosses the byte limit', async () => {
  const totalChunks = 100
  let pulls = 0
  let cancelled = false
  const oversized = new ReadableStream({
    pull(controller) {
      pulls += 1
      if (pulls > totalChunks) return controller.close()
      controller.enqueue(new Uint8Array(64 * 1024))
    },
    cancel() {
      cancelled = true
    },
  })

  await assert.rejects(
    verifyProjectLinkFlightEvidence({
      source: endpoint('mumega', 'mumega-project', 'source-token-value'),
      destination: endpoint('dme', 'dme-project', 'destination-token-value'),
      correlationId: 'flight-dme-live-001',
      now: NOW,
      notBefore: NOT_BEFORE,
      fetchImpl: async (input) => new URL(String(input)).hostname === 'mumega.example'
        ? new Response(oversized)
        : Response.json({ rows: [receiptRow('inbound')], next_cursor: null }),
    }),
    /response too large/,
  )
  assert.equal(cancelled, true)
  assert.ok(pulls < totalChunks)
})

test('CLI accepts credential files only and the runtime runbook wires the verifier', () => {
  const options = parseArgs([
    '--source-url', 'https://mumega.example',
    '--source-pot', 'mumega',
    '--source-project', 'mumega-project',
    '--source-token-file', '/run/secrets/mumega-token',
    '--destination-url', 'https://dme.example',
    '--destination-pot', 'dme',
    '--destination-project', 'dme-project',
    '--destination-token-file', '/run/secrets/dme-token',
    '--correlation', 'flight-dme-live-001',
    '--not-before', '2026-07-19T03:55:00.000Z',
  ])
  assert.equal(options.sourceTokenFile, '/run/secrets/mumega-token')
  assert.equal(options.destinationTokenFile, '/run/secrets/dme-token')
  assert.throws(() => parseArgs(['--source-token', 'literal-secret']), /unknown option/)

  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const runbook = readFileSync(new URL('../docs/runtime-starter.md', import.meta.url), 'utf8')
  assert.equal(packageJson.scripts['receipt:project-link-flight'], 'node scripts/project-link-flight-evidence.mjs')
  assert.match(runbook, /receipt:project-link-flight/)
  assert.match(runbook, /mupot\.project-link-flight-evidence\/v1/)
  assert.match(runbook, /source-token-file/)
  assert.match(runbook, /destination-token-file/)
  assert.match(runbook, /not-before/)
})
