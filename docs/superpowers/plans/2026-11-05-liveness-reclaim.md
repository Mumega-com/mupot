# Liveness and dead-assignee reclaim

The shared reader keeps freshness, operator intent, delivery and execution/assignment eligibility separate. Stores remain separate. Existing dispatch receiver and delivery rules remain authoritative for those fields.

## Activity and residency

An agent is live when any valid activity source is fresh: fleet heartbeat under its registered TTL, presence within ten minutes, an online module heartbeat within 120 seconds, an active runtime-seat heartbeat under the fleet TTL, or a live credential-bound agent-session deadline. Source timestamps must be recognized stored date/time values; numeric or relative SQLite date strings do not establish activity.

Only real attach/attach-signed writes establish `connection_kind=fleet_attach`, using the existing column. A runtime label alone, boot self-report, or unsigned daemon report does not establish a resident heartbeat obligation. If a subsequent boot replaces attach provenance, reclamation stays disabled until attach renews it. Existing rows are not backfilled by assumption.

Poll registrations remain mailbox-deliverable between polls. Unknown/no-fresh-source agents are not automatically assigned; absence of an external runtime does not prove a live in-Worker process. Freshness does not override a stop or execution pause. Concierge retains explicit module-offline intent and roster ordering.

## Reclaim

An attach-backed resident must be dead on every observed activity source for strictly more than 24 hours before reclaim. The death clock uses the latest source deadline, not just the fleet timestamp. Unknown or malformed observed activity supplies no death proof. Poll and unproven interactive/Worker agents are never reclaimed by heartbeat age.

At most 25 open/in-progress tasks are reclaimed per tick. Live claims, unaccounted or unexpired receipt pointers, runnable dispatch, active flights, archive state, operator pauses and closed/review work are protected. The update reasserts ownership/status/timestamp, exact activity aggregates, current pause/custody and the old execution markers. A late heartbeat, check-in, session, dispatch or flight wins. Assignment updates evaluate the current shared liveness proof too.

The conditional audit shares the D1 batch with the update. Only proved-expired execution markers are cleared, with their old values retained in the audit. No receipt ledger is deleted.

## Owner notices

One logical owner batch lists that owner's reclaimed task IDs and audit IDs. It is sent only to live, non-paused owned-agent inboxes, excluding affected agents. Limits are three attempts per owner, 25 attempts per sweep and 200 recipient candidates examined. Failed sends consume the attempt budget. Missing owner, no eligible recipient, or lookup/send failure leaves the audit and committed reclaim intact; inbox enqueue does not claim human consumption.

## Scheduling and verification

The existing cron remains unchanged. There are 20 maintenance slots over 40 firing ticks/hour, so every job runs twice hourly. Reclaim is slot 19 at UTC minutes 24 and 54. Membership and metabolism previously ran three times/hour under 19 slots and now run twice; other second firings shift with the slot count.

Real migration-chain tests cover activity-source and dispatch parity, both gate probes, routing availability and current-write checks, custody races, pointer handoff, audit rollback, owner caps and cadence. Local native D1 checks supplement unit tests. Guard mutations, regenerated build-info/typecheck and the schema-source ratchet are required; the local full suite is skipped in favor of CI.

No migration or Worker configuration change is needed. Dashboard/routine display consumers remain follow-ups. No merge or deploy is part of this work.
