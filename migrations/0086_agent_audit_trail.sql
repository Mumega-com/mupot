-- 0086_agent_audit_trail.sql — Agent profile mutation audit trail
--
-- Enables admin-gated update_agent MCP tool with append-only audit + rollback.
-- Prevents "profile hygiene requires DB access" pattern (GH #837 companion).
--
-- `agents` has NO updated_at column — 0049 rebuilt the table without one and no
-- later migration adds it (#846). This table is therefore the ONLY provenance a
-- correction has. It is written in the SAME D1 batch as the UPDATE it describes
-- (see updateAgentProfile), so the record commits with the change or not at all.
--
-- Schema:
--   agent_audit: immutable log of agent mutations
--     • before_state, after_state: JSON snapshots for verification
--     • rollback_to_id: links back to a prior audit row for undo affordance
--
-- ORDERING (#857): `seq` exists because created_at cannot order the log. It was
-- originally datetime('now') — whole-second resolution — so two corrections to
-- the same agent within one second were indistinguishable and ORDER BY
-- created_at returned them in arbitrary order. For an append-only trail whose
-- entire purpose is "what did this row look like before", ambiguous ordering
-- makes the chain unreconstructable and rollback_to_id unsafe: "the prior entry"
-- stops having one answer. A test caught this before the table shipped.
-- created_at keeps millisecond precision for humans; seq is what code orders by.

CREATE TABLE IF NOT EXISTS agent_audit (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT, -- monotonic; the ordering key
  id              TEXT NOT NULL UNIQUE,              -- UUID, the external handle
  -- Deliberately NOT a foreign key. It was `REFERENCES agents(id) ON DELETE
  -- CASCADE`, which erased an agent's entire history the moment deleteAgent ran
  -- — the trail vanishing exactly when it is most needed, at retirement, when
  -- someone asks what this seat used to be and who changed it. Orphan rows are
  -- the acceptable price of the record surviving its subject.
  --
  -- Dropping only the CASCADE would be worse than leaving it: the default
  -- NO ACTION would make deleteAgent fail outright once an agent had any audit
  -- history. So the constraint goes, not just its action. (#857)
  agent_id        TEXT NOT NULL,
  actor_id        TEXT NOT NULL,                 -- agent/user id (admin who made change)
  actor_type      TEXT NOT NULL DEFAULT 'agent' CHECK (actor_type IN ('agent','user','system')),
  action          TEXT NOT NULL,                 -- 'update_agent'
  fields_changed  TEXT NOT NULL,                 -- JSON array: ["role", "model", ...]
  before_state    TEXT NOT NULL,                 -- JSON snapshot of every audited column
  after_state     TEXT NOT NULL,                 -- JSON snapshot of every audited column
  rollback_to_id  TEXT,                          -- if this is a rollback, points to prior audit id
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_audit_agent ON agent_audit(agent_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_agent_audit_actor ON agent_audit(actor_id, seq DESC);
