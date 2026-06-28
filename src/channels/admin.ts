// mupot — channel binding admin (bind a scoped channel to a squad + mint link codes).
// Mounted at /api/channels. The channel IS the squad: a binding row is what makes a
// Discord channel / Google Space / Telegram group resolve to a mupot squad.
//
// Binding is an org-admin action (it grants a whole channel's membership a foothold on
// a squad via sync). Link codes bind a platform user to a member (self, or admin for
// others) — single-use, short-TTL, never a self-claimed identity.

import { Hono, type MiddlewareHandler } from 'hono'
import { z } from 'zod'
import type { Env, AuthContext, Capability, ChannelBinding } from '../types'
import { requireAuth } from '../auth'
import { requireOrgCapability, actorMaxRankOnScope } from '../auth/capability'
import { getAdapter } from './registry'
import { discordGet, createGuildRole, getDiscordAdminToken } from './adapters/discord'
import { projectMemberCapabilitiesToDiscord, MANAGED_DISCORD_ROLES } from './discord-cap-sync'

type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } }

const CAPS: Capability[] = ['owner', 'admin', 'lead', 'member', 'observer']
function isCapability(v: unknown): v is Capability {
  return typeof v === 'string' && (CAPS as string[]).includes(v)
}
function isNonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

export const channelsAdminApp = new Hono<AppEnv>()

// Auth + hard tenant guard on every route (this app mounts outside the dashboard guard).
const tenantGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('auth').tenant !== c.env.TENANT_SLUG) {
    return c.json({ error: 'forbidden', reason: 'tenant_scope' }, 403)
  }
  await next()
}
channelsAdminApp.use('*', requireAuth, tenantGuard)

// ── bindings ───────────────────────────────────────────────────────────────────
interface BindBody {
  platform?: unknown
  external_channel_id?: unknown
  squad_id?: unknown
  max_capability?: unknown
}

channelsAdminApp.post('/bindings', requireOrgCapability('admin'), async (c) => {
  let body: BindBody
  try {
    body = (await c.req.json()) as BindBody
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }
  if (!isNonEmpty(body.platform) || !isNonEmpty(body.external_channel_id) || !isNonEmpty(body.squad_id)) {
    return c.json({ error: 'platform, external_channel_id, squad_id required' }, 400)
  }
  // platform must be a registered adapter — no dead bindings for unknown platforms.
  if (!getAdapter(body.platform.trim())) {
    return c.json({ error: 'unknown_platform', hint: 'discord | google-chat | telegram' }, 400)
  }
  // max_capability ceiling for sync grants — default 'member'; never above 'lead'
  // from a binding (channel membership must not mint admins/owners).
  const maxCap: Capability = isCapability(body.max_capability) ? body.max_capability : 'member'
  if (maxCap === 'owner' || maxCap === 'admin') {
    return c.json({ error: 'max_capability too high (member|lead only)' }, 400)
  }
  // squad must exist in this tenant's DB
  const squad = await c.env.DB.prepare('SELECT id FROM squads WHERE id = ?1')
    .bind(body.squad_id.trim())
    .first<{ id: string }>()
  if (!squad) return c.json({ error: 'squad_not_found' }, 404)

  const id = crypto.randomUUID()
  try {
    await c.env.DB.prepare(
      'INSERT INTO channel_bindings (id, platform, external_channel_id, squad_id, max_capability) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(id, body.platform.trim(), body.external_channel_id.trim(), body.squad_id.trim(), maxCap)
      .run()
  } catch {
    return c.json({ error: 'binding_exists', hint: 'this channel is already bound' }, 409)
  }
  return c.json({ id, action: 'bound' }, 201)
})

channelsAdminApp.get('/bindings', requireOrgCapability('member'), async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT id, platform, external_channel_id, squad_id, max_capability, created_at FROM channel_bindings ORDER BY created_at DESC',
  ).all<ChannelBinding>()
  return c.json({ bindings: rows.results ?? [] })
})

channelsAdminApp.delete('/bindings/:id', requireOrgCapability('admin'), async (c) => {
  const res = await c.env.DB.prepare('DELETE FROM channel_bindings WHERE id = ?1')
    .bind(c.req.param('id'))
    .run()
  return c.json({ action: 'unbound', removed: res.meta ? res.meta.changes : 0 })
})

// ── link codes (platform user → member binding) ──────────────────────────────────
interface LinkBody {
  member_id?: unknown
  platform?: unknown
}

