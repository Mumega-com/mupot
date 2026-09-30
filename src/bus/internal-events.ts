// src/bus/internal-events.ts — bus event types that ONLY the queue consumer may enqueue.
//
// `mcp.event.delivery` (mupot#1618) is a delivery-attempt job. Every producer that forwards a
// caller-chosen `type` onto the queue (createBus().emit, the sos addon's /publish and /bridge, the
// /bus/emit route's allowlist) must refuse it, and the consumer additionally rebuilds every fact of
// the delivery from D1 (src/bus/events-delivery.ts) — the queue is not a trust boundary.

export const INTERNAL_ONLY_EVENT_TYPES: ReadonlySet<string> = new Set(['mcp.event.delivery'])

export function isInternalOnlyEventType(type: unknown): boolean {
  return typeof type === 'string' && INTERNAL_ONLY_EVENT_TYPES.has(type)
}
