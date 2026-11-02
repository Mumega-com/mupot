// src/harness/delivery.ts — did the work actually leave Mupot?
//
// A reservation row proves Mupot set work aside. It does not prove a worker ever saw it. Before
// this, `state: 'attached'` was the only thing a caller could read, and Grok's adapter produced it
// from a RECORD-ONLY dispatch that enqueues nothing (adapters/grok.ts:7-10) — so a recorded
// dispatch read as a delivery (mupot#2283).
//
// The three states are deliberately about the work, not about the vendor:
//   reserved  — held by Mupot; nobody has been given it
//   delivered — it reached a queue (an inbox row, or a vendor that accepted the run)
//   claimed   — a worker took it, so the next fence is a lease, not a delivery

import type { AttemptLabels, HarnessDeliveryState, HarnessDispatchState, HarnessKind } from './types'

/**
 * Vendor statuses that mean the work reached a worker. Anything unrecognised stays `reserved`:
 * an unknown string is not evidence of delivery, and guessing here is how the original bug read
 * a record-only dispatch as attached.
 */
const DELIVERED_VENDOR_STATUSES: ReadonlySet<string> = new Set([
  'delivered',
  'sent',
  'queued',
  'accepted',
  'started',
  'running',
  'in_progress',
])

/** A worker has taken the work; a lease (not a delivery) is the fence from here. */
const CLAIMED_VENDOR_STATUSES: ReadonlySet<string> = new Set(['claimed', 'leased', 'in_progress'])

/**
 * The single place that decides delivery. Adapters must not each invent this: the whole point of
 * the conformance slice is that Codex, Claude and Grok answer the same question the same way.
 */
export function deliveryStateOf(row: {
  state: HarnessDispatchState | string
  last_vendor_status?: string | null
}): HarnessDeliveryState {
  const status = (row.last_vendor_status ?? '').trim().toLowerCase()
  switch (row.state) {
    case 'attached':
      // `recorded` is what a record-only dispatch writes. It is an audit note, not a handover.
      if (!status || status === 'recorded') return 'reserved'
      if (CLAIMED_VENDOR_STATUSES.has(status)) return 'claimed'
      if (DELIVERED_VENDOR_STATUSES.has(status)) return 'delivered'
      return 'reserved'
    case 'reconciled':
    case 'failed':
      // Terminal vendor states still say what happened to the work: a reconciled run that the
      // vendor accepted was delivered; a failed reservation never left Mupot.
      if (CLAIMED_VENDOR_STATUSES.has(status)) return 'claimed'
      if (DELIVERED_VENDOR_STATUSES.has(status)) return 'delivered'
      return 'reserved'
    default:
      return 'reserved'
  }
}

/**
 * Labels describe an attempt; they never authorise one. Exported so tests can assert that nothing
 * in the delivery path reads them: the same request with different labels must produce the same
 * outcome.
 */
export function attemptLabels(input: {
  harness: HarnessKind
  model?: string | null
  host?: string | null
}): AttemptLabels {
  return {
    harness: input.harness,
    model: input.model?.trim() || null,
    host: input.host?.trim() || null,
  }
}
