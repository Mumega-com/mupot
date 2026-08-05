# SOS PAYLOAD Path Retirement Plan

**Status:** Inventory phase complete. Full task blocked on sos#193 (deploy path undefined).

**Date:** 2026-08-05

---

## Executive Summary

The SOS Redis bus has been **retired from active fleet routes** as of 2026-07-22 per `docs/architecture/sos-coordination-compat.md`. This document inventories the remaining compat shims, outlines the authenticated courier role migration, and identifies blockers for full cutover.

**Finding:** No active code paths call SOS. All authenticated send/inbox/wake/control operations use mupot CF-native primitives (D1 agent_messages + CF Queue).

---

## Inventory: SOS References in mupot

### Compat Shims (Unused)

| Artifact | File | Status | Notes |
|---|---|---|---|
| `Env.BUS_URL` | `src/types.ts:111` | **Unused** | Optional leftover for ops visibility only. Default: `https://bus.mumega.com` (never called). |
| `Env.BUS_TOKEN` | `src/types.ts:133` | **Unused** | Secret. Paired with BUS_URL for compat detection only. |
| `busConfigured()` | `src/dashboard/fleet.ts:63-65` | **Exported, not called** | Reports whether legacy SOS secrets are present for ops visibility. No live routes depend on it. |
| `DEFAULT_BUS_URL` | `src/dashboard/fleet.ts:68` | **Deprecated constant** | Fallback URL used only by `busConfigured()`. Marked with `@deprecated` comment. |

### Documentation & Comments

| Reference | File | Context |
|---|---|---|
| "SOS Redis bus compat shim" | `src/dashboard/fleet.ts:1-10` | Design note: explains why BUS_URL/BUS_TOKEN exist. Correct—compat only, active routes don't call. |
| "SOS bus retired from this path" | `src/dashboard/index.ts:118` | Comment on fleet roster reads. Accurate—uses D1 + presence check-in instead. |
| "SOS coordination compat shim" | `docs/architecture/sos-coordination-compat.md` | Status document. Already states SOS is retired from all active paths. |

### Test Coverage

| Test | File | Purpose |
|---|---|---|
| `busConfigured` suite | `tests/dashboard-fleet.test.ts` | 2 tests. Verify the compat-detection function works. **No test calls it from live code.** |
| Fleet roster tests | `tests/dashboard-fleet.test.ts` | Verify D1 + presence reads. Zero SOS calls. |
| Fleet wake tests | `tests/dashboard-fleet.test.ts` | Verify `wakeFleetAgent()` uses agent_messages + Queue. Zero SOS calls. |

---

## Authenticated Courier Role: Current State

### What the SOS Bus Provided

| Capability | mupot Replacement | Evidence |
|---|---|---|
| **Authenticated sender** | `auth.boundAgentId` + MemberToken | `src/mcp/index.ts:send`, `src/agents/messages.ts:sendAgentMessage` |
| **Immutable request ID** | `request_id` VARCHAR(128) UNIQUE | `src/agents/messages.ts:50-51`, `migrations/0017_agent_messages.sql:27` |
| **Dedupe/retry** | `UNIQUE(tenant, from_agent, request_id)` | `migrations/0017_agent_messages.sql:27` — prevents double-delivery on network retry |
| **Durable inbox** | D1 `agent_messages` table | `src/agents/messages.ts:237-299`, `migrations/0017_agent_messages.sql` |
| **ACK tracking** | `request_id` + presence in inbox | Apps read via `inbox`, send via `send`, track delivery by seq/id; Fleet daemon signed consume path |
| **Unanswered requests** | Inbox inspection by sender | No explicit "unanswered" tracking yet (see **gap** below). Sender can poll inbox or rely on timeout/re-ask. |

### Gaps in Current mupot Implementation

