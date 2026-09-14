# Telegram project onboarding — repository evidence

This record makes the local Task 5 verification durable alongside the
[operator runbook](./telegram-project-onboarding.md). It is repository evidence only. It is
not a PR review, CI result, merge, deployment, migration-application, webhook, Telegram, or
live-pilot receipt.

## Scope and commits

- Task base: `bba3ab0a7d72b333cdf5e00bb4aef84f184e7b1a`
- Verification-fix commit: `ac533e45fad704e8867cbcd4b7aaf6a5f1315747`
- Initial runbook commit: `d4e6299ad95976ec59ef8ee4a6765629ff866746`
- Branch: `kasra/telegram-project-onboarding-20260913`

The final full suite ran with code at `ac533e45fad704e8867cbcd4b7aaf6a5f1315747`
and the runbook present as an untracked documentation file. The only changes through
`d4e6299ad95976ec59ef8ee4a6765629ff866746` were that runbook's documentation commit. After
that commit, typecheck, schema freshness, diff checks, and the secret scan were rerun on the
clean committed tree. This distinction avoids representing a pre-commit test as an exact-head
test of a later documentation commit.

No production credentials were read. No push, PR, merge, deploy, production mutation, or
external message occurred during this evidence run.

## Required focused verification

The first combined attempt included the nonexistent path `tests/r-actions.test.ts`:

```text
git diff --check && npm run typecheck && node scripts/check-schema-chain-fresh.mjs &&
npx vitest run tests/telegram-project-onboarding.test.ts
  tests/im-webhook-idempotency.test.ts tests/im-verdict-gates.test.ts
  tests/r-actions.test.ts tests/needs-you.test.ts --reporter=verbose
```

Vitest silently ran four existing files and reported 77/77 passing. That result was
discarded. The corrected exact command was:

```text
npx vitest run tests/telegram-project-onboarding.test.ts
  tests/im-webhook-idempotency.test.ts tests/im-verdict-gates.test.ts
  tests/routine-actions.test.ts tests/needs-you.test.ts --reporter=verbose
```

Result: exit 0, 5/5 files and 119/119 tests passed. The same five files were rerun with the
dot reporter after all temporary mutations were restored and again passed 119/119.

The surrounding checks were:

```text
git diff --check
npm run typecheck
node scripts/check-schema-chain-fresh.mjs
```

Results: all exited 0. TypeScript ran `tsc --noEmit`; the schema guard reported
`src/pots/schema-chain.generated.ts is fresh`.

## First full-suite failure and diagnosis

Command:

```text
npm test
```

First result: exit 1 after 535.67 seconds.

```text
Test Files  1 failed | 510 passed (511)
Tests       1 failed | 7954 passed (7955)
```

The sole failure was
`tests/routine-actions.test.ts > converges concurrent identical SQLite proposals on one
stored result`. Both calls succeeded with the same stored task result, but the right-hand
`Promise.all` input returned `duplicate:false` while the test required it to return
`duplicate:true`.

The production invariant does not assign winner and replay roles by array position. Under
full-suite scheduling, the right caller legitimately won. Ten isolated pre-fix repetitions
happened to schedule the left caller first:

```text
for i in 1 2 3 4 5 6 7 8 9 10; do
  npx vitest run tests/routine-actions.test.ts
    -t 'converges concurrent identical SQLite proposals'
    --reporter=dot --maxWorkers=1
done
```

All ten isolated runs exited 0. The minimal test-only correction retained the identical
result, one-task, and one-action assertions while requiring the unordered duplicate flags to
equal `[false, true]`. No production code changed. It was committed separately as
`ac533e45fad704e8867cbcd4b7aaf6a5f1315747`.

Post-fix verification:

```text
npx vitest run tests/routine-actions.test.ts
  -t 'converges concurrent identical SQLite proposals' --reporter=verbose
git diff --check
npm run typecheck
npx vitest run tests/routine-actions.test.ts --reporter=dot
```

Results: all exited 0; the targeted case passed, and the full Routine file passed 42/42.

