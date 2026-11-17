# Agent identity and wake verification

Task: 7a7cc34a-1b03-4bce-bf6a-4fde9ba2d748. Builder: Athena. Independent gate: Kasra.

`connection_check` is a self diagnostic for canonical agent-bound credentials and live attached chats. Its identity step zero returns the server-resolved agent ID, slug and credential kind. A person credential or an unattached conversation seat receives `not_agent` and `this connection is not an agent; stop and ask your human`. No argument can choose an agent. The diagnostic is available independently of the attachment-enrollment flags; attachment and token authority still come from their existing live checks.

The normal check keeps the SEND/RECEIVE legs. Agent-bound RECEIVE completes through the own-inbox acknowledgement; an attached chat uses its own handled receipt. A configured WAKE path remains advisory and is displayed alongside the separate proof state.

## Echo contract

1. Call `connection_check {echo:true}`. Before exposing the nonce, the server persists a challenge witness. The onboarding sender then puts the nonce in the authenticated agent's own inbox. A correlated ready witness records the exact message ID. The tool returns that ID and a ten-minute expiry, without the nonce.
2. End the turn. After wake, read the agent's own inbox and call `connection_check {echo_reply:'<nonce>'}`.
3. The result is `wake_proven` only when an existing successful transport receipt for that exact message follows challenge creation, the reply follows delivery, and no validated inbox read/peek/lease attempt occurred from challenge creation until delivery. Otherwise a valid nonce return is `echo_roundtrip`, which remains unproven. Invalid, expired, replayed and changed-context challenges are refused.

Native receipt correlation includes the exact subscription-specific event ID, tenant, agent, challenged token, successful outcome, 2xx status and completion timestamp. Signature timestamps have second resolution: their second bucket must cover challenge creation or be later, and must not follow reply; the precise receipt timestamp establishes strict delivery order. For diagnostic attribution only, webhook-doorbell correlation includes tenant, agent, exact message reference, wake event type, persisted `posted` outcome, 2xx and timestamps. Its `attempted_at` is the attempt start, with no completion timestamp. Doorbells therefore return `echo_roundtrip` with `delivery_timestamp_unavailable` and null delivery latencies. The signed doorbell worker returns `delivered` to its caller but persists `posted`; both signed and legacy receipt fixtures use the real schema.

The proof insert atomically rechecks credential liveness, the retained token set, current runtime, runtime-transition sequence and the polling window. A unique audit ID prevents two replies from committing a successful proof for one challenge. Reads cannot expose or consume the nonce when their observation cannot persist. Observations contain metadata only, never message bodies or nonces.

## Proof lifetime and display

Ten minutes expires the challenge, not an already committed proof. Effective proof ends on a new agent token, a changed credential/attachment/harness context, a fleet runtime-label transition, or seven days. Runtime transitions are recorded with the relevant registry write in one D1 batch; changing a label away and back cannot revive proof. Unchanged runtime reports preserve it. History is append-only, and a seven-day proof is displayed as stale and asks for re-proving.

Bound-agent boot and attached-chat boot include `wake_verification` and direct the agent to prove wake until it is proven. Existing wrong-principal guidance keeps priority; the curated read-only profile does not gain this workflow. The existing authorized agent page and `fleet_agent_get` expose safe proof metadata: state, time, actual receipt path and the challenge-to-delivery / delivery-to-reply latencies. Proof database failures report `wake_proof_unavailable`, rather than pretending no history exists.

## Limits

This is **agent transport evidence**, not runtime turn-completion attestation. Public metadata states `evidence_scope: agent_transport` and `runtime_turn_attested: false`. In particular, doorbell receipts do not identify a credential or harness; they prove delivery for the agent/message only. A host accepting HTTP does not prove its model consumed the hint or ended its previous turn.

Push-host hints currently have no persisted per-message delivery receipt. Doorbells lack a completion timestamp and attached monitor/poll paths also do not prove wake. They can complete an inbox roundtrip only. A validated read attempt that subsequently fails or is fenced conservatively downgrades a challenge. Bounded receipt lookup can also produce an unproven result when relevant historical evidence lies outside its candidate window. These limits never become dispatch permission.

There are no migrations, flag changes, credential operations or dispatch-policy changes in this slice. No merge or deployment is performed by the builder.

## Verification

