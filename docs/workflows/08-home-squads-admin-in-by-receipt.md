# Home squads and admin-in by receipt

Source: mupot#1472 (private home squads — required `SquadScope`, `planeCoversScope`, no
standing grant into homes, elevation-to-home). Code cited at `origin/main` `3c706069`.

## Trigger

An org-admin or squad-admin needs to act inside a member's private **home squad**
(`squads.kind = 'home'`) for support/ops reasons, and has no standing grant there — every
ordinary inherited-authority path is closed on a home scope by design (`planeCoversScope`,
`src/auth/capability.ts:179`: `if (scope.kind === 'home') return false`). The only door in is a
time-boxed elevation request naming `action:home_access` and the exact squad.

## Actor(s)

The requesting principal (a **bound-agent session** only — a pure web/dashboard operator
session is refused before any scope check runs, see Known gaps), the **home squad's owner**
(the only valid approver), and the mupot backend.

## Tool/route sequence

1. `request_elevation` (MCP tool, `src/mcp/index.ts:4469`) — the agent asks for
   `actions: ['action:home_access']`, `scope_type: 'squad'`, `scope_id: <home squad id>`,
   `duration_minutes`, `reason`. Identity (`agentSessionId`/`agentId`/`memberId`) is derived
   from the authenticated session via `resolveAgentSessionContext(auth)`, never from request
   args — an agent cannot name a different session or another agent's request
   (`src/mcp/index.ts:4462-4469` comment; enforced by `resolveAgentSessionContext`).
   Writes a row via `createElevationRequest` (`src/auth/elevation.ts`) into
   `elevation_requests`. Response: `{ request: {...}, note: 'Pending human approval. No
   authority is granted yet — poll elevation_status or wait for it to be reflected on your
   next call.' }` (`src/mcp/index.ts:4536`).
2. `GET /auth/elevation/requests` (`src/auth/index.ts:1011`) — the home owner's dashboard
   session lists pending requests it has authority to decide (a request on a scope the
   operator cannot admin is not even listed — "Security Invariant 12").
3. `POST /auth/elevation/requests/:id/decide` (`src/auth/index.ts:1047`) → calls
   `decideElevationRequest` (`src/auth/elevation.ts:418`). Body: `{ decision: 'approve'|'deny',
   actions?, duration_minutes?, note? }` — `actions`/`duration_minutes` may only narrow the
   request, never widen it.
4. On approval, a row is written to `elevation_grants` inside the same decision transaction.
5. `elevation_status` (MCP tool, `src/mcp/index.ts:4542`) — the agent polls its session's live
   grants; each is re-evaluated live via `evaluateElevationGrant`.
6. On use, `canOnSquadAuth` (`src/auth/capability.ts:545-547`) checks, for a `kind==='home'`
   scope and a bound-agent caller: `hasElevatedAction(env, auth, 'action:home_access', 'squad',
   scope.id)` (dynamic-imported from `src/auth/elevation.ts` to avoid a module cycle).

## Human gate

- **Authority check, run before either terminal decision** (`decideElevationRequest`,
  `src/auth/elevation.ts:418`, "authority, checked BEFORE either terminal decision"): the
  decider must satisfy `decidedByOrgAdminCoversScope(...) || hasCapabilityOnDynamicScope(...,
  'admin')` (`src/auth/elevation.ts:392,470`). For a `squad` scope,
  `decidedByOrgAdminCoversScope` loads the real `SquadScope` and calls `planeCoversScope('org',
  scope)` — which returns `false` for `kind==='home'` (capability.ts:179) — so an **org-admin
  cannot approve a home-scope request**; only a caller holding an exact capability grant on
  that specific home (i.e. the owner) passes `hasCapabilityOnDynamicScope`. Confirmed by test:
  `tests/home-access-elevation.test.ts` — `"an ORG-ADMIN cannot approve action:home_access for
  someone else's home"` and the `decidedByIsOrgAdmin` boolean-flag variant, both denied.
- **Self-approval refused**: `if (input.decidedByMemberId === request.member_id) return {
  forbidden }` (`src/auth/elevation.ts`, same function) — a request is never its own approval.
- **Live re-derivation, not a cached grant**: `hasElevatedAction` re-checks, on every call, the
  agent session's own liveness, the grant's expiry/revocation, and the approving human's
  *current* live capabilities and web-session liveness — nothing is cached or materialized
  (module header comment, `src/auth/elevation.ts:10-23`). If the approving owner later loses
  standing authority, the grant stops working on the very next call even though the row is
  untouched.
- **Sensitive-action step-up**: approving a `SENSITIVE_STEP_UP_ACTIONS` action requires the
  decider's web session to have a fresh reauth within 5 minutes (`src/auth/index.ts:1047`
  comment + `hasRecentReauth` call).

## Receipt(s) written

- `elevation_requests` (migration `0148_elevation_ledger.sql`): `id, tenant,
  agent_session_id, agent_id, member_id, requested_actions_json, requested_scope_type,
  requested_scope_id, requested_duration_minutes, reason, status
  (pending|approved|denied|expired|revoked), created_at, decision_expires_at, decided_at,
  decided_by_member_id, decided_by_web_session_hash, decision_note`.
