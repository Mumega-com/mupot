// mupot — seat events: one multiplexed, body-free notification channel per fleet host.
//
// WHY. /api/inbox/stream is one server-side D1 poll per open stream (1s cadence, plus a bearer
// revalidation per tick). A host serving N seats across projects holds N of them open forever.
// This channel replaces that for hosts that opt in: the host keeps ONE WebSocket, and Mupot
// pushes a hint only when a row actually lands.
//
// FLOW.
//   send / task_dispatch  → agent_messages INSERT → BUS.emit('message.created')   (existing seam,
//                           src/agents/messages.ts; emitted only on a real insert, never a body)
//   Queue consumer        → publishSeatHint() → SeatEventsDO /hint               (src/bus/consumer.ts)
//   SeatEventsDO          → re-authorizes the grant → sends {type:'hint'} to the one socket
//                           holding that agent                                   (./seat-events-do.ts)
//   host (Orca plugin)    → waits for the seat's turn to end → types one notice; the seat reads
//                           and inbox_acks its OWN inbox with its OWN credential.
//
// AUTHORIZATION — three independent facts, all required, all re-checked on every hint:
//   1. the host proves possession of its registered Ed25519 key (agent_keys; the same signed
//      fleet identity as signed attach/inbox) over a domain-separated, single-use message;
//   2. an explicit seat_event_grants row authorizes THAT host for THAT agent (one live grant
//      per agent — the durable one-consumer-per-UUID fence);
//   3. the agent is active (and, for a project-scoped grant, still has the project).
// The ticket that comes out is short-lived (TICKET_TTL_SEC), single-use, stored only as a hash,
// and scoped to the exact agent list that passed 1–3.
//
// WHAT IS NEVER HERE. Message bodies: every frame is built from HINT_FIELDS, and the catch-up
// query selects those columns by name. Inbox consumption: hints never mark anything read;
// inbox_ack stays the seat's call. Task settlement: task receipts/verdicts are untouched.
//
// NO POLLING. Nothing here runs on a timer. The DO has no alarm; catch-up is one bounded query
// per (connect, agent). The host's keepalive ping is answered by the DO's WebSocket
// auto-response without waking it.

import type { Env, MessageCreatedPayload } from '../types'
import { loadActiveAgentKey } from '../fleet/agent-keys'
import { burnSharedAgentNonce, sharedNonceWindowSec } from '../fleet/shared-nonce-ledger'

export const SEAT_EVENTS_FLAG = '1'
export const SEAT_EVENTS_PROTOCOL = 1
export const TICKET_SIG_DOMAIN = 'seat-events-ticket:v1'
export const TICKET_WINDOW_SEC = sharedNonceWindowSec(TICKET_SIG_DOMAIN)
export const TICKET_TTL_SEC = 60
export const MAX_AGENTS_PER_TICKET = 64
export const BACKLOG_HINT_LIMIT = 50
export const RECENT_HINT_IDS = 1024
export const CLOSE_TICKET_INVALID = 4401
export const CLOSE_NO_SUBSCRIPTIONS = 4409

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/
const SIG_B64URL_RE = /^[A-Za-z0-9_-]{80,120}$/
const TICKET_RE = /^[A-Za-z0-9_-]{43}$/

export function isSeatEventsEnabled(env: Env): boolean {
  return env.REALTIME_SEAT_EVENTS === SEAT_EVENTS_FLAG && env.SEAT_EVENTS !== undefined
}

/** One DO per pot. The commit seam knows the recipient agent, not a fleet, so routing inside the
 *  pot's single channel is an attachment lookup rather than an agent→fleet query per event. */
export function seatEventsChannelName(tenant: string): string {
  const t = tenant.trim()
  if (!t) throw new Error('seat_events_tenant_required')
  return `${t}:seat-events`
}

// ── hints ─────────────────────────────────────────────────────────────────────────────────

/** The complete set of fields a hint may carry. There is no body field and no way to add one
 *  without editing this list — hintFromPayload and the backlog SELECT both derive from it. */
export const HINT_FIELDS = [
  'id', 'seq', 'to_agent', 'from_agent', 'kind', 'request_id', 'in_reply_to', 'target_seat', 'project_id', 'created_at',
] as const

export type SeatHint = {
  id: string
  seq: number
  to_agent: string
  from_agent: string
  kind: string
  request_id: string | null
  in_reply_to: string | null
  target_seat: string | null
  project_id: string | null
  created_at: string
}

