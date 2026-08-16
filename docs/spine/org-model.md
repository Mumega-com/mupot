# MU.100.0XX — Org Model: one hierarchy, one vocabulary (decision record)

**Status:** ADOPTED (decision record for mupot#1067 — smallest coherent v1)
**Scope:** vocabulary + hierarchy + join/create/dispatch semantics. Data model unchanged.
**Non-goals (this record):** no schema migration, no credential changes, no permission
changes, no destructive cleanup, no API/MCP field renames without a compat plan.

## 1. The one hierarchy

```
Department  — durable organizational boundary + policy/ownership container
   └── Squad — work unit; the canonical user-facing noun (see §2)
         └── Agent — one canonical operational identity; home squad = agents.squad_id;
                     additional memberships = memberships rows
```

Members (humans) are a separate first-class node; they hold capabilities over scopes
(org / department / squad). A member may be *welded* to an agent via
`agent_member_bindings` — that weld is the agent's identity, and credentials are bound
to it.

| Object | Identity | Owns work? | Owns identity? | Owns permissions? |
|---|---|---|---|---|
| Department | `departments.id` | policy/ownership | no | scope for admin |
| Squad | `squads.id` (UNIQUE dept+slug) | **yes** (tasks) | no | scope for lead/member |
| Agent | `agents.id` (UNIQUE squad+slug) | yes (assigned tasks) | **yes** | via welded member's capabilities |
| Member | `members.id` | no | yes (human) | **yes** — capabilities table |

## 2. Vocabulary: team vs squad

**Decision: "squad" is the canonical noun. "team" is a prose alias only.**

- The schema and all MCP/REST surfaces use `squad` (there is no `teams` table).
- Docs/prose may say "team" conversationally, but any new UI, receipt, or contract
  must use **squad**.
- Do NOT introduce a `teams` table unless a genuine distinct concept is defined first.

## 3. When to create vs reuse (one-page guide)

| Situation | Action |
|---|---|
| New operational identity that does not exist anywhere | **create_agent** on the home squad |
| Identity already exists (any squad) | **add existing agent** (membership) — never recreate |
| Same slug in 2+ live squads | **ambiguous** — resolve by exact `agent_id`; fail closed |
| Move an agent's home | **transfer** (explicit flow; NOT in v1) |
| New work unit | **create_squad** (admin on department) |
| New boundary | **create_department** (org admin) |

## 4. Relationships (authoritative sources)

| Relationship | Table | Notes |
|---|---|---|
| Home squad | `agents.squad_id` | one per agent |
| Additional memberships | `memberships` (agent×squad→capability) | 0..N |
| Member capability over scope | `capabilities` (member×scope→rank) | org/dept/squad |
| Member↔agent weld | `agent_member_bindings` | the token binds here |
| Credentials | `member_tokens` (HASHED) | bound to member, welded to agent |
| Project↔squad access | `project_squad_access` | read/write/admin |

Routing membership (`memberships`, `agents.squad_id`) ≠ effective capability
(`capabilities` + inheritance org→dept→squad). A UI or receipt must show the
**effective** result, not only the intended write.

## 5. Safe lifecycle rules (v1)

1. **Join never mints.** Adding an existing agent to a squad must not create a
   credential as a side effect. Mint stays a separate, explicit action.
2. **Join never duplicates.** Resolve by exact id first; slug only when unique;
   ambiguous → refuse and ask for the id.
3. **Preview before confirm.** Show home squad, current memberships, and the
   capability to be granted before the write.
4. **Create ≠ dispatch.** Creating a task (backlog) and dispatching it are separate
   actions with separate receipts.
5. **Read-only control center** surfaces the authoritative roster, effective
   capability + source, credential state (hashed only), and duplicate warnings.
