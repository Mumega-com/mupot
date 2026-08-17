-- 0106_onboarding_doors.sql — self-service onboarding with a reviewable close.
--
-- Hadi, 2026-08-17: "let them choose their access fine grain, then when we close the door
-- we crystal the access after Athena approval."
--
-- THE MODEL, and why it is not a hole:
--
--   OPEN     a fresh login picks the access it needs and gets it IMMEDIATELY. No 403 wall,
--            no invite round-trip, no waiting on an admin. Access granted here is
--            PROVISIONAL — real enough to work with, explicitly marked as unreviewed.
--   RECORD   every self-grant writes an append-only receipt in the SAME D1 batch as the
--            capability write, carrying the PRIOR capability as well as the new one.
--   CLOSE    one owner-gated call freezes the door: further self-grants fail immediately,
--            and the receipts become the exact review set.
--   REVIEW   Athena rules on each receipt.
--   CRYSTALLIZE  approved access becomes permanent and loses its provisional mark.
--            Rejected access is RESTORED to its prior value from the receipt — never
--            blind-deleted, because a self-grant may have overwritten a legitimate grant.
--
-- WHY THE RECEIPT CARRIES `capability_before`. src/members/agent-access.ts does
-- `ON CONFLICT ... DO UPDATE SET capability = excluded.capability`, so a self-grant
-- OVERWRITES any existing grant. Without the prior value, "undo the door" would delete a
-- legitimate `observer` that predated it. Loom caught this in the #1118-era door review:
-- event-only provenance is insufficient, and blind deletion at close destroys real access.
--
-- WHY A DOOR ROW AND NOT A CODE FLAG. The first attempt planned "restore min:'lead' and
-- delete the block" as the close procedure. That is archaeology dressed as a plan: nothing
-- durable identifies what came through, so nothing can be reviewed or reversed. A door is
-- a ROW, its generation is queryable, and closing it is a transaction rather than a commit.

-- ── the door itself ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS onboarding_doors (
  id             TEXT NOT NULL PRIMARY KEY,
  tenant         TEXT NOT NULL,
  -- open: self-service writes allowed. closed: writes refused, receipts frozen for review.
  -- crystallized: review complete, dispositions applied, this generation is history.
  status         TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'closed', 'crystallized')),
  -- Ceiling on what may be self-selected while this door is open. Enforced in code against
  -- an ALLOWLIST, never a string-prefix test: `gate:*` lives in a separate grant surface,
  -- and scope 'org' / capability 'owner' must be structurally unreachable here.
  max_capability TEXT NOT NULL DEFAULT 'lead'
                 CHECK (max_capability IN ('observer', 'member', 'lead')),
  -- Which scopes may be self-selected. 'department' is DELIBERATELY excluded by default:
  -- a department grant covers every squad in it INCLUDING FUTURE ONES, which makes it an
  -- authority generator rather than fine-grained access. Opening it must be a conscious act.
  allowed_scopes TEXT NOT NULL DEFAULT '["squad"]'
                 CHECK (json_valid(allowed_scopes) AND json_type(allowed_scopes) = 'array'),
  opened_by      TEXT NOT NULL,
  opened_at      TEXT NOT NULL DEFAULT (datetime('now')),
  closed_by      TEXT,
  closed_at      TEXT,
  -- Sealed at close: how many receipts this generation produced. A later review that sees a
  -- different count knows the set was tampered with or is being read wrong.
  sealed_receipt_count INTEGER,
  -- Who ruled on the review, and when it was crystallized.
  reviewed_by    TEXT,
  crystallized_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_onboarding_doors_tenant_status
  ON onboarding_doors(tenant, status);

-- Only ONE door may be open per tenant. Two open generations would make "which door did
-- this come through" ambiguous exactly when the answer matters most — at review.
CREATE UNIQUE INDEX IF NOT EXISTS idx_onboarding_doors_one_open
  ON onboarding_doors(tenant) WHERE status = 'open';

-- ── append-only receipts ───────────────────────────────────────────────────────────
-- One row per access decision taken through a door. APPEND ONLY: never updated except to
-- record the review disposition, never deleted. This is the ledger the close depends on,
-- and it is written in the same batch as the capability row so a receipt cannot go missing
-- while the grant lands (the failure that made the previous attempt's audit a fiction).
CREATE TABLE IF NOT EXISTS door_receipts (
  id                 TEXT NOT NULL PRIMARY KEY,
  tenant             TEXT NOT NULL,
  door_id            TEXT NOT NULL REFERENCES onboarding_doors(id),
  -- Who acted. member_id is always present; agent_id is set when the actor was agent-bound.
  actor_member_id    TEXT NOT NULL,
  actor_agent_id     TEXT,
  -- What the access applies to.
  subject_member_id  TEXT NOT NULL,
  scope_type         TEXT NOT NULL CHECK (scope_type IN ('org', 'department', 'squad')),
  scope_id           TEXT,
  action             TEXT NOT NULL CHECK (action IN ('self_grant', 'agent_create')),
  -- THE RESTORE KEY. NULL means "no grant existed" — so rejecting restores by DELETING;
  -- a non-NULL value means a grant was overwritten and rejecting must write it back.
  capability_before  TEXT,
  capability_after   TEXT,
  -- Set only for action='agent_create'.
  created_agent_id   TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  -- Review outcome. 'pending' until Athena rules at close.
  disposition        TEXT NOT NULL DEFAULT 'pending'
                     CHECK (disposition IN ('pending', 'crystallized', 'revoked')),
  disposition_by     TEXT,
  disposition_at     TEXT,
  disposition_note   TEXT
);

CREATE INDEX IF NOT EXISTS idx_door_receipts_door        ON door_receipts(door_id, disposition);
CREATE INDEX IF NOT EXISTS idx_door_receipts_subject     ON door_receipts(tenant, subject_member_id);

-- ── provisional marking on the live grant ──────────────────────────────────────────
-- `capabilities` (0002_members.sql) has no provenance at all: id/member_id/scope_type/
-- scope_id/capability/created_at. Without this column a reader cannot tell a reviewed,
-- earned grant from one someone handed themselves five minutes ago — and after
-- crystallization we need that distinction to have been resolved, not assumed.
--
-- NULL          = a normal grant, unrelated to any door (every pre-existing row).
-- <door_id>     = PROVISIONAL, granted through that door, not yet reviewed.
-- Cleared back to NULL on crystallize, which is exactly what "crystal the access" means:
-- the grant stops being door-provisional and becomes an ordinary permanent capability.
ALTER TABLE capabilities ADD COLUMN provisional_door_id TEXT;

CREATE INDEX IF NOT EXISTS idx_capabilities_provisional
  ON capabilities(provisional_door_id) WHERE provisional_door_id IS NOT NULL;
