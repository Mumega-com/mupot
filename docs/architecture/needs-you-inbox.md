# Needs You — the inbox rule (mupot#1688)

`listNeedsYou` (`src/attention/service.ts`) is the ONE list behind MCP `needs_you_list`,
REST `/needs-you`, the dashboard `/needs-you` page and Telegram `/needs`. It is an inbox,
not a wall.

## What is listed

An item appears only if ALL hold:

1. **The viewer can act.** Approvals use `evaluateVerdictGates` (gate ownership with
   liveness, `gate:loops` surface cap, self-verdict, owner/affiliation exclusion #1663) —
   the same predicate `task_verdict` runs — plus the squad-scope check. Routine / recommit /
   publish rows keep their existing verbs. A row whose only verb would be `view` is dropped
   (exception: blocked human work, which has no resolve verb in this list).
2. **The viewer can read it.** Task rows pass `canReadSquadTasks` (`src/tasks/visibility.ts`).
3. **It is live.** Rows under an archived project (`projects.status = 'archived'`) or an
   archived task (`TASK_NOT_ARCHIVED_SQL`) drop out.
4. **A human decides it.** A gate wait needs an independent human holder
   (`humanGateHolderExistsSql`). Agent-only lanes (e.g. `gate:kasra-core`) and
   `gate:agent-self-completion` are not owner-inbox items: workspace admins read them with
   `view: 'stuck'` (MCP arg / REST `?view=stuck`); everyone else gets an empty list there.

## Urgency and staleness (task-backed rows)

- base: `P0` urgent, `P1` high, `P2`/unset normal, `P3` low
- up one level for waiting >= 3 days, two for >= 7 days, one when the project `target_date`
  is within 2 days or past; total bump capped at 2
- waiting >= 14 days (`NEEDS_YOU_STALE_DAYS`): no age bump, `stale: true`, sorted after every
  live item ("older"). Nothing is auto-dismissed.

Routine waits keep their wait-reason rank and gain only the stale grouping.
