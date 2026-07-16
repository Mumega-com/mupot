import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import type { Context } from 'hono'
import type { Env, AuthContext } from '../types'
import { requireAuth } from '../auth'
import './modules/fixture'
import { getRegisteredAddon, listRegisteredAddons } from './registry'
import {
  activateAddon,
  archiveAddon,
  countAddonOwnershipClaims,
  configureAddon,
  disableAddon,
  getAddonReceipts,
  getDepartmentStateSha256,
  installAddon,
  listAddonInstallations,
  type AddonInstallation,
  type AddonMutationResult,
  type AddonReceipt,
} from './service'

const MAX_BODY_BYTES = 8192

type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } }
type LifecycleAction = 'install' | 'configure' | 'activate' | 'disable' | 'archive'

function isAdminPlus(auth: AuthContext): boolean {
  return auth.role === 'owner' || auth.role === 'admin'
}

function archivedLifecycleTimestamp(installation: AddonInstallation): string {
  return installation.archivedAt ?? installation.updatedAt
}

function latestInstallationsByKey(installations: AddonInstallation[]): Map<string, AddonInstallation> {
  const byKey = new Map<string, AddonInstallation>()
  for (const installation of installations) {
    const current = byKey.get(installation.addonKey)
    if (!current || (
      current.state === 'archived' && (
        installation.state !== 'archived' || (
          installation.state === 'archived' &&
          archivedLifecycleTimestamp(installation) > archivedLifecycleTimestamp(current)
        )
      )
    )) {
      byKey.set(installation.addonKey, installation)
    }
  }
  return byKey
}

function catalogAddon(entry: ReturnType<typeof listRegisteredAddons>[number], installation: AddonInstallation | undefined) {
  return {
    key: entry.manifest.key,
    name: entry.manifest.name,
    version: entry.manifest.version,
    publisher: entry.manifest.publisher,
    trustClass: entry.manifest.trustClass,
    kind: entry.manifest.kind,
    description: entry.manifest.description,
    state: installation?.state ?? null,
  }
}

function redactedReceipt(receipt: AddonReceipt) {
  return {
    sequence: receipt.sequence,
    id: receipt.id,
    action: receipt.action,
    previousState: receipt.previousState,
    nextState: receipt.nextState,
    addonKey: receipt.addonKey,
    installedVersion: receipt.installedVersion,
    publisher: receipt.publisher,
    trustClass: receipt.trustClass,
    actorId: receipt.actorId,
    outcome: receipt.outcome,
    errorCode: receipt.errorCode,
    createdAt: receipt.createdAt,
  }
}

async function readEmptyBody(c: { req: { header(name: string): string | undefined; text(): Promise<string> } }) {
  const declaredLength = Number(c.req.header('content-length') ?? '0')
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) return { ok: false as const, status: 413 as const }

  let raw: string
  try {
    raw = await c.req.text()
  } catch {
    return { ok: false as const, status: 400 as const }
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return { ok: false as const, status: 413 as const }
  return raw.length === 0 ? { ok: true as const } : { ok: false as const, status: 400 as const }
}

function mutationError(result: Extract<AddonMutationResult, { ok: false }>) {
  switch (result.reason) {
    case 'addon_not_registered':
      return { status: 404 as const, body: { error: result.reason } }
    case 'not_authorized':
      return { status: 403 as const, body: { error: 'forbidden', detail: 'owner/admin only' } }
    case 'invalid_state':
    case 'manifest_digest_drift':
    case 'operation_busy':
    case 'fence_lost':
      return { status: 409 as const, body: { error: result.reason, state: result.state ?? null } }
    case 'write_failed':
      return { status: 500 as const, body: { error: result.reason } }
  }
}

async function mutate(c: Context<AppEnv>, action: LifecycleAction) {
  const auth = c.get('auth')
  if (!isAdminPlus(auth)) return c.json({ error: 'forbidden', detail: 'owner/admin only' }, 403)

  const body = await readEmptyBody(c)
  if (!body.ok) return c.json({ error: body.status === 413 ? 'payload_too_large' : 'invalid_body' }, body.status)

  const key = c.req.param('key')
  if (!key) return c.json({ error: 'addon_not_registered' }, 404)
  const actor = { id: auth.userId, role: auth.role }
  const execute = {
    install: installAddon,
    configure: configureAddon,
    activate: activateAddon,
    disable: disableAddon,
    archive: archiveAddon,
  }[action]

  let result: AddonMutationResult
  try {
    result = await execute(c.env, actor, key)
  } catch {
    return c.json({ error: 'write_failed' }, 500)
  }
  if (!result.ok) {
    const error = mutationError(result)
    return c.json(error.body, error.status)
  }

  return c.json(
    { ok: true, key, state: result.state, ...(result.idempotent ? { idempotent: true } : {}) },
    action === 'install' && result.created ? 201 : 200,
  )
}

export const addonsApp = new Hono<AppEnv>()

addonsApp.use('*', csrf())
addonsApp.use('*', async (c, next) => {
  if (c.req.method === 'GET' || c.req.method === 'HEAD') return next()
  const cookie = c.req.header('cookie') ?? ''
  if (!/(?:^|;\s*)mupot_session=/.test(cookie)) return next()

  const sameOrigin = c.req.header('origin') === new URL(c.req.url).origin
    || c.req.header('sec-fetch-site') === 'same-origin'
  if (!sameOrigin) return c.text('Forbidden', 403)
  return next()
})
addonsApp.use('*', requireAuth)

addonsApp.get('/', async (c) => {
  if (!isAdminPlus(c.get('auth'))) return c.json({ error: 'forbidden', detail: 'owner/admin only' }, 403)

  try {
    const installations = latestInstallationsByKey(await listAddonInstallations(c.env))
    return c.json({ addons: listRegisteredAddons().map((entry) => catalogAddon(entry, installations.get(entry.manifest.key))) })
  } catch {
    return c.json({ error: 'read_failed' }, 500)
  }
})

addonsApp.post('/:key/install', (c) => mutate(c, 'install'))
addonsApp.post('/:key/configure', (c) => mutate(c, 'configure'))
addonsApp.post('/:key/activate', (c) => mutate(c, 'activate'))
addonsApp.post('/:key/disable', (c) => mutate(c, 'disable'))
addonsApp.post('/:key/archive', (c) => mutate(c, 'archive'))

addonsApp.get('/:key/receipts', async (c) => {
  if (!isAdminPlus(c.get('auth'))) return c.json({ error: 'forbidden', detail: 'owner/admin only' }, 403)

  if (!getRegisteredAddon(c.req.param('key'))) return c.json({ error: 'addon_not_registered' }, 404)
  try {
    const departmentStateSha256 = await getDepartmentStateSha256(c.env)
    const installation = latestInstallationsByKey(await listAddonInstallations(c.env)).get(c.req.param('key'))
    if (!installation) return c.json({ receipts: [], ownershipClaimCount: 0, departmentStateSha256 })
    return c.json({
      receipts: (await getAddonReceipts(c.env, installation.id)).map(redactedReceipt),
      ownershipClaimCount: await countAddonOwnershipClaims(c.env, installation.id),
      departmentStateSha256,
    })
  } catch {
    return c.json({ error: 'receipt_unavailable' }, 500)
  }
})
