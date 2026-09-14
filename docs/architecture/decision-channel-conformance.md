# Decision-channel & harness conformance spec

Status: test-spec table, written 2026-09-14 by Kasra. Not code — this names the black-box
probe, the expected outcome, and the mutation that must go red for each clause of
[`human-decision-channel-contract.md`](./human-decision-channel-contract.md) and
[`agent-harness-contract.md`](./agent-harness-contract.md). Existing tests are cited by
path; a clause with no existing test is marked **TODO**. Refs: mupot `main` @ `49a344aa`,
`Mumega-com/mupot-plugin` @ `6c86c2b0`.

## How to read this table

- **Probe** — the black-box action a test takes (no internal state peeking beyond a
  readback the contract itself calls for).
- **Expected** — the observable outcome a passing implementation produces.
- **Kill mutation** — the smallest code change that must flip the probe's outcome. A test
  that stays green under this mutation is not testing the clause.
- **Existing test** — file path (and test name where useful) if one already exercises this.
  **TODO** means write it; nothing today pins the clause.

## Decision-channel contract clauses

### (a) Invite binding

| # | Probe | Expected | Kill mutation | Existing test |
|---|---|---|---|---|
| a1 | Redeem the same pairing code twice | 2nd redemption `invalid_or_expired_pairing_code`, no 2nd member/capability row | Drop `accepted_at IS NULL` from `CLAIM_INVITE_SQL` | `tests/telegram-project-onboarding.test.ts:626` (`M5`) |
| a2 | Redeem a code past `pairing_expires_at` | `invalid_or_expired_pairing_code` | Drop `pairing_expires_at > ?8` | `tests/telegram-project-onboarding.test.ts:632` (`M6`) |
| a3 | Redeem with no matching `processing` receipt | `invalid_or_expired_pairing_code`/`update_receipt_invalid`, no writes | Drop the receipt `EXISTS` conjunct | `tests/telegram-project-onboarding.test.ts:638` (`M7`) |
| a4 | Redeem into a project archived between invite mint and claim | Claim refused, no member/capability written | Drop `projects.status='active'` `EXISTS` | `tests/telegram-project-onboarding.test.ts:655` (`M8`) |
| a5 | Redeem after the `project_squad_access` edge is revoked | Claim refused | Drop the `project_squad_access` `EXISTS` | `tests/telegram-project-onboarding.test.ts:672` (`M9`) |
| a6 | Create an invite with a capability above the inviter's own rank | `cannot_grant_above_own_rank` | Remove the `capabilityRank(input.capability) > actorRank` check | `tests/telegram-project-onboarding.test.ts:383` |
| a7 | Redeem, then read the invite row for a raw secret | Only `pairing_hash` ever stored; `pairing_code` never persisted | N/A — schema/code review, not a runtime mutation | **TODO** (assert via schema: no `pairing_code` column exists) |
| a8 | Redeem using Telegram `first_name`/`username` as if they were identity | Display-name-only; identity is `telegram_user_id`, never these fields | Make `redeemTelegramProjectInvite` accept `display_name` as a lookup key | `tests/telegram-project-onboarding.test.ts:1435` (E, display_name label only) |

### (b) Ingress authority

| # | Probe | Expected | Kill mutation | Existing test |
|---|---|---|---|---|
| b1 | POST `/im/webhook` with `IM_WEBHOOK_SECRET` unset | `503 webhook_not_configured` | Default the secret check to pass when unset | `tests/im-webhook.test.ts:47` (bad small secrets unauthorized) — extend for the unset case; unset-specific case is **TODO** |
| b2 | POST with wrong/missing `X-Telegram-Bot-Api-Secret-Token` | `401 unauthorized` | Replace `timingSafeEqual` with `===` (functionally same result, but timing-attack surface — flag as a design-review item, not a black-box-observable mutation) | `tests/im-webhook.test.ts:47` |
| b3 | POST with `Content-Length` over cap | `413`, body never parsed | Remove the pre-parse `content-length` check | `tests/im-webhook.test.ts:26` |
| b4 | POST with actual body over cap (chunked, no honest `Content-Length`) | `413` after buffering, before JSON parse | Remove the post-read `buf.byteLength > maxBytes` check | `tests/im-webhook.test.ts:37` |
| b5 | POST invalid UTF-8 bytes | `400 invalid_json`/`bad_utf8`, no downstream effect | Drop `{ fatal: true }` from `TextDecoder` | **TODO** |

