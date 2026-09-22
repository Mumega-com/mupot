# Project access chain

Source: mupot#1490 ("project_access chain v2 — verdict bound to its proposal, human-origin
required, atomic grant+receipt", successor to #1488). This is the current `origin/main` HEAD
(`3c706069`) — the commit message itself is this workflow's own description.

## Trigger

An agent assigned to a routine calls `routine_proposal_submit` with an `action.kind ===
'project_access'` (`src/routines/proposal.ts:35`), naming a member, a project, an
`access_level` (`read|write|admin`), and a reason.

## Actor(s)

The proposing agent, a deciding human, and the mupot backend.

## Tool/route sequence

1. `routine_proposal_submit` (MCP tool, `src/mcp/routines.ts:386`) → `submitRoutineProposal`.
   Input validated by `parseAction`'s `project_access` branch (`src/routines/proposal.ts:190
   -209`): exact keys `member_id, project_id, access_level, reason`; `access_level` must be
   one of `PROJECT_ACCESS_LEVELS`; `reason` bounded 1-2000 chars.
2. `validateActionScope`'s `project_access` branch (`src/routines/proposal.ts`, referenced
   near `:671-700` in `src/routines/actions.ts`) checks the member exists, is active, same
   tenant, the proposal names the run's own project, and the requested `access_level` does
   not exceed the proposing squad's own access level on that project.
3. Under `execution_mode: 'propose'`, the action routes through the same generic
   `waitForHuman('review')` gate every proposal kind uses (`src/routines/actions.ts:1033` —
   `approvedGate` flips the control task's `gate_status` from `pending`→`approved`/`rejected`
   generically).
4. A human casts `task_verdict` (`src/mcp/index.ts:1886`) on the control task —
   `approved`/`rejected`, optionally with `human_origin` (see the "human decision channel"
   workflow doc for that mechanism in full; this flow simply requires the verdict to satisfy
   `verdictIsHuman`, below).
5. `executeRoutineAction`'s `project_access` dispatch branch
   (`src/routines/actions.ts:1687-1710`) is reached only after `approvedGate` has flipped the
   gate — but that flip alone is **not** treated as sufficient authorization for this
   privileged effect. It re-derives the real gate via `resolveProposalVerdict`
   (`src/routines/actions.ts:1012-1026`): `SELECT id, verdict, decided_by, decided_via FROM
   task_verdicts WHERE proposal_id = ? AND decided_at > ? AND reversed_at IS NULL ORDER BY
   decided_at DESC, id DESC LIMIT 1` — bound to *this exact proposal* (`action.id`), fresh
   (postdates `action.created_at`), and not reversed.
6. `verdictIsHuman(env, verdict, tenant)` (`src/tasks/service.ts:1535-1544`): `true` if
   `decided_via === 'agent_attested_origin'` (the harness-attested-human path), otherwise
   looks up `decided_by` in `members WHERE status = 'active' AND (tenant = ? OR tenant IS
   NULL)` — a decider suspended or in the wrong tenant *after* casting the verdict but before
   the routine replays no longer counts as human.
7. `getMemberHomeSquad` resolves the target member's home squad, then
   `executeProjectAccessGrant` (`src/projects/service.ts:639`) writes the grant.

## Human gate

- **Bound to this exact proposal**: `resolveProposalVerdict`'s `WHERE proposal_id = ?`
  (`src/routines/actions.ts:1017`) — a verdict on a *different* pending proposal can never
  authorize this one.
- **Fresh**: `decided_at > action.created_at` — a stale verdict from before the proposal
  existed cannot be replayed against it.
- **Not reversed**: `reversed_at IS NULL` — see the "verdict reversal" workflow doc for how a
  verdict gets un-set.
- **Actually human**: `verdictIsHuman` re-checked live at execution time, not just at
  decision time (comment, `src/tasks/service.ts:1520-1533`: "P2-3, kasra-review adversarial
  round 2 on PR #1490" — the first version trusted any `members` row regardless of status or
  tenant; a decider suspended between deciding and the routine replaying must not still count).
- **Receipt-less refusal on either failure**: both `verdict.verdict !== 'approved'` and
  `!verdictIsHuman(...)` fail closed via `classifyActionFailure` with reasons
  `verdict_not_found` / `rejected_non_human_verdict` (`src/routines/actions.ts:1698-1706`) —
  no `project_access_grant_receipts` row is ever written on either path.
- **Access level cannot exceed the proposing squad's own** on that project (validated at
  proposal time, step 2 above).

## Receipt(s) written

- `project_access_grant_receipts` (`migrations/0157_project_access_grant_receipts.sql:51-59`):
  `id, tenant, project_id, squad_id, member_id, access_level, proposal_id, verdict_id,
  decided_by, decided_via, created_at` — `UNIQUE(proposal_id)` (idempotent on retry), append-
  only (enforced by `BEFORE UPDATE`/`BEFORE DELETE` triggers that `RAISE(ABORT, ...)`).
  `decided_by`/`decided_via` are frozen copies taken at write time so the receipt reads
  standalone without a join.
- `project_squad_access` (upserted on the member's home squad) — the actual standing grant,
  via the same `projectSquadAccessStatements` helper `project_squad_set` uses.
- **Atomic**: both the grant upsert and the receipt INSERT land in one `env.DB.batch()`
  (`src/projects/service.ts:639`, comment block above the function) — closing a proven
  failure mode from PR #1488 where forcing only the receipt INSERT to fail left the grant
  live with zero receipt rows. `assertWritten` on each required statement turns a silent
  0-row write into a loud throw.
- Idempotent on `proposalId`: a retried execution finds the existing receipt (matched by
  `proposal_id`) rather than writing a second one; if a replay somehow carries a *different*
  `verdictId` than the stored receipt, it is refused (`verdict_mismatch`) rather than silently
  diverging.
- `routine_run_actions.kind` CHECK constraint was widened to admit `'project_access'`
  (`migrations/0158_routine_run_actions_project_access_kind.sql`, a table-rebuild migration).

## What the person sees

The proposal surfaces on `/needs` as an ordinary gated task (comment,
`src/routines/actions.ts:1773`), queried via `WHERE run_id = ? AND tenant = ? AND kind =
'project_access' AND status = 'waiting' AND gate_status = 'pending'`
(`src/routines/actions.ts:1789`). The eventual `task_verdict` response and its human-origin
outcome fields are documented on the "human decision channel" workflow — this flow adds no
invite-specific reply text of its own beyond the routine-proposal envelope
(`version, run_id, project_id, situation_digest, summary, action`, per
`routine_proposal_submit`'s schema, `src/mcp/routines.ts:386-406`).

## Tests that pin it

`tests/routine-project-access.test.ts` and `tests/routine-project-access-v2.test.ts` —
validation refusals, the mutation-class assertion (zero grant/receipt rows while the proposal
sits in review), the rejection path (no grant written, `routine_run_actions` row says
`proposal_rejected`), and the full chain through a **real** `task_verdict` MCP call (not a raw
`task_verdicts` INSERT). `tests/mubot-capability-floor.test.ts` — proves an agent shaped like
Mubot's live profile (ordinary `member` capability, no elevation) can call
`routine_proposal_submit` with a `project_access` action while being refused on
`project_squad_set`, `grant_agent_capability`, and `squad_member_add` directly — the floor
this whole chain exists to enforce. `tests/home-memory-isolation.test.ts` — a related isolation
check on the memory surface for the same home-squad mechanism this chain grants access to.

## Known gaps

- **No receipted revocation path** (P2-5, kasra-review adversarial round 2 on PR #1490): once
  `executeProjectAccessGrant` gives a member's home squad access to a project, the only way to
  remove it is `project_squad_set` (an org-admin tool with its own documented bypass, see the
  "home squads" workflow's #1489 note) or a raw `project_squad_access` UPSERT — neither writes
  to `project_access_grant_receipts`, so a revoked or downgraded grant leaves no audit trail
  distinguishable from "never granted differently." A `project_access_revoke` tool mirroring
  this function's atomic grant+receipt shape is the natural fix; filed but not built. Tracked
  as **mupot#1491**.
- **mupot#1489**: an org-admin can still write a home→project edge directly via
  `project_squad_set`, bypassing this entire proposal→verdict→receipt chain — ruled that
  elevation-with-receipt should be the only path; not yet closed as of this writing.
- Cross-reference: the human-origin attestation this chain depends on (`verdictIsHuman`'s
  `agent_attested_origin` branch) is documented in full on the "human decision channel"
  workflow, and its own known gaps (mupot#1426) apply here too.
- Migration status: `migrations/0157` and `0158` both carry the same "NOT applied by this
  build — a human applies it separately" header pattern as 0143/0144/0147/0148. Whether they
  have since been applied to the live database should be verified operationally.
