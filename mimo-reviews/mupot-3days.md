# Mupot Build Review: 2026-08-16 → 2026-08-19

**Window:** 2026-08-16T00:00Z — 2026-08-19T05:00Z  
**Commits on main:** 31  
**Merged PRs:** 25+  
**Contributors:** Hadi Servat (20 commits), mumega848 (9), kasra (2)

---

## 1. Flight / Watchdog

### What was built
- **#1127** — `evaluateFlightLiveness` predicate classifies non-terminal flights as `reap`, `escalate`, or `healthy`. Hard invariant: `waiting` (human-review) is NEVER auto-reaped, only escalated after 24h. Governed reap via `canReapFlight` (zero hardcoded literals; checks dispatcher, self, squad lead, org admin, or `mupot-watchdog` system principal), with atomic D1 `UPDATE ... WHERE status IN ('preflight','running','sleeping') RETURNING` and immutable `flight.reaped` outbox receipt.
- **#1151** — Wires the watchdog into `scheduled()` as the 12th maintenance heartbeat (slots at minutes 16, 33, 50). Sweep guarantees: (a) escalate-never-reap for waiting, (b) fail-soft per flight, (c) capped-scan reports `capped:true` so partial results are distinguishable from complete ones.
- **#1147** — Gives reap receipts their OWN table (`0109_flight_reap_receipts.sql`, purely additive) rather than widening the `flight_event_outbox` CHECK. Avoids a risky SQLite rebuild on a table with 6 trigger definitions, and prevents the flusher from announcing a reap as a landing.
- **#1153 / #1155** — Makes the `sleeping` / `next_run_at` guard a REAL test enforcement, including a backfill guard that walks migrations.
- **#1152** (merged but closed) — Loom follow-ups: fixes stale count comment (dynamic parse instead of hardcoded 11→12 pins), makes every heartbeat reachable and labels unique, and replaces silent catch with error logging per flight.
- **#1146** — Fixes maintenance slot `[10]` (token-expiry-warning) which was unreachable because `getUTCMinutes() % 15` only addresses indices 0-9 against an 11-entry array. This means token-expiry-warning NEVER ran in production until now.

**Files:** `src/flight/watchdog.ts`, `src/index.ts`, `migrations/0109_*.sql`, tests in `tests/flight-watchdog.test.ts`

### Independent risk/observation
The reap predicate for `sleeping` flights at `watchdog.ts:95` reasons from `next_run_at IS NULL` with zero grace. It is currently unreachable because the sole writer (`sleepFlight`) sets both columns atomically, but the second someone adds another writer that can produce `NULL`, this becomes an absence-reasoning time bomb with no grace period. The PR body acknowledges this as "recorded, not fixed." That is a latent regression waiting for the next feature branch touching the sleep state machine.

---

## 2. Gates / Authorization

### What was built
- **#1180** — Adds a supported re-gate path for review tasks: owner-only, mandatory reason, append-only history in `gate_owner_reassignments` table (`0113_*.sql`). Updates `mcp/index.ts` dispatch tools and MCP task-tool tests.
- **#1134** — Fixes `isOrgAdmin` to admit capability grants alongside legacy role. Adds `src/auth/refusal.ts` (canonical refusal shapes), extensive tests in `tests/org-admin-capability-gate.test.ts`, and wires capability reads into dashboard and addon routes. This fixed s530: the org owner was locked out of every admin page.

**Files:** `src/auth/capability.ts`, `src/auth/refusal.ts`, `src/dashboard/index.ts`, `src/addons/routes.ts`, `migrations/0113_*.sql`

### Independent risk/observation
The capability system is expanding fast: grants, refusals, reassignments, and liveness checks now all live in different files. The `refusal.ts` module is new and welcome, but there is no single invariant-checking test that asserts "for every gate action, either a grant exists or a refusal with a canonical reason is emitted." The scatter across `capability.ts`, `grants.ts`, `refusal.ts`, and migration files makes it easy for a future PR to add a new gate surface without wiring refusal emission.

---

## 3. Security

### What was built
- **#977** — Eliminates timing attack vulnerability in torivers addon auth (constant-time `crypto.timingSafeEqual`).
- **#1123** — Sentinel HIGH: fixes timing attack vulnerability in addon token validation (same pattern, different surface).
- **#1129** (s911) — A non-v1 flight could land with every gate skipped (budget, task-completion, gate checks, receipt generation all bypassed) when `meta` did not parse as `mupot.flight.meta/v1`. Now refuses with a controlled error.
- **#1128** (s1085) — `/credentials/match` answered YES to every scope; now refuses with 501 (not implemented) for unimplemented scope matching logic, preventing over-permissive credential grants.
- **#1100** — Redacts raw credentials from mint tool results in MCP responses.
- **#771** — Docs: GitHub + Mac-local credential audit, secrets-storage policy.

**Files:** `src/addons/torivers.ts`, `src/mcp/index.ts`, `tests/torivers-addon.test.ts`, docs

