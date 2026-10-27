-- 0263 — the Security Bar (Hadi, 2026-10-26: "move the restriction settings to a security bar
-- that can have onboarding, operating, under attack").
--
-- Numbering: rebased above origin/main's migration chain; 0263 is reserved for this change.
-- Renumber on rebase if the migration-numbering guard reports a later applied head.
--
-- THREE TABLES, ONE CONCERN
--   security_bar_state          the level per scope (only the tenant row is writable in this PR).
--                               A missing row is NOT a level: the reader maps it to 'operating'
--                               (all rules strict, exactly today's behaviour). Only explicit
--                               onboarding opts in to friction relaxations. A malformed row or failed read maps to
--                               'under_attack' (src/policy/bar.ts).
--   policy_events               append-only audit: would_block records (a relaxed check that
--                               would have refused), level changes, lowering requests. NO bodies,
--                               NO secrets: ids and a short enum-ish detail only.
--   security_bar_lower_requests a LOWERING of the level is a two-step act (request, then confirm
--                               by a second owner, or by the same owner after a delay). Raising
--                               is never gated. At most one pending request at a time.

CREATE TABLE IF NOT EXISTS security_bar_state (
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('tenant', 'department', 'squad', 'project', 'agent')),
  scope_id   TEXT NOT NULL CHECK (length(scope_id) BETWEEN 1 AND 200),
  level      TEXT NOT NULL CHECK (level IN ('onboarding', 'operating', 'under_attack')),
  version    INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by TEXT NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 200),
  PRIMARY KEY (scope_kind, scope_id)
);

CREATE TABLE IF NOT EXISTS policy_events (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  id      TEXT NOT NULL UNIQUE,
  ts      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  kind    TEXT NOT NULL CHECK (kind IN (
            'would_block', 'relaxed_applied',
            'level_change', 'lower_requested', 'lower_confirmed', 'lower_cancelled', 'lower_refused'
          )),
  rule_id TEXT CHECK (rule_id IS NULL OR length(rule_id) BETWEEN 1 AND 120),
  level   TEXT CHECK (level IS NULL OR level IN ('onboarding', 'operating', 'under_attack')),
  actor   TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
  scope   TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 200),
  detail  TEXT CHECK (detail IS NULL OR length(detail) <= 200)
);
CREATE INDEX IF NOT EXISTS idx_policy_events_rule ON policy_events (rule_id, ts);
CREATE INDEX IF NOT EXISTS idx_policy_events_kind ON policy_events (kind, ts);

CREATE TRIGGER IF NOT EXISTS policy_events_no_update BEFORE UPDATE ON policy_events
BEGIN SELECT RAISE(ABORT, 'policy_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS policy_events_no_delete BEFORE DELETE ON policy_events
BEGIN SELECT RAISE(ABORT, 'policy_events is append-only'); END;

CREATE TABLE IF NOT EXISTS security_bar_lower_requests (
  id              TEXT PRIMARY KEY,
  from_level      TEXT NOT NULL CHECK (from_level IN ('onboarding', 'operating', 'under_attack')),
  target_level    TEXT NOT NULL CHECK (target_level IN ('onboarding', 'operating', 'under_attack')),
  requested_by    TEXT NOT NULL,
  requested_at    TEXT NOT NULL,
  effective_after TEXT NOT NULL,
  needs_second_owner INTEGER NOT NULL CHECK (needs_second_owner IN (0, 1)),
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'cancelled')),
  resolved_by     TEXT,
  resolved_at     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_security_bar_one_pending
  ON security_bar_lower_requests (status) WHERE status = 'pending';
