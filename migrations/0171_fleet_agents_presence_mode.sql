-- 0171_fleet_agents_presence_mode.sql — poll-mode presence for external runners (mupot#1494).
--
-- Additive only, no backfill: every existing row keeps presence_mode='' and
-- presence_ttl_sec=NULL, so src/fleet/registry.ts's derivePresence keeps reading the ONE global
-- presenceTtlSec(env) window for every row this migration doesn't touch — resident/signed-attach
-- semantics are completely unchanged.
--
-- Why this is needed: a polling runner (cron, an external orchestrator, a laptop that wakes
-- every N minutes — no resident heartbeat daemon) has no way to stay inside the global
-- presence_ttl_sec window without polling far more often than its own cadence justifies, so
-- task_dispatch's liveness check never saw it as live and it could never receive dispatched
-- work (see the issue's "Runner onboarding is not smooth" report). check_in accepts
-- presence_mode:'poll' + poll_interval_sec, computes a per-row TTL
-- (max(180, 2*poll_interval_sec) — see pollPresenceTtlSec) and stores it here; last_reported_at
-- is then refreshed on every subsequent authenticated call that agent makes
-- (touchPollFleetPresence), so a faithfully-polling runner reads as continuously live on its
-- own declared cadence.
ALTER TABLE fleet_agents ADD COLUMN presence_mode TEXT NOT NULL DEFAULT '';
ALTER TABLE fleet_agents ADD COLUMN presence_ttl_sec INTEGER;

-- mupot#1494 round 3 (P2-a) — `squads` has two independent writers (reportFleetAgents, the
-- daemon's bulk self-report; upsertPollFleetPresence, check_in(presence_mode:'poll')) that
-- used to plainly overwrite each other's contribution on ON CONFLICT. This column tracks the
-- POLL writer's own last contribution (its current home-squad slug, or NULL) SEPARATELY from
-- the column both writers share, so each writer's ON CONFLICT can replace exactly its own
-- portion and union in the other's, instead of either accumulating stale values forever or
-- clobbering the other side's membership. Additive, nullable, no backfill: every existing row
-- reads NULL (no poll contribution recorded), which both merge formulas already treat as
-- "nothing to preserve/remove" — a resident-only row is unaffected.
ALTER TABLE fleet_agents ADD COLUMN poll_home_squad_slug TEXT;

-- Second half of #1494: task_dispatch's routing decision (src/bus/consumer.ts routeEvent,
-- 'agent.wake' case) must "never silently" fall back to the in-Worker executor — record which
-- route was actually taken, durably, on the SAME receipt row a caller/operator already reads
-- for dispatch state. Additive, nullable, no backfill: a NULL here just means "dispatched before
-- this migration" (or an event still mid-flight), not a distinct third route.
ALTER TABLE task_dispatch_receipts ADD COLUMN delivered_via TEXT
  CHECK (delivered_via IS NULL OR delivered_via IN ('inbox', 'in_worker'));

-- ── mupot#1494 v4 (P1-a, adversarial round 2 on PR #1514) ──────────────────────────────────
--
-- task_dispatch_lease_reset's repair (adminResetDispatchLease, src/tasks/runtime-receipts.ts)
-- resets a wedged agent_messages row's lease bookkeeping, but left NO trace on
-- task_dispatch_receipts/task_dispatch_runtime_receipts — so hasInFlightDispatchReceipt (which
-- keys ONLY on a terminal 'completed'/'failed' runtime receipt) kept reporting the dispatch as
-- still in-flight even after a `reset(override:true)` on a genuinely dead runner. PROVED: reset
-- succeeds, reassignment still refuses 409 task_dispatch_in_flight, unassignment also refuses,
-- and (worse) a FRESH task_dispatch SUCCEEDS anyway — contradicting toolTaskDispatch's own
-- documented task_not_dispatchable guard and reopening exactly the orphaned-dispatch class
-- P2-5 exists to close. There was no operator path out of a dead-runner wedge at all.
--
-- Fix: adminResetDispatchLease's new `terminate: true` option writes a REAL terminal
-- task_dispatch_runtime_receipts row (stage='reset_terminated') alongside the lease reset, so
-- hasInFlightDispatchReceipt sees the dispatch as settled (reassign/unassign become possible)
-- and toolTaskDispatch's own new in-flight guard (mirroring hasInFlightDispatchReceipt) refuses
-- a fresh dispatch while any earlier one is genuinely still unsettled.
--
-- 0138's CHECK (stage IN ('runtime_consumed', 'completed', 'failed')) hard-refuses this new
-- value — SQLite has no ALTER COLUMN / ALTER CONSTRAINT, so this is the same table-rebuild
-- migrations/0042 (tasks.status), 0158 (routine_run_actions.kind), and 0165
-- (member_home_provisioning_receipts.channel) already used for exactly this shape of change:
-- rebuild the table with every column, FK, index, and trigger unchanged except the widened
-- CHECK. WIDEN, DON'T RELABEL (same discipline as 0165) — no existing row's `stage` value is
-- touched, only the set of values a FUTURE row may carry is expanded.
--
-- task_dispatch_runtime_receipts is UNAPPLIED IN PRODUCTION as of this writing (created by
-- 0138, and this file is branch/schema-only per this repo's own established convention — a
-- human applies it; renumbered 0163 -> 0168 -> 0171 as sibling in-flight PRs claimed the
-- numbers in between, see git history); this rebuild is still written as fully
-- ROW- AND VALUE-PRESERVING (straight column copy, no CASE/relabel) so it is correct
-- regardless of whether production data exists by the time it is actually applied — same
-- posture 0165 took after discovering its own "unapplied" assumption was wrong once already.
--
-- PRAGMA foreign_keys is decorative on D1 (same precedent as 0049/0069/0116/0165) but real
-- under this repo's own local node:sqlite migration test harness — kept for both.

PRAGMA foreign_keys = off;

CREATE TABLE task_dispatch_runtime_receipts_new (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  dispatch_receipt_id TEXT NOT NULL
    REFERENCES task_dispatch_receipts(id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  message_id TEXT NOT NULL REFERENCES agent_messages(id) ON DELETE RESTRICT,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  credential_id TEXT NOT NULL REFERENCES member_tokens(id) ON DELETE RESTRICT,
  stage TEXT NOT NULL CHECK (stage IN ('runtime_consumed', 'completed', 'failed', 'reset_terminated')),
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 5),
  runtime_address TEXT NOT NULL CHECK (length(trim(runtime_address)) BETWEEN 1 AND 255),
  runtime_receipt_hash TEXT NOT NULL CHECK (
    length(runtime_receipt_hash) = 64
    AND runtime_receipt_hash = lower(runtime_receipt_hash)
    AND runtime_receipt_hash NOT GLOB '*[^0-9a-f]*'
  ),
  request_digest TEXT NOT NULL CHECK (
    length(request_digest) = 64
    AND request_digest = lower(request_digest)
    AND request_digest NOT GLOB '*[^0-9a-f]*'
  ),
  artifact_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(artifact_refs_json)
    AND json_type(artifact_refs_json) = 'array'
  ),
  artifact_sha256 TEXT CHECK (
    artifact_sha256 IS NULL
    OR (
      length(artifact_sha256) = 64
      AND artifact_sha256 = lower(artifact_sha256)
      AND artifact_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  result TEXT CHECK (result IS NULL OR length(result) BETWEEN 1 AND 20000),
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 2000),
  audit_entry_id TEXT NOT NULL UNIQUE
    REFERENCES mutation_audit_entries(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  CHECK (stage <> 'completed' OR result IS NOT NULL),
  CHECK (stage <> 'failed' OR reason IS NOT NULL),
  UNIQUE (tenant, dispatch_receipt_id, stage, attempt)
);

-- Row- AND value-preserving: every column copied as-is, no CASE/relabel.
INSERT INTO task_dispatch_runtime_receipts_new (
  id, tenant, dispatch_receipt_id, task_id, agent_id, message_id,
  member_id, credential_id, stage, attempt, runtime_address,
  runtime_receipt_hash, request_digest, artifact_refs_json,
  artifact_sha256, result, reason, audit_entry_id, created_at
)
SELECT
  id, tenant, dispatch_receipt_id, task_id, agent_id, message_id,
  member_id, credential_id, stage, attempt, runtime_address,
  runtime_receipt_hash, request_digest, artifact_refs_json,
  artifact_sha256, result, reason, audit_entry_id, created_at
FROM task_dispatch_runtime_receipts;

DROP TABLE task_dispatch_runtime_receipts;
ALTER TABLE task_dispatch_runtime_receipts_new RENAME TO task_dispatch_runtime_receipts;

-- Indexes dropped with the table above — recreated verbatim from 0138.
CREATE INDEX idx_task_dispatch_runtime_receipts_task
  ON task_dispatch_runtime_receipts(tenant, task_id, created_at, id);

CREATE INDEX idx_task_dispatch_runtime_receipts_message
  ON task_dispatch_runtime_receipts(tenant, message_id, attempt, stage);

-- Triggers dropped with the table above — recreated verbatim from 0138.
CREATE TRIGGER task_dispatch_runtime_receipts_no_update
BEFORE UPDATE ON task_dispatch_runtime_receipts
BEGIN
  SELECT RAISE(ABORT, 'task dispatch runtime receipts are append-only');
END;

CREATE TRIGGER task_dispatch_runtime_receipts_no_delete
BEFORE DELETE ON task_dispatch_runtime_receipts
BEGIN
  SELECT RAISE(ABORT, 'task dispatch runtime receipts are append-only');
END;

PRAGMA foreign_keys = on;

-- ── mupot#1494 v4 (P1-b, adversarial round 2 on PR #1514) ──────────────────────────────────
--
-- One-time backfill for the "one agent, two fleet_agents rows" defect: the poll writer
-- (upsertPollFleetPresence) always keyed on the caller's own `agents.id` (a uuid); the daemon
-- report / signed-attach writers keyed on the reported SLUG. Both shapes satisfy
-- fleet_agents' own AGENT_ID_RE, so they coexisted as two different PRIMARY KEY rows for the
-- same real agent. src/fleet/registry.ts's `resolveFleetWriteAgentId` (this PR) stops any NEW
-- duplicate from being created; this backfill repairs rows that already exist.
--
-- Case A — a slug-keyed row with NO existing uuid-keyed counterpart: safe to rename onto its
-- canonical `agents.id` in place (no PK conflict, no data loss).
UPDATE fleet_agents
   SET agent_id = (SELECT id FROM agents WHERE slug = fleet_agents.agent_id)
 WHERE NOT EXISTS (SELECT 1 FROM agents WHERE id = fleet_agents.agent_id)
   AND (SELECT COUNT(*) FROM agents WHERE slug = fleet_agents.agent_id) = 1
   AND NOT EXISTS (
     SELECT 1 FROM fleet_agents other
      WHERE other.tenant = fleet_agents.tenant
        AND other.agent_id = (SELECT id FROM agents WHERE slug = fleet_agents.agent_id)
   );

-- Case B — a genuine duplicate: BOTH a slug-keyed row and its resolved uuid-keyed row already
-- exist. The uuid-keyed row is the one every writer converges on going forward and the one
-- dispatch routing already reads by (src/mcp/index.ts, src/bus/consumer.ts) — the redundant
-- slug-keyed row is deleted, but NOT before its display fields are merged forward and the
-- merge is receipted.
--
-- mupot#1494 v4 round 2 (P2-b, adversarial regression) — round 1 deleted the slug-keyed row
-- outright, reasoning "fleet_agents is a DISPLAY cache, never authority... re-populated by
-- the next report" — true for the common case (daemon reports display/runtime/host on a
-- regular cadence), but WRONG for the shape actually seen in practice: the uuid-keyed row is
-- typically the POLL writer's (`upsertPollFleetPresence` never sets display/runtime/host —
-- only `agent_id`/`squads`/`presence_mode`/timestamps), so round 1 kept the EMPTY row and
-- discarded the RICH one, and there is no guarantee a "next report" ever comes for an agent
-- that has switched fully to poll mode. Fixed: merge forward, per column, ONLY where the
-- surviving uuid row's own value is still empty/default (never clobber a real value the
-- uuid row already carries), and RECEIPT the merge to `mutation_audit_entries` (operation
-- `fleet_agents_dedup_merge`) before the delete, so the merge is an auditable fact, not a
-- silent DB patch — same discipline as `adminResetDispatchLease`'s own audit trail.
--
-- Part 1 — MERGE forward (before the DELETE, while the slug row's values are still readable).
UPDATE fleet_agents
   SET display = CASE WHEN display = '' THEN COALESCE((
         SELECT s.display FROM fleet_agents s
          WHERE s.tenant = fleet_agents.tenant AND s.agent_id = (SELECT slug FROM agents WHERE id = fleet_agents.agent_id)
       ), '') ELSE display END,
       runtime = CASE WHEN runtime = '' THEN COALESCE((
         SELECT s.runtime FROM fleet_agents s
          WHERE s.tenant = fleet_agents.tenant AND s.agent_id = (SELECT slug FROM agents WHERE id = fleet_agents.agent_id)
       ), '') ELSE runtime END,
       squads = CASE WHEN squads = '[]' THEN COALESCE((
         SELECT s.squads FROM fleet_agents s
          WHERE s.tenant = fleet_agents.tenant AND s.agent_id = (SELECT slug FROM agents WHERE id = fleet_agents.agent_id)
       ), '[]') ELSE squads END,
       host = CASE WHEN host = '' THEN COALESCE((
         SELECT s.host FROM fleet_agents s
          WHERE s.tenant = fleet_agents.tenant AND s.agent_id = (SELECT slug FROM agents WHERE id = fleet_agents.agent_id)
       ), '') ELSE host END
 WHERE EXISTS (SELECT 1 FROM agents WHERE id = fleet_agents.agent_id)
   AND (SELECT COUNT(*) FROM agents WHERE slug = (SELECT slug FROM agents WHERE id = fleet_agents.agent_id)) = 1
   AND EXISTS (
     SELECT 1 FROM fleet_agents s
      WHERE s.tenant = fleet_agents.tenant
        AND s.agent_id = (SELECT slug FROM agents WHERE id = fleet_agents.agent_id)
   );

-- Part 2 — RECEIPT the merge. Deterministic id/request_id (not randomblob) so a re-run of
-- this migration on the same data is a clean PK-conflict failure, never a silent duplicate.
INSERT INTO mutation_audit_entries (
  id, tenant, principal_kind, principal_id, agent_id,
  origin, handler, operation, target_kind, target_id, request_id, idempotency_key,
  evidence_json, recorded_at
)
SELECT
  'migration-0171-dedup:' || uuid_row.tenant || ':' || uuid_row.agent_id,
  uuid_row.tenant, 'migration', 'migration:0171_fleet_agents_presence_mode', uuid_row.agent_id,
  'migration', 'migrations/0171_fleet_agents_presence_mode', 'fleet_agents_dedup_merge',
  'fleet_agents', uuid_row.agent_id,
  'migration-0171-dedup:' || uuid_row.tenant || ':' || uuid_row.agent_id,
  'migration-0171-dedup:' || uuid_row.tenant || ':' || uuid_row.agent_id,
  json_object(
    'merged_from_agent_id', slug_row.agent_id,
    'merged_display', slug_row.display,
    'merged_runtime', slug_row.runtime,
    'merged_squads', slug_row.squads,
    'merged_host', slug_row.host
  ),
  datetime('now')
FROM fleet_agents uuid_row
JOIN agents a ON a.id = uuid_row.agent_id
JOIN fleet_agents slug_row ON slug_row.tenant = uuid_row.tenant AND slug_row.agent_id = a.slug
WHERE (SELECT COUNT(*) FROM agents WHERE slug = a.slug) = 1;

-- Part 3 — delete the now-redundant slug-keyed row (its useful fields already merged above).
DELETE FROM fleet_agents
 WHERE NOT EXISTS (SELECT 1 FROM agents WHERE id = fleet_agents.agent_id)
   AND (SELECT COUNT(*) FROM agents WHERE slug = fleet_agents.agent_id) = 1
   AND EXISTS (
     SELECT 1 FROM fleet_agents other
      WHERE other.tenant = fleet_agents.tenant
        AND other.agent_id = (SELECT id FROM agents WHERE slug = fleet_agents.agent_id)
   );

-- UNMAPPED ROWS (neither Case A nor Case B touches these — left exactly as-is, on purpose):
-- a row whose agent_id matches NO real agent's id or slug at all (an external/generic runtime
-- identifier never onboarded as a full mupot agent — a normal, expected shape for this table),
-- or one whose agent_id happens to be an AMBIGUOUS slug (shared by agents in different squads
-- — agents.slug is UNIQUE(squad_id, slug), not tenant-wide). Neither case is safe to guess
-- through; a human applying this migration should run
-- `SELECT agent_id FROM fleet_agents WHERE tenant = '<tenant>' AND NOT EXISTS (SELECT 1 FROM
-- agents WHERE id = fleet_agents.agent_id OR slug = fleet_agents.agent_id)` before and after
-- to confirm this migration only ever REMOVES rows from that unmapped set (via Case A's
-- rename), never adds to it, per Kasra's "no fake green — receipts, not grades" rule.