## Mutation checks

Each mutation below was introduced alone, its targeted test was observed to fail for the
expected reason, and the source was immediately restored before the next mutation.

1. Pairing expiry — removed both expiry fences.

   ```text
   npx vitest run tests/telegram-project-onboarding.test.ts
     -t 'refuses an expired pairing code' --reporter=verbose
   ```

   Exit 1: the expired code created a member instead of returning
   `invalid_or_expired_pairing_code`.

2. Chat/user equality — removed `userId !== chatId` from the private-chat fence.

   ```text
   npx vitest run tests/im-webhook-idempotency.test.ts
     -t 'refuses non-private or mismatched sender chats' --reporter=verbose
   ```

   Exit 1: the mismatched private sender returned 200 instead of 400.

3. Update-digest conflict — removed the request-digest comparison during receipt replay.

   ```text
   npx vitest run tests/im-webhook-idempotency.test.ts
     -t 'conflicting text, principal or forwarding metadata' --reporter=verbose
   ```

   Exit 1: conflicting text returned 200 instead of `409 update_conflict`.

4. Active member — removed the active-status check from Telegram member resolution.

   ```text
   npx vitest run tests/im-webhook-idempotency.test.ts
     -t 'refuses task effects for suspended membership' --reporter=verbose
   ```

   Exit 1: the suspended member created a task.

5. Exact project/squad edge — replaced the exact `(project_id, squad_id)` invite lookup with
   a squad-only lookup.

   ```text
   npx vitest run tests/telegram-project-onboarding.test.ts
     -t 'refuses a unlinked squad' --reporter=verbose
   ```

   Exit 1: the service no longer returned `project_squad_not_linked`; a later rank refusal is
   not accepted as equivalent exact-edge validation.

6. Answer-choice validation — removed the exact choice-membership requirement.

   ```text
   npx vitest run tests/routine-actions.test.ts
     -t 'answers through IM as the mapped human with exact choices' --reporter=verbose
   ```

   Exit 1: lowercase `paid` was recorded instead of returning `invalid_answer`.

7. Shared verdict predicate — bypassed the `!gateResult.allowed` refusal branch.

   ```text
   npx vitest run tests/im-verdict-gates.test.ts
     -t 'REACHABLE exploit, now closed' --reporter=verbose
   ```

   Exit 1: an unauthorized self-completion gate returned `Approved` and wrote a verdict.

8. Stable notification request ID — appended a random UUID to the normal
   `routine-human:<run-id>:<action-key>` ID.

   ```text
   npx vitest run tests/routine-actions.test.ts
     -t 'routes propose mode through the existing Task review gate' --reporter=verbose
   ```

   Exit 1: the durable ID differed from `routine-human:run-1:task-1`.

Restoration check:

```text
git status --short
git diff -- src migrations
```

Result: only the then-untracked runbook remained; source and migrations had no diff.

## Final full repository verification

Command after the concurrency assertion fix and all mutation restorations:

```text
npm test
```

Result: exit 0 after 546.17 seconds.

```text
Test Files  511 passed (511)
Tests       7955 passed (7955)
```

Document and repository safety checks:

```text
git diff --check
node scripts/no-secrets.mjs
npm run typecheck
node scripts/check-schema-chain-fresh.mjs
```

Results: all exited 0; the secret scan reported `no secrets found`. The final post-runbook
build stamp identified `d4e6299ad95976ec59ef8ee4a6765629ff866746` with `clean: true`.

Node emitted its existing experimental SQLite warning during SQLite-backed tests. The
existing simulated `flight.landed receipt insert failed` line came from a passing negative
test. Neither was counted as a test failure.

## Graph limitation

The graph entrypoint was called first with this worktree and `origin/main`. It returned
`status: not_ready`, `reason: stale_graph`, built SHA `24e0c8bb...`, and head SHA
`bba3ab0a...`. An incremental update returned `status: ok` but still reported zero nodes,
zero edges, zero updated files, and the old built SHA. No graph-derived impact claim is made;
the fallback inspection was limited to the plan-named onboarding, IM, Routine, messaging,
migration, route, test, and operations-document files.

