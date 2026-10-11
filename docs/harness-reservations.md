# Harness reservations (mupot#1428)

`harness_reservations` (migration 0206) is the pre-dispatch ledger for vendor and local agent runs.

## Invariants

- **Insert first.** The reservation row (`task_id`/`flight_id` NULL) is INSERTed before any Task or Flight exists;
  its `UNIQUE (tenant, squad_id, adapter, idempotency_key)` is the idempotency lock. The loser of a race replays the
  row (or gets `idempotency_key_conflict`) and creates nothing. Only the inserter creates Task + Flight and binds
  them (`UPDATE ... WHERE task_id IS NULL`). NULL ids mean "reserved, not yet bound".
- **The attach lease is a fencing token, not a timer.** `claimAttachLease` returns a random `attach_lease_id`.
  Bind and fail writes by an attacher carry `AND attach_lease_id = ?`. An EXPIRED `attaching` row is never
  re-launched: it moves to `failed` with `last_error = 'launch_unconfirmed: lease_expired'` (the vendor POST may
  have landed). Reconcile that row by vendor lookup, never by re-launch.
- **Pause fence.** Dispatch checks `execution_pauses` before the reservation INSERT and again after the lease is
  claimed (the lease is handed back, row stays `reserved`).
- **Public errors are fixed codes** (`publicHarnessError`). Raw DB or vendor text never reaches an MCP caller.

## Reconcile has no scheduled caller yet

`listReconcileBatch` + `HarnessAdapter.reconcile` exist but nothing runs them. Until a scheduled entry or an
admin `harness_reconcile` tool (dry-run default) lands, `status()` reports `stuck: true` for any `reserved` or
`attaching` row not updated for 10 minutes, and `reconcile()` fails an unbound reservation past that horizon.

Issue stub: "harness: scheduled reconcile caller. Add a `router_tick`-style cron entry or admin MCP tool
`harness_reconcile` (dry_run default true, org-admin only, pause-fenced) that iterates `listReconcileBatch` and
calls the adapter's `reconcile`. Acceptance: a reservation stuck `reserved`/`attaching` > 10 min is surfaced and
resolved without operator SQL."
