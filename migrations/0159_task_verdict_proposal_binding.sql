-- 0159_task_verdict_proposal_binding.sql — bind a verdict to the SPECIFIC
-- routine proposal it decides (FP-01 Slice 2 v2, successor to mupot#1443/
-- PR #1488, adversarial P0-2 + Athena's design ruling on the successor
-- brief: "a dedicated proposal_id COLUMN on task_verdicts ... NOT
-- human_origin text"). NOT applied by this build — branch/schema only,
-- exactly like 0143/0144/0147/0148/0157/0158 before it; a human applies it.
--
-- THE BUG THIS CLOSES
--
-- PR #1488's approvedGate/latestTaskVerdict (src/routines/actions.ts) read
-- `SELECT ... FROM task_verdicts WHERE task_id = ? ORDER BY decided_at DESC
-- LIMIT 1` — "the latest verdict on the control task", never bound to the
-- proposal it is supposed to authorize. An agent could submit a
-- project_access proposal AFTER an unrelated earlier approval of the same
-- long-lived control task and have that stale verdict count as authorizing
-- a decision the human never saw. See ADVERSARIAL PATTERN LIBRARY finding 2
-- (kasra-review, 2026-09-21, PR #1488).
--
-- proposal_id is nullable: every pre-existing task_verdicts row (ordinary
-- task approvals with no routine proposal behind them) has no proposal to
-- bind to and stays NULL forever — this is additive, not a backfill.
--
-- reversed_at (Athena's design ruling, successor brief): task_verdict_reverse
-- previously wrote NO new task_verdicts row at all (it only flipped the task
-- back to 'review' via task_update) — a reversed approval stayed the
-- "latest approved verdict" for any proposal_id-bound read. reversed_at
-- marks the verdict row itself as reversed IN PLACE (task_verdicts is
-- otherwise append-only with no UPDATE path from any route — this is the
-- one narrow, additive exception: a single nullable timestamp column that
-- can move from NULL to a value exactly once, never back, and touches no
-- other column). Any reader that must not honor a reversed verdict
-- (src/routines/actions.ts's proposal-bound grant check) filters
-- `reversed_at IS NULL` explicitly.

ALTER TABLE task_verdicts ADD COLUMN proposal_id TEXT;
ALTER TABLE task_verdicts ADD COLUMN reversed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_task_verdicts_proposal
  ON task_verdicts(proposal_id);
