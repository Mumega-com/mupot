-- 0210 - bind the producer receipt to the exact result it submitted.
--
-- gate:agent-self-completion verdict authority is "the agent that produced the CURRENT result".
-- The ledger row alone did not say WHICH result: supported writers replace tasks.result without
-- appending a submission (the CI-result sync, an artifact-shaped dispatch failure reason, a
-- blocked -> in_progress -> review walk), so a stale row could vouch for a result its agent never
-- wrote. result_text is the exact text that was submitted; the lane compares it to tasks.result
-- (text equality) inside the verdict UPDATE's WHERE.
--
-- ADD COLUMN only (no table rebuild: the append-only triggers from 0183 stay in force). Rows that
-- predate this migration keep result_text NULL and therefore fail closed on the lane (an org admin
-- still can). It also preserves the submitted text append-only, so clearing tasks.result on rework
-- no longer destroys the only verbatim copy of a rejected result.

ALTER TABLE task_result_submissions ADD COLUMN result_text TEXT;
