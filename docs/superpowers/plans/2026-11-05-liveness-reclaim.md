# Liveness and dead-assignee reclaim plan

**Goal:** Give concierge and router one liveness read contract and recover only tasks whose resident assignee is provably long-dead with no execution custody.

**Contract:** Keep freshness, operator pause, delivery route and execution eligibility separate. Use the fleet registry's canonical exact-ID/unambiguous-slug lookup, per-row TTL and routing derivation. The modes actually registered are poll and resident; no registered external surface routes in-Worker. Attached polling seats follow their registered poll mode.

- Resident: live through the existing fleet TTL, stale to 2x TTL, then dead. Reclaim requires a further 24 hours and a valid observed timestamp.
- Poll: the same registered TTL measures freshness, but stale polling mailboxes remain deliverable and never become reclaimable from age alone.
- In-Worker: missing external heartbeats do not prove death.
- Operator-stopped, agent-paused or execution-paused agents are paused and never reclaimed.
- Automatic assignment excludes dead and paused states. Execution eligibility and delivery continue matching dispatch's receiver fence and route.

**Read architecture:** Batch agent/fleet resolution and pause facts, sharing the registry's route derivation rather than creating a second rule. Keep stores separate. Concierge retains project/shared roster capabilities and explicit module offline intent; its 120-second derived display status no longer decides execution liveness. Router removes the independent ten-minute presence clock. Dashboard migration remains a follow-up.

**Reclaim architecture:** Select only dead resident agents past the threshold, then at most 25 open/in-progress tasks. A guarded UPDATE rechecks assignee, status, timestamp, liveness snapshot, pause state, archive state and absence of live claims, unaccounted execution receipts, runnable dispatch and active flight custody. Clear only the execution markers already proven expired, fence their pre-update values and retain them in the audit. Pair the update with a conditional audit in one D1 batch. Send informational notices after commit to the owner's other agents; a missing owner/recipient or send failure never reverses reclamation.

**Cadence:** Append one entry to the existing maintenance array: 20 slots over 40 cron ticks/hour. New slot index 19 runs at minutes 24 and 54 (twice hourly). No cron configuration change.

**Verification:** Real migration-chain tests; mode/dispatch parity, routing parity, pause and execution exclusions, concurrent reassignment/heartbeat wins, owner notices, audit rollback, 25-row bound, cadence wiring. Mutate each new guard, then run related suites, regenerate build-info, typecheck and schema-source check. Skip the local full suite; leave the PR draft and do not merge or deploy.

No migration is planned: existing heartbeat, task execution, ownership and audit/message stores provide the required evidence.
