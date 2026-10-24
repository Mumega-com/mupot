import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HARNESS_PROBE_METRIC,
  extractVerboseMetaValues,
  maybeEmitHarnessIdentityProbe,
  resetHarnessProbeSampling,
  type ProbeInputs,
} from '../src/mcp/harness-identity-probe'

const SECRET = 'test-master-key-material'
const RAW_BEARER = 'Bearer sk-live-AAAABBBBCCCC'
const RAW_COOKIE = 'session=cookie-value-12345'
const RAW_TOKEN_META = 'tok-meta-value-98765'
const RAW_UA = 'ChatGPT-User/1.0 (raw-ua-string)'
const RAW_OPENAI_HDR = 'raw-openai-header-value'

function base(over: Partial<ProbeInputs> = {}): ProbeInputs {
  return {
    headerSeat: null, metaSeat: null, openaiSession: null, openaiSubject: null, codexThreadId: null,
    metaKeys: [], clientInfoName: null, hasMcpSessionId: false, protocolVersionHeader: null, ...over,
  }
}

function verboseInputs() {
  return {
    metaValues: extractVerboseMetaValues({
      'openai/locale': 'en-CA',
      'openai/userAgent': RAW_UA,
      accessToken: RAW_TOKEN_META,
      'x-api-key': 'k-123',
      authorization: RAW_BEARER,
      long: 'x'.repeat(500),
      num: 5,
    }),
    headers: [
      ['user-agent', RAW_UA],
      ['openai-conversation-id', RAW_OPENAI_HDR],
      ['x-cursor-client-version', '1.2.3'],
      ['x-forwarded-for', '203.0.113.9'],
      ['authorization', RAW_BEARER],
      ['cookie', RAW_COOKIE],
      ['x-client-token', 'abc'],
      ['x-api-key', 'k-123'],
    ] as Array<[string, string]>,
    clientInfoName: 'openai-mcp',
    clientInfoVersion: '1.0.0',
  }
}

let lines: string[]
beforeEach(() => {
  resetHarnessProbeSampling()
  lines = []
  vi.spyOn(console, 'info').mockImplementation((s: unknown) => { lines.push(String(s)) })
})
afterEach(() => { vi.restoreAllMocks() })

const run = async (env: Record<string, string | undefined>, grant = 'g1', v = true) =>
  maybeEmitHarnessIdentityProbe(env as never, grant, base(v ? { verbose: verboseInputs() } : {}))

