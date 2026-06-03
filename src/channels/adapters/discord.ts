// mupot — Discord channel adapter (LEAF plugin). The microkernel core depends ONLY
// on the ChannelAdapter interface; this file is the single place any Discord-specific
// knowledge lives. Adding/removing Discord = this file + one registry entry, nothing
// else touches the core.
//
// Sovereign-core discipline (same as src/mcp + src/im + src/auth):
//   - Identity is the PLATFORM MAPPING, never message text. parseInbound returns the
//     raw Discord channel_id + user id; the core resolves those to a binding/member.
//     We never read a self-claimed identity field as proof of "who".
//   - Webhook authenticity is verified fail-closed: a missing public key or a bad
//     Ed25519 signature → verify() returns false and the core rejects the request.
//   - Secrets (DISCORD_PUBLIC_KEY, DISCORD_BOT_TOKEN) are runtime-only and are NEVER
//     logged, echoed, or returned. The bot token leaves this file only inside an
//     Authorization header on an outbound fetch to Discord.
//
// Exports: `discordAdapter: ChannelAdapter` (platform 'discord').

import type { ChannelAdapter, Env, InboundMessage, Capability } from '../../types'

// ── env secret access ─────────────────────────────────────────────────────────
// DISCORD_PUBLIC_KEY / DISCORD_BOT_TOKEN are platform-specific secrets. They are
// runtime-only (wrangler secrets) and intentionally NOT on the shared Env interface
// in types.ts (which this part must not edit). We read them through a narrow,
// per-adapter view of env. The cast is the documented seam for adapter-local secrets;
// it widens nothing for the core and never escapes this module.
interface DiscordSecrets {
  DISCORD_PUBLIC_KEY?: string
  DISCORD_BOT_TOKEN?: string
}

function discordSecrets(env: Env): DiscordSecrets {
  // `as` is required because DiscordSecrets keys are not declared on Env; this is the
  // adapter-local secret seam, documented in the header. No platform code leaks out.
  return env as unknown as DiscordSecrets
}

const DISCORD_API = 'https://discord.com/api/v10'

// ── Ed25519 verification (Web Crypto, fail-closed) ────────────────────────────
// Discord signs each interaction webhook with Ed25519 over (timestamp + raw body),
// using the application's public key. We validate X-Signature-Ed25519 against
// X-Signature-Timestamp + body. Absent key, absent headers, malformed hex, or a
// failed verify all return false — the core then refuses the request.

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0) return null
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) return null
    out[i] = byte
  }
  return out
}

async function importEd25519PublicKey(publicKeyHex: string): Promise<CryptoKey | null> {
  const raw = hexToBytes(publicKeyHex)
  if (!raw || raw.length !== 32) return null // Ed25519 public keys are 32 bytes
  try {
    return await crypto.subtle.importKey(
      'raw',
      raw,
      { name: 'Ed25519' },
      false,
      ['verify'],
    )
  } catch {
    // Runtime without Ed25519 support, or a malformed key → fail closed.
    return null
  }
}

/**
 * verify — validate the Discord interaction signature, fail-closed.
 * Requires DISCORD_PUBLIC_KEY plus both signature headers; any miss → false.
 * Reads the raw body via req.clone() so parseInbound can still read it afterward.
 */
async function verify(req: Request, env: Env): Promise<boolean> {
  const publicKeyHex = discordSecrets(env).DISCORD_PUBLIC_KEY
  if (!publicKeyHex) return false // no key configured → sealed (fail-closed)

  const signatureHex = req.headers.get('X-Signature-Ed25519')
  const timestamp = req.headers.get('X-Signature-Timestamp')
  if (!signatureHex || !timestamp) return false

  const signature = hexToBytes(signatureHex)
  if (!signature || signature.length !== 64) return false // Ed25519 sigs are 64 bytes

  const key = await importEd25519PublicKey(publicKeyHex)
  if (!key) return false

  let body: string
  try {
    body = await req.clone().text()
  } catch {
    return false
  }

  const message = new TextEncoder().encode(timestamp + body)
  try {
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, signature, message)
  } catch {
    return false
  }
}

// ── inbound parsing ───────────────────────────────────────────────────────────
// Discord delivers Interactions to the webhook. We accept two shapes:
//   - Interaction (slash/message-component/etc.): { type, channel_id, member|user, data }
//   - A plain message-create-shaped payload (gateway relay): { channel_id, author, content }
// We return null for a PING (type 1 — answered with a PONG by the core, not here),
// for anything without a channel + user, or for messages authored by a bot (no
// self-loops). Identity fields are returned RAW for the core to map — never trusted
// here as authorization.

// Discord interaction type 1 = PING. 2 = APPLICATION_COMMAND. 3 = MESSAGE_COMPONENT.
const INTERACTION_PING = 1

interface DiscordUser {
  id?: unknown
  bot?: unknown
}

