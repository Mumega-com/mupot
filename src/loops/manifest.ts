// mupot — the Loop manifest: the declarative resource that the Loop Container runs.
//
// A Loop is NOT hardcoded pipeline. It is a declarative record that binds RESOURCES
// (sources, channels, a human gate, a money budget, a cadence) to a GOAL, and the
// container runs its cycle + enforces the resource accounting. Outreach/support/
// research are CONFIGS of this one shape. See
// docs/superpowers/specs/2026-06-08-loop-container-design.md §3.
//
// This module is PURE — types + validators, no I/O. Storage (src/loops/service.ts)
// persists a validated manifest; the runtime (src/loops/runtime.ts) reads it. We
// follow the repo's manual-validation convention (org/service.ts), not a schema lib,
// to stay dependency-free and under the Worker size budget.
//
// SECURITY: a ResourceRef NEVER carries a secret. `auth_ref` is an OPAQUE NAME that
// the resolver maps to a Worker binding/secret server-side. The manifest is tenant
// data; it must never be trusted to supply credentials or identity.

import type { Effort } from '../types'
import { isEffort, isBudgetWindow } from '../types'

// ── enums ────────────────────────────────────────────────────────────────────

export type LoopStatus = 'active' | 'paused' | 'done' | 'killed'
export type ResourceKind = 'mcp' | 'queue' | 'memory'
export type GateTimeout = 'pause' | 'reject'

const LOOP_STATUSES: readonly LoopStatus[] = ['active', 'paused', 'done', 'killed']
const RESOURCE_KINDS: readonly ResourceKind[] = ['mcp', 'queue', 'memory']
const GATE_TIMEOUTS: readonly GateTimeout[] = ['pause', 'reject']

export function isLoopStatus(v: unknown): v is LoopStatus {
  return typeof v === 'string' && (LOOP_STATUSES as readonly string[]).includes(v)
}
export function isResourceKind(v: unknown): v is ResourceKind {
  return typeof v === 'string' && (RESOURCE_KINDS as readonly string[]).includes(v)
}
export function isGateTimeout(v: unknown): v is GateTimeout {
  return typeof v === 'string' && (GATE_TIMEOUTS as readonly string[]).includes(v)
}

// ── shapes ───────────────────────────────────────────────────────────────────

/**
 * A bound resource. `kind:'mcp'` resolves to an MCP server's tool surface (url +
 * auth_ref naming a server-side secret); `queue`/`memory` are in-pot built-ins
 * named by `name`. `tool_filter` optionally allowlists tool names from the source.
 */
export interface ResourceRef {
  kind: ResourceKind
  url?: string // kind='mcp' only — must be https
  auth_ref?: string // OPAQUE binding/secret NAME, never the secret itself
  name?: string // built-in selector (queue name / memory scope)
  tool_filter?: string[] // optional allowlist of tool names
}

/** How the loop's OUTCOME is measured. signal÷target, NOT a task count by default. */
export interface KpiSpec {
  signal: string // named outcome signal, e.g. 'positive_replies' | 'done_tasks'
  target: number // positive denominator
  source?: string // optional ResourceRef name that supplies the signal
}

/** Human gate policy. on_timeout NEVER auto-approves. */
export interface GatePolicy {
  require_approval: boolean
  timeout_sec?: number
  on_timeout?: GateTimeout // default 'pause'
}

export interface LoopBudget {
  cap_micro_usd?: number | null // null/absent ⇒ unlimited (within the meter's token cap)
  window?: 'day' | 'week'
  effort?: Effort
}

export interface LoopCadence {
  heartbeat?: boolean // driven by the metabolism tick
  on_event?: boolean // resumes on an inbound event (e.g. a reply)
  alarm_sec?: number | null // self-reschedule timer (follow-up)
}

export interface LoopStop {
  dry_rounds_max?: number // N empty ticks → pause
  on_kpi_met?: boolean // stop when kpi >= 100
  kill?: boolean // hard kill flag
}

/** The writable subset of a loop (what a caller declares). */
export interface LoopSpec {
  squad_id: string | null
  agent_id: string | null
  okr: string
  kpi: KpiSpec
  sources: ResourceRef[]
  channels: ResourceRef[]
  gate: GatePolicy
  budget: LoopBudget
  cadence: LoopCadence
  stop: LoopStop
}

/** A persisted loop = a validated spec + identity + lifecycle. */
export interface LoopManifest extends LoopSpec {
  id: string
  tenant: string
  status: LoopStatus
  created_at: string
}

// ── validation (manual; mirrors org/service.ts) ───────────────────────────────

