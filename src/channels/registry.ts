// mupot — channel adapter registry (the microkernel's ONLY knowledge of which
// platforms exist). The core depends on the ChannelAdapter INTERFACE; this map
// is the single seam where leaf adapters are bound to their platform key.
//
// MICROKERNEL RULE: adding a platform = ONE entry here + ONE adapter file. No
// other core file changes. The core never imports a concrete platform anywhere
// else — only this registry does, and only to populate the map.
//
// Each adapter file exports a single const (discordAdapter / googleChatAdapter /
// telegramAdapter) implementing ChannelAdapter; the standardized contract every
// part codes to.

import type { ChannelAdapter } from '../types'
import { discordAdapter } from './adapters/discord'
import { googleChatAdapter } from './adapters/google-chat'
import { telegramAdapter } from './adapters/telegram'

// The registry: platform key → adapter. Keyed by the adapter's own `platform`
// string so a binding row's `platform` column resolves directly. The keys here
// MUST match channel_bindings.platform / member_identities.platform values
// ('discord' | 'google-chat' | 'telegram').
export const ADAPTERS: Record<string, ChannelAdapter> = {
  [discordAdapter.platform]: discordAdapter,
  [googleChatAdapter.platform]: googleChatAdapter,
  [telegramAdapter.platform]: telegramAdapter,
}

/**
 * getAdapter — resolve a platform key to its leaf adapter, or null for an
 * unknown platform. Fail-closed: the core treats null as "no such platform"
 * (503/404), never as a default adapter.
 */
export function getAdapter(platform: string): ChannelAdapter | null {
  return ADAPTERS[platform] ?? null
}
