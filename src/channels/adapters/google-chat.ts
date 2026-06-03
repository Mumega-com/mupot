// mupot — Google Chat channel adapter (LEAF plugin). The microkernel core depends
// ONLY on the ChannelAdapter interface; this file is the single place any Google
// Chat-specific knowledge lives. Adding/removing Google Chat = this file + one
// registry entry, nothing else touches the core.
//
// This is viamar's likely pick (a Google shop): identity = the user's EMAIL, so a
// platform user auto-binds to members.email with ZERO link step. Google Chat has
// no per-space roles, so roleCapability returns null and the core falls back to the
// per-binding default capability (respecting max_capability on sync).
//
// Sovereign-core discipline (same as src/mcp + src/im + src/auth + the Discord adapter):
//   - Identity is the PLATFORM MAPPING, never message text. parseInbound returns the
//     raw space name + the sender's email; the core resolves those to a binding/member.
//     We never read a self-claimed identity field as proof of "who" for authorization.
//   - Webhook authenticity is verified fail-closed: Google Chat sends a Bearer token in
//     the Authorization header (the verification token configured on the app, or the
//     bearer audience token issued to the app). No configured secret → verify() returns
//     false and the core rejects the request.
//   - Secrets (GOOGLE_CHAT_VERIFY_TOKEN, GOOGLE_CHAT_TOKEN) are runtime-only and are
//     NEVER logged, echoed, or returned. The service token leaves this file only inside
//     an Authorization header on an outbound fetch to Google.
//
// Exports: `googleChatAdapter: ChannelAdapter` (platform 'google-chat').

import type { ChannelAdapter, Env, InboundMessage, Capability } from '../../types'

// ── env secret access ─────────────────────────────────────────────────────────
// GOOGLE_CHAT_VERIFY_TOKEN / GOOGLE_CHAT_TOKEN are platform-specific secrets. They are
// runtime-only (wrangler secrets) and intentionally NOT on the shared Env interface in
// types.ts (which this part must not edit). We read them through a narrow, per-adapter
// view of env. The cast is the documented seam for adapter-local secrets; it widens
// nothing for the core and never escapes this module.
interface GoogleChatSecrets {
  // Shared verification token configured on the Chat app's webhook (Google sends it
  // back as the Authorization bearer on each event) — OR the bearer issued to the app.
  GOOGLE_CHAT_VERIFY_TOKEN?: string
  // OAuth2 access token / service-auth bearer used to call the Chat REST API (post,
  // members.list). Service-account based; minted out of band, supplied as a secret.
  GOOGLE_CHAT_TOKEN?: string
}

function googleChatSecrets(env: Env): GoogleChatSecrets {
  // `as` is required because GoogleChatSecrets keys are not declared on Env; this is the
  // adapter-local secret seam, documented in the header. No platform code leaks out.
  return env as unknown as GoogleChatSecrets
}

const CHAT_API = 'https://chat.googleapis.com/v1'

// ── small helpers ───────────────────────────────────────────────────────────────
function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

// Extract the raw bearer token from an Authorization header value, or null.
function bearerToken(header: string | null): string | null {
  if (!header) return null
  const m = header.match(/^Bearer\s+(.+)$/i)
  if (!m) return null
  const tok = m[1].trim()
  return tok.length > 0 ? tok : null
}

// Constant-time string compare (length + char xor). Avoids leaking the secret
// character-by-character via early-exit timing. Both inputs are short bearer tokens.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// A Google Chat space is addressed as a resource name: "spaces/AAAA...". The core
// stores that whole resource name as external_channel_id. Build a REST path from it,
// tolerating either the bare id or the full "spaces/<id>" form. Never log the result
// with a token.
function spacePath(externalChannelId: string): string {
  const trimmed = externalChannelId.trim()
  return trimmed.startsWith('spaces/') ? trimmed : `spaces/${trimmed}`
}

