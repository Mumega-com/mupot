# Archive and hygiene — operator runbook

mupot#1496 (PR #1561, `ac312ba8`; migration `0173_archive_columns.sql`). Archives
`members`, `agents`, `squads`, and `projects` rows with an immutable receipt.
`tasks` is intentionally not supported yet — see "Tasks are not supported" below.

## What archiving is, and is not

Archiving is a soft-delete signal, not a status change on its own for most
tables:

- **`members`** — archiving ALWAYS suspends the member (`status` flips to
  `'suspended'`) and revokes its live tokens, web sessions, and agent
  sessions. `archived_prior_status` captures the true prior status (a member
  could already be `'suspended'` for an unrelated reason) so `unarchive_row`
  restores it exactly, never hardcoding `'active'`.
- **`agents`** — archiving is orthogonal to `status`. An agent must already be
  `status='inactive'` (call `deactivate_agent` first) before it can be
  archived; `archive_row` never deactivates implicitly.
- **`squads`** — gained a brand-new `status` column in migration 0173
  (`'active'` / `'archived'`, CHECK-constrained; squads had no status column
  before this migration).
- **`projects`** — reuses the existing `status='archived'` value (the CHECK
  already allowed it). `archived_prior_status` captures what to restore on
  unarchive, since `projects.status` has six legal values.
- **`tasks`** — `tasks.status` is never touched by archiving, by design (see
  the migration's own header: 12 triggers plus 8 RESTRICT foreign-key
  referrers make status-enum widening far riskier here than on the other four
  tables). A side table, `tasks_archive_state` (`task_id`, `archived_at`,
  `archived_reason`, `archived_by_member_id`, `prior_status`, `created_at`),
  exists in the schema for a future pass, but nothing writes to it today.

## Tasks are not supported (mupot#1571)

`archive_row`, `unarchive_row`, and `archive_plan_expand` all refuse
`table: "tasks"` unconditionally with `409 not_supported` —
`{ table: 'tasks', issue: 'https://github.com/Mumega-com/mupot/issues/1571' }`.
Task archiving needs its own action-boundary pass across roughly ten
task-mutating tools and is out of scope for this substrate. `archive_plan_expand`
is registered (not deleted) specifically so #1571 can re-enable it by
reverting one early-return in `src/mcp/archive.ts`, rather than rebuilding the
tool from scratch.

`scripts/hygiene-archive.mjs` enforces the same refusal client-side, in plan
mode, for both a literal `{table:'tasks', id}` entry and a `where`-shaped bulk
filter — a tasks entry never reaches the server only to fail there.

## Who can call this

`archive_row`, `unarchive_row`, and `archive_plan_expand` require an
**operator principal**: org-admin capability (`hasWorkspaceAdmin`) AND no
`boundAgentId` on the caller. An agent-bound bearer — including an agent's own
welded credential — gets `403 operator_principal_required` before any other
check runs. Applying a plan therefore needs an unbound org-admin bearer or an
operator dashboard session; no agent seat can do it, by design (same bar as
`move_agent_squad` and `team_bootstrap`, not `deactivate_agent`'s narrower
single-scope bar).

Registration is REST-transparent: these are ordinary `ToolSpec`s in
`src/mcp/archive.ts`, so `POST /actions/archive_row` /
`/actions/unarchive_row` / `/actions/archive_plan_expand` dispatch through the
same `invokeTool` seam any registered tool uses. There is no separate route.

## Refusal reasons (`archive_row`)

| Error | Meaning |
|---|---|
| `not_found` | No row for `table`/`id`. |
| `invalid_reason` | `reason` must be 1–2000 characters. |
| `active_dependents` | The row has live dependents that block archiving (counts included). |
| `live_execution_claim` | A live execution claim is in progress. |
| `in_air_flight` | A flight is currently in the air against this row. |
| `owns_active_agent` | An `agent_member_bindings` row, a live agent-bound `member_tokens` row, or `agents.owner_member_id` still points at a `status=active` agent (counts included). |
| `cannot_archive_self` | The caller cannot archive their own member row. |
| `cannot_affect_higher_rank` | The same #1337 rank-ceiling predicate `PATCH /members/:id` enforces. |
| `last_org_owner` | Refuses to archive the org's last owner. |
| `must_deactivate_first` | Agents only — call `deactivate_agent` first. |
| `not_supported` | `table: "tasks"` — see above. |
| `archive_refused_conflict` | A 0-row guarded write with no re-derivable refusal reason and the row not actually archived — an unexplained write conflict (e.g. a benign race), never reported as a success. Re-check state and retry. |

