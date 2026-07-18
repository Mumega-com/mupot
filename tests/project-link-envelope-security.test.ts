import { describe, expect, it } from 'vitest'
import {
  PROJECT_LINK_ENVELOPE_SCHEMA,
  PROJECT_LINK_ENVELOPE_SIGNATURE_DOMAIN,
  canonicalDomainSeparatedBytes,
  canonicalJson,
  canonicalProjectLinkArtifact,
  canonicalProjectLinkEnvelope,
  canonicalProjectLinkEnvelopeSigningBytes,
  createSignedProjectEnvelope,
  generateProjectLinkKeyPair,
  validateProjectLinkEnvelope,
} from '../src/addons/project-link/envelope'

function envelopeInput() {
  return {
    schema: PROJECT_LINK_ENVELOPE_SCHEMA,
    source: {
      pot: 'mumega', project_id: 'mumega-project', agent_id: 'codex-mac-mumcp', key_id: 'mumega-key',
    },
    destination: { pot: 'dme', project_id: 'dme-project' },
    correlation_id: 'flight-dme-001',
    idempotency_key: 'dme-task-flight-001',
    requested_capability: 'project.evidence.write' as const,
    expires_at: '2026-07-18T22:35:00.000Z',
    task: {
      source_task_id: 'mumega-task-001',
      flight_id: 'flight-dme-001',
      request_id: 'request-dme-001',
      title: 'Verify DME visibility monitor deployment',
      state: 'in_progress' as const,
      priority: 'high' as const,
      blocker_summary: null,
      success_predicate: 'A sanitized deployment receipt is attached in both projects.',
      progress_summary: 'The source completed its sanitized preflight.',
    },
    evidence: {
      sha256: 'a'.repeat(64),
      media_type: 'application/json' as const,
      occurred_at: '2026-07-18T22:30:00.000Z',
      url: 'https://evidence.dme.test/receipts/flight-dme-001',
    },
  }
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function fromB64url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))
}

