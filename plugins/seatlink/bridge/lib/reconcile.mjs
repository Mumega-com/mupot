// bridge/lib/reconcile.mjs — reconcile a stale local delivery queue against the pot's CURRENT
// ack state before finally delivering it.
//
// THE DEFECT THIS CLOSES (mumega-com#1179, measured 2026-09-02/03 on host muvps)
//
// seatlink.mjs defers a mupot message when the target Herdr seat is busy (working/blocked):
// it queues the already-fetched message object in an in-memory Map and returns without
// delivering. The queue drains later, unconditionally, when the seat goes idle
// (`pane.agent_status_changed` -> idle/done). Between defer-time and drain-time the seat can
// consume that SAME message through a completely different channel — a direct `inbox`/
// `inbox_ack` MCP call made mid-turn, or the Stop hook running between turns — and the
// deferred queue has no way to learn that happened. Drain then re-offers already-settled mail,
// with wording ("handle it now ... send the required ACK") that pushes the reader to re-act on
// work that is already done.
//
// This was measured (mumega-com#1179 issue comments) and one candidate mechanism was RULED
// OUT by an independent test against the real mupot schema: a fresh SSE reconnect with a
// stale/lagging `since` cursor does NOT re-surface an already-acked row, because
// readAgentInboxForReader's `read_at IS NULL` predicate excludes it from every query
// regardless of `since` (see the mupot repo, branch
// kasra/ack-terminal-marker-and-seatlink-ack-reconcile, tests/ack-terminal-marker.test.ts
// sibling investigation notes). The deferred-queue path above is the one place in this bridge
// that genuinely holds a snapshot across an unbounded amount of elapsed time without ever
// re-checking it — that is the gap this module closes.
//
// POLICY: fail OPEN, not closed.
//
// Dropping a message that is still genuinely unread would be silent message loss — worse than
// the false-work this fix exists to remove. Delivering a message that turns out to already be
// consumed is, at worst, one more instance of the exact symptom under repair, not a new
// failure mode. So any error while fetching current unread state is treated as "assume
// everything queued is still unread" (deliver as before), never as "assume everything is
// settled" (drop everything). This module has no I/O of its own; the caller supplies
// `fetchUnreadIds` and this module makes no assumption about how it fails or why.

/**
 * @param {{id: string}[]} candidates
 * @param {Set<string>} unreadIds
 * @returns {{id: string}[]} the subset of candidates whose id is present in unreadIds
 */
export function filterStillUnread(candidates, unreadIds) {
  if (!Array.isArray(candidates) || !(unreadIds instanceof Set)) return []
  return candidates.filter((m) => m != null && typeof m.id === 'string' && unreadIds.has(m.id))
}

/**
 * Re-validate a batch of previously-fetched (possibly stale) messages against the pot's
 * CURRENT unread state before delivering them.
 *
 * @param {{id: string}[]} candidates
 * @param {() => Promise<Set<string>>} fetchUnreadIds
 * @param {(msg: object) => void} [onStale] called once per candidate dropped as already-settled
 * @returns {Promise<{id: string}[]>} the candidates still safe to deliver
 */
export async function reconcileBeforeDeliver(candidates, fetchUnreadIds, onStale) {
  if (!Array.isArray(candidates) || candidates.length === 0) return []
  let unreadResult
  try {
    unreadResult = await fetchUnreadIds()
  } catch {
    return candidates // fail open — see module docstring
  }

  // Completeness check: a partial set must NEVER be used to declare a message settled.
  // ONLY an object explicitly providing { ids: Set<string>, complete: true } is authorized to drop.
  // A bare Set cannot carry completeness, so it fails open alongside null/non-objects (mumega-com#1179).
  if (!unreadResult || !(unreadResult.ids instanceof Set) || unreadResult.complete !== true) {
    return candidates // fail open — cannot prove this set is whole
  }

  const unreadIds = unreadResult.ids
  const kept = filterStillUnread(candidates, unreadIds)
  if (onStale && kept.length !== candidates.length) {
    const keptIds = new Set(kept.map((m) => m.id))
    for (const candidate of candidates) {
      if (!keptIds.has(candidate.id)) onStale(candidate)
    }
  }
  return kept
}
