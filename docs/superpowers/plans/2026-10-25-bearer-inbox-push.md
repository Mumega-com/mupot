# Bearer Inbox Push Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Execute natively; external independent PR reviews remain required.

**Goal:** Deliver task mumega-com#1535 as a default-off, member-token-only push stream draft PR.
**Architecture:** Trusted Worker authenticates and subscribes to a typed SeatEventsDO observer; DO emits body-free hints; Worker coalesces authorized inbox peeks into the existing SSE format. Fleet host ownership stays authoritative. Existing polling is retained only as flag-off behavior or explicit allowed outage fallback.
**Tech Stack:** TypeScript, Hono, D1, Durable Objects, Vitest, workerd.
**Spec:** Kasra's recorded decisions on https://github.com/Mumega-com/mumega-com/issues/1535 (round1 P1s, six v2 decisions, implementation GO). These override earlier exploratory drafts.

## Global Constraints

- No merge, deploy, feature activation, credentials, grants or Step1/3 implementation.
- Member tokens only; OAuth, dashboards, revoke bus fast path and outbox excluded.
- Bearer caps256/pot,4/agent,2/credential; observers never consume/lease/ACK.
- Scheduled auth45s, query timeout5s, retries50/55s, hard deadline60s from successful attempt start; disclosure cache10s.
- Connect catch-up; resync cycle>=300s plus jitter, <=10 pages of100; distinguish auth, resync, push and fallback metrics.
- Heartbeat25s, DO observer expiry15min, stream rotation30min; SSE id cursors and explicit since support.
- Host grant definitive granted=>409, lookup error=>503; capacity=>503. Fallback30s only genuine DO outage with definitive not_granted.
- Migration-backed SQL tests only. DO behavior tested in workerd. Flag omitted means off.

## Review Focus

- Same-member credential rebound to a different agent/seat must not renew disclosure.
- Late auth success after timeout/closure cannot extend a lease or enqueue.
- Host registration between observer authorization and subscribe must evict/refuse safely.
- Slow readers and >1000-message backlog must be bounded without cursor loss.
- Explicit/implicit reconnect cursors and initial frames must preserve old bridge behavior.

### Task 1: Reference revalidator
Files: create src/agents/inbox-stream-auth.ts and tests/inbox-stream-auth.test.ts; reuse member-bearer/token-lifecycle/inbox-seat/seat-events SQL predicates.
Interface: StreamIdentity {tokenId,memberId,agentId,seat:string|null}; validateInboxStreamIdentity(env,identity): Promise<'valid'|'invalid'|'error'>. One SQL statement validates credential/channel/member/agent/seat floor/seat equality and effective fleet grant.
- [ ] Write migration-backed valid/revoked/expired/rebound/seat/inactive/held/directory/fleet/error tests; run and observe red.
- [ ] Implement a shared delivery SQL predicate if needed without changing host behavior.
- [ ] Run tests and host grant regressions; commit.

### Task 2: Typed DO observers
Files: src/agents/seat-events.ts, seat-events-do.ts; new bearer observer helpers and tests/composition/seat-events-bearer.test.ts.
Interface: BearerSubscription {kind:'bearer',agent,seat,credential_id,member_id,not_after}; private /bearer-connect accepts Worker-derived descriptor. Separate observer pool; body-free frames; synchronous host claim eviction. Unknown explicit kinds refused.
- [ ] Write failing decoding, caps, seat filters, host race and expiry tests.
- [ ] Implement helpers and DO integration preserving legacy host paths; test in workerd.
- [ ] Run host regression suite; commit.

### Task 3: Worker push stream
Files: new src/agents/inbox-push-stream.ts; src/agents/inbox-routes.ts, src/types.ts; tests/inbox-push-stream.test.ts and route tests.
Interface: createPushInboxStream(env,identity,options): Response or typed unavailable/refused result; injected clock/socket/read seams for deterministic tests. Internally owns cancellation, deadlines, cursor, dirty/read state and all timers.
- [ ] Write failing idle-budget, hint, pagination, deadline/hang/late-result, fallback and wire tests.
- [ ] Implement flag-off-compatible route, initial auth error distinction, trusted DO request, read/revalidate/enqueue, resync, cleanup and metrics.
- [ ] Run tests across45/60/300s and above50/100/1000-message boundaries; commit.

### Task 4: Client and end-to-end proof
Files: plugins/seatlink bridge existing test suite; workerd composition tests and feature documentation.
- [ ] Write rotation/cursor and DO-to-stream integration tests before any required client correction.
- [ ] Verify real bridge resume, no public hint fields, flag-off parity, all failure paths and typecheck.
- [ ] Run full ordinary suite and relevant composition suite, record any baseline failures separately. Review whole branch and address findings.
- [ ] Create draft PR, attach it to this chat, post exact head/test evidence on existing Mupot task, obtain Athena/kasra-review/Opus reviews. Do not merge or enable.
