import { beforeEach } from 'vitest'
import { resetPresenceThrottle } from '../../src/fleet/registry'

// The 60s presence throttle is per-isolate module state; tests in one file share the isolate, so
// a touch in one test would silently skip the touch the next test asserts. Every test starts cold.
beforeEach(() => {
  resetPresenceThrottle()
})
