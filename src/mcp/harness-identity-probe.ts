// mupot#1794 W2 step 0 — harness identity probe (flag-gated, read-only observability).
//
// The research on which harness sends which thread identifier is partly UNVERIFIED (see
// agents/kasra/docs/harness-seat-identity-research-20261009.md). This logs, per grant at most once
// per hour per isolate, WHICH identifier channels a real client actually populates — as presence
// booleans plus short hashes of the values, NEVER the raw values — so the per-harness defaults can
// be chosen from evidence instead of community reports.
//
// Nothing here selects or authorises anything, writes anything, or can fail a request.

import type { Env } from '../types'
import { seatAutoEnrollEnabled } from '../members/harness'
import type { HarnessHints } from '../members/seat-handle'

export const HARNESS_PROBE_METRIC = 'harness_identity_probe'
const PROBE_INTERVAL_MS = 60 * 60 * 1000
const PROBE_MAX_TRACKED = 2000
const META_KEY_MAX = 20
const META_KEY_LEN = 48

// Per-isolate sampling state. Deliberately lossy: a new isolate logs again, which only means a few
// extra sampled lines. Bounded so it cannot grow without limit.
const lastLogged = new Map<string, number>()

export interface ProbeInputs {
  headerSeat: string | null
  metaSeat: string | null
  openaiSession: string | null
  openaiSubject: string | null
  codexThreadId: string | null
  /** Names (never values) of the top-level _meta keys, to discover fields we do not know about. */
  metaKeys: string[]
  clientInfoName: string | null
  hasMcpSessionId: boolean
  protocolVersionHeader: string | null
  /** Present only for the verbose probe (HARNESS_PROBE_VERBOSE). Never consulted when the flag is off. */
  verbose?: VerboseProbeInputs
}

/** Raw verbose facts as gathered at the call site. Reduced to keyed hashes before anything is logged. */
export interface VerboseProbeInputs {
  /** Top-level `_meta` entries as [name, value]. value is null when the key is present but must not be hashed. */
  metaValues: Array<[string, string | null]>
  /** Request headers as [name, value]. Values are hashed only for allowlisted names. */
  headers: Array<[string, string]>
  clientInfoName: string | null
  clientInfoVersion: string | null
}

// Hard denylist, applied (after NFKC normalisation) to every `_meta` key and header name before anything is read or hashed.
export const PROBE_DENY_RE = /auth|bearer|jwt|cred|token|secret|key|pass|pwd|pin|otp|sig|cookie|csrf|xsrf|nonce|private|cert|assertion|session-?id|seat|email|e-mail|phone|ip$/i
// `_meta` keys whose VALUES may be hashed. Every other key is logged by name only (present: true). Extend here.
export const PROBE_META_HASH_ALLOW: ReadonlySet<string> = new Set([
  'openai/locale', 'openai/userAgent', 'openai/session', 'openai/subject', 'openai/organization', 'threadId', 'thread_id',
])
// Header names whose values may be hashed (names of all non-denied headers are listed regardless). Exact names for x-client-*:
// ip / forwarded / cert / real-ip / connecting headers are never hashed.
const PROBE_HEADER_HASH_ALLOW_RE = /^(user-agent|openai-.+|x-openai-.+|x-cursor-.+|x-client-name|x-client-version)$/i
const CLIENT_VERSION_RE = /^[0-9A-Za-z.+-]{1,24}$/
const NON_ASCII_RE = /[^\x00-\x7F]/
const VERBOSE_VALUE_MAX = 256
const VERBOSE_MAX_META = 24
const VERBOSE_MAX_HEADER_NAMES = 40
const VERBOSE_MAX_HEADER_HASHES = 16

/** True when a key or header name may appear in the probe at all: ASCII only, and clear of the denylist before and after NFKC. */
export function probeNameAllowed(name: string): boolean {
  if (NON_ASCII_RE.test(name)) return false
  return !PROBE_DENY_RE.test(name) && !PROBE_DENY_RE.test(name.normalize('NFKC'))
}

