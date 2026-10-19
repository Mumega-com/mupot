-- 0244_provider_kernel.sql -- provider kernel (harness/kernel.ts): per-run bookkeeping on harness_reservations.
--
-- Every provider dispatch now passes one kernel: kill switch -> checkAndReserve (budget) BEFORE launch -> reservation ->
-- (optional) per-run short-lived mupot token -> launch -> reconcile -> finalize. These columns carry what finalize needs:
--   estimate_micro_usd   the pre-call estimate the meter reserved against (booked at finalize when the vendor reports no usage)
--   run_token_id / run_token_member_id   the per-run mupot credential, revoked at finalize (NULL when the adapter has no callback)
--   finalized_at         set exactly once, by the one finalizer that books usage, revokes the token and cleans up
--   usage_cost_micro_usd / usage_estimated   what finalize booked, and whether it was an ESTIMATE (vendor exposes no usage)
-- Additive only: ADD COLUMN, no rebuild, no data rewrite. Existing rows keep NULLs and finalize treats them as "nothing to settle".

ALTER TABLE harness_reservations ADD COLUMN estimate_micro_usd INTEGER;
ALTER TABLE harness_reservations ADD COLUMN run_token_id TEXT;
ALTER TABLE harness_reservations ADD COLUMN run_token_member_id TEXT;
ALTER TABLE harness_reservations ADD COLUMN finalized_at TEXT;
ALTER TABLE harness_reservations ADD COLUMN usage_cost_micro_usd INTEGER;
ALTER TABLE harness_reservations ADD COLUMN usage_estimated INTEGER;

CREATE INDEX IF NOT EXISTS idx_harness_reservations_unfinalized
  ON harness_reservations (tenant, state, finalized_at);
