-- Task execution results. The task-execution loop (AgentDO execute-mode cortex
-- cycle) writes the model output back onto the task row and stamps a completion
-- time, so "send a task → an agent does it → the result persists" is durable and
-- readable by the dashboard /send poller and the GET /api/tasks/:id API.
--
-- Both columns are nullable: an open/in_progress task has no result yet, and a
-- task may finish (done) or fail (blocked) — completed_at is set in either
-- terminal case (it marks "execution finished", not "succeeded").

ALTER TABLE tasks ADD COLUMN result TEXT;
ALTER TABLE tasks ADD COLUMN completed_at TEXT;
