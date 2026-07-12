# Capability-Aware Cross-Squad Task Assignment

## Context

Mupot agents have one home squad in `agents.squad_id`, while their bound member identity may hold
capabilities on additional squads. Issue #336 made those cross-squad grants safe and usable for
governed flights. The first live VPS Codex flight proved that authorization works, but task
assignment still rejects every agent whose home squad differs from the task squad.

Production evidence is recorded in issue #338 and flight
`91a3acab-3ce5-43ea-9263-36b6376d0273`. VPS Codex held active `member` capability on Runtime Fleet
and Build Integration, but assigning its Build Integration task returned
`assignee_not_in_squad`. The same task completed successfully when left unassigned.

## Goal

Make task ownership follow Mupot's existing identity and capability model: an active agent may own
a task in its home squad or in another squad where its one active bound member identity holds
effective `member`-or-higher capability.

Assignment does not move the agent, create a second membership plane, or grant authority. It only
records task responsibility after proving the agent can currently act on the task squad.

## Assignment Contract

The shared resolver accepts `(env, rawAssignee, taskSquadId)` and returns either the resolved agent
ID, an unassigned result, or one of the existing public errors.

1. `undefined` or `null` means unassigned.
2. A malformed or nonexistent agent ID returns `invalid_assignee`.
3. An inactive agent returns `assignee_not_in_squad`.
4. An active agent whose home squad equals the task squad is assignable without requiring a bound
   member token. This preserves the existing home-squad operating model.
5. An active cross-squad agent must resolve to exactly one active member identity through live,
   tenant-matched agent tokens.
6. That member's current grants must satisfy `member` on the task squad through org, department,
   exact squad, or channel capability inheritance.
7. Unminted, ambiguous, suspended, revoked, ungranted, and tenant-mismatched identities return
   `assignee_not_in_squad` without revealing which identity condition failed.

The caller independently needs its existing `member`-or-higher authority on the task squad.
Assigning an agent never changes caller authority or agent grants.

## Architecture

Add `src/tasks/assignee.ts` as the single assignment-policy module. It owns input validation,
agent status and home-squad compatibility, active bound-member resolution, capability loading, and
department-to-squad inheritance checks.

Both task surfaces use this resolver:

- HTTP task creation and update replace the local `resolveAssignee` implementation.
- MCP `task_update` replaces its private `resolveTaskAssignee` implementation.
- MCP `task_create` gains optional `assignee_agent_id` and resolves it through the same policy.

The resolver reuses `resolveActiveAgentMember`, `resolveCapabilities`, and `hasCapability`. It reads
the target squad's department ID server-side. No tenant, member identity, capability, or department
is accepted from request data.

## Consistency and Revocation

Assignment is responsibility metadata, not a durable authority grant. Capability and token checks
remain authoritative on every subsequent MCP or HTTP action.

The resolver evaluates current state immediately before task creation or update. If the agent's
last effective target-squad `member` capability is revoked before a later assignment request, that
request fails. Revocation does not rewrite or
unassign historical tasks; the assigned agent simply cannot perform future guarded actions without
current authority. This matches existing behavior for suspended agents and revoked credentials and
avoids destructive background mutation.

A capability can change between assignment validation and the task write. That race cannot confer
authority because execution re-authenticates and reloads capabilities. An assignment may briefly
record an agent that has just lost access, which is equivalent to revoking access after a completed
assignment. No migration or multi-statement write transaction is required.

## API Behavior

### HTTP

Existing request and response shapes remain unchanged. Both `POST /api/tasks` and
`PATCH /api/tasks/:id` accept cross-squad assignees under the shared policy.

### MCP

`task_update` keeps its current arguments and errors. `task_create` adds optional
`assignee_agent_id: string` and returns the created task with that assignment.

Public errors remain deliberately coarse:

| Condition | Result |
|---|---|
| Missing or malformed agent | `400 invalid_assignee` |
| Agent inactive | `400 assignee_not_in_squad` |
| Cross-squad agent unminted or ambiguous | `400 assignee_not_in_squad` |
| Bound member inactive, revoked, or from another tenant | `400 assignee_not_in_squad` |
| Bound member lacks effective target-squad `member` | `400 assignee_not_in_squad` |

## Security Invariants

- Tenant scope comes only from `env.TENANT_SLUG`.
- Cross-squad identity requires exactly one active member, not exactly one token.
- Multiple live tokens for the same member remain one identity.
- Home-squad assignment never mints or requires a credential.
- Cross-squad assignment never changes `agents.squad_id`.
- Assignment never creates, updates, returns, or logs a raw credential.
- The caller cannot use assignment to bypass its own target-squad authorization.
- Current capabilities remain mandatory when the agent later reads, updates, dispatches, or lands
  work.

## Verification

Tests must prove:

1. The shared resolver accepts active home-squad agents without a token.
2. It accepts a cross-squad agent with one active tenant-bound member holding exact squad,
   department, org, or channel-inherited `member` authority.
3. Multiple tokens bound to the same member are accepted as one identity.
4. Inactive, unminted, ambiguous, suspended-member, revoked-token, cross-tenant, observer-only, and
   ungranted agents fail closed.
5. Revoking the agent member's last effective target-squad `member` capability prevents a future
   assignment.
6. HTTP create/update and MCP create/update all use the shared policy.
7. MCP advertises the new optional `task_create.assignee_agent_id` schema.
8. A bearer-authenticated agent receives a cross-squad grant, reloads it, assigns itself to the
   cross-squad task, dispatches a zero-budget multi-squad flight, completes the assigned task, and
   lands the flight.
9. Existing same-home-squad assignment and unrelated task lifecycle tests remain green.

## Production Proof

After review and deployment, use the existing VPS Codex identity and persistent VPS credential.
Create a new Build Integration task, assign it to VPS Codex, and run a zero-budget flight spanning
Runtime Fleet and Build Integration. Capture task, flight, outbox, presence, and capability D1
receipts. Do not mint another VPS identity or credential.

The temporary owner credential used for deployment verification must be revoked. No customer
tenant, external customer data, DNS, payment, public publication, or unrelated VPS service may be
changed.