const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

/** Build a hint from the committed-message event. Allowlist, never spread: whatever else the
 *  payload grows later cannot reach a socket. Returns null for a malformed payload. */
export function hintFromPayload(p: Partial<MessageCreatedPayload> | null | undefined): SeatHint | null {
  if (!p || typeof p !== 'object') return null
  const seq = Number(p.seq)
  if (typeof p.message_id !== 'string' || !p.message_id) return null
  if (!Number.isSafeInteger(seq) || seq <= 0) return null
  if (typeof p.to_agent !== 'string' || !p.to_agent) return null
  return {
    id: p.message_id,
    seq,
    to_agent: p.to_agent,
    from_agent: typeof p.from_agent === 'string' ? p.from_agent : '',
    kind: typeof p.kind === 'string' ? p.kind : 'message',
    request_id: strOrNull(p.request_id),
    in_reply_to: strOrNull(p.in_reply_to),
    target_seat: strOrNull(p.target_seat),
    project_id: strOrNull(p.project_id),
    created_at: typeof p.created_at === 'string' ? p.created_at : '',
  }
}

/** Re-normalize a hint that crossed a process boundary (Worker → DO). Same allowlist. */
export function normalizeHint(obj: unknown): SeatHint | null {
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  return hintFromRow(o, o.to_agent as string)
}

function hintFromRow(row: Record<string, unknown>, agent: string): SeatHint | null {
  return hintFromPayload({
    message_id: row.id as string,
    seq: Number(row.seq),
    to_agent: agent,
    from_agent: row.from_agent as string,
    kind: row.kind as string,
    request_id: row.request_id as string | null,
    in_reply_to: row.in_reply_to as string | null,
    target_seat: row.target_seat as string | null,
    project_id: row.project_id as string | null,
    created_at: row.created_at as string,
  })
}

// ── frames ────────────────────────────────────────────────────────────────────────────────

export type ServerFrame =
  | { type: 'ready'; protocol: number; host: string; subscriptions: { agent: string; ok: boolean; reason?: string }[] }
  | { type: 'backlog'; agent: string; unread: number; complete: boolean; hints: SeatHint[] }
  | { type: 'hint'; agent: string; hint: SeatHint }
  | { type: 'revoked'; agent: string; reason: string }
  | { type: 'superseded'; agent: string; reason: string }
  | { type: 'error'; reason: string }

export const encodeFrame = (f: ServerFrame): string => JSON.stringify(f)

// ── grants ────────────────────────────────────────────────────────────────────────────────

export type GrantResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'invalid_args' | 'agent_not_found' | 'host_key_missing' | 'project_access_denied' | 'agent_already_granted' | 'db_error' }

/** Authorize host → agent. Refuses while another live grant holds the agent: moving an agent
 *  is revoke-then-grant, never an implicit takeover. */
