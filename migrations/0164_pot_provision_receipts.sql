-- 0164_pot_provision_receipts.sql — a receipt trail for provisionSovereignPot
-- (mupot#1285). One row per STEP attempted for one provisioning call, written
-- into the ORCHESTRATOR's own D1 (the same D1 that carries `pots`, migration
-- 0145) — not the tenant's own new D1, which gets the full schema chain
-- applied to it separately.
--
-- WHY THIS EXISTS
--
-- Before #1285, `provisionSovereignPot`'s honesty lived entirely in its return
-- value: `completed` / `not_completed` / `orphaned_resources` in the response
-- body of one call. Nobody persisted that body. A partial run that created a
-- billable D1 + KV and then failed left no queryable trace anywhere except an
-- operator's terminal scrollback — exactly the "orphan discovered on a bill"
-- failure #1285 documents (Psychonom's D1 `b0568c25...` / KV `061ebc1e...`,
-- live 2026-09-22, orphaned this exact way).
--
-- SHAPE follows the append-only receipt idiom already used by
-- task_dispatch_runtime_receipts (this file), member_home_provisioning_receipts
-- (0161) and project_access_grant_receipts (0157/0160): TEXT id (UUID), no
-- AUTOINCREMENT surrogate, append-only enforced by trigger not convention.
--
-- `step` is exactly the ProvisionStep union from src/pots/types.ts. `ok=0` with
-- `detail` naming the failure (statement index, HTTP error, health-check
-- response, ...) is a first-class row, not an absence of one — the same
-- "receipts, not grades" discipline as every other ledger in this schema.

-- Round-2 adversarial gate (Athena, mupot#1507): `actor_member_id` +
-- `actor_tenant` name WHO ran this provisioning call (never who it provisions
-- — that identity lives entirely on the CHILD pot, see "the provisioner's
-- authority ends at the handover" in docs/workflows/tenant-provision.md). Both
-- nullable: a Stripe-webhook self-serve call has no interactive member at all
-- (`checkout.ts` never sets `minted_by_member_id`). `detail` is a hard
-- CHECK boundary, not just a convention: no email address may ever appear in
-- it (a receipt is an operational ledger, not a place a customer's PII
-- accumulates), and it must stay valid JSON where the step schema expects
-- structure (`seed_identities`/`deploy_worker`/`verify_reachable`), so a
-- regression that starts interpolating a raw string back in is caught by the
-- database itself, not just code review.
CREATE TABLE IF NOT EXISTS pot_provision_receipts (
  id              TEXT NOT NULL PRIMARY KEY,
  tenant          TEXT NOT NULL,
  slug            TEXT NOT NULL,
  -- One provisionSovereignPot() call gets one run_id; its steps share it so
  -- they can be grouped back into one attempt.
  run_id          TEXT NOT NULL,
  step            TEXT NOT NULL CHECK (step IN (
    'create_d1', 'create_kv', 'apply_schema', 'deploy_worker',
    'seed_identities', 'verify_reachable'
  )),
  ok              INTEGER NOT NULL CHECK (ok IN (0, 1)),
  detail          TEXT CHECK (
    detail IS NULL
    OR (
      instr(lower(detail), '@') = 0
      AND (
        step NOT IN ('seed_identities', 'deploy_worker', 'verify_reachable')
        OR json_valid(detail)
      )
    )
  ),
  -- The CALLER's own identity — an org-admin's member id via the dashboard
  -- route or the MCP tool (both pass auth.memberId as minted_by_member_id).
  -- NULL for checkout.ts's self-serve path, which has no interactive member.
  actor_member_id TEXT,
  -- The CALLER's own tenant (auth.tenant at the moment of the call) — lets an
  -- operator distinguish "the home colony provisioned this" from a foreign
  -- caller, independent of `tenant` above (which is this receipt ROW's own
  -- storage tenant, always the orchestrator's).
  actor_tenant    TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_pot_provision_receipts_slug
  ON pot_provision_receipts(slug, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pot_provision_receipts_run
  ON pot_provision_receipts(run_id, created_at ASC);

CREATE TRIGGER IF NOT EXISTS pot_provision_receipts_no_update
  BEFORE UPDATE ON pot_provision_receipts
BEGIN
  SELECT RAISE(ABORT, 'pot_provision_receipts is append-only');
END;

CREATE TRIGGER IF NOT EXISTS pot_provision_receipts_no_delete
  BEFORE DELETE ON pot_provision_receipts
BEGIN
  SELECT RAISE(ABORT, 'pot_provision_receipts is append-only');
END;
