-- 0036_sane_brain_dedup_observer.sql — anti-spam spine for the goal loop (S2).
--
-- Two tables keyed by (tenant, agent_id) — tenant FIRST so every row is
-- tenant-scoped and a cross-tenant scan is structurally impossible.
--
-- loop_decisions — idempotent dedup key for one goal-cycle tick.
--   The unique constraint on (tenant, agent_id, decision_fp) is the atomic
--   reservation point: INSERT ... ON CONFLICT DO NOTHING is the commit — if
--   meta.changes=0 the cycle already ran for this fingerprint.
--
-- loop_observer — durable meta-observer counters, one row per (tenant, agent).
--   Tracks consecutive no-ops, consecutive failures, and liveness failures so
--   the loop can self-regulate (cooldown) and escalate to the operator ONCE
--   (deduped via last_escalated_at) rather than on every tick.

-- ── loop_decisions ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS loop_decisions (
  id            TEXT NOT NULL,                          -- uuid, for row identity / audit
  tenant        TEXT NOT NULL,                          -- = TENANT_SLUG, tenant isolation (first in PK)
  agent_id      TEXT NOT NULL,                          -- the agent that produced this fingerprint
  decision_fp   TEXT NOT NULL,                          -- SHA-256 hex of the canonical preimage
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  -- Unique constraint: the dedup key. INSERT ... ON CONFLICT DO NOTHING is atomic.
  -- meta.changes=1 → reservation won; meta.changes=0 → already reserved (duplicate).
  UNIQUE (tenant, agent_id, decision_fp)
);

CREATE INDEX IF NOT EXISTS idx_loop_decisions_agent
  ON loop_decisions(tenant, agent_id, created_at DESC);

-- ── loop_observer ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS loop_observer (
  tenant                TEXT NOT NULL,                    -- = TENANT_SLUG, tenant isolation (first in PK)
  agent_id              TEXT NOT NULL,                    -- the observed agent
  consecutive_noops     INTEGER NOT NULL DEFAULT 0,       -- deduped ticks with no work spawned
  consecutive_fails     INTEGER NOT NULL DEFAULT 0,       -- consecutive error/liveness-fail ticks
  liveness_fails        INTEGER NOT NULL DEFAULT 0,       -- cumulative liveness failures (reset on productive tick)
  last_escalated_at     TEXT,                             -- ISO-8601 of last operator escalation (NULL = never)
  cooldown_until        TEXT,                             -- ISO-8601 until which the alarm should be extended (NULL = no cooldown)
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant, agent_id)
);
