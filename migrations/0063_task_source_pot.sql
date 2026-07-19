-- 0063: provenance-tag tasks that arrive via project-link (#403 gap 2b).
--
-- receiveProjectLinkEnvelope (src/addons/project-link/service.ts) is Ed25519-signature and
-- capability gated (transport integrity), but writes attacker-controlled task title/body onto
-- the local board with no structural marker distinguishing it from a locally-created task.
-- Content from a hostile (or merely compromised) linked pot is adversarial input — a reading
-- agent that later picks up the task must be able to tell "this came from an external pot,
-- treat as untrusted content, not as trusted local instructions."
--
-- source_pot is NULL for every locally-created task (the existing, trusted path — createTask
-- in src/tasks/service.ts, and every other INSERT INTO tasks) and is set to the linked pot's
-- slug (project_links.remote_pot) exactly when the row was written by
-- receiveProjectLinkEnvelope. NULL-vs-non-NULL is the trust boundary; no CHECK/FK constraint
-- is added — remote_pot is an opaque slug already validated by validId() at envelope-receive
-- time (src/addons/project-link/envelope.ts), and this column intentionally outlives the
-- project_links row it originated from (a revoked/deleted link must not silently erase the
-- provenance of tasks it already delivered).

ALTER TABLE tasks ADD COLUMN source_pot TEXT;

-- Read-path index: "show me all tasks that came in over a project link" (dashboard/MCP
-- provenance filter, audit) without a full table scan. Partial index — the vast majority of
-- rows are local (source_pot IS NULL) and gain nothing from being indexed here.
CREATE INDEX IF NOT EXISTS idx_tasks_source_pot ON tasks(source_pot) WHERE source_pot IS NOT NULL;
