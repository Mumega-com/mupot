# Task 1 Report — External Agent Wake Routing

Date: 2026-08-25

Branch: `codex/wake-external-route`

Plan/base commit: `33e33e4df3ab09b467815e63774f741ad7ff2f1d`

Implementation commit: `a709770bd49914810ef84fa0fe2c64d2623346dc`

Independent-gate correction commit: `8f0d1068e7fde88246df3f82a593d82f841836d3`

Final delivery-boundary correction commit: `cb061e318546c088d777d65498a69da2c99d5778`

Evidence-only real-send test commit: `6acd0bdaa1087eef531fc6c0969acf3b46cf1ab1`

## Result

Implemented the bounded external-agent wake-routing repair with one shared service used by
MCP `wake_agent` and IM wake:

- a live external fleet route receives one durable `agent.wake/v1` inbox envelope at the
  external identity resolved by `getFleetAgentLiveness`, without an AgentDO call;
- an internal route calls AgentDO exactly once and writes no fallback envelope when it succeeds;
- a failed AgentDO writes one durable fallback envelope to the exact fleet identity already
  resolved by `getFleetAgentLiveness` (even when stale), or to the canonical UUID when that
  resolver returns no safe identity;
- a failed fallback returns fixed `wake_failed` without reflecting Durable Object or database
  bodies;
- the durable envelope preserves canonical agent UUID, reason, optional context, normalized
  `maxActions`, and one bounded sender-scoped idempotency key;
- the post-commit `agent.wake` observation is marked `already_routed=true`, and the Queue
  consumer acknowledges it without a second action;
- normal generic Queue wake behavior remains AgentDO-backed.

## RED evidence

Command:

```text
npx vitest run tests/wake-routing.test.ts tests/bus-consumer.test.ts
```

Observed before production edits:

```text
Test Files  2 failed (2)
Tests       5 failed | 33 passed (38)
```

The five expected failures proved that the old code:

1. executed AgentDO again for `already_routed=true`;
2. called AgentDO for a live external MCP wake and wrote no envelope;
3. returned 409 after AgentDO failure instead of durable fallback;
4. did not preserve the requested wake fields in a fallback envelope; and
5. called AgentDO for a live external IM wake.

The IM fixture was corrected to use IM's documented slug/name resolver, then rerun alone. It
failed at the expected missing-route assertion (`doFetch` called once), not at identity setup.

## GREEN evidence

Focused command:

```text
npx vitest run tests/wake-routing.test.ts tests/bus-consumer.test.ts
```

Result:

```text
Test Files  2 passed (2)
Tests       38 passed (38)
```

Relevant regressions and typecheck:

```text
npx vitest run tests/wake-routing.test.ts tests/bus-consumer.test.ts \
  tests/im-hermes.test.ts tests/mcp-jsonrpc.test.ts \
  tests/fleet-agent-liveness.test.ts tests/agent-messages.test.ts
npm run typecheck
git diff --check
```

Result:

```text
Test Files  6 passed (6)
Tests       108 passed (108)
TypeScript  PASS
diff check  PASS
```

Secret scan:

```text
node scripts/no-secrets.mjs --root .
```

Result:

```text
no secrets found
```

## Independent-gate corrections

The first independent gate identified four bounded defects. They were reproduced before the
correction commit:

```text
node scripts/check-test-schema-source.mjs
npx vitest run tests/wake-routing.test.ts tests/bus-consumer.test.ts

schema source  PASS after replacing the D1-shaped mock with createSqliteD1() plus
               applyAllMigrations()
Test Files     1 failed | 1 passed (2)
Tests          5 failed | 36 passed (41)
```

The five expected RED failures proved:

1. a cross-squad duplicate slug leaked fallback delivery to the ambiguous slug rather than the
   canonical UUID;
2. a rejected AgentDO `fetch()` escaped as HTTP 500 rather than taking durable fallback;
3. the full canonical inbox did not fail closed because the unsafe slug bypassed it;
4. the no-fleet fallback used the slug instead of the canonical UUID; and
5. IM described durable external acceptance as a running synchronous cycle.

The correction keeps the single liveness result for both decisions: a stale but unambiguous
fleet identity remains the fallback target; an absent/ambiguous fleet identity falls back only
to the canonical UUID. AgentDO response failures and transport rejections now share that same
durable fallback. IM reports a running cycle only for `agent_do` and reports durable queueing for
the inbox routes.

Correction GREEN:

```text
node scripts/check-test-schema-source.mjs
npx vitest run tests/wake-routing.test.ts tests/bus-consumer.test.ts

schema source  PASS (baseline unchanged: files 26, mockDb 127)
Test Files     2 passed (2)
Tests          41 passed (41)
```

