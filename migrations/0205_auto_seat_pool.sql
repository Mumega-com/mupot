-- mupot W5a round 2 — a SEPARATE, bounded pool for auto-seats (seats created from a per-conversation
-- client key, src/members/seat-auto.ts), so ordinary ChatGPT conversations can never exhaust the
-- member-wide caps that explicit seat_select seats use.
--
-- 1. agent_seats.source: 'select' (seat_select; every pre-existing row) or 'auto' (W5a). Immutable.
--    max_auto_live: the per-HARNESS live cap for auto seats IN FORCE when the row was issued (like
--    max_live / max_total); last_used_at: LRU bookkeeping for reclaim (mutable, touched at most every
--    10 minutes by the auto path).
-- 2. The three member/harness caps (0198/0199/0204) now count and apply to source='select' ONLY. An auto
--    seat consumes none of them; an explicit seat's caps behave exactly as before.
-- 3. agent_seats_auto_live_cap_insert: atomic per-harness LIVE cap for auto seats. Reclaim (retire the LRU
--    auto seat of the harness) runs inside the creating batch BEFORE the insert, so a full pool turns
--    into a retire + create; if the retire did not free a slot the trigger aborts the whole batch.
-- 4. auto_seat_windows: ONE counter row per (tenant, harness) holding the creation window. It is spent by a
--    single atomic UPSERT ... WHERE (changes()=0 means refused), never a KV read-compare-put, and a
--    failed statement is treated as a refusal (fail closed).

ALTER TABLE agent_seats ADD COLUMN source TEXT NOT NULL DEFAULT 'select' CHECK (source IN ('select', 'auto'));
ALTER TABLE agent_seats ADD COLUMN max_auto_live INTEGER NOT NULL DEFAULT 32 CHECK (max_auto_live BETWEEN 1 AND 4096);
ALTER TABLE agent_seats ADD COLUMN last_used_at TEXT;

CREATE INDEX IF NOT EXISTS idx_agent_seats_harness_auto ON agent_seats (tenant, harness_id, source, retired_at);

DROP TRIGGER IF EXISTS agent_seats_cap_insert;
CREATE TRIGGER agent_seats_cap_insert
BEFORE INSERT ON agent_seats
FOR EACH ROW
WHEN NEW.retired_at IS NULL AND NEW.source = 'select'
 AND (SELECT COUNT(*) FROM agent_seats s
       JOIN agents a ON a.id = s.agent_id
       WHERE s.tenant = NEW.tenant AND s.member_id = NEW.member_id AND s.source = 'select'
         AND s.retired_at IS NULL AND a.status IN ('active', 'paused')) >= NEW.max_live
BEGIN
  SELECT RAISE(ABORT, 'seat_cap_exceeded');
END;

DROP TRIGGER IF EXISTS agent_seats_total_cap_insert;
CREATE TRIGGER agent_seats_total_cap_insert
BEFORE INSERT ON agent_seats
FOR EACH ROW
WHEN NEW.source = 'select'
 AND (SELECT COUNT(*) FROM agent_seats s
       WHERE s.tenant = NEW.tenant AND s.member_id = NEW.member_id AND s.source = 'select') >= NEW.max_total
BEGIN
  SELECT RAISE(ABORT, 'seat_total_cap_exceeded');
END;

DROP TRIGGER IF EXISTS agent_seats_harness_total_cap_insert;
CREATE TRIGGER agent_seats_harness_total_cap_insert
BEFORE INSERT ON agent_seats
FOR EACH ROW
WHEN NEW.source = 'select'
 AND (SELECT COUNT(*) FROM agent_seats s
       WHERE s.tenant = NEW.tenant AND s.harness_id = NEW.harness_id AND s.source = 'select') >= NEW.max_harness_total
BEGIN
  SELECT RAISE(ABORT, 'seat_harness_total_cap_exceeded');
END;

CREATE TRIGGER agent_seats_auto_live_cap_insert
BEFORE INSERT ON agent_seats
FOR EACH ROW
WHEN NEW.retired_at IS NULL AND NEW.source = 'auto'
 AND (SELECT COUNT(*) FROM agent_seats s
       JOIN agents a ON a.id = s.agent_id
       WHERE s.tenant = NEW.tenant AND s.harness_id = NEW.harness_id AND s.source = 'auto'
         AND s.retired_at IS NULL AND a.status IN ('active', 'paused')) >= NEW.max_auto_live
BEGIN
  SELECT RAISE(ABORT, 'seat_auto_cap_exceeded');
END;

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
  OR NEW.max_harness_total IS NOT OLD.max_harness_total
  OR NEW.source IS NOT OLD.source
  OR NEW.max_auto_live IS NOT OLD.max_auto_live
  OR NEW.seat_token_id IS NOT OLD.seat_token_id
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS NOT OLD.retired_at)
BEGIN
  SELECT RAISE(ABORT, 'agent_seat_immutable');
END;

CREATE TABLE IF NOT EXISTS auto_seat_windows (
  tenant       TEXT NOT NULL,
  harness_id   TEXT NOT NULL REFERENCES harnesses(id) ON DELETE CASCADE,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL CHECK (count >= 0),
  PRIMARY KEY (tenant, harness_id)
);