## Unproven live gates

The following remain explicitly unproven:

1. Branch push and draft PR creation.
2. Independent review and every required CI/security check on the eventual exact PR head.
3. Merge authorization and merge receipt.
4. Direct deployment approval naming the exact commit and tenant.
5. Remote application and ledger readback of migration `0152`.
6. Clean deployed-SHA readback from `/health`.
7. Protected Hermes/Telegram webhook configuration and credential rotation/readiness.
8. Live participant-specific-squad onboarding, Telegram delivery, decision, notification,
   revocation, and rollback evidence.

Until those receipts exist, this work is locally verified repository work, not a deployed or
live-pilot completion claim.

## Final hostile-review fix round 1

This section records the local fix tree based on
`7ee6b18a8660f0faf4acd0db18e2fb03bf6c20af`. The prior PR #1407 report of 17 green checks
applied to that base and is historical after this fix; it is not CI evidence for the commit
containing this section. This round did not push, mutate the PR, merge, deploy, configure a
credential or invitation, or execute a live pilot.

The operator runbook now makes authorized decision routing a prerequisite: a Routine human
answer must name the participant squad in `responsible_squad_id` (including the materialized
run policy), while a Task verdict must name that squad in `task.squad_id` and retain its
independently approved gate policy/grant. It also keeps the inherited `writeVerdict`
status-before-receipt interruption gap explicit for pilot reconciliation; this fix does not
claim to repair it.

### Red/green and mutation evidence

The hostile control-character regression used a valid 2,000-byte U+0001 question and five
valid 500-byte choices. Before the source fix:

```text
npx vitest run tests/routine-actions.test.ts
  -t 'bounds control-character human-wait notifications' --reporter=verbose
```

Result: exit 1. The Routine reached durable waiting state, but the first result reported
`notification_pending: true` instead of `false`; the raw-slice fallback still serialized
above 8,000 characters, so no agent message was accepted. After JSON-encoded budgeting and
the final serialized re-check, the same command exited 0. The test proves project/run/action
attribution, `truncated: true`, a nonempty distinct choice summary, a body at or below 8,000
characters, successful initial delivery, duplicate replay, and exactly one stored message.

The migration-chain join-to-decision integration was then run with:

```text
npx vitest run tests/telegram-project-onboarding.test.ts
  -t 'joins through Telegram and decides only participant-squad' --reporter=verbose
```

Its first complete-path run exposed an incomplete test seed: governed control-Flight landing
correctly refused a missing Routine proposal-witness receipt and `/answer` returned
`receipt_failed`. Adding the real witness to the migration-backed fixture made the command
exit 0. The test now creates the participant/other squad topology, routes the Routine and
Task before invitation, redeems through the authenticated `/start` webhook, adds the
independent gate grant, verifies `/needs` decision actions, records the authorized answer and
verdict, and refuses both other-squad decisions.

Two source mutations were introduced separately and restored immediately:

1. Removing `answerRoutineRun`'s `policy.responsible_squad_id` authorization changed the
   other-squad attempt from `forbidden` to `answer_not_found`; the integration exited 1.
2. Removing IM verdict routing's `task.squad_id` capability check approved `other-review`;
   the integration exited 1 instead of observing the permission refusal.

After both restorations, the integration command exited 0 again. These are mutation REDs,
not shipped source changes.

### Focused and expanded verification

Focused command:

```text
npx vitest run tests/telegram-project-onboarding.test.ts
  tests/im-webhook-idempotency.test.ts tests/im-verdict-gates.test.ts
  tests/routine-actions.test.ts tests/needs-you.test.ts --reporter=verbose
```

Result: exit 0, 5/5 files and 120/120 tests passed.

Expanded adjacent command:

