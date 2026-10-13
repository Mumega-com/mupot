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
structure). A project delegation covers the project and the squads linked to it.

## The ceiling

`min(max_grant, delegator's live rank on the squad, the agent's own live rank on the squad)`. Above it, the answer is
`requires_human_approval`, flat JSON on HTTP and `detail` on MCP:

```json
{ "error": "requires_human_approval", "requires_human_approval": true, "act": "squad_member_add",
  "reason": "above_max_grant | above_delegator_rank | above_agent_rank | target_outranks_delegation",
  "delegation_id": "...", "requested": { "capability": "lead" }, "max_grant": "member", "ceiling_rank": 2 }
```

A later wave can turn that into a secure moment. An existing standing above `max_grant` on the target agent (an admin
membership, say) is not the agent's to overwrite, remove or move either.

## Never, delegation or not

Admin or owner grants (above every ceiling); `gate_grants` (also closed for ALL agents flag-independently); minting,
listing, revoking or revealing tokens, keys and connections; any act on the agent itself; any act on a human member or the
delegator; changing delegations; home squads and departments; money, deploy, publish (not structural; untouched).

## Re-derived per request

Nothing is cached. The delegation row, the delegator's membership status, the delegator's live rank (grants and the legacy
role plane) on the delegation scope, and both ranks on the target are read on every call. Revocation, a demoted or
suspended delegator, or a revoked delegator seat bite on the next request.

## Receipts

Every delegated structural write writes `operator_delegation_receipts` BEFORE the write: agent, the agent's seat member,
delegator, delegation id, action, surface (`mcp`|`http`), target scope, ceiling. It is an authorization receipt: an act
that then fails downstream still leaves a row, and no applied delegated write exists without one. Append-only by trigger,
no foreign keys (the record outlives agent, member and delegation). The existing `membership_receipts` rows for
`squad_member_add/remove` still record the agent as actor.

## Flag semantics

- Off: MCP is unchanged. The HTTP doors now apply the same chokepoint: an org-admin agent is refused over HTTP exactly as
  on MCP. Delegations are ignored. `operator_delegate` answers `delegated_operators_disabled`.
- On: a bound agent may also act inside a live delegation. For the DELEGABLE acts that previously accepted an agent by its
  own capability grants (`create_squad`, `create_agent`, `project_squad_set/remove`), the capability lane is closed: the
  delegation replaces it. Non-delegable acts keep their pre-W0 lane.
