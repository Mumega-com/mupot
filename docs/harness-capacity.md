# Harness capacity snapshots (mupot#1765, epic #1590)

mupot learns how loaded a harness host is (Orca first, herdr-compatible shape) from a small
read-only reporter. This is **advisory**: it never refuses dispatch.

## What is reported (counts only)

`harness_capacity_report` (agent-bound caller; the reporter is always the authenticated agent,
never an argument) upserts ONE latest row per `(tenant, harness, host_key, reporter_agent_id)`
into `harness_capacity_snapshots` (migration 0196):

`live_terminals`, `agent_sessions`, `busy_recent` (output within 10 min), `orphaned_terminals`,
`workers_active`, `workers_release_unknown`, `worktrees_with_live`, optional `max_agents`
(policy ceiling; omitted = keep the stored one), and a `summary_json` of integer counters only
(<= 4 KB, <= 24 keys, `[a-z][a-z0-9_]*` keys). `observed_at` is the reporter clock;
`received_at` is the server clock. An older `observed_at` never overwrites a newer row.

## What is never reported

Terminal previews or any terminal text, titles, file paths, worktree/branch names, repo names,
tokens. The reporter reads only numbers/booleans/enums from Orca output, the server rejects any
non-integer summary value, and the table has no column that could hold text.

## Freshness

`harness_capacity_list` returns each row with `fresh` (received within 5 minutes) and
`saturated` (`max_agents` set AND `agent_sessions >= max_agents`, only while fresh). A stale
snapshot is **unknown**, never zero load and never "saturated".

## Dispatch advisory

`flight_dispatch` / `POST /flights` results may carry
`advisories: ["harness_capacity_saturated:<harness>:<host_key>"]` when a FRESH snapshot is
saturated (one bounded read, errors swallowed). `go`, `reasons` and flight status are unchanged.

## Reporter

`scripts/harness-capacity-reporter.mjs` (node, no deps). Runs only these Orca commands, exact
argv match, everything else is refused before a process is spawned: `status`, `host list`,
`terminal list`, `orchestration worker-list`, `worktree ps` (the Orca CLI can also write, so the
allowlist is the safety boundary). If `status` or any read is not `ok`, nothing is reported
(a failing runtime must not look like zero load).

```
node scripts/harness-capacity-reporter.mjs --dry-run --host-key hadi-mac --max-agents 8
MUPOT_TOKEN_FILE=/path/to/token node scripts/harness-capacity-reporter.mjs
```

The bearer token is read from the file named by `MUPOT_TOKEN_FILE`, never argv or logs.
User units: `ops/systemd/harness-capacity-reporter.{service,timer}` (every 2 min). They are
files only; installing them is an operator step.
