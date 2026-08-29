# Governance Identity and Protected-Action 2FA Design

Status: proposed written specification for Hadi review

Date: 2026-08-29 UTC

Approved direction: protect token rotation and governance ratification only. Do not generalize this slice to every org-admin action.

## Objective

Replace PR #1236's caller-asserted governance and approval model with a server-derived, replay-safe design. The slice must prove canonical governance identity, unique voting, founder ratification, cryptographically verified approval, and atomic approval consumption for exactly two protected actions:

1. credential rotation; and
2. governance ratification.

The design prepares code and evidence only. It does not enroll a live key, rotate a live credential, ratify a live proposal, merge, deploy, apply a remote migration, or mutate production.

## Authority

- Hadi chooses the protected-action scope, reviews this written specification, decides whether an Athena-GREEN PR may merge, and separately authorizes any live enrollment, rotation, ratification, deployment, or production mutation.
- Kasra owns the isolated implementation worktree, TDD regressions, bounded internal review, exact-head evidence, and Mupot receipts.
- Athena independently gates the immutable candidate head with an Artifact path and SHA256. Queued work is not a verdict.
- Loom and Lumen have no role in this flow.

## Preconditions and sequencing

1. PR #1239 or an equivalent bounded CI repair must be present on `origin/main` with green required evidence before a governance implementation branch starts.
2. IR-3 head `6762cf6d` remains held. A fresh follow-up must first repair lost-success claim retrieval and resumable cancellation recovery.
3. Governance implementation starts from the merged descendant of that repaired rotation boundary. It must not copy PR #1236's migrations 0137-0139 or its receipts as proof.
4. Migration numbers are selected only after fetching the then-current migration head. No design-time number is reserved.

## Canonical governance principal

Every governance operation begins from authenticated server context. The service resolves a canonical principal tuple:

```ts
type GovernancePrincipal = {
  tenant: string
  principalKind: 'member' | 'agent'
  principalId: string
  memberId: string
  boundAgentId: string | null
  canonicalSeat: string | null
  governanceRole: 'voter' | 'founder'
}
```

The caller cannot supply `voter_seat`, `voter_type`, `principal_id`, `member_id`, `agent_id`, `founder`, key ownership, or verification outcome. Resolution requires active tenant membership, active bound-agent state when the caller is agent-bound, and an explicit server-side governance grant. Squad admin alone is insufficient.

Founder status comes only from a server-side founder/owner governance grant. A magic name, role string, seat label, or org-admin capability is not founder proof.

## Proposals, votes, quorum, and ratification

- A proposal stores a canonical action type, immutable payload hash, target tuple, creation principal, expiry, status, and `quorum_required` copied from durable tenant governance policy at creation. The caller cannot choose or lower the quorum. If no valid policy exists, proposal creation fails closed.
- Votes are unique by `(tenant, proposal_id, principal_kind, principal_id)` so the same principal cannot vote through multiple seats or channels.
- The vote service derives the voter and records the resolved canonical seat only as evidence; seat text is not the uniqueness or authority key.
- Quorum counts unique authorized principals against the proposal's frozen `quorum_required`. Suspended, inactive, unbound, cross-tenant, and revoked-grant principals cannot vote. Revoking a principal after its vote does not silently rewrite history; ratification revalidates the current eligible vote set and refuses if current eligible votes no longer meet the frozen threshold.
- Ratification requires the proposal to have the exact approved payload hash, unexpired quorum, and a current founder principal.
- Ratification also requires a verified 2FA approval bound to `governance.ratify`, the proposal ID, and the immutable proposal payload hash. Consumption and ratification occur in the same transactional batch.
- A proposal author may vote only if independently authorized by governance policy, but cannot bypass quorum or founder ratification. Ratification is never inferred from proposal creation or vote count alone.

## Approval key custody and enrollment boundary

The implementation contains no public key-enrollment or key-recovery endpoint. Tests generate ephemeral Ed25519 keys; private material never enters repository files, receipts, logs, or persisted rows.

Production key enrollment is a separate Hadi-authorized operation. An enrolled key record binds an Ed25519 public key fingerprint to one canonical principal and tenant, with enrollment receipt, activation time, optional expiry, revocation time, and generation. Ownership and fingerprint are immutable; revocation is append-audited.

Losing a key does not permit server-side private-key recovery. Recovery means revoking the old public key and separately authorizing a new enrollment. Existing unconsumed challenges for the revoked generation become unusable.

