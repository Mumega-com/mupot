import type { ActionClass, Channel, Severity } from './carry'

/** The pseudo-recipient for the owner's configured Telegram chat (TELEGRAM_CHAT_ID). Member-id -> chat mapping is slice 2. */
export const OWNER_RECIPIENT = 'owner'

/** A member id, OWNER_RECIPIENT, or a gate reference written 'gate:<ref>'. */
export type Recipient = string

/** The only free-form fields an event may carry for rendering. There is deliberately no raw-payload field. */
export interface NotifyContext {
  title?: string
  message?: string
  task_id?: string
  squad_id?: string
  agent_id?: string
  project_id?: string
}

export interface NotifyEvent {
  tenant: string
  type: string
  severity: Severity
  subject_ref: string
  recipients: Recipient[]
  dedupe_key: string
  action_class?: ActionClass
  context?: NotifyContext
}

export type DeliveryStatus = 'sent' | 'edited' | 'acked' | 'failed' | 'capped'

export interface DeliveryOutcome {
  status: DeliveryStatus
  external_ref?: string | null
  error_code?: string | null
}

export interface NotifyDelivery {
  recipient: Recipient
  channel: Channel
  status: DeliveryStatus
  error_code?: string
}

export interface NotifyResult {
  event_id: string | null
  deliveries: NotifyDelivery[]
  /** Recipients dropped by the dedupe window. */
  deduped: Recipient[]
  /** Recipients whose push channels were held back by the rate cap (dashboard still recorded). */
  rate_capped: Recipient[]
}

/** True if any delivery on `channel` went out. */
export function wasDelivered(result: NotifyResult, channel: Channel): boolean {
  return result.deliveries.some((d) => d.channel === channel && d.status === 'sent')
}
