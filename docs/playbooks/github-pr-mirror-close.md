# GitHub PR event-mirror close-stale

## Problem

Inbound webhooks mint open tasks titled `[GH <owner/repo>] PR #<n> opened: …`.
Without a close path, merged/closed PRs leave stale open mirrors on the board.

## Live path (Worker)

On `pull_request.closed`, the webhook:

1. Calls `closeGitHubPrMirrorTasks(env, repo, prNumber)` — marks matching
   **ungated** `open`/`in_progress` mirrors `done` (`result=github_pr_closed`).
2. Records merged PRs for the `github_prs` KPI when `merged=true`.
3. Does **not** create a new "closed/merged" noise task.
4. Ignores `synchronize` / `edited` / other non-open actions for task minting.

Implementation: `src/tasks/service.ts` (`closeGitHubPrMirrorTasks`) +
`src/integrations/github-routes.ts`.

## Operator backfill

When webhooks were down or the board is already polluted, use the ECC-adapted
Cursor skill/script (not Worker code):

- Skill: `agents/cursor/.cursor/skills/gh-pr-mirror-close/`
- Script: `agents/cursor/.cursor/scripts/gh-pr-mirror-sync-close.py`

Algorithm matches ECC `work-items sync-github` close-stale: active = open PRs
from `gh`; any open ungated mirror whose number is absent → `done`.

## Fences

- Never touch rows with `gate_owner` set.
- Never invent tasks for synchronize/edited/closed noise.