Real SQLite D1 tests apply the complete migration chain. Coverage includes native and attached tool roundtrips, native proof through boot/fleet metadata, person refusal, exact credential and agent confinement, nonce secrecy, wrong nonce, expiry/replay/concurrent replies, successful and mismatched receipts, polling through bearer/signed/lease/attempt paths, observation/persistence failure, token/runtime changes, runtime reversal, seven-day staleness and agent-page display. Race tests interleave actual SQLite commits before the proof insert without matching SQL or stubbing query results.

The PR carries final regression counts, typecheck and guard-mutation receipts. Mutations run in a private copy, one change at a time; a kill requires an assertion failure, not a syntax/import/fixture error.

Initial targeted validation: 639 distinct checks across 20 files passed, including 66 core proof tests and 44 agent/attached admission-tool tests. The two boot files with migration-setup timeouts were moved to the existing canonical migration helper and their 17 checks passed with the normal timeout. Final core/tool rerun: 110 passed. Typecheck (`npx tsc --noEmit`), schema-source ratchet and `git diff --check` passed. This is targeted coverage; the PR's CI provides the full-suite result. Final mutation receipts and CI status are recorded on the PR with exact source/test hashes and failing-test patterns.


CI integration corrections: bearer peeks fold the active-challenge check into the existing read with a sentinel for empty/fenced results. They persist the witness before exposing any message. SSE remains one D1 statement per idle tick outside a challenge, two while active, and one again after expiry. Each challenge retains one earliest poll witness instead of one audit row per tick. Three inbox fixture systems now execute the real migration-chain database; the shared test adapter reports SQLite's actual insert row ID instead of a placeholder zero. The registry's diagnostic floor describes agent-bound/live-attached eligibility, and proof credential reads use the shared token-lifecycle predicate. The retained token-ID inventory has a query-specific non-authority exemption because it intentionally includes revoked history.

The focused CI-correction set verifies 233 distinct checks across eight files. Its first combined run had three lifecycle fixture setup timeouts; after moving that file to the canonical helper, all 18 lifecycle checks passed with normal timeouts. The other seven files passed all 215 checks, and the real cap/dedup interleaving case was rechecked separately. Typecheck, the schema-source ratchet (mock debt reduced from 122 to 119 files), and the refusal guard passed. These are local receipts; only the final head's completed CI run is a full-suite claim.


## Round two: rejected head 225e6799

Both independent gates reproduced false proof despite the earlier green suites. Five non-folded reader interleavings let a challenge appear after a zero-row pre-witness, then returned its nonce without a witness. A folded peek could stamp its witness after an intervening delivery. The new real-SQLite regressions reproduced all six false `wake_proven` outcomes before the fixes; the inactive-snapshot control did not expose a newly created nonce.

Non-folded readers now use one shared pre/post observation boundary. The post-witness completes before any result is exposed, including consume, signed peek/consume, lease and attempt-lease. The captured read time is reused; a challenge created during the read clamps the witness to challenge T0 so it cannot be backdated out of the proof window. Folded peeks stamp the active snapshot's time, rather than a later clock read. A post-witness persistence failure returns an error without the nonce.

The shared active-challenge query uses the canonical agent-member actor plus a ten-minute creation-time lower bound through the existing `idx_agent_audit_actor_changes` index. Challenge issue rows store their logical issue timestamp explicitly. This avoids historical audit scans and requires no migration. Query-plan regressions use 5,000 old rows and require an actor/time range search; a dense-recent-history control proves no candidate LIMIT can hide an active challenge. The SSE idle/active/expiry statement budget remains 1/2/1.

Exact observer expiry, stale attachment ID, stale attachment agent and the explicit native credential/agent join are pinned by regressions and mutations. The native join assertion deliberately pins a defensive query contract that current member-binding uniqueness also enforces. The annotation now covers canonical/attached diagnostics and echo writes, the doorbell test name states that it does not prove wake, and the dashboard copy states the narrow returned-path/no-prior-read claim.

Local round-two verification: 877 tests across 21 files passed; typecheck, schema-source and diff checks passed. The final round-two mutation table and exact-head CI receipt are attached to the PR after the single push. Earlier receipts belong to the rejected round-one head and are not round-two gate approvals. No merge or deployment is performed by this builder.

The refreshed round-two table contains 54 assertion-killed mutations, including the post-read boundary, captured folded timestamp, overlapping-creation clamp, actor/time seek and forced-index selection, exact observer expiry, stale attachment ID/agent and explicit native token/agent weld. Source/test hashes and recipes are attached to the PR on the round-two head. Annotation verification passed 136 checks after the final wording edit. The one pushed head's completed CI result is reported separately on the PR and task.
