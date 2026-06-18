// tests/loop-manifest-contract.test.ts — the FROZEN Loop manifest contract (v1, #38).
//
// As of v1.0 the Loop manifest is a STABLE PUBLIC CONTRACT. The manifests and validated
// shapes pinned here ARE that contract. A change that breaks any assertion in this file
// is a BREAKING change to the contract and requires a MAJOR version bump (2.0).
//
// Do NOT edit this test to make a breaking change pass — that defeats its purpose. Add a
// NEW, additive contract (new optional field, new ResourceRef kind) without breaking the
// frozen v1 shape. The v1 invariants (exactly-one-owner, CASL channel-gate, MCP-native
// refs, gate enum) are guarantees consumers build on.

import { describe, expect, it } from 'vitest'
import { validateLoopSpec, validateResourceRef } from '../src/loops/manifest'

// ── The canonical v1 manifest — every field exercised. FROZEN. ───────────────────
const FROZEN_V1 = {
  agent_id: 'agent-1',
  squad_id: null,
  okr: 'Book qualified meetings',
  kpi: { signal: 'positive_replies', target: 5, source: 'prospects' },
  sources: [
    { kind: 'queue', name: 'prospects' },
    { kind: 'memory', name: 'outreach' },
    { kind: 'mcp', url: 'https://srv.example/mcp', auth_ref: 'ghl', tool_filter: ['search', 'fetch'] },
  ],
  channels: [{ kind: 'mcp', url: 'https://ghl.example/mcp', auth_ref: 'ghl' }],
  gate: { require_approval: true, timeout_sec: 86400, on_timeout: 'pause' },
  budget: { cap_micro_usd: 5_000_000, window: 'week', effort: 'standard' },
  cadence: { heartbeat: true, on_event: true, alarm_sec: 259200 },
  stop: { dry_rounds_max: 5, on_kpi_met: true, kill: false },
}

const V1_TOP_LEVEL_KEYS = [
  'agent_id', 'budget', 'cadence', 'channels', 'gate', 'kpi', 'okr', 'sources', 'squad_id', 'stop',
].sort()

describe('Loop manifest contract v1 (FROZEN)', () => {
  it('the canonical v1 manifest validates', () => {
    expect(validateLoopSpec(FROZEN_V1).ok).toBe(true)
  })

  it('the validated LoopSpec has EXACTLY the v1 top-level keys', () => {
    const r = validateLoopSpec(FROZEN_V1)
    expect(r.ok).toBe(true)
    if (r.ok) expect(Object.keys(r.value).sort()).toEqual(V1_TOP_LEVEL_KEYS)
  })

  it('a MINIMAL manifest (required fields only) validates and defaults sources/channels empty', () => {
    const minimal = {
      agent_id: 'a',
      okr: 'do the thing',
      kpi: { signal: 'x', target: 1 },
      gate: { require_approval: true },
      budget: {},
      cadence: {},
      stop: {},
    }
    const r = validateLoopSpec(minimal)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.sources).toEqual([])
      expect(r.value.channels).toEqual([])
      expect(r.value.squad_id).toBeNull()
    }
  })

  it('the v1 ResourceRef kinds are exactly {mcp, queue, memory}', () => {
    expect(validateResourceRef({ kind: 'mcp', url: 'https://x/mcp' }).ok).toBe(true)
    expect(validateResourceRef({ kind: 'queue', name: 'q' }).ok).toBe(true)
    expect(validateResourceRef({ kind: 'memory', name: 'm' }).ok).toBe(true)
    expect(validateResourceRef({ kind: 'http', url: 'https://x' }).ok).toBe(false)
  })

  it('v1 gate contract: require_approval boolean, on_timeout ∈ {pause, reject}', () => {
    expect(validateLoopSpec({ ...FROZEN_V1, gate: { require_approval: true, on_timeout: 'reject' } }).ok).toBe(true)
    expect(validateLoopSpec({ ...FROZEN_V1, gate: { require_approval: true, on_timeout: 'approve' } }).ok).toBe(false)
  })

  // ── ADDITIVE extensions (non-breaking; do not alter the frozen v1 shape) ──
  it('ADDITIVE (S5): `kind` is optional — absent ⇒ omitted (v1 shape unchanged), explicit ⇒ carried', () => {
    const r0 = validateLoopSpec(FROZEN_V1) // v1 manifest has no kind
    expect(r0.ok).toBe(true)
    if (r0.ok) expect('kind' in r0.value).toBe(false) // frozen shape preserved

    const rc = validateLoopSpec({ ...FROZEN_V1, kind: 'cro' })
    expect(rc.ok).toBe(true)
    if (rc.ok) expect(rc.value.kind).toBe('cro')

    expect(validateLoopSpec({ ...FROZEN_V1, kind: 'nope' }).ok).toBe(false) // unknown kind rejected
  })

  // ── v1 INVARIANTS — guarantees consumers build on. Breaking any = a 2.0. ──
  it('INVARIANT: exactly one owner (squad XOR agent)', () => {
    expect(validateLoopSpec({ ...FROZEN_V1, squad_id: 's', agent_id: 'a' }).ok).toBe(false)
    expect(validateLoopSpec({ ...FROZEN_V1, squad_id: null, agent_id: null }).ok).toBe(false)
  })

  it('INVARIANT: a loop with any channel MUST be gated (CASL/no-auto-send)', () => {
    expect(validateLoopSpec({ ...FROZEN_V1, gate: { require_approval: false } }).ok).toBe(false)
  })

  it('INVARIANT: mcp refs are https + public host; secrets are named, never inline', () => {
    expect(validateResourceRef({ kind: 'mcp', url: 'http://x/mcp' }).ok).toBe(false)
    expect(validateResourceRef({ kind: 'mcp', url: 'https://127.0.0.1/mcp' }).ok).toBe(false)
    // auth_ref is an opaque NAME (charset-restricted), resolved server-side to a binding.
    expect(validateResourceRef({ kind: 'mcp', url: 'https://x/mcp', auth_ref: 'a b' }).ok).toBe(false)
  })

  it('INVARIANT: kpi.target must be a positive number (outcome denominator)', () => {
    expect(validateLoopSpec({ ...FROZEN_V1, kpi: { signal: 'x', target: 0 } }).ok).toBe(false)
  })
})
