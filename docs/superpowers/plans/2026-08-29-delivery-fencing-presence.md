# Delivery Fencing and Presence Lease Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register delivery fences in the real producer path, consume them only from the authenticated receiver seat, and make presence epochs/leases monotonic and time-effective.

**Architecture:** Add a narrow delivery-turn-fence table and presence lease columns. `sendAgentMessage` registers the immutable delivery tuple before visibility; inbox leasing consumes it with one receiver-bound conditional update. Presence writes use compare-and-set epochs, and readers compute effective liveness from bounded TTL rather than trusting stored status.

**Tech Stack:** TypeScript, D1/SQLite transactions, agent message producer/lease paths, MCP presence, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-29-pr1236-fix-forward-design.md`

## Global Constraints

- Start from the merged router/loop/meter descendant after Loom Slice 5 GO.
- Design-time migration path is `migrations/0135_delivery_turn_fences.sql`; renumber above then-current main before editing.
- Receiver agent and seat derive from authenticated context; they are never caller claims.
- Fence registration must happen before work becomes visible; consumption is one atomic conditional update.
- Session epochs only increase; server policy bounds TTL and readers honor expiry.

---

### Task 1: Add Fence and Presence-Lease Storage Invariants

**Files:**
- Create: `migrations/0135_delivery_turn_fences.sql` (renumber above current head at execution)
- Test: `tests/delivery-presence-migration.test.ts`

**Interfaces:**
- Produces: `delivery_turn_fences` plus `presence.session_epoch`, `presence.lease_ttl_sec`, and `presence.lease_expires_at`.

- [ ] **Step 1: Write SQLite invariant tests**

Use the full migration harness. Assert unique `(tenant, delivery_id)`, nonce digest format, positive generation/turn/epoch, expiry after registration, one consumption only, bounded TTL, and session-epoch downgrade refusal.

- [ ] **Step 2: Confirm RED, write migration, and verify**

Required fence fields: tenant, delivery ID, recipient agent ID, target seat, thread ID, turn ID, generation, correlation ID, nonce SHA-256, registered/expires/consumed timestamps, and consumed-by agent/seat.

```bash
npx vitest run tests/delivery-presence-migration.test.ts tests/helpers-migrations.test.ts
node scripts/check-migration-numbering.mjs origin/main
git add migrations tests/delivery-presence-migration.test.ts
git commit -m "feat(db): add receiver-bound turn fences"
```

### Task 2: Implement Fence Registration and Consumption

**Files:**
- Create: `src/flight-spine/delivery-turn-fencing.ts`
- Test: `tests/delivery-turn-fencing.test.ts`

**Interfaces:**
- Consumes: `RegisterTurnFenceInput` from the producer and `ConsumeTurnFenceInput` with server-derived receiver.
- Produces: `registerDeliveryTurnFence` and `consumeDeliveryTurnFence`.

- [ ] **Step 1: Define immutable inputs**

```ts
export interface RegisterTurnFenceInput {
  deliveryId: string
  recipientAgentId: string
  targetSeat: string
  threadId: string
  turnId: number
  generation: number
  correlationId: string
  nonce: string
  ttlSeconds: number
}

