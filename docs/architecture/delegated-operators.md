# Delegated operators (Operators + Admission, wave W0)

Task 65b11e48, mumega-com#1386. Behind `DELEGATED_OPERATORS` (`"1"` or `"true"`; unset = off).

## The problem

Every agent-bound caller was refused on MCP for capability-granting and org-structure writes
(`operator_principal_required`), whatever its rank, while the HTTP members route let an org-admin agent do the same act
through `requireCapability`, which never looks at `boundAgentId` (#1357). Same act, two doors, opposite rules.

## The shape

One function, `authorizeStructuralWrite(env, auth, action, target)` in `src/operators/chokepoint.ts`, asked by every
structural write on MCP and HTTP. A non-agent caller gets `principal` and the site keeps its own capability checks. An
agent-bound caller gets one of:

| verdict | meaning |
|---|---|
| `refused` | `operator_principal_required`, `outside_delegation_scope`, `delegator_authority_lost`, `cannot_act_on_self`, `human_target_forbidden`, `home_scope_not_grantable`, or `requires_human_approval` |
| `agent_legacy` | the pre-W0 lane for THIS action is still open (a live human-approved elevation grant; or the agent's own capability grants, where MCP always allowed that and the flag is off) |
| `delegated` | a live delegation covers the target, its delegator still holds admin over the delegation scope right now, and the act is inside the ceiling; the receipt is already written |

`STRUCTURAL_ACTIONS` is the registry: per action, `delegable` and the agent lane. `STRUCTURAL_MCP_TOOLS` maps tool name to
action; `tests/operator-chokepoint-ratchet.test.ts` fails if a tool, an HTTP route, or a new file that writes a structural
table bypasses it.

## Delegations

`agent_operator_delegations` (migration 0217): agent, delegator (a human), scope (`org`, `department`, `squad`,
`project`), `max_grant` (`member` or `lead`, CHECK-bounded, never admin or owner), `revoked_at`. A partial unique index
allows one live row per agent and scope. A trigger makes a row immutable except for the one-way revoke; rows are never
deleted. Created and revoked only by `operator_delegate` / `operator_revoke` (human principals, refused for any agent-bound
session, with the writers re-checking "human" themselves). `operator_list` reads them.

A project has no capability scope of its own, so admin over a project means org admin (as everywhere else in project
structure). A PROJECT delegation covers the project's own edge-management acts and NO squad: "squads linked to the project"
is mutable state, so counting it would let a delegation widen itself (attach a squad, then act there; or a later human link).
`project_squad_set` under delegation needs the project covered AND the ATTACHED squad covered by a NON-project delegation
scope (org, department or squad) whose delegator is still live. `project_squad_remove` needs the project only.

## The ceiling

`min(max_grant, delegator's live rank on the squad, the agent's own live rank on the squad)`. Above it, the answer is
`requires_human_approval`, flat JSON on HTTP and `detail` on MCP:

```json
{ "error": "requires_human_approval", "requires_human_approval": true, "act": "squad_member_add",
  "reason": "above_max_grant | above_delegator_rank | above_agent_rank | target_outranks_delegation",
  "delegation_id": "...", "requested": { "capability": "lead" }, "max_grant": "member", "ceiling_rank": 2 }
```

A later wave can turn that into a secure moment. A target agent whose standing ANYWHERE (seat capabilities across org,
department and squad scopes, the legacy role plane, and any membership) is above `max_grant` is not the agent's to touch at
all: standing is global, the #1411 rank-ceiling rule. `create_agent` writes a member-rank membership, so it CONFERS `member`
and meets the same ceiling (the agent must itself hold member or better on that squad), and a slug that collides with any
existing agent in the tenant is refused (`slug_taken`) so a delegate cannot make slug resolution ambiguous for humans.

## Never, delegation or not

Admin or owner grants (above every ceiling); `gate_grants` (also closed for ALL agents flag-independently); minting,
listing, revoking or revealing tokens, keys and connections; any act on the agent itself; any act on a human member or the
delegator; changing delegations; home squads and departments; money, deploy, publish (not structural; untouched).

## Re-derived per request

Nothing is cached. The delegation row, the delegator's membership status, the delegator's live rank (grants and the legacy
role plane) on the delegation scope, and both ranks on the target are read on every call. Revocation, a demoted or
suspended delegator, or a revoked delegator seat bite on the next request.

## Overlapping delegations

An agent can hold several live delegations that cover the same act (an org/member row and a squad/lead row, say). The
chokepoint judges the act under EVERY live covering delegation whose delegator is still admin and uses the one that PERMITS
it with the highest ceiling (ties go to the oldest). The oldest row never shadows a newer, more permissive one. The receipt's
`delegation_id` is the one used; `detail.considered_delegation_ids` lists every candidate. If none permits, the refusal is
reported under the most permissive candidate. For `project_squad_set` the ATTACH delegation is chosen the same way (highest
`max_grant` among the live non-project delegations covering the squad) and the ceiling is the lower of the two `max_grant`s.

## Target identity

A seat member's agent is resolved by the chokepoint from `agent_member_bindings` WHATEVER the member's status, so a suspended
seat cannot make the target's standing vanish from the guard (the active-only `resolveBoundAgentForMember` returned null for a
suspended seat and skipped it). An act that changes what an existing agent holds and names no agent is refused fail-closed
(`target_identity_required`). A target holding ANY `gate_grants` row (as the agent or as its seat member) is top standing: gate
authority is not a rank, so no delegate can add, remove or move it. After the gate, a site that resolves the references again
compares them with `delegatedTargetDrift` and refuses `target_changed` on a mismatch; `move_agent_squad` additionally binds the
gate's source squad into the write itself (the first statement of its batch aborts and rolls the batch back unless the agent
still sits in that squad, `source_squad_changed`).