### (c) Replay

| # | Probe | Expected | Kill mutation | Existing test |
|---|---|---|---|---|
| c1 | Send the identical update twice concurrently | Exactly one task/answer effect; both callers see the same stored reply | Remove the reservation's uniqueness on `(tenant, update_id)` | `tests/im-webhook-idempotency.test.ts:124` |
| c2 | Resend same `update_id` with different text/principal/forwarding | `409 update_conflict`, no effect from the second body | Compute the digest without one of `(text, telegram_user_id, forwarding)` | `tests/im-webhook-idempotency.test.ts:195` |
| c3 | Crash/restart mid-`processing`, then resend | Row stays `processing`, resend returns `409 update_in_progress`, no replay | Allow a `processing` row to be claimed as if `empty` | **TODO** — needs a fault-injection harness (kill between reserve and complete) |
| c4 | Replay a `completed` update | Stored response returned verbatim, no second write | Skip the `state === 'completed'` short-circuit in `redeemTelegramProjectInvite`/webhook handler | `tests/telegram-project-onboarding.test.ts:966` |

### (d) Principal

| # | Probe | Expected | Kill mutation | Existing test |
|---|---|---|---|---|
| d1 | `/approve` from a member holding org-scope `owner` capability, for `gate:agent-self-completion` | Refused — no principal can approve this gate over IM | Make `memberAuth` set `role` from a resolved owner/admin capability | Verified by execution per `docs/operations/telegram-project-onboarding.md` "Behaviour change" section; automated probe is **TODO** |
| d2 | `/approve` after the actor's capability grant is revoked between `/needs` display and `/approve` | Refused at decision time | Cache capability at message-parse time instead of re-resolving in `verdictReply` | **TODO** |
| d3 | `/approve` where the deciding member also owns the assignee agent's token | Refused (`memberOwnsAssigneeAgent`) | Remove the `memberOwnsAssigneeAgent` check | **TODO** (unit-level; `src/im/index.ts:583-597`) |
| d4 | `/answer` with a member who is not on `responsible_squad_id` for the run | Refused | Skip the routine principal squad check | Covered indirectly by `tests/telegram-project-onboarding.test.ts:1235` (routes only participant-squad work) |

### (e) Fences

| # | Probe | Expected | Kill mutation | Existing test |
|---|---|---|---|---|
| e1 | Send from a group chat | Refused, no action | Remove `message.chat.type !== 'private'` check | `tests/im-webhook.test.ts:63` (validates chat id; group-specific negative case is **TODO**) |
| e2 | Send where `from.id !== chat.id` | `400 private_chat_required` | Remove the `userId !== chatId` check | **TODO** |
| e3 | Send with a forwarding marker present, any command including `/approve` | Fixed refusal text, no effect | Remove the `options.forwarded` check in `handleImMessage` or at `fleetReply`/`directiveReply` | **TODO** |
| e4 | Command text containing `"member_id": "<other>"` or similar | Identity unaffected; text is intent only | Make `parseIntent` extract an identity field from text | Structural — covered by `memberForChat` never reading `text`; no direct negative test. **TODO** |

### (f) Receipts

| # | Probe | Expected | Kill mutation | Existing test |
|---|---|---|---|---|
| f1 | Trigger a Routine human-wait twice with the same run/action | One delivered message, second is a no-op duplicate | Remove the stable `request_id` derivation (`humanWaitRequestId`) | **TODO** |
| f2 | `notifyHumanWait` with `run.assigned_agent_id = null` | `{ delivered: false, reason: 'no_recipient' }`, distinguishable from a refused send | Collapse the outcome type back to a bare boolean | `src/routines/actions.ts:233-238` documents the unit-level seam; direct test is **TODO** |
| f3 | Reconcile a task verdict after an interrupted write (status flipped, no verdict row) | Reported as an incident, not silently treated as complete | N/A — this is an operational runbook step, not a code path with a mutation target | Manual, per runbook "Receipts, restart, and retry interpretation" |

## Harness contract clauses

### (b) Lease/ack

