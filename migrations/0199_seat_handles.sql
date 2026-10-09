-- 0199_seat_handles.sql — mupot#1794 W2: seat handles (a selected seat authenticates AS its agent).
--
-- seat_select (W1) resolves a (human, harness, workspace) key to ONE agent. W2 lets a later
-- request ACT as that agent by presenting an opaque SEAT HANDLE (header X-Mupot-Seat or
-- _meta["mupot/seat"]) alongside the human's ordinary OAuth grant. The handle is a SELECTOR, never a
-- credential on its own: it only resolves while the human's directory grant (grant_token_id) is
-- still live, still unbound, still on the same harness, and still held by the same member.
--
-- Only sha256(handle) is stored (32 random bytes, base64url, never persisted raw). The row pins
-- WHO may use it (consenting member + the exact grant token + harness), so another human's grant,
-- another harness of the same human, or a re-consented grant never matches.
--
-- Behind SEAT_AUTO_ENROLL (unset in prod): with the flag off no code writes or reads this table.
-- Additive migration; nothing existing references it.
CREATE TABLE IF NOT EXISTS seat_handles (
  id                   TEXT PRIMARY KEY,
  tenant               TEXT NOT NULL,
  handle_hash          TEXT NOT NULL CHECK (length(handle_hash) = 64),
  seat_id              TEXT NOT NULL REFERENCES agent_seats(id) ON DELETE RESTRICT,
  agent_id             TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  harness_id           TEXT NOT NULL REFERENCES harnesses(id) ON DELETE RESTRICT,
  consenting_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  grant_token_id       TEXT NOT NULL CHECK (length(grant_token_id) BETWEEN 1 AND 128),
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at         TEXT,
  revoked_at           TEXT,
  UNIQUE (tenant, handle_hash)
);