describe('HARNESS_PROBE_VERBOSE', () => {
  it('flag off: output is identical to the pre-existing line (no verbose key), whatever the inputs carry', async () => {
    await run({ SEAT_AUTO_ENROLL: '1', CONNECTOR_MASTER_KEY: SECRET })
    const ev = JSON.parse(lines[0])
    expect(ev.metric).toBe(HARNESS_PROBE_METRIC)
    expect('verbose' in ev).toBe(false)
  })

  it('both flags off: nothing is emitted', async () => {
    await run({ CONNECTOR_MASTER_KEY: SECRET })
    expect(lines).toEqual([])
  })

  it('runs with SEAT_AUTO_ENROLL off when the verbose flag is on', async () => {
    await run({ HARNESS_PROBE_VERBOSE: '1', CONNECTOR_MASTER_KEY: SECRET })
    expect(lines.length).toBe(1)
    expect(JSON.parse(lines[0]).verbose).toBeTruthy()
  })

  it('only the strict value 1 turns it on', async () => {
    await run({ HARNESS_PROBE_VERBOSE: 'true', CONNECTOR_MASTER_KEY: SECRET })
    expect(lines).toEqual([])
  })

  it('denylisted keys and header names never appear, and no raw value appears anywhere in the output', async () => {
    await run({ HARNESS_PROBE_VERBOSE: '1', SEAT_AUTO_ENROLL: '1', CONNECTOR_MASTER_KEY: SECRET })
    const out = lines.join('\n')
    for (const bad of [RAW_BEARER, RAW_COOKIE, RAW_TOKEN_META, 'k-123', 'sk-live', 'accessToken', 'x-api-key', 'authorization', 'cookie', 'x-client-token', RAW_UA, RAW_OPENAI_HDR, '203.0.113.9', 'en-CA']) {
      expect(out.toLowerCase()).not.toContain(bad.toLowerCase())
    }
    const v = JSON.parse(lines[0]).verbose
    expect(v.denied_headers).toBe(4)
    expect(Object.keys(v.meta_h).sort()).toEqual(['openai/locale', 'openai/userAgent'])
    expect(v.header_names).toEqual(['user-agent', 'openai-conversation-id', 'x-cursor-client-version', 'x-forwarded-for'])
    expect(Object.keys(v.header_h).sort()).toEqual(['openai-conversation-id', 'user-agent', 'x-cursor-client-version'])
    expect(v.client_info_name).toBe('openai-mcp')
    expect(v.client_info_version).toBe('1.0.0')
  })

  it('a denylisted key is dropped even if handed straight to the probe (defense in depth)', async () => {
    await maybeEmitHarnessIdentityProbe({ HARNESS_PROBE_VERBOSE: '1', CONNECTOR_MASTER_KEY: SECRET } as never, 'g', base({
      verbose: { metaValues: [['api_key', 'v1'], ['Password', 'v2'], ['ok', 'v3']], headers: [['Set-Cookie', 'c'], ['X-Secret-Thing', 's']], clientInfoName: null, clientInfoVersion: null },
    }))
    const v = JSON.parse(lines[0]).verbose
    expect(Object.keys(v.meta_h)).toEqual(['ok'])
    expect(v.header_names).toEqual([])
    expect(v.denied_headers).toBe(2)
  })

  it('hashes are stable for the same input and differ for different input', async () => {
    const env = { HARNESS_PROBE_VERBOSE: '1', CONNECTOR_MASTER_KEY: SECRET }
    await run(env)
    resetHarnessProbeSampling()
    await run(env)
    resetHarnessProbeSampling()
    await maybeEmitHarnessIdentityProbe(env as never, 'g1', base({ verbose: { ...verboseInputs(), metaValues: [['openai/locale', 'fr-CA']] } }))
    const [a, b, c] = lines.map((l) => JSON.parse(l).verbose)
    expect(a.meta_h).toEqual(b.meta_h)
    expect(a.header_h).toEqual(b.header_h)
    expect(a.meta_h['openai/locale']).toMatch(/^[0-9a-f]{12}$/)
    expect(c.meta_h['openai/locale']).not.toBe(a.meta_h['openai/locale'])
  })

  it('without a server secret no hash is emitted (values stay null)', async () => {
    await run({ HARNESS_PROBE_VERBOSE: '1' })
    const v = JSON.parse(lines[0]).verbose
    expect(Object.values(v.meta_h).every((h) => h === null)).toBe(true)
  })

  it('is bounded: oversized values are skipped and counts are capped', async () => {
    const many: Array<[string, string]> = Array.from({ length: 200 }, (_, i) => [`h${i}`, 'v'])
    await maybeEmitHarnessIdentityProbe({ HARNESS_PROBE_VERBOSE: '1', CONNECTOR_MASTER_KEY: SECRET } as never, 'g', base({
      verbose: { metaValues: extractVerboseMetaValues(Object.fromEntries(many.concat([['big', 'y'.repeat(300)]]))), headers: many.map(([n, v]) => [`x-client-${n}`, v] as [string, string]), clientInfoName: 'n'.repeat(500), clientInfoVersion: null },
    }))
    const v = JSON.parse(lines[0]).verbose
    expect(Object.keys(v.meta_h).length).toBeLessThanOrEqual(24)
    expect(v.header_names.length).toBeLessThanOrEqual(40)
    expect(Object.keys(v.header_h).length).toBeLessThanOrEqual(16)
    expect(v.client_info_name.length).toBe(40)
    expect(lines[0].length).toBeLessThan(4000)
  })

  it('extractVerboseMetaValues skips denylisted keys and non-short-string values', () => {
    expect(extractVerboseMetaValues({ a: 'x', 'my-token': 'y', n: 1, o: {}, e: '' })).toEqual([['a', 'x']])
  })
})
