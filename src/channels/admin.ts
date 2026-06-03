// mupot — channel binding admin (bind a scoped channel to a squad + mint link codes).
// Mounted at /api/channels. The channel IS the squad: a binding row is what makes a
// Discord channel / Google Space / Telegram group resolve to a mupot squad.
//
// Binding is an org-admin action (it grants a whole channel's membership a foothold on
// a squad via sync). Link codes bind a platform user to a member (self, or admin for
// others) — single-use, short-TTL, never a self-claimed identity.

import { Hono, type MiddlewareHandler } from 'hono'
import type { Env, AuthContext, Capability, ChannelBinding } from '../types'
import { requireAuth } from '../auth'
import { requireOrgCapability, actorMaxRankOnScope } from '../auth/capability'
import { getAdapter } from './registry'

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