export function verboseProbeEnabled(env: Pick<Env, 'HARNESS_PROBE_VERBOSE'>): boolean {
  return env.HARNESS_PROBE_VERBOSE === '1'
}

/** Collect the verbose facts from a `_meta` object. Denied keys are dropped here; only allowlisted keys keep a value. */
export function extractVerboseMetaValues(meta: unknown): Array<[string, string | null]> {
  const m = typeof meta === 'object' && meta !== null && !Array.isArray(meta) ? meta as Record<string, unknown> : {}
  const out: Array<[string, string | null]> = []
  for (const [k, v] of Object.entries(m)) {
    if (out.length >= VERBOSE_MAX_META) break
    if (!probeNameAllowed(k)) continue
    const hashable = PROBE_META_HASH_ALLOW.has(k) && typeof v === 'string' && v.length > 0 && v.length <= VERBOSE_VALUE_MAX
    out.push([k, hashable ? v : null])
  }
  return out
}

export function extractClientInfoVersion(meta: unknown): string | null {
  const m = typeof meta === 'object' && meta !== null && !Array.isArray(meta) ? meta as Record<string, unknown> : {}
  const raw = m['clientInfo'] ?? m['io.modelcontextprotocol/clientInfo']
  const ci = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : null
  const v = ci ? str(ci['version']) : null
  return v !== null && CLIENT_VERSION_RE.test(v) ? v : null
}

const cleanName = (k: string): string => k.replace(/[^A-Za-z0-9_./:-]/g, '?').slice(0, META_KEY_LEN)
const cleanLabel = (v: string | null, max: number): string | null =>
  v === null ? null : v.replace(/[^A-Za-z0-9 ._/-]/g, '?').slice(0, max)

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/** Pull the hint values + _meta key names out of a tools/call `_meta` object. */
export function extractMetaFacts(meta: unknown): Pick<ProbeInputs, 'metaSeat' | 'openaiSession' | 'openaiSubject' | 'codexThreadId' | 'metaKeys' | 'clientInfoName'> {
  const m = typeof meta === 'object' && meta !== null && !Array.isArray(meta) ? meta as Record<string, unknown> : {}
  const clientInfoRaw = m['clientInfo'] ?? m['io.modelcontextprotocol/clientInfo']
  const clientInfo = typeof clientInfoRaw === 'object' && clientInfoRaw !== null ? clientInfoRaw as Record<string, unknown> : null
  return {
    metaSeat: str(m['mupot/seat']),
    openaiSession: str(m['openai/session']),
    openaiSubject: str(m['openai/subject']),
    codexThreadId: str(m['threadId']) ?? str(m['thread_id']),
    metaKeys: Object.keys(m).slice(0, META_KEY_MAX).map((k) => k.replace(/[^A-Za-z0-9_./:-]/g, '?').slice(0, META_KEY_LEN)),
    clientInfoName: clientInfo ? str(clientInfo['name']) : null,
  }
}

export function hintsFrom(facts: Pick<ProbeInputs, 'openaiSession' | 'openaiSubject' | 'codexThreadId'>): HarnessHints {
  return {
    openai_session: facts.openaiSession !== null,
    openai_subject: facts.openaiSubject !== null,
    codex_thread_id: facts.codexThreadId !== null,
  }
}

// Hashes are HMAC-SHA256 under a per-deploy server secret (domain-separated), so a logged
// openai/subject or Codex threadId digest cannot be correlated with the same value hashed anywhere
// else, or reversed by guessing candidates. With no secret configured NO hash is emitted (null):
// presence booleans still are.
export async function keyedHash(secret: string | undefined, v: string | null): Promise<string | null> {
  if (v === null || !secret) return null
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`mupot:harness-probe:v1:${v}`))
  return Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12)
}

/** Test seam: forget the sampling state. */
export function resetHarnessProbeSampling(): void {
  lastLogged.clear()
}