## Receipts

Every delegated structural write writes `operator_delegation_receipts` BEFORE the write: agent, the agent's seat member,
delegator, delegation id, action, surface (`mcp`|`http`), target scope, ceiling, `detail.delegations` (every delegation that
took part, with its delegator and role `covering` or `attach_squad`) and `outcome = 'attempted'`. A site closes it after the
write (`applied` when it landed, `refused` when the write was refused or changed nothing, for example an `unchanged` add).
Closing is also STRUCTURAL: the MCP dispatcher and the org, projects and members HTTP apps call
`settleOpenDelegatedReceipts` after every call, which moves any receipt still `attempted` to `applied` (2xx) or `refused`
(4xx). A 5xx or a throw is left `attempted` on purpose, which honestly means "authorised, outcome unknown". A covered act that
the chokepoint itself refuses (ceiling, target standing, slug, attached squad) leaves an `outcome = 'refused'` row. The only
legal UPDATE is `attempted -> applied|refused`; no deletes; no foreign keys (the record outlives agent, member and
delegation). The existing `membership_receipts` rows for `squad_member_add/remove` still record the agent as actor.

## Revoking

The original delegator can always withdraw their delegation, even after being demoted (`operator_revoke` has the
`authenticated` floor; `revokeDelegation` enforces "human, and the delegator or admin over the scope"). Any agent-bound caller
is refused by the chokepoint before an argument is read.

## Other doors that create structure

`addon_activate`, `addon_setup` and `POST /api/addons/:key/activate` ask the chokepoint for `activate_addon` (activation
materializes a department and squads through `activateDepartment`): not delegable, the agent keeps its pre-W0 capability
lane. `seedSquadPack` and `seedOutreachLoop` (human dashboard / admin routes) ask for `create_squad` and refuse every agent.
The caller census matches a writer by NAME anywhere in the source, so an aliased import or a default-injected reference
(`deps.createSquad ?? createSquad`) cannot hide a caller.

