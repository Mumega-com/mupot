-- 0037_episodic_memory.sql — S4a sane-brain: episodic memory layer.
--
-- agent_episodes is a durable, recency-ordered TIMELINE of notable goal-cycle
-- outcomes per (tenant, agent). Unlike:
--   - engrams (semantic memory, Vectorize-backed similarity recall)
--   - loop_decision_dedup (idempotent reservation key, NOT a log)
--   - loop_observer (aggregate noop/fail counters, not per-cycle records)
--
-- ...agent_episodes is a structured, queryable, append-only LOG of what happened
-- on each cycle — the "recent trajectory" the agent re-reads at cycle start to
-- know its own history without a Vectorize semantic search.
--
-- TENANT ISOLATION: tenant is the FIRST column in the composite index so every
-- read/write is scoped to a single tenant; a cross-tenant scan is structurally
-- impossible when the query always includes tenant in the WHERE clause.
--
-- APPEND-ONLY: no UNIQUE constraint — episodes are a log, not a reservation.
-- This is intentional: the dedup guard in loop.ts already prevents redundant
-- cycle runs; we do NOT deduplicate episode records (the record is the log entry).
--
-- RECORD POLICY (enforced in episodic.ts):
--   RECORD:   'spawned'      — always (at least one task was created)
--             'backpressure' — queue-full state is a real signal
--             'escalated'    — observer.escalate fired (operator attention raised)
--   SKIP:     'observe-only' — effort=low no-op (noise, not a signal)
--             'deduped'      — idempotent rest (not a distinct event)
--             'rate_limited' / 'budget_exhausted' — economic gates, not trajectory
--
-- FIELDS:
--   id            — UUID, row identity (also used for ORDER BY tiebreak)
--   tenant        — = env.TENANT_SLUG (isolation first)
--   agent_id      — the agent this episode belongs to
--   cycle         — cycle counter at time of recording (from AgentDO runtime)
--   ts            — ISO-8601 timestamp of the episode (NOT DEFAULT — caller sets it)
--   kind          — episode type: 'spawned'|'backpressure'|'escalated'
--   summary       — bounded human-readable description (≤300 chars, enforced in code)
--   decision_fp   — SHA-256 hex fingerprint of the cycle (from dedup.ts), nullable
--   kpi_progress  — kpi_progress at time of recording (REAL, nullable)
--   created_at    — row insertion time (DEFAULT datetime('now'))

CREATE TABLE IF NOT EXISTS agent_episodes (
  id            TEXT NOT NULL,
  tenant        TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  cycle         INTEGER,
  ts            TEXT NOT NULL,
  kind          TEXT NOT NULL,
  summary       TEXT NOT NULL,
  decision_fp   TEXT,
  kpi_progress  REAL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (id)
);

-- Primary retrieval index: (tenant, agent_id, ts DESC) — the exact access pattern
-- for recentEpisodes(). Including `id` for stable tiebreaking on equal timestamps.
CREATE INDEX IF NOT EXISTS idx_agent_episodes_recent
  ON agent_episodes(tenant, agent_id, ts DESC, id DESC);
