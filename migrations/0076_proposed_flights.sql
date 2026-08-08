-- 0076_proposed_flights.sql — gate state for external origins (Phase 2).
--
-- Extends flight record to support external workflow triggers (Linear, PostHog).
-- A flight created from an external webhook lands with gate_state='proposed':
-- visible/auditable on the origin system but NOT dispatchable until explicit
-- mupot-side gate/approval moves it to gate_state='approved'.
--
-- gate_state values:
--   'open'     (default) — normal flight, no approval gate. Existing flights.
--   'proposed' — external origin (Linear, PostHog, etc.). Requires approval.
--   'approved' — proposed flight has been approved by mupot-side gate. Ready for dispatch.
--
-- Dispatch guard: dispatchFlight() must check gate_state != 'proposed' and reject.
-- Webhook cannot create flights with gate_state != 'proposed'.

ALTER TABLE flights ADD COLUMN IF NOT EXISTS gate_state TEXT NOT NULL DEFAULT 'open'
  CHECK (gate_state IN ('open','proposed','approved'));

CREATE INDEX IF NOT EXISTS idx_flights_gate_state ON flights(tenant, gate_state);
