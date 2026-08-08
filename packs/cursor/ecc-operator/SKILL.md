---
name: mupot-ecc-operator
description: >-
  Use when operating as an ECC-optimized Cursor agent attached to a mupot pot —
  boot, claim tasks, land at review, never self-verdict. Trigger on session start
  or when asked to work the pot queue / gate rails.
---

# mupot ECC operator (Cursor)

You are client-optimized by **ECC** (skills/hooks). Your **output is governed by mupot**.

## Session start

1. `boot_context` — identity from the bearer token (never invent tenant/agent).
2. `instinct_recall` — confidence-weighted project + global instincts (decayed).
3. `check_in` — announce presence on your project (your bound agent name); shows you live in Fleet.
4. `orient` — basin packet; follow assigned tasks only.
5. `inbox` — consume operator messages; ack via `send` when asked.

Refresh presence while working (`check_in` on start; a heartbeat hook or cron if idle —
see [flock contract](../../../docs/flock-harness-pack-contract.md)).

## Instinct memory (Port 4)

Hooks auto-capture via `packs/cursor/ecc-operator/hooks/instinct-observe.sh`
(`MUPOT_MCP_URL` + `MUPOT_TOKEN` + `MUPOT_PROJECT_ID`). Distill with
`instinct_distill` when `distill_ready` (cheap model). Org-admin promotes with
`instinct_promote` only when the same id appears in ≥2 projects at avg confidence ≥0.8.

## Work loop

1. `task_list` — see open work assigned to you (or unassigned with clear ownership).
2. Claim via `task_update` → `status: "in_progress"` (set assignee if the task is unassigned).
3. Do the work in the repo/worktree named by the task.
4. `task_update` → `status: "review"`, set `gate_owner` (e.g. `gate:kasra-core`).
5. Stop. A **different** principal calls `task_verdict`. **You must not verdict your own task.**

## Admin / operator tools (only if your token is org-admin)

- `grant_gate_capability` / `revoke_gate_capability` — delegate `gate:<owner>` (no SQL).
- `loop_list` / `loop_set_status` — promote paused addon loops to `active`.

## Do not

- Merge, deploy, or publish without a gate verdict.
- Self-approve (`task_verdict` on your own assignee row).
- Copy ECC skill trees into the mupot Worker — keep craft on the harness.
- Print or commit tokens.
