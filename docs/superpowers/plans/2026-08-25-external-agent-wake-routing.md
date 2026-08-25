# External Agent Wake Routing Repair Plan

**Goal:** Make `wake_agent` execute exactly one route and deliver a durable wake envelope to external agent runtimes even when their fleet presence is stale or their in-Worker AgentDO cannot run.

**Base:** `890a0209c0846c9ce7b4f4561ab13523ddf9a21c`

**Evidence:** Hadi-Grok `a065e61c-6a93-42fc-b070-b541631202f1` and Hadi-Hermes `870a5024-afd2-407e-86b3-fe2596e89bd1` accept tasks/messages but return `wake_agent` HTTP 500 `internal_error`; both current fleet rows have `runtime=""`, stale presence, and no report. Task2R review request `9b7a2a0e-31a4-4b1b-8a64-7b03d3d2e5c1` and Task6 request `5f33cc8a-4b65-44d6-8a57-bc0e5e7d9272` remain unACKed.

## Constraints

- Preserve lead/admin authorization and active-agent checks.
- One wake call chooses and acts on exactly one route.
- Live external fleet route: durable inbox envelope to `getFleetAgentLiveness(...).agentId`; no AgentDO call.
- Internal route: one AgentDO call. On non-2xx only, durable fallback to the server-known agent slug; a failed DO is never treated as execution.
- The durable envelope is `agent.wake/v1`, retains canonical agent UUID, reason, context, `maxActions`, and one bounded idempotency key.
- A routed wake may emit an attributed `agent.wake` observation with `already_routed=true`; the Queue consumer must ACK that observation without another DO/inbox action.
- Never emit the operational event before the synchronous route decision.
- Do not widen tenant/squad authority, rotate credentials, alter task semantics, deploy, migrate, or touch live panes.
- This patch does not claim `send`, broadcast, or `flight_dispatch` external identity routing is solved; those remain separately measurable surfaces.

## Task 1: RED routing tests

Create focused tests proving:

1. live external route writes exactly one wake envelope to the resolved external identity and never calls AgentDO;
2. no live external route plus successful AgentDO calls it exactly once and writes no fallback envelope;
3. failed AgentDO writes exactly one durable fallback envelope to the canonical slug and returns a non-secret routed result;
4. fallback failure returns fixed `wake_failed` and never reflects a raw DO or DB body;
5. reason/context/maxActions and canonical UUID survive the external/fallback envelope;
6. an `already_routed=true` Queue event is acknowledged without calling AgentDO;
7. a normal unhandled generic bus wake retains the pre-existing AgentDO behavior.

Run focused tests and retain the expected RED failures before production edits.

## Task 2: Implement one route selector

- Add one internal wake-routing service used by MCP `wake_agent` and IM wake.
- Resolve fleet liveness once.
- Route external-live directly to a durable `sendAgentMessage` wake envelope.
- Otherwise call AgentDO once; if it fails, write the fallback envelope to `agent.slug` (or UUID only when slug is absent).
- Emit `already_routed=true` observation only after the chosen action commits.
- Update Queue consumer to no-op those observations.
- Return `{route, delivered, seq, duplicate}` for durable external/fallback routes, or the existing runtime result for AgentDO.

## Task 3: GREEN and review

Run focused MCP/IM/bus tests, relevant regressions, typecheck, no-secrets, and `git diff --check`. Commit one candidate, obtain an independent review, and record an artifact SHA. No deployment or live canary without separate Hadi approval.