| Gap | Scope | Severity | Path Forward |
|---|---|---|---|
| **Unanswered-request view** | No explicit "which sends did not get ack" query | Medium | Add a view or helper that reads agent_messages WHERE consumed_at IS NULL AND ts < now - timeout_duration. Operator-gated. |
| **Dual-run comparison** | No infrastructure to run both SOS and mupot paths in parallel | High | Needs sos#193 (deploy path). Cannot proceed without upstream decision on how to toggle paths. |
| **Cutover atomicity** | Migrating 21 running units requires ceremony | High | sos#193 defines this. Currently no deploy gate that can flip all units at once. |

---

## Callers & Data Audit

### Active Callers (Confirmed Zero SOS Calls)

| Caller | How It Wakes/Sends | Inbox Used |
|---|---|---|
| **Fleet dashboard** (`src/dashboard/fleet.ts`) | `sendAgentMessage()` + Queue `agent.wake` | Yes — durable; verified working in production |
| **MCP send tool** (`src/mcp/index.ts`) | `sendAgentMessage()` directly | Yes — per-spec. Verified via squad-mupot-cutover.md step 3 |
| **Task dispatch** (`src/bus/fleet-bridge.ts`) | `deliverDispatchToInbox()` | Yes — durable receipt + consume-on-read |
| **Routine proposals** (`src/routines/actions.ts`) | No message send; creates Task only | N/A — tasks are D1, not inbox |

### Tenants & Scale

| Scope | Finding |
|---|---|
| **Number of units** | "SOS names 21 running units" per brief. Inventory needed from SOS repo (out-of-scope for mupot). |
| **This pot (mupot)** | Single tenant per deployment. TENANT_SLUG scopes all inbox/send. Zero cross-tenant message routing. |
| **Per-unit data** | No "units" table in mupot. Presence tracked per member_id + agent_id; messages per sender/recipient. |

---

## What Blocks Full Retirement

### sos#193: Deploy Path Undefined

**Current blocker:** The brief explicitly states *"Blocked on sos#193 (deploy path undefined)"*.

mupot cannot retire SOS PAYLOAD path in isolation because:

1. **The 21 running units live in SOS** (Python). They still have SOS Redis stream listeners configured. Mupot cannot unilaterally turn them off.
2. **Dual-run needs a toggle mechanism** that both sides understand. Needs sos#193 to define:
   - How to signal which units should read from mupot inbox vs. SOS Redis
   - How to scale that signal across all 21 units without coordinated downtime
   - How to measure latency/delivery parity during the window
