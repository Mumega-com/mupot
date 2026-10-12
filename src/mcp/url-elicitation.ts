// mupot — MCP URL-mode elicitation for secure-moment links (W3). Contract: docs/architecture/secure-moments.md (W3).
//
// WHAT THIS IS. When a request tool (seed_attach_request, request_elevation) has just filed a request and
// minted a secure-moment link, and the calling client DECLARED url-mode elicitation support, the tool call is
// answered with the protocol-native "open this URL" message instead of (and carrying) the plain link:
//   - 2026-07-28 clients (stateless, per-request `_meta` capabilities): a multi-round-trip result
//     {resultType:'input_required', inputRequests:{...elicitation/create mode:url}, requestState}.
//   - 2025-11-25 clients: JSON-RPC error -32042 (URLElicitationRequiredError) with data.elicitations[].
// The plain link stays the guaranteed path: a client that did not declare url support gets the tool result
// byte-for-byte unchanged, and the -32042 message text itself carries the link.
//
// WHAT THIS IS NOT. It never sends a server-initiated mid-call elicitation/create (the Worker is stateless),
// never uses form mode, and never carries anything but the secure-moment URL. The URL's token is the W1
// one-time link token, which already authorises nothing by itself (the human still proves identity with a
// passkey on the secure host). An elicitation response (accept/decline/cancel) is consent to OPEN the page,
// never a decision: the retry only READS the request's state.
//
// RETRY IS READ-ONLY. A retry (2026-07-28: requestState; 2025-11-25: the same call again) must never file a
// second request and must never rotate the link (createMoment rotates the token of a pending moment, which
// would kill the page the human just opened). So a matching retry short-circuits invokeTool BEFORE the tool
// body runs and reports the request's current state.
import type { AuthContext, Env } from '../types'
import type { ToolOutcome } from './index'
import { issueBoundToken, verifyBoundToken } from '../access/csrf'
import { secureMomentsStatus } from '../secure-moments/config'
import { loadMoment, type MomentKind, type MomentRow } from '../secure-moments/store'
import { reissueMomentLink } from '../secure-moments/issue'
import { reserveRotation } from '../secure-moments/rotate'
import { approveUrl } from '../access/config'
import { loadElevationRequestById, REQUEST_DECISION_WINDOW_MS } from '../auth/elevation'
import { loadSeedRequest } from '../access/seed-request'
import { loadLiveAgentSessionByCredential, resolveAgentSessionContext } from '../auth/agent-sessions'
import { validateSeed } from '../seeds/validate'

/** Per-request client capabilities (2026-07-28, SEP-2575). Also accepted as a per-request fallback on older requests. */
export const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities'

/** The only tools that may be answered with an elicitation, and the moment kind each must have minted. */
export const URL_ELICITATION_TOOLS: ReadonlyMap<string, MomentKind> = new Map<string, MomentKind>([
  ['seed_attach_request', 'seed_attach'],
  ['request_elevation', 'elevation'],
])

const STATE_INFO = 'mupot_mcp_url_elicitation_state_v1'
const SESSION_INFO = 'mupot_mcp_url_elicitation_session_v1'
const STATE_PREFIX = 'mus1.'
const SESSION_PREFIX = 'mce1.'
/** The protocol version URL mode (and -32042) belongs to; a session negotiated below it never gets -32042. */
export const URL_ELICITATION_PROTOCOL_VERSION = '2025-11-25'
/** A declared-capability session id is only a capability hint; it grants nothing. */
export const SESSION_CAPABILITY_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** 2025-11-25 retry window: a request younger than this (or decided this recently) is "the same ask". */
export const RETRY_WINDOW_MS = REQUEST_DECISION_WINDOW_MS
const INPUT_KEY = 'secure_moment'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// ── flag ────────────────────────────────────────────────────────────────────────────────────────────
/**
 * ON only when MCP_URL_ELICITATION is '1'/'true' AND secure moments are fully usable (flag on, host valid) AND
 * the signing key (CONNECTOR_MASTER_KEY, 64 hex) is present. Anything else: nothing here runs.
 */
