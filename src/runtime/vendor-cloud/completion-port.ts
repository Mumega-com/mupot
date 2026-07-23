// Pluggable completion port — topology C must NOT hardcode webhook-only
// completion. Cursor Background Agents have HMAC webhooks; Claude Managed
// Agents are poll/SSE only.

import type { CompletionEvent, CompletionKind, LandAtReviewIntent, VendorKind } from './types'

export interface CompletionPort {
  readonly kind: CompletionKind
  readonly vendor: VendorKind
}

export interface WebhookCompletionPort extends CompletionPort {
  readonly kind: 'webhook'
  /** Shared HMAC secret (Cursor X-Webhook-Signature). */
  readonly secret: string
}

export interface PollSseCompletionPort extends CompletionPort {
  readonly kind: 'poll_sse'
  readonly pollIntervalMs: number
  readonly timeoutMs: number
}

export type AnyCompletionPort = WebhookCompletionPort | PollSseCompletionPort

export function createWebhookCompletionPort(
  vendor: VendorKind,
  secret: string,
): WebhookCompletionPort {
  if (!secret) {
    throw new Error('webhook_completion_secret_required')
  }
  if (vendor !== 'cursor-background') {
    throw new Error('webhook_completion_only_for_cursor_background')
  }
  return { kind: 'webhook', vendor, secret }
}

export function createPollSseCompletionPort(
  vendor: VendorKind,
  pollIntervalMs: number,
  timeoutMs: number,
): PollSseCompletionPort {
  if (pollIntervalMs <= 0) {
    throw new Error('poll_interval_must_be_positive')
  }
  if (timeoutMs <= 0) {
    throw new Error('poll_timeout_must_be_positive')
  }
  return { kind: 'poll_sse', vendor, pollIntervalMs, timeoutMs }
}

/** Select the completion port for a vendor. CMA forces poll/SSE. */
export function selectCompletionPort(
  vendor: VendorKind,
  webhookSecret: string | null,
  pollIntervalMs: number,
  timeoutMs: number,
): AnyCompletionPort {
  if (vendor === 'claude-managed') {
    return createPollSseCompletionPort(vendor, pollIntervalMs, timeoutMs)
  }
  if (webhookSecret !== null && webhookSecret.length > 0) {
    return createWebhookCompletionPort(vendor, webhookSecret)
  }
  return createPollSseCompletionPort(vendor, pollIntervalMs, timeoutMs)
}

export function landAtReviewIntent(
  event: CompletionEvent,
  gateOwner: string,
): LandAtReviewIntent {
  if (!gateOwner) {
    throw new Error('gate_owner_required')
  }
  return {
    status: 'review',
    gateOwner,
    vendorRunId: event.vendorRunId,
    branchName: event.branchName,
    prUrl: event.prUrl,
    summary: event.summary,
    forbidden: ['merge', 'deploy', 'publish', 'self_verdict'],
  }
}
