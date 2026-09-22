# Agent-proposed member invite

Source: mupot#1497 ("Mubot-driven onboarding: an agent proposes a member invite, a human
approves, the invite goes out — no org admin typing emails"). Code checked at `origin/main`
`3c706069`.

**Status: unimplemented.** Issue #1497 is **open** (`closedAt: null`), with no linked PR
(`gh pr list --search "1497"` and `--search "member_invite"` both return zero results). This
doc records the gap and the building blocks it would reuse, rather than a shipped flow.

## Trigger

Per the issue: an agent (e.g. Mubot, via Telegram intake) would call a new `member_invite`
proposal kind on `routine_proposal_submit` with `{email, squad_id, capability, reason,
source}`.

## Actor(s)

The proposing agent, an approving human (squad lead or org admin), and the mupot backend.

## Tool/route sequence

**Does not exist.**

`src/routines/proposal.ts:29-35` defines the full `RoutineProposalAction` union — exactly six
kinds: `create_task`, `dispatch_flight`, `request_review`, `ask_human`, `no_action`,
`project_access`. There is no `member_invite` kind. `PROPOSAL_ACTION_KINDS`
(`src/routines/proposal.ts:51`) lists the same six strings, and `parseAction`
(`:110-216`) has a parser branch per kind with none for invites. A repo-wide grep for
`member_invite` and `proposed_by_agent` returns zero hits anywhere in `.ts` files — no
partial scaffolding, no dead code, no migration column.

**Building blocks that already exist and would be reused:**
1. The proposal → verdict chain from the "project access chain" workflow (#1490, landed at
   this exact commit): `routine_proposal_submit` (`src/mcp/routines.ts:386`), `task_verdict`
   (`src/mcp/index.ts:1886`). The existing `project_access` kind
   (`src/routines/proposal.ts:17-28,35`) is the direct precedent a `member_invite` kind would
   mirror — same ordering discipline (`proposal_id -> verdict_id -> receipt id`, never
   collapsed) and the same `waitForHuman('review')` gate before execution.
2. The invite mechanism from the "human onboarding door" workflow (#1436/#1438):
   `POST /invites` (`src/members/index.ts:646`, admin-only today), inserting into `invites`
   (`migrations/0002_members.sql:40`, already has an `invited_by` column,
   `src/members/index.ts:156,688`); redemption via `acceptInvite`
   (`src/members/index.ts:243`, wired to `POST /invites/:id/accept` at `:403`).

Neither block currently has a code path connecting them: the invite route has no caller from
`src/routines/*`, and the proposal union has no invite-shaped input.

## Human gate

Not applicable — no code path exists to cite without fabricating it. Per the issue, the
gate would be the same pattern as workflow 03: an approving human (or harness-attested
origin, workflow 07) deciding a `task_verdict` on a gated proposal task, not the proposing
agent's own capability.

## Receipt(s) written

Not applicable — no such table or write path exists today. Per the issue, a shipped
version would need either a new `member_invite_receipts` table or a `kind` column added to
an existing ledger (mirroring `project_access_grant_receipts`'s
`proposal_id -> verdict_id -> receipt id` chain); neither exists.

## What the person sees

Not applicable — nothing renders for this flow today, since it doesn't exist. Today, an
admin fills the dashboard invite form directly (`src/dashboard/invite.ts`) or calls
`POST /invites`; nothing lets a person see or approve an agent-drafted invite proposal over
Telegram or elsewhere.

## Tests that pin it

None. A repo-wide search for `1497`, `member_invite`, and `proposed_by_agent`-shaped test
names returns zero files. Existing, unrelated invite tests:
`tests/invite-landing-page.test.ts`, `tests/accept-invite-direct.test.ts`,
`tests/plain-squad-invite-create.test.ts`, `tests/plain-squad-invite-accept.test.ts`,
`tests/invite-login-link.test.ts`, `tests/admin-members-invite-link.test.ts`.

## Known gaps

**mupot#1497, state OPEN, no PR.** The feature is a documented ask only, as of commit
`3c706069` (origin/main tip). It would extend the existing `project_access`-style
proposal/verdict pattern with a new `member_invite` kind, and reuse the existing
`POST /invites` / `acceptInvite` mechanism for delivery once built — but neither the
proposal-kind union, the MCP tool wiring, nor any receipt table for it exists today.