## Challenge and signature protocol

The server creates a short-lived, single-use challenge containing:

- version;
- tenant;
- challenge ID and random nonce;
- approving canonical principal ID;
- key fingerprint and generation;
- protected action;
- target kind and ID;
- canonical payload SHA-256;
- issued-at and expires-at timestamps.

The signed bytes are stable canonical JSON over all fields. Object-key order is normalized; array order remains significant. The server verifies Ed25519 against the active key already bound to the approving principal and stores only the signature digest, key fingerprint, verification timestamp, and immutable decision receipt.

Wrong tenant, principal, key, generation, action, target, payload hash, nonce, expiry, or replay fails closed. Authorization and target visibility are checked before target lookup is exposed, preventing token/proposal existence oracles.

## Protected action 1: credential rotation

Credential rotation continues to require server-derived org owner/admin authority. Squad-local admin is insufficient. The approval is bound to:

- action `credential.rotate`;
- the canonical token-owner/target tuple;
- the replacement-policy digest, excluding raw secret material; and
- the initiating canonical principal.

Approval consumption, original-token compare-and-set revocation, replacement activation, claim readiness, and audit writes must have one recoverable state-machine boundary. A lost success response returns the same still-valid one-time claim for the completed rotation; it does not burn the claim or create a second replacement. If readiness or cancellation fails, retries can resume from durable state and cannot leave a live replacement with no recoverable claim or a pending handoff with no recovery path.

The raw replacement credential is returned only after the durable completed state is proven and is never persisted in logs, tests, receipts, or error text.

## Protected action 2: governance ratification

Ratification requires both:

1. a current server-derived founder principal; and
2. a verified approval for `governance.ratify` bound to the exact proposal ID and payload hash.

The approval decision, single-use consume, proposal state transition, and ratification receipt occur atomically. A standalone approval-consume endpoint cannot authorize a later ratification. A retry after a committed ratification returns the same receipt without a second transition.

## Failure and recovery semantics

- All refusal paths are fail-closed and distinguish authentication, authorization, stale/replay, conflict, and unavailable recovery without revealing whether an unauthorized target exists.
- Conditional writes require exactly one affected row; ambiguous results are reconciled from durable state before retrying any mutation.
- Challenge verification and action execution have explicit idempotency keys.
- No cleanup path deletes immutable vote, decision, consume, rotation, or ratification receipts.
- Clock checks use server time and bounded TTL policy.
- Cross-system calls are not inside an assumed D1 transaction. Any external effect uses an intent/observation/recovery record and does not claim atomicity it cannot provide.

## Adversarial verification

Tests must cover at least:

- forged voter/founder/seat/member/agent fields rejected at schema and service layers;
- one principal voting through multiple seats/channels counted once;
- inactive, suspended, unbound, revoked-grant, squad-admin-only, and cross-tenant principals rejected;
- wrong key, wrong principal, wrong action, wrong target, wrong payload, expired challenge, revoked key, stale generation, and replay rejected;
- canonical JSON key-order invariance and array-order sensitivity;
- self-authored proposal cannot bypass quorum or founder ratification;
- missing 2FA blocks both protected actions;
- approval for rotation cannot ratify, and approval for ratification cannot rotate;
- approval consumption is rolled back when the protected mutation fails;
- concurrent action attempts produce one winner and one immutable receipt;
- rotation lost-success retry preserves the claim without creating/revoking extra tokens;
- readiness plus cancellation failure remains resumable;
- removing each load-bearing predicate makes a named regression fail.

Exact-head evidence requires focused tests, migration tests, typecheck, the complete suite, every repository guard, local D1 evidence, `git diff --check`, all GitHub checks, bounded internal review with no unresolved Critical/Important findings, and Athena Artifact+SHA256 verdict.

## Explicit non-goals

- protecting every org-admin mutation;
- public key enrollment, private-key custody, recovery seeds, or credential escrow;
- live key enrollment, live rotation, live ratification, deployment, or remote migration;
- accepting PR #1236 receipts or focused tests as replacement evidence;
- weakening required CI, authorization, quorum, or replay protection to make the slice easier to land.

## Completion boundary

The design phase completes when Hadi approves this exact written specification. Only then may Kasra rewrite the stale implementation plan and begin the fresh IR-3 recovery cycle. Code completion still requires a bounded PR with current-main ancestry, green full evidence, Athena's independent exact-head verdict, and a separate Hadi merge decision.
