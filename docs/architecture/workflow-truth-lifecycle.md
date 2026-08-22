# Workflow Truth Lifecycle — 6-Hop Canonical Operational Pipeline

**Flight:** `FLIGHT-WORKFLOW-TRUTH-01`  
**Status:** Canonical Reference Specification  
**Authority:** River (Receipt Keeper) · Hadi-Grok (Independent Gate) · Hadi (Founder)

---

## 1. Executive Summary

This document establishes the unambiguous, mathematical mapping of the autonomous agent execution lifecycle across Mupot and distributed multi-seat nodes (`hadi-mac`, `hadi-grok-desktop`, Cloudflare Workers, Cloud Run).

Prior to this specification, attribution gaps existed between agent families, hardware seats, and flight owners. This pipeline formally unifies execution into 6 deterministic hops, enforcing that **each hop produces a distinct, tamper-evident cryptographic receipt**.

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  1. ROUTINE  │ ──► │  2. CIRCUIT  │ ──► │  3. FLIGHT   │
└──────────────┘     └──────────────┘     └──────────────┘
                                                 │
                                                 ▼
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  6. RECEIPT  │ ◄── │   5. GATE    │ ◄── │   4. TASK    │
└──────────────┘     └──────────────┘     └──────────────┘
```

---

## 2. The 6-Hop Canonical Lifecycle

| Hop | Entity | Primary Tables / Seams | Trigger / Input | Terminal State / Output | Invariant Receipt |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1** | **Routine** | `project_routines`<br>`project_routine_runs` | `cron` schedule, `event` webhook, or `manual` fire | `routine_run_id`<br>`mode: propose / autonomous` | `receipt:routine_created`<br>`receipt:routine_enabled` |
| **2** | **Circuit** | `circuits`<br>`circuit_executions` | Routine run observation & budget check | Pre-flight circuit clearance | `receipt:circuit_cleared` |
| **3** | **Flight** | `flights`<br>`flight_events`<br>`flight_dispatch` | Goal, `done_when` array, budget cap, squad target | Flight dispatch envelope<br>`flight_id` | `receipt:flight_dispatched`<br>`receipt:flight_injected` |
| **4** | **Task** | `tasks`<br>`task_events`<br>`agent_messages` | Atomic D1 task creation (`open` $\to$ `in_progress`) | Task result artifacts<br>`status: review` | `receipt:task_consumed`<br>`receipt:task_completed` |
| **5** | **Gate** | `gate_grants`<br>`task_verdict` | Review payload, git head SHA, test evidence | Independent verdict: `PASS` / `HOLD` / `BLOCK` | `receipt:gate_verdict` |
| **6** | **Receipt** | `receipts`<br>`flight_event_outbox` | Canonical payload digest | Web Crypto SHA-256 seal<br>`receipt_id` | `receipt:tamper_evident_seal` |

---

## 3. The 4-Tuple Attribution Identity

Every execution unit in Mupot is uniquely addressable via the immutable 4-tuple:

$$\text{Identity} = \big(\text{Tenant/Project}, \;\;\; \text{Agent Family}, \;\;\; \text{Seat / Hardware Node}, \;\;\; \text{Run / Execution Context}\big)$$

1. **Tenant / Project (`project_id`)**: The sovereign organization boundary (`mumega`, `viamar`, `dnu`).
2. **Agent Family (`agent_id`)**: The persistent persona and grant holder (`river`, `grok`, `cursor`, `hermes`, `kasra`).
3. **Seat / Machine (`seat`)**: The exact executing runtime instance (`hadi-river` on Mac, `cursor-mupot-setup` / `hadi-grok-desktop` on Desktop/Cloud).
4. **Run / Execution (`run_id` / `request_id`)**: The deterministic trace ID for the turn.

### Invariant:
* General broadcasts (`target_seat IS NULL`) may be claimed by any pooled worker in the family.
* Targeted dispatches (`target_seat = 'hadi-river'`) are strictly partitioned and can only be leased or consumed by that exact seat.

---

## 4. Distinct Receipt Invariant: The Non-Collapsing Rule

In autonomous systems, communication states must never be conflated:

$$\text{authorized} \;\neq\; \text{accepted} \;\neq\; \text{injected} \;\neq\; \text{consumed} \;\neq\; \text{ACK} \;\neq\; \text{verdict}$$

1. **`authorized`**: Principal holds capability grant in `capabilities` or `gate_grants`.
2. **`accepted`**: Dispatcher validates schema and queues work.
3. **`injected`**: Event or payload written to D1/Queue mailbox.
4. **`consumed`**: Worker leases row and marks atomic lease lock.
5. **`ACK`**: Correlated response returned with matching `in_reply_to` / `request_id`.
6. **`verdict`**: Independent gatekeeper with zero authorship stake certifies cryptographically verified evidence.

---

## 5. Kill-Witness Invariant

Any modification to hop definitions, transition rules, or receipt digests must cause the conformance test suite (`tests/workflow-truth-lifecycle.test.ts`) to immediately fail **RED**.