```text
npx vitest run tests/im-hermes.test.ts tests/telegram-direct.test.ts
  tests/telegram-bridge.test.ts tests/telegram-adapter.test.ts
  tests/routine-routes.test.ts tests/routine-dispatch.test.ts
  tests/routine-proposal-receipt.test.ts tests/tasks-verdict-gates.test.ts
  tests/tasks-verdict-route-e2e.test.ts --reporter=dot
```

Result: exit 0, 9/9 files and 90/90 tests passed. Existing negative Telegram tests emitted
their expected delivery-refusal logs; they did not fail.

The following commands also exited 0 on the local fix tree:

```text
npm run typecheck
node scripts/check-schema-chain-fresh.mjs
git diff --check
node scripts/no-secrets.mjs
```

TypeScript ran `tsc --noEmit`; the schema guard reported the generated schema chain fresh;
the secret scan reported `no secrets found`. The typecheck build-info pre-step identified
base `7ee6b18a8660f0faf4acd0db18e2fb03bf6c20af` and `clean: false`, accurately reflecting
that the fix was not committed yet. No full-suite or new PR-CI result is claimed here.

The code-review graph was updated from the exact base after the changes. It parsed three
source/test files, indexed 206 changed nodes and 3,404 edges, and reported risk 0.40; it found
no detected execution flows and could not associate the private serializer helpers with the
integration-style regression, so the direct focused and expanded test evidence remains the
verification authority.

## Hostile repair Task 6: terminal human-wait delivery

This local repair started from exact head
`2bcfd7e6af6bf277b06bd9bf24ee4f7fa6e632ed`. It changes only new Routine human-wait
notifications from `kind = 'request'` to `kind = 'ack'`; their sender identities, stable
`routine-human:` request ID, project attribution, and `routine.human-wait/v1` body are
unchanged. Ordinary `routine.run/v1` execution dispatch remains a request.

### Red/green seam evidence

The test was changed first to lease the real stored human-wait message through
`leaseAgentInbox`. Before the source change, this command exited 1 because the persisted kind
was `request` instead of `ack`:

```text
npx vitest run tests/routine-actions.test.ts
  -t 'routes propose mode through the existing Task review gate' --reporter=verbose
```

After the one-line source change, the exact local seam gate exited 0 with 2/2 files and 3/3
selected tests passing:

```text
npx vitest run tests/routine-actions.test.ts tests/routine-dispatch.test.ts
  -t 'routes propose mode through the existing Task review gate|preserves a legacy request-kind human-wait envelope during reconciliation|attributes Task, Flight, references, digest, and inbox envelope to the exact Project'
  --reporter=verbose
```

The leased human-wait envelope reported `kind: ack`, `expects_reply: false`, and
`reply_basis: ack_is_terminal`. Its identical proposal replay retained one durable message.
The real ordinary Routine dispatch lease reported `kind: request`, `expects_reply: true`, and
`reply_basis: request_id_field`.

Historical human-wait rows are not migrated or rewritten. The reconciliation regression
pre-seeded a request-kind `routine-human:` row, replayed the proposal, and observed the same
row and kind with a one-row count. Because the new ACK envelope differs from that historical
envelope, notification remains pending and the operator must reconcile the persisted legacy
record rather than manufacture a replacement.

### Fresh local verification

Focused full-file verification:

```text
npx vitest run tests/routine-actions.test.ts tests/routine-dispatch.test.ts --reporter=dot
```

Result: exit 0, 2/2 files and 65/65 tests passed.

Adjacent lease, reply-expectation, integrity, and migration-chain onboarding verification:

```text
npx vitest run tests/reply-expectation.test.ts tests/agent-inbox-lease-sqlite.test.ts
  tests/message-integrity-persistence.test.ts tests/telegram-project-onboarding.test.ts
  --reporter=dot
```

Result: exit 0, 4/4 files and 81/81 tests passed.

The following commands also exited 0:

```text
npm run typecheck
node scripts/check-schema-chain-fresh.mjs
git diff --check
node scripts/no-secrets.mjs
```