channelsAdminApp.post('/link-codes', async (c) => {
  const auth = c.get('auth')
  let body: LinkBody
  try {
    body = (await c.req.json()) as LinkBody
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }
  if (!isNonEmpty(body.platform)) return c.json({ error: 'platform required' }, 400)
  if (!getAdapter(body.platform.trim())) {
    return c.json({ error: 'unknown_platform', hint: 'discord | google-chat | telegram' }, 400)
  }
  const memberId = isNonEmpty(body.member_id) ? body.member_id.trim() : auth.memberId
  if (!memberId) return c.json({ error: 'member_id required' }, 400)

  // self-mint is allowed; minting for ANOTHER member requires org admin.
  if (memberId !== auth.memberId) {
    const rank = await actorMaxRankOnScope(c, 'org', null)
    if (rank < 4) return c.json({ error: 'forbidden', need: 'admin to mint for others' }, 403)
  }
  const member = await c.env.DB.prepare('SELECT id FROM members WHERE id = ?1')
    .bind(memberId)
    .first<{ id: string }>()
  if (!member) return c.json({ error: 'member_not_found' }, 404)

  const code = crypto.randomUUID().replace(/-/g, '').slice(0, 12)
  // 15-minute TTL. Date is available in the Workers runtime.
  const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString()
  await c.env.DB.prepare(
    'INSERT INTO channel_link_codes (code, member_id, platform, expires_at) VALUES (?, ?, ?, ?)',
  )
    .bind(code, memberId, body.platform.trim(), expires)
    .run()
  // shown ONCE — the member types `/link <code>` in the channel to bind.
  return c.json({ code, member_id: memberId, platform: body.platform.trim(), expires_at: expires }, 201)
})

