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
2. `orient` — basin packet; follow assigned tasks only.
3. `inbox` — consume operator messages; ack via `send` when asked.

## Work loop

1. `task_list` — claim open work assigned to you (or unassigned with clear ownership).
2. Do the work in the repo/worktree named by the task.
3. `task_update` → `status: "review"`, set `gate_owner` (e.g. `gate:kasra-core`).
4. Stop. A **different** principal calls `task_verdict`. **You must not verdict your own task.**

## Admin / operator tools (only if your token is org-admin)

- `grant_gate_capability` / `revoke_gate_capability` — delegate `gate:<owner>` (no SQL).
- `loop_list` / `loop_set_status` — promote paused addon loops to `active`.

## Do not

- Merge, deploy, or publish without a gate verdict.
- Self-approve (`task_verdict` on your own assignee row).
- Copy ECC skill trees into the mupot Worker — keep craft on the harness.
- Print or commit tokens.
