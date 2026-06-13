-- #142 capsule keystone: every task must carry a verifiable success predicate.
-- done_when is a required field on new tasks (enforced in the application layer).
-- Existing rows get a sentinel default so the column is NOT NULL without
-- breaking reads on live data. Operators should backfill real predicates
-- via a PATCH to the task body/done_when on active tasks.
--
-- NOT applied to production automatically — apply on review.

ALTER TABLE tasks ADD COLUMN done_when TEXT NOT NULL DEFAULT '(backfill required)';
