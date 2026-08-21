# The Keystone: Agent-Inbox Delivery

**Status:** LIVING finding · part of [[MU.100.002-spine]]
**Found:** 2026-08-08, by the flight-executor end-to-end test

---

## The finding

**mupot dispatch does not reliably deliver the `routine.run/v1` envelope (carrying the `situation_digest`) to the assigned agent's inbox.** Confirmed live: asha's inbox (`e211b0fb`) holds **zero** such envelopes, for every run.

This was surfaced — not caused — by the flight-executor. That worker is built, gated PASS (including adversarial), and provably correct: it polls, claims the right flight, skips out-of-lane (cursor/Tech-Grok) flights, and then **refuses to proceed** because the `situation_digest` isn't in the assigned agent's inbox. Per Condition 7 it will *never fabricate* one. So it CLAIMs then BLOCKs, safely, doing nothing — because there is nothing to act on.

## Why it is *the* keystone — three problems, one root

| Problem | How this root causes it |
|---|---|
| **Flights never execute** | The executor can't get the digest → can't run the goal → can't submit the proposal. The 5+ stuck flights (cost=0 since Aug 5) are all this. |
| **Sessions stuck read-only** | The connector problem every external session hits (dara, Claude Desktop, ChatGPT) is the same "agent cannot reliably receive" at the transport/dispatch layer. |
| **Public onboarding fails** | Public-mupot vision step 2 — "connect your first harness and start using" — dies here: a stranger's harness must receive and act on dispatches. |

**One fix unblocks all three.** That fix is reliable agent-receiving: the dispatch must land the envelope in the assigned agent's inbox, retrievable by that agent's own token, independent of whether the agent holds a live connection.

## The fix is the self-registration / receiving architecture

This is the same work as the design surveyed 2026-08-08 (see the survey thread). The agreed shape so far:

- **Server-derives-identity** (Athena): OAuth proves the human; the server derives agent-identity + scope from the authenticated directory row — never trust client-supplied `agent_id`/scope. Registration = server materialization, not client assertion.
- **In-band registration** is PR #688 (ADR-001 "threads are the unit of work") — the foundation, currently OPEN and BLOCKED on 2 fail-open P0s: fail-OPEN scope resolution (dropped header → full squad access) and incoherent binding (connect binds claimed agent, loadSession validates welded agent). Fix fail-CLOSED + coherent-binding first.
- **Mechanical token-grant via Asha** (always-available authority): `grant = f(OAuth identity, directory row, requested ∩ allowed)` — deterministic policy, never model-judged (else prompt-injectable). Keeps Asha's cause.md intact (she never exercises final judgment) and gets its own dual-gate + 2FA on sensitive scope classes + audit.
- **Reliable inbox delivery**: whatever the mechanism, `routine.run/v1` (with `situation_digest`) must reach the assigned agent's inbox at dispatch and be readable by that agent's token.

## Standing directives

- **Do NOT force-enable the flight-executor.** It's built and waiting; enabling it now just logs safe blocks. It goes live automatically once dispatch delivers the digest.
- **Public-readiness note:** the flight-executor's HTTP client was 1010-banned by Cloudflare's WAF for using urllib's default User-Agent (fixed with a named UA). **Any external Python client hitting public mupot will hit this** — the API must not bot-ban legitimate clients. Track under public-readiness (onboarding / portable-execution / packaging).

## Lineage

- 2026-08-08 — found by the flight-executor e2e (task 731d1634 / #740). The flight-executor is the proof that surfaced the true keystone: it is not the last mile of execution, agent-receiving is.
