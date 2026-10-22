# task_brief: context travels with the work

An agent that picks up a bare ticket does not know why the project exists, what the team already
learned, what its sibling tasks did, or who may approve what. `task_brief { task_id }` returns all of
that in one call: a ranked pack of about 2,500 tokens, every line tagged with a `[kind:id]` handle so
the agent can drill in with the tools it already has. `task_get` now carries a `hint` pointing at it,
and the initialize instructions tell an agent to start there.

Read-only. Same visibility as `task_get`: a task the caller cannot read answers the same
`task_not_found` as a missing id.

## What is in it

| Section | Content | Source |
|---|---|---|
| Task | title, status, priority, gate lane, project risk class, `done_when`, the ask, the last 5 notes, execution hold | `tasks`, `execution_holds`, `project_seeds` |
| Why it matters | project goal and description, objective, flight and lane, parent task | `projects`, `objectives`, `flights`, `flight_lanes` |
| What we know | up to 8 project memory entries, wiki topics and lessons, ranked against the task text | `createMemory().recall`, `getProjectWikiGraph` |
| Related work | sibling tasks (same flight, parent, objective), the last 3 project verdicts with their reasons, failed attempts on this task | `tasks`, `task_verdicts`, `task_dispatch_receipts` |
| How this team works | playbook memory entries (concept `playbook`/`conventions`), the project seed's rules (`human_only`, `forbidden`), the decision ladder | `engrams`, `project_seeds` |
| Open questions | notes marked `Question:`/`Q:`/`Blocked:` or ending in `?`, a blocked status | the task body |

Notes: a task has no notes table. `task_update { note }` appends to the body, so the trailing
blocks of the body are the notes (newest last) and the leading blocks are the original ask. Risk class
is the project seed's `risk.class` (there is no per-task risk column); with no seed attached it is omitted.

A section with nothing to say is omitted, not rendered empty. A source that fails (wiki unreachable, the
embedding model down, a table missing) is an empty leg: the brief degrades, it never errors.

## What is not in it, and why

- Anything the caller could not read through the existing tools: siblings and verdicts go through the
  same squad-visibility predicate as `task_list`; project sections need project read (`readableProject`);
  dispatch-failure detail needs `canViewTaskReceipts` (assignee, gate-lane holder, org admin).
- Another tenant's rows: every flight/objective/seed/receipt query filters on the pot's tenant.
- Who holds a gate lane. The ladder names the lane, not its holders (that is org-admin audit data).
- Secrets: free text is run through `redactSecretPatterns` and collapsed onto one line, so a note
  cannot forge a heading or a prompt line.

## Budget and ranking

The budget is 2,500 estimated tokens (characters / 3.5, deliberately pessimistic for id-heavy text).
Each field has a cap; if the pack is still over, the least important lines are dropped first (older
memory, further siblings, notes), never the title, `done_when` or the ask. `trimmed` in the result
says what was cut.

Memory ranking: vector score plus a lexical-overlap bonus against the task title, `done_when` and ask;
lessons get a small boost; a hit with no shared term and a distant vector is the index padding its
topK and is dropped. Wiki topics keep up to 2 of the 8 slots.

Code: `src/tasks/brief.ts` (assembly), `src/mcp/task-brief.ts` (tool, RBAC), `tests/task-brief.test.ts`.
