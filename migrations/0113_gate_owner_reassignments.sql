-- 0113 — gate_owner reassignment receipts (mupot#1148-adjacent; P0 workflow blocker)
--
-- WHY THIS TABLE EXISTS
--
-- A task in status='review' with a gate_owner already set has NO supported
-- re-gate path. Measured live on cb512f05 (FLIGHT-06 L2, squad 3674d955,
-- status=review, gate_owner='gate:agent-self-completion'): task_update returns
-- 409 gate_owner_locked. The one existing escape hatch —
-- repairsHistoricalUngatedReview — requires gate_owner IS NULL, so it cannot
-- apply to a row that already carries a gate. The gate is stuck with whoever it
-- was first assigned to, forever, even when that holder is retired or wrong.
--
-- THE LOCK IS DELIBERATE AND MUST NOT BE WEAKENED
--
-- It is the BLOCK-2 fix (kasra-review, 2026-08-13, proof-of-exploit): re-gating
-- a review task into a peer's lane let two colluding or compromised agents
-- launder any single-gate check. That was demonstrated live, not theorised. So
-- the recovery path added alongside this table is narrow by construction:
--   * status='review' ONLY — approved/rejected/done stay locked outright
--   * org owner/admin ONLY — not squad admin, not lead, not the assignee
--   * a non-empty reason is MANDATORY
--   * gate_owner is the ONLY column that may move; status, result and verdict
--     are untouched, so this can never stand in for a verdict
--
-- The receipt below is what makes that narrowness auditable. An owner is
-- trusted to reassign a gate; an owner is NOT trusted to do it invisibly. If the
-- laundering attack is ever attempted by a legitimate principal, this table is
-- where it shows up — from, to, who, when and why, in order.
--
-- SHAPE follows agent_audit (0086) and the append-only receipts idiom (0091):
--   * seq AUTOINCREMENT is the ordering key. created_at is for humans; ordering
--     by a timestamp makes the chain unreconstructable when two rows share a
--     millisecond, which 0086 records as caught-before-shipping.
--   * NO foreign key to tasks. 0086 learned this the hard way: a CASCADE erased
--     an agent's whole history exactly at retirement, when it is most needed.
--     Orphan rows are the acceptable price of a record outliving its subject.
--     Dropping only the action would be worse — NO ACTION would make deleting a
--     task fail once it had any history.
--   * append-only enforced by triggers, not convention.
--
-- MIGRATION NUMBERING: 0110-0112 are claimed by the unmerged PR #1164
-- (squad membership write path). This takes 0113 to avoid a collision if that
-- lands first. If #1164 is abandoned, 0110-0112 stay unused rather than being
-- renumbered — a gap is harmless, a reused number is not.

CREATE TABLE IF NOT EXISTS gate_owner_reassignments (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT, -- monotonic; the ordering key
  id              TEXT NOT NULL UNIQUE,              -- UUID, the external handle
  tenant          TEXT NOT NULL,
  task_id         TEXT NOT NULL,                     -- deliberately NOT a foreign key (see above)
  squad_id        TEXT NOT NULL,
  -- The immutable from/to pair. from_gate_owner is NOT NULL because this path
  -- only ever moves an EXISTING gate; the null-gate case is the pre-existing
  -- repairsHistoricalUngatedReview hatch and is not recorded here.
  from_gate_owner TEXT NOT NULL,
  to_gate_owner   TEXT NOT NULL,
  reason          TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  actor_id        TEXT NOT NULL,
  actor_type      TEXT NOT NULL DEFAULT 'member' CHECK (actor_type IN ('member','agent','system')),
  -- Recorded so a later reader can confirm the constraint held at write time
  -- rather than trusting that it did. status must be 'review' for this path.
  task_status     TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_gate_owner_reassign_task
  ON gate_owner_reassignments(tenant, task_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_gate_owner_reassign_actor
  ON gate_owner_reassignments(tenant, actor_id, seq DESC);

-- Append-only, enforced. A receipt an operator can edit is not a receipt.
CREATE TRIGGER gate_owner_reassignments_no_update
BEFORE UPDATE ON gate_owner_reassignments
BEGIN
  SELECT RAISE(ABORT, 'gate_owner_reassignments is append-only: UPDATE is forbidden');
END;

CREATE TRIGGER gate_owner_reassignments_no_delete
BEFORE DELETE ON gate_owner_reassignments
BEGIN
  SELECT RAISE(ABORT, 'gate_owner_reassignments is append-only: DELETE is forbidden');
END;
