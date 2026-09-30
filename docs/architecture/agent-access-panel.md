# Agent Access panel

One org-admin control for an agent's squad access. It lives on the dashboard agent page
(`/agents/:id`, `src/dashboard/index.ts`) and writes through `POST /agents/:id/access`.
The logic is in `src/dashboard/agent-access-panel.ts`.

## What an admin can do

- See the agent's squad access rows, each with its squad, its department (read-only,
  derived from the squad) and its level.
- Change the level on a squad the agent already has, to one of `observer`, `member`,
  `lead`, `admin`. There is no default level: a form with no level is refused.
- Enroll the agent on another work squad at a chosen level.
- Revoke the access on a squad.
- Optionally give a reason (up to 500 characters), stored on the receipt.

`owner` is never offered and is refused if submitted. The panel never shows, mints or
rotates a token. After a change the page says, for example, "Rava is now lead on Core
Platform. Effective on its next request."

The panel is rendered only for an org admin who is not an agent-bound session. The
home squad row, archived squad rows, owner rows and rows whose membership and capability
tables disagree are listed but have no controls.

## How the write goes through the existing machinery

The write calls `commitAgentSquadAccess` (set) or `commitRemoveAgentSquadAccess`
(revoke) from `src/members/agent-access.ts`, which write the `memberships` and
`capabilities` rows. This panel adds no SQL against those two tables.

Both functions take an extra-statements hook whose statements run in the same
`env.DB.batch` as the access rows. The panel passes one statement there: an
`INSERT INTO agent_access_receipts ... SELECT CASE WHEN <guard> THEN id END, ...`.

Two consequences follow, and both are tested:

1. **The guard runs inside the write.** D1 rolls a batch back only when a statement
   throws, not when it writes zero rows. The receipt id column is `NOT NULL`, so a
   failed guard makes the insert throw, and the whole batch (receipt and both access
   statements) is rolled back.
2. **The receipt exists if and only if the access rows changed.** After the batch, the
   outcome reported to the admin is read back from the receipt row, not from the
   service's return value.

One small change was made to the service: `commitRemoveAgentSquadAccess` takes an
optional `{ evaluateExtrasWhenAbsent: true }`. Without it the hook is skipped when the
service's own read finds nothing to remove, and its two `DELETE`s are unguarded, so a
grant that landed in that gap could be deleted with no receipt. With it, the guarded
receipt statement rides the batch and aborts it. The default is unchanged for the
existing caller in `src/members/squad-membership.ts`.

## The rules, and where each is enforced

Each rule is checked twice: a readable pre-check in `applyAgentAccessChange` (returns a
refusal code and status) and the same fact as an `EXISTS` or `NOT EXISTS` leaf in the
in-batch guard (`guardSql`). Never a scalar compare.

| # | Rule | Pre-check | In the batch |
|---|------|-----------|--------------|
| 1 | Actor is org admin and admin on the target squad | `isOrgAdmin(auth)`, `actorRankOnScopeFor` | active-member leaf, org-admin leaf, squad-rank leaf (`currentMemberRankAtLeastSql`, which also reads the `users.role` bridge) |
| 2 | Granted rank at most the actor's live rank; never owner | `isAgentAccessCapability` rejects owner; rank compared to `max(admin, new, prior)` | squad-rank leaf with the same required rank; table `CHECK` refuses `owner` |
| 3 | Admin and above are human-only: any agent-bound session is refused | `auth.boundAgentId` set: refused for every level, before the agent is even looked up | actor must not be any agent-bound member |
| 4 | No home or archived squads | squad `kind = 'home'`, the agent's home squad id, `status <> 'active'` | `squads.kind <> 'home' AND status = 'active'` leaf, and the agent's current home squad must still equal the one the plan was computed against (so a home squad that moved between read and write rolls the batch back) |
| 5 | An agent cannot change its own access | target's bound member equals actor; actor is any bound member | actor has no `agent_member_bindings` row |
| 6 | No silent widening | the form carries the level the admin saw (`expected_prior`); no default level; a squad where the membership and capability rows disagree is refused (`rows_disagree`), so a receipt can never hide a drop on one table | compare-and-swap in BOTH tables: `none` means neither row exists, otherwise the capability row AND the membership row have that level. A set to the level already held is answered `unchanged`, and the receipt `CHECK` (`prior <> new`) would refuse it anyway |
| 7 | Org-scope-local actor rank; floor of admin for the target rank ceiling | `exceedsTargetRankCeiling` (org-scope-local actor vs the target's global rank) | the agent's member holds nothing above admin on any plane that ceiling reads: capability rows on any work scope, `channel_capability_grants` on a non-home squad, and the legacy role plane (`members.email` to `users.role`, case-insensitive). Home-squad grants are excluded, as `targetMaxRankAcrossScopes` does. The JS side has the same floor (`target_above_admin_floor`), so an org owner acting on an agent that holds owner elsewhere is refused with a specific message rather than a generic write-time one |
| 8 | Receipt iff access changed | outcome read from the receipt row | receipt statement is in the same batch and carries the guard |

Also in the batch: the target's welded identity must still be the member that was
authorized. An owner row in either access table cannot pass the compare-and-swap.

The squad-rank leaf is redundant today with the org-admin leaf plus the home refusal:
an org admin's grant covers every non-home squad. It is kept so the rule stays true if
the org-admin definition ever narrows.

## Concurrency

The compare-and-swap means two admins, or two clicks, starting from the same page cannot
both succeed. The loser's batch throws and rolls back and the page reports "access
changed underneath you". Tests run four identical changes, three different levels, and a
revoke against a change through `Promise.all` and assert exactly one receipt each time,
matching the resulting rows.

## Receipts: `agent_access_receipts` (migration 0187)

Columns: `id`, `actor_member_id`, `agent_id`, `squad_id`, `prior_capability`
(NULL on enroll), `new_capability` (NULL on revoke), `action`
(`enroll` | `change` | `revoke`), `reason`, `created_at`.

- Create-only migration: no parent table is dropped or rebuilt.
- Foreign keys to `members`, `agents` and `squads` are `ON DELETE RESTRICT`.
- Append-only: `BEFORE UPDATE` and `BEFORE DELETE` triggers raise, in the style of
  `oauth_consent_receipts` (0091).
- A table `CHECK` ties `action` to the two capability columns and refuses `owner`.

## Not covered

- The panel changes squad access only. It does not edit department grants, org grants,
  channel grants or gates, and it does not touch tokens or sessions.
- An admin cannot lower or revoke an agent's `owner` access from here.
- Nothing pushes the new level into an agent's running session: it takes effect when the
  agent's next request resolves its capabilities.
- Tests use the SQLite D1 harness, which runs a batch as one transaction. That matches
  D1's documented rollback on a thrown error; it has not been run against a live D1.