TypeScript ran `tsc --noEmit`; the schema guard reported the generated chain fresh; the
secret scan reported `no secrets found`. The build-info pre-step named exact base
`2bcfd7e6af6bf277b06bd9bf24ee4f7fa6e632ed` with `clean: false`, accurately describing the
uncommitted local repair at verification time. This is local evidence only: no push, PR
mutation, merge, deployment, production state change, or live Telegram pilot is claimed.

## Final local release verification at `80001a11`

Final verification was run on exact server head
`80001a11c29d93a5dd83f09f87eeaff92514f851` with a clean tracked tree. The additive
migration order is `0152_telegram_project_onboarding.sql` followed by
`0153_inbox_lease_attempt_reconciliation.sql`; 0153 owns the strict-scope, attempt lease,
reconciliation, and attempt-bound ACK receipts consumed by the Hermes attempt-v3 client.

Fresh results:

```text
npm test
Test Files  512 passed (512)
Tests       7985 passed (7985)
Duration    664.60s

npm run typecheck                                      exit 0
schema generator/freshness tests                       59/59 passed
MCP seam ratchet tests                                 24/24 passed
selected migration/schema integration                 105/105 passed (10 files)
schema-chain freshness, full-base diff, no-secrets     exit 0
```

The cross-repository acceptance used the real server MCP application over loopback HTTP and
the native Hermes client. With plugin head
`457ac9816ec1b2532eb959b05a664cbccde2532c` and Hermes
`233757037df1f03f9fe1cfddc097acd5ad7f7510`, both cases passed: the matched profile reached
strict status, attempt lease, attempt ACK, consumed readback, and one activation acceptance;
the mismatched profile stopped before custody or ACK.

Two final server mutations were introduced separately in a disposable detached worktree and
restored immediately:

1. Removing the attempt stamp/delivery/expiry ownership checks let stale attempt A consume
   newer lease B. The stale-attempt regression failed on the changed `read_at` and cleared
   lease, killing the mutation.
2. Removing `lease_expires_at IS NULL` from ACK compensation rolled back a same-timestamp
   legacy consume. The legacy-race regression failed on the erased `read_at`, killing the
   mutation.

After restoration, the complete attempt-ACK file passed 9/9 and the disposable worktree was
diff-clean. No server source or test changed during this final verification.

This file is repository-local verification only, permanently — that property does not change
with a later push or a later green CI run, so no claim here should be read as, or restated as,
proof of any of the following: exact-head remote CI, an independent security review, merge,
deployment approval, remote application or readback of migrations `0152` and `0153`, a
deployed `/health` SHA, protected profile/webhook configuration, a live invitation, or a real
non-admin Telegram onboarding pilot. Each of those is a separate, separately gated artifact
that names its own exact commit; look for that artifact rather than inferring its outcome from
this file's test counts. See the Athena/Kasra gate history on the PR for the exact-head verdict
and the commit it was measured against.

## Kasra-core addendum (2026-09-14, commits 91e7df7c–608d622a)

Kasra gate on head `22c778d8` returned **AMBER (fix before merge)**: P1-1 (CONFIRMED, executed
— actor rank on a squad scope widened from the coarse legacy role, past an explicit narrower
grant), P1-2 (CONFIRMED — the atomic claim fence unpinned because the synchronous test harness
cannot race it), P1-3 (CONFIRMED — zero negative-actor coverage on the admin floor), P1-4
(CONFIRMED — recipient/project authority content and the null-assignee branch of the notify
fence unpinned). Fixed in commit `91e7df7c`. Athena's parallel addendum (items A–H: a masked
mutant on the exact project↔squad edge lookup, a route-level P1-1 negative test plus
reconciling the coarse-role rank helper to one predicate, IM verdict-authority behaviour-change
disclosure, a net-new-humans-only `member_already_exists` test, threading Telegram's
first_name/username through as a cosmetic display-name label, this evidence file's own stale
"not yet pushed" language, the migration-0153-as-second-subsystem PR-body disclosure plus a
numbering re-check against every other open PR, and splitting notifyHumanWait's collapsed
boolean into a distinguishable outcome) landed in commit `ad441e69`. Mutation testing of the
addendum's own new fences (below) surfaced two test-setup bugs in the M13 assertions
themselves — an invalid `agents.status` value and a project status independently caught by an
earlier, unrelated pre-check — both fixed in commit `608d622a` so the tests fail for the
reason they claim to, not by accident.