export async function createSeatEventGrant(
  env: Env,
  input: { hostAgentId: string; agentId: string; projectId?: string | null; memberId: string; reason: string },
  now: () => string = () => new Date().toISOString(),
): Promise<GrantResult> {
  const tenant = env.TENANT_SLUG
  if (!ID_RE.test(input.hostAgentId) || !ID_RE.test(input.agentId)) return { ok: false, reason: 'invalid_args' }
  if (!input.reason?.trim() || input.reason.length > 500) return { ok: false, reason: 'invalid_args' }
  const agent = await env.DB.prepare(`SELECT 1 AS x FROM agents WHERE id = ?1 AND status = 'active'`)
    .bind(input.agentId).first()
  if (!agent) return { ok: false, reason: 'agent_not_found' }
  if (!(await loadActiveAgentKey(env, input.hostAgentId))) return { ok: false, reason: 'host_key_missing' }
  const projectId = input.projectId ?? null
  if (projectId !== null && !(await agentHasProject(env, input.agentId, projectId))) {
    return { ok: false, reason: 'project_access_denied' }
  }
  const id = crypto.randomUUID()
  try {
    await env.DB.prepare(
      `INSERT INTO seat_event_grants (id, tenant, host_agent_id, agent_id, project_id, granted_by_member_id, reason, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    ).bind(id, tenant, input.hostAgentId, input.agentId, projectId, input.memberId, input.reason.trim(), now()).run()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/UNIQUE/i.test(msg)) return { ok: false, reason: 'agent_already_granted' }
    return { ok: false, reason: 'db_error' }
  }
  return { ok: true, id }
}

export async function revokeSeatEventGrant(
  env: Env,
  input: { agentId: string; memberId: string },
  now: () => string = () => new Date().toISOString(),
): Promise<{ ok: boolean; revoked: number }> {
  const res = await env.DB.prepare(
    `UPDATE seat_event_grants SET revoked_at = ?1, revoked_by_member_id = ?2
      WHERE tenant = ?3 AND agent_id = ?4 AND revoked_at IS NULL`,
  ).bind(now(), input.memberId, env.TENANT_SLUG, input.agentId).run()
  return { ok: true, revoked: Number(res.meta?.changes ?? 0) }
}

export async function activeSeatEventGrant(
  env: Env,
  agentId: string,
): Promise<{ host_agent_id: string; project_id: string | null } | null> {
  return env.DB.prepare(
    `SELECT host_agent_id, project_id FROM seat_event_grants
      WHERE tenant = ?1 AND agent_id = ?2 AND revoked_at IS NULL LIMIT 1`,
  ).bind(env.TENANT_SLUG, agentId).first<{ host_agent_id: string; project_id: string | null }>()
}

async function agentHasProject(env: Env, agentId: string, projectId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS x FROM memberships ms
       JOIN project_squad_access psa ON psa.squad_id = ms.squad_id
       JOIN projects p ON p.id = psa.project_id
      WHERE ms.agent_id = ?1 AND p.id = ?2 AND p.status = 'active' LIMIT 1`,
  ).bind(agentId, projectId).first()
  return row !== null
}

/** The per-disclosure check. One indexed query: live grant for (host, agent), agent active,
 *  host key still bound to an active member, project (if scoped) still reachable. */
export async function hostMayReceive(env: Env, hostAgentId: string, agentId: string): Promise<boolean> {
  try {
    const row = await env.DB.prepare(
      `SELECT 1 AS x
         FROM seat_event_grants g
         JOIN agents a ON a.id = g.agent_id AND a.status = 'active'
         JOIN agent_keys k ON k.tenant = g.tenant AND k.agent_id = g.host_agent_id AND k.member_id IS NOT NULL
         JOIN members m ON m.id = k.member_id AND m.tenant = k.tenant AND m.status = 'active'
        WHERE g.tenant = ?1 AND g.host_agent_id = ?2 AND g.agent_id = ?3 AND g.revoked_at IS NULL
          AND (g.project_id IS NULL OR EXISTS (
                SELECT 1 FROM memberships ms
                  JOIN project_squad_access psa ON psa.squad_id = ms.squad_id
                  JOIN projects p ON p.id = psa.project_id
                 WHERE ms.agent_id = g.agent_id AND p.id = g.project_id AND p.status = 'active'))
        LIMIT 1`,
    ).bind(env.TENANT_SLUG, hostAgentId, agentId).first()
    return row !== null
  } catch {
    return false // fail closed: a DB error discloses nothing
  }
}

// ── signed ticket request ─────────────────────────────────────────────────────────────────

/** The exact bytes the host signs. Agents are de-duplicated and sorted so the signature binds the
 *  set, not the order. Domain tag first, tenant bound in (no cross-pot replay). */
export function canonicalTicketMessage(p: { tenant: string; host_agent_id: string; agents: readonly string[]; ts: number; nonce: string }): Uint8Array {
  const agents = [...new Set(p.agents)].sort().join(',')
  return new TextEncoder().encode([TICKET_SIG_DOMAIN, p.tenant, p.host_agent_id, agents, String(p.ts), p.nonce].join('\n'))
}

function b64urlToBytes(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

export type TicketRequestResult =
  | { ok: true; host: string; granted: string[]; refused: { agent: string; reason: string }[] }
  | { ok: false; status: 400 | 401 | 403 | 409; error: string; detail?: string }

export async function verifyTicketRequest(
  env: Env,
  body: Record<string, unknown>,
  nowSec: () => number = () => Math.floor(Date.now() / 1000),
): Promise<TicketRequestResult> {
  const host = body.host_agent_id
  if (typeof host !== 'string' || !ID_RE.test(host)) return { ok: false, status: 400, error: 'bad_request', detail: 'host_agent_id' }
  const agentsRaw = body.agents
  if (!Array.isArray(agentsRaw) || agentsRaw.length === 0 || agentsRaw.length > MAX_AGENTS_PER_TICKET) {
    return { ok: false, status: 400, error: 'bad_request', detail: `agents: 1..${MAX_AGENTS_PER_TICKET}` }
  }
  if (!agentsRaw.every((a) => typeof a === 'string' && ID_RE.test(a))) return { ok: false, status: 400, error: 'bad_request', detail: 'agents' }
  const agents = [...new Set(agentsRaw as string[])].sort()
  const ts = body.ts
  if (typeof ts !== 'number' || !Number.isSafeInteger(ts)) return { ok: false, status: 400, error: 'bad_request', detail: 'ts' }
  if (typeof body.nonce !== 'string' || !NONCE_RE.test(body.nonce)) return { ok: false, status: 400, error: 'bad_request', detail: 'nonce' }
  if (typeof body.sig !== 'string' || !SIG_B64URL_RE.test(body.sig)) return { ok: false, status: 400, error: 'bad_request', detail: 'sig' }
  const nonce = body.nonce
  const now = nowSec()
  if (Math.abs(now - ts) > TICKET_WINDOW_SEC) return { ok: false, status: 401, error: 'stale_signature' }

  const key = await loadActiveAgentKey(env, host)
  if (!key || key.algo !== 'Ed25519') return { ok: false, status: 401, error: 'unauthorized' }
  let pub: CryptoKey
  try {
    pub = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: key.pubkey, ext: true }, { name: 'Ed25519' }, false, ['verify'])
  } catch {
    return { ok: false, status: 401, error: 'unauthorized' }
  }
  const sig = b64urlToBytes(body.sig)
  if (!sig) return { ok: false, status: 401, error: 'unauthorized' }
  const valid = await crypto.subtle.verify(
    { name: 'Ed25519' }, pub, sig, canonicalTicketMessage({ tenant: env.TENANT_SLUG, host_agent_id: host, agents, ts, nonce }),
  )
  if (!valid) return { ok: false, status: 401, error: 'unauthorized' }
  // Burn only after the signature verifies, so unsigned junk cannot fill the ledger.
  const fresh = await burnSharedAgentNonce(env, { domain: TICKET_SIG_DOMAIN, windowSec: TICKET_WINDOW_SEC, agentId: host, nonce, now })
  if (!fresh) return { ok: false, status: 409, error: 'replay' }

  const granted: string[] = []
  const refused: { agent: string; reason: string }[] = []
  for (const agent of agents) {
    if (await hostMayReceive(env, host, agent)) granted.push(agent)
    else refused.push({ agent, reason: 'not_granted' })
  }
  if (granted.length === 0) return { ok: false, status: 403, error: 'no_granted_agents' }
  return { ok: true, host, granted, refused }
}

