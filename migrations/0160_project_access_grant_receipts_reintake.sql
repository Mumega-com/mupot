-- 0160_project_access_grant_receipts_reintake.sql — widen
-- project_access_grant_receipts (0157) to also carry a receipted
-- "re-intake authorized" row (FP-01 Slice 2 v2, successor to mupot#1443/
-- PR #1488, adversarial P2-8 + Athena's design ruling on the successor
-- brief: "Re-intake = a receipted 're-intake authorized' action,
-- human-word-gated (org admin or gate owner), receipt row in the SAME
-- append-only table with reason + who; derivation = (proposal OR receipt)
-- AND NOT re-intake-authorized-after-it."). NOT applied by this build —
-- branch/schema only, exactly like 0143/0144/0147/0148/0157/0158/0159
-- before it; a human applies it.
--
-- THE BUG THIS CLOSES
--
-- 0157's project_access_grant_receipts is append-only with UNIQUE(proposal_id)
-- — DELETE and UPDATE are both trigger-refused. PR #1488's intake_state
-- derivation treats "a grant receipt exists for this member" as a
-- permanent, one-way door: once a member has ever received a grant, there
-- is no supported way to return their intake_state to 'pending' (an
-- offboard/rejoin or a botched intake is unrecoverable without DROP
-- TRIGGER surgery on a production table). See ADVERSARIAL PATTERN LIBRARY
-- finding 8 (kasra-review, 2026-09-21, PR #1488).
--
-- SHAPE
--
-- `kind` discriminates the two row shapes this table now carries. A 'grant'
-- row is UNCHANGED from 0157 — every 0157 column stays NOT NULL for that
-- kind (enforced by the CHECK below, not by column-level NOT NULL, since
-- SQLite CHECK constraints can express "conditionally required" but column
-- NOT NULL cannot). A 'reintake_authorized' row carries only member_id,
-- decided_by (the org admin or gate owner who authorized it — reusing the
-- existing column rather than adding a same-shaped new one) and a mandatory
-- `reason`; project_id/squad_id/access_level/proposal_id/verdict_id are all
-- NULL for this kind. `UNIQUE (proposal_id)` still holds under SQLite's
-- rule that NULL never equals NULL, so any number of 'reintake_authorized'
-- rows (proposal_id always NULL) coexist without collision.
--
-- The re-intake row is deliberately NOT itself the thing that flips a
-- member back to 'pending' — it is a fact ("a human authorized this member
-- to re-intake, and said why") that the derivation in src/im/index.ts reads
-- alongside the existing proposal/receipt facts: complete = (proposal OR
-- grant receipt) AND NOT (a reintake_authorized row created AFTER the later
-- of those two). Writing this row is gated at the call site (org-admin or
-- the routine gate's gate:routines capability) — this migration only makes
-- the row representable and durable.

PRAGMA foreign_keys = off;

CREATE TABLE project_access_grant_receipts_new (
  id           TEXT NOT NULL PRIMARY KEY,
  tenant       TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'grant' CHECK (kind IN ('grant', 'reintake_authorized')),
  project_id   TEXT,
  squad_id     TEXT,                          -- the member's HOME squad that received the grant
  member_id    TEXT NOT NULL,
  access_level TEXT CHECK (access_level IS NULL OR access_level IN ('read', 'write', 'admin')),
  proposal_id  TEXT,                          -- routine_run_actions.id (the project_access proposal)
  verdict_id   TEXT,                          -- task_verdicts.id that authorized this grant
  decided_by   TEXT NOT NULL,                 -- grant: task_verdicts.decided_by. reintake: the authorizer.
  decided_via  TEXT,                          -- grant: task_verdicts.decided_via. reintake: 'org_admin'|'gate:routines'.
  reason       TEXT,                          -- required for 'reintake_authorized'; unused for 'grant'.
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (proposal_id),                       -- one grant receipt per proposal — idempotent on retry.
  CHECK (
    (kind = 'grant'
       AND project_id IS NOT NULL AND squad_id IS NOT NULL AND access_level IS NOT NULL
       AND proposal_id IS NOT NULL AND verdict_id IS NOT NULL)
    OR
    (kind = 'reintake_authorized'
       AND reason IS NOT NULL AND length(trim(reason)) > 0
       AND project_id IS NULL AND squad_id IS NULL AND access_level IS NULL
       AND proposal_id IS NULL AND verdict_id IS NULL)
  )
);

INSERT INTO project_access_grant_receipts_new (
  id, tenant, kind, project_id, squad_id, member_id, access_level,
  proposal_id, verdict_id, decided_by, decided_via, reason, created_at
)
SELECT
  id, tenant, 'grant', project_id, squad_id, member_id, access_level,
  proposal_id, verdict_id, decided_by, decided_via, NULL, created_at
FROM project_access_grant_receipts;

DROP TABLE project_access_grant_receipts;
ALTER TABLE project_access_grant_receipts_new RENAME TO project_access_grant_receipts;

-- Indexes dropped with the table above — recreated verbatim from 0157, plus
-- one new index for the reintake-derivation read path.
CREATE INDEX IF NOT EXISTS idx_project_access_grant_receipts_verdict
  ON project_access_grant_receipts(verdict_id);
CREATE INDEX IF NOT EXISTS idx_project_access_grant_receipts_member
  ON project_access_grant_receipts(member_id);
CREATE INDEX IF NOT EXISTS idx_project_access_grant_receipts_member_kind
  ON project_access_grant_receipts(member_id, kind, created_at);

-- Triggers dropped with the table above — recreated verbatim from 0157.
CREATE TRIGGER IF NOT EXISTS project_access_grant_receipts_no_update
  BEFORE UPDATE ON project_access_grant_receipts
BEGIN
  SELECT RAISE(ABORT, 'project_access_grant_receipts is append-only');
END;

CREATE TRIGGER IF NOT EXISTS project_access_grant_receipts_no_delete
  BEFORE DELETE ON project_access_grant_receipts
BEGIN
  SELECT RAISE(ABORT, 'project_access_grant_receipts is append-only');
END;

PRAGMA foreign_keys = on;