**Final head of this repository-local work: commit `608d622a` on
`kasra/telegram-project-onboarding-20260913`.** `npm run typecheck` clean. Focused suite
(`telegram-project-onboarding.test.ts`, `members-sensitive-response.test.ts`,
`needs-you.test.ts`, `routine-actions.test.ts`, `im-webhook-idempotency.test.ts`,
`im-verdict-gates.test.ts`): 141/141. Full `npm test`: 512 files, 8,001 tests — see the exact
run below; the same numbers are re-measured, not carried over from an earlier head.

This addendum does not replace the exact-head remote CI / independent review / deployment
gates named above — it is the same repository-local kind of evidence as the rest of this file,
for the commits added after `22c778d8`.

### Mutation table (measured against commit `608d622a`; each mutant applied, run, confirmed
### red, then reverted — `git diff` clean between mutants)

| ID | Location | Mutation | Test(s) driving the kill | Result |
| --- | --- | --- | --- | --- |
| A | `src/members/project-invites.ts:312-318` (exact project↔squad edge lookup) | `WHERE access.squad_id = ?2` only (dropped `access.project_id = ?1 AND`) | `refuses a unlinked squad` (`it.each`) — required first linking `squad-unlinked` to a *different* real project so a squad-only lookup and the exact-pair lookup diverge | RED — returned `forbidden` instead of `project_squad_not_linked` |
| M5 | `project-invites.ts` `CLAIM_INVITE_SQL` | dropped `AND accepted_at IS NULL` | P1-2 "M5 — refuses to claim an invite that is already accepted" | RED — 1 row changed instead of 0 |
| M6 | `project-invites.ts` `CLAIM_INVITE_SQL` | dropped `AND pairing_expires_at > ?8` | P1-2 "M6 — refuses to claim an invite past its pairing expiry" | RED — 1 row changed instead of 0 |
| M7 | `project-invites.ts` `CLAIM_INVITE_SQL` | dropped the receipt `state = 'processing'` line inside the EXISTS | P1-2 "M7 — refuses to claim without a matching processing receipt" | RED — 1 row changed instead of 0 |
| M10 | `project-invites.ts:319` | deleted `if (actorRank < capabilityRank('admin')) return {ok:false,error:'forbidden'}` | P1-3 "refuses invite creation from an observer holding a real, narrower squad grant" | RED — invite minted (`ok:true`) instead of `forbidden` |
| M13 | `src/agents/messages.ts:419-420` (insert-time recipient fence) | dropped both `recipient.status = 'active'` and `project.status = 'active'` | routine-actions "fences notification when the assigned agent is deactivated…" and "…when the project is no longer active…" | RED (both) — `notification_pending:false, notification_reason:'delivered'` instead of refused |
| M14 | `src/routines/actions.ts:397` (`notifyHumanWait`) | deleted `if (!run.assigned_agent_id) return {delivered:false, reason:'no_recipient'}` | routine-actions "reports no delivery honestly when the run has no assigned agent" | RED — outcome reason changed (fell through to an actual, differently-failing send attempt) |
| P1-1 source | `project-invites.ts` `actorRankOnSquad` | restored the pre-fix `Math.max(legacyRoleRank(auth.role), grantRank)` widening | P1-1 "refuses an org admin with resolved-but-empty capabilities…" and "…org owner whose only resolved grant… is narrower than admin" | RED (both) — invite minted at `admin`/`owner` instead of refused |

Every row above was applied as a single localized edit, confirmed red, then reverted with
`git checkout -- <file>`; `git status --short` showed a clean tree between mutants (no
uncommitted mutation ever coexisted with the next one).
