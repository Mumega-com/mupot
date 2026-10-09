-- 0197_studio_dispatch_slots.sql — mupot#1762 (a). Studio dispatch (member floor) can launch a real Cursor agent against a
-- member-chosen repoUrl; a maybe-launched / launched flight HOLDs that repo's clearance for 60-84 min. This table is the
-- atomic per-actor bound: a slot is reserved by ONE conditional INSERT...SELECT (count-in-window < limit) BEFORE the
-- external launch, so concurrent requests cannot both pass a read-then-write check. state: reserved (launch in flight),
-- launched (agent exists), maybe (POST may have reached Cursor). A clean refusal / no-launch deletes the slot; leaked
-- 'reserved' slots age out of the window. Additive; no backfill.
CREATE TABLE IF NOT EXISTS studio_dispatch_slots (
  id         TEXT PRIMARY KEY,
  member_key TEXT NOT NULL,
  repo_key   TEXT NOT NULL,
  state      TEXT NOT NULL CHECK (state IN ('reserved','launched','maybe')),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_studio_slots_member ON studio_dispatch_slots (member_key, created_at);
CREATE INDEX IF NOT EXISTS idx_studio_slots_repo ON studio_dispatch_slots (repo_key, state, created_at);
