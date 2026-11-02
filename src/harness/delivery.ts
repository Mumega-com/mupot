// src/harness/delivery.ts — did the work actually leave Mupot?
//
// A reservation row proves Mupot set work aside. It does not prove a worker ever saw it. Before
// this, `state: 'attached'` was the only thing a caller could read, and Grok's adapter produced it
// from a RECORD-ONLY dispatch that enqueues nothing (adapters/grok.ts:7-10) — so a recorded
// dispatch read as a delivery (mupot#2283).
//
// Four answers, deliberately about the work and not about the vendor:
//   reserved  — held by Mupot; nobody has been given it
//   delivered — it reached a worker's queue or a vendor accepted the run
//   claimed   — a worker took it, so the next fence is a lease, not a delivery
//   unknown   — we cannot prove either way; used instead of guessing, because a wrong `reserved`
//               hides work that did go out and a wrong `delivered` claims work that did not
//
// Review round 2 (mupot#2283): the previous allowlist knew only the statuses I happened to write,
// not the ones the vendor writers actually emit. Cursor's own vocabulary (src/cursor/client.ts:14-22)
// is CREATING | RUNNING | FINISHED | ERROR | CANCELLED | EXPIRED, so a replayed CREATING run and a
// polled FINISHED run both fell through to `reserved` — a vendor-accepted execution becoming
// apparently unhanded work.

import type { AttemptLabels, HarnessDeliveryState, HarnessDispatchState, HarnessKind } from './types'

/**
 * The vendor has the run. Every one of these means an execution exists at the vendor, so the work
 * left Mupot: CREATING is the launch being materialised, the rest are its lifecycle and terminals.
 * Unknown strings are NOT added here — they go to `unknown` instead.
 */
const DELIVERED_VENDOR_STATUSES: ReadonlySet<string> = new Set([
  // Cursor's documented run lifecycle (src/cursor/client.ts:14-22).
  'creating',
  'running',
  'finished',
  'error',
  'cancelled',
  'expired',
  // Generic words other vendors and our own attach path use for "it is out there".
  'delivered',
  'sent',
  'queued',
  'accepted',
  'started',
])

/** A worker has taken the work; a lease (not a delivery) is the fence from here. */
const CLAIMED_VENDOR_STATUSES: ReadonlySet<string> = new Set(['claimed', 'leased', 'in_progress'])

/** A record-only dispatch writes this. It is an audit note, not a handover. */
const RECORD_ONLY_STATUS = 'recorded'

/**
 * The single place that decides delivery. Adapters must not each invent this: the conformance
 * suite exists to prove they all answer the same question the same way.
 */
export function deliveryStateOf(row: {
  state: HarnessDispatchState | string
  last_vendor_status?: string | null
}): HarnessDeliveryState {
  const status = (row.last_vendor_status ?? '').trim().toLowerCase()
  switch (row.state) {
    case 'attached':
      if (!status || status === RECORD_ONLY_STATUS) return 'reserved'
      if (CLAIMED_VENDOR_STATUSES.has(status)) return 'claimed'
      if (DELIVERED_VENDOR_STATUSES.has(status)) return 'delivered'
      // A status we do not know is not evidence of delivery, and not evidence of absence either.
      return 'unknown'
    case 'reconciled':
    case 'failed':
      // Terminal reservation states still say what happened to the work: a run the vendor accepted
      // was delivered even if it later failed; a reservation that never left Mupot was not.
      if (CLAIMED_VENDOR_STATUSES.has(status)) return 'claimed'
      if (DELIVERED_VENDOR_STATUSES.has(status)) return 'delivered'
      if (!status || status === RECORD_ONLY_STATUS) return 'reserved'
      return 'unknown'
    default:
      return 'reserved'
  }
}

/**
 * Labels describe an attempt; they never authorise one. Exported so tests can assert that nothing
 * in the delivery path reads them: the same row with different labels must answer identically.
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
