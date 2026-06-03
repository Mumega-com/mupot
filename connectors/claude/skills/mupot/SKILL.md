---
name: mupot
description: Act on your mupot pot from Claude Code — create tasks, check agent/squad status, and recall your own memory. Use when the user says "/mupot", "add a task to <squad>", "what's the status of <agent>", or "recall <something>". Drives the pot's MCP seam with your member token; identity and permissions are enforced server-side by the pot.
---

# mupot

Act on your sovereign agent pot (**mupot**) over its MCP seam. This skill exposes
the three everyday actions as `/mupot` commands. The pot resolves *who you are* and
*what you may do* from your member token — you never assert identity here.

## Setup (one time)

The helper script reads two environment variables:

- `MUPOT_URL` — your pot's base URL, e.g. `https://mupot.your-org.workers.dev`
- `MUPOT_MEMBER_TOKEN` — the raw member token your pot minted (`channel: workspace`)

Set them in your shell (profile or `.envrc`), **never in a committed file**:

```bash
export MUPOT_URL="https://YOUR-POT.example.workers.dev"
export MUPOT_MEMBER_TOKEN="<your raw member token>"
```

If either is missing, the script prints a clear error and exits non-zero.

## Commands

All commands shell out to `scripts/mupot.sh` (alongside this file), which POSTs to
`$MUPOT_URL/mcp` with `Authorization: Bearer $MUPOT_MEMBER_TOKEN` and prints the
JSON result. Never echo the token.

### `/mupot task <title> [@squad] [-- <body>]`
Create a task on a squad. Calls the `task_create` tool.
- `@squad` selects the target squad by **id**. If you only know the squad's name,
  ask the user for its id, or list squads in the dashboard.
- Text after `--` becomes the task body (optional).

```bash
scripts/mupot.sh task_create --squad_id "<SQUAD_ID>" --title "Ship the landing page" --body "Hero + pricing"
```

Requires `member` capability on that squad. `403 forbidden` means the user's token
lacks it — relay that plainly; do not retry with a different scope.

### `/mupot status [<agent_id>]`
Read-only. With no argument, echoes *who the token is* and its capabilities. With
an `agent_id`, returns that agent's runtime telemetry. Calls the `status` tool.

```bash
scripts/mupot.sh status                      # who am I + my scopes
scripts/mupot.sh status --agent_id "<AGENT_ID>"
```

### `/mupot recall <query> [<limit>]`
Search **your own** member memory scope. Calls the `recall` tool. A member can only
read their own memory — there is no cross-member or agent memory here.

```bash
scripts/mupot.sh recall --query "what did we decide about pricing" --limit 5
```

### `/mupot remember <text>`
Write to your own member memory scope (companion to recall). Calls `remember`.

```bash
scripts/mupot.sh remember --text "Decided: launch pricing at \$49/mo"
```

## Rules for this skill

- **Never print or log `MUPOT_MEMBER_TOKEN`.** Pass it only via the script's env.
- **Never invent identity.** Do not pass any "who am I" field — the pot derives the
  actor from the token. The tools have no such argument.
- **Surface errors verbatim.** `401 unauthenticated` = bad/expired token (re-mint
  in the dashboard). `403 forbidden` = the member lacks the capability (an admin
  must grant it). `404` = the squad/agent id doesn't exist in this pot.
- **One pot per token.** A token only works against the pot it was minted for.

## Tool reference

Discover the live surface any time (no token needed):

```bash
curl "$MUPOT_URL/mcp/tools"
```

Full tools: `task_create`, `remember`, `recall`, `wake_agent`, `squad_message`,
`status`. This skill wraps the everyday three (task / status / recall) plus
`remember`; `wake_agent` and `squad_message` are available via the raw MCP client
for `lead`+ members.
