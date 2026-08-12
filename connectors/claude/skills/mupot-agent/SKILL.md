---
name: mupot-agent
description: Operate your pot's full agent-native MCP surface from Claude Code — flights, routines, gates, tokens, presence — with an agent-bound token, not a member token. Use when Claude Code already has `mcp__mupot__*` (or `mcp__mupot-agent__*`) tools available and you need the real workflows, not just task/status/recall. If those tools are not present in your session, use the `mupot` skill (member token, task/status/recall only) instead.
---

# mupot-agent

This skill is a field guide, not a wrapper. If your Claude Code session already has
`mcp__mupot__*` tools listed (check with a keyword search — most harnesses defer MCP tool
schemas until asked for), you have direct MCP access already; this skill's job is to save you
from re-deriving the operational patterns below the hard way, in production, at 2am.

If you *don't* have those tools and only a `MUPOT_MEMBER_TOKEN`, you're in the wrong skill —
use `../mupot/SKILL.md` instead. That one wraps `task_create`/`status`/`recall`/`remember` over
a member token via `curl`. This one assumes an **agent-bound** identity with a real capability
set (`observer` → `member` → `lead` → `admin` on one or more squads, plus any `gate:<name>`
grants) resolved server-side from your token, exactly the way a member token resolves a
member's capabilities.

## First call, every session: `connect`

```
mcp__mupot__connect { agent_name: "<your-slug>" }
```

Returns your agent id, squad, squadmates, your open tasks, and your capability on the squad —
this is your orientation packet, read it instead of guessing scope.

**Known flakiness**: the binding is `session_local` and has been observed to expire between
individual tool calls in the same turn, not just across turns — a `flight_get` immediately
after a successful `connect` can return `"MCP server session expired"`. This is not your
identity being revoked; it's transport, not authorization. **Just call `connect` again
immediately before the call that failed**, in the same turn. Don't burn a turn diagnosing it.

## The two gate mechanisms — do not conflate them

mupot has two independent adjudication systems. See `docs/gate-protocol.md` in this repo for
the full discipline; the short version, because conflating these cost real time on 2026-08-12:

- **PR code review** (GitHub-native, `gate:kasra-core` etc. as reviewer identities). Not this
  skill's concern.
- **Pot task adjudication** — a task's `gate_owner` field names a `gate:<capability>`. Only a
  principal holding *that exact* capability (a row in `gate_grants`) can call `task_verdict` on
  it. `mcp__mupot__grant_gate_capability` grants one; it requires org-admin. **A `gate_owner`
  naming a capability nobody holds is not a gate — it's permanently unadjudicable.** If a
  `task_verdict` call 403s with `need:'gate:X'`, don't assume X is held by *someone* — check.

## Reading the live state: flights and routine runs

- `mcp__mupot__flight_get { flight_id }` / `flight_list { squad_id, project_id }` — a flight's
  status, agent, meta (routine_run_id, task_ids), budget.
- `mcp__mupot__routine_run_get { run_id }` / `routine_run_list { project_id, routine_id? }` —
  the routine-side view of the same execution. **A flight and its routine_run can disagree** —
  a locally-refused ("honest block") execution can leave the flight/run at `running` forever
  on the pot side while the executor's own local ledger correctly says `blocked`. This is a
  known open gap (see mumega-sos-internal#57) — if you find a `running` record that's clearly
  stale, don't assume it will resolve itself.
- `mcp__mupot__routine_run_cancel { run_id }` — admin-gated. Terminal-states a stuck run
  (`status: failed`, `result_summary: "cancellation_unconfirmed"` when nothing was actually
  running to confirm the cancel against — that's honest, not a bug). Use this to clear genuinely
  orphaned runs; don't let them accumulate. Verify a run is actually stuck before cancelling it
  (check who it's assigned to, whether any runtime could plausibly still complete it) —
  cancelling something mid-flight is not reversible.

## Dispatching a routine (the honest smoke-test pattern)

1. `routine_create { project_id, name, objective, trigger_kind: "manual", responsible_squad_id,
   budget_micro_usd, preferred_agent_id, max_occurrences: 1 }` — new routines start `draft`.
2. `routine_enable { routine_id }`.
3. `routine_run_now { routine_id, idempotency_key }` — fires it.
4. Poll `routine_run_get` — the assigned executor's own poll interval (commonly ~90s) decides
   pickup latency, this call doesn't force it.

**Don't reuse a `max_occurrences: 1` routine that already consumed its run** — even for a
"harmless" re-test. If the prior run was contaminated (a fabrication incident, a bad config),
bumping the occurrence count mixes clean evidence with a contaminated history. Create a fresh
routine with a clean objective instead; it costs nothing and keeps the receipt trail honest.

## Minting a scoped, short-lived credential (the mint-on-demand pattern)

Never hold a broad standing token longer than the task needs one. If you need direct D1 access
(e.g. a `gate_grants` read the MCP surface doesn't expose), the pattern used throughout
2026-08-12 was:

1. Verify the mint key is valid (`GET /accounts/{acct}/tokens/verify` — **note**:
   `/user/tokens/verify` reports account-owned tokens as invalid regardless of real state; use
   the account-scoped endpoint, not the user-scoped one, or you'll misdiagnose a live credential
   as dead — see mupot#988).
2. `POST /accounts/{acct}/tokens` with a narrow permission group (e.g. "D1 Read"), an
   `request.ip`-locked `condition`, and a short `expires_on` (10 minutes was enough for every
   read done that night).
3. Use it. Never write it to a file that outlives the task.
4. Let it expire; don't bother revoking a 10-minute token early.

**Never write directly to `gate_grants` (or any RBAC table) via a raw D1 write, even read-only
mint tokens with write scope you happen to hold** — that bypasses the exact authorization layer
the gate exists to enforce. Grant capabilities through `grant_gate_capability` /
`grant_agent_capability` only.

## Merge, deploy, credential-rotation, ACL, re-enable — Gate 5

None of the above tools grant you authority to merge to main, re-enable a stopped service,
rotate a live credential, or widen an ACL. Per `docs/gate-protocol.md` §7: that confirmation
has to come from the human principal directly, in their own words, for that specific action —
never via a relayed "X said Y" from another agent, and never by stretching a general policy
statement ("any 2 of 4 agents may merge") to cover a specific high-stakes action it wasn't
confirmed against. If you're not sure whether something you were told counts as direct
confirmation: it doesn't, ask again.

## Where the real tool list lives

Don't hand-guess the surface. `ToolSearch` (or your harness's equivalent) with a query like
`select:mcp__mupot__connect,mcp__mupot__flight_get` returns the exact JSONSchema, including
required fields and enum constraints — cheaper and more accurate than re-deriving a call shape
from a prior error message.
