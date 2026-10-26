# PR #2217: consent continuity review fixes

## Grant replacement

`upsertHarness` revokes pending and live harness-scoped admissions before changing
its grant anchor, in one D1 batch (`src/members/harness.ts:135`). The invalidation
checks the previous grant, tenant, human and harness, so a losing compare-and-set
cannot revoke a concurrent winner's fresh approval. Repeating the same grant does
not revoke approval. Seat-scoped admissions and other harnesses are unchanged.

This uses existing revocation transitions and cascades: admission history remains,
attachments detach, attachment tokens and dot keys are revoked, and an old pending
passkey link cannot approve the replacement consent. Failure to move the harness
rolls the entire batch back. The replacement consent must obtain a fresh approval.
No migration is introduced or migration number reserved.

## Other authorization boundaries

- `src/members/seat-attach.ts:333`: every reuse path, including dashboard and the
  original asking seat, requires grant proof for a harness admission.
- `src/members/seat-attach.ts:526`: passkey promotion captures the OAuth grant
  identity and passes it to the guarded INSERT. Every caller must supply a grant
  value; null fails closed for harness scope.
- `src/members/attach-designated.ts:44`: the original asking seat cannot bypass
  harness grant liveness.
- `tests/seat-attach-grant-thread-select.test.ts`: a direct `writeVerdict` regression
  bypasses the request pre-check, forces the admission gate bit on, and proves the
  write guard refuses a reused thread. Its positive control proves the same write
  succeeds for the original approved seat under the existing exception.
- `src/mcp/events-attached.ts:54`: events composes the same joins, liveness and seat
  token fragments as the resolver and verdict guard. Token liveness accepts an
  explicit SQL alias; no alias replacement is needed in these paths.

## Local verification

- Failing first: seven authorization regressions failed on the original source;
  the original 30 R1 tests and the direct verdict guard regression passed.
- R1 suite: 45 passed (the original 30 plus 15 new cases).
- Broader targeted suites: 61 files, 2,078 tests passed (attachment, events,
  verdict, token lifecycle, harness and direct harness callers).
- `npx tsc --noEmit`: passed.
- `npx wrangler deploy --dry-run --outdir .scratch-out`: passed.
- `node --check .scratch-out/index.js`: passed.
- The borrowed `wrangler.toml` was deleted after validation; it is not committed.
- No merge, deployment, production access or live identity assertion was performed.

## Mutation evidence

Each mutation was applied in isolation, run against its named regression in
`tests/seat-attach-grant-thread-select.test.ts` with `--maxWorkers=2`, and restored.
Each failure below was an assertion failure, rather than a startup/SQL error.

| Mutation | Result |
| --- | --- |
| Disable harness admission invalidation | 1 failed; killed |
| Invalidate live approvals only; leave pending approvals open | 1 failed; killed |
| Revoke seat-scoped approvals during re-anchor | 1 failed; killed |
| Remove the old-grant comparison from admission invalidation | 1 failed; killed |
| Skip the pinned grant comparison in the promotion INSERT | 1 failed; killed |
| Limit the missing-grant refusal to the tool path | 2 failed; killed |
| Remove the request-grant comparison from the attach INSERT | 1 failed; killed |
| Allow the original seat to bypass harness grant liveness | 1 failed; killed |
| Remove the requested-seat comparison from the verdict UPDATE | 1 failed; killed |
| Remove seat retirement from the shared liveness fragment | 1 failed; killed |