Relevant correction regressions:

```text
npx vitest run tests/wake-routing.test.ts tests/bus-consumer.test.ts \
  tests/im-hermes.test.ts tests/mcp-jsonrpc.test.ts \
  tests/fleet-agent-liveness.test.ts tests/agent-messages.test.ts
node scripts/check-test-schema-source.mjs
npm run typecheck
node scripts/no-secrets.mjs --root .
git diff --check

Test Files     6 passed (6)
Tests          111 passed (111)
schema source  PASS
TypeScript     PASS
no-secrets     PASS
diff check     PASS
```

## Final delivery-boundary correction

The final narrow gate found that `sendAgentMessage` can reject before returning its typed
failure result (for example, during a pre-insert dependency read). The rejection previously
escaped the MCP surface as HTTP 500.

The final test uses the real `sendAgentMessage`. It builds the complete schema with
`createSqliteD1()` + `applyAllMigrations()`, delegates normal D1 statements to that migrated
harness, and injects rejection only at the exact `agent_messages` sender/request-id precheck
(`from_agent = ?2 AND request_id = ?3`) that the real service executes before insert.

RED was proven in a temporary detached mutation worktree containing this exact test. Removing
only `deliverWakeEnvelope`'s rejection containment produced:

```text
npx vitest run tests/wake-routing-send-rejection.test.ts

Test Files  1 failed (1)
Tests       1 failed (1)
Observed    HTTP 500 instead of fixed HTTP 409 wake_failed
```

The untouched candidate then ran the same test GREEN with HTTP 409, one observed real precheck
attempt, and neither the injected migrated-DB detail nor the AgentDO body in the MCP response.

`deliverWakeEnvelope` now contains any rejected send and returns the same fixed
`{ok:false, reason:'wake_failed'}` contract as a typed send failure, without exposing raw
dependency details.

Final correction GREEN:

```text
node scripts/check-test-schema-source.mjs
npx vitest run tests/wake-routing-send-rejection.test.ts \
  tests/wake-routing.test.ts tests/bus-consumer.test.ts

schema source  PASS (baseline unchanged: files 26, mockDb 127)
Test Files     3 passed (3)
Tests          42 passed (42)
```

Relevant and workerd gates:

```text
npx vitest run tests/wake-routing-send-rejection.test.ts \
  tests/wake-routing.test.ts tests/bus-consumer.test.ts tests/im-hermes.test.ts \
  tests/mcp-jsonrpc.test.ts tests/fleet-agent-liveness.test.ts tests/agent-messages.test.ts
npx vitest run --config vitest.composition.config.ts
node scripts/check-test-schema-source.mjs
npm run typecheck
node scripts/no-secrets.mjs --root .
git diff --check

Relevant tests  112 passed (112)
Workerd tests   8 passed (8)
schema source   PASS
TypeScript      PASS
no-secrets      PASS
diff check      PASS
```

## Files

- `src/agents/wake-routing.ts` — shared one-route selector, durable envelope, safe fallback,
  and post-route observation.
- `src/mcp/index.ts` — MCP `wake_agent` delegates to the shared service while preserving its
  authorization and fixed failure contract.
- `src/im/index.ts` — IM wake delegates to the same service while preserving its user-facing
  reply contract.
- `src/bus/consumer.ts` — acknowledges `already_routed=true` observations without execution.
- `tests/wake-routing.test.ts` — MCP and IM branch/field/failure coverage.
- `tests/wake-routing-send-rejection.test.ts` — migrated-schema MCP proof for a rejected
  real `sendAgentMessage` sender/request-id precheck; no production-module mock.
- `tests/bus-consumer.test.ts` — no-double-action and generic-wake regression coverage.

## Risks and review boundary

- The durable wake is consumed only when an external runtime polls the resolved inbox identity;
  this candidate does not claim a live runtime consumed or ACKed it.
- Queue observation emit is deliberately best-effort after the selected action commits. A bus
  failure does not turn a committed durable send or successful AgentDO cycle into a retry that
  could choose another route.
- The idempotency key deduplicates one routed call. The public MCP/IM contracts do not currently
  accept a caller-supplied retry key, so a brand-new caller invocation creates a new wake request.
- No deployment, migration, credential, live canary, push, merge, or authority change occurred.
- No `send`, broadcast, task dispatch, or `flight_dispatch` identity routing was changed or
  claimed solved.
- Independent review returned the corrections recorded above. The exact final branch head is
  ready for the separately owned re-gate before any deployment or live canary.