| # | Probe | Expected | Kill mutation | Existing test |
|---|---|---|---|---|
| hb1 | ACK with a stale/wrong `attempt_id` | Refused; message stays leased under the real attempt | Remove the `attempt_id` join condition from the ack UPDATE | `tests/native/test_estop_lease_gate.py::test_pre_lease_pause`, `::test_mid_message_pause` (pause-adjacent, not attempt-mismatch directly) — direct mismatch case is **TODO** at mupot `src/agents/messages.ts` level |
| hb2 | Harness crashes after lease, before persisting the message locally, restarts | Message is redelivered, not lost, not double-processed twice with different content | Ack immediately after lease instead of after local persistence | **TODO** — requires a harness-level fault-injection test, not just the mupot-side lease/ack unit tests |

### (c) Fence

| # | Probe | Expected | Kill mutation | Existing test |
|---|---|---|---|---|
| hc1 | Notice body contains 4, 5, 6, 9 backticks (non-multiple-of-3 runs) | Fence cannot be escaped/closed early by the body | Revert to `text.replace("```", ...)` | `tests/native/test_notifications.py::test_fenced_untrusted_block_escapes_every_backtick_run_length` |
| hc2 | Notice body contains ANSI escapes around backticks | Fence still holds | Same revert as hc1 | `tests/native/test_notifications.py::test_fenced_untrusted_block_escapes_ansi_prefixed_run` |
| hc3 | Notice body mixes CR/LF/zero-width characters with backticks | Fence still holds | Same revert as hc1 | `tests/native/test_notifications.py::test_fenced_untrusted_block_escapes_mixed_cr_lf_zwsp_body` |
| hc4 | Mirror a notice into a session transcript, then inspect the stored role | Role is `"user"`, never `"assistant"` | Drop the explicit `role="user"` kwarg from `mirror_to_session` | `tests/native/test_notifications.py::test_flush_real_estop_sentinel_blocks_mirror_text_at_its_own_choke_point` (estop-adjacent); direct role-assertion test is `test_flush_fences_and_shares_one_string_across_deliver_and_mirror` |
| hc5 | Caveat text placement relative to the fence | Caveat always after the closing fence, unconditionally | Move `_UNTRUSTED_CAVEAT` before the fence | Covered implicitly by hc1-hc3 (string-shape assertions); explicit placement-only test is **TODO** |

### (d) Authorization / allowlist

| # | Probe | Expected | Kill mutation | Existing test |
|---|---|---|---|---|
| hd1 | Configure `allowed_agents: ""` explicitly | Every sender denied | Treat `""` the same as an absent key | `tests/native/test_adapter.py::test_explicit_empty_allowed_agents_denies_everyone` |
| hd2 | Omit `allowed_agents` entirely | Falls back to the documented default roster | Make an absent key also deny everyone (breaks the documented default) | `tests/native/test_adapter.py::test_absent_allowed_agents_key_falls_back_to_the_documented_default` |
| hd3 | A peer sender not on the allowlist sends a message | Message refused by `should_accept_message`, not delivered | Remove the allowlist membership check | `tests/native/test_routine_events.py::test_disabled_config_keeps_routine_path_absent_and_never_expands_peer_allowlist` (adjacent); a direct `should_accept_message` unit test is **TODO** |
| hd4 | Break the import the estop check depends on (simulate `mupot_gateway.adapter` unimportable from the legacy path) | Fails safe (refuses/warns), does not silently skip the check forever | Import unconditionally without the try/except fallback | `tests/native/test_estop_egress_gate.py::test_legacy_inbox_stream_deliver_fails_closed_when_agent_estop_unimportable` |

### (e) Pause/e-stop

