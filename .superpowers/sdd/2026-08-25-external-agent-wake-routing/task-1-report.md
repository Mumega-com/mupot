# Task 1 Report — External Agent Wake Routing

Date: 2026-08-25

Branch: `codex/wake-external-route`

Plan/base commit: `33e33e4df3ab09b467815e63774f741ad7ff2f1d`

Implementation commit: `a709770bd49914810ef84fa0fe2c64d2623346dc`

## Result

Implemented the bounded external-agent wake-routing repair with one shared service used by
MCP `wake_agent` and IM wake:

- a live external fleet route receives one durable `agent.wake/v1` inbox envelope at the
  external identity resolved by `getFleetAgentLiveness`, without an AgentDO call;
- an internal route calls AgentDO exactly once and writes no fallback envelope when it succeeds;
- a failed AgentDO writes one durable fallback envelope to the server-known canonical slug
  (UUID only when no slug exists);
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

## Files

- `src/agents/wake-routing.ts` — shared one-route selector, durable envelope, safe fallback,
  and post-route observation.
- `src/mcp/index.ts` — MCP `wake_agent` delegates to the shared service while preserving its
  authorization and fixed failure contract.
- `src/im/index.ts` — IM wake delegates to the same service while preserving its user-facing
  reply contract.
- `src/bus/consumer.ts` — acknowledges `already_routed=true` observations without execution.
- `tests/wake-routing.test.ts` — MCP and IM branch/field/failure coverage.
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
- Independent review was not performed inside this task because the assignment explicitly
  prohibited spawning subagents. The exact implementation commit above is ready for the
  separately owned Kasra/independent gate before any deployment or live canary.