CREATE INDEX IF NOT EXISTS idx_seat_handles_seat_live ON seat_handles (seat_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_seat_handles_agent ON seat_handles (agent_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_seat_handles_member ON seat_handles (consenting_member_id, revoked_at);

-- Per-seat live-handle cap, enforced inside the same statement/batch as the insert (a BEFORE INSERT
-- trigger raises, so a capped insert rolls back whatever batch carried it). seat_select evicts the
-- least-recently-used live handle first, so the cap bounds growth without ever locking a seat out.
CREATE TRIGGER IF NOT EXISTS seat_handles_cap_insert
BEFORE INSERT ON seat_handles
FOR EACH ROW
WHEN NEW.revoked_at IS NULL
 AND (SELECT COUNT(*) FROM seat_handles h WHERE h.seat_id = NEW.seat_id AND h.revoked_at IS NULL) >= 32
BEGIN
  SELECT RAISE(ABORT, 'seat_handle_cap_exceeded');
END;

-- A handle row is an identity record: who/what it points at never changes. revoked_at moves
-- NULL -> value once and never back; last_used_at is the only free column.
CREATE TRIGGER IF NOT EXISTS seat_handles_immutable
BEFORE UPDATE ON seat_handles
FOR EACH ROW
WHEN NEW.id IS NOT OLD.id
  OR NEW.tenant IS NOT OLD.tenant
  OR NEW.handle_hash IS NOT OLD.handle_hash
  OR NEW.seat_id IS NOT OLD.seat_id
  OR NEW.agent_id IS NOT OLD.agent_id
  OR NEW.harness_id IS NOT OLD.harness_id
  OR NEW.consenting_member_id IS NOT OLD.consenting_member_id
  OR NEW.grant_token_id IS NOT OLD.grant_token_id
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
BEGIN
  SELECT RAISE(ABORT, 'seat_handle_immutable');
END;

CREATE TRIGGER IF NOT EXISTS seat_handles_no_delete
BEFORE DELETE ON seat_handles
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'seat_handle_immutable');
END;

-- Revocation reach. Done as triggers (not per-tool sweeps) so EVERY path that takes an identity
-- out of service — deactivate_agent, archive_row, a seat retire, a direct admin UPDATE — revokes
-- its handles atomically in the same statement/batch, with no code path able to forget.
--   * agent leaves 'active'/'paused' (deactivate_agent flips it to 'inactive')  -> its handles die
--   * a member leaves 'active' (archive_row suspends it): handles it consented, AND handles of any
--     agent that member is the dedicated identity of
--   * a seat is retired
-- ('paused' is deliberately not terminal: the resolver already refuses a non-active agent while
-- paused, and un-pausing restores the seat; revoking on pause would be heavier than the pause.)
CREATE TRIGGER IF NOT EXISTS seat_handles_revoke_on_agent_end
AFTER UPDATE OF status ON agents
FOR EACH ROW
WHEN NEW.status NOT IN ('active', 'paused')
BEGIN
  UPDATE seat_handles SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE agent_id = NEW.id AND revoked_at IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS seat_handles_revoke_on_member_end
AFTER UPDATE OF status ON members
FOR EACH ROW
WHEN NEW.status <> 'active'
BEGIN
  UPDATE seat_handles SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE revoked_at IS NULL
     AND (consenting_member_id = NEW.id
          OR agent_id IN (SELECT b.agent_id FROM agent_member_bindings b WHERE b.member_id = NEW.id));
END;

CREATE TRIGGER IF NOT EXISTS seat_handles_revoke_on_seat_retire
AFTER UPDATE OF retired_at ON agent_seats
FOR EACH ROW
WHEN NEW.retired_at IS NOT NULL AND OLD.retired_at IS NULL
BEGIN
  UPDATE seat_handles SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE seat_id = NEW.id AND revoked_at IS NULL;
END;

-- ── Lifetime seat-creation bound per member (W1 round-2 gate, P2) ──────────────────────────────
-- agent_seats_cap_insert (0198) counts only LIVE seats, so deactivate + re-create in a loop frees a
-- slot each cycle and every cycle writes an agent + member + binding + token + audit row (home-kind
-- agents are plan-exempt). The only other bound is the per-member KV throttle, which is fail-open
-- and not atomic. This adds an ATOMIC, FAIL-CLOSED bound that counts EVERY agent_seats row of the
-- member, retired or not: the trigger raises inside the creating batch, so the whole batch (agent,
-- member, binding, token, audit, seat) rolls back and 10 concurrent creators at the boundary yield
-- exactly one success. The KV throttle stays on top as a soft layer.
-- max_total is the cap IN FORCE when the row was issued (env-derived by seat_select, never from the
-- caller); DEFAULT 64 only covers a raw insert that omits it.
ALTER TABLE agent_seats ADD COLUMN max_total INTEGER NOT NULL DEFAULT 64 CHECK (max_total BETWEEN 1 AND 4096);

CREATE TRIGGER IF NOT EXISTS agent_seats_total_cap_insert
BEFORE INSERT ON agent_seats
FOR EACH ROW
WHEN (SELECT COUNT(*) FROM agent_seats s
       WHERE s.tenant = NEW.tenant AND s.member_id = NEW.member_id) >= NEW.max_total
BEGIN
  SELECT RAISE(ABORT, 'seat_total_cap_exceeded');
END;

-- Replace the W1 immutability trigger so the new column is part of the identity record too.
DROP TRIGGER IF EXISTS agent_seats_immutable;
CREATE TRIGGER agent_seats_immutable
BEFORE UPDATE ON agent_seats
FOR EACH ROW
WHEN NEW.id IS NOT OLD.id
  OR NEW.tenant IS NOT OLD.tenant
  OR NEW.member_id IS NOT OLD.member_id
  OR NEW.harness_id IS NOT OLD.harness_id
  OR NEW.key_hash IS NOT OLD.key_hash
  OR NEW.agent_id IS NOT OLD.agent_id
  OR NEW.label_basename IS NOT OLD.label_basename
  OR NEW.max_live IS NOT OLD.max_live
  OR NEW.max_total IS NOT OLD.max_total
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS NOT OLD.retired_at)
BEGIN
  SELECT RAISE(ABORT, 'agent_seat_immutable');
END;

-- ── Live-seat cap counts 'paused' too (W1 round-2 gate, P3) ─────────────────────────────────────
-- 0198's agent_seats_cap_insert counted only status = 'active', so pausing a seat agent freed a slot
-- and resuming it exceeded the cap. A seat is live while its agent is 'active' OR 'paused'; only
-- 'inactive' (deactivate_agent) or a retired seat frees a slot. Replaces the 0198 trigger.
DROP TRIGGER IF EXISTS agent_seats_cap_insert;
CREATE TRIGGER agent_seats_cap_insert
BEFORE INSERT ON agent_seats
FOR EACH ROW
WHEN NEW.retired_at IS NULL
 AND (SELECT COUNT(*) FROM agent_seats s
       JOIN agents a ON a.id = s.agent_id
       WHERE s.tenant = NEW.tenant AND s.member_id = NEW.member_id
         AND s.retired_at IS NULL AND a.status IN ('active', 'paused')) >= NEW.max_live
BEGIN
  SELECT RAISE(ABORT, 'seat_cap_exceeded');
END;