// ── tickets ───────────────────────────────────────────────────────────────────────────────

export interface TicketRecord {
  host: string
  agents: string[]
  expires_at: number // unix seconds
}

export interface TicketStore {
  put(hash: string, rec: TicketRecord): Promise<void>
  /** Atomically read and delete — the single-use property lives here. */
  take(hash: string): Promise<TicketRecord | null>
}

/** The subset of DurableObjectStorage the ticket store uses (so it runs under plain vitest). */
export interface TicketStorage {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  delete(keys: string | string[]): Promise<unknown>
  list<T>(opts: { prefix: string }): Promise<Map<string, T>>
}

const TICKET_PREFIX = 'ticket:'

export function storageTicketStore(storage: TicketStorage, nowSec: () => number): TicketStore & { purgeExpired(): Promise<void> } {
  return {
    async put(hash, rec) {
      await storage.put(TICKET_PREFIX + hash, rec)
    },
    // Single use: read then delete. The DO processes one hello at a time per input gate, so no
    // second redeem can interleave between the two.
    async take(hash) {
      const key = TICKET_PREFIX + hash
      const rec = await storage.get<TicketRecord>(key)
      if (rec) await storage.delete(key)
      return rec ?? null
    },
    // Event-driven cleanup: runs when a ticket is minted, never on a timer.
    async purgeExpired() {
      const all = await storage.list<TicketRecord>({ prefix: TICKET_PREFIX })
      const dead = [...all].filter(([, r]) => r.expires_at < nowSec()).map(([k]) => k)
      if (dead.length) await storage.delete(dead)
    },
  }
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function mintTicketSecret(): Promise<{ ticket: string; hash: string }> {
  const raw = crypto.getRandomValues(new Uint8Array(32))
  let bin = ''
  for (const b of raw) bin += String.fromCharCode(b)
  const ticket = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return { ticket, hash: await sha256Hex(ticket) }
}

// ── the hub (DO logic, runtime-free so it runs under plain vitest) ────────────────────────

export interface SocketState {
  host: string
  agents: string[]
}

export interface HubSocket {
  send(data: string): void
  close(code: number, reason: string): void
  getState(): SocketState | null
  setState(s: SocketState): void
}

export interface HubDeps {
  sockets: () => HubSocket[]
  tickets: TicketStore
  nowSec?: () => number
  /** Bounded memory of recently published hint ids; survives across calls while the DO is awake. */
  recent?: RecentIds
  authorize?: (host: string, agent: string) => Promise<boolean>
}

export class RecentIds {
  private readonly ids = new Set<string>()
  constructor(private readonly max = RECENT_HINT_IDS) {}
  /** true the first time an id is seen. */
  add(id: string): boolean {
    if (this.ids.has(id)) return false
    this.ids.add(id)
    if (this.ids.size > this.max) this.ids.delete(this.ids.values().next().value as string)
    return true
  }
}

export async function backlogFor(env: Env, agent: string, since: number): Promise<{ unread: number; complete: boolean; hints: SeatHint[] }> {
  const cols = HINT_FIELDS.filter((f) => f !== 'to_agent').join(', ')
  const rows = await env.DB.prepare(
    `SELECT ${cols} FROM agent_messages
      WHERE tenant = ?1 AND to_agent = ?2 AND read_at IS NULL AND seq > ?3
      ORDER BY seq ASC LIMIT ?4`,
  ).bind(env.TENANT_SLUG, agent, since, BACKLOG_HINT_LIMIT + 1).all<Record<string, unknown>>()
  const list = rows.results ?? []
  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM agent_messages WHERE tenant = ?1 AND to_agent = ?2 AND read_at IS NULL`,
  ).bind(env.TENANT_SLUG, agent).first<{ n: number }>()
  const hints = list.slice(0, BACKLOG_HINT_LIMIT).map((r) => hintFromRow(r, agent)).filter((h): h is SeatHint => h !== null)
  return { unread: Number(count?.n ?? 0), complete: list.length <= BACKLOG_HINT_LIMIT, hints }
}

export class SeatEventsHub {
  private readonly nowSec: () => number
  private readonly recent: RecentIds
  private readonly authorize: (host: string, agent: string) => Promise<boolean>

  constructor(private readonly env: Env, private readonly deps: HubDeps) {
    this.nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000))
    this.recent = deps.recent ?? new RecentIds()
    this.authorize = deps.authorize ?? ((host, agent) => hostMayReceive(env, host, agent))
  }

  /** The only client frame: `{type:'hello', v, ticket, since:{agent:seq}}`. Anything else is ignored. */
  async onMessage(sock: HubSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string') return
    let f: Record<string, unknown>
    try {
      f = JSON.parse(raw)
    } catch {
      return
    }
    if (f?.type !== 'hello') return
    if (sock.getState()) return sock.send(encodeFrame({ type: 'error', reason: 'already_subscribed' }))
    if (f.v !== SEAT_EVENTS_PROTOCOL) return this.reject(sock, 'protocol_unsupported')
    if (typeof f.ticket !== 'string' || !TICKET_RE.test(f.ticket)) return this.reject(sock, 'ticket_invalid')
    const rec = await this.deps.tickets.take(await sha256Hex(f.ticket))
    if (!rec || rec.expires_at < this.nowSec()) return this.reject(sock, 'ticket_invalid')

    const since = (f.since && typeof f.since === 'object' ? f.since : {}) as Record<string, unknown>
    const subs: { agent: string; ok: boolean; reason?: string }[] = []
    const mine: string[] = []
    for (const agent of rec.agents) {
      // Re-check at redeem: a grant revoked between mint and connect must not open.
      if (!(await this.authorize(rec.host, agent))) {
        subs.push({ agent, ok: false, reason: 'not_granted' })
        continue
      }
      const conflict = await this.claim(sock, rec.host, agent)
      if (conflict) {
        subs.push({ agent, ok: false, reason: conflict })
        continue
      }
      mine.push(agent)
      subs.push({ agent, ok: true })
    }
    if (mine.length === 0) {
      sock.send(encodeFrame({ type: 'ready', protocol: SEAT_EVENTS_PROTOCOL, host: rec.host, subscriptions: subs }))
      sock.close(CLOSE_NO_SUBSCRIPTIONS, 'no_subscriptions')
      return
    }
    sock.setState({ host: rec.host, agents: mine })
    sock.send(encodeFrame({ type: 'ready', protocol: SEAT_EVENTS_PROTOCOL, host: rec.host, subscriptions: subs }))
    for (const agent of mine) {
      const s = Number(since[agent] ?? 0)
      const b = await backlogFor(this.env, agent, Number.isSafeInteger(s) && s > 0 ? s : 0)
      sock.send(encodeFrame({ type: 'backlog', agent, ...b }))
    }
  }

  /** One live socket per agent. Same host reconnecting supersedes its old socket; another host
   *  that is still authorized keeps the agent (the grant table makes this unreachable unless a
   *  grant moved while an old socket lived — then the old holder is evicted as revoked). */
  private async claim(sock: HubSocket, host: string, agent: string): Promise<string | null> {
    for (const other of this.deps.sockets()) {
      if (other === sock) continue
      const st = other.getState()
      if (!st?.agents.includes(agent)) continue
      if (st.host !== host && (await this.authorize(st.host, agent))) return 'held_by_other_host'
      const frame: ServerFrame =
        st.host === host
          ? { type: 'superseded', agent, reason: 'newer_connection_same_host' }
          : { type: 'revoked', agent, reason: 'grant_moved' }
      this.drop(other, st, agent, frame)
    }
    return null
  }

  private drop(sock: HubSocket, st: SocketState, agent: string, frame: ServerFrame): void {
    const agents = st.agents.filter((a) => a !== agent)
    sock.setState({ host: st.host, agents })
    try {
      sock.send(encodeFrame(frame))
      if (agents.length === 0) sock.close(CLOSE_NO_SUBSCRIPTIONS, 'no_subscriptions')
    } catch {
      // socket already gone
    }
  }

  private reject(sock: HubSocket, reason: string): void {
    sock.send(encodeFrame({ type: 'error', reason }))
    sock.close(CLOSE_TICKET_INVALID, reason)
  }

  /** Fan a committed-message hint out to the socket holding its agent. Duplicate publishes
   *  (Queue redelivery) are dropped while the DO stays awake; after hibernation a duplicate
   *  reaches the host, which dedups by id and seq floor — harmless either way. */
  async publish(hint: SeatHint): Promise<{ sent: number; duplicate: boolean; revoked: number }> {
    if (!this.recent.add(hint.id)) return { sent: 0, duplicate: true, revoked: 0 }
    let sent = 0
    let revoked = 0
    for (const sock of this.deps.sockets()) {
      const st = sock.getState()
      if (!st?.agents.includes(hint.to_agent)) continue
      if (!(await this.authorize(st.host, hint.to_agent))) {
        this.drop(sock, st, hint.to_agent, { type: 'revoked', agent: hint.to_agent, reason: 'grant_revoked' })
        revoked++
        continue
      }
      try {
        sock.send(encodeFrame({ type: 'hint', agent: hint.to_agent, hint }))
        sent++
      } catch {
        // socket closed under us; the host's reconnect catch-up covers it
      }
    }
    return { sent, duplicate: false, revoked }
  }
}

// ── worker-side publish (called by the bus consumer) ──────────────────────────────────────

export type PublishSeatHintResult =
  | { ok: true; skipped: true; reason: 'disabled' | 'invalid_payload' | 'tenant_mismatch' }
  | { ok: true; skipped: false; sent: number }
  | { ok: false; error: string }

export async function publishSeatHint(env: Env, tenant: string, payload: unknown): Promise<PublishSeatHintResult> {
  if (!isSeatEventsEnabled(env) || !env.SEAT_EVENTS) return { ok: true, skipped: true, reason: 'disabled' }
  if (tenant !== env.TENANT_SLUG) return { ok: true, skipped: true, reason: 'tenant_mismatch' }
  const hint = hintFromPayload(payload as Partial<MessageCreatedPayload>)
  if (!hint) return { ok: true, skipped: true, reason: 'invalid_payload' }
  const ns = env.SEAT_EVENTS
  try {
    const res = await ns.get(ns.idFromName(seatEventsChannelName(env.TENANT_SLUG))).fetch(
      new Request('https://seat-events/hint', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(hint),
      }),
    )
    if (!res.ok) return { ok: false, error: `seat_events_http_${res.status}` }
    const body = (await res.json()) as { sent?: unknown }
    return { ok: true, skipped: false, sent: typeof body.sent === 'number' ? body.sent : 0 }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'seat_events_fetch_failed' }
  }
}
