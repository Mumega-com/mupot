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
}

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
async function keyedHash(secret: string | undefined, v: string | null): Promise<string | null> {
  if (v === null || !secret) return null
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`mupot:harness-probe:v1:${v}`))
  return Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12)
}

/** Test seam: forget the sampling state. */
export function resetHarnessProbeSampling(): void {
  lastLogged.clear()
}

export async function maybeEmitHarnessIdentityProbe(
  env: Pick<Env, 'SEAT_AUTO_ENROLL' | 'CONNECTOR_MASTER_KEY'>,
  grantKey: string,
  inputs: ProbeInputs,
  nowMs: number = Date.now(),
): Promise<void> {
  if (!seatAutoEnrollEnabled(env)) return
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
    }))
  } catch {
    // Observability must never fail a request.
  }
}