export interface AuthenticatedReceiver {
  tenant: string
  agentId: string
  seat: string
}
```

- [ ] **Step 2: Write adversarial consumption tests**

Cover sibling seat, wrong agent, wrong thread/turn/generation/correlation/nonce, expired lease, nonexistent fence, and replay. Ensure each fails closed and leaves `consumed_at` null except the single valid winner.

- [ ] **Step 3: Confirm RED and implement**

Hash nonce before storage. Consume with one conditional update whose `WHERE` clause includes `consumed_at IS NULL`, `expires_at > datetime('now')`, every tuple field, and every authenticated receiver field; require `changes === 1`.

- [ ] **Step 4: Mutation-check and commit**

Temporarily remove `target_seat = ?`; sibling-seat test must fail. Restore.

```bash
npx vitest run tests/delivery-turn-fencing.test.ts
git add src/flight-spine/delivery-turn-fencing.ts tests/delivery-turn-fencing.test.ts
git commit -m "feat(delivery): enforce turn fences"
```

### Task 3: Connect the Real Producer and Inbox Lease

**Files:**
- Modify: `src/agents/messages.ts`
- Modify: `src/bus/consumer.ts`
- Modify: `src/mcp/index.ts`
- Test: `tests/delivery-producer-consumer.test.ts`

**Interfaces:**
- Consumes: `sendAgentMessage`, `leaseAgentInbox`, authenticated bound agent/seat, and the fence service.
- Produces: atomic producer registration before message visibility and lease-time receiver consumption.

- [ ] **Step 1: Write end-to-end producer/consumer tests**

Assert the production send path creates the fence before the message can be leased; registration failure writes no visible message; wrong receiver cannot lease; valid receiver consumes once; retry/replay cannot re-consume.

- [ ] **Step 2: Confirm RED**

Run: `npx vitest run tests/delivery-producer-consumer.test.ts`

- [ ] **Step 3: Batch producer writes**

Put fence insert and `agent_messages` insert in one D1 batch. If the message references an existing fenced-delivery abstraction, link by immutable ID rather than duplicating mutable state.

- [ ] **Step 4: Derive receiver in MCP**

Require `auth.boundAgentId`; resolve the canonical active seat from server state. Remove agent/seat override fields from the consumption schema. Pass the derived `AuthenticatedReceiver` to `leaseAgentInbox`.

- [ ] **Step 5: Mutation-check and commit**

Temporarily insert the message before fence registration; injected registration failure must expose the bug. Restore atomic ordering.

```bash
npx vitest run tests/delivery-producer-consumer.test.ts tests/agent-messages.test.ts
git add src/agents/messages.ts src/bus/consumer.ts src/mcp/index.ts tests/delivery-producer-consumer.test.ts
git commit -m "fix(delivery): bind producer to receiver"
```

### Task 4: Enforce Monotonic Presence Leases

**Files:**
- Modify: `src/fleet/presence.ts`
- Modify: `src/mcp/presence.ts`
- Modify: `src/mcp/index.ts`
- Test: `tests/presence-leases.test.ts`

**Interfaces:**
- Consumes: `CheckinOpts.sessionEpoch`, requested TTL, authenticated member/agent/seat.
- Produces: compare-and-set `recordCheckin`/`touchPresence` and effective `PresenceView.status`.

- [ ] **Step 1: Write epoch/TTL tests**

Cover epoch advance, equal-epoch heartbeat, lower-epoch rejection, delayed old heartbeat, TTL below/above policy rejection, offline after expiry, and raw stored status remaining distinguishable from effective status.

- [ ] **Step 2: Confirm RED and implement CAS writes**

Bound TTL to an explicit server range such as 30–3600 seconds. Update only when incoming epoch is greater, or equal with a nondecreasing heartbeat sequence if one exists. Never allow a lower epoch to change `last_seen_at` or lease expiry.

- [ ] **Step 3: Compute effective liveness at read time**

Return both raw presence fields and an effective `online` boolean/status derived from `lease_expires_at > now`. Do not rewrite stored state merely because a lease aged out.

- [ ] **Step 4: Mutation-check and commit**

Temporarily change `incomingEpoch >= storedEpoch` to unconditional update; delayed-heartbeat test must fail. Restore.

```bash
npx vitest run tests/presence-leases.test.ts tests/fleet-presence.test.ts tests/mcp-presence-tools.test.ts
git add src/fleet/presence.ts src/mcp/presence.ts src/mcp/index.ts tests/presence-leases.test.ts
git commit -m "fix(presence): enforce monotonic leases"
```

### Task 5: Exact-Head Gate

**Files:**
- Create: `docs/receipts/pr1236-fix-forward/delivery-presence-exact-head.md`

**Interfaces:**
- Produces: real-producer, receiver-binding, epoch/TTL, mutation, full-suite, Lumen, Athena, and Loom evidence.

- [ ] **Step 1: Run focused and full gates**

```bash
npx vitest run tests/delivery-presence-migration.test.ts tests/delivery-turn-fencing.test.ts tests/delivery-producer-consumer.test.ts tests/presence-leases.test.ts
npm run typecheck
npm test
node scripts/no-secrets.mjs
node scripts/check-test-schema-source.mjs
node scripts/check-migration-numbering.mjs origin/main
bash scripts/ci-local-evidence.sh
git diff --check origin/main...HEAD
```

- [ ] **Step 2: Gate and stop**

Commit receipt, push, open draft PR, obtain green required checks, Lumen review, Athena exact-head Artifact+SHA256, and Loom composition. Stop for Hadi.
