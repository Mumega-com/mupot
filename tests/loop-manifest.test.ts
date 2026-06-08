// tests/loop-manifest.test.ts — the Loop manifest validators (P1, pure, no I/O).
//
// Covers: ResourceRef (mcp https requirement, built-in name, auth_ref/tool_filter,
// secret-never-inline shape), KpiSpec, GatePolicy (on_timeout never auto-approve is
// a runtime concern; here we just validate the enum), budget/cadence/stop, and the
// LoopSpec composite incl. the exactly-one-owner rule.

import { describe, expect, it } from 'vitest'
import {
  validateResourceRef,
  validateLoopSpec,
  isResourceKind,
  isLoopStatus,
  isGateTimeout,
} from '../src/loops/manifest'

describe('enum guards', () => {
  it('resource kinds', () => {
    expect(isResourceKind('mcp')).toBe(true)
    expect(isResourceKind('queue')).toBe(true)
    expect(isResourceKind('memory')).toBe(true)
    expect(isResourceKind('http')).toBe(false)
  })
  it('loop status + gate timeout', () => {
    expect(isLoopStatus('active')).toBe(true)
    expect(isLoopStatus('running')).toBe(false)
    expect(isGateTimeout('pause')).toBe(true)
    expect(isGateTimeout('approve')).toBe(false)
  })
})

describe('validateResourceRef', () => {
  it('mcp requires a public https url', () => {
    expect(validateResourceRef({ kind: 'mcp', url: 'https://x.example/mcp' }).ok).toBe(true)
    const bad = validateResourceRef({ kind: 'mcp', url: 'http://x.example/mcp' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toBe('mcp_url_must_be_https_public')
  })

  it('rejects private/loopback/metadata hosts (SSRF)', () => {
    for (const url of [
      'https://localhost/mcp',
      'https://127.0.0.1/mcp',
      'https://10.0.0.5/mcp',
      'https://192.168.1.1/mcp',
      'https://169.254.169.254/mcp',
      'https://foo.internal/mcp',
    ]) {
      expect(validateResourceRef({ kind: 'mcp', url }).ok).toBe(false)
    }
  })

  it('rejects an auth_ref with unsafe characters', () => {
    expect(validateResourceRef({ kind: 'mcp', url: 'https://x/mcp', auth_ref: 'a b' }).ok).toBe(false)
    expect(validateResourceRef({ kind: 'mcp', url: 'https://x/mcp', auth_ref: 'GHL_API_KEY' }).ok).toBe(true)
  })

  it('mcp without url fails', () => {
    const r = validateResourceRef({ kind: 'mcp' })
    expect(r.ok).toBe(false)
  })

  it('built-in queue takes a name, no url', () => {
    const r = validateResourceRef({ kind: 'queue', name: 'prospects' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.name).toBe('prospects')
  })

  it('carries auth_ref (an opaque name) and tool_filter', () => {
    const r = validateResourceRef({
      kind: 'mcp',
      url: 'https://x.example/mcp',
      auth_ref: 'GHL_API_KEY',
      tool_filter: ['search', 'fetch'],
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.auth_ref).toBe('GHL_API_KEY')
      expect(r.value.tool_filter).toEqual(['search', 'fetch'])
    }
  })

  it('rejects a non-string tool_filter element', () => {
    const r = validateResourceRef({ kind: 'mcp', url: 'https://x/mcp', tool_filter: ['ok', 3] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('invalid_tool_filter')
  })

  it('rejects an unknown kind', () => {
    expect(validateResourceRef({ kind: 'ftp' }).ok).toBe(false)
  })
})

describe('validateLoopSpec', () => {
  const base = {
    agent_id: 'agent-1',
    squad_id: null,
    okr: 'Book 5 qualified meetings',
    kpi: { signal: 'positive_replies', target: 5 },
    sources: [{ kind: 'queue', name: 'prospects' }],
    channels: [{ kind: 'mcp', url: 'https://ghl.example/mcp', auth_ref: 'GHL_API_KEY' }],
    gate: { require_approval: true, timeout_sec: 86400, on_timeout: 'pause' },
    budget: { cap_micro_usd: 5_000_000, window: 'week', effort: 'standard' },
    cadence: { heartbeat: true, on_event: true, alarm_sec: 259200 },
    stop: { dry_rounds_max: 3, on_kpi_met: true },
  }

  it('accepts a complete, valid outreach-shaped spec', () => {
    const r = validateLoopSpec(base)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.kpi.signal).toBe('positive_replies')
      expect(r.value.sources).toHaveLength(1)
      expect(r.value.channels[0].kind).toBe('mcp')
      expect(r.value.budget.cap_micro_usd).toBe(5_000_000)
    }
  })

  it('requires exactly one owner (squad XOR agent)', () => {
    expect(validateLoopSpec({ ...base, squad_id: 'sq-1', agent_id: 'agent-1' }).ok).toBe(false)
    expect(validateLoopSpec({ ...base, squad_id: null, agent_id: null }).ok).toBe(false)
    expect(validateLoopSpec({ ...base, squad_id: 'sq-1', agent_id: null }).ok).toBe(true)
  })

  it('rejects a non-positive kpi target', () => {
    const r = validateLoopSpec({ ...base, kpi: { signal: 'x', target: 0 } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('invalid_kpi_target')
  })

  it('rejects an empty okr', () => {
    expect(validateLoopSpec({ ...base, okr: '   ' }).ok).toBe(false)
  })

  it('rejects a non-boolean gate.require_approval', () => {
    const r = validateLoopSpec({ ...base, gate: { require_approval: 'yes' } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('invalid_gate_require_approval')
  })

  it('defaults sources/channels to empty when omitted', () => {
    const { sources, channels, ...noLists } = base
    const r = validateLoopSpec(noLists)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.sources).toEqual([])
      expect(r.value.channels).toEqual([])
    }
  })

  it('propagates a bad nested resource error with the list label', () => {
    const r = validateLoopSpec({ ...base, channels: [{ kind: 'mcp', url: 'http://insecure' }] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('channels: mcp_url_must_be_https_public')
  })

  it('rejects a negative budget cap', () => {
    expect(validateLoopSpec({ ...base, budget: { cap_micro_usd: -1 } }).ok).toBe(false)
  })
})