describe('project-link envelope security boundary', () => {
  it('produces stable canonical JSON for key ordering, Unicode, escaping, and nulls', () => {
    const vector = {
      z: null,
      'é': 'composed',
      nested: { b: null, a: 'café' },
      array: [null, 'é', { y: '雪', x: 'quote" slash\\ newline\n' }],
      a: 'first',
    }
    const golden = '{"a":"first","array":[null,"é",{"x":"quote\\" slash\\\\ newline\\n","y":"雪"}],"nested":{"a":"café","b":null},"z":null,"é":"composed"}'

    expect(canonicalJson(vector)).toBe(golden)
    expect(canonicalJson({ nested: { a: 'café', b: null }, a: 'first', array: vector.array, 'é': 'composed', z: null })).toBe(golden)
  })

  it('produces a deterministic domain-separated byte vector reusable for receipts', () => {
    const value = {
      receipt_id: 'receipt-001', accepted: true, evidence: null,
    }
    const artifact = canonicalProjectLinkArtifact('mupot.project-link-receipt/v1/signature', value)
    const bytes = canonicalDomainSeparatedBytes('mupot.project-link-receipt/v1/signature', value)

    expect(artifact).toBe(new TextDecoder().decode(bytes))
    expect(bytesToHex(bytes)).toBe(
      '4d55504f542d5349474e45442d43414e4f4e4943414c2d4a534f4e006d75706f742e70726f6a6563742d6c696e6b2d726563656970742f76312f7369676e6174757265007b226163636570746564223a747275652c2265766964656e6365223a6e756c6c2c22726563656970745f6964223a22726563656970742d303031227d',
    )
  })

  it('signs domain-separated envelope bytes rather than bare canonical JSON', async () => {
    const keys = await generateProjectLinkKeyPair()
    const input = envelopeInput()
    const { schema: _schema, ...unsigned } = input
    const signed = await createSignedProjectEnvelope(unsigned, keys.privateKey)
    const signature = fromB64url(signed.signature)

    expect(await crypto.subtle.verify(
      { name: 'Ed25519' }, keys.publicKey, signature,
      new TextEncoder().encode(canonicalProjectLinkEnvelope(signed.envelope)),
    )).toBe(true)
    expect(canonicalProjectLinkEnvelopeSigningBytes(signed.envelope)).toEqual(
      new TextEncoder().encode(canonicalProjectLinkEnvelope(signed.envelope)),
    )
    expect(canonicalProjectLinkEnvelope(signed.envelope)).toBe(
      canonicalProjectLinkArtifact(PROJECT_LINK_ENVELOPE_SIGNATURE_DOMAIN, signed.envelope),
    )
    expect(await crypto.subtle.verify(
      { name: 'Ed25519' }, keys.publicKey, signature,
      new TextEncoder().encode(canonicalJson(signed.envelope)),
    )).toBe(false)
    expect(PROJECT_LINK_ENVELOPE_SIGNATURE_DOMAIN).toBe('mupot.project-link-envelope/v1/signature')
  })

  it('applies prohibited-content checks to every transmitted string', () => {
    const mutations: Array<[string, (value: ReturnType<typeof envelopeInput>) => void]> = [
      ['schema', (value) => { value.schema = 'mupot_secret' as typeof PROJECT_LINK_ENVELOPE_SCHEMA }],
      ['source.pot', (value) => { value.source.pot = 'mupot_secret' }],
      ['source.project_id', (value) => { value.source.project_id = 'mupot_secret' }],
      ['source.agent_id', (value) => { value.source.agent_id = 'mupot_secret' }],
      ['source.key_id', (value) => { value.source.key_id = 'mupot_secret' }],
      ['destination.pot', (value) => { value.destination.pot = 'mupot_secret' }],
      ['destination.project_id', (value) => { value.destination.project_id = 'mupot_secret' }],
      ['correlation_id', (value) => { value.correlation_id = 'mupot_secret' }],
      ['idempotency_key', (value) => { value.idempotency_key = 'mupot_secret' }],
      ['requested_capability', (value) => { value.requested_capability = 'Bearer unsafe' as 'project.evidence.write' }],
      ['expires_at', (value) => { value.expires_at = 'Bearer unsafe' }],
      ['task.source_task_id', (value) => { value.task.source_task_id = 'mupot_secret' }],
      ['task.flight_id', (value) => { value.task.flight_id = 'mupot_secret' }],
      ['task.request_id', (value) => { value.task.request_id = 'mupot_secret' }],
      ['task.title', (value) => { value.task.title = 'Bearer unsafe' }],
      ['task.state', (value) => { value.task.state = 'Bearer unsafe' as 'in_progress' }],
      ['task.priority', (value) => { value.task.priority = 'Bearer unsafe' as 'high' }],
      ['task.blocker_summary', (value) => { value.task.blocker_summary = 'Bearer unsafe' }],
      ['task.success_predicate', (value) => { value.task.success_predicate = 'Bearer unsafe' }],
      ['task.progress_summary', (value) => { value.task.progress_summary = 'Bearer unsafe' }],
      ['evidence.sha256', (value) => { value.evidence.sha256 = 'mupot_secret' }],
      ['evidence.media_type', (value) => { value.evidence.media_type = 'Bearer unsafe' as 'application/json' }],
      ['evidence.occurred_at', (value) => { value.evidence.occurred_at = 'Bearer unsafe' }],
      ['evidence.url', (value) => { value.evidence.url = 'https://evidence.dme.test/mupot_secret' }],
    ]

    for (const [path, mutate] of mutations) {
      const value = envelopeInput()
      mutate(value)
      expect(validateProjectLinkEnvelope(value), path).toEqual({ ok: false, reason: 'prohibited_content', path })
    }
  })

  it('restricts identifiers to opaque safe references without credential-shaped values', () => {
    for (const unsafe of ['tenant:project', '.hidden', 'trailing-', 'percent%2Fref', 'ghp_abcdefghijklmnopqrstuvwxyz1234567890']) {
      const value = envelopeInput()
      value.correlation_id = unsafe
      expect(validateProjectLinkEnvelope(value), unsafe).toMatchObject({ ok: false, path: 'correlation_id' })
    }

    const valid = envelopeInput()
    valid.correlation_id = '01J2YF7Q5K_opaque.ref-9'
    expect(validateProjectLinkEnvelope(valid).ok).toBe(true)
  })

  it('treats evidence URLs as strict HTTPS references without query strings or fragments', () => {
    for (const url of [
      'http://evidence.dme.test/receipt',
      'https://evidence.dme.test/receipt?download=1',
      'https://evidence.dme.test/receipt#proof',
    ]) {
      const value = envelopeInput()
      value.evidence.url = url
      expect(validateProjectLinkEnvelope(value), url).toEqual({ ok: false, reason: 'invalid_url', path: 'evidence.url' })
    }

    const withUserInfo = envelopeInput()
    withUserInfo.evidence.url = 'https://user@evidence.dme.test/receipt'
    expect(validateProjectLinkEnvelope(withUserInfo)).toEqual({
      ok: false, reason: 'prohibited_content', path: 'evidence.url',
    })
  })

  it('decodes evidence URL paths to a bounded fixed point before checking prohibited content', () => {
    const nestedSecret = envelopeInput()
    nestedSecret.evidence.url = `https://evidence.dme.test/${encodeURIComponent(
      encodeURIComponent(encodeURIComponent(encodeURIComponent('mupot_secret'))),
    )}`
    expect(validateProjectLinkEnvelope(nestedSecret)).toEqual({
      ok: false, reason: 'prohibited_content', path: 'evidence.url',
    })

    const nonConverging = envelopeInput()
    let path = '/safe-receipt'
    for (let pass = 0; pass < 20; pass += 1) path = encodeURIComponent(path)
    nonConverging.evidence.url = `https://evidence.dme.test/${path}`
    expect(validateProjectLinkEnvelope(nonConverging)).toEqual({
      ok: false, reason: 'invalid_url', path: 'evidence.url',
    })
  })

  it('enforces an explicit approved evidence-origin list when supplied', () => {
    const value = envelopeInput()

    expect(validateProjectLinkEnvelope(value, {
      approvedEvidenceOrigins: ['https://evidence.dme.test'],
    }).ok).toBe(true)
    expect(validateProjectLinkEnvelope(value, {
      approvedEvidenceOrigins: ['https://receipts.mumega.test'],
    })).toEqual({ ok: false, reason: 'unapproved_origin', path: 'evidence.url' })
    expect(validateProjectLinkEnvelope(value, {
      approvedEvidenceOrigins: [],
    })).toEqual({ ok: false, reason: 'unapproved_origin', path: 'evidence.url' })
  })
})
