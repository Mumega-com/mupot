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
