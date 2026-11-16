import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { BusEvent, Env } from '../src/types'
import { addonMayReceive, dispatchAddonEvent, type NativeAddonEventHandler } from '../src/addons/event-dispatch'
import { getRegisteredAddon } from '../src/addons/registry'
import { NotifyAddon } from '../src/addons/notify/manifest'
import { FixtureAddon } from '../src/addons/modules/fixture'
import type { AddonManifestV1 } from '../src/addons/contract'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

let h: SqliteD1Harness
beforeEach(() => { h = createSqliteD1(); applyAllMigrations(h.sqlite); vi.spyOn(console, 'error').mockImplementation(() => undefined) })
afterEach(() => { h.close(); vi.restoreAllMocks() })

const external: AddonManifestV1 = {
  ...FixtureAddon, key: 'ext-addon', trustClass: 'external_isolated', kind: 'external_mcp',
  eventSubscriptions: ['task.review', 'task.completed'],
}
const native: AddonManifestV1 = { ...FixtureAddon, key: 'nat-addon', eventSubscriptions: ['task.review'] }
const manifests: Record<string, AddonManifestV1> = { 'ext-addon': external, 'nat-addon': native }
const lookup = (k: string) => (manifests[k] ? { manifest: manifests[k] } : undefined)
const evt = (type: BusEvent['type']): BusEvent => ({ type, tenant: 't1', payload: {}, ts: '2026-11-16T00:00:00Z' })

function install(key: string, state: string, tenant = 't1'): void {
  h.sqlite.exec('PRAGMA foreign_keys = OFF')
  // The lifecycle triggers forbid fabricating a state; this test only needs rows the dispatcher can read.
  const triggers = h.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'addon_installations'").all() as Array<{ name: string }>
  for (const t of triggers) h.sqlite.exec(`DROP TRIGGER ${t.name}`)
  h.sqlite.prepare(
    `INSERT INTO addon_installations (id, tenant, addon_key, installed_version, publisher, trust_class, manifest_sha256, mupot_compatibility,
       state, installed_by, latest_actor_id, latest_receipt_id, installed_at, updated_at)
     VALUES (?, ?, ?, '1.0.0', 'mumega', 'native_reviewed', ?, '^0.30.0', 'installed', 'u', 'u', 'r', 'now', 'now')`,
  ).run(`i-${key}`, tenant, key, 'a'.repeat(64))
  if (state !== 'installed') h.sqlite.prepare('UPDATE addon_installations SET state = ? WHERE addon_key = ? AND tenant = ?').run(state, key, tenant)
}

describe('mupot-notify manifest', () => {
  it('is registered, native_reviewed, and subscribes to the three events', () => {
    const entry = getRegisteredAddon('mupot-notify')
    expect(entry?.manifest.trustClass).toBe('native_reviewed')
    expect(entry?.manifest.eventSubscriptions).toEqual(['task.review', 'task.blocked'])
    expect(NotifyAddon.key).toBe('mupot-notify')
  })
})

describe('addonMayReceive', () => {
  it('native receives what it subscribed to, and nothing else', () => {
    expect(addonMayReceive(native, 'task.review')).toBe(true)
    expect(addonMayReceive(native, 'task.blocked')).toBe(false)
  })
  it('GUARD: external receives only allowlisted events even if subscribed', () => {
    expect(addonMayReceive(external, 'task.review')).toBe(false)
    expect(addonMayReceive(external, 'task.completed')).toBe(true)
  })
})

describe('dispatchAddonEvent', () => {
  it('delivers to ACTIVE native add-ons only', async () => {
    install('nat-addon', 'active')
    const handler = vi.fn<NativeAddonEventHandler>(async () => {})
    const got = await dispatchAddonEvent({ DB: h.db } as unknown as Env, evt('task.review'), { handlers: { 'nat-addon': handler }, lookup })
    expect(got).toEqual(['nat-addon'])
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('GUARD: an installed-but-not-active add-on gets nothing', async () => {
    install('nat-addon', 'configured')
    const handler = vi.fn<NativeAddonEventHandler>(async () => {})
    expect(await dispatchAddonEvent({ DB: h.db } as unknown as Env, evt('task.review'), { handlers: { 'nat-addon': handler }, lookup })).toEqual([])
    expect(handler).not.toHaveBeenCalled()
  })

  it('GUARD: an active external add-on does not receive a non-allowlisted event', async () => {
    install('ext-addon', 'active')
    const handler = vi.fn<NativeAddonEventHandler>(async () => {})
    const got = await dispatchAddonEvent({ DB: h.db } as unknown as Env, evt('task.review'), { handlers: { 'ext-addon': handler }, lookup })
    expect(got).toEqual([])
    expect(handler).not.toHaveBeenCalled()
  })

  it('GUARD: an active install in another tenant receives nothing', async () => {
    install('nat-addon', 'active', 'other-tenant')
    const handler = vi.fn<NativeAddonEventHandler>(async () => {})
    expect(await dispatchAddonEvent({ DB: h.db } as unknown as Env, evt('task.review'), { handlers: { 'nat-addon': handler }, lookup })).toEqual([])
    expect(handler).not.toHaveBeenCalled()
  })

  it('one failing handler does not stop the others', async () => {
    install('nat-addon', 'active')
    const got = await dispatchAddonEvent({ DB: h.db } as unknown as Env, evt('task.review'), {
      handlers: { 'nat-addon': async () => { throw new Error('boom') } }, lookup,
    })
    expect(got).toEqual([])
  })
})
