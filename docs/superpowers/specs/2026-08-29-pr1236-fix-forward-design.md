# PR #1236 Bounded Fix-Forward Replacement Design

Status: proposed written specification after Hadi approved movement on 2026-08-29.

## Objective

Replace Mupot PR #1236 with a sequential series of bounded pull requests created from the current `origin/main`. Do not merge, extend, or use #1236 as a shared implementation branch. Each replacement slice must be independently understandable, adversarially tested, fully verified, reviewed internally, gated by Athena at its exact head, and receipted by Loom.

The program prepares merge-ready pull requests. Only Hadi may authorize a merge, deployment, credential operation, or production mutation.

## Current evidence boundary

At design freeze:

- `origin/main` is `41330115de7304c95654f57949b41c24761b2e8f`.
- The normal `/home/mumega/mupot` checkout contains unrelated user changes and is not an implementation surface.
- PR #1236 has advanced to `541881c8905163a31f9bc3ce388921c12ca9abc8`, spans 152 files, and still fails required `local-evidence`.
- PR #1237 is a draft MSG-01 repair at `e730e316d6180dabe39c61c853e1a026c545384a`; its task `60c7ac1c-16b6-4aba-b71a-3d88e5be469b` is in review under `gate:athena`.
- SOS is unavailable by direct seat-aware probe. Mupot is authoritative for coordination; the protected Kasra agent-bound token resolves to `c855f82c-1eeb-409d-94d2-f11e9dd18968`.
- Current main fails repository typecheck, `no-secrets`, the test-schema-source ratchet, local D1 evidence, and two WFP tests. The full-suite baseline at the same immutable main SHA is 6,634 passed and 2 failed.
- The late CI commits on #1236 depend on new omnibus features and migrations. They are evidence and donor material only; they cannot be cherry-picked as the clean CI foundation.

The design must be refreshed if `origin/main` changes before a slice branch is created.

## Authority and review roles

### Hadi

- Approves architecture and consequential scope changes.
- Decides whether and when an Athena-GREEN slice is merged.
- Separately authorizes deployment, credential use, or production mutation.

### Loom

- Owns sequence, governing brief/tasks, request IDs, and composition receipts.
- Issues a new slice GO only after the prior slice reaches its required checkpoint.
- Never substitutes a queued request for a delivered/consumed gate receipt.

### Kasra

- Creates the isolated branch and worktree for each authorized slice.
- Implements with test-first development and preserves exact evidence.
- Does not self-gate, merge, deploy, rotate live credentials, or mutate production.

### Lumen

- Performs the mandatory internal review before external gate submission.
- Returns findings to Kasra; Critical and Important findings must be resolved before Athena.

### Athena

- Independently reviews the exact immutable PR head.
- Returns `GREEN`, `BLOCK`, or `RESHAPE` with an Artifact path and SHA256.
- Does not inherit Kasra's review conclusion or self-clear an Athena-authored change.

## Delivery strategy

Use sequential gate-and-land, not a stacked omnibus.

1. A slice starts from freshly fetched `origin/main` after the prior required merge.
2. Kasra implements and verifies in one isolated worktree.
3. The slice opens as its own PR against `main`.
4. Lumen performs internal review.
5. Athena gates the exact PR head.
6. Loom composes the slice receipt.
7. Hadi may merge. Kasra waits for the exact merge SHA before starting the next slice.

If Hadi chooses not to merge a GREEN slice, the program waits rather than stacking later feature work onto it. This keeps every PR independently main-ready and prevents parent-branch drift from invalidating exact-head gates.

## Donor-code rule

PR #1236 is a read-only donor and defect inventory. A slice may manually port the smallest useful implementation after understanding it, but must not:

- extend the #1236 branch;
- cherry-pick an omnibus commit wholesale;
- copy a receipt as proof;
- import unrelated device fleet, unified access, onboarding, or journey work;
- reuse migration numbers without rechecking the live main migration head;
- treat a focused test from #1236 as evidence for the replacement PR.

Every behavioral change must first be expressed as a failing regression on the new clean-main slice.

## Program sequence

Loom accepted this order as a draft sequence in Mupot message `35165332-ab80-4d39-8db4-5b0874fbf61e` and ordered HOLD until the MSG-01 Athena verdict. The HOLD applies to implementation, not to this design artifact.

### Gate dependency: finish MSG-01 review

Before Slice 1 begins:

