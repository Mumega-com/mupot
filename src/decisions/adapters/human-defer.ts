// The DEFAULT adapter. Always defers to a human; sends nothing anywhere. Shipping the
// decision port with this default changes no behaviour.
import type { DecisionAdapter } from '../port'

export const humanDeferAdapter: DecisionAdapter = {
  id: 'human',
  // Nothing leaves the process, so any data class is acceptable to *this* adapter.
  dataPolicy: { maxDataClass: 'regulated', residency: 'none', retention: 'none' },
  async decide() {
    return { ok: false, reason: 'deferred_to_human' }
  },
}
