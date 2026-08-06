-- 0077: provenance-tag tasks that arrive via a governed external integration (PR #659
-- diverse-model gate P0, filed against the Linear read-only board connector).
--
-- migrations/0063 added `source_pot` for the SAME reason on the project-link (pot-to-pot)
-- path: a reading agent that later picks up a task must be able to tell "this title/body
-- came from an untrusted, non-local writer" before it lets that content reach a model
-- turn or an unattended auto-assign. That column's name and its downstream checks
-- (canAgentExecuteTask, routeUnassignedWork, the admin-gated reassignment guard) are
-- specific to the project-link mechanism (a signed remote pot). Linear is a DIFFERENT
-- untrusted-writer class -- anyone with edit rights on the bound Linear team, no
-- pot-to-pot signature involved -- so it gets its own marker rather than overloading
-- source_pot's "remote pot slug" meaning. `external_source` generalizes the SAME
-- trust invariant: NULL for every locally-created task (the existing, trusted path);
-- set to an opaque, integration-defined string (e.g. `linear:<teamKey>`) when the row
-- was written by an external, less-trusted importer. NULL-vs-non-NULL is the trust
-- boundary; no CHECK/FK constraint is added, mirroring 0063's reasoning -- the value is
-- a display/audit string, never joined against another table.
--
-- The P0 this closes: `skipEvent`/`skipMirror` on Linear-imported tasks suppressed the
-- EVENT wake, but two status-POLLING drivers never looked at events at all --
-- canAgentExecuteTask's unassigned-auto-pickup branch (src/agents/execute.ts) and the
-- concierge's routeUnassignedWork cron (src/concierge/service.ts) -- and neither had any
-- column to test, because no provenance was persisted at create time. Both are updated
-- (same PR) to also exclude `external_source IS NOT NULL`, so a Linear-origin task is
-- structurally indistinguishable from a cross-pot task for every trust decision that
-- already existed for source_pot: no auto-pickup, no unattended auto-assign, admin-gated
-- reassignment, and the untrusted-content prompt fence.

ALTER TABLE tasks ADD COLUMN external_source TEXT;

-- Read-path index: "show me all tasks that came from a governed external integration"
-- (dashboard/MCP provenance filter, audit) without a full table scan. Partial index --
-- the vast majority of rows are local (external_source IS NULL) and gain nothing from
-- being indexed here. Mirrors idx_tasks_source_pot (migrations/0063).
CREATE INDEX IF NOT EXISTS idx_tasks_external_source ON tasks(external_source) WHERE external_source IS NOT NULL;
