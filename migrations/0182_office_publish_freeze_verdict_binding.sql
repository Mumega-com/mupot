-- 0182_office_publish_freeze_verdict_binding.sql — mupot#1592 (r2 adversarial follow-up
-- on PR #1588, comment 5860750102, NEW-1/NEW-2/NEW-4): 0179's office_publish_freezes
-- froze the payload at APPROVAL time, built from whatever the row said inside the
-- approve call — "freeze at click, not freeze at sight". A requester who can still edit
-- title/body up to the moment of approval (task_update/PATCH have no office-aware lock)
-- can swap content after a human has already looked at the pending-approvals list, and
-- the human's approval then binds whatever the swapped row currently says. Separately,
-- the freeze was never bound to the SPECIFIC verdict that approved it — reverse + reject
-- left a stale freeze row an agent could re-approve through the GENERIC task_verdict tool
-- (which office.review_approval's own extra checks never run for) and publish the
-- rejected content anyway.
--
-- Code-side fix (src/addons/office/service.ts, src/tasks/service.ts,
-- src/im/origin-verdict.ts, src/mcp/index.ts, src/tasks/index.ts):
--   1. the freeze is now built the moment a gate:office task ENTERS review (the
--      "approval request" itself), not at approval — office.review_approval only
--      VALIDATES a caller-supplied `expected_payload_sha256` against this already-
--      frozen hash and refuses on mismatch; it never re-reads task.title/body itself.
--   2. title/body/note/reason edits are refused outright while a gate:office task is
--      in 'review' (src/mcp/index.ts's task_update, src/tasks/index.ts's PATCH) — the
--      row a human is looking at cannot change under them at all, belt-and-suspenders
--      with (1)'s hash check.
--   3. the freeze row is bound to the verdict that approved it (`verdict_id`) in the
--      SAME batch as the verdict write (buildVerdictStatements' own landed-PROOF
--      anchor, reused rather than re-derived — see office/service.ts's
--      writeOfficeVerdictAndBindFreeze), and voided (`voided_at`) in the same
--      transaction a reject or reversal lands. office.publish_post's one-shot claim
--      re-checks, IN ITS OWN CONDITIONAL UPDATE, that this freeze's verdict_id is
--      still the task's current, unreversed, approved verdict AND not voided.
--   4. the generic task_verdict surface (HTTP /:id/verdict, MCP task_verdict, the IM
--      human_origin path) now refuses outright to decide a gate:office task at all —
--      every office verdict must go through office.review_approval's own predicate.
--
-- ADD COLUMN + a new trigger only — office_publish_freezes (0179) is a brand-new leaf
-- table this addon owns outright, no children of its own, so this never touches
-- `tasks`/`task_verdicts`/any addon_* parent table or their CHECK constraints.
ALTER TABLE office_publish_freezes ADD COLUMN verdict_id TEXT;
ALTER TABLE office_publish_freezes ADD COLUMN voided_at TEXT;
ALTER TABLE office_publish_freezes ADD COLUMN voided_reason TEXT;

-- P3 (mupot#1592): "no DB trigger keeps a claimed row claimed" — claimed_at is the
-- one-shot execution guard office.publish_post's atomic claim UPDATE depends on
-- (migrations/0179); nothing in application code ever clears it back to NULL in
-- place, but nothing stopped a direct/future writer from doing so either, which
-- would silently re-open a one-shot slot for a WordPress write that already
-- happened. Scoped to `frozen_at` UNCHANGED — the review-entry freeze hook's own
-- rework-loop refreeze (src/addons/office/service.ts's freezeOfficeTaskOnReviewEntry
-- / persistOfficePublishFreeze, called from src/mcp/index.ts's task_update and
-- src/tasks/index.ts's PATCH on every entry into review, not from
-- office.review_approval any more — see this file's own header)
-- is a full INSERT ... ON CONFLICT DO UPDATE that legitimately resets claimed_at to
-- NULL for a BRAND NEW freeze generation, stamping a fresh `frozen_at`
-- (claimTimestamp(), src/lib/claim-timestamp.ts — unique enough per call that two
-- genuinely different freeze events never share one) in the SAME statement; that
-- must keep working. What this closes is a writer that clears claimed_at WITHOUT
-- any new freeze existing — an in-place un-claim on the SAME generation, which is
-- the only shape that would let a claimed one-shot slot be spent twice.
CREATE TRIGGER IF NOT EXISTS office_publish_freezes_claim_append_only
BEFORE UPDATE OF claimed_at ON office_publish_freezes
FOR EACH ROW
WHEN OLD.claimed_at IS NOT NULL AND NEW.claimed_at IS NULL AND NEW.frozen_at = OLD.frozen_at
BEGIN
  SELECT RAISE(ABORT, 'office_publish_freezes.claimed_at is append-only within one freeze generation');
END;