| # | Probe | Expected | Kill mutation | Existing test |
|---|---|---|---|---|
| he1 | Engage the real estop sentinel, then run a poll loop iteration | No lease, no replay, no flush — the tick does nothing but sleep/backoff | Remove the `_estop_engaged()` check from the top of `_poll_loop` | `tests/native/test_estop_lease_gate.py::test_pre_lease_pause` |
| he2 | Engage the sentinel mid-message (after lease, before ack) | Message deferred via `_EstopDeferred`, lease left to expire naturally, no partial state written | Remove the mid-lease `_estop_engaged()` check in `_process_leased_message`/`_deliver` | `tests/native/test_estop_lease_gate.py::test_mid_message_pause` |
| he3 | Engage the sentinel during outbox replay (`_replay_routine_events`, `_replay_reply_outbox`) | Both defer without acking/transmitting | Remove either replay function's own gate | `tests/native/test_estop_replay_gate.py::test_replay_routine_events_defers_without_acking_or_processing_while_paused`, `::test_replay_reply_outbox_defers_without_transmitting_while_paused` |
| he4 | Engage the sentinel during a live interim `send()` | Deferred, not transmitted | Remove the `send()` interim-path gate | `tests/native/test_estop_replay_gate.py::test_live_interim_send_defers_without_transmitting_while_paused` |
| he5 | `_EstopDeferred` raised from inside `_replay_routine_events`/`_replay_reply_outbox` reaches `_poll_loop` | Treated as a pause (retry later), not folded into the generic protocol-error/quarantine path | Reorder the `except` clauses so a broad `except Exception` catches it first | `tests/native/test_estop_replay_gate.py::test_poll_loop_treats_replay_routine_events_estop_deferred_as_a_pause`, `::test_poll_loop_treats_replay_reply_outbox_estop_deferred_as_a_pause` |
| he6 | Engage the sentinel on the legacy (non-native) inbox-stream `deliver()` path | Refuses/drops with a log line, does not inject into the human session | Remove the legacy path's own estop check | `tests/native/test_estop_egress_gate.py::test_legacy_inbox_stream_deliver_refuses_inject_while_real_estop_engaged` |
| he7 | Pause engaged, a DLQ append occurs, then the same message is reprocessed within the same pause | DLQ append is idempotent by message id — no duplicate row | Remove the "already in DLQ" pre-check before the append | `tests/native/test_estop_observability.py::test_sender_policy_dlq_append_is_idempotent_across_a_pause_before_the_ack`, `::test_invalid_ack_envelope_dlq_append_is_idempotent_across_a_pause_before_the_ack` |

### (f) Observability

| # | Probe | Expected | Kill mutation | Existing test |
|---|---|---|---|---|
| hf1 | Pause engaged, trigger the same choke point twice within one pause window | Exactly one log line, not two | Remove the `_ESTOP_PAUSE_LOG_SITES` dedup | `tests/native/test_estop_observability.py::test_refuse_ack_if_estop_engaged_logs_once_per_pause_window`, `::test_process_leased_message_top_gate_logs_once_per_pause_window` |
| hf2 | Pause lifts, then re-engages; trigger the same choke point again | A NEW log line for the new window | Never clear `_ESTOP_PAUSE_LOG_SITES` on pause-lift | Covered by the same tests as hf1 asserting the clear path fires (`_clear_estop_pause_log_sites`) — explicit "second window logs again" case is **TODO** |
| hf3 | `is_engaged()` itself raises (check failure, not a real pause), repeatedly | Warns once per distinct failure window, not once per call | Remove `_ESTOP_CHECK_FAILSAFE_WARNED` gating | `tests/native/test_estop_observability.py::test_estop_engaged_failsafe_warns_once_per_failure_window` |
| hf4 | A final reply is refused due to pause | `SendResult.error` names the pause (`"estop_paused"`), plus a WARNING log | Drop the `except _EstopDeferred` clause naming the reason in `send()` | `tests/native/test_estop_observability.py::test_transmit_final_reply_choke_point_logs_once_and_send_result_names_the_pause`, `::test_refused_final_reply_also_warns_once_per_pause_window_naming_request_id` |
| hf5 | A notification is queued but never confirmed delivered/mirrored | Discoverable via a stranded-state scan, not silent | Remove `stranded_notifications()`/the startup warning scan | **TODO** — added post-round-1 fix; no dedicated test found in this pass |

## Notes on gaps

Every **TODO** above is a real absence, not a formatting placeholder — write the test
before treating the clause as proven. Several TODOs need infrastructure this repo does not
currently have (fault injection between two specific writes, a harness-level crash/restart
harness) rather than a quick addition; scope those as their own follow-up rather than
rushing a vacuous version to close the row.

## Sources read

- mupot `main` @ `49a344aa`: `tests/telegram-project-onboarding.test.ts`,
  `tests/im-webhook-idempotency.test.ts`, `tests/im-webhook.test.ts`
- `Mumega-com/mupot-plugin` @ `6c86c2b0`: `tests/native/test_estop_lease_gate.py`,
  `test_estop_egress_gate.py`, `test_estop_replay_gate.py`, `test_estop_observability.py`,
  `test_notifications.py`, `test_adapter.py`, `test_routine_events.py`