`unarchive_row` shares `not_found`, `invalid_reason`,
`cannot_affect_higher_rank`, and `not_supported`.

## The two-step CLI: `scripts/hygiene-archive.mjs`

Calls the live pot's REST actions surface
(`POST /actions/archive_row` / `/unarchive_row` / `/archive_plan_expand`) with
a bearer read from a token file — never printed, never placed in argv.

**Env:**

- `MUPOT_BASE_URL` — default `https://mupot.mumega.com`.
- `MUPOT_TOKEN_FILE` — required, no default. A path to a file holding the
  bearer token for an unbound org-admin (or operator dashboard session) —
  refuses to guess a path for a credential this sensitive.

**Step 1 — plan mode** (nothing is archived):

```bash
node scripts/hygiene-archive.mjs --plan plan.json
```

`plan.json` is a JSON array of literal entries:

```json
[{ "table": "members", "id": "<id>", "reason": "<reason>" }]
```

`table` is one of `members` / `agents` / `squads` / `projects` — `tasks` is
refused outright, in plan mode, for both a literal entry and a `where`-shaped
bulk filter (see "Tasks are not supported"). `reason` is required on every
entry. Plan mode validates every entry, prints the reviewed id list, and
writes `plan.json.expanded.json`. This is the ONLY step that produces the
file the apply step consumes — apply never re-derives a filter.

**Step 2 — apply mode**, against the file plan mode just wrote:

```bash
node scripts/hygiene-archive.mjs --plan plan.json.expanded.json --apply
node scripts/hygiene-archive.mjs --plan plan.json.expanded.json --apply --unarchive
```

Apply mode requires the plan file to already be a flat, literal list — no
`where` entries. It refuses outright (before calling anything) if it finds an
unexpanded `where` entry, rather than silently expanding a possibly-different
set of rows on your behalf. This is the fix for a round-2 adversarial finding
(P1-5): a live filter can drift between "what a human reviewed" and "what
actually got archived" if expansion is re-run at apply time — so it never is.

Apply mode calls `archive_row`/`unarchive_row` once per entry and reports
`OK`/`FAIL` per row plus a final `N ok, M failed` summary; a non-zero failure
count sets a non-zero exit code.

## Receipts

Every successful `archive_row`/`unarchive_row` call writes one row to
`archive_receipts` (migration 0173): `id`, `tenant`, `entity_table` (CHECK'd to
the five archivable tables), `entity_id`, `action` (`'archive'`/`'unarchive'`),
`reason`, `actor_member_id`, `prior_status`, `created_at`. The table is
append-only — `archive_receipts_no_update` and `archive_receipts_no_delete`
triggers `RAISE(ABORT, ...)` on any `UPDATE`/`DELETE`, matching every other
receipts table in this repo (`membership_receipts`,
`telegram_unbind_receipts`, `telegram_origin_bind_receipts`,
`team_bootstrap_receipts`). Query by entity via
`idx_archive_receipts_entity (entity_table, entity_id, created_at)`, or by
tenant timeline via `idx_archive_receipts_tenant_cursor (tenant, created_at)`.

`already_archived` and `not_archived` outcomes are not failures — they write
no receipt and return that status directly, since nothing changed.

## Tests

`tests/archive-hygiene.test.ts` covers `src/hygiene/archive.ts` and
`src/mcp/archive.ts`; `tests/members-patch-and-agent-status-archived-refusal.test.ts`,
`tests/flight-task-archived-refusal.test.ts`, and
`tests/task-archive-readers.test.ts` cover the read/refusal seams archiving
touches elsewhere. Consult the test files directly for exact case names,
since this runbook does not restate them.