export type Validate<T> = { ok: true; value: T } | { ok: false; error: string }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Block private / loopback / link-local / cloud-metadata hosts (SSRF defense).
 * Hostname-literal based — does NOT resolve DNS, so it cannot stop DNS-rebinding
 * (a public name pointing at 169.254.x). The real protection against secret exfil
 * is host-pinning in the resolver (a secret only travels to its pinned host); this
 * is defense-in-depth for the unauthenticated read case.
 */
export function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h === '0.0.0.0' || h.endsWith('.internal') || h.endsWith('.local')) return true
  if (h === '169.254.169.254') return true // cloud metadata endpoint
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true
  if (/^169\.254\./.test(h)) return true
  if (h === '::1') return true
  if (h.startsWith('fe80:')) return true // IPv6 link-local
  if (h.startsWith('fc') || h.startsWith('fd')) return true // IPv6 ULA
  return false
}

/** https + a non-blocked host. Used for any mcp ResourceRef url. */
function isSafeHttpsUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0) return false
  try {
    const u = new URL(v)
    return u.protocol === 'https:' && !isBlockedHost(u.hostname)
  } catch {
    return false
  }
}

/** auth_ref is an opaque logical name → must be a safe identifier (no env-key smuggling). */
function isSafeAuthRef(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_]+$/.test(v) && v.length <= 64
}

/** Validate a single ResourceRef. mcp ⇒ https url required; secrets never inline. */
export function validateResourceRef(input: unknown): Validate<ResourceRef> {
  if (!isPlainObject(input)) return { ok: false, error: 'resource_not_object' }
  if (!isResourceKind(input.kind)) return { ok: false, error: 'invalid_resource_kind' }

  const ref: ResourceRef = { kind: input.kind }

  if (input.kind === 'mcp') {
    if (!isSafeHttpsUrl(input.url)) return { ok: false, error: 'mcp_url_must_be_https_public' }
    ref.url = input.url
  } else {
    // built-in: a name selects the queue/memory scope
    if (input.name !== undefined && typeof input.name !== 'string') {
      return { ok: false, error: 'invalid_resource_name' }
    }
    if (typeof input.name === 'string') ref.name = input.name
  }

  if (input.auth_ref !== undefined) {
    if (!isSafeAuthRef(input.auth_ref)) return { ok: false, error: 'invalid_auth_ref' }
    ref.auth_ref = input.auth_ref
  }
  if (input.tool_filter !== undefined) {
    if (!Array.isArray(input.tool_filter) || input.tool_filter.some((t) => typeof t !== 'string')) {
      return { ok: false, error: 'invalid_tool_filter' }
    }
    ref.tool_filter = input.tool_filter as string[]
  }
  return { ok: true, value: ref }
}

function validateKpi(input: unknown): Validate<KpiSpec> {
  if (!isPlainObject(input)) return { ok: false, error: 'kpi_not_object' }
  if (typeof input.signal !== 'string' || input.signal.trim().length === 0) {
    return { ok: false, error: 'invalid_kpi_signal' }
  }
  if (typeof input.target !== 'number' || !Number.isFinite(input.target) || input.target <= 0) {
    return { ok: false, error: 'invalid_kpi_target' }
  }
  const kpi: KpiSpec = { signal: input.signal, target: input.target }
  if (input.source !== undefined) {
    if (typeof input.source !== 'string') return { ok: false, error: 'invalid_kpi_source' }
    kpi.source = input.source
  }
  return { ok: true, value: kpi }
}

function validateGate(input: unknown): Validate<GatePolicy> {
  if (!isPlainObject(input)) return { ok: false, error: 'gate_not_object' }
  if (typeof input.require_approval !== 'boolean') {
    return { ok: false, error: 'invalid_gate_require_approval' }
  }
  const gate: GatePolicy = { require_approval: input.require_approval }
  if (input.timeout_sec !== undefined) {
    if (typeof input.timeout_sec !== 'number' || !Number.isFinite(input.timeout_sec) || input.timeout_sec <= 0) {
      return { ok: false, error: 'invalid_gate_timeout_sec' }
    }
    gate.timeout_sec = input.timeout_sec
  }
  if (input.on_timeout !== undefined) {
    if (!isGateTimeout(input.on_timeout)) return { ok: false, error: 'invalid_gate_on_timeout' }
    gate.on_timeout = input.on_timeout
  }
  return { ok: true, value: gate }
}