// ── verify (fail-closed) ──────────────────────────────────────────────────────
// Google Chat authenticates webhook deliveries with a Bearer token in the
// Authorization header. In the simplest (and recommended-for-self-host) setup that is
// a fixed verification token you configure on the app; Google echoes it back on every
// event. We compare it against GOOGLE_CHAT_VERIFY_TOKEN in constant time. No configured
// token → sealed (return false): an unauthenticated POST could otherwise forge a space
// + sender email and impersonate that member's capabilities.
//
// (A production deployment may instead verify a Google-signed JWT audience bearer; that
// upgrade lives entirely in this function and changes nothing in the core.)
async function verify(req: Request, env: Env): Promise<boolean> {
  const expected = googleChatSecrets(env).GOOGLE_CHAT_VERIFY_TOKEN
  if (!expected) return false // no token configured → fail closed

  const presented = bearerToken(req.headers.get('authorization'))
  if (!presented) return false

  return safeEqual(presented, expected)
}

// ── inbound parsing ───────────────────────────────────────────────────────────
// Google Chat delivers events as JSON. The shapes we care about:
//   - MESSAGE event: { type:'MESSAGE', space:{name}, message:{ sender:{email,type},
//                      argumentText, text }, user:{email,type} }
//   - ADDED_TO_SPACE / REMOVED_FROM_SPACE / other: no usable message → null.
// Identity is the SENDER'S EMAIL (so it auto-binds to members.email). We return null
// for any event without a space + a human sender email, and for bot-authored messages
// (sender.type === 'BOT') so the app never loops on its own posts. Identity fields are
// returned RAW for the core to map — never trusted here as authorization.

interface GoogleChatUser {
  name?: unknown
  email?: unknown
  type?: unknown // 'HUMAN' | 'BOT'
}

interface GoogleChatSpace {
  name?: unknown // "spaces/AAAA..."
}

interface GoogleChatMessage {
  sender?: GoogleChatUser | null
  argumentText?: unknown // message text with the bot @mention stripped
  text?: unknown // full message text (fallback)
}

interface GoogleChatEvent {
  type?: unknown // 'MESSAGE' | 'ADDED_TO_SPACE' | ...
  space?: GoogleChatSpace | null
  message?: GoogleChatMessage | null
  user?: GoogleChatUser | null // the user who triggered the event
}

function isBotUser(u: GoogleChatUser | null | undefined): boolean {
  return typeof u?.type === 'string' && u.type.toUpperCase() === 'BOT'
}

// Prefer argumentText (mention-stripped) so a "@bot task: x" reads as "task: x"; fall
// back to the full text. Either may be absent on non-text events.
function messageText(m: GoogleChatMessage | null | undefined): string {
  if (!m) return ''
  return asString(m.argumentText) ?? asString(m.text) ?? ''
}

/**
 * parseInbound — Google Chat event → normalized InboundMessage, or null.
 * Returns null for non-MESSAGE events, bot-authored messages, or any payload missing a
 * space name or a sender email. externalUserId is the sender's EMAIL (auto-binds to
 * members.email). The text is the user's intent; identity is the platform mapping,
 * never authorization.
 */
async function parseInbound(req: Request, _env: Env): Promise<InboundMessage | null> {
  let payload: unknown
  try {
    payload = await req.clone().json()
  } catch {
    return null
  }
  if (!payload || typeof payload !== 'object') return null

  const event = payload as GoogleChatEvent

  // Only message events carry user intent. Everything else (ADDED_TO_SPACE, etc.) is
  // not a message → the core has nothing to act on.
  const type = asString(event.type)
  if (type !== 'MESSAGE') return null

  const spaceName = asString(event.space?.name)
  if (!spaceName) return null

  // Sender identity = email. Google nests it under message.sender; some payloads also
  // carry a top-level `user`. Prefer the message sender (the message author).
  const sender = event.message?.sender ?? event.user ?? null
  if (isBotUser(sender)) return null // ignore bot/self messages → no loops
  const email = asString(sender?.email)
  if (!email) return null

  const text = messageText(event.message)
  return {
    platform: 'google-chat',
    externalChannelId: spaceName,
    externalUserId: email,
    text,
  }
}