## Fixing departments and squads: who can do what

| Act | Human org admin | Agent | Delegated operator (flag on) |
|---|---|---|---|
| `create_department` | yes (standing org admin) | only under a live `action:org_structure` elevation granted at ORG scope (or a standing org-admin grant, the pre-existing lane) | no, not delegable |
| `update_department` (rename; work departments only) | yes (department admin, org admin inherits) | only under a live `action:org_structure` elevation granted on that department or at org scope; a standing grant never opens it | no, not delegable |
| `update_squad` (slug, budget) | yes (squad admin, inherited) | only under a live `action:org_structure` elevation granted on that squad, its department, or org; a standing grant never opens it | no, not delegable |
| `create_squad` | yes | `action:project_lifecycle` on the department, or a capability grant | yes, inside the delegation |

The agent path is the existing elevation mechanism, not a new one: the agent calls `request_elevation` with
`action:org_structure` and a scope, a human approves it at the secure moment, and the grant is a time window (multi-use
until it expires or is revoked; every use is written to `elevation_usage_log`). Approving it grants no standing capability.
It is reversible (everything it can do, a standing admin can undo) and is not a step-up action. It never reaches a home
department or home squad, never archives or deletes (there is no delete path), and a slug rename into a name that
`team_bootstrap` has reserved still needs standing department admin. An ATTACHED seat thread is refused `request_elevation`
and refused these three tools even if a grant row exists for its credential.

## Flag semantics

- Off: MCP is unchanged. The HTTP doors now apply the same chokepoint: an org-admin agent is refused over HTTP exactly as
  on MCP. Delegations are ignored. `operator_delegate` answers `delegated_operators_disabled`.
- On: a bound agent may also act inside a live delegation. For the DELEGABLE acts that previously accepted an agent by its
  own capability grants (`create_squad`, `create_agent`, `project_squad_set/remove`), the capability lane is closed: the
  delegation replaces it. Non-delegable acts keep their pre-W0 lane.

## Flag-INDEPENDENT tightenings (these ship even with the flag off)

- The HTTP doors apply the chokepoint, closing #1357: an org-admin AGENT is refused (`operator_principal_required`) on
  `POST /api/members/members/:id/capabilities`, `POST/DELETE .../tokens`, `PATCH .../members/:id` (suspend),
  `DELETE .../telegram`, `POST /api/members/invites` (refused for ALL agents, project invites included), and
  `POST /api/org/agents/:id/memberships` (main's refusal kept: no manage_access elevation lane over HTTP, and no
  `isOrgAdmin` shortcut that could grant admin).
- Gate grants: `grant_gate_capability` / `revoke_gate_capability` (MCP) and `POST/DELETE /api/gates/grants` refuse every
  agent-bound caller. This REMOVES org-admin agents' ability to grant or revoke gate authority, Kasra's seat included. Use a
  human session or the human-only path.
- `project_create` and the planned->active start (`project_update`, `PATCH /api/projects/:id`) are routed through the chokepoint
  as non-delegable actions with the pre-W0 lane, so an agent behaves exactly as before; the structural side effect (a new
  department, squad and agent) is never delegable because no delegation scope can cover a NEW department.

## Human-only check (`memberLooksAgentBound`)

Who may delegate, and who may be a delegator, uses the fail-closed union: bound in `agent_member_bindings` OR holding any
`member_tokens` row welded to an agent. The TARGET rule ("an act on a human member is refused") still uses the binding
table alone (a wrong "agent" answer there would be the unsafe one). It was NOT verified against production data that no
human row carries a legacy binding; the union makes the creation side over-refuse rather than under-refuse.

## Production data check (2026-10-13)

`agent_member_bindings` was checked read-only in production: 84 rows, and none belongs to a member with a human login identity or a passkey. The stricter `memberLooksAgentBound` union (used for the delegator and creator checks) is therefore a conservative choice, not a workaround for bad data.
