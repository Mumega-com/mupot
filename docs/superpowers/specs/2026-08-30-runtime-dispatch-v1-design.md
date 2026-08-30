# Runtime Dispatch v1 and Exact Runtime Receipts Design

**Issue:** Mumega-com/mupot#1240  
**Status:** approved by Hadi on 2026-08-30  
**Executor:** Hadi Codex (`087a816b-ab9f-400f-8d53-f6f97b94a725`)  
**Independent gate:** Hadi-grok

## Outcome

An assigned Mupot task delivered to an external desktop runtime has a versioned,
data-derived envelope and a native receipt path that distinguishes transport,
runtime consumption, completion/failure, artifact evidence, review, and gate
verdict. Retries are idempotent and authority is revalidated on every write.

## Existing State and Boundary

`task_dispatch_receipts.consumed_at` currently means the Queue consumer completed
its selected delivery side effect. For the external route, that side effect is a
durable `agent_messages` row from `mupot-dispatch`; it is not proof that a desktop
runtime consumed the task.

The Flight-3 fenced-delivery schema is not the ordinary task-dispatch contract. It
requires an objective, flight, assignment epoch, runtime seat generation,
encrypted-envelope ingress receipt, registered authorities, and signed evidence.
Ordinary tasks may have none of those. #1240 must not invent those facts or weaken
the Flight-3 schema to make ordinary dispatch fit.

The new `task_dispatch_runtime_receipts` table is therefore a narrow projection
anchored by foreign keys to `task_dispatch_receipts`, `tasks`, `agents`, and the
exact `agent_messages` delivery row. It is not a replacement for the signed Flight-3
execution receipt chain.

## Versioned External Envelope

`src/bus/fleet-bridge.ts` emits:

```json
{
  "version": "runtime.dispatch/v1",
  "type": "task_dispatch",
  "task_id": "task-id",
  "dispatch_receipt_id": "dispatch-id",
  "squad_id": "squad-id",
  "runtime_address": "data-derived-public-address"
}
```

The Queue consumer derives `runtime_address` from the same persisted fleet-liveness
route used to select the external inbox. Callers cannot supply it. Raw harness
thread/session identifiers remain host-private.

The authenticated inbox lease remains authoritative for message ID, sequence,
outer sender, target address, project, creation time, lease expiry, and
`delivery_attempts`. The body cannot override those facts.

## Runtime Receipt Operation

MCP tool `task_dispatch_runtime_receipt` and REST route
`POST /api/tasks/:id/runtime-receipts` accept:

```json
{
  "dispatch_receipt_id": "dispatch-id",
  "message_id": "message-id",
  "stage": "runtime_consumed | completed | failed",
  "runtime_receipt_hash": "64-lowercase-hex",
  "attempt": 1,
  "artifact_refs": [],
  "artifact_sha256": null,
  "result": null,
  "reason": null
}
```

The task ID comes from the route or the MCP arguments and must match the persisted
dispatch. The authenticated workspace token supplies the member and bound agent.

### Current-authority checks

Immediately before every new receipt write and before every replay response:

- channel is `workspace` and the token is agent-bound;
- tenant matches the pot;
- the bound agent is active and equals the dispatch receipt assignee;
- the task still names that agent and remains on the same squad/project;
- the member retains `member+` on the task squad, including department inheritance;
- cross-squad assignment remains valid through `resolveTaskAssignee`;
- dispatch receipt, exact external inbox row, sender `mupot-dispatch`, request ID,
  body correlations, project attribution, runtime address, and delivery attempt all
  match;
- the delivery is not dead-lettered, superseded, terminal, or stale.

Changed or revoked authority yields no receipt and no task mutation.

### Idempotency

The unique key is `(tenant, dispatch_receipt_id, stage, attempt)`. The service
canonicalizes the complete request and stores its SHA-256 digest. An identical
retry reauthorizes and returns the original row. Different content under the same
key returns `409 runtime_receipt_conflict`.

### State effects

- `runtime_consumed`: requires the exact leased delivery attempt; atomically records
  the receipt and moves `open|blocked|rejected` to `in_progress`, binding
  `tasks.execution_receipt_id` to the dispatch receipt. It never completes work.
- `completed`: requires an earlier consumed receipt for the same attempt and an
  `in_progress` task bound to the same dispatch. It records result/evidence and
  moves the task to `review`, never `done`.
- `failed`: requires consumed or a still-current delivery attempt, stores a bounded
  reason, and moves the task to `blocked`. It never redispatches automatically.

Completion requires at least one artifact reference plus one lowercase SHA-256
when the task's `done_when` contains an explicit `Artifact:` or `SHA256:` predicate.
The existing artifact-verification helper remains the parser of that requirement.

Mutations and receipt inserts execute in one D1 batch with a changes-count guard;
guard failure rolls back the batch. A mutation audit entry records the exact
principal, credential, task, dispatch, message, stage, attempt, and request digest.

## Operator UI and Readback

The `/send` Dispatch-now form adds an editable, required `done_when` field. It sends
that exact value instead of the current generic hard-coded predicate. The page
reads the created task back before dispatch status polling.

Task JSON readback and the dashboard show separate receipt stages:

- transport delivered;
- runtime consumed;
- completed or failed;
- task review;
- independent gate verdict.

No stage is inferred from another.

## Testing and Canary

Tests use the full migration chain and real SQLite. They cover versioned envelope
derivation, exact outer-row correlation, authorization drift, idempotent replay,
changed-content conflict, attempt/generation mismatch, completion ordering,
artifact enforcement, REST/MCP parity, `/send` exact predicates, dashboard
separation, and sticky external routing.

The synthetic canary runs against local D1 and fake host/runtime adapters only. It
must produce one chain:

`dispatch -> external inbox -> runtime_consumed -> completed -> review -> gate`

Interruption tests restart after transport and after consumption and prove one
runtime-consumed row, one completion row, and no duplicate task mutation. The
active Hadi-assistant voice task is never selected or addressed.

## Operational Boundaries

This branch may create a draft PR. It does not deploy, install a receiver, alter
Codex configuration, expose credentials, or activate production. Hadi-grok gates
the exact SHA before any merge or live canary.