// ── outbound post ─────────────────────────────────────────────────────────────
// POST https://chat.googleapis.com/v1/{space}/messages with the service bearer token.
// The token never appears in a log line or an error message — on failure we surface
// only the HTTP status (+ Google's body, which carries no secret), never the headers.

async function post(env: Env, externalChannelId: string, text: string): Promise<void> {
  const token = googleChatSecrets(env).GOOGLE_CHAT_TOKEN
  if (!token) {
    // Fail-closed and token-safe: no secret, no send. Never log the (absent) token.
    throw new Error('google-chat: GOOGLE_CHAT_TOKEN not configured')
  }

  const space = spacePath(externalChannelId)
  const res = await fetch(`${CHAT_API}/${space}/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ text }),
  })

  if (!res.ok) {
    // Surface status only — never the request headers (which carry the token) or the
    // token itself. Google's error body is safe to include (no secret echoed back).
    const detail = await res.text().catch(() => '')
    throw new Error(`google-chat: post failed (${res.status}) ${detail.slice(0, 256)}`)
  }
}

// ── channel members ───────────────────────────────────────────────────────────
// spaces.members.list → the space's memberships. Each membership nests the human
// under `member.email` (type 'HUMAN'). We page via nextPageToken and return the
// external user ids = EMAILS (so they line up with parseInbound + members.email).
// Bots are excluded so sync never grants capabilities to a bot account. Best-effort +
// fail-soft: any error → [] so a transient Google outage can't wedge reconciliation.

interface GoogleChatMembership {
  member?: GoogleChatUser | null // the human/bot principal
  state?: unknown // 'JOINED' | 'INVITED' | ...
}

interface GoogleChatMembersList {
  memberships?: GoogleChatMembership[] | null
  nextPageToken?: unknown
}

async function chatGet(env: Env, path: string): Promise<unknown | null> {
  const token = googleChatSecrets(env).GOOGLE_CHAT_TOKEN
  if (!token) return null
  const res = await fetch(`${CHAT_API}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!res.ok) return null
  return res.json<unknown>().catch(() => null)
}

/**
 * listChannelMembers — the EMAILS of the human members of a Google Chat space.
 * Pages spaces.members.list via nextPageToken (we request the max page size and follow
 * the cursor). Excludes bots and de-dupes (case-insensitively). Fail-soft: returns []
 * on any error so a transient outage can't wedge reconciliation. Emails feed the core's
 * membership sync, which binds them to members.email under the per-binding ceiling.
 */
async function listChannelMembers(env: Env, externalChannelId: string): Promise<string[]> {
  const space = spacePath(externalChannelId)
  const emails: string[] = []
  const seen = new Set<string>()
  let pageToken = ''

  // Bounded paging loop — stop when Google returns no nextPageToken. Hard cap the
  // iterations defensively against a misbehaving cursor.
  for (let page = 0; page < 100; page++) {
    const query = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''
    const data = await chatGet(env, `/${space}/members?pageSize=1000${query}`)
    if (!data || typeof data !== 'object') break

    const list = data as GoogleChatMembersList
    const memberships = Array.isArray(list.memberships) ? list.memberships : []
    for (const m of memberships) {
      const principal = m?.member ?? null
      if (isBotUser(principal)) continue
      const email = asString(principal?.email)
      if (!email) continue
      const key = email.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      emails.push(email)
    }

    const next = asString(list.nextPageToken)
    if (!next) break
    pageToken = next
  }

  return emails
}

// ── role → capability (optional) ──────────────────────────────────────────────
// Google Chat has NO per-space roles (membership is flat: a member is in the space or
// not). There is no platform signal to map to a finer capability, so we return null and
// the core falls back to the per-binding default capability (bounded by max_capability
// on sync). Declared explicitly for parity with the other adapters.
async function roleCapability(
  _env: Env,
  _externalChannelId: string,
  _externalUserId: string,
): Promise<Capability | null> {
  return null
}

// ── the adapter (the only export the core sees) ───────────────────────────────
export const googleChatAdapter: ChannelAdapter = {
  platform: 'google-chat',
  verify,
  parseInbound,
  post,
  listChannelMembers,
  roleCapability,
}
