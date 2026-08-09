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

-- Append-only triggers, matching task_verdicts_no_update/_no_delete
-- (migrations/0008_gate_grants.sql). An audit trail that is append-only only by
-- convention is not an audit trail: anything with DB access could otherwise
-- rewrite or delete history silently, which is exactly the failure mode this
-- table exists to close (agents has no updated_at — see header comment above).
--
-- Rollback does NOT need an exception here: per the schema comment, undo is a
-- NEW row with rollback_to_id pointing at a prior audit id, never a mutation of
-- an existing one. Verified against src/org/service.ts — the rollback path this
-- table anticipates is not implemented yet, so there is nothing there to
-- reconcile with immutability today.
--
-- updateAgentProfile DOES need an exception: it writes agent_audit inside the
-- same env.DB.batch() as the `agents` UPDATE it records (src/org/service.ts,
-- around lines 893-906), and that batch's third statement UPDATEs the
-- just-inserted row's after_state — the INSERT (statement 1) runs BEFORE the
-- `agents` UPDATE (statement 2), so the post-update snapshot can only be
-- captured with a follow-up read. That is not a design accident: the comment
-- there rejects computing after_state from a pre-UPDATE JS-side SELECT because
-- a concurrent write between the read and the transaction would make it a
-- fabrication. So the trigger below permits exactly that one transition — the
-- one-time after_state backfill on a row whose after_state is still the ''
-- sentinel INSERT always writes — and blocks every other UPDATE, including any
-- second attempt to backfill the same row. Same narrow-allow-list shape as
-- task_verdicts_no_update (migrations/0069_project_structural_completion.sql:232),
-- which already carries a controlled exception for exactly this reason: a
-- blanket append-only trigger with no exception would break this table's own
-- primary write path.
CREATE TRIGGER agent_audit_no_update
  BEFORE UPDATE ON agent_audit
  WHEN NOT (
    OLD.after_state = ''
    AND NEW.after_state <> ''
    AND NEW.seq IS OLD.seq
    AND NEW.id IS OLD.id
    AND NEW.agent_id IS OLD.agent_id
    AND NEW.actor_id IS OLD.actor_id
    AND NEW.actor_type IS OLD.actor_type
    AND NEW.action IS OLD.action
    AND NEW.fields_changed IS OLD.fields_changed
    AND NEW.before_state IS OLD.before_state
    AND NEW.rollback_to_id IS OLD.rollback_to_id
    AND NEW.created_at IS OLD.created_at
  )
BEGIN
  SELECT RAISE(ABORT, 'agent_audit is append-only: UPDATE is forbidden');
END;

CREATE TRIGGER agent_audit_no_delete
  BEFORE DELETE ON agent_audit
BEGIN
  SELECT RAISE(ABORT, 'agent_audit is append-only: DELETE is forbidden');
END;
