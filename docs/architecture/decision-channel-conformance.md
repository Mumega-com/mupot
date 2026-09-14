# Decision-channel & harness conformance spec

Status: test-spec table, written 2026-09-14 by Kasra, revised 2026-09-14 (round 2,
Athena gate on PR #1410, head `aa6e0a99`). Not code — this names the black-box
probe, the expected outcome, and the mutation that must go red for each clause of
[`human-decision-channel-contract.md`](./human-decision-channel-contract.md) and
[`agent-harness-contract.md`](./agent-harness-contract.md). Existing tests are cited by
path; a clause with no existing test is marked **TODO**. Refs: mupot `main` @ `49a344aa`,
`Mumega-com/mupot-plugin` @ `6c86c2b0`. Where a row cites Hermes (the host agent runtime
the plugin runs inside — a separate repo this doc has not independently fetched), it is
cited by **symbol**, once, at the plugin's own CI-pinned rev
`233757037df1f03f9fe1cfddc097acd5ad7f7510` (`.github/workflows/test.yml:34`), never by
a Hermes line number — see `agent-harness-contract.md`'s Hermes-citation note.

This is one of **two** conformance surfaces in this repo. `docs/runtime-adapter-contract.md`
already has its own "Planned Conformance Tests" section (`:603-626`, `npm run
conformance:runtime:local`) covering the identity/attach/messaging layer (signed
attach, detach, heartbeat, inbox send/read/peek). This document does not repeat that
surface — the rows below start one layer up, at the decision-channel and harness-safety
properties that surface does not cover (invite binding, replay, principal, fences,
receipts, e-stop, allowlists).

## How to read this table

- **Probe** — the black-box action a test takes (no internal state peeking beyond a
  readback the contract itself calls for). For the Harness contract clauses (hb-hf)
  below, the probe is stated in **contract terms** — an action and an observable outcome
  any harness could be tested against — not in terms of one reference implementation's
  private functions.
- **Expected** — the observable outcome a passing implementation produces.
- **Kill mutation** — the smallest code change that must flip the probe's outcome. A test
  that stays green under this mutation is not testing the clause.
- **Existing test** — file path (and test name where useful) if one already exercises this.
  **TODO** means write it; nothing today pins the clause. For the Harness contract
  clauses, this column is **Reference implementation evidence**: a test in this column
  proves the property holds for Hermes/mupot-plugin specifically. It is not a portable
  conformance test another harness can run, and its absence for a second harness is not
  itself a defect — a genuinely harness-agnostic black-box test is separately marked
  TODO in each row where none exists.

## Decision-channel contract clauses

### (a) Invite binding

| # | Probe | Expected | Kill mutation | Existing test |
|---|---|---|---|---|
| a1 | Redeem the same pairing code twice | 2nd redemption `invalid_or_expired_pairing_code`, no 2nd member/capability row | Drop `accepted_at IS NULL` from `CLAIM_INVITE_SQL` | `tests/telegram-project-onboarding.test.ts:625-629` (`M5`, `runClaim()` returns `0` rows affected) — this pins the SQL fence directly; it does not additionally assert the HTTP-level `invalid_or_expired_pairing_code` reply text for a *second* redemption attempt through the full webhook path, which remains implicit rather than pinned end-to-end |
| a2 | Redeem a code past `pairing_expires_at` | `invalid_or_expired_pairing_code` | Drop `pairing_expires_at > ?8` | `tests/telegram-project-onboarding.test.ts:632` (`M6`) |
| a3 | Redeem with no matching `processing` receipt | `invalid_or_expired_pairing_code`/`update_receipt_invalid`, no writes | Drop the receipt `EXISTS` conjunct | `tests/telegram-project-onboarding.test.ts:638` (`M7`) |
| a4 | Redeem into a project archived between invite mint and claim | Claim refused, no member/capability written | Drop `projects.status='active'` `EXISTS` | `tests/telegram-project-onboarding.test.ts:655` (`M8`) |
| a5 | Redeem after the `project_squad_access` edge is revoked | Claim refused | Drop the `project_squad_access` `EXISTS` | `tests/telegram-project-onboarding.test.ts:672` (`M9`) |
| a6 | Create an invite with a capability above the inviter's own rank | `cannot_grant_above_own_rank` | Remove the `capabilityRank(input.capability) > actorRank` check | `tests/telegram-project-onboarding.test.ts:383` |
| a7 | Redeem, then read the invite row for a raw secret | Only `pairing_hash` ever stored; `pairing_code` never persisted | N/A — schema/code review, not a runtime mutation | **TODO**, confirmed genuinely absent (verified this revision): `tests/telegram-project-onboarding.test.ts:361-369` ("creates an active project invite ... stores only the pairing hash") reads the row via `SELECT project_id, squad_id, pairing_hash, pairing_expires_at FROM invites` — the column list itself excludes any raw-secret column, so `expect(JSON.stringify(row)).not.toContain(pairing_code)` (`:369`) is true by construction of the query, not proof the schema/other columns never persist it. A real probe needs `SELECT *` or a schema check |
| a8 | Redeem using Telegram `first_name`/`username` as if they were identity | Display-name-only; identity is `telegram_user_id`, never these fields | Make `redeemTelegramProjectInvite` accept `display_name` as a lookup key | `tests/telegram-project-onboarding.test.ts:1435` (E, display_name label only) |

### (b) Ingress authority

| # | Probe | Expected | Kill mutation | Existing test |
|---|---|---|---|---|
| b1 | POST `/im/webhook` with `IM_WEBHOOK_SECRET` unset | `503 webhook_not_configured` | Default the secret check to pass when unset | **TODO** — no test drives the unset-secret branch of `src/im/index.ts:911-913` directly. `tests/im-webhook.test.ts:47` ("keeps bad small secrets unauthorized") exercises the wrong-secret → `401` branch (`:914-917`), a *different* clause, and was miscited here in the prior revision. Separately: `src/channels/adapters/telegram.ts`'s `ChannelAdapter.verify` (`:44-49`) implements the identical fail-closed check against the same env var and IS unit-tested for the unset case (`tests/telegram-adapter.test.ts:12-14`, `test('fails closed when IM_WEBHOOK_SECRET is not configured')`) — but that test exercises the `/channels/telegram/...` path (`src/channels/index.ts:776`), a separate live route from `/im/webhook`, not this clause's own inline check. Two copies of one predicate, only one of which is tested for the unset case; see `human-decision-channel-contract.md` (b) |
| b2 | POST with wrong/missing `X-Telegram-Bot-Api-Secret-Token` | `401 unauthorized` | Replace `timingSafeEqual` with `===` (functionally same result, but timing-attack surface — flag as a design-review item, not a black-box-observable mutation) | `tests/im-webhook.test.ts:47` |
| b3 | POST with `Content-Length` over cap | `413`, body never parsed | Remove the pre-parse `content-length` check | `tests/im-webhook.test.ts:26` |
| b4 | POST with actual body over cap (chunked, no honest `Content-Length`) | `413` after buffering, before JSON parse | Remove the post-read `buf.byteLength > maxBytes` check | `tests/im-webhook.test.ts:37` |
| b5 | POST invalid UTF-8 bytes | `400 invalid_json`/`bad_utf8`, no downstream effect | Drop `{ fatal: true }` from `TextDecoder` | **TODO**, confirmed genuinely absent (verified this revision): `tests/im-webhook.test.ts:55` ("rejects invalid JSON after a valid small authenticated body") sends `'{not-json}'`, which is valid UTF-8 with malformed JSON *syntax* — it exercises `JSON.parse`'s failure path, not `readCappedBody`'s `TextDecoder({ fatal: true })` failure path (`src/im/index.ts:72-82`). No test sends actually-invalid UTF-8 bytes |

### (c) Replay

| # | Probe | Expected | Kill mutation | Existing test |
|---|---|---|---|---|
| c1 | Send the identical update twice concurrently | Exactly one task/answer effect; both callers see the same stored reply | Remove the reservation's uniqueness on `(tenant, update_id)` | `tests/im-webhook-idempotency.test.ts:124-141` ("allows only one concurrent update to produce the task effect") |
| c2 | Resend same `update_id` with different text/principal/forwarding | `409 update_conflict`, no effect from the second body | Compute the digest without one of `(text, telegram_user_id, forwarding)` | `tests/im-webhook-idempotency.test.ts:195-207` |
| c3 | Crash/restart mid-`processing`, then resend | Row stays `processing`, resend returns `409 update_in_progress`, no replay | Allow a `processing` row to be claimed as if `empty` | `tests/im-webhook-idempotency.test.ts:210-220` (`it.each(['processing', 'unknown'])('does not retry effects after interrupted %s reservation', ...)`) — this simulates the interruption by directly setting the receipt row's `state` column rather than an actual process kill between reserve and complete (a real fault-injection harness, killing the process between the reservation write and the completion write, remains a further TODO; this test proves the *consequence* — a `processing`/`unknown` row is never treated as retryable — which is the externally observable half of the clause) |
| c4 | Replay a `completed` update | Stored response returned verbatim, no second write | Skip the `state === 'completed'` short-circuit in `redeemTelegramProjectInvite`/webhook handler | `tests/telegram-project-onboarding.test.ts:966` |

### (d) Principal

| # | Probe | Expected | Kill mutation | Existing test |
|---|---|---|---|---|
| d1 | `/approve` from a member holding an org-scope capability grant (`admin`, or a direct `gate:agent-self-completion` grant), for `gate:agent-self-completion` | Refused — no principal can approve this gate over IM on the basis of a capability grant, because `legacyOwnerAdmin(auth)` (`src/tasks/index.ts:93`) reads only `auth.role`, which IM hardcodes to `'member'` | Make `evaluateVerdictGates` consult `AuthContext.capabilities` for the `gate:agent-self-completion` branch, or make `memberAuth` set `role` from a resolved capability | `tests/im-verdict-gates.test.ts:98` (direct `gate:agent-self-completion` grant to a `member`-scope member, refused) and `:114` (org-scope `admin` capability, refused). No committed test exercises an org-scope `owner` capability specifically for this gate over IM — the prior revision of this document and of `human-decision-channel-contract.md` asserted one existed; it does not. The two cited cases are sufficient to prove the clause (the check never reads the capability grant's value at all), but a dedicated owner-capability case remains a small, precise TODO |
| d2 | `/approve` after the actor's capability grant is revoked between `/needs` display and `/approve` | Refused at decision time | Cache capability at message-parse time instead of re-resolving in `verdictReply` | `tests/im-webhook-idempotency.test.ts:155-183` ("records one authorized verdict and refuses forwarding, revocation and conflicting or terminal decisions"), specifically `:177-182`: `gate_grants` deleted, a new `gate:human`-gated task inserted, `/approve` on it replies matching `/permission/` |
| d3 | `/approve` where the deciding member also owns the assignee agent's token | Refused (`memberOwnsAssigneeAgent`) | Remove the `memberOwnsAssigneeAgent` check | `tests/im-verdict-gates.test.ts:127-142` ("the completing agent's OWN member (memberOwnsAssigneeAgent) is still refused") — the same member holds both a squad `member` capability and an org `admin` capability and is still refused (`/assignee/i`), proving neither capability path substitutes for this check |
| d4 | `/answer` with a member who is not on `responsible_squad_id` for the run | Refused | Skip the routine principal squad check | Covered indirectly by `tests/telegram-project-onboarding.test.ts:1235` (routes only participant-squad work) |

### (e) Fences

| # | Probe | Expected | Kill mutation | Existing test |
|---|---|---|---|---|
| e1 | Send from a group chat | Refused, no action | Remove `message.chat.type !== 'private'` check | `tests/im-webhook-idempotency.test.ts:97-101` (`it.each`, the `{ chat: { id: 123, type: 'group' } }` case), asserting `400` and no business-state change. (Correction: the prior revision cited `tests/im-webhook.test.ts:63`, which tests a *missing* `chat.id` returning `no_chat_id` — a different validation path — and does not exercise a group chat at all.) |
| e2 | Send where `from.id !== chat.id` | `400 private_chat_required` | Remove the `userId !== chatId` check | `tests/im-webhook-idempotency.test.ts:97-101` (`it.each`, the `{ from: { id: 456 } }` case, chat id defaults to `123` from the base envelope — sender and chat owner mismatch) |
| e3 | Send with a forwarding marker present, any command including `/approve` | Fixed refusal text, no effect | Remove the `options.forwarded` check in `handleImMessage` or at `fleetReply`/`directiveReply` | `tests/im-webhook-idempotency.test.ts:164-166` (`/approve` with `forward_date: 1`, business state unchanged) and, for a second command shape proving "any command" rather than just `/approve`, `:254-261` (`it.each(['forward_origin', 'forward_from', 'forward_from_chat', 'forward_date'])('refuses a forwarded invite marked by %s', ...)` on `/start <code>`) |
| e4 | Command text containing `"member_id": "<other>"` or similar | Identity unaffected; text is intent only | Make `parseIntent` extract an identity field from text | Structural — covered by `memberForChat` never reading `text`; no direct negative test. **TODO**, confirmed genuinely absent (verified this revision): no test constructs a message body carrying an identity-shaped string inside `text` and asserts it has no effect |

### (f) Receipts

| # | Probe | Expected | Kill mutation | Existing test |
|---|---|---|---|---|
| f1 | Trigger a Routine human-wait twice with the same run/action | One delivered message, second is a no-op duplicate | Remove the stable `request_id` derivation (`humanWaitRequestId`) | `tests/routine-actions.test.ts:582-601` ("keeps the stable human-wait request ID valid for maximum-length action keys"): first submit stores `request_id` matching `^routine-human:[a-f0-9]{64}$` (`:594-595`), second submit returns `duplicate: true` with the SAME `request_id` and no second `agent_messages` row (`:598-601`). (Correction: the prior revision cited `:582,604` — line `604` is the *start of the next, unrelated test* ("bounds control-character human-wait notifications..."), not part of this test.) |
| f2 | `notifyHumanWait` with `run.assigned_agent_id = null` | `{ delivered: false, reason: 'no_recipient' }`, distinguishable from a refused send | Collapse the outcome type back to a bare boolean | `src/routines/actions.ts:397` is the live check (`if (!run.assigned_agent_id) return { delivered: false, reason: 'no_recipient' }`; the prior revision's `:233-238` citation pointed at a now-stale comment block, not the live branch), tested directly at `tests/routine-actions.test.ts:576` (`expect(outcome).toEqual({ delivered: false, reason: 'no_recipient' })`) |
| f3 | Reconcile a task verdict after an interrupted write (status flipped, no verdict row) | Reported as an incident, not silently treated as complete | N/A — this is an operational runbook step, not a code path with a mutation target | Manual, per runbook "Receipts, restart, and retry interpretation" |

## Harness contract clauses

The rows below probe `agent-harness-contract.md`'s properties (b)-(f). Per that
document's Second-harness checklist, the properties themselves are harness-agnostic;
today's **Reference implementation evidence** column is Hermes/mupot-plugin-specific
because Hermes/mupot-plugin is the only harness that exists. A genuinely portable
black-box probe — one a second harness's own test suite could run — is marked
separately as TODO in each row where it does not exist; citing the plugin's test as if
it were that portable probe was MAJOR-3 of the round-1 gate.

### (b) Lease/ack

| # | Probe | Expected | Kill mutation | Existing test |
|---|---|---|---|---|
| hb1 | ACK with a stale/wrong `attempt_id` | Refused; message stays leased under the real attempt | Remove the `attempt_id` join condition from the ack UPDATE | `tests/inbox-lease-attempt-ack.test.ts:144-168` ("marks stale attempt A expired without consuming or altering newer lease B" — ack on stale attempt A returns `expired`/`consumed: false` while a `reconcile` on the real, newer attempt B still shows the message `leased`, and B's own ack then succeeds) and `:304-328` ("does not read anything for unknown, empty, cancelled, or expired attempts" — an attempt id that was never issued at all returns `cancelled`/`consumed: false`, no read). This is a mupot-side test (`src/agents/messages.ts`), harness-agnostic by construction — any harness calling `inbox_lease_ack` gets this for free |
| hb2 | Harness crashes after lease, before persisting the message locally, restarts | Message is redelivered, not lost, not double-processed twice with different content | Ack immediately after lease instead of after local persistence | **TODO** — requires a harness-level fault-injection test (kill the harness process between lease and local persistence, restart, assert redelivery), which by definition must be written per-harness; no such test exists for Hermes/mupot-plugin or any other harness today |

### (c) Fence

Contract-terms probe: a body relayed from a remote Mupot session into a human-facing
surface must be delimited so the body cannot forge the delimiter, regardless of what
that surface's own escaping mechanism looks like.

| # | Probe (contract terms) | Expected | Kill mutation (contract terms) | Reference implementation evidence (Hermes/mupot-plugin) |
|---|---|---|---|---|
| hc1 | Notice body contains 4, 5, 6, 9 delimiter-character runs (non-multiple-of-the-delimiter-width) | Delimiter cannot be escaped/closed early by the body | Revert to a full-delimiter-string, non-overlapping replace instead of a per-character escape | `tests/native/test_notifications.py::test_fenced_untrusted_block_escapes_every_backtick_run_length` |
| hc2 | Notice body contains terminal control sequences around delimiter characters | Delimiter still holds | Same reversion as hc1 | `tests/native/test_notifications.py::test_fenced_untrusted_block_escapes_ansi_prefixed_run` |
| hc3 | Notice body mixes line-ending and zero-width characters with delimiter characters | Delimiter still holds | Same reversion as hc1 | `tests/native/test_notifications.py::test_fenced_untrusted_block_escapes_mixed_cr_lf_zwsp_body` |
| hc4 | Mirror a notice into a session transcript, then inspect the stored role/tag | Role/tag reads as data relayed to the agent, never as the agent's own turn | Drop the explicit non-default role/tag when writing to the transcript | `tests/native/test_notifications.py::test_flush_real_estop_sentinel_blocks_mirror_text_at_its_own_choke_point` (estop-adjacent, not a direct role assertion); a direct role-assertion test is `test_flush_fences_and_shares_one_string_across_deliver_and_mirror` |
| hc5 | Caveat text placement relative to the fence, asserted explicitly (not merely implied by hc1-hc3's string-shape checks) | Caveat always after the closing fence, unconditionally | Move the caveat before the fence | `tests/native/test_notifications.py::test_activation_queues_existing_human_conversation_instead_of_passive_send` (`:779-783`): `caveat_index = ...index("not a human instruction or approval"); assert caveat_index > fence_end` — this IS a dedicated, explicit placement assertion; the prior revision of this document marked it only "implicit" and TODO for an explicit case, which was wrong |

**Portable black-box probe:** TODO for all of hc1-hc5 — none of the above is runnable
against a non-Hermes harness. A harness-agnostic version would construct a body with
these properties, ask the harness (via whatever public API it exposes for "deliver this
remote text to a human") to wrap it, and assert on the delivered string's shape —
without importing any Hermes/mupot-plugin-private function.

### (d) Authorization / allowlist

| # | Probe (contract terms) | Expected | Kill mutation (contract terms) | Reference implementation evidence (Hermes/mupot-plugin) |
|---|---|---|---|---|
| hd1 | Configure the harness's peer-sender allowlist as explicitly empty | Every sender denied | Treat explicit-empty the same as absent | `tests/native/test_adapter.py::test_explicit_empty_allowed_agents_denies_everyone` |
| hd2 | Omit the allowlist config entirely | Falls back to the documented default roster | Make an absent key also deny everyone (breaks the documented default) | `tests/native/test_adapter.py::test_absent_allowed_agents_key_falls_back_to_the_documented_default` |
| hd3 | A peer sender not on the allowlist sends a message | Message refused, not delivered | Remove the allowlist membership check | `tests/native/test_routine_events.py::test_disabled_config_keeps_routine_path_absent_and_never_expands_peer_allowlist` (adjacent); a direct positive-refusal unit test is **TODO** |
| hd4 | Break the import the harness's own safety check depends on (simulate an unimportable dependency on the legacy delivery path) | Fails safe (refuses/warns), does not silently skip the check forever | Import unconditionally without a try/except fallback that can silently never re-attempt | `tests/native/test_estop_egress_gate.py::test_legacy_inbox_stream_deliver_fails_closed_when_agent_estop_unimportable` |
| hd5 **(new, round 2 — BLOCK-2)** | A host-runtime flag exists whose purpose is routing (e.g. marking a harness-originated turn so it queues rather than interrupts a human's own turn); assert that the SAME flag does not ALSO cause the host to skip its own per-source authorization or its own global pause gate for that event | Either the host's own gates still run for a flagged event, OR the harness performs its own explicit, equivalent check at the same point instead of assuming the host's routing flag implies the host's security flag | Rely on the routing flag alone; remove the harness's own explicit check | Reference implementation evidence for the harness-owned compensating check: `tests/native/test_adapter.py::test_explicit_empty_allowed_agents_denies_everyone` / `::test_absent_allowed_agents_key_falls_back_to_the_documented_default` prove `self.allowed_agents` (the harness-owned sender fence) is enforced; the `allow_from`-scoping comment (`mupot_gateway/adapter.py:1103-1121`) documents WHY Hermes's own gates cannot be assumed to run. **No test proves the host-side absence directly** — that the host's own gates in fact do not run for a flagged event is a claim about Hermes, a repo this test suite cannot reach; it is asserted by the plugin's own comment, not independently verified here. TODO: a black-box probe belongs in Hermes's own test suite, not this one |

### (e) Pause/e-stop

Contract-terms probe: an operator-issued stop must gate every future consume/dispatch/
egress action a harness takes on an agent's behalf, as a temporal ("try again later")
condition, never folded into a permanent-failure state — this property is REQUIRED for
conformance (see `agent-harness-contract.md`'s scope note on property (e)).

| # | Probe (contract terms) | Expected | Kill mutation (contract terms) | Reference implementation evidence (Hermes/mupot-plugin) |
|---|---|---|---|---|
| he1 | Engage the pause, then run one iteration of the harness's own work loop | No lease, no replay, no flush — the iteration does nothing but sleep/backoff | Remove the pause check from the top of the work loop | `tests/native/test_estop_lease_gate.py::test_pre_lease_pause` |
| he2 | Engage the pause mid-message (after lease, before ack) | Message deferred, lease left to expire naturally, no partial state written | Remove the mid-lease pause check | `tests/native/test_estop_lease_gate.py::test_mid_message_pause` |
| he3 | Engage the pause during outbox/event replay | Replay defers without acking/transmitting | Remove the replay path's own gate | `tests/native/test_estop_replay_gate.py::test_replay_routine_events_defers_without_acking_or_processing_while_paused`, `::test_replay_reply_outbox_defers_without_transmitting_while_paused` |
| he4 | Engage the pause during a live interim send | Deferred, not transmitted | Remove the interim-send gate | `tests/native/test_estop_replay_gate.py::test_live_interim_send_defers_without_transmitting_while_paused` |
| he5 | A pause-deferred exception raised from inside replay reaches the top of the work loop | Treated as a pause (retry later), not folded into the generic error/quarantine path | Reorder exception handling so a broad catch-all intercepts the pause signal first | `tests/native/test_estop_replay_gate.py::test_poll_loop_treats_replay_routine_events_estop_deferred_as_a_pause`, `::test_poll_loop_treats_replay_reply_outbox_estop_deferred_as_a_pause` |
| he6 | Engage the pause on any secondary/legacy delivery path the harness exposes | Refuses/drops with a log line, does not inject into the human session | Remove that path's own pause check | `tests/native/test_estop_egress_gate.py::test_legacy_inbox_stream_deliver_refuses_inject_while_real_estop_engaged` |
| he7 | Pause engaged, a dead-letter/quarantine append occurs, then the same message is reprocessed within the same pause | The append is idempotent by message id — no duplicate row | Remove the "already recorded" pre-check before the append | `tests/native/test_estop_observability.py::test_sender_policy_dlq_append_is_idempotent_across_a_pause_before_the_ack`, `::test_invalid_ack_envelope_dlq_append_is_idempotent_across_a_pause_before_the_ack` |
| he8 **(new, round 2 — BLOCK-2)** | Engage the pause, then invoke a human's own already-running, live in-session tool call (not a harness-originated poll/dispatch/cron turn) | The tool call proceeds normally — per property (e)'s explicit, deliberately narrow boundary, a pause is not a kill switch for a human's already-running session | Make the harness's own pause gate intercept a live in-session tool call | **TODO — no test found, in this repo or the plugin's.** The reference implementation's docstring states the boundary explicitly (`mupot_gateway/adapter.py`, the `_EstopDeferred` docstring's F2 correction, re-gate #5: "Human `/approve` control traffic while paused is Hermes's own concern, not this plugin's ... this class only gates the native-receive/legacy-inbox-stream surfaces listed above") but nothing in the cited test files exercises the NEGATIVE case (a live tool call while paused, asserting it is NOT blocked). This is the honest complement to he1-he7, all of which test that the pause DOES gate something — none tests that it deliberately does NOT gate something else |

**Portable black-box probe:** TODO for he1-he7 (as with hc/hd above); he8's portable
form is: engage whatever pause mechanism a given harness exposes, then drive a normal,
human-initiated tool call through that harness's own live-session surface, and assert
it completes — this needs a live session to drive, which neither this repo nor the
plugin's test suite currently sets up.

### (f) Observability

| # | Probe (contract terms) | Expected | Kill mutation (contract terms) | Reference implementation evidence (Hermes/mupot-plugin) |
|---|---|---|---|---|
| hf1 | Pause engaged, trigger the same choke point twice within one pause window | Exactly one log line, not two | Remove the per-window log dedup | `tests/native/test_estop_observability.py::test_refuse_ack_if_estop_engaged_logs_once_per_pause_window`, `::test_process_leased_message_top_gate_logs_once_per_pause_window` |
| hf2 | Pause lifts, then re-engages; trigger the same choke point again | A NEW log line for the new window | Never clear the per-window log dedup state on pause-lift | `tests/native/test_estop_observability.py::test_refuse_ack_if_estop_engaged_logs_once_per_pause_window` (`:87-102`) — the SAME test as hf1 covers both halves: after `real_estop.disengage()` and one natural re-check clears the dedup state, a second `engage()` + refusal asserts `len(records2) == 1, "a NEW pause window did not log again"` (`:102`). The prior revision marked this "implicit" and TODO for an explicit second-window case; that was wrong — it is explicit, in the same test function |
| hf3 | The pause-check mechanism itself raises (check failure, not a real pause), repeatedly | Warns once per distinct failure window, not once per call | Remove the failure-dedup gating | `tests/native/test_estop_observability.py::test_estop_engaged_failsafe_warns_once_per_failure_window` |
| hf4 | A final reply is refused due to pause | The result names the pause as the reason, plus a WARNING log | Drop the pause-naming from the refusal result | `tests/native/test_estop_observability.py::test_transmit_final_reply_choke_point_logs_once_and_send_result_names_the_pause`, `::test_refused_final_reply_also_warns_once_per_pause_window_naming_request_id` |
| hf5 | A notification is queued but never confirmed delivered/mirrored | Discoverable via a stranded-state scan, not silent | Remove the stranded-state inspector/startup scan | `tests/native/test_adapter.py:1763` (`test_stranded_notifications_are_logged_at_startup_and_surfaced_by_status_tool`) and `:1791` (`test_gateway_status_tool_reports_stranded_notifications`). The prior revision of this document claimed "no dedicated test found in this pass" for hf5 — that was wrong; both tests exist, are committed, and directly exercise `stranded_notifications()` |

**Portable black-box probe:** TODO for hf1-hf5, same shape as above — a second harness
needs its own local pause-window/log-dedup state and its own stranded-state inspector;
none of the cited tests can run against it.

## Notes on gaps

The prior revision of this document claimed every **TODO** row above was "a real
absence, not a formatting placeholder." Round 2 (Athena gate on PR #1410) found that
claim itself unverified in the wrong direction: 11 rows marked TODO (c3, d1, d2, d3,
e2, e3, f1, hb1, hc5, hf2, hf5) were in fact already pinned by committed tests, some of
which this document's own earlier "Sources read" list had already named. Only three
rows — b5, e4, a7 — were re-checked this revision and confirmed genuinely absent (see
each row's note above for what was checked and why the nearest-looking existing test
does not actually cover the clause). The lesson generalizes: **a TODO claim is itself a
claim requiring evidence** — "I did not find a test" is not the same statement as "no
test exists," and this document was wrong about that distinction on 11 of 14
previously-TODO rows. Several genuine TODOs (b5, e4, a7, hb2, he8, and the harness rows'
portable-probe TODOs) need real infrastructure this repo does not currently have (fault
injection between two specific writes, a live human session to drive, a Hermes-side
test) rather than a quick addition; scope those as their own follow-up rather than
rushing a vacuous version to close the row.

## Sources read

- mupot `main` @ `49a344aa`: `tests/telegram-project-onboarding.test.ts`,
  `tests/im-webhook-idempotency.test.ts`, `tests/im-webhook.test.ts`,
  `tests/im-verdict-gates.test.ts`, `tests/routine-actions.test.ts`,
  `tests/inbox-lease-attempt-ack.test.ts`, `tests/telegram-adapter.test.ts`,
  `src/im/index.ts`, `src/tasks/index.ts:85-93,1415-1445`, `src/routines/actions.ts`,
  `src/channels/index.ts:755-800`, `src/channels/adapters/telegram.ts`
- `Mumega-com/mupot-plugin` @ `6c86c2b0`: `tests/native/test_estop_lease_gate.py`,
  `test_estop_egress_gate.py`, `test_estop_replay_gate.py`, `test_estop_observability.py`,
  `test_notifications.py:754-790`, `test_adapter.py:1763-1830`, `test_routine_events.py`,
  `mupot_gateway/adapter.py:1069-1121`
- mupot PR #1410 round 1 gate comment (Athena, head `aa6e0a99`, 2026-09-14) — every
  citation in this revision was independently re-opened and re-read against that
  comment's claims, not copied from it