interface DiscordInteraction {
  type?: unknown
  channel_id?: unknown
  // For guild interactions Discord nests the user under `member.user`; for DMs it's
  // top-level `user`.
  member?: { user?: DiscordUser } | null
  user?: DiscordUser | null
  data?: {
    // slash-command options or the resolved message text, when present
    name?: unknown
    options?: Array<{ name?: unknown; value?: unknown }> | null
  } | null
  // message-component / modal payloads can carry a `message.content`
  message?: { content?: unknown } | null
}

interface DiscordMessageCreate {
  channel_id?: unknown
  author?: DiscordUser | null
  content?: unknown
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

// Pull a usable text payload out of an interaction: a top-level message content, a
// slash-command's first string option, or the command name as a last resort.
function interactionText(i: DiscordInteraction): string {
  const msgContent = asString(i.message?.content)
  if (msgContent) return msgContent

  const options = i.data?.options
  if (Array.isArray(options)) {
    for (const opt of options) {
      const val = asString(opt?.value)
      if (val) return val
    }
  }
  const name = asString(i.data?.name)
  return name ?? ''
}

function userId(u: DiscordUser | null | undefined): string | null {
  return u ? asString(u.id) : null
}

function isBot(u: DiscordUser | null | undefined): boolean {
  return u?.bot === true
}

/**
 * parseInbound — Discord payload → normalized InboundMessage, or null.
 * Returns null for PING, bot-authored messages, or any payload missing a channel
 * id or a user id. The text is the user's intent; the identity is the platform
 * mapping (returned raw for the core to resolve), never authorization.
 */
async function parseInbound(req: Request, _env: Env): Promise<InboundMessage | null> {
  let payload: unknown
  try {
    payload = await req.clone().json()
  } catch {
    return null
  }
  if (!payload || typeof payload !== 'object') return null

  // PING handshake — not a message; the core answers the PONG. Never treat as input.
  const maybeType = (payload as { type?: unknown }).type
  if (maybeType === INTERACTION_PING) return null

  // Interaction shape (has a `type`) takes precedence; otherwise message-create.
  if (typeof maybeType === 'number') {
    const i = payload as DiscordInteraction
    const channelId = asString(i.channel_id)
    if (!channelId) return null
    const user = i.member?.user ?? i.user ?? null
    if (isBot(user)) return null
    const uid = userId(user)
    if (!uid) return null
    const text = interactionText(i)
    return { platform: 'discord', externalChannelId: channelId, externalUserId: uid, text }
  }

  const m = payload as DiscordMessageCreate
  const channelId = asString(m.channel_id)
  if (!channelId) return null
  if (isBot(m.author)) return null // ignore bot/self messages → no loops
  const uid = userId(m.author)
  if (!uid) return null
  const content = asString(m.content) ?? ''
  return { platform: 'discord', externalChannelId: channelId, externalUserId: uid, text: content }
}

// ── outbound post ─────────────────────────────────────────────────────────────
// POST /channels/{id}/messages with the bot token. The token never appears in a log
// line or an error message — on failure we surface only the HTTP status, not headers.

async function post(env: Env, externalChannelId: string, text: string): Promise<void> {
  const token = discordSecrets(env).DISCORD_BOT_TOKEN
  if (!token) {
    // Fail-closed and token-safe: no secret, no send. Never log the (absent) token.
    throw new Error('discord: DISCORD_BOT_TOKEN not configured')
  }

  const res = await fetch(`${DISCORD_API}/channels/${encodeURIComponent(externalChannelId)}/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bot ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ content: text }),
  })

  if (!res.ok) {
    // Surface status only — never the request headers (which carry the token) or the
    // token itself. Discord's error body is safe to include (no secret echoed back).
    const detail = await res.text().catch(() => '')
    throw new Error(`discord: post failed (${res.status}) ${detail.slice(0, 256)}`)
  }
}

// ── channel members ───────────────────────────────────────────────────────────
// Discord channels live inside a guild; "members visible to the channel" are the
// guild's members (the bot needs the GUILD_MEMBERS privileged intent + permission to
// read them). We resolve the channel → its guild_id, then page guild members and
// return the external user ids. Best-effort + fail-soft: any error → [].

interface DiscordChannel {
  guild_id?: unknown
}

interface DiscordGuildMember {
  user?: DiscordUser | null
}

async function discordGet(env: Env, path: string): Promise<unknown | null> {
  const token = discordSecrets(env).DISCORD_BOT_TOKEN
  if (!token) return null
  const res = await fetch(`${DISCORD_API}${path}`, {
    headers: { authorization: `Bot ${token}` },
  })
  if (!res.ok) return null
  return res.json<unknown>().catch(() => null)
}

async function channelGuildId(env: Env, channelId: string): Promise<string | null> {
  const data = await discordGet(env, `/channels/${encodeURIComponent(channelId)}`)
  if (!data || typeof data !== 'object') return null
  return asString((data as DiscordChannel).guild_id)
}

/**
 * listChannelMembers — external user ids of the guild members visible to a channel.
 * Pages the guild-members list (Discord caps a page at 1000). Excludes bots so sync
 * never grants capabilities to a bot account. Fail-soft: returns [] on any error so
 * a transient Discord outage can't wedge reconciliation.
 */
async function listChannelMembers(env: Env, externalChannelId: string): Promise<string[]> {
  const guildId = await channelGuildId(env, externalChannelId)
  if (!guildId) return []

  const ids: string[] = []
  const seen = new Set<string>()
  let after = '0'
  const PAGE = 1000

  // Bounded paging loop — Discord returns < PAGE on the final page. The `after`
  // cursor is the highest user id seen. Hard cap the iterations defensively.
  for (let page = 0; page < 50; page++) {
    const data = await discordGet(
      env,
      `/guilds/${encodeURIComponent(guildId)}/members?limit=${PAGE}&after=${encodeURIComponent(after)}`,
    )
    if (!Array.isArray(data) || data.length === 0) break

    let maxId = after
    for (const raw of data as DiscordGuildMember[]) {
      const user = raw?.user ?? null
      if (isBot(user)) continue
      const uid = userId(user)
      if (!uid || seen.has(uid)) continue
      seen.add(uid)
      ids.push(uid)
      // user ids are snowflakes (monotonic, numeric strings) — track the max for paging
      if (uid.length > maxId.length || (uid.length === maxId.length && uid > maxId)) {
        maxId = uid
      }
    }

    if (data.length < PAGE) break // last page
    if (maxId === after) break // no progress → stop (defensive)
    after = maxId
  }

  return ids
}

// ── role → capability (optional) ──────────────────────────────────────────────
// Convention: a Discord role named "<squad>-<capability>" (e.g. "growth-lead",
// "ops-admin") maps its suffix to a mupot Capability. The squad prefix is informational
// here — the binding already scopes the channel to a squad; this maps the member's
// platform ROLE to a capability for membership-sync. The per-binding max_capability
// ceiling is enforced by the CORE on sync, not here. We return the HIGHEST capability
// implied by the user's roles, or null if none match the convention.

const CAPABILITY_SUFFIXES: Capability[] = ['owner', 'admin', 'lead', 'member', 'observer']

interface DiscordGuildMemberRoles {
  roles?: unknown // array of role id strings
}

interface DiscordRole {
  id?: unknown
  name?: unknown
}

function capabilityFromRoleName(roleName: string): Capability | null {
  const lower = roleName.trim().toLowerCase()
  for (const cap of CAPABILITY_SUFFIXES) {
    // "<squad>-<cap>" or a bare "<cap>" role both resolve to <cap>.
    if (lower === cap || lower.endsWith(`-${cap}`)) return cap
  }
  return null
}

function capRank(cap: Capability): number {
  // Local rank — mirrors auth/capability.ts's ladder. We only need an ordering to
  // pick the highest role-implied capability; the authoritative gate lives in the core.
  return CAPABILITY_SUFFIXES.length - CAPABILITY_SUFFIXES.indexOf(cap)
}

/**
 * roleCapability — map a Discord user's guild ROLES to the highest mupot Capability
 * implied by the naming convention, or null. Reads the member's role ids, resolves
 * them to role names via the guild roles list, and matches the suffix convention.
 * Fail-soft: any error → null (no capability inferred → core falls back to its
 * per-binding default, never an over-grant).
 */
async function roleCapability(
  env: Env,
  externalChannelId: string,
  externalUserId: string,
): Promise<Capability | null> {
  const guildId = await channelGuildId(env, externalChannelId)
  if (!guildId) return null

  const memberData = await discordGet(
    env,
    `/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(externalUserId)}`,
  )
  if (!memberData || typeof memberData !== 'object') return null
  const roleIds = (memberData as DiscordGuildMemberRoles).roles
  if (!Array.isArray(roleIds) || roleIds.length === 0) return null
  const roleIdSet = new Set(roleIds.filter((r): r is string => typeof r === 'string'))
  if (roleIdSet.size === 0) return null

  const rolesData = await discordGet(env, `/guilds/${encodeURIComponent(guildId)}/roles`)
  if (!Array.isArray(rolesData)) return null

  let best: Capability | null = null
  for (const raw of rolesData as DiscordRole[]) {
    const id = asString(raw?.id)
    const name = asString(raw?.name)
    if (!id || !name || !roleIdSet.has(id)) continue
    const cap = capabilityFromRoleName(name)
    if (cap && (best === null || capRank(cap) > capRank(best))) best = cap
  }
  return best
}

// ── the adapter (the only export the core sees) ───────────────────────────────
export const discordAdapter: ChannelAdapter = {
  platform: 'discord',
  verify,
  parseInbound,
  post,
  listChannelMembers,
  roleCapability,
}