export function urlElicitationActive(env: Env): boolean {
  const v = env.MCP_URL_ELICITATION?.trim().toLowerCase()
  if (v !== '1' && v !== 'true') return false
  if (secureMomentsStatus(env).state !== 'on') return false
  return /^[0-9a-fA-F]{64}$/.test(env.CONNECTOR_MASTER_KEY ?? '')
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function b64uEncode(s: string): string {
  let bin = ''
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64uDecode(s: string): string | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)))
  } catch {
    return null
  }
}

function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (isPlainObject(v)) {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * The calling principal as the state binds it: member + bound agent, and for an ELEVATION also the exact agent
 * session (request_elevation / elevation_status scope a request to the session that filed it, so a sibling session
 * of the same agent is a different principal here too). All server-derived.
 */
export function principalKey(auth: Pick<AuthContext, 'memberId' | 'boundAgentId'>, agentSessionId?: string): string {
  return `${auth.memberId ?? ''}|${auth.boundAgentId ?? ''}${agentSessionId !== undefined ? `|${agentSessionId}` : ''}`
}

/** The principal for one moment kind, or null when it cannot be derived (no live agent session for an elevation). */
export async function elicitationPrincipal(env: Env, auth: AuthContext, kind: MomentKind): Promise<{ key: string; sessionId: string | null } | null> {
  if (kind === 'seed_attach') return { key: principalKey(auth), sessionId: null }
  const sc = resolveAgentSessionContext(auth)
  if (!sc.ok) return null
  const live = await loadLiveAgentSessionByCredential(env, env.TENANT_SLUG, sc.context.authKind, sc.context.credentialId)
  return live ? { key: principalKey(auth, live.id), sessionId: live.id } : null
}

export function argsDigest(args: unknown): Promise<string> {
  return sha256Hex(canonicalJson(args ?? {}))
}

function declaresUrl(caps: unknown): boolean {
  return isPlainObject(caps) && isPlainObject(caps.elicitation) && isPlainObject(caps.elicitation.url)
}

// ── capability carriers ─────────────────────────────────────────────────────────────────────────────
export type ElicitMode = 'mrtr' | 'error32042'

function metaCapabilities(params: unknown): unknown {
  if (!isPlainObject(params) || !isPlainObject(params._meta)) return undefined
  return params._meta[CLIENT_CAPABILITIES_META_KEY]
}

/**
 * Which elicitation shape this client gets, or null (plain result).
 *  - modern (2026-07-28) request: only a per-request `_meta` capability with elicitation.url => MRTR. A modern
 *    client never gets -32042 (removed in that version) and never gets MRTR without declaring url.
 *  - a request carrying `MCP-Protocol-Version: 2025-11-25`: the per-request `_meta` capability (fallback) or the
 *    signed capability session id the initialize response issued (see sessionIdForInitialize) => -32042.
 *  - anything else (older negotiated version, no header): null.
 */
export async function detectUrlElicitation(
  env: Env,
  input: { modern: boolean; params: unknown; sessionId: string | null | undefined; protocolVersionHeader?: string | null },
  nowMs: number = Date.now(),
): Promise<ElicitMode | null> {
  const metaUrl = declaresUrl(metaCapabilities(input.params))
  if (input.modern) return metaUrl ? 'mrtr' : null
  // -32042 exists from 2025-11-25 on: a request that does not carry that negotiated version never gets it.
  if (input.protocolVersionHeader !== URL_ELICITATION_PROTOCOL_VERSION) return null
  if (metaUrl) return 'error32042'
  if (input.sessionId && (await verifySessionId(env, input.sessionId, nowMs))) return 'error32042'
  return null
}

/**
 * 2025-11-25 has a handshake, mupot has no session store. The initialize response therefore hands a client that
 * declared elicitation.url a SELF-CONTAINED signed `Mcp-Session-Id` carrying only that fact + an issue time. The
 * spec obliges the client to echo it, so later tools/call requests prove the declaration without server state.
 * It identifies nobody and authorises nothing; forging it only opts the forger into a link they could read anyway.
 */
export async function sessionIdForInitialize(env: Env, initializeParams: unknown, nowMs: number = Date.now()): Promise<string | null> {
  if (!urlElicitationActive(env)) return null
  if (!isPlainObject(initializeParams) || !declaresUrl(initializeParams.capabilities)) return null
  // Only a client that asks for the version URL mode belongs to is moved to it (and handed a session id).
  if (initializeParams.protocolVersion !== URL_ELICITATION_PROTOCOL_VERSION) return null
  const payload = b64uEncode(JSON.stringify({ c: 'url', iat: nowMs, n: crypto.randomUUID() }))
  const mac = await issueBoundToken(env, SESSION_INFO, `${SESSION_PREFIX}${payload}`)
  return mac ? `${SESSION_PREFIX}${payload}.${mac}` : null
}

async function verifySessionId(env: Env, id: string, nowMs: number): Promise<boolean> {
  if (!id.startsWith(SESSION_PREFIX)) return false
  const [payload, mac, extra] = id.slice(SESSION_PREFIX.length).split('.')
  if (!payload || !mac || extra !== undefined) return false
  if ((await verifyBoundToken(env, SESSION_INFO, `${SESSION_PREFIX}${payload}`, mac)) !== 'ok') return false
  const decoded = b64uDecode(payload)
  if (decoded === null) return false
  let parsed: unknown
  try { parsed = JSON.parse(decoded) } catch { return false }
  if (!isPlainObject(parsed) || parsed.c !== 'url' || typeof parsed.iat !== 'number' || typeof parsed.n !== 'string') return false
  return parsed.iat <= nowMs + 60_000 && nowMs - parsed.iat < SESSION_CAPABILITY_TTL_MS
}

// ── requestState (2026-07-28) ───────────────────────────────────────────────────────────────────────
interface StatePayload {
  v: 1
  /** principalKey of the caller it was issued to */
  p: string
  /** tool name */
  t: string
  /** sha256 of the canonical tool arguments */
  a: string
  /** moment id */
  m: string
  /** moment kind */
  k: MomentKind
  /** subject (request) id */
  s: string
  /** expiry, epoch ms */
  e: number
}

export async function sealState(env: Env, payload: StatePayload): Promise<string | null> {
  const body = b64uEncode(JSON.stringify(payload))
  const mac = await issueBoundToken(env, STATE_INFO, `${STATE_PREFIX}${body}`)
  return mac ? `${STATE_PREFIX}${body}.${mac}` : null
}

export type StateCheck = { ok: true; payload: StatePayload } | { ok: false; reason: string }

/** Verify integrity, then every binding. The state is attacker-controlled; nothing in it is believed before the MAC. */
export async function openState(
  env: Env,
  raw: unknown,
  expect: { principal: string; tool: string; argsSha256: string },
  nowMs: number = Date.now(),
): Promise<StateCheck> {
  if (typeof raw !== 'string' || raw.length > 4096 || !raw.startsWith(STATE_PREFIX)) return { ok: false, reason: 'malformed' }
  const [body, mac, extra] = raw.slice(STATE_PREFIX.length).split('.')
  if (!body || !mac || extra !== undefined) return { ok: false, reason: 'malformed' }
  if ((await verifyBoundToken(env, STATE_INFO, `${STATE_PREFIX}${body}`, mac)) !== 'ok') return { ok: false, reason: 'integrity' }
  const decoded = b64uDecode(body)
  let p: unknown
  try { p = decoded === null ? null : JSON.parse(decoded) } catch { return { ok: false, reason: 'malformed' } }
  if (!isPlainObject(p) || p.v !== 1 || typeof p.p !== 'string' || typeof p.t !== 'string' || typeof p.a !== 'string'
    || typeof p.m !== 'string' || typeof p.k !== 'string' || typeof p.s !== 'string' || typeof p.e !== 'number') {
    return { ok: false, reason: 'malformed' }
  }
  const kind = URL_ELICITATION_TOOLS.get(p.t)
  if (!kind || kind !== p.k) return { ok: false, reason: 'tool' }
  if (p.e <= nowMs) return { ok: false, reason: 'expired' }
  if (p.p !== expect.principal) return { ok: false, reason: 'principal' }
  if (p.t !== expect.tool) return { ok: false, reason: 'tool' }
  if (p.a !== expect.argsSha256) return { ok: false, reason: 'args' }
  // as: every field was type-checked on the lines above and the kind was matched against the registry.
  return { ok: true, payload: p as unknown as StatePayload }
}

// ── the link a result carries ───────────────────────────────────────────────────────────────────────
/** Parse a tool result's `approve_url`. Only the exact secure-moment shape on the dedicated secure host qualifies. */
export function parseMomentLink(env: Env, url: unknown): { momentId: string; url: string } | null {
  if (typeof url !== 'string') return null
  const status = secureMomentsStatus(env)
  if (status.state !== 'on') return null
  let u: URL
  try { u = new URL(url) } catch { return null }
  if (u.protocol !== 'https:' || u.host !== status.host || u.username || u.password || u.search || u.hash) return null
  const m = /^\/m\/([0-9a-f-]{36})\/([A-Za-z0-9_-]{16,128})$/.exec(u.pathname)
  if (!m || !UUID_RE.test(m[1])) return null
  return { momentId: m[1], url: u.toString() }
}

const ELICIT_MESSAGE = 'A human must approve this request on the secure page. Open the link, review it, and decide with your passkey.'

/** The decided/pending state a retry reports. Read-only; null when the subject is not this principal's (own session for an elevation). */
export async function readOutcome(
  env: Env, auth: AuthContext, kind: MomentKind, subjectId: string, agentSessionId: string | null, nowMs: number,
): Promise<Record<string, unknown> | null> {
  if (kind === 'seed_attach') {
    const row = await loadSeedRequest(env, subjectId)
    if (!row || !auth.memberId || row.requester_member_id !== auth.memberId) return null
    if (row.requester_agent_id !== (auth.boundAgentId ?? null)) return null
    const status = row.status === 'pending' && Date.parse(row.expires_at) <= nowMs ? 'expired' : row.status
    return { kind, request_id: row.id, status, expires_at: row.expires_at, decided_at: row.decided_at }
  }
  const row = await loadElevationRequestById(env, env.TENANT_SLUG, subjectId)
  if (!row || !auth.boundAgentId || row.agent_id !== auth.boundAgentId) return null
  if (agentSessionId === null || row.agent_session_id !== agentSessionId) return null
  const status = row.status === 'pending' && Date.parse(row.decision_expires_at) <= nowMs ? 'expired' : row.status
  return { kind, request_id: row.id, status, decision_expires_at: row.decision_expires_at, decided_at: row.decided_at }
}

function retryNote(status: unknown): string {
  if (status === 'pending') return 'Still awaiting the human decision at the link already presented. This retry created nothing and changed nothing.'
  return 'This is the current state of the request you filed earlier. This retry created nothing and changed nothing.'
}

function outcomeResult(outcome: Record<string, unknown>, extra: Record<string, unknown> = {}, note?: string): ToolOutcome {
  return { ok: true, result: { ok: true, ...outcome, ...extra, retry: true, note: note ?? retryNote(outcome.status) } }
}

/**
 * The plain-link fallback (W3.1). A client that DECLINED or CANCELLED the elicitation (a headless client cancels
 * on its own) discarded the link, and the link is stored only as a hash, so the only way to give the agent
 * something to relay is to rotate the pending moment's token and return the new link in the tool result. Bounded
 * by reserveRotation. Only called for a still-pending request whose moment is still pending and live; the old
 * link dies, which is intended (the client that held it dropped it). An ACCEPT never reaches here: the human has
 * the link open and rotating would break the page.
 */
async function plainLinkFallback(
  env: Env, auth: AuthContext, kind: MomentKind, moment: MomentRow, outcome: Record<string, unknown>, action: string | null, nowMs: number,
): Promise<ToolOutcome> {
  const actionNote = action ? { elicitation_action: action } : {}
  if (!auth.memberId) return outcomeResult(outcome, actionNote)
  const reserved = await reserveRotation(env, { momentId: moment.id, memberId: auth.memberId, agentId: auth.boundAgentId ?? null, reason: `elicitation_${action ?? 'not_accepted'}` }, nowMs)
  if (reserved !== 'ok') {
    const why = reserved === 'throttled'
      ? 'A fresh link was issued for this request a moment ago; wait about a minute before asking again.'
      : reserved === 'human_active'
        ? 'The human already opened a fresh link for this request from Telegram and may be mid-passkey, so no new link was issued (it would break theirs). Do not retry for about ten minutes; nothing is decided until they confirm.'
      : reserved === 'capped'
        ? 'This request has used all its link re-issues; file the request again to get a new one.'
        : 'A fresh link could not be issued right now.'
    return outcomeResult(outcome, { ...actionNote, link_reissue: reserved }, `${retryNote('pending')} ${why}`)
  }
  const link = await reissueMomentLink(env, moment.id)
  if (!link || link.momentId !== moment.id) {
    return outcomeResult(outcome, { ...actionNote, link_reissue: 'error' }, `${retryNote('pending')} A fresh link could not be issued right now.`)
  }
  const access = approveUrl(env, kind === 'seed_attach' ? 'seed' : 'elevation', moment.subject_id)
  return outcomeResult(
    outcome,
    { ...actionNote, approve_url: link.url, ...(access ? { access_approve_url: access } : {}), link_reissue: 'ok' },
    'Your client did not take up the in-protocol prompt, so here is the link again: give approve_url to the human to open (a one-time link; they decide with their passkey). The previous link no longer works. Nothing is decided until they do.',
  )
}

/** A moment row is only ever offered to the principal that filed it, on the kind this tool mints. */
function momentBelongsTo(row: MomentRow, auth: AuthContext, kind: MomentKind, nowMs: number): boolean {
  return row.kind === kind
    && row.status === 'pending'
    && Date.parse(row.expires_at) > nowMs
    && row.requester_agent_id === (auth.boundAgentId ?? null)
}

// ── per-call preparation ────────────────────────────────────────────────────────────────────────────
export interface ElicitationPrep {
  /** Passed to invokeTool as ToolCtx.shortCircuit; runs after every authz/schema gate, instead of the tool body. */
  shortCircuit: (args: Record<string, unknown>) => Promise<ToolOutcome | null>
  mode: ElicitMode | null
  /** True once shortCircuit actually answered with a retry outcome (the tool body did not run). */
  answeredByRetry: () => boolean
}

const refuseState = (reason: string): ToolOutcome => ({ ok: false, status: 400, error: 'invalid_request_state', detail: reason })

/**
 * Called for a tools/call of a URL_ELICITATION_TOOLS tool with the feature active. Nothing is refused here: a bad
 * requestState is refused INSIDE shortCircuit, i.e. after invokeTool's harness chokepoint, capability floor and
 * schema validation, so an unauthorised caller gets its normal refusal. A requestState that is present NEVER falls
 * through to the tool body: it either verifies and is answered read-only, or is refused.
 */
export async function prepareUrlElicitation(
  env: Env,
  auth: AuthContext,
  input: { toolName: string; params: Record<string, unknown>; modern: boolean; sessionId: string | null | undefined; protocolVersionHeader?: string | null },
  nowMs: number = Date.now(),
): Promise<ElicitationPrep | null> {
  const kind = URL_ELICITATION_TOOLS.get(input.toolName)
  if (!kind) return null
  let answered = false
  const hasState = input.params.requestState !== undefined
  const mode = await detectUrlElicitation(env, input, nowMs)
  if (!hasState && !mode) return null

  return {
    mode,
    answeredByRetry: () => answered,
    shortCircuit: async (args) => {
      const principal = await elicitationPrincipal(env, auth, kind)
      // 2026-07-28 retry: requestState present => verify everything, then report state read-only.
      if (hasState) {
        if (!principal) return refuseState('principal')
        const checked = await openState(env, input.params.requestState, { principal: principal.key, tool: input.toolName, argsSha256: await argsDigest(args) }, nowMs)
        if (!checked.ok) return refuseState(checked.reason)
        const st = checked.payload
        const moment = await loadMoment(env, st.m)
        // The moment must still be this principal's own row for this subject (it may have been decided or expired since).
        if (!moment || moment.kind !== st.k || moment.subject_id !== st.s || moment.requester_agent_id !== (auth.boundAgentId ?? null)) return refuseState('not_found')
        const outcome = await readOutcome(env, auth, st.k, st.s, principal.sessionId, nowMs)
        if (!outcome) return refuseState('not_found')
        answered = true
        const action = readAction(input.params.inputResponses)
        // Anything but an explicit accept (decline, cancel, a missing or unrecognised answer) while the request AND
        // its moment are still open: the client did not show the human the link, so hand the agent a fresh one.
        if (action !== 'accept' && outcome.status === 'pending' && moment.status === 'pending' && Date.parse(moment.expires_at) > nowMs) {
          return plainLinkFallback(env, auth, st.k, moment, outcome, action, nowMs)
        }
        return outcomeResult(outcome, action ? { elicitation_action: action } : {})
      }
      // 2025-11-25 retry: no state travels, so find "the same ask" by its natural key, but only among this
      // principal's own requests that were issued through a secure moment and are recent.
      if (mode !== 'error32042' || !principal) return null
      const existing = await findSameAsk(env, auth, kind, args, principal.sessionId, nowMs)
      if (!existing) return null
      const outcome = await readOutcome(env, auth, kind, existing, principal.sessionId, nowMs)
      if (!outcome) return null
      answered = true
      return outcomeResult(outcome)
    },
  }
}

function readAction(inputResponses: unknown): 'accept' | 'decline' | 'cancel' | null {
  if (!isPlainObject(inputResponses)) return null
  const r = inputResponses[INPUT_KEY]
  const a = isPlainObject(r) ? r.action : undefined
  return a === 'accept' || a === 'decline' || a === 'cancel' ? a : null
}

/** Newest recent request of this principal with the same natural key that has a secure moment; its id, else null. */
export async function findSameAsk(env: Env, auth: AuthContext, kind: MomentKind, args: Record<string, unknown>, agentSessionId: string | null, nowMs: number): Promise<string | null> {
  const recent = (iso: string | null): boolean => iso !== null && nowMs - Date.parse(iso) <= RETRY_WINDOW_MS
  if (kind === 'elevation') {
    if (!auth.boundAgentId || agentSessionId === null) return null
    const since = new Date(nowMs - 2 * RETRY_WINDOW_MS).toISOString()
    const rows = await env.DB.prepare(
      `SELECT id, requested_actions_json, requested_scope_type, requested_scope_id, requested_duration_minutes, reason,
              status, created_at, decided_at, decision_expires_at
         FROM elevation_requests
        WHERE tenant = ?1 AND agent_id = ?2 AND agent_session_id = ?4 AND created_at > ?3
          AND EXISTS (SELECT 1 FROM secure_moments m WHERE m.tenant = ?1 AND m.kind = 'elevation' AND m.subject_id = elevation_requests.id
                        AND m.requester_agent_id = ?2)
        ORDER BY created_at DESC LIMIT 10`,
    ).bind(env.TENANT_SLUG, auth.boundAgentId, since, agentSessionId).all<{
      id: string; requested_actions_json: string; requested_scope_type: string; requested_scope_id: string
      requested_duration_minutes: number; reason: string; status: string; created_at: string; decided_at: string | null; decision_expires_at: string
    }>()
    const wantActions = Array.isArray(args.actions) ? [...new Set(args.actions.filter((a): a is string => typeof a === 'string'))].sort() : null
    const wantReason = typeof args.reason === 'string' ? args.reason.trim() : null
    // as request_elevation stores it: str(scope_id) ?? '' (blank counts as absent, a non-blank value is kept untrimmed)
    const wantScopeId = typeof args.scope_id === 'string' && args.scope_id.trim().length > 0 ? args.scope_id : ''
    for (const r of rows.results ?? []) {
      let have: unknown
      try { have = JSON.parse(r.requested_actions_json) } catch { continue }
      if (!Array.isArray(have) || wantActions === null) continue
      const same = JSON.stringify([...have].sort()) === JSON.stringify(wantActions)
        && r.requested_scope_type === args.scope_type && r.requested_scope_id === wantScopeId
        && r.requested_duration_minutes === args.duration_minutes && r.reason === wantReason
      if (!same) continue
      const live = r.status === 'pending' && Date.parse(r.decision_expires_at) > nowMs
      if (live || recent(r.decided_at)) return r.id
      return null // the newest matching ask is old and closed: a fresh ask, not a retry
    }
    return null
  }
  if (!auth.memberId) return null
  const v = await validateSeed(args.seed)
  if (!v.ok) return null
  const rows = await env.DB.prepare(
    `SELECT id, status, created_at, expires_at, decided_at
       FROM seed_attach_requests
      WHERE tenant = ?1 AND requester_member_id = ?2 AND seed_sha256 = ?3 AND requester_agent_id IS ?4
        AND EXISTS (SELECT 1 FROM secure_moments m WHERE m.tenant = ?1 AND m.kind = 'seed_attach' AND m.subject_id = seed_attach_requests.id)
      ORDER BY created_at DESC LIMIT 1`,
  ).bind(env.TENANT_SLUG, auth.memberId, v.seedSha256, auth.boundAgentId ?? null).all<{ id: string; status: string; created_at: string; expires_at: string; decided_at: string | null }>()
  const r = rows.results?.[0]
  if (!r) return null
  // pending: the same ask only while young (an older pending request is re-asked through the tool, which reuses
  // it and rotates the link, exactly as without elicitation). decided: the same ask for a short while.
  if (r.status === 'pending') return recent(r.created_at) && Date.parse(r.expires_at) > nowMs ? r.id : null
  return recent(r.decided_at) ? r.id : null
}

// ── the elicitation response ────────────────────────────────────────────────────────────────────────
export type ElicitationResponse =
  | { kind: 'error'; code: number; message: string; data: unknown }
  | { kind: 'result'; result: Record<string, unknown> }

/**
 * Turn a SUCCESSFUL request-tool outcome into the elicitation, or null (return the plain result unchanged).
 * Fails soft on every doubt: a missing/foreign/malformed link, a moment that is not this principal's, or a
 * signing failure all leave the plain result — the guaranteed path — untouched.
 */
export async function buildElicitation(
  env: Env,
  auth: AuthContext,
  input: { toolName: string; args: unknown; mode: ElicitMode; result: unknown },
  nowMs: number = Date.now(),
): Promise<ElicitationResponse | null> {
  const kind = URL_ELICITATION_TOOLS.get(input.toolName)
  if (!kind || !isPlainObject(input.result)) return null
  const link = parseMomentLink(env, input.result.approve_url)
  if (!link) return null
  const moment = await loadMoment(env, link.momentId)
  if (!moment || !momentBelongsTo(moment, auth, kind, nowMs)) return null
  const principal = await elicitationPrincipal(env, auth, kind)
  if (!principal) return null

  if (input.mode === 'error32042') {
    return {
      kind: 'error',
      code: -32042,
      // The plain link rides in the message too: a client that does not act on -32042 still shows it.
      message: `URL elicitation required. ${ELICIT_MESSAGE} Link: ${link.url}`,
      data: { elicitations: [{ mode: 'url', elicitationId: moment.id, url: link.url, message: ELICIT_MESSAGE }] },
    }
  }
  const expMs = Math.min(Date.parse(moment.expires_at), nowMs + 24 * 60 * 60 * 1000)
  const state = await sealState(env, {
    v: 1, p: principal.key, t: input.toolName, a: await argsDigest(input.args), m: moment.id, k: kind, s: moment.subject_id, e: expMs,
  })
  if (!state) return null
  return {
    kind: 'result',
    result: {
      resultType: 'input_required',
      inputRequests: { [INPUT_KEY]: { method: 'elicitation/create', params: { mode: 'url', url: link.url, message: ELICIT_MESSAGE } } },
      requestState: state,
    },
  }
}