// ── sync status ───────────────────────────────────────────────────────────────
channelsAdminApp.get('/sync/status', requireOrgCapability('member'), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT b.id, b.platform, b.squad_id,
            (SELECT COUNT(*) FROM member_identities mi WHERE mi.platform = b.platform) AS identities
       FROM channel_bindings b ORDER BY b.created_at DESC`,
  ).all<{ id: string; platform: string; squad_id: string; identities: number }>()
  return c.json({ bindings: rows.results ?? [] })
})

// ── Discord cap→role sync ─────────────────────────────────────────────────────
// POST /discord/sync — admin-gated. One-way projection of mupot capabilities
// onto Discord guild roles for every member with a Discord identity. mupot is
// the master; Discord roles are purely derived from mupot grants.
//
// §2A role names: @owner | @lead | @squad | @member | @public (MANAGED_DISCORD_ROLES).
// Missing managed roles are CREATED in the guild (live path). Roles not in the
// managed set are NEVER touched.
//
// Dry-run (?dryRun=1 or body {dryRun:true}): resolves guild + builds roleMap
// but does NOT create missing roles. Reports intended projections per member
// with no-op add/remove, so nothing mutates on Discord.
//
// Security: the bot token is NEVER included in a response or error body.
// The route fails closed on absent token, missing binding, or any Discord API
// error that prevents a reliable projection.

const SyncBody = z.object({
  squadId: z.string().optional(),
  dryRun: z.boolean().optional(),
})

// Per-member projection result (safe to return; no token or secret included).
// Discriminated union so TypeScript knows `reason` is always present on failure
// and `targetRole`/`added`/`removed` are always present on success.
type ProjectionEntry =
  | { memberId: string; ok: true; targetRole: string | null; added: string[]; removed: string[] }
  | { memberId: string; ok: false; reason: string }

channelsAdminApp.post('/discord/sync', requireOrgCapability('admin'), async (c) => {
  // ── parse + validate body ─────────────────────────────────────────────────
  let rawBody: unknown = {}
  try {
    rawBody = await c.req.json()
  } catch {
    // empty body or non-JSON body is fine — defaults apply below
  }

  const dryRunQuery = c.req.query('dryRun') === '1'

  const parse = SyncBody.safeParse(rawBody)
  if (!parse.success) {
    return c.json({ error: 'invalid_body', issues: parse.error.issues }, 400)
  }

  const squadId = parse.data.squadId ?? 'squad-core'
  const dryRun = dryRunQuery || (parse.data.dryRun ?? false)

  // ── fail-closed on absent admin token before any external calls ──────────
  // S196 two-bot: DISCORD_ADMIN_BOT_TOKEN is the Kasra admin bot (Manage Roles +
  // Manage Channels). Single-bot setups fall back to DISCORD_BOT_TOKEN via
  // getDiscordAdminToken. If neither is configured → 503.
  const adminToken = getDiscordAdminToken(c.env)
  if (!adminToken) {
    return c.json(
      {
        error: 'no_discord_token',
        hint: 'Set DISCORD_ADMIN_BOT_TOKEN (privileged ops) or DISCORD_BOT_TOKEN (single-bot setup)',
      },
      503,
    )
  }

  // ── step 1: resolve guild id from the squad's bound Discord channel ───────
  const binding = await c.env.DB.prepare(
    `SELECT external_channel_id
       FROM channel_bindings
      WHERE platform = 'discord' AND squad_id = ?1
      LIMIT 1`,
  )
    .bind(squadId)
    .first<{ external_channel_id: string }>()

  if (!binding) {
    return c.json({ error: 'no_discord_binding', squadId }, 404)
  }

  // Admin bot reads the channel and guild roles — the same bot that holds Manage Roles
  // must be able to read guild metadata for the sync to work correctly.
  const channelData = await discordGet(
    c.env,
    `/channels/${encodeURIComponent(binding.external_channel_id)}`,
    adminToken,
  )
  if (!channelData || typeof channelData !== 'object') {
    return c.json(
      { error: 'channel_get_failed', hint: 'Discord GET /channels returned null' },
      502,
    )
  }
  const rawGuildId = (channelData as { guild_id?: unknown }).guild_id
  if (typeof rawGuildId !== 'string' || !rawGuildId) {
    return c.json({ error: 'no_guild_id', hint: 'Discord channel has no guild_id' }, 502)
  }
  const guildId = rawGuildId

  // ── step 2: build roleMap; create missing managed roles (live path only) ──
  const rolesData = await discordGet(
    c.env,
    `/guilds/${encodeURIComponent(guildId)}/roles`,
    adminToken,
  )
  if (!Array.isArray(rolesData)) {
    return c.json(
      { error: 'guild_roles_get_failed', hint: 'Discord GET /guilds/roles returned null' },
      502,
    )
  }

  const roleMap: Record<string, string> = {}
  for (const role of rolesData as { id?: unknown; name?: unknown }[]) {
    const id = typeof role.id === 'string' ? role.id : null
    const name = typeof role.name === 'string' ? role.name : null
    if (id && name && (MANAGED_DISCORD_ROLES as readonly string[]).includes(name)) {
      roleMap[name] = id
    }
  }

  const rolesEnsured: string[] = []
  for (const roleName of MANAGED_DISCORD_ROLES) {
    if (roleMap[roleName]) {
      rolesEnsured.push(`${roleName}:exists`)
    } else if (dryRun) {
      rolesEnsured.push(`${roleName}:would_create`)
    } else {
      // Create the missing managed role in the guild.
      try {
        const newRoleId = await createGuildRole(c.env, guildId, roleName)
        roleMap[roleName] = newRoleId
        rolesEnsured.push(`${roleName}:created`)
      } catch (err) {
        // createGuildRole throws status-only messages (e.g. "discord: createGuildRole failed (403)").
        // We extract the numeric HTTP status and return ONLY {error, role, status} — no upstream
        // response body, no raw error string, no detail that could carry injected content.
        const msg = err instanceof Error ? err.message : String(err)
        const statusMatch = /\((\d+)\)/.exec(msg)
        const status = statusMatch ? statusMatch[1] : 'unknown'
        return c.json({ error: 'role_create_failed', role: roleName, status }, 502)
      }
    }
  }

  // ── step 3: project per discord-linked member ─────────────────────────────
  const identityRows = await c.env.DB.prepare(
    `SELECT member_id FROM member_identities WHERE platform = 'discord'`,
  ).all<{ member_id: string }>()

  const projections: ProjectionEntry[] = []

  for (const { member_id } of identityRows.results ?? []) {
    // Dry-run: inject no-op add/remove so nothing mutates on Discord.
    // The production discordGet (GET member roles) still runs so we can report
    // what WOULD be added/removed — making the dry-run output meaningful.
    const inject = dryRun
      ? {
          addRoleFn: async (_g: string, _u: string, _r: string): Promise<void> => {},
          removeRoleFn: async (_g: string, _u: string, _r: string): Promise<void> => {},
        }
      : undefined

    const result = await projectMemberCapabilitiesToDiscord(
      c.env,
      member_id,
      guildId,
      roleMap,
      inject,
    )

    if (result.ok) {
      projections.push({
        memberId: member_id,
        ok: true,
        targetRole: result.targetRole,
        added: result.added,
        removed: result.removed,
      })
    } else {
      projections.push({
        memberId: member_id,
        ok: false,
        reason: result.reason,
      })
    }
  }

  // ── outcome: fail-CLOSED reporting (BLOCK-1 fix) ─────────────────────────
  // ok:true + 200 ONLY when every projection succeeded (or zero linked members).
  // Any per-member failure → ok:false + 207 Multi-Status with a `failed` summary.
  // The caller must check ok and inspect `failed` — they cannot assume a 200 means
  // "all members synced". This is not a soft warning: a failed member means Discord
  // roles may diverge from mupot capabilities for that principal.

  if (projections.length === 0) {
    // Explicitly signal zero linked members so the caller knows the sync ran but
    // had no targets (common during initial setup before any /link codes are used).
    return c.json({ ok: true, projected: 0, guildId, rolesEnsured, projections }, 200)
  }

  const failed = projections
    .filter((p): p is ProjectionEntry & { ok: false; reason: string } => !p.ok)
    .map((p) => ({ memberId: p.memberId, reason: p.reason }))

  if (failed.length > 0) {
    // 207 Multi-Status: some operations succeeded, some failed. Caller gets the full
    // projections array for detail and a `failed` summary for quick triage.
    return c.json({ ok: false, guildId, rolesEnsured, projections, failed }, 207)
  }

  return c.json({ ok: true, projected: projections.length, guildId, rolesEnsured, projections }, 200)
})
