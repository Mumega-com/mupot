// mupot — add-on event dispatch (notify kernel slice 1). The bus consumer calls dispatchAddonEvent() for events that
// add-ons may subscribe to. Delivery is to ACTIVE installations only, and only along a path the manifest's trust class
// allows. There is no outbound transport for external add-ons here: they stay on EXTERNAL_ADDON_EVENT_ALLOWLIST and
// receive nothing from this dispatcher.
import type { Env, BusEvent } from '../types'
import type { AddonManifestV1 } from './contract'
import { getRegisteredAddon } from './registry'
import { EXTERNAL_ADDON_EVENT_ALLOWLIST } from './service'
import { safeConsole } from '../lib/log'

export type NativeAddonEventHandler = (env: Env, event: BusEvent) => Promise<void>

/** Native handlers by addon key. mupot-notify is a seat only in slice 1: delivery still happens in the consumer. */
export const NATIVE_ADDON_EVENT_HANDLERS: Readonly<Record<string, NativeAddonEventHandler>> = {
  'mupot-notify': async () => {},
}

/** Pure: may this manifest receive this event type through the dispatcher? */
export function addonMayReceive(manifest: Pick<AddonManifestV1, 'trustClass' | 'eventSubscriptions'>, eventType: string): boolean {
  if (!manifest.eventSubscriptions.includes(eventType)) return false
  if (manifest.trustClass === 'native_reviewed') return true
  return EXTERNAL_ADDON_EVENT_ALLOWLIST.has(eventType)
}

export interface DispatchOptions {
  handlers?: Readonly<Record<string, NativeAddonEventHandler>>
  lookup?: (key: string) => { manifest: AddonManifestV1 } | undefined
}

/** Returns the addon keys the event was handed to. Handler errors are contained per add-on. */
export async function dispatchAddonEvent(env: Env, event: BusEvent, opts: DispatchOptions = {}): Promise<string[]> {
  const handlers = opts.handlers ?? NATIVE_ADDON_EVENT_HANDLERS
  const lookup = opts.lookup ?? getRegisteredAddon
  const rows = await env.DB.prepare(
    `SELECT addon_key FROM addon_installations WHERE tenant = ?1 AND state = 'active'`,
  ).bind(event.tenant).all<{ addon_key: string }>()
  const delivered: string[] = []
  for (const { addon_key } of rows.results ?? []) {
    const entry = lookup(addon_key)
    if (!entry || !addonMayReceive(entry.manifest, event.type)) continue
    const handler = handlers[addon_key]
    if (!handler) continue
    try {
      await handler(env, event)
      delivered.push(addon_key)
    } catch (err) {
      safeConsole.error('addon event handler failed', addon_key, String(err).slice(0, 200))
    }
  }
  return delivered
}