3. **Cutover ceremony** needs explicit runtime wiring that doesn't exist yet:
   - The fleet daemon's signed `/api/inbox/signed` endpoint exists in mupot (documented in squad-mupot-cutover.md step 5).
   - The host-side `~/.fleet/runtime` handler exists in mupot source.
   - But the operator deployment path (Hadi's lane per CLAUDE.md) hasn't wired it to the running host yet.

**Evidence of blockage:**
- squad-mupot-cutover.md §5 (wake-hooks cutover): *"Do NOT migrate the hooks until the target host has a passing receipt bundle."*
- docs/architecture/sos-coordination-compat.md: *"Blocked on sos#193 (deploy path undefined)."*

---

## Recommended Next Steps (After sos#193)

### Phase 1: Unanswered-Request Visibility (This pot)

Add an explicit query for in-flight requests:

```sql
-- Unanswered requests sent by an agent
SELECT from_agent, to_agent, request_id, body, ts
  FROM agent_messages
 WHERE tenant = ?1 AND from_agent = ?2 AND consumed_at IS NULL
   AND ts > datetime('now', '-30 minutes')
 ORDER BY ts DESC
```

Expose via an internal debug endpoint (not MCP-public yet).

### Phase 2: Dual-Run Infrastructure (Requires sos#193)

After sos#193 defines the deploy path:

1. **Add a feature flag per unit:** `DELIVERY_MODE` env var (`sos` | `mupot` | `dual`).
2. **Instrument both paths:** Log `delivery_attempt.method`, `delivery_attempt.latency_ms`, `delivery_outcome`.
3. **Run 7–14 day window** with `DELIVERY_MODE=dual` on a subset of units:
   - Send to both SOS Redis and mupot inbox.
   - Log both outcomes.
   - Compare latency, failures, and ack patterns.
4. **Decide cutover order:** Which units are safe to flip first?

### Phase 3: Cutover with Rollback (Requires sos#193 + Phase 2 data)

1. **Operator ceremony:** Hadi runs fleet-runtime bootstrap + receipts (squad-mupot-cutover.md §5).
2. **Per-unit flip:** Starting with kasra squad (§1–4 of squad-mupot-cutover.md):
   - Mint tokens.
   - Verify memory (remember/recall).
   - Verify messaging (send/inbox).
   - Flip wake-hooks when host receipts pass.
3. **Rollback gate:** While 21 units are still on SOS, any failed cutover unit can revert to SOS Redis within 30m.

### Phase 4: Archive Old Components (After all units cutover)

1. **Remove from mupot:**
   - Delete `busConfigured()` and its tests.
   - Remove `BUS_URL`, `BUS_TOKEN` from `Env` interface.
   - Remove comment references to SOS.
2. **SOS repo:** Archive `sos:stream:project:sos:agent:*` Redis streams, `check-inbox.sh` delegation path, `verify-delegation.py` HMAC envelope.
3. **Runbooks:** Archive squad-mupot-cutover.md (move to historical docs).

---

## Verification: mupot Readiness

**Claim:** mupot can fully replace SOS's authenticated courier role.

**Evidence:**

✅ **Authenticated sender:** MemberToken + `auth.boundAgentId` weld. No forge path.  
✅ **Immutable request ID:** UNIQUE constraint on `(tenant, from_agent, request_id)`.  
✅ **Dedupe/retry:** Duplicate sends return `{ duplicate: true }` without re-inserting.  
✅ **Durable inbox:** D1 persistence + atomic consume-on-read.  
✅ **Inbox API:** `GET /api/inbox`, `POST /api/inbox/send`, `POST /api/inbox/signed` (fleet daemon).  
✅ **Presence tracking:** `POST /api/fleet/checkin` + D1 presence table.  
✅ **Wake via Queue:** `agent.wake` events + `AgentDO.wake()` routing.  
✅ **Control requests:** Signed `emitControlRequest()` + Task/Flight link.  
⚠️ **Unanswered-request view:** Possible (query above), not yet exposed. Low priority—can add in Phase 1.  

---

## Summary: What's Done vs. Blocked

| Work | Status | Why |
|---|---|---|
| Inventory callers | ✅ Done | Zero active SOS calls found. |
| Prove mupot capabilities | ✅ Done | All courier features present; see evidence above. |
| Dual-run infrastructure | 🔴 Blocked | Needs sos#193 deploy-path decision. |
| Cutover ceremony | 🟡 Partial | Fleet runtime handlers exist; operator wiring pending. |
| Archive old components | 🔴 Blocked | Can't delete until all 21 units migrated (outside this repo). |

---

## Minimal Code Changes This Turn

To prepare for retirement without blocking on sos#193:

1. ✅ Deprecate `busConfigured()` more clearly (already marked `@deprecated`).
2. ✅ Document that BUS_URL/BUS_TOKEN have no active callers.
3. ✅ Add this plan document for future reference.
4. 🚫 Do NOT delete anything yet—deletion requires sos#193 + full unit migration.

---

## References

- **ADR:** GitHub issue [#473](https://github.com/Mumega-com/mupot/issues/473) — SOS bus retirement decision
- **Cutover runbook:** `docs/squad-mupot-cutover.md` — step-by-step for the first 21 units
- **Architecture audit:** `docs/architecture-audit-mupot-vs-sos.md` — body/mind boundary
- **Compat shim status:** `docs/architecture/sos-coordination-compat.md` — what remains and why
- **Deploy blocker:** SOS repo sos#193 (external; not in this repo)