- Athena returns a verdict for task `60c7ac1c` and draft PR #1237, naming the artifact and SHA256.
- Loom records the verdict and either authorizes rework or issues Slice 1 GO.
- Neither #1236 nor #1237 is merged by Kasra.

### Slice 1: repository CI foundation

Goal: make current main's required development gates green without importing any new #1236 feature.

Scope:

- repair TypeScript contract and unused-symbol failures instead of suppressing them;
- update the two WFP expectations to the production dispatcher contract;
- remove secret-like test literals while preserving the scanner's ability to catch real token shapes;
- eliminate the eight new mock-DB ratchet violations by using `createSqliteD1()` plus `applyAllMigrations()` or by removing unnecessary production imports;
- repair local D1 evidence so migration application does not exceed SQLite's compound-select limit;
- preserve all existing public behavior except where a failing regression proves the implementation and committed test disagree.

Explicit exclusions:

- token grants, device fleet, device attestation, onboarding packs, router cron, and migrations 0140–0142 from #1236;
- new product behavior;
- broad lint-disable or TypeScript-ignore directives;
- weakening `no-secrets`, test-schema-source, migration-numbering, or local-evidence guards.

Slice 1 is complete only when typecheck, the complete Vitest suite, every local guard, and every required GitHub check exit zero at the exact PR head.

### Slice 2: credential rotation boundary

Goal: provide atomic credential rotation without cross-squad or cross-member credential takeover.

Authorization:

- arbitrary-token rotation requires server-derived org owner/admin authority;
- a squad-scoped admin grant is insufficient;
- authorization is checked before token lookup so refusal does not become a token-ID oracle;
- no client argument may claim the rotating principal or token owner.

Atomicity:

- replacement insert, original-token compare-and-set revocation, and rotation audit write execute as one D1 transactional batch;
- concurrent rotation permits one winner;
- any failed statement rolls back all three effects;
- raw replacement material is returned only after a successful batch and only to the authorized caller;
- no test or receipt stores raw token material.

This slice does not rotate a live credential. It proves the service and tool against real SQLite migrations.

### Slice 3: governance identity and enforced 2FA

Goal: make governance votes, founder authority, approval receipts, and consequential-action consumption depend on authenticated server state.

Governance identity:

- remove caller authority over `voter_seat` and `voter_type`;
- derive voter member, bound agent, and canonical agent/seat label from authenticated records;
- count a council vote only when the authenticated principal holds the explicit governance gate capability;
- derive founder authority from a server-side owner/founder grant, never a magic input string;
- enforce one canonical principal vote per resolution.

Approval verification:

- canonicalize the challenge and action payload before hashing;
- verify Ed25519 signatures against a registered, active key owned by the approving principal;
- store the verified key fingerprint and verification outcome, not an unchecked caller label;
- make challenge decision and receipt creation atomic;
- reject replay, expired challenge, wrong action hash, wrong target, wrong key, and wrong principal.

Enforcement:

- high-impact actions covered by the program must consume the approved challenge atomically before mutating;
- a standalone successful `approval_consume` response is not sufficient proof;
- token rotation remains org-authorized and becomes 2FA-enforced when this slice lands.

### Slice 4: router, loop, and meter authorization

Goal: scope automated execution to the caller's authorized domain and derive consequential limits from durable state.

Router:

- dry-run requires observer on the named squad;
- mutation requires lead/admin on the named squad or an internal scheduled-system authority;
- tenant-wide mutation is org-admin/internal only;
- a task may only be assigned to an active agent authorized on `task.squad_id`;
- no fallback crosses squad boundaries.

Loop driver:

- an explicit loop is resolved before authorization;
- mutation requires owner/admin authority for that loop's squad/project;
- all-loop sweeps are internal scheduled operations or org-admin only;
- no ordinary authenticated principal can drive another squad's loop.

Meter:

- self-status is available only for the caller's bound agent;
- another agent's status requires observer on that agent's squad;
- reservation requires the authorized execution path, not a public arbitrary-agent tool;
- budget caps and windows come from durable agent/project policy, not caller overrides;
- unauthorized callers cannot consume another agent's dispatch count or inspect spend telemetry.

### Slice 5: delivery fencing and presence leases

Goal: connect delivery fencing to the real producer and bind consumption/liveness to authenticated receiver state.

Delivery fencing:

- the real delivery producer registers the fence before making work visible;
- the fence stores tenant, delivery ID, recipient agent, target seat, thread, turn, generation, correlation, nonce hash, and expiry;
- consumption derives recipient identity and seat from the authenticated execution context;
- every tuple field plus receiver identity must match in one atomic update;
- sibling seats, wrong agents, stale generations, expired leases, wrong nonces, and replays fail closed;
- producer registration plus receiver consumption is exercised end to end.

Presence:

- session epochs are monotonic and reject downgrade;
- lease TTL is validated within a bounded server policy and affects effective status;
- a delayed heartbeat cannot revive or overwrite a newer session;
- stored raw state remains distinguishable from effective online/offline state.

### Slice 6: MSG-01 immutable integrity

Goal: land the smallest clean-main message-integrity repair after reconciling Athena's verdict on #1237.

- persist send-time body length and SHA-256 for every production `agent_messages` writer;
- prevent later baseline mutation;
- compare the stored baseline on inbox, lease, and dead-letter reads;
- return `is_intact=null` for legacy rows without a baseline;
- return `is_intact=false` for truncation and same-length substitution;
- preserve sender-scoped idempotency, target visibility, inbox fences, targeted seats, and push-event behavior.

If Athena GREENs #1237, Slice 6 rebases or reconstructs those exact approved semantics after the CI foundation has landed. If Athena BLOCKs, its findings are added to the slice before code begins.

### Slice 7: integration audit

Goal: prove the replacement series satisfies the original objective without inheriting #1236's unrelated scope.

- verify every prior slice merge SHA is an ancestor of current main;
- run typecheck, complete Vitest, every repository guard, and local D1 evidence from a clean main worktree;
- verify required GitHub checks on each immutable PR head and the final main descendant;
- run cross-slice adversarial cases for credential plus 2FA, governance plus canonical identity, router plus meter, and producer plus delivery consumption;
- audit that #1236 remains unmerged and was not extended by this program;
- produce one final Artifact+SHA256 packet for Lumen, Athena, and Loom.

## Per-slice engineering protocol

Every slice follows the same lifecycle:

1. Fetch current `origin/main` and record the exact base SHA.
2. Create one isolated branch/worktree with no inherited dirty changes.
3. Build or refresh the code-review graph at that exact base before code exploration.
4. Write one failing adversarial regression for the claimed security predicate.
5. Run it and confirm RED for the intended reason.
6. Implement the minimum complete behavior; do not weaken the requested end state for easier tests.
7. Run the focused suite and mutate/remove the load-bearing predicate to prove the test fails.
8. Run typecheck, the complete Vitest suite, repository guards, migration compatibility, and `git diff --check`.
9. Commit with a narrow conventional message and push the isolated branch.
10. Open a draft PR with base/head SHAs, commands, exits, and explicit caveats.
11. Request Lumen internal review and fix every Critical/Important finding.
12. Request Athena exact-head review with Artifact+SHA256.
13. Ask Loom to compose the receipt.
14. Wait for Hadi's explicit merge decision.

No later slice starts merely because focused tests pass or a review request is queued.

## Error and evidence handling

- Missing or inaccessible control-plane context is `UNPROVEN`, never empty.
- A message send proves accepted persistence; it does not prove runtime consumption.
- Failed required CI is a BLOCK even when focused tests pass.
- A materialized branch SHA does not prove deployment.
- A self-authored receipt does not prove behavior.
- Test fixtures must falsify the exact predicate; another independent filter must not mask the missing guard.
- Secrets remain in protected files/environment bindings and never enter command output, artifacts, commits, or messages.
- Migrations are never applied locally to production or remotely inside this goal without separate Hadi authorization.

## Completion criteria

The program is complete only when all of the following are true:

1. Every Slice 1–7 deliverable exists on a bounded PR or final integration artifact.
2. Every behavioral slice includes adversarial regression and mutation evidence.
3. Every slice exact head has typecheck exit 0, full-suite exit 0, and all required CI checks successful.
4. Lumen has no unresolved Critical/Important finding for each slice.
5. Athena has returned an Artifact+SHA256 verdict for each exact head.
6. Loom has recorded a sequencing/composition receipt for each slice.
7. #1236 was neither merged nor extended by this program.
8. Kasra did not merge, deploy, rotate credentials, or mutate production.
9. Any merges needed for sequential progress were explicitly performed or authorized by Hadi and their exact SHAs are recorded.
10. A final clean-main audit proves the whole replacement chain rather than inferring completion from individual PRs.
