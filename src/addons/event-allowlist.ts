// The only event topics an external addon may subscribe to. Deliberately narrow and
// hand-enumerated (not "whatever the bus happens to define today") — widening this set
// is a review-worthy decision, not a side effect of adding an unrelated event elsewhere.
export const EXTERNAL_ADDON_EVENT_ALLOWLIST: ReadonlySet<string> = new Set([
  'task.completed',
  'message.created',
])
