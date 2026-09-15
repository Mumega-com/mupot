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

**The mutation table and the focused/full-suite counts in this addendum were produced at
commit `608d622a` on `kasra/telegram-project-onboarding-20260913`; they describe that commit,
not whatever this branch's tip happens to be when read. Later commits on this branch are
docs-only unless this section itself is revised to name a new commit and re-measured counts —
a docs-only commit changing this file's wording (as this correction does) does not by itself
invalidate the `608d622a` measurement it is scoped to.** `npm run typecheck` clean. Focused suite
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

## kasra-review re-gate follow-up (2026-09-14, commits 27f26deb–9cd9b182)

kasra-review's adversarial re-gate at head `1fbc60b2` enumerated every conjunct of
`CLAIM_INVITE_SQL` (not just the three the P1-2 fix's own tests named) and reported **8 of
~11 survived** even with M5/M6/M7 in place, naming the project `status = 'active'` EXISTS and
the `project_squad_access` EXISTS as the two that mattered (both singly-expressed, no JS
twin, proven load-bearing by an A/B probe in that gate — deleting either lets a redemption
into an archived project / a revoked squad↔project edge mint a `capabilities` row). This
follow-up did not re-run that exact pre-fix baseline (the M8/M9 tests below were added before
the first sweep in this session ran); instead it added tests for those two named conjuncts
first, then ran its own full sweep at a finer 15-way split (separating the receipt `EXISTS`'s
four sub-conjuncts individually, which the review's ~11 count did not) and found **10 of 15
still unpinned** even with M5-M9 in place: `id`, `pairing_hash`, `project_id`, `squad_id`,
`capability`, `email`, and all four receipt sub-conjuncts (`tenant`, `update_id`, digest,
`telegram_user_id` — only `state = 'processing'` was independently pinned, by M7). Separately,
the same re-gate re-confirmed a second finding first raised at
head `22c778d8`: `createProjectInvite` still minted an invite for a legacy `role: 'admin'`
principal with **no `memberId`**, a shape `requireCapability` itself refuses unconditionally
for any non-org scope (`src/auth/capability.ts:315-322`) regardless of role. And a third,
P2 finding: `decided_by_display` (`src/tasks/runtime-receipts.ts`) can resolve to a
Telegram-onboarded member's cosmetic, user-supplied `display_name` with no escaping at that
render site.

Fixes, in commit order:

- `27f26deb` — (1) added M8/M9 to the P1-2 fence describe block proving the project-active and
  project-squad-access `EXISTS` conjuncts are load-bearing: each asserts 0 rows claimed,
  `invites.accepted_at` still `NULL`, zero `capabilities` rows, and the Telegram receipt state
  untouched at `'processing'`. (2) Closed the `memberId` parity gap: `actorRankOnSquad`'s
  `!auth.memberId` branch no longer grants a legacy-role floor at all — it returns `0`
  unconditionally, matching `requireCapability`'s own restriction (that escape only ever
  applies to org-scope checks) instead of reimplementing a third, looser copy of it. Added a
  test: org owner, no `memberId` → `forbidden`. Left `actorMaxRankOnScope`
  (`src/auth/capability.ts`) untouched per brief — same class of drift, tracked separately as
  `mupot#1408` — added a one-line pointer comment so the drift stays visible rather than
  silently diverging further. (3) Added `sanitizeDecidedByDisplay`: strips C0/C1 control
  characters (newlines, CR, tabs) and caps to 200 chars (the same bound
  `redeemTelegramProjectInvite` enforces on `display_name` at mint time) at the
  `decided_by_display` render site, plus a test proving a name with embedded markup/newlines
  cannot inject a fake extra line into the receipt while its legible content still survives.
- `209c2104` — full conjunct-by-conjunct mutation sweep of `CLAIM_INVITE_SQL` (script below)
  re-run after the M8/M9 addition; 10 of 15 conjuncts were still green. Pinned the
  four categories the re-gate brief named as mattering: receipt tenant (a receipt for the
  right `update_id`/digest/`telegram_user_id` but the wrong tenant must not satisfy the
  `EXISTS`), the exact invite `id` (a second invite row sharing the same
  `pairing_hash`/`project_id`/`squad_id`/`capability`/`email` — only the named `id` is ever
  touched), the `project_id`/`squad_id` binding, and the `capability` binding. Left
  `pairing_hash`, `email`, and the receipt's `update_id`/digest/`telegram_user_id`
  sub-conjuncts as reported (not pinned) survivors — see the table below for why.
- `9cd9b182` — the full suite (not just the two focused files named in this task) surfaced 6
  failures in `tests/im-webhook-idempotency.test.ts`: its `invite()` fixture used
  `role: 'admin'` with no `memberId`, exactly the shape the `27f26deb` fix now correctly
  refuses. Gave the fixture a real `memberId` + an explicit `admin` capability grant on
  `squad-1`, the same shape any real inviter needs, instead of leaning on the coarse legacy
  role alone. This is the fixture catching up to the corrected (secure) behavior, not a
  regression in the fix.

### Mutation sweep method

Every conjunct of `CLAIM_INVITE_SQL` was mutated one at a time (anchor-uniqueness asserted
before each write — `assert content.count(old) == 1`), `npx vitest run
tests/telegram-project-onboarding.test.ts` run against each mutant, then the file restored
and byte-identity verified against the original before the next mutant. No mutant ever
coexisted with the next; the driver script itself asserts this at the end of the run.

### Mutation table (measured at head `209c2104` — after both the P1-A fence tests and the
### tenant/id/project/squad/capability pinning tests landed; each conjunct removed/replaced,
### run against `tests/telegram-project-onboarding.test.ts`, then restored)

| Conjunct | Mutation | Result | Killed by |
| --- | --- | --- | --- |
| `id = ?2` | replaced with `1=1` | RED | "pins the exact invite id — a second invite sharing the same pairing_hash/project/squad/capability/email is never touched" |
| `pairing_hash = ?3` | dropped | **SURVIVED** | none (see note) |
| `project_id = ?4` | dropped | RED | "pins the project_id binding — refuses when the caller's project_id mismatches the invite's own project" |
| `squad_id = ?5` | dropped | RED | "pins the squad_id binding — refuses when the caller's squad_id mismatches the invite's own squad" |
| `capability = ?6` | dropped | RED | "pins the capability binding — refuses when the caller claims a different capability than the invite grants" |
| `email = ?7` | dropped | **SURVIVED** | none (see note) |
| `accepted_at IS NULL` | dropped | RED | M5 |
| `pairing_expires_at > ?8` | dropped | RED | M6 |
| `EXISTS (projects … status = 'active')` | dropped | RED | M8 (new) |
| `EXISTS (project_squad_access …)` | dropped | RED | M9 (new) |
| receipt `tenant = ?9` | replaced with `1=1` | RED | "pins the receipt tenant — refuses when the only matching receipt belongs to a different tenant" |
| receipt `AND update_id = ?10` | dropped | **SURVIVED** | none (see note) |
| receipt `AND lower(request_digest) = lower(?11)` | dropped | **SURVIVED** | none (see note) |
| receipt `AND telegram_user_id = ?12` | dropped | **SURVIVED** | none (see note) |
| receipt `AND state = 'processing'` | dropped | RED | M7 |

**Note on the 5 remaining survivors (`pairing_hash`, `email`, receipt `update_id`, receipt
digest, receipt `telegram_user_id`):** none are reachable on the live call path today.
`redeemTelegramProjectInvite` always binds every one of these straight off the *same* row it
just read (by `pairing_hash` for the invite, by `tenant`+`update_id` for the receipt), so a
mismatch cannot occur at the one real caller. The three receipt sub-conjuncts additionally
already have a JS-level twin in `redeemTelegramProjectInvite`'s own pre-check — digest and
`telegram_user_id` equality, and `update_id` as part of the lookup key itself — so their
SQL-level exposure, if any, is TOCTOU-only (a receipt row changing between the JS pre-check
and the atomic claim), the same class as the pre-existing M6 finding, not a new gap.
`pairing_hash`/`email` are redundant with the now-pinned `id` in the current single-caller
shape (the row is already uniquely identified by `id`). Reported per the "narrow truth, not
the dramatic one" rule — these are honestly survived mutants, not silently dropped ones.

### Focused and full-suite verification, measured at commit `9cd9b182` (the last code/test
### commit in this follow-up; this documentation commit lands after it and does not itself
### change any test or source file)

- `npm run typecheck`: clean (`tsc --noEmit` exit 0).
- `npx vitest run tests/telegram-project-onboarding.test.ts tests/members-sensitive-response.test.ts`:
  exit 0, 2 files, 55/55 tests passed.
- `npm test` (full suite): exit 0, **512 files, 8010 tests, all passed** (0 failed). Run
  duration 592.53s. This is the real, freshly-measured count for this commit — not carried
  over from the `608d622a` addendum above (which measured 512 files / 8,001 tests; the 9 new
  tests added in this follow-up — 2 for the P1-A fence, 1 for the P1-1 parity gap, 5 for the
  tenant/id/project/squad/capability pinning sweep, 1 for the display_name sanitizer — plus 0
  net change elsewhere account for the difference).

## Kasra final-gate repair (head `bf401ca7` → new commit), 2026-09-14

Kasra's final gate on `bf401ca7` (AMBER → merge-defensible, 0 BLOCK / 3 WARN / 2 LOW) named
three WARN findings and one LOW. All four addressed as classes, not repros:

**WARN-1** (`src/members/project-invites.ts:242`, `access.squad_id = invites.squad_id`): M9
deletes the invite's *only* `project_squad_access` row, so it cannot tell whether the
`project_id` conjunct or the `squad_id` conjunct (or both) is what actually refuses the
claim — with zero rows left, mutating out either one individually still yields zero matches
and the test stays green regardless. Added two tests to the same `describe` block, each
leaving a *different* row in place that satisfies exactly one of the two conjuncts:

- **M9b** — a second squad (`squad-fence-b`) linked to the *same* project keeps its own
  `project_squad_access` edge; only the invite's own squad's edge is revoked. If
  `access.squad_id = invites.squad_id` were dropped, this leftover row would satisfy the
  `EXISTS` via `project_id` alone.
- **M9c** — the *same* squad keeps an edge on a *different* active project
  (`project-fence-b`); only the invite's own project's edge is revoked. If
  `access.project_id = invites.project_id` were dropped, this leftover row would satisfy the
  `EXISTS` via `squad_id` alone.

Mutation-proved individually (not inferred from the pair): dropping
`access.squad_id = invites.squad_id` → M9b red (claimed 1 row instead of 0); dropping
`access.project_id = invites.project_id` (replaced with `1=1` to avoid a SQL syntax error
that would give a false red) → M9c red. Both restored via `git checkout --` after each probe;
`git diff --stat` empty before the next probe and before final commit.

**WARN-2** (`src/tasks/runtime-receipts.ts:611`): `verdict.note` was returned raw beside the
sanitized `decided_by_display`, so the fake-extra-line injection threat this receipt guards
against was closed on only one of its two free-text fields. Renamed `sanitizeDecidedByDisplay`
to the generic `sanitizeReceiptText` (no other file referenced the old name — confirmed via
`grep -rn sanitizeDecidedByDisplay src tests`) and applied it to both `note` (guarding the
`null` case explicitly) and `decided_by_display`. New test: a note containing
`\n**FAKE VERDICT**\r\ndecided_by: X` plus 300 padding characters renders as a single line
(`split('\n')` length 1), with no `\n`/`\r`/C0-C1 control character, capped at 200 chars, and
its legible content (`Looks fine`, `FAKE VERDICT`) intact. Mutation-proved: reverting the
`gate.map` line to `note: row.note` (raw passthrough) turns this test red. Restored, diff
empty.

**WARN-3** (`runtime-receipts.ts:552`): the sanitizer stripped only C0/C1 control characters.
Unicode bidi embedding/override (U+202A-U+202E) and isolate (U+2066-U+2069) controls can
visually reorder or mask rendered text without changing the underlying characters; zero-width
characters (U+200B-U+200F, U+2060 word joiner, U+FEFF BOM/ZWNBSP) and soft hyphen (U+00AD)
render as nothing (or nothing until a line break) and can hide content or defeat exact-text
matching — none of these fall in the C0/C1 range, so all survived into an identity-bearing
field untouched. Extended `sanitizeReceiptText`'s regex to also strip
`[\u200B-\u200F\u2060\uFEFF\u00AD\u202A-\u202E\u2066-\u2069]`, written as explicit `\u`
escapes in the source (never literal invisible glyphs, so the diff itself stays reviewable
and can't be corrupted by the very characters it strips). Five new tests, each probing exactly one
class via a `renderedDisplayNameFor` helper (also built entirely from `\u` escapes): bidi
embedding/override, bidi isolates, zero-width (all four codepoint classes in one probe),
soft hyphen, and — the negative control — combining marks (U+0301 on `e`) are explicitly
*not* stripped, since they are legitimate diacritics rather than an injection vector.
Mutation-proved: removing the new strip clause (leaving only the C0/C1 clause) turns all four
positive-class tests red simultaneously while the combining-marks test stays green, confirming
the new clause — not some other part of the function — is what each test depends on. Restored,
diff empty.

**LOW** (comment at `runtime-receipts.ts:529-532`, now `:532-540`): the claim "so this can
never truncate a value that was itself accepted as valid at mint time" is false — the 200-char
cap is not universal across every mint-time path into these fields. `src/members/index.ts`'s
own `isNonEmptyString` helper (~line 87, used at its `display_name` validation, ~line 194,
the generic member-creation path) enforces no length cap at all, and a verdict `note` has no
mint-time cap anywhere in the codebase. Rewrote the comment to state plainly that the cap
bounds what a single receipt can render, not that it promises round-tripping of arbitrary
mint-time input. Also asked to report the evidence-doc survivor table honestly at an
asymmetric split: a symmetric two-edge split (M9b/M9c above) was done for *both* halves of the
`project_squad_access` EXISTS conjunct, so there is no remaining asymmetry to report for that
predicate specifically — the pre-existing 5-survivor table above (pairing_hash, email, and the
three receipt sub-conjuncts) is unrelated to this WARN and is unchanged by this round.

### Verification

- `npm run typecheck`: clean (`tsc --noEmit` exit 0).
- `npx vitest run tests/telegram-project-onboarding.test.ts tests/task-dispatch-runtime-receipts.test.ts`:
  exit 0, 2 files, **84/84** tests passed (was 55/55 + 27 in the receipts file before this
  round — this run's exact count for these two files together).
- `npm test` (full suite), measured on the committed code/test tree (commit `5c2ea0bd`): exit
  0, **512 files, 8018 tests, all passed** (0 failed). Duration 590.81s. Up from 8010 at
  `bf401ca7` — the 8 new tests this round (2 for M9b/M9c, 1 for verdict.note, 5 for WARN-3's
  bidi/zero-width/soft-hyphen classes) account for the difference exactly.

### Mutation table (this round, all executed for real: mutate → run targeted test →
### confirm red → `git checkout --` → confirm `git diff --stat` empty → next mutation)

| Guard | Mutation | Result | Killed by |
| --- | --- | --- | --- |
| `access.squad_id = invites.squad_id` | dropped | RED (1 row claimed, expected 0) | M9b |
| `access.project_id = invites.project_id` | replaced with `1=1` | RED (1 row claimed, expected 0) | M9c |
| `note: sanitizeReceiptText(row.note)` | reverted to raw `row.note` passthrough | RED (control chars present, not single line) | "sanitizes verdict.note with the same helper as decided_by_display" |
| bidi/zero-width/soft-hyphen strip clause | removed (C0/C1 clause kept) | RED × 4 (bidi embedding/override, bidi isolates, zero-width, soft hyphen) | the 4 named WARN-3 tests |
| same mutation as above | — | GREEN (unaffected, as expected) | "keeps combining marks intact" (negative control, correctly unaffected) |

## Bind-existing-member follow-up (mupot#1407 extension, 2026-09-14)

Separate task, separate branch: `kasra/telegram-bind-existing-member-20260914`, forked from
`origin/main` at `49a344aa9cd20d1aa7b563b36c946bc91ffea02b` (the merged #1407). This section
describes ROUND 1 specifically — the commits named below, not "every commit this branch will
ever hold" (a prior draft of this list stopped at `aa66b330` and, read after the two docs
commits that followed it on the SAME branch, would have understated the branch's own history;
see the Round 2 section below for what changed after this point, its own commit list, and its
own scoped verification):

- `c057d13c` — initial implementation: `createProjectInvite` accepts optional `member_id`;
  `redeemTelegramProjectInvite` binds an existing member instead of inserting a new one;
  migration `0154_project_invite_member_bind.sql` adds `invites.member_id` and extends
  0152's joint-null trigger.
- `aa66b330` — a correctness fix found by running the tests written for this task (not by a
  separate review pass), plus the tests that found it and two more added afterward. See
  "What testing found" below.
- `63069fb5` / `0b7a0945` — docs-only commits (this file plus the operations runbook)
  finishing round 1; no source or test changes.

This section describes work already committed at the SHAs above at the time it was written;
it does not describe this documentation commit's own pending state.

### Design (one predicate, one claim statement, no second copy)

`createProjectInvite` (`src/members/project-invites.ts`): `member_id` and a caller-supplied
`email` are mutually exclusive. When `member_id` is set, the function looks up the member with
the SAME tenant-collapse shape as `GET /members/:id` (`WHERE id = ?1 AND (tenant = ?2 OR
tenant IS NULL)`) — a member in another tenant reads as `member_not_found` (404), never a
distinguishable "wrong tenant" response, so this can never become a cross-tenant existence
oracle. `member_not_active` (403) and `member_missing_email` (400, an IM-only member with no
email on file — `invites.email` is `NOT NULL`) are checked next; the member's own email
becomes the invite's `email`, so the `members.email` UNIQUE fence and the receipt shape are
byte-identical to the net-new path. The actor's capability ceiling reuses `actorRankOnSquad`
verbatim — no second, looser rank predicate for the bind path.

`redeemTelegramProjectInvite`: when `invite.member_id` is set, the atomic batch's second
statement becomes an `UPDATE members SET telegram_chat_id = ?` (never an `INSERT`) guarded by
`(tenant = ? OR tenant IS NULL)` and `(telegram_chat_id IS NULL OR telegram_chat_id = ?)`. A
pre-check ahead of the batch (mirroring the existing JS-pre-check-then-SQL-fence pattern
already used for pairing-code validity) answers the "member already bound to a DIFFERENT
Telegram identity" conflict with its own named `telegram_identity_conflict` — necessary
because, unlike every other member-eligibility fact, this ONE case changes the returned error
code, so a redundant copy inside the atomic guard would only ever silently agree with it. The
reverse conflict ("this Telegram identity already belongs to a different member") is left
entirely to the pre-existing `UNIQUE(members.telegram_chat_id)` catch — the exact same
mechanism the net-new path already relies on, not a second copy of it.

### What testing found (a real gap, not a hypothetical)

The suspended-member test (written per the brief's explicit "pin member status='active' at
claim time" instruction) failed on the first run against the initial implementation. Cause:
`bindMemberStatement` could affect 0 rows without throwing (a suspended member is not a SQL
error), but `CLAIM_INVITE_SQL` — bound only to the invite's own columns — had already
committed `accepted_at`. This permanently burned a single-use invite for a transient member
suspension, on the ordinary SEQUENTIAL "member got suspended before `/start`" path, not merely
under a race. Worse: the downstream capability INSERT and receipt-completion UPDATE were
guarded only by `EXISTS(invite accepted)`, which was now true — so a residual race (the same
kind of Telegram-conflict or a mid-flight tenant reassignment, landing between the pre-check
and the atomic claim) would grant a squad capability and mark the receipt `completed` for a
member whose Telegram identity was never actually bound.

Fix (all inside `aa66b330`, one round, found by the task's own tests rather than a second
review pass): `CLAIM_INVITE_SQL` gained one more conjunct — `invites.member_id IS NULL OR
EXISTS(SELECT 1 FROM members WHERE id = invites.member_id AND status = 'active')` — so the
claim itself refuses to commit for an inactive bind target (net-new invites are unaffected;
the `OR` short-circuits before touching `members`). `bindMemberStatement` dropped its own
`status = 'active'` re-check as a guaranteed-vacuous copy (`CLAIM_INVITE_SQL` already proves it
inside the same D1-batch transaction — no external write can interleave). The capabilities
INSERT and receipt-completion UPDATE gained a conditional `EXISTS(SELECT 1 FROM members WHERE
id = ? AND telegram_chat_id = ?)` conjunct for the bind path, tying them to
`bindMemberStatement`'s OWN effect having landed, not merely to `CLAIM_INVITE_SQL`'s.

### Verification

- `npm run typecheck`: clean.
- `node scripts/check-migration-numbering.mjs`: `0154_project_invite_member_bind.sql` sorts
  above `origin/main` head `0153`; no open PR (checked: #1386, #1384, #1381, #1363, #1362,
  #1352, #1344, #1343, #1327, #1324, #1317, #1277, #1253) reserves `0154` or higher.
- `node scripts/check-schema-chain-fresh.mjs`: fresh after `npm run gen:schema-chain`.
- `npx vitest run tests/telegram-project-onboarding.test.ts tests/members-sensitive-response.test.ts tests/im-webhook-idempotency.test.ts tests/im-verdict-gates.test.ts`:
  exit 0, 4 files, 111 passed (before the 3 tests the correctness fix added; see full-suite
  count below for the final total).
- `npx vitest run tests/telegram-project-onboarding.test.ts`: exit 0, 76/76 (was 53 before this
  task; +23 new: 1 schema-trigger test, 8 `createProjectInvite` member_id tests, 9
  `redeemTelegramProjectInvite` member_id tests — including the suspend-retry and
  tenant-reassignment tests the correctness fix added — and 5 HTTP route tests).
- `npm test` (full suite, committed tree at `63069fb5`): exit 0, **512 files, 8041 tests, all
  passed** (0 failed). Duration 584.11s. Up from 8018 on `origin/main` at `49a344aa` — the 23
  new tests in this one file account for the difference exactly.

### Mutation table (round 1, `aa66b330`; corrected — Athena's round-2 BLOCK noted "Killed by"
### was dropped for 12/13 rows, "every conjunct new to this task" overstates it since the
### member-status conjunct reuses round 1's own predicate. All executed for real: mutate → run
### targeted test → confirm red → `git checkout --` → confirm `git diff --stat` empty → next)

| Guard | Location | Mutation | Result | Killed by |
| --- | --- | --- | --- | --- |
| 0154 trigger: member-bind requires full project field set (INSERT + UPDATE) | migration 0154 | both RAISE ABORT clauses removed | RED | "requires a member-bind project invite to carry the full project field set" |
| `invalid_member_id` on blank/whitespace `member_id` | `createProjectInvite` | check removed | RED — wrong error returned | "rejects an empty member_id as invalid_member_id" |
| Member lookup returns `member_not_found` | `createProjectInvite` | check neutered (`if (false)`) | RED — both throw on null deref once neutered | "refuses a nonexistent member with member_not_found"; "collapses a member from another tenant to member_not_found (no cross-tenant existence oracle)" |
| Member lookup tenant scoping | `createProjectInvite` SQL | `(tenant = ?2 OR tenant IS NULL)` removed | RED — cross-tenant invite minted (existence-oracle class) | "collapses a member from another tenant to member_not_found (no cross-tenant existence oracle)" |
| `member_not_active` on suspended member | `createProjectInvite` | check neutered | RED — invite minted for a suspended member | "refuses a suspended member with member_not_active" |
| `member_missing_email` on null email | `createProjectInvite` | check neutered | RED — throws on `.trim()` of null | "refuses a member with no email on file with member_missing_email" |
| Rank ceiling (`cannot_grant_above_own_rank`) reached via the bind path | `createProjectInvite` | ceiling check neutered | RED — invite minted above actor's rank | "still enforces the actor rank ceiling on a member-bind invite (no second predicate)" |
| Pre-check `telegram_identity_conflict` (member already bound differently) | `redeemTelegramProjectInvite` | pre-check neutered | RED — wrong error code (falls through to the atomic guard's generic fallback) | "refuses when the member already has a DIFFERENT Telegram identity bound" |
| `CLAIM_INVITE_SQL`'s new member-status conjunct | `redeemTelegramProjectInvite` | conjunct removed | RED — redemption now SUCCEEDS entirely for a suspended member | "refuses redemption when the target member is suspended between invite creation and claim"; "does not burn the invite when the target member is suspended — it is retryable once reactivated" |
| `bindMemberStatement`'s own tenant conjunct | `redeemTelegramProjectInvite` | `(tenant = ?3 OR tenant IS NULL)` replaced with `(1=1)` | RED — tenant-reassigned member gets bound anyway | round-1 test of this name, superseded in round 2 (see below) — the statement it names no longer exists verbatim after round 2's shared-predicate fix, re-proven there |
| `memberBindLandedGuard` cross-statement fence (capabilities INSERT + receipt UPDATE) | `redeemTelegramProjectInvite` | guard fragment/params neutered to `''`/`[]` | RED — capability row granted (count 1, expected 0) for a member whose bind never landed | round-1 test of this name, superseded in round 2 by F2 and the stamp-guard proof (see below) |
| Stray-`email`-with-`member_id` rejection | `src/members/index.ts` `parseInvite` | check neutered | RED — 201 instead of 400 | "rejects a body supplying both member_id and email as an ambiguous scope (400)" |
| `member_not_found`/`member_not_active` → 404/403 HTTP mapping | `src/members/index.ts` `projectInviteErrorStatus` | both arms neutered | RED — both fall to default 400 | "refuses a member_id from another tenant (404)"; "refuses an inactive member (403)" |

Honestly-reported non-distinguishable survivors (documented, not silently dropped):

- `bindMemberStatement`'s own `(telegram_chat_id IS NULL OR telegram_chat_id = ?1)` conjunct
  is TOCTOU-only from this test suite's perspective: the pre-check above reads the identical
  condition from the identical row with no intervening I/O, so in every sequential test it can
  only ever agree with the pre-check. Same class as the pre-existing receipt sub-conjuncts'
  TOCTOU-only gap in `CLAIM_INVITE_SQL` (documented in the prior #1407 evidence above). A real
  concurrent redemption is the only thing that could exercise it independently.
- `bindMemberStatement`'s `EXISTS(invites WHERE id = ? AND accepted_at = ?)` conjunct: removing
  it is not caught by any test, because the capabilities/receipt statements' own guards
  (`EXISTS(invite accepted)` plus `memberBindLandedGuard`) already independently prevent any
  observable bad effect even if `bindMemberStatement` re-fires harmlessly (re-setting an
  already-correct value). Kept for structural symmetry with the net-new `INSERT`'s identical
  `EXISTS` guard, not because a test proves it uniquely load-bearing.

### Not done

- A real concurrent (multi-connection) exercise of the two TOCTOU-only survivors above —
  consistent with every prior TOCTOU-only finding in this codebase, which are accepted and
  documented rather than fabricated into a synchronous test.
- `docs/operations/telegram-project-onboarding.md` updated in the same commit range: removed
  the "net-new humans only" restriction, added a "Binding a Telegram identity to an existing
  member" section with the request shape, the three creation-time refusals, and the two
  redemption-time conflict shapes.

## Round 2 — Athena BLOCK + kasra-review parallel adversarial gate (2026-09-15)

Same branch, same PR (#1411). Round 1 ended at `0b7a0945`. Athena's gate on that head
returned **BLOCK** (F1, F2, F3 below); a parallel kasra-review adversarial pass on the same
head separately found **P0-1** (identity takeover) plus P2/P3 items. Both are addressed here,
in commits `97e2537f` (fix), `b403c64f` (test), `8a08d69e` (test) on top of `0b7a0945` — this
documentation commit lands after those three and does not itself change source or test files.

### Athena BLOCK — one eligibility predicate, not two

Root cause named in the BLOCK: `CLAIM_INVITE_SQL`'s `bind_target` EXISTS (round 1) checked
only `status = 'active'`; `bindMemberStatement`'s WHERE (round 1) separately checked
`(tenant = ? OR tenant IS NULL)` — two hand-duplicated predicates that had already drifted
(F2), and neither refused a NULL tenant (F1), which `memberForChat`
(`src/im/index.ts:95-97`) can never resolve regardless.

Fix: `MEMBER_BIND_ELIGIBLE_SQL` (`src/members/project-invites.ts`) — `id = ? AND tenant = ?
AND status = 'active' AND (telegram_chat_id IS NULL OR telegram_chat_id = ?)`, with an EXACT,
non-NULL tenant match — is now the ONLY place this predicate is written, interpolated
verbatim into both `CLAIM_INVITE_SQL`'s `bind_target` EXISTS and the extracted
`MEMBER_BIND_UPDATE_SQL` (bindMemberStatement's statement, itself now exported for the same
P1-2 reason `CLAIM_INVITE_SQL` was). A seam test asserts both compiled statement strings
contain the identical constant (`toContain`) — a future hand-edit to either copy that drifts
even slightly fails immediately, rather than waiting for a behavioral test to notice.

Consequence (F3 in Athena's own recommendation): a member reassigned to another tenant
mid-flight is now refused AT THE CLAIM (`CLAIM_INVITE_SQL`'s own `bind_target` EXISTS fails),
so the invite is left intact and retryable — not burned, as round 1's documented "judgment
call" accepted. The round-1 test asserting the invite WAS burned in this scenario has been
replaced with one asserting it stays intact (`accepted_at: null`).

`memberBindLandedGuard` (gating the capabilities INSERT and receipt-completion UPDATE) was a
STATE test — `EXISTS(members WHERE id = ? AND telegram_chat_id = ?)` — satisfiable by ANY
history that happened to leave that value set, independent of whether `bindMemberStatement`
itself ran, and ran successfully, for THIS claim (F2's exact mechanism: a member already
carrying the redeeming identity, reassigned mid-flight, made the state test pass while the
bind statement silently affected 0 rows). Fix: migration `0154` gains an additive
`members.telegram_bound_at TEXT` column, written ONLY by `bindMemberStatement` with THIS
claim's own unique timestamp (`claimTimestamp()` mixes in a random suffix); the guard
(`MEMBER_BIND_LANDED_GUARD_SQL`, also exported) now checks `telegram_bound_at = ?` bound to
that same claim timestamp — a PROOF this claim's own write landed, not a fact that could
already have been true.

### kasra-review P0-1 — identity takeover, closed

A member-bind invite mints a Telegram credential that authenticates AS the target
(`memberForChat`). Round 1's actor check (`actorRankOnSquad`, squad-scope) and its target
check (none) meant a squad-admin could member-bind a higher-ranked principal — an org owner,
say — onto their own squad at a low capability, then redeem it from THEIR OWN Telegram id and
resolve through `memberForChat` AS that member. No route ever cleared
`members.telegram_chat_id`, so the takeover was permanent.

Fix, reusing existing primitives rather than adding new ones:

- `createProjectInvite`'s member-bind branch now computes the actor's rank via
  `actorRankOnScopeFor(env, auth, 'org', null)` (org-scope, not squad-scope) — the SAME
  authority `POST /members/:id/tokens` already requires for minting a credential AS someone.
  The non-member_id (net-new) path is unchanged.
- New `exceedsTargetRankCeiling` / `targetMaxRankAcrossScopes`
  (`src/auth/capability.ts`) check the target's standing ACROSS EVERY SCOPE they hold a grant
  on (reusing `resolveCapabilities`, the same query every capability check already runs), not
  one `(scope_type, scope_id)` row. This closes the identical per-scope bypass in
  `targetRankCeiling`'s three PRE-EXISTING call sites (`src/members/index.ts`: suspend/
  reactivate, token mint, capability grant) uniformly — `targetRankCeiling` itself now
  delegates to `exceedsTargetRankCeiling` instead of its own narrow query.
- New `DELETE /members/:id/telegram` route (org admin + the same `targetRankCeiling`) — the
  bind was previously irreversible; this is the admin-unbind half of P0-1(d) (a self-unbind
  via the bound chat is not implemented this round).

### kasra-review P2 / P3

- P2-2: `createProjectInvite` now refuses `member_id` and `email` supplied together itself
  (`invalid_invite_scope`), not only at the HTTP `parseInvite` layer — a non-HTTP caller of
  the service cannot bypass the route's own check.
- P2-1 (email visibility / enumeration): resolved as a consequence of the P0-1 fix rather than
  a separate change — member-bind invites now require ORG admin, the same principal who
  already has full member visibility via `GET /members`, so the response's `invite.email`
  is no longer reachable by a caller below that floor.
- P2-3 (UNIQUE throw on a pre-existing capability row on the invited squad → permanent
  `redemption_failed`): NOT fixed this round — noted here as a known robustness gap (the
  claim itself rolls back on the thrown constraint, so the invite is not burned, but the
  invite becomes permanently unusable until an operator intervenes). Left for a follow-up;
  tracked in the PR body.
- P3: migration `0154`'s `DROP TRIGGER` now uses `IF EXISTS` (matching 37/39 other
  migrations); the trigger now also refuses a whitespace-only `member_id`. The operations
  runbook's preflight, rollback, and evidence checklists now name `0154` alongside `0152`/
  `0153`. This file's round-1 mutation table gained the "Killed by" column Athena's BLOCK
  named as missing, and the self-falsifying commit list above (round 1's own section) is
  corrected to include the two docs-only commits that followed `aa66b330` on this same
  branch. "Who may target whom" for the member-bind path: an actor needs ORG-scope admin (or
  owner) standing AND the target's MAX standing across every scope must not exceed the
  actor's own — documented above under kasra-review P0-1, and in
  `docs/operations/telegram-project-onboarding.md`'s bind-existing-member section.

### Mutation table (round 2, all executed for real on the committed tree: mutate → run
### targeted test(s) → confirm red → restore from a clean `git diff --stat`-empty baseline
### → next; full commands and exact test names in
### `tests/telegram-project-onboarding.test.ts`)

| Guard | Location | Mutation | Result | Killed by |
| --- | --- | --- | --- | --- |
| `MEMBER_BIND_ELIGIBLE_SQL` tenant: `OR tenant IS NULL` restored | `src/members/project-invites.ts` | exact tenant match relaxed to the round-1 collapse shape | RED | "F1 — refuses at the claim (invite stays intact) when the target member has a NULL tenant" |
| `MEMBER_BIND_ELIGIBLE_SQL` tenant conjunct dropped entirely (param kept, made a no-op) | `src/members/project-invites.ts` | `tenant = ?` → `(? IS NOT NULL)` | RED × 3 | "refuses at the claim (invite stays intact) when the target member is reassigned to another tenant mid-flight"; "F1 …"; "F2 — refuses at the claim, grants nothing, when the target already carries the redeeming Telegram id AND was reassigned to another tenant" |
| `MEMBER_BIND_UPDATE_SQL` stops interpolating the shared constant (inlines a textually-different copy) | `src/members/project-invites.ts` | `${MEMBER_BIND_ELIGIBLE_SQL}` replaced with a hand-typed, deliberately narrower WHERE | RED | "seam — the claim and the bind statement interpolate the IDENTICAL member-eligibility fragment" |
| `MEMBER_BIND_LANDED_GUARD_SQL` reverted to a state test | `src/members/project-invites.ts` | `telegram_bound_at = ?` → `telegram_chat_id = ?` (JS still binds `claimedAt` as the 2nd param — a type/semantic mismatch, not merely a text change) | RED × 6 (every bind-success path breaks, plus the dedicated proof test) | "MEMBER_BIND_LANDED_GUARD_SQL requires THIS claim's own stamp, not a pre-existing matching identity"; "joins through Telegram with the same generic reply text as the net-new path"; "does not burn the invite when the target member is suspended — it is retryable once reactivated"; + 3 more bind-success tests |
| Member-bind actor rank restricted to squad-scope again (`hasMemberId ? org : squad` branch removed) | `src/members/project-invites.ts` | `actorRankOnScopeFor` branch dropped, always `actorRankOnSquad` | RED | "P0-1a — refuses a squad-admin actor (no org-scope standing) for a member-bind invite" |
| `exceedsTargetRankCeiling` call removed from `createProjectInvite` | `src/members/project-invites.ts` | ceiling check block deleted | RED | "P0-1b — refuses an org-admin actor targeting a member who outranks them via a DIFFERENT, unrelated scope (target-rank ceiling, across ALL scopes)" |
| `targetMaxRankAcrossScopes` narrowed back to org-scope-only (the pre-P0-1 shape) | `src/auth/capability.ts` | non-org grants skipped in the max-rank loop | RED × 2 | "P0-1b — …"; "refuses an org admin unbinding a member who outranks them via a DIFFERENT scope" |
| `targetRankCeiling` call removed from the new unbind route | `src/members/index.ts` | ceiling check block deleted | RED | "refuses an org admin unbinding a member who outranks them via a DIFFERENT scope" |
| Service-level `email` + `member_id` refusal removed | `src/members/project-invites.ts` | `invalid_invite_scope` check block deleted | RED | "P2-2 — the SERVICE itself refuses member_id and email supplied together, bypassing the HTTP route entirely" |
| 0154 whitespace-only `member_id` trigger clause removed (both INSERT/UPDATE triggers) | migration 0154 | `RAISE(ABORT, 'project invite member bind requires a non-blank member_id')` clause deleted | RED (different error — `FOREIGN KEY constraint failed` — confirming the clause is what threw, not a vacuous no-op) | "requires a member-bind project invite member_id to be non-blank" |

No new survivors reported this round — every new/changed guard above was proven by at least
one mutation.

### Verification

- `npm run typecheck`: clean (`tsc --noEmit` exit 0).
- `npx vitest run tests/telegram-project-onboarding.test.ts`: exit 0, **90/90** (up from 76 at
  round 1 — 14 new tests: reassignment behavior change, F1, F2, seam, stamp-proof, P0-1a/b/c,
  P2-2, 6 unbind-route tests, whitespace-member_id trigger test; net +14 after also removing
  and replacing the one round-1 test whose assertion direction flipped).
- `npx vitest run tests/members-sensitive-response.test.ts tests/members-agent-capability-route.test.ts tests/agent-self-update.test.ts tests/squad-member-tools.test.ts`:
  exit 0, 4 files, **119/119** — confirms `targetRankCeiling`'s three pre-existing call sites
  are unaffected by the across-all-scopes change (their fixtures grant exactly one scope per
  member, so the narrower and broader queries agree on every one of these cases).
- All local CI-parity scripts, re-run at head `8a08d69e`: `check-branch-staleness`,
  `check-mcp-tool-seam`, `check-migration-numbering` (`0154` still sorts above `origin/main`
  head `0153`, still uncontested by every other open PR's migrations dir),
  `check-operator-counts-source`, `check-schema-chain-fresh` (fresh after `npm run
  gen:schema-chain`), `check-test-schema-source`, `no-secrets`, `release-truth-policy` — all
  exit 0.
- **Full suite (`npm test`, all 515 files): NOT completed at head `8a08d69e`.** The host this
  session ran on was under sustained memory pressure from OTHER concurrent processes (other
  agent sessions, Hermes gateways, Celery workers — confirmed via `ps`/`free`, not attributable
  to this PR's own code or tests) for the whole verification window. Three whole-suite attempts
  (default parallelism, `--maxWorkers=2`, `--maxWorkers=1`) were each killed by the harness's
  own low-memory guard before finishing; a fourth attempt split the suite into file-list chunks
  to bound peak memory. What that chunking DID complete, all green, before being stopped to
  finalize this report:
  - `tests/execute*.test.ts` … lexicographically through the file list's first ~127 entries
    (`find tests -name '*.test.ts' | sort`, chunk 1 of 4): **124 files, 2237 tests, 0 failed.**
    (3 of the 127 names in that chunk are excluded by `vitest.config.ts`'s own exclude list —
    not a failure, the same exclusion `npm test` itself applies.)
  - The next 60 files (two 30-file sub-chunks of chunk 2 of 4, `tests/execute.test.ts` through
    `tests/flight-routes.test.ts` alphabetically): **60 files, 985 tests, 0 failed** (451 +
    534 across the two sub-chunks).
  - **Not run this session:** the remaining files of chunk 2 (3 further 30-file sub-chunks),
    and all of chunks 3 and 4 — roughly the back half of the alphabet
    (`tests/flight-spine-*.test.ts` onward through `tests/*` and `tests/composition/`'s
    workerd-pool step). None of the files not yet run are known, from this session, to touch
    `src/members/`, `src/auth/capability.ts`, or the migration chain — but that is an
    inference from the change's own surface area, not a measurement, and is exactly the kind
    of claim a full run is supposed to replace with a fact.
  - **Combined measured this session: 184 of 515 files, 3222 of an unknown total test count,
    0 failures.** This is a strictly smaller claim than "full suite green" and must not be
    read as one. The next re-gate should run `npm test` (or the same chunking, continued from
    file 185 onward) against a clean git-backed checkout of head `8a08d69e` (or later) to get
    the real, complete count — this session's own host contention is not evidence about the
    code.
  - **Superseded by Round 3 below**, which ran the full suite once, uncontended, to
    completion — see that section for the real, complete count.

## Round 3 — CI fix for the round-2 widening's own test fixture (2026-09-15)

CI run `34917646917` on head `fbf85528` (round 2's own final head) came back **1 failed /
8054 passed**:

```
FAIL tests/members-capability-service.test.ts > POST /members/:id/capabilities > returns
     the shared upsert result after consolidating duplicate…
AssertionError: expected 500 to be 201
Error: unexpected all query: SELECT member_id, scope_type, scope_id, capability
```

Cause: round 2 widened `targetRankCeiling` to consult `exceedsTargetRankCeiling` /
`targetMaxRankAcrossScopes` (`src/auth/capability.ts`) — the target's standing across
*every* scope, via the same `resolveCapabilities` query every capability check already
runs — and applied that uniformly to all three pre-existing call sites in
`src/members/index.ts` (suspend/reactivate, token mint, capability grant). The grant
route's own test fixture (`makeGrantRouteEnv` in `tests/members-capability-service.test.ts`)
mocked only the OLD, narrower query shape; the new `.all()` query fell through to the
mock's own `throw new Error('unexpected all query: …')`, so the route 500'd instead of
returning 201. `tests/members-sensitive-response.test.ts`'s sibling mock had already been
updated for this shape in round 2 — this one fixture was missed.

### Fix (not just patching the mock blind)

- `makeGrantRouteEnv` now declares the new `resolveCapabilities` query shape (identical
  pattern to the already-fixed stub in `tests/members-sensitive-response.test.ts`) and
  accepts an explicit `{ role, targetGrants }` override instead of always assuming an
  org-owner actor and org-scope target grants.
- Added a **positive** test proving the grant route's ceiling is actually consulted, not
  merely mocked without throwing: an org-admin actor (rank 4, no fine-grained
  capabilities) attempts to grant a capability to a target who holds nothing on the `org`
  scope being acted on but holds `owner` (rank 5) on an unrelated squad — refused, `403
  cannot_affect_higher_rank`.
- Audited the other two pre-existing call sites (`tests/members-agent-capability-route.test.ts`)
  and found neither had ANY test that could distinguish the round-2 across-all-scopes
  widening from the pre-#1411 per-scope-only check — every existing fixture in that
  describe block granted the target exactly one scope, so the narrow and broad queries
  agreed on every case tested. Added one cross-scope regression test per call site
  (a new `member-squad-owner` fixture member holding `owner` on `squad-target` only,
  nothing on `org`; the acting `member-admin` is an org admin with no standing on
  `squad-target`):
  - `PATCH /members/:id` (suspend) — refused, `403 cannot_affect_higher_rank`, member
    stays `active`.
  - `POST /members/:id/tokens` (mint) — refused, `403 cannot_affect_higher_rank`, zero
    `member_tokens` rows minted.
- Grepped the whole test tree for other query-shape mocks that could see the new query
  (`grep -rn "unexpected all query\|unexpected first query" tests/`): the only other hit,
  `tests/flight-routes.test.ts`, already matches broadly on `sql.includes('FROM
  capabilities')` and needed no change.

### Mutation proof (all 3 new tests, executed for real)

`src/members/index.ts`'s `targetRankCeiling` was temporarily reverted in place to the
pre-#1411 per-scope-only shape (query `resolveCapabilities`, filter to the exact
`(scopeType, scopeId)` the route acts on, drop `exceedsTargetRankCeiling` entirely), then
restored from a backup copy (`git diff --stat` empty afterward, confirmed):

| Test | Result under the per-scope revert |
| --- | --- |
| grant route — "refuses an org admin granting a capability to a member who outranks them via a DIFFERENT scope" | RED — 201 instead of 403 |
| suspend — "refuses an admin SUSPENDING a member who outranks them via a DIFFERENT, unrelated squad" | RED — 200 instead of 403 |
| token mint — "refuses an admin MINTING A TOKEN for a member who outranks them via a DIFFERENT, unrelated squad" | RED — 201 instead of 403 |

All other tests in both files stayed green under the same revert, confirming they only
ever exercised the same-scope case and could not have caught this regression.

### Verification

- `npm run typecheck`: clean (`tsc --noEmit` exit 0).
- Focused (`tests/members-capability-service.test.ts tests/telegram-project-onboarding.test.ts
  tests/members-sensitive-response.test.ts tests/members-agent-capability-route.test.ts`):
  exit 0, **4 files, 118/118**.
- **Full suite (`npm test`, all 512 files, default worker parallelism, run once,
  uncontended host): exit 0, 512 files, 8058 tests, 0 failed.** This is the first
  complete (non-chunked) full-suite run recorded on this branch. It reconciles exactly
  with CI's 8054-passed/1-failed count at `fbf85528`: 8054 + 1 (the fixed test) + 3 (the
  new tests above) = 8058.

## Round 4 — Kasra adversarial re-gate + Athena addendum (2026-09-15)

Kasra adversarial re-gate on head `a832f84d` (round 3's final head): **BLOCK** (CI
16/16, 14/16 mutations killed, P0 still open on one plane). Athena's parallel gate added
5 more items (N1-N5) before this round pushed. All items addressed below, one commit per
logical group: `b00a4764` (code + first tests), `bd7172e1` (N1 test), `23b5c0bc` (P1-A
SELECT-fence-specific test).

### P0-A (BLOCK) — the role plane, not just grant rows

`targetMaxRankAcrossScopes` (`src/auth/capability.ts`) maxed only over
`resolveCapabilities`'s GRANT ROWS. `actorRankOnScopeFor` floors the ACTOR on BOTH
`auth.role` and grants — an asymmetry: the org owner "characteristically holds zero
capability rows" (`src/auth/index.ts:917-923`), so the OLD ceiling measured the owner's
standing as 0. Executed by the reviewer: org admin invites `member_id` = bootstrap owner
→ MINTED; redeemed; owner row `telegram_chat_id = ATTACKER-TG-99`; `PATCH
.../status=suspended` on the owner → **200** (the exact #1337 lockout).

Fix: new `targetLegacyRoleRank(env, targetMemberId)` — reads `members.email` for the
target, then `users.role` for that email (the SAME email-is-the-dedup-key bridge
`upsertUserByEmail` in `src/auth/index.ts` already uses to keep one human's `users` row
and `members` row in sync — `members` carries no `role` column at all). No email, or an
email matching no `users` row, resolves to 0 — the safe default, never an escalation.
Folded into `targetMaxRankAcrossScopes` itself (the ONE helper), so all 4 call sites
inherit it: suspend/reactivate, token mint, capability grant (`src/members/index.ts`),
and the member-bind invite (`src/members/project-invites.ts`).

Tests (`tests/members-agent-capability-route.test.ts`, new `BOOTSTRAP_OWNER_MEMBER`
fixture — a members row + a `users` row sharing its email, role='owner', **zero**
capability rows):
- suspend → 403, member stays active
- token mint → 403, zero `member_tokens` rows
- capability grant/revoke → 403, no row change
- a member with NO email bridges to nothing (rank 0), never treated as elevated — proves
  absence-of-bridge is the safe default, not a separate escalation path

Takeover-probe re-run (`tests/telegram-project-onboarding.test.ts`, `describe
createProjectInvite — member_id`): org admin mints a `member_id` invite for the same
bootstrap-owner shape → `{ ok: false, error: 'forbidden' }`, zero invite rows created.

Mutation: commented out the `targetLegacyRoleRank` fold line in
`targetMaxRankAcrossScopes` → **RED** on all 3 new route tests + the takeover-probe re-run
(4 tests total). Restored (`git diff --stat` empty before continuing).

### N2 (Athena, BLOCK) — actor/target symmetry + self-exemption

`exceedsTargetRankCeiling`'s `actorRank` parameter was always a SCOPE-LOCAL number
(`actorMaxRankOnScope(c, scopeType, scopeId)`) compared against a GLOBAL target rank —
two different quantities. Athena's repro: actor = org admin (rank 4 on the `org` scope)
who ALSO holds `owner` on one unrelated squad (real global standing 5) → self-mint
(target = self) → **403**, a principal measured as unable to outrank himself. Same class
on suspend/reactivate, capability grant, member-bind invite, and the new unbind route.

Fix: new `actorMaxRankAcrossScopes(env, auth)` — the actor's standing on the SAME global
quantity `targetMaxRankAcrossScopes` computes for the target (role-plane rank, unioned
with the max grant rank across every scope). Sources grants from `auth.capabilities ??
resolveCapabilities(...)` — the SAME precedence `actorRankOnScopeFor` already uses —
rather than an unconditional DB requery, because a directory-channel session has
`auth.capabilities` deliberately zeroed to `[]` by the B1 ambient-authority ceiling; a raw
DB query here would silently reinstate exactly the ambient authority that ceiling exists
to close. `exceedsTargetRankCeiling`'s signature changed to `(env, auth, targetMemberId)`
and is now explicitly self-exempt (`auth.memberId === targetMemberId` → never exceeds),
independent of the comparison. `targetRankCeiling` (`src/members/index.ts`) no longer
takes a scope at all — the ceiling question is scope-independent by construction now.

Tests:
- `tests/members-agent-capability-route.test.ts` — a member holding org-admin (grant,
  rank 4) AND squad-owner-elsewhere (grant, rank 5) self-suspends, self-mints, and
  self-grants — all succeed (200/201), proving the actor/target symmetry fix (this
  fixture's `auth.capabilities` already matches the DB rows, so it isolates the
  local-vs-global fix from the self-exempt fix below).
- `tests/telegram-project-onboarding.test.ts` — `ownerAuth`'s OWN `capabilities` field
  is fixed at describe-setup time to org-admin only; a NEW squad-owner grant is inserted
  directly into the DB afterward (simulating a session whose `auth.capabilities` has gone
  stale relative to the DB) and `ownerAuth` member-binds `member_id` = itself → succeeds.
  This is the case that isolates self-exemption specifically: without it, actor (session-
  cached, rank 4) vs target (fresh DB read, rank 5) would disagree even though they are
  the same principal.

Mutation: (a) commented out the self-exempt line — **RED** on the telegram-onboarding
self-bind test (members-agent-capability-route's self test stayed green, because its
fixture has actor/target always computed identically — an honest, reported non-kill for
THAT specific test, not a gap in the self-exempt line's coverage overall). (b) reverted
`actorMaxRankAcrossScopes` to always call `resolveCapabilities` (dropping the
`auth.capabilities ??` precedence) — **RED** on the pre-existing `P0-1c` test (an org
owner acting via `auth.capabilities` alone, no matching DB rows), confirming the
B1-ceiling-respecting precedence is independently load-bearing. Both restored.

### N1 (Athena) — token mint's own pre-existing tenant gap

`POST /members/:id/tokens`' member lookup (`src/members/index.ts`) was `WHERE id = ?`
alone — the same #1330 F2 class the suspend route next to it, and this round's own unbind
route, both needed fencing. Fixed with the identical tenant-collapse predicate (exact
match OR legacy NULL-tenant row) used elsewhere in this file; no tenant-adoption write
needed since this handler never updates the `members` row itself.

Test: tenant-A admin mints a token for a tenant-B member → `404 member_not_found`, zero
`member_tokens` rows. Mutation: dropped the tenant conjunct → **RED** (201 instead of
404).

### P1-A — unbind's tenant gap (two independent fences)

`DELETE /members/:id/telegram`'s SELECT and its clearing UPDATE were both `WHERE id = ?`
alone. Fixed both: the SELECT with the standard tenant-collapse predicate; the UPDATE
with tenant-collapse-and-adopt PLUS a `telegram_chat_id = ?` TOCTOU conjunct pinning it to
the exact identity the handler just read (same discipline as this feature's own
`MEMBER_BIND_LANDED_GUARD_SQL`).

Tests + a mutation surprise worth recording: a tenant-B target with Telegram BOUND
(`telegram_chat_id` set) returns `member_not_found` — but mutating away the SELECT's OWN
tenant fence left that test GREEN, because the UPDATE's independent tenant fence still
converts the request to a 0-row update → the same `member_not_found` response via a
different path. Added a SECOND, distinguishing test: a tenant-B target with NO Telegram
bound (`telegram_chat_id IS NULL`). Under the same SELECT-fence-removed mutation, this one
goes RED — the mutated SELECT finds the tenant-B row by id alone and answers
`telegram_not_bound` instead of `member_not_found`, the cross-tenant EXISTENCE ORACLE the
fence exists to prevent. Both mutations (SELECT alone; the combined SELECT+UPDATE) are
now correctly killed by at least one test.

### P2-B/C — unbind receipt + the M8 mutation survivor

No route/tool/table anywhere recorded an unbind (grepped `INSERT INTO
telegram_unbind_receipts`, `INSERT INTO connector_audit`, `dashboard/audit.ts`'s
`loadAudit` sources — none read or wrote anything for this action; the mint/revoke paths
in this same file write no receipt row either, confirmed by reading `mintMemberToken`/
`revokeMemberToken` in `src/members/service.ts`, so there was no existing writer to reuse
verbatim). New append-only `telegram_unbind_receipts` table added to migration 0154
(still unshipped — additive `CREATE TABLE IF NOT EXISTS`, no rebuild), following this
codebase's own per-action-class receipt-table convention (`oauth_consent_receipts` 0091,
`gate_owner_reassignments` 0113, `verdict_reversals` 0118). Written only once the clearing
UPDATE is proven (by its own row-count check) to have landed against the exact prior
identity — never a phantom receipt for a no-op.

M8: the ONLY pre-existing negative test for this route's `requireCapability(orgScope,
'admin')` gate used a SQUAD-scope non-admin — an org-scope `admin` → `observer` mutation
at that exact line left the whole suite green. Added the missing ORG-SCOPE observer
negative test.

Tests + mutations: (a) removed the receipt INSERT entirely → RED (the receipt-exists
assertion fails, `undefined` instead of a row). (b) mutated the route's own capability
floor from `'admin'` to `'observer'` → RED on the new M8 test (200 instead of 403).

### P2-D (Athena) — enumeration oracle via check ordering

`createProjectInvite`'s coarse "does the actor hold admin standing at ALL" check ran
AFTER the member lookup, so a zero-standing caller got a DIFFERENT error per target
(`member_not_found` / `member_not_active` / `member_missing_email`) — an enumeration
oracle reachable by anyone, admin or not. Neither `edge` (squad/department, resolved
earlier) nor the actor-rank computation depends on the target member row, so the check
moved above the lookup with no other reordering needed.

Test: one zero-standing actor (`squadOnlyAdminAuth`, no org-scope standing) against FOUR
target shapes — nonexistent, active, suspended, no-email — all four now return the
IDENTICAL `{ ok: false, error: 'forbidden' }`, and zero invite rows exist for any of them.
Mutation: disabled the early actor-rank gate (falls through to the member lookup first,
as before the fix) → RED — the four calls diverge (`forbidden` / `forbidden` /
`member_not_found` / `cannot_grant_above_own_rank` / `member_missing_email` depending on
target), exactly the oracle the fix closes.

### P2-E — capability upgrade at redemption, not a permanent brick

Round 2's P2-3 ("any pre-existing grant on the invited squad throws a UNIQUE violation,
rolling the whole claim back to a permanent, unrecoverable `redemption_failed`") was left
explicitly NOT FIXED. On the bind-EXISTING-member path this is the MOST common shape — the
whole point is usually adding Telegram to someone who already works on that squad. Fixed
with `INSERT … ON CONFLICT (member_id, scope_type, scope_id) DO UPDATE SET capability =
<higher of existing vs invited, via a RANK_SQL_CASE ladder matching capability.ts's own
RANK> ` — never downgrades (an existing `admin` redeeming an `observer` invite keeps
`admin`), never exceeds the invite's own capability (already capped at mint time to `<=`
the minter's rank via the pre-existing `cannot_grant_above_own_rank` check, so this can
never smuggle a grant past the minter's ceiling). When the guarding `WHERE EXISTS(...)`
is false (a failed claim), zero source rows means the INSERT never fires and `ON CONFLICT`
never triggers — a failed claim touches no pre-existing row.

Tests: (a) existing `observer` grant on the invited squad, invite for `member` → upgraded
to `member`, exactly ONE row (not a second row, not thrown away). (b) existing `admin`
grant, invite for `observer` → KEPT at `admin`, never downgraded.

Mutations: (a) reverted to a bare INSERT (no `ON CONFLICT`) → RED on both tests (`ok:
false`, `redemption_failed`). (b) kept `ON CONFLICT` but replaced the CASE with an
unconditional `capability = excluded.capability` (would silently downgrade) → RED on both
— a bind-param-count mismatch this time (compile-broken mutation, not a semantic
survivor: the `?` in the CASE's comparison is now unused, so the extra
`capabilityRank(invite.capability)` bind value has no matching placeholder) — still an
honest kill, confirmed via the exact `column index out of range` error, not a silently
wrong pass.

### N4 (Athena) — creation must not mint a permanently dead invite

Creation's member lookup (`project-invites.ts`) collapsed a NULL-tenant target the SAME
way `GET /members/:id` does (`tenant = ? OR tenant IS NULL`) — right for a READ, wrong
here: redemption's `MEMBER_BIND_ELIGIBLE_SQL` requires an EXACT, non-NULL tenant match,
so a NULL-tenant target passed creation, minted a real invite, and could NEVER be
redeemed — a silent, permanent dead invite indistinguishable from any other expired code.
Creation now uses the SAME exact-match predicate the eligibility fence enforces; a
NULL-tenant target now refuses immediately with `member_not_found` (still not a
cross-tenant oracle — a NULL-tenant row and a genuinely nonexistent one resolve to the
identical refusal).

Test: NULL-tenant target → creation itself refuses (`member_not_found`), zero invite rows
minted (replaces the round-2 test that asserted creation SUCCEEDED and only redemption
failed — that assertion described exactly the bug N4 closes). Mutation: reverted to the
collapse-shaped predicate → RED (creation now succeeds, minting the dead invite again).

### N5 (Athena, Low) — parameter order, not just SQL text

The existing seam test (`CLAIM_INVITE_SQL`/`MEMBER_BIND_UPDATE_SQL` both `.toContain(
MEMBER_BIND_ELIGIBLE_SQL)`) proves identical SQL TEXT, not that both call sites bind the
SAME VALUES in the SAME ORDER into that text's 3 placeholders — a transposed bind at only
one site would still pass. Added a behavioral test: spies on both statements' real
`.bind()` calls during one genuine redemption (a thin wrapper around `env.DB.prepare` that
records the bound values for the two target SQL strings, then delegates to the real
statement) and asserts the exact 3-tuple `(id, tenant, telegram)` each site binds,
including that they agree with EACH OTHER, not merely with the fixture.

### Runbook + docs

- `docs/operations/telegram-project-onboarding.md`: "Who may target whom" rewritten for
  the global-standing + self-exempt semantics, with the operator-visible consequence
  called out explicitly — a member outranking an org admin via even ONE unrelated squad
  is untouchable by every org admin across all 5 gated actions (suspend, mint, grant,
  member-bind invite, unbind); only an owner (or an equal-or-higher grant holder) can act
  on them. "Undoing a bind" updated for the tenant fence and the new receipt table.
- `docs/architecture/human-decision-channel-contract.md` (N3, Athena, BLOCK for merge):
  this file was added to `main` at `bebed97e` — AFTER this branch (`kasra/telegram-bind-
  existing-member-20260914`, base `main`, forked earlier) — so it does not exist in this
  branch's own history to diff against. Added here with clause (g)'s "Net-new humans
  only" gap rewritten as CLOSED (member-bind invite + unbind, with the authority floor
  described) and clause (a)'s `CLAIM_INVITE_SQL` citations corrected to its current range
  (`:315-349`, moved since the doc's original citation) plus both invite-creation rank
  paths named (`actorRankOnSquad` net-new vs `actorRankOnScopeFor(org)` +
  `exceedsTargetRankCeiling` member-bind). **This WILL need reconciling at merge time** —
  main's copy of this file has no shared history with this branch's copy, so a merge will
  see it as two independent adds of the same path. Flagging explicitly rather than
  silently hoping git's 3-way merge resolves it cleanly (it should not — an add/add
  conflict is the expected, correct outcome for a human/kasra-git to reconcile, not a bug
  in this branch).

### Verification

- `npm run typecheck`: clean (`tsc --noEmit` exit 0), rerun after every code change in
  this round.
- Focused suites rerun clean after all fixes: `tests/members-capability-service.test.ts`,
  `tests/members-sensitive-response.test.ts`, `tests/telegram-project-onboarding.test.ts`
  (96/96), `tests/members-agent-capability-route.test.ts` (24/24), plus
  `tests/squad-member-tools.test.ts`, `tests/agent-self-update.test.ts`,
  `tests/flight-routes.test.ts`, `tests/members-capability-sqlite.test.ts`,
  `tests/org-admin-capability-gate.test.ts`, `tests/surface-caps.test.ts` — 10 files,
  335/335 combined. **A5 correction (Athena final-gate, round 5, 2026-09-15): this count
  was undercounted — a re-tally of the same 10 files at this round's head is 337, not
  335. Left as originally written above rather than silently edited; this note is the
  honest correction, not a rewrite of what round 4 actually claimed.**
- All 8 local CI-parity scripts green: `check-schema-chain-fresh`,
  `check-migration-numbering` (0154 still sorts above `origin/main` head 0153),
  `check-test-schema-source` (26/127 baselines unchanged — no new mock-DB files, only
  existing stubs updated for the new `SELECT email FROM members` / `SELECT role FROM
  users` queries `targetLegacyRoleRank` introduces), `check-mcp-tool-seam`,
  `check-operator-counts-source`, `check-branch-staleness`, `release-truth-policy` (4
  docs scanned), `no-secrets`.
- Mutation table (**A5 correction, Athena final-gate round 5, 2026-09-15: the table below
  has 12 rows (M1-M4b, M6-M12 — M5 was never assigned; the "14 mutations" claim in this
  bullet was wrong and is left as originally written, corrected here rather than
  silently edited), all executed for real** via `sed`/`python3` source
  mutation → rerun the specific test(s) → confirm RED → `git checkout --` restore →
  confirm `git diff --stat` empty before the next mutation):

| # | Item | Mutation | Result |
| --- | --- | --- | --- |
| M1 | P0-A | drop `targetLegacyRoleRank` fold in `targetMaxRankAcrossScopes` | RED (4 tests) |
| M2 | N2 self-exempt | drop the `auth.memberId === targetMemberId` line | RED (telegram self-bind test); honest non-kill on the DB-synced self-fixture (documented as an isolating pair, not a gap). **A5 correction: this row's proof supports ONLY the self-exemption, which survived round 5 unchanged — it does NOT validate the "both sides global" comparison this same round introduced, which round 5's A1 found to be the escalation (see round 5 section below). The self-exemption's real regression proof going forward is round 5's own A1 test set (`members-agent-capability-route.test.ts`, `A1 —` tests), not this row.** |
| M3 | N2 precedence | `actorMaxRankAcrossScopes` always calls `resolveCapabilities` (drops `auth.capabilities ??`) | RED (P0-1c) |
| M4a | P1-A SELECT | drop unbind SELECT's tenant conjunct | GREEN on the bound-target test (UPDATE's own fence covers it) — reported, not hidden |
| M4b | P1-A SELECT | same mutation, unbound-target test | RED (existence oracle) |
| M6 | P2-B/C receipt | remove the receipt INSERT | RED |
| M7 | P2-B/C / M8 | `requireCapability(orgScope,'admin')` → `'observer'` on unbind | RED |
| M8(N1) | N1 | drop token-mint SELECT's tenant conjunct | RED |
| M9 | P2-D | disable the early actor-rank gate | RED |
| M10 | P2-E | revert `ON CONFLICT` to bare INSERT | RED (both tests) |
| M11 | P2-E | keep `ON CONFLICT`, force unconditional overwrite | RED (compile-broken: bind-count mismatch, still a kill) |
| M12 | N4 | revert to the NULL-tenant collapse predicate | RED |

Killed-by: M1 → `members-agent-capability-route.test.ts` (3 new P0-A tests) +
`telegram-project-onboarding.test.ts` (`P0-A` takeover-probe re-run). M2 →
`telegram-project-onboarding.test.ts` (`N2` self-bind-via-stale-session test). M3 →
`telegram-project-onboarding.test.ts` (`P0-1c`, pre-existing). M4a/M4b →
`members-agent-capability-route.test.ts` (`P1-A` — the SELECT-fence-specific variant).
M6/M7 → `members-agent-capability-route.test.ts` (`P2-B/C` receipt test; `M8` observer
test). M8(N1) → `members-agent-capability-route.test.ts` (`N1` test). M9 →
`telegram-project-onboarding.test.ts` (`P2-D` test). M10/M11 →
`telegram-project-onboarding.test.ts` (both `P2-E` tests). M12 →
`telegram-project-onboarding.test.ts` (`N4` test).

- **Full suite (`npm test`, all files, default worker parallelism, run once, host load
  average ~1.2-2.4 at start): exit 0, 512 files, 8075 tests, 0 failed, 469s wall time. Reconciles exactly with round 3's 8058 + 17 new tests this round (6 in telegram-project-onboarding.test.ts, 11 in members-agent-capability-route.test.ts).**

## Round 5 (Athena final-gate BLOCK on head `35aeefef` + kasra-review adversarial addendum, 2026-09-15)

Athena's final-gate comment on the PR found A1 and A2 as NEW P0s (round 4's own fix
direction on A1 was itself wrong); a parallel kasra-review adversarial pass on the same
head (`35aeefef`) found five more items (two P1s, two P2s, one M2/M12 survivor pair) that
were folded in before push per this round's brief.

### A1 (P0) — round 4's actor-side globalisation was itself the escalation

`exceedsTargetRankCeiling`'s actor side was `actorMaxRankAcrossScopes(env, auth)` —
maxed over EVERY scope the actor holds a grant on, violating `capability.ts`'s own stated
invariant ("grants never bubble UP"; an org grant bubbles DOWN to cover every squad, but a
squad grant never bubbles UP to satisfy an org-scope check). Reproduced against round 4's
code: an org admin (org-scope rank 4) who ALSO held `owner` on one unrelated squad —

- minted a token AS the (unrelated) org owner: **201** (should refuse)
- suspended the owner: **200** (should refuse)
- revoked the owner's org capability row: **200, `removed:1`** (should refuse)

Fix: actor side reverted to `actorRankOnScopeFor(env, auth, 'org', null)` — org-scope-local,
matching what every one of the five call sites already proves before reaching this ceiling
(all five are `requireCapability(orgScope, 'admin')`-gated, or the member-bind invite path's
own equivalent check). The self-exemption (`auth.memberId === targetMemberId` → not
exceeded) is untouched — it alone closes round 4's self-action-lockout finding (N2), and
does not depend on which quantity either side computes. `actorMaxRankAcrossScopes` deleted;
grepped for any other caller — none.

New tests (`members-agent-capability-route.test.ts`, describe block
`POST /members/:id/capabilities — target-rank ceiling (#1337)`): an actor with org-scope
`admin` AND squad-scope `owner` on an unrelated squad, acting on the REAL org owner (a
DIFFERENT member, not themselves) —
- `A1 — refuses this actor SUSPENDING the real org owner` (was 200)
- `A1 — refuses this actor MINTING A TOKEN for the real org owner` (was 201)
- `A1 — refuses this actor REVOKING the real org owner's org capability row` (was 200 removed:1)

Mutation (executed for real): replaced the actor-side call with `Promise.resolve(5)`
(simulating the round-4 inflation) → all three A1 tests RED with the exact round-4 symptom
status codes (200/201/200); the pre-existing `N2` self-target test stayed GREEN under the
same mutation, confirming the self-exemption path is independent of this change. Restored,
confirmed `git diff --stat` empty, reran green.

### A2 (P0) — `targetLegacyRoleRank`'s email bridge compared exact case

`members.email → users.email` used exact-case comparison on both hops; every OTHER email
bridge in this codebase (`auth/index.ts:1285`, `sso.ts:114`,
`resolve-human-member.ts:158,169`, migration 0146) is `lower()`. A `members.email` stored
with different casing than its `users.email` counterpart bridged to NOTHING, silently
returning legacy rank 0 — an org admin could suspend/mint-for/grant-on a target whose real
role-plane rank (via a differently-cased email) was actually `owner`.

Fix: `SELECT lower(email) AS email FROM members ...` on the first hop,
`SELECT role FROM users WHERE lower(email) = ?1` on the second — either hop being
differently-cased now bridges correctly.

New tests: `A2 — refuses an admin SUSPENDING a member whose members.email differs only in
CASE from users.email` and the equivalent MINTING test, using
`members.email = 'Bootstrap-Owner@Example.Test'` against `users.email =
'bootstrap-owner@example.test'` (legacy rank 5, org owner).

Mutation: reverted both `lower()` calls → both new tests RED (200/201 instead of 403).
Restored, confirmed clean, reran green.

Collateral: two OTHER test files stub this exact query by SQL-substring match
(`members-capability-service.test.ts`, `members-sensitive-response.test.ts`) —
`sql.includes('SELECT email FROM members')` no longer matched the new `lower(email)` SQL
text; updated both stubs to `sql.includes('FROM members') && sql.includes('lower(email)')`.

### A8 — unbind clearing UPDATE + receipt INSERT were non-atomic

Two separate `.run()` calls; a receipt-side failure (or a crash between the two) left the
Telegram binding cleared with no durable trace of who did it. Now one atomic `DB.batch()`,
with the receipt INSERT as `INSERT ... SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE changes() = 1` —
the same cross-statement idiom this codebase already uses in migrations
0071/0134/0135's triggers and `flight-spine/receipts.ts`'s own atomic-audit guard — so a
TOCTOU-raced 0-row UPDATE (the pre-existing `telegram_chat_id = ?3` conjunct) never writes a
receipt for a clearing that never happened. The batch result is asserted with
`assertWritten` (already imported for `assertBatchWritten` elsewhere in this file).

New test: `A8 — a failed receipt write leaves the binding intact (clearing UPDATE + receipt
INSERT are atomic)` — mocks `crypto.randomUUID()` to a fixed value, pre-inserts a receipt
row with that same id (forcing a real PRIMARY KEY violation on the conditional INSERT), and
asserts the clearing UPDATE did NOT survive (row unchanged) — proving atomicity, not merely
that a successful unbind writes a receipt (which a separate, pre-existing test already
covered).

Mutation: reverted to two separate `.run()` calls (receipt INSERT unconditional VALUES,
after the UPDATE) → the new test went RED — `telegram_chat_id` was `null` (the UPDATE had
landed) despite the receipt INSERT throwing on the forced PK collision, reproducing exactly
the phantom-success class this fix closes. Restored, confirmed clean, reran green.

### kasra-review adversarial addendum on head `35aeefef` (parallel pass, folded in before push)

- **P1 — `POST /members/:id/capabilities`'s member lookup unscoped by tenant.** Same
  `#1330` F2 class already closed on suspend/mint/unbind in this file — `SELECT id FROM
  members WHERE id = ?` alone let a tenant-A admin grant/revoke a capability on a tenant-B
  member. Fenced with the identical `(tenant = ?2 OR tenant IS NULL)` predicate. New test:
  `P1 round 5 — refuses (member_not_found) a tenant-A admin GRANTING a capability on a
  tenant-B member`. Mutation: reverted the fence → RED (201 instead of 404). Restored,
  confirmed clean.
- **P1 — `telegram_unbind_receipts` claimed append-only, carried no trigger.** The
  migration's own comment cited `oauth_consent_receipts`' (0091) append-only precedent but
  never added the matching `BEFORE UPDATE`/`BEFORE DELETE` `RAISE(ABORT)` trigger pair — a
  forged `actor_id` UPDATE or an outright DELETE both silently succeeded against the schema
  as it actually shipped. Added directly to migration 0154 (still unshipped anywhere).
  New file `tests/telegram-unbind-receipts-immutable.test.ts` (3 tests: accepts an insert,
  refuses an UPDATE, refuses a DELETE) run against the REAL migration chain
  (`applyAllMigrations`), same pattern as `gate-owner-reassign-immutable.test.ts`.
- **M12 — the clearing UPDATE's own tenant fence was untested independently of the
  SELECT's.** Every existing cross-tenant test reached the UPDATE only via a SELECT that
  already filtered the row out, so a mutation removing JUST the UPDATE's own tenant
  conjunct was never independently exercised. New test stubs ONLY the SELECT statement (by
  exact SQL-text match) to return a fabricated fence-bypassed row for a real tenant-B
  target, while every other statement — including the real UPDATE and INSERT, inside the
  real `DB.batch()` — runs against the actual sqlite database; asserts the real row
  survives untouched. This is a genuine defense-in-depth proof, not merely duplicated
  coverage of the SELECT's own fence (which has its own separate test).
- **P2 — self-unbind.** A member-bind invite attaches Telegram to an existing member
  without their say; until this round they had no way to detach it themselves without an
  org admin. `requireAdminOrSelfForTelegramUnbind` now lets `DELETE /members/:id/telegram`
  pass with NO capability check when the caller targets themselves, falling back to the
  existing admin + ceiling path otherwise. Framed honestly in the runbook as both a remedy
  for the bind victim and, in an admin's hands, still the same takeover-enabler the admin
  envelope already covers — nothing widens what an admin can do. Two new tests (self-unbind
  succeeds with zero capabilities; a non-admin still cannot unbind SOMEONE ELSE). Mutation:
  reverted the self branch to always fall through to `requireCapability` → the self-unbind
  test went RED (403 instead of 200). Restored, confirmed clean.
- **P2 — invite capability cannot outlive the minter's authority.** `invites` gained an
  additive `minted_by_member_id` column (0154); `createProjectInvite` stores
  `auth.memberId ?? null`. At redemption, a new `currentMemberOrgRank` helper re-derives the
  minter's CURRENT org-scope standing fresh from D1 (the SAME quantity
  `actorRankOnScopeFor` computes for a live session) and refuses
  (`invite_minter_authority_lost`, collapsed into the existing generic chat reply) when it
  no longer covers the invite's capability, or the minter is no longer active. Only runs
  when `minted_by_member_id` is non-NULL — a pure legacy web-login minter's role-plane rank
  is immutable in this schema (no route ever changes `users.role`), so there is nothing to
  re-check for them, and no regression versus before this column existed. Two new tests
  (demoted minter refused, suspended minter refused) plus a no-regression test (minter
  retains authority → redemption still succeeds). Mutation: removed the check entirely →
  both authority-loss tests went RED (`ok: true` instead of the refusal). Restored,
  confirmed clean.
  - **Collateral fixture gap found and fixed:** the "bind existing member" describe block
    fed the creating actor's org-admin standing directly as `auth.capabilities` (simulating
    an already-resolved session) with NO matching row in the `capabilities` table —
    harmless before anything read it back from the database, but this round's redemption
    check does exactly that. One line added to the shared `beforeEach` (a real
    `capabilities` row for `member-bind-owner`) recovered all 12 tests in that describe
    block that had gone red from this collateral effect.
  - **Second collateral gap, found only by running the FULL suite (not caught by any
    focused suite):** `tests/im-webhook-idempotency.test.ts`'s `invite()` fixture used a
    synthetic `auth.memberId` (`'inviter-member'`) with NO backing `members` row — the new
    `minted_by_member_id` column `REFERENCES members(id)`, so this threw a real FOREIGN KEY
    constraint violation. Fixed by inserting the member row (matching every real inviter,
    which never has a memberId without a backing row) and narrowing one broad
    `SELECT ... FROM members` assertion (which expected exactly one row) to exclude the new
    fixture row.

### A5 corrections to round 4's evidence

Applied as inline annotations in the round-4 section above rather than silent edits:
round 4's "335/335 combined" focused-suite count corrected to 337; the mutation table's
"14 mutations" bullet corrected — the table has 12 rows (M1-M4b, M6-M12; M5 was never
assigned); the `N2` row's proof note corrected — it supports only the self-exemption
(which survived round 5 unchanged), not the actor-globalisation round 5's A1 found wrong.

### Verification

- `npm run typecheck`: clean, rerun after every code change this round.
- The same 10 files round 4 tracked, plus the new receipts-immutability file — 11 files,
  **353/353 combined** (337 round-4 baseline, corrected, + 16 new this round):
  `members-agent-capability-route.test.ts` (34/34, up from 24 — 10 new: 3×A1, 2×A2,
  1×P1-tenant-fence, 1×M12, 1×A8, 2×self-unbind), `telegram-project-onboarding.test.ts`
  (99/99, up from 96 — 3 new: 2×minter-authority-loss, 1×no-regression),
  `tests/telegram-unbind-receipts-immutable.test.ts` (new file, 3/3),
  `members-capability-service.test.ts`, `members-sensitive-response.test.ts`,
  `squad-member-tools.test.ts`, `agent-self-update.test.ts`, `flight-routes.test.ts`,
  `members-capability-sqlite.test.ts`, `org-admin-capability-gate.test.ts`,
  `surface-caps.test.ts`.
- **Separately** (not part of the 353 above — a different file, touched only for a
  fixture-schema regression, not new coverage for this round's own items):
  `tests/im-webhook-idempotency.test.ts` — 29/29, same count as before this round; fixed a
  FOREIGN KEY violation the new `minted_by_member_id` column exposed in its fixture (see
  "Second collateral gap" above).

- **Full suite (`npm test`, all files, default worker parallelism, run once, after the
  im-webhook-idempotency fixture fix above): exit 0, 513 files, 8091 tests, 0 failed,
  551s wall time.** (The FIRST full run at this round's head, before that fix, was 512
  files / 8091 total-attempted / 6 failed / 8085 passed — the exact im-webhook-idempotency
  FK violation described above; not fabricated into a clean number, the failing run is
  the reason the fixture fix exists.) Reconciles with round 4's 8075 + this round's new
  tests: +16 in the 11-file focused set above, +0 net in im-webhook-idempotency.test.ts
  (fixture-only change, no new test cases), for a net of 8075 + 16 = 8091, and one
  additional test FILE (`telegram-unbind-receipts-immutable.test.ts`) bringing the file
  count from 512 to 513.
