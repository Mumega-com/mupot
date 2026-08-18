-- 0114 — verdict reversal receipts (mupot#1181; assigned via mupot#67fcf7dc / dara-assign-kasra-1181-20260818)
--
-- WHY THIS TABLE EXISTS
--
-- Once a task moves to status='approved' or 'rejected', task_verdict — the only
-- tool that writes a verdict — hard-refuses (`status !== 'review'`), and
-- task_update deliberately makes approved/rejected non-patchable
-- (src/mcp/index.ts, "a task cannot approve itself"). So a WRONG verdict, once
-- written, is permanent — not for a gate, not for an org owner, not for anyone,
-- through any tool. Filed and measured live tonight while attempting to reverse
-- a specific approval (a5e45082, Mumega-com/hadi-mac) whose stored evidence was
-- later ruled contaminated. That specific approval was left standing by owner
-- ruling — this table exists regardless of that outcome, because the mechanism
-- gap survives it: every gate on every board is currently issuing irreversible
-- decisions, and the gate model's entire justification (a wrong verdict can be
-- caught downstream) does not hold as implemented.
--
-- THE LOCK THIS NARROWS IS DELIBERATE, LIKE 0113's WAS
--
-- task_verdict's self-verdict prevention and gate-capability checks exist to
-- stop a decider grading their own homework (BLOCK-2, proof-of-exploit,
-- 2026-08-13: colluding agents laundering a gate check by re-routing it). A
-- verdict carries MORE weight than a gate assignment, so this reversal path is
-- at least as narrow as 0113's, and its whole design goal is to feed the task
-- back into the EXISTING task_verdict machinery rather than create a second,
-- parallel way to write a verdict:
--   approved/rejected ONLY — a review task has no verdict to reverse
--   org owner/admin ONLY
--   reason MANDATORY
--   moves status back to 'review' and clears nothing else — the reversed
--     verdict's audit trail (who decided what, when) stays intact; this adds a
--     row, it does not edit or erase one
--   the SUBSEQUENT re-verdict runs through task_verdict UNCHANGED — self-verdict
--     prevention and gate-capability checks apply exactly as they always do, so
--     reopening a task does not weaken the check that closes it
--
-- SHAPE follows 0086 (agent_audit), 0091 (oauth_consent_receipts), 0113
-- (gate_owner_reassignments): seq AUTOINCREMENT ordering key (0086: ordering an
-- audit chain by timestamp is unreconstructable when two rows share a
-- millisecond), NO foreign key (0086: a CASCADE erases history exactly at
-- retirement, when it is most needed — orphan rows are the price of the record
-- outliving its subject), RAISE(ABORT) append-only triggers.

CREATE TABLE IF NOT EXISTS verdict_reversals (
  seq              INTEGER PRIMARY KEY AUTOINCREMENT, -- monotonic; the ordering key
  id               TEXT NOT NULL UNIQUE,               -- UUID, the external handle
  tenant           TEXT NOT NULL,
  task_id          TEXT NOT NULL,                      -- deliberately NOT a foreign key (see above)
  squad_id         TEXT NOT NULL,
  from_status      TEXT NOT NULL CHECK (from_status IN ('approved', 'rejected')),
  -- The prior verdict's decider and note, copied at reversal time — the row
  -- being reopened will be overwritten by the NEXT task_verdict call, so this
  -- is the only place the ORIGINAL decision survives once it is reopened.
  prior_decided_by TEXT,
  prior_note       TEXT,
  reason           TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  actor_id         TEXT NOT NULL,
  actor_type       TEXT NOT NULL DEFAULT 'member' CHECK (actor_type IN ('member', 'agent', 'system')),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_verdict_reversals_task
  ON verdict_reversals(tenant, task_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_verdict_reversals_actor
  ON verdict_reversals(tenant, actor_id, seq DESC);

-- Append-only, enforced. A reversal an operator can edit afterwards defeats the
-- point of recording it.
CREATE TRIGGER verdict_reversals_no_update
BEFORE UPDATE ON verdict_reversals
BEGIN
  SELECT RAISE(ABORT, 'verdict_reversals is append-only: UPDATE is forbidden');
END;

CREATE TRIGGER verdict_reversals_no_delete
BEFORE DELETE ON verdict_reversals
BEGIN
  SELECT RAISE(ABORT, 'verdict_reversals is append-only: DELETE is forbidden');
END;
