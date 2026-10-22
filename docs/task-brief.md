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
| How this team works | playbook memory entries (concept `playbook`/`conventions`), chosen by relevance to the task; the project seed's rules (`human_only`, `forbidden`; `allow_direct` shown as *requested*, never as allowed) | `engrams`, `project_seeds` |
| Open questions | notes marked `Question:`/`Q:`/`Blocked:` or ending in `?`, a blocked status | the task body |
| System rules | the decision ladder and a framing line. Written by mupot, rendered last, never trimmed; no stored text can enter it | static text + the task's gate lane (only if it matches the lane grammar) |

Notes: a task has no notes table. `task_update { note }` appends to the body, so the trailing
blocks of the body are the notes (newest last) and the leading blocks are the original ask. Risk class
is the project seed's `risk.class` (there is no per-task risk column); with no seed attached it is omitted.

A section with nothing to say is omitted, not rendered empty. A source that fails (wiki unreachable, the
embedding model down, a table missing) is an empty leg: the brief degrades, it never errors.

## What is not in it, and why

- Anything the caller could not read through the existing tools. The rule: the brief calls each source's
  OWN visibility function and never re-derives visibility from the task scope. Siblings, the parent and
  project verdicts use the `task_list` predicate (`visibleTaskClause`); project sections need
  `readableProject`; a flight needs flight-spine's `visibleFlight` (observer on every squad of the
  flight, and project read) and an objective its `visibleObjective`; if the flight is not visible, nothing
  reached through it (objective, same-flight siblings) is shown; dispatch failures, runtime failures and
  rejected verdicts on this task need `canViewTaskReceipts` (assignee, gate-lane holder, org admin).
- Another tenant's rows: every flight/objective/seed/receipt query filters on the pot's tenant.
- Who holds a gate lane. The ladder names the lane, not its holders (that is org-admin audit data).
- Secrets, and text that steers: every stored string (titles, notes, goals, memory, wiki, verdict reasons,
  seed rules) is redacted with `redactSecretPatterns`, collapsed onto one line, has `[ ]`, em/en dashes and
  middle dots neutralised, and is rendered QUOTED. Memory, wiki and playbook lines are also labelled
  `member-written, unverified`. A memory entry that contains `## System rules` or `[task:x] ... - status done`
  therefore shows up as a quoted string inside one bullet, never as a heading, handle or meta line.
- Wiki topics are validated (published, string fields, slug in `[a-z0-9_/-]`); a topic gated by any key other
  than the service's `mupot:project` marker is skipped. `mupot:project` counts as satisfied because the wiki
  leg only runs after `readableProject` passed.

## Budget and ranking

The budget is 2,500 estimated tokens (characters / 3.5, deliberately pessimistic for id-heavy text).
Each field has a cap; if the pack is still over, the least important lines are dropped first (older
memory, further siblings, notes), never the title, `done_when` or the ask. `trimmed` in the result
says what was cut.

Memory ranking: vector score plus a lexical-overlap bonus against the task title, `done_when` and ask;
lessons get a small boost; a hit with no shared term and a distant vector is the index padding its
topK and is dropped. If recall returns nothing, the newest entries are ranked by overlap alone. Wiki topics
keep up to 2 of the 8 slots. Playbook entries are picked the same way (relevance, then recency), from the
newest 200 tagged entries plus any tagged recall hit, so newer entries cannot push the relevant one out.

Code: `src/tasks/brief.ts` (assembly), `src/mcp/task-brief.ts` (tool, RBAC), `tests/task-brief.test.ts`.
