// mupot — notify kernel adapters. Each wraps an EXISTING sender without changing it.
import type { Env } from '../types'
import { notifyHadi } from '../telegram-bridge/bus_notify'
import { redactSecretPatterns } from '../lib/redact'
import { safeConsole } from '../lib/log'
import type { Channel } from './carry'
import { OWNER_RECIPIENT, type DeliveryOutcome, type NotifyContext, type NotifyEvent, type Recipient } from './types'

export interface ChannelAdapter {
  channel: Channel
  deliver(env: Env, event: NotifyEvent, recipient: Recipient): Promise<DeliveryOutcome>
}

const FIELD_MAX = 500

/** Redact secret-shaped text and bound its length. Rendered notification text goes through here and nowhere else. */
export function safeField(value: unknown): string | undefined {
  // Bus payloads are untyped: execute.ts emits project_id: null for a task with no project. null/undefined are absent.
  if (value === null || value === undefined) return undefined
  return redactSecretPatterns(typeof value === 'string' ? value : String(value)).slice(0, FIELD_MAX)
}

export function renderContext(ctx: NotifyContext | undefined): NotifyContext {
  return {
    title: safeField(ctx?.title),
    message: safeField(ctx?.message),
    task_id: safeField(ctx?.task_id),
    squad_id: safeField(ctx?.squad_id),
    agent_id: safeField(ctx?.agent_id),
    project_id: safeField(ctx?.project_id),
  }
}

/** The dashboard pulls (needs_you reads its own tables), so delivery is just the recorded row. */
export const dashboardAdapter: ChannelAdapter = {
  channel: 'dashboard',
  async deliver() {
    return { status: 'sent' }
  },
}

/** Wraps notifyHadi. Only the owner pseudo-recipient has a chat in slice 1. */
export const telegramAdapter: ChannelAdapter = {
  channel: 'telegram_dm',
  async deliver(env, event, recipient) {
    if (recipient !== OWNER_RECIPIENT) return { status: 'failed', error_code: 'no_chat_for_recipient' }
    try {
      const r = await notifyHadi(env, { type: event.type, ...renderContext(event.context) })
      return r.delivered ? { status: 'sent' } : { status: 'failed', error_code: 'send_failed' }
    } catch (err) {
      safeConsole.error('notify: telegram adapter threw', redactSecretPatterns(String(err)).slice(0, 200))
      return { status: 'failed', error_code: 'adapter_threw' }
    }
  },
}

export const DEFAULT_ADAPTERS: readonly ChannelAdapter[] = [dashboardAdapter, telegramAdapter]