- `elevation_grants`: `id, tenant, elevation_request_id, agent_session_id, action, scope_type,
  scope_id, effect (reversible|irreversible|revocable_if_recorded), approved_by_member_id,
  approved_by_web_session_hash, created_at, expires_at, revoked_at, revoke_reason` — unique on
  `(agent_session_id, action, scope_type, scope_id)`.
- `elevation_usage_log`: `id, tenant, elevation_grant_id, agent_session_id, action, tool_name,
  detail_json, occurred_at` — one row per action actually taken under the grant, outlives the
  grant (no `ON DELETE CASCADE` from `elevation_grants`).
- **Not a receipt**: the elevation ledger never writes into `capabilities`, `gate_grants`,
  `memberships`, `agent_member_bindings`, or `project_squad_access` — those are the five
  tables holding *standing* authority, and elevation is deliberately never one of them
  (module header, `src/auth/elevation.ts:12-16`).

## What the person sees

- Agent, on request: `note: 'Pending human approval. No authority is granted yet — poll
  elevation_status or wait for it to be reflected on your next call.'`
- Elevation action label shown to the approver: `"Access a member's home"` — description
  `"Time-boxed read on ONE named home squad (never a standing grant)."`, effect
  `reversible`, effect note `"Read-only and scoped to a single squad; the access itself
  leaves no lasting effect once the grant expires."` (`src/auth/elevation-actions.ts:159-166`).
- Agent, on `elevation_status`: `{ session_id, request, active_elevations: [{ id, action,
  label, scope_type, scope_id, effect, expires_at, live }] }` (`src/mcp/index.ts:4542`).
- No notice is sent to the home-squad owner when someone *else* triggers the flow — the owner
  only sees it because they themselves are the required approver.

## Tests that pin it

- `tests/home-access-elevation.test.ts` — baseline refusal, org-admin refused at approval
  (both capability-grant and legacy `decidedByIsOrgAdmin` flag shapes, approve and deny),
  owner-approves → allowed → expiry → refused again, a second home untouched by the same
  grant.
- `tests/home-squad-org-admin-isolation.test.ts` — the broader isolation invariant this
  elevation door is the sanctioned exception to (org-scope grant refused on `squad_recall`,
  `squad_member_list`, `task_list`, `task_board`, `wake_agent`, `peers`; legacy-owner still
  admits on a real work squad).
- `tests/elevation.test.ts` — general elevation-ledger constraints (no idle-ceiling extension,
  controlled-clock expiry).

## Known gaps

- **Dashboard/web-session operators have no path in at all** — `hasElevatedAction` refuses
  any non-bound-agent session with `not_agent_session` before consulting scope, and
  `elevation_requests.agent_session_id` is `NOT NULL`, so a human-only operator cannot
  populate a request. Tracked as **mupot#1474** ("blocks FP-01 G-FP3 live day").
- **The self-repair path was deliberately removed, not merely un-receipted.**
  `createHomeForMember` originally had a `'repaired'` disposition (writing a capability row
  for a member who reaches an existing home squad with no grant on it), but Athena's round-2
  ruling on point 6 (2026-09-21) closed it: none of the three existing receipt ledgers
  (`elevation_grants`/`elevation_usage_log`, `door_receipts`, `membership_receipts`) fit a
  member-only, agent-less, door-less, session-less event without a schema change, and rather
  than ship a write with no receipt the disposition union is now exactly `'created' | 'existing'`
  (`src/org/service.ts:502-509`). Reaching an existing home with no grant now returns
  `disposition: 'existing'` with **no grant and no capability row written**
  (`src/org/service.ts:583-596`) — pinned by `tests/home-squad-org-admin-isolation.test.ts`
  ("the repair path is CLOSED... never written by createHomeForMember, for anyone"). A
  real receipted repair mechanism does not exist yet.
- **`resolveAccessibleSquadIds`'s other consumers** (`dashboard/agents-admin.ts`,
  `dashboard/fleet.ts`, `dashboard/brain.ts`, `dashboard/mission-control-routes.ts`,
  `mcp/runners.ts` ×2) inherit the home-exclusion fix via a shared `=== null` check but were
  not individually tested — tracked as **mupot#1475**.
- **mupot#1489**: an org-admin can still write a home→project edge directly via
  `project_squad_set`, bypassing the project-access proposal→verdict→receipt ledger — ruled
  that elevation-with-receipt should be the only path; not yet closed as of this writing.
- **mupot#1480**: 9 of 19 round-2 mutation tests against PR #1472's round-1 P0 fixes survived
  — regression coverage on several of the exact call sites this doc describes is incomplete.
- **Migration status**: `migrations/0148_elevation_ledger.sql`'s own header states it is "NOT
  applied by this build — branch/schema only... a human applies it separately," matching the
  pattern of migrations 0143/0144/0147. Whether it has since been applied to the live database
  should be verified operationally before trusting this flow works in production; this doc
  describes the code as written, not a confirmed live-DB state.