async function buildVerbose(secret: string | undefined, vi: VerboseProbeInputs): Promise<Record<string, unknown>> {
  const meta_h: Record<string, string | null> = {}
  const meta_present: Record<string, true> = {}
  for (const [k, v] of vi.metaValues) {
    if (!probeNameAllowed(k)) continue
    // Re-checked here (not only at extraction): a value is hashed only for an allowlisted key.
    if (v !== null && PROBE_META_HASH_ALLOW.has(k) && v.length <= VERBOSE_VALUE_MAX) meta_h[cleanName(k)] = await keyedHash(secret, v)
    else meta_present[cleanName(k)] = true
  }
  const header_names: string[] = []
  const header_h: Record<string, string | null> = {}
  let denied = 0
  for (const [name, value] of vi.headers) {
    if (!probeNameAllowed(name)) { denied++; continue }
    if (header_names.length < VERBOSE_MAX_HEADER_NAMES) header_names.push(cleanName(name.toLowerCase()))
    if (PROBE_HEADER_HASH_ALLOW_RE.test(name) && Object.keys(header_h).length < VERBOSE_MAX_HEADER_HASHES) {
      header_h[cleanName(name.toLowerCase())] = await keyedHash(secret, value.slice(0, VERBOSE_VALUE_MAX))
    }
  }
  const ver = vi.clientInfoVersion !== null && CLIENT_VERSION_RE.test(vi.clientInfoVersion) ? vi.clientInfoVersion : null
  return {
    meta_h,
    meta_present,
    header_names,
    header_h,
    denied_headers: denied,
    client_info_name: cleanLabel(vi.clientInfoName, 40),
    client_info_version: ver,
  }
}

export async function maybeEmitHarnessIdentityProbe(
  env: Pick<Env, 'SEAT_AUTO_ENROLL' | 'CONNECTOR_MASTER_KEY' | 'HARNESS_PROBE_VERBOSE'>,
  grantKey: string,
  inputs: ProbeInputs,
  nowMs: number = Date.now(),
): Promise<void> {
  const verbose = verboseProbeEnabled(env)
  // The verbose probe is its own flag: it runs with SEAT_AUTO_ENROLL off too.
  if (!seatAutoEnrollEnabled(env) && !verbose) return
  try {
    const secret = env.CONNECTOR_MASTER_KEY
    // The sampling key never leaves the isolate; the logged `grant` field is the keyed hash (or null).
    const key = (await keyedHash(secret, grantKey)) ?? grantKey
    const last = lastLogged.get(key)
    if (last !== undefined && nowMs - last < PROBE_INTERVAL_MS) return
    if (lastLogged.size >= PROBE_MAX_TRACKED) lastLogged.clear()
    lastLogged.set(key, nowMs)
    console.info(JSON.stringify({
      metric: HARNESS_PROBE_METRIC,
      grant: await keyedHash(secret, grantKey),
      x_mupot_seat: inputs.headerSeat !== null,
      meta_mupot_seat: inputs.metaSeat !== null,
      openai_session: inputs.openaiSession !== null,
      openai_session_h: await keyedHash(secret, inputs.openaiSession),
      openai_subject: inputs.openaiSubject !== null,
      openai_subject_h: await keyedHash(secret, inputs.openaiSubject),
      codex_thread_id: inputs.codexThreadId !== null,
      codex_thread_id_h: await keyedHash(secret, inputs.codexThreadId),
      client_info_name: inputs.clientInfoName === null ? null : inputs.clientInfoName.replace(/[^A-Za-z0-9 ._/-]/g, '?').slice(0, 40),
      mcp_session_id: inputs.hasMcpSessionId,
      protocol_version: inputs.protocolVersionHeader === null ? null : inputs.protocolVersionHeader.replace(/[^0-9A-Za-z.-]/g, '?').slice(0, 16),
      meta_keys: inputs.metaKeys,
      ...(verbose && inputs.verbose ? { verbose: await buildVerbose(secret, inputs.verbose) } : {}),
    }))
  } catch {
    // Observability must never fail a request.
  }
}