### Independent risk/observation
The `meta` version bypass (#1129) is the most alarming: a single unversioned landing path silently disabled every safety gate, receipt generation, and cost attribution. The fix is a refusal, which is correct, but there is no evidence of a broader sweep for other "version-gated" paths that may have silent fallthroughs. Any new feature that adds a version check should be accompanied by a lint/test rule that asserts "every branch after version parsing MUST either succeed with all checks OR fail with an explicit error — no bare fallthrough to the unguarded operation."

---

## 4. Presence / Onboarding

### What was built
- **#1118** — Seat activity: what a seat is doing, not just whether it is reachable. Adds `module_seat_activity` table (`0108_*.sql`), updates `src/mcp/presence.ts` and `src/registry/service.ts` (250 lines), with 455 lines of tests. This surfaces agent state beyond binary up/down.
- **#1121** — "Open the system": OAuth signup grants access, recorded and reversible. Adds `onboarding/doors.ts` (410 lines), `migrations/0107_onboarding_doors.sql`, docs, and 358 lines of tests. Notably reversible — the door can be closed.
- **#1126** — MCP initialize handshake returns canonical onboarding instructions.
- **#1099** — Names the `bootstrap_self` escape hatch on the empty consent screen.

**Files:** `src/onboarding/doors.ts`, `src/mcp/presence.ts`, `src/registry/service.ts`, `src/mcp/oauth-authorize.ts`

### Independent risk/observation
Seat activity surfaces rich state (455 lines of tests suggest complexity), but the privacy boundary is unclear. If a seat's activity includes task content or agent reasoning, this becomes a surveillance surface. The migration and registry changes do not show a TTL or retention policy on seat_activity rows, nor a scope check for who can query another seat's activity. Absent those, this feature may leak operational detail across tenant/agent boundaries.

---

## 5. Budget Policy

### What was built
- **#1179** (OPEN, not merged) — Fixes a critical double-meaning bug: `meter.ts` treated unset `budget_cap_cents` as "unlimited" while `mcp/index.ts` dispatch treated the same null/≤0 as "refuse the flight." Owner decision (Hadi): default budget to unlimited for now, because much of the fleet runs on rationed subscription capacity, not metered per-token dollars.
- **#1075** (merged 2026-08-16) — `task_create` dispatch flag for backlog parity (Flight-006 follow-up).

**Files:** `src/mcp/index.ts`, `src/flight/meter.ts`

### Independent risk/observation
The budget cap column is nullable with no default, and `create_agent`/`create_squad` leave it null. The "unlimited" default is an owner decision, not a schema default. If a future writer (SQL console, migration, admin tool) inserts a zero or negative value expecting "unlimited," the meter will treat it as unlimited but the dispatch guard (pre-#1179) would have refused it. Even post-#1179, having the semantic meaning of a null/zero column live in application code rather than a schema default or CHECK means every new code path touching budget must independently know the convention. The `budget_uncapped` reporting field is good observability, but the invariant is still verbal.

---

## 6. Dashboard / MCP Polish

### What was built
- **#1078** — Disambiguated Agent Selector (Flight-008 Slice 3) in dashboard.
- **#1077** — Consolidates hero-KPI aggregation into one canonical helper (Flight-008 Slice 1).
- **#1088** — Docs for "Muster" — crew half of preflight (F4 applied to crew).
- **#1076** (CLOSED, NOT MERGED) — Safe Approvals Triage: server-derived blocker reasons, resolved gate-lane owners with liveness checks, `can_verdict` computed field, batch-verdict idempotency. This was a large PR (closed without merge).
- **#1100** — Mint tool credential redaction.
- **#1126** — Onboarding instructions in MCP initialize.
- Various dashboard test coverage additions (parseDashboardCursor, grokSnippet, projectMutationStatus, etc.) — 8+ test-only PRs.

---

## 7. Unfinished or Risky

| Item | State | Risk |
|------|-------|------|
| **PR #1179** (budget cap alignment) | Open, not merged | This is a production-affecting double-meaning bug. Every null-cap agent/squad is currently blocked from dispatch by one code path while being treated as unlimited by another. The PR is approved in concept by owner but sits open. |
| **PR #1076** (safe approvals triage) | Closed without merge | Large feature (batch verdict, resolveGateOwner, can_verdict) that was gated and then abandoned. The in-flight gate UI may still show raw `gate_owner` chips with unconditional Approve/Reject buttons. |
| **PR #1152** (Loom follow-ups) | Closed without merge | Fixes comment-lies, silent catches, and stale test pins. These are real correctness issues that were flagged by a gate reviewer and then left unmerged. The stale count comment already bit production once (slot [10] unreachable). |
| **`watchdog.ts:95` sleeping NULL check** | Acknowledged, not fixed | Absence-reasoning with zero grace. Currently unreachable, but any new sleep-state writer turns it into an immediate reap bomb. |
| **Seat activity retention / privacy** | No TTL or scope guard visible | Operational surveillance data with no evidence of retention policy or cross-tenant access control. |
| **Landing version bypass (#1129)** | Fixed for this path | No evidence of a broader sweep for other version-gated paths with silent fallthroughs. The pattern is dangerous enough to warrant a lint rule or architectural test. |
| **Capability scatter** | Growing | `capability.ts`, `grants.ts`, `refusal.ts`, migration rules, dashboard routes — no single invariant test that every gate emits either a grant or a canonical refusal. |

---

## Summary Statistics

- **31 commits** across 4 days (6 on 08-16, 20 on 08-17, 5 on 08-18)
- **Major themes:** Flight/watchdog (reap, liveness, maintenance heartbeats), Security (timing attacks, gate bypasses, credential leak), AuthZ (capability grants, org-admin gate, re-gate path), Presence/onboarding (seat activity, OAuth doors), Budget policy (dispatch/meter alignment)
- **Test emphasis:** 8+ dedicated test-coverage PRs (dashboard cursors, change types, filters, snippet)
- **Merged but fragile:** #1151/#1153/#1155 (watchdog is new and the test guard has already caught one backfill gap)
- **Open risks:** #1179 (budget), #1152 (silent catch), sleeping NULL guard, seat activity privacy, capability scatter

---

*Reviewed by Athena (read-only) — 2026-08-19*