function validateBudget(input: unknown): Validate<LoopBudget> {
  if (!isPlainObject(input)) return { ok: false, error: 'budget_not_object' }
  const budget: LoopBudget = {}
  if (input.cap_micro_usd !== undefined && input.cap_micro_usd !== null) {
    if (typeof input.cap_micro_usd !== 'number' || !Number.isInteger(input.cap_micro_usd) || input.cap_micro_usd < 0) {
      return { ok: false, error: 'invalid_budget_cap' }
    }
    budget.cap_micro_usd = input.cap_micro_usd
  } else {
    budget.cap_micro_usd = null
  }
  if (input.window !== undefined) {
    if (!isBudgetWindow(input.window)) return { ok: false, error: 'invalid_budget_window' }
    budget.window = input.window
  }
  if (input.effort !== undefined) {
    if (!isEffort(input.effort)) return { ok: false, error: 'invalid_budget_effort' }
    budget.effort = input.effort
  }
  return { ok: true, value: budget }
}

function validateCadence(input: unknown): Validate<LoopCadence> {
  if (!isPlainObject(input)) return { ok: false, error: 'cadence_not_object' }
  const cadence: LoopCadence = {}
  for (const k of ['heartbeat', 'on_event'] as const) {
    if (input[k] !== undefined) {
      if (typeof input[k] !== 'boolean') return { ok: false, error: `invalid_cadence_${k}` }
      cadence[k] = input[k] as boolean
    }
  }
  if (input.alarm_sec !== undefined && input.alarm_sec !== null) {
    if (typeof input.alarm_sec !== 'number' || !Number.isFinite(input.alarm_sec) || input.alarm_sec <= 0) {
      return { ok: false, error: 'invalid_cadence_alarm_sec' }
    }
    cadence.alarm_sec = input.alarm_sec
  }
  return { ok: true, value: cadence }
}

function validateStop(input: unknown): Validate<LoopStop> {
  if (!isPlainObject(input)) return { ok: false, error: 'stop_not_object' }
  const stop: LoopStop = {}
  if (input.dry_rounds_max !== undefined) {
    if (typeof input.dry_rounds_max !== 'number' || !Number.isInteger(input.dry_rounds_max) || input.dry_rounds_max < 0) {
      return { ok: false, error: 'invalid_stop_dry_rounds_max' }
    }
    stop.dry_rounds_max = input.dry_rounds_max
  }
  for (const k of ['on_kpi_met', 'kill'] as const) {
    if (input[k] !== undefined) {
      if (typeof input[k] !== 'boolean') return { ok: false, error: `invalid_stop_${k}` }
      stop[k] = input[k] as boolean
    }
  }
  return { ok: true, value: stop }
}

/**
 * validateLoopSpec — validate the writable subset of a loop. Exactly one of
 * squad_id / agent_id must be set (a loop is owned by one work-unit at one fractal
 * level). sources/channels each validated element-wise.
 */
export function validateLoopSpec(input: unknown): Validate<LoopSpec> {
  if (!isPlainObject(input)) return { ok: false, error: 'spec_not_object' }

  const squad_id = input.squad_id === undefined ? null : input.squad_id
  const agent_id = input.agent_id === undefined ? null : input.agent_id
  if (squad_id !== null && typeof squad_id !== 'string') return { ok: false, error: 'invalid_squad_id' }
  if (agent_id !== null && typeof agent_id !== 'string') return { ok: false, error: 'invalid_agent_id' }
  if ((squad_id === null) === (agent_id === null)) {
    return { ok: false, error: 'exactly_one_owner_required' } // both null or both set
  }

  if (typeof input.okr !== 'string' || input.okr.trim().length === 0) {
    return { ok: false, error: 'invalid_okr' }
  }

  const kpi = validateKpi(input.kpi)
  if (!kpi.ok) return kpi
  const gate = validateGate(input.gate)
  if (!gate.ok) return gate
  const budget = validateBudget(input.budget)
  if (!budget.ok) return budget
  const cadence = validateCadence(input.cadence)
  if (!cadence.ok) return cadence
  const stop = validateStop(input.stop)
  if (!stop.ok) return stop

  const sources = validateRefList(input.sources, 'sources')
  if (!sources.ok) return sources
  const channels = validateRefList(input.channels, 'channels')
  if (!channels.ok) return channels

  return {
    ok: true,
    value: {
      squad_id: squad_id as string | null,
      agent_id: agent_id as string | null,
      okr: input.okr,
      kpi: kpi.value,
      sources: sources.value,
      channels: channels.value,
      gate: gate.value,
      budget: budget.value,
      cadence: cadence.value,
      stop: stop.value,
    },
  }
}

function validateRefList(input: unknown, label: string): Validate<ResourceRef[]> {
  if (input === undefined) return { ok: true, value: [] }
  if (!Array.isArray(input)) return { ok: false, error: `invalid_${label}` }
  const out: ResourceRef[] = []
  for (const el of input) {
    const r = validateResourceRef(el)
    if (!r.ok) return { ok: false, error: `${label}: ${r.error}` }
    out.push(r.value)
  }
  return { ok: true, value: out }
}
