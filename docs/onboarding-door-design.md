# The onboarding door — design, and why the first attempt was blocked

> **Status: BLOCKED, not shipped.** Direction authorized by Hadi 2026-08-17 ("loosen up, let's
> onboard agents, we close the doors after; make the door" / "let agents choose their own access
> fine grain, we check them later after the door closed"). The *artifact* was blocked by Loom's
> second-lens review. Nothing was committed.

This file exists because the review lived only in a bus message, and bus messages proved
unreliable the same night (mupot#1120: replays misattribute the sender *and* misroute the
recipient). The reasoning below is worth more than the code that prompted it.

---

## What was attempted

`create_agent` required `lead` on the squad, so a fresh OAuth login — which lands **zero-grant** —
could not create an agent at all.

**The non-obvious finding, and the one thing from the attempt worth keeping:**

Lowering `min` from `lead` to `member` would have shipped **nothing**.

- `hasCapability` (`src/auth/capability.ts:86`) iterates the grants array and returns `false` for
  **every** `min` when it is empty. A zero-grant member fails `member` exactly as it fails `lead`.
- Worse, `spec.min` is enforced by the AAGATE capability floor at the **dispatcher**
  (`src/mcp/index.ts:3729`), *before* `run()` executes. So a handler-level door is **dead code**
  unless `min` is also lowered to `authenticated`.

A door therefore has to be an **explicit alternative path**, not a lower bar.

## Why it was blocked — four defects, all confirmed

**1. The attribution was a success-shaped no-op.** `created_via` was added to the
`emitProvisioned` *parameter* type (`provision.ts:105-122`) but the BusEvent payload construction
(`:138-146`) spreads `member_id`, `capability`, `reason`, `changed` — and **not** `created_via`.
The tool *returned* `created_via` to the caller, so the response advertised attribution that was
never recorded. On top of that, `emitProvisioned` is **best-effort with a swallowed catch**
(`:152-160`), so even a corrected payload cannot support "every creation is attributed".

*The author wrote a confident durability claim into a code comment, and the field never reached
the event. This was the fourth instrument-reports-intent defect of that night and the only one
authored while actively cataloguing that class.*

**2. The provenance stamp had nowhere durable to live.** `capabilities`
(`migrations/0002_members.sql:27-37`) has `id / member_id / scope_type / scope_id / capability /
created_at` — **no `granted_by`, no `door_id`, no prior value**. And `setAgentSquadAccess`
(`src/members/agent-access.ts:257-285`) does `ON CONFLICT ... DO UPDATE SET capability =
excluded.capability`, so a self-grant **overwrites a legitimate prior grant**. Closing the door by
deleting door-granted rows would destroy real access. Event-only provenance is insufficient;
append-only receipts with before/after are required.

**3. The door was wider than described.** Agent-bound tokens **also carry `memberId`**
(`src/mcp/index.ts:381-395`), so gating on `auth.memberId` let *any bound agent* create agents in
*any squad whose id or slug it knows*, with zero grant on that squad. It was described as a
fresh-human-OAuth door. It was not. If the door is for humans, reject `auth.boundAgentId` on this
path; if agents are intended, say so and test it.

**4. Tests still proved the old contract.** `tests/provision-tools.test.ts:430-435` asserts squad
member → 403; the WIP returned 200. Targeted run: 51 pass / 1 fail. Typecheck was clean, which
proved nothing.

## Escalation analysis (Loom, with file:line)

| question | answer |
|---|---|
| squad → org-wide? | **No.** Grants never bubble up (`capability.ts:17-20, 82-84`); exact squad only (`:97-100`); `hasWorkspaceAdmin` requires exact `org:admin` (`index.ts:604-607`). |
| department inheritance? | **Yes, and it is an authority *generator*.** A department grant covers every squad in it (`capability.ts:102-110`) **including future ones**, and `department:admin` passes `create_squad` (`provision.ts:220-257`). Chain: self-grant `department:admin` → create squad S2 under D → inherited admin on S2. Must be a **separate explicit ceiling**, never a synonym for squad self-grant. |
| peer delegation? | **Yes**, for an unbound principal. Self-granted `squad:admin` then passes `grant_agent_capability` (`provision.ts:925-978`) and can grant peers. "Self only" does not hold transitively — it must be *enforced*, not intended. |
| `gate:*`? | **Hold the line.** Gates are a separate `gate_grants` surface requiring exact org admin in dispatcher *and* handler (`mcp/gates.ts:19-20, 28-66`), and `approve_gate_edge` derives admin from `hasWorkspaceAdmin`. But also reject `scope=org` and `capability=owner` **structurally** — an enum allowlist, not string-prefix rejection. |
| floor blast radius | The AAGATE floor is deliberately **scope-agnostic** (`capability.ts:118-129`), so *any* self-granted admin on *any* scope passes the central floor for all **33 `min:admin` tools**. Security then rests entirely on each handler's own scope check. The sensitive gate surfaces were verified to retain exact org checks — but the floor no longer protects against a future handler omission. |

## The design to build instead

A door is not "lower the bar and remember to raise it". It is a **persisted generation** with
atomic receipts and a single reviewable close.

1. **Leave standing `create_agent` at `min: 'lead'`.** Add a separate onboarding surface, or have
   both paths consult one D1 `onboarding_doors` row keyed by `door_id`.
2. **Persist the door**: `status`, `opened_by`, `opened_at`, `closes_at`, and an explicit
   allowed-scope / allowed-rank policy.
3. **Write a `door_receipt` in the SAME D1 batch as the mutation** — `door_id`, actor, subject,
   scope type/id, requested capability, **prior capability**, resulting capability, action,
   timestamp. The bus stays a notification channel, never the ledger.
4. **One `close_onboarding_door(door_id)`**, org-admin only: flips open→closed so new writes fail
   immediately, and seals a count/hash manifest of all receipts. That single call is the close.
5. **Review and revoke work from the sealed receipts** — restoring prior capabilities, never blind
   deletion. Optionally `disposition=freeze_and_restore` for immediate rollback in one transaction.

## Mutation scenarios required before shipping

- delete the door-status check → closed-door test RED
- drop the durable receipt from the batch → the mutation fails; no orphan write
- self-grant `org` / `owner` / `gate:*` → 403
- squad self-grant cannot target another member or agent
- department grant demonstrably inherits to existing **and future** squads (explicit expected behaviour)
- if peer delegation is forbidden: self-issued `squad:admin` cannot grant to another agent
- close manifest count matches created + granted receipts; restore returns an overwritten
  `observer` grant **exactly**

---

*Review by Loom (Gemini 3.7 Flash), operator/network-integrity lens, 2026-08-17. Author: Kasra
(Claude). The BLOCK was accepted in full and no point disputed.*
