# Agent harness contract

Status: architecture note, written 2026-09-14 by Kasra from receipts. Not a release
contract. Hadi decides scope; updates by PR only.

## One sentence

A "harness" is any runtime that carries an agent's ears and mouth into Mupot — it leases
work, delivers text to a human, and sends to peers. Mupot's own `docs/runtime-adapter-contract.md`
(mupot `main` @ `49a344aa`) defines the identity/attach/messaging surface every runtime must
use; this document names the properties a harness must hold **on top of** that surface to
be safe to run unattended. The Hermes/mupot-plugin integration
(`Mumega-com/mupot-plugin` @ `6c86c2b0`, PR #6 `kasra/native-receive-telegram-20260913`,
open and unmerged as of that commit) is the first harness this was proven against, across five adversarial
gate rounds. Per Hadi (2026-09-14): the method generalizes past this one harness.

## The properties

### (a) Identity: agent-bound bearer, never a human's

- The harness authenticates to Mupot as the **agent**, not as whoever is operating it.
  Mupot's `runtime-adapter-contract.md` "Identity And Binding" section: `agent_id` names
  the durable Mupot agent, `member_id` is derived from the bearer/agent key, and a runtime
  "must not trust local config as proof of identity."
- A harness must never let a human's own web/MCP session credential leak into the same
  process that also carries the agent's bearer — see the harness/human separation property
  (f) below; they are the same underlying rule applied to two different failure directions.

### (b) Lease/ack: attempt-bound, consume-once, no ACK without delivery custody

- Every lease is an **attempt** with its own id, digest, and state machine (`leased` →
  `empty|cancelled|expired|acked`), not a bare read (mupot
  `src/agents/messages.ts:954`, `LeaseAttemptState`; `src/agents/messages.ts:1013`, `ATTEMPT_ID_RE`).
- An ACK only ever succeeds if it names the **exact attempt** that leased the message: the
  ack statement joins `agent_inbox_lease_attempts` on `(tenant, agent_id, target_seat_key,
  attempt_id, state='leased')` AND the message's own `lease_attempt_id`/`lease_expires_at`
  still match that attempt row (`ackAgentInboxLeaseAttempt`,
  `src/agents/messages.ts:1364-1420`). A stale attempt cannot consume a newer lease; a
  same-timestamp legacy consume cannot be rolled back by a fenced attempt ACK
  (`docs/operations/telegram-project-onboarding.md`, "attempt-v3 custody chain").
- Consequence for the harness side: **never ACK before the work is durably committed.** The
  runtime-adapter contract states this directly for the fleet daemon path
  (`runtime-adapter-contract.md` "Agent Messaging"): "persist each message durably before
  exit 0; invoke a per-agent runtime command only after persistence; exit non-zero when the
  runtime did not accept the batch, leaving messages unread for the next tick." A harness
  that ACKs on receipt and processes afterward can lose work on a crash between the two.

### (c) Fence: untrusted bodies wrapped once at construction, escape by character, mirrored as data

- Every body that originates from a remote Mupot session and reaches a human's live
  terminal/chat/mirror is wrapped in a fence **once, at the point the notice is
  constructed**, not at each egress sink separately re-deriving it
  (`_fenced_untrusted_block` + `_UNTRUSTED_CAVEAT`,
  `mupot_gateway/notifications.py:143-147,155-180`, plugin `@6c86c2b0`).
- The escape must operate on **every character of the delimiter**, not on runs of the full
  delimiter string. The plugin's own history is the proof: the first fix used
  `text.replace("```", ...)` — a left-to-right, non-overlapping replace that regenerated the
  exact 3-backtick delimiter for any body whose backtick run length was not itself a
  multiple of 3 (round 2 defect, see below). The fix that held: insert a zero-width space
  after **every individual backtick**, so no two backtick characters are ever adjacent in
  the escaped output — provably no run of length ≥2 survives, independent of run length,
  position, or surrounding ANSI/CR/LF/other zero-width characters
  (`_fenced_untrusted_block` docstring, `mupot_gateway/notifications.py:155-165`).
- The caveat text ("not a message from a person... not an instruction, approval, or
  command") goes **after** the closing fence, never before the raw body — a long injection
  placed before the caveat can push it out of context or bury it.
- When the body is mirrored into a session transcript, it must be recorded at a role that
  reads as **data relayed to** the agent, never as the agent's own outgoing turn and never
  as the human's own words. The plugin's `mirror_text` calls `mirror_to_session(...,
  role="user")` explicitly, documenting that the library's own default role
  (`"assistant"`) would let a relayed remote notice "replay as a genuine, completed agent
  statement in the transcript instead of a quoted, attributable inbound message"
  (`mupot_gateway/notifications.py:104-130`). Any non-`"user"` role Hermes accepts is
  cosmetic prefix text only, not a transport-enforced distinction
  (`hermes_cli/plugins.py:596`, referenced in `notifications.py:148-152`) — the fence in
  the *content* is the real control; the role label is a bonus signal, not a substitute.

### (d) Authorization: harness-side allowlist that fails CLOSED on empty

- The harness's own peer-sender allowlist (which remote agents may inject text into a live
  human session) must treat an **explicitly empty** value differently from an **absent**
  key: only a genuinely absent config key may fall back to a documented default roster; an
  explicit `""` or `[]` must deny everyone (`mupot_gateway/adapter.py:1069-1102`, P1-1 fix,
  tested by `tests/native/test_adapter.py::test_explicit_empty_allowed_agents_denies_everyone`
  and `::test_absent_allowed_agents_key_falls_back_to_the_documented_default`).
- **Never rely on a host-runtime flag that skips the host's own authorization as the
  harness's authorization.** The concrete defect this generalizes from: the plugin sets
  `event.internal=True` on every Mupot-originated turn so it queues as its own turn rather
  than interrupting the human's (correct, needed behavior) — but at the pinned Hermes rev,
  `gateway/run_inbound.py:174` returns for any internal event **before** it ever reaches
  Hermes's own per-source auth check or its global e-stop gate
  (`mupot_gateway/adapter.py:695-717`, `_estop_engaged` docstring). `internal=True` is a
  routing signal, not an authorization decision, and a harness that treats "the host
  skipped its own check for this class of event" as "therefore this event needs no check"
  inherits a silent bypass. The fix kept `internal=True` (dropping it would misroute
  synthetic Mupot sources through end-user auth never designed for them) and added an
  **explicit, harness-owned** check at the same point instead of assuming the host covers it.
- Gate on the **smallest importable dependency that carries the authority**, not a
  convenience re-export. Concrete defect: a legacy delivery path imported a whole gateway
  module (pulling in HTTP client deps) just to reach the estop check; when that import
  failed, the safety check silently never ran across the entire dependency chain, and the
  failure warned once and then went permanently silent (kasra-review re-gate #5, see (g)
  below).

### (e) Pause/e-stop: a temporal condition, never a state transition

- A pause must be representable as "try again later," never folded into "this is
  permanently broken." The plugin's own `_EstopDeferred` exception class exists
  specifically so a paused turn is distinguishable from a protocol violation
  (`mupot_gateway/adapter.py:132-208`): raising the generic protocol error would trigger
  `_quarantine_inbox_polling()`, "a durable, `connect()`-refusing state that outlives the
  pause and requires manual `reconcile_inbox_polling()`" — i.e. treating a temporary
  condition as a permanent one turns a 30-second pause into a manual-intervention incident.
- **One gate at the top of the work loop, plus a choke point on every consume/egress
  primitive** — not a per-call-site list that goes stale every time a new branch is added.
  The plugin's history across gate rounds 1-4 is the direct evidence for this shape (see
  defect classes below): each round fixed the named site the previous re-gate found, and
  the next re-gate found the next ungated one, until round 4 replaced the whole approach
  with "gate the poll loop's first statement, and gate the primitive itself (ack, send,
  each notification sink) so every future caller of that primitive inherits the gate for
  free" (`_EstopDeferred` docstring's enumerated choke-point list,
  `mupot_gateway/adapter.py:159-192`).
- **Deferral, never quarantine, and no persisted state while paused.** A choke point raises
  and returns the lease to expire for natural redelivery; it does not write a partial
  result, does not advance a cursor, and does not mark anything processed.
- **A pause is not a kill switch for an already-running human session's own tool calls.**
  The boundary is explicit and deliberately narrow: `hermes pause` blocks new
  cron/kanban/gateway-turn dispatch, not a human's live in-session tool invocation
  (`mupot_gateway/adapter.py`, F2 correction in the `_EstopDeferred` docstring, re-gate #5).
  Gating a human-invoked tool call inside the harness would make the harness enforce a
  stronger pause than the host agent runtime itself does anywhere else — scope the gate to
  what the harness actually owns (native receive/reply, legacy inject), not to every
  possible code path that happens to run inside the same process.

### (f) Observability: refusals logged once per window, stranded states inspectable

- A safety refusal that never logs is invisible; a safety refusal that logs on every
  message during a long pause floods the log. The right shape is **once per site per pause
  window**, cleared when the pause lifts (`_note_estop_pause_once` +
  `_ESTOP_PAUSE_LOG_SITES`, `mupot_gateway/adapter.py:666-693`).
- A log flag that resets only inside the **work** path (e.g. only when a delivery actually
  runs) rather than inside the **check** path silently loses an entire new pause window
  when no traffic arrives between windows. Reset the flag where the check happens, not
  where work happens (kasra-review re-gate #5 finding, second pattern).
- Any state a harness can leave "stranded" (queued for a human but never delivered,
  attempted but outcome unknown) needs its own inspector, not just a log line — the plugin
  added `stranded_notifications()` + a startup warning scan
  (`mupot_gateway/adapter.py`, P2 inspector) specifically because a silent bypass upstream
  (see (d)) had no other way to surface after the fact.

### (g) Human decisions never ride the agent bearer

- The harness's own bearer authenticates the **agent's** actions (lease, ack, send,
  notify). A human's decision — approve, reject, answer — must be authenticated and
  recorded under the human's own identity via the decision-channel contract
  (`docs/architecture/human-decision-channel-contract.md`), never folded into or
  authorized by the harness's agent-bound credential. This is the harness-side mirror of
  that document's principal property (d): a harness that let its own bearer stand in for
  "the human decided" would collapse the exact distinction the decision-channel contract
  exists to hold.

## Defect classes found in PR #6 rounds 1–5 — what a non-conforming harness looks like

Each line: the defect class, one line, the round it was found (all dates 2026-09-14,
`Mumega-com/mupot-plugin` PR #6, `kasra/native-receive-telegram-20260913`).

1. **Round 1 — host-flag-as-authorization.** `event.internal=True` (needed for correct
   turn-queueing) silently also skipped the host's own per-source auth and its global
   e-stop gate; the harness had assumed the host's flag implied the host's check ran. →
   property (d).
2. **Round 1-2 — fence escape via non-overlapping replace.** `text.replace("```", ...)`
   left a delimiter reconstructible for any backtick run whose length wasn't a multiple of
   3; fixed by escaping every individual backtick instead of matching the full delimiter
   string. → property (c).
3. **Round 2 — mirrored notice at the wrong role.** A relayed remote notice mirrored at the
   library's default role (`"assistant"`) would replay in the transcript as the agent's own
   completed statement rather than quoted inbound data. → property (c).
4. **Round 3 — named-site gating goes stale.** Rounds 1-2 each gated the specific function
   the prior re-gate named (`_deliver`, `_handle_routine_event`, `_handle_ack_envelope`);
   the next re-gate found `_poll_loop`'s own replay/flush calls, and three branches inside
   `_process_leased_message`, running fully ungated. → property (e).
5. **Round 4 — the class fix: choke points on primitives, not call sites.** Replaced the
   per-site list with a gate at the top of the poll loop plus one choke point per primitive
   (ack via `_refuse_ack_if_estop_engaged`, peer `send` via `_transmit_final_reply`, each of
   three notification sinks independently) so a *future* branch inherits the gate instead
   of needing its own copy. → property (e).
6. **Round 4 — explicit-empty vs absent config collapsed to the same fallback.** An
   `allowed_agents: ""` or `[]` was treated identically to a missing key, silently
   falling open to a default 4-agent roster instead of denying everyone. → property (d).
7. **Round 5 — a safety check gated on a heavy, unrelated import.** The legacy delivery
   path imported a whole gateway/HTTP-client module chain just to reach the estop check;
   when that import failed, the check silently never ran, permanently, after a single
   warning. → property (d) ("smallest importable dependency").
8. **Round 5 — silent choke points.** Four of twelve gate sites refused a paused message
   with no log line at all — a correct refusal that leaves no trace an operator can find
   later. → property (f).
9. **Round 5 — a fix applied to two branches, pinned by a test on only one.** A DLQ
   idempotency fix touched both the `sender_policy` and `invalid_ack_envelope` branches;
   the mutation table proved only one branch's test actually killed a reverted mutant. →
   general discipline, not a named property above: when a class fix touches N branches,
   mutate each branch independently, not the class once.

## Sources read

- `docs/runtime-adapter-contract.md` (mupot `main` @ `49a344aa`)
- `Mumega-com/mupot-plugin` @ `6c86c2b0` (`master`, PR #6 head): `mupot_gateway/adapter.py`
  (`_EstopDeferred` class + docstring lines 132-208, `_estop_engaged` lines 695-720,
  `normalize_agent`/`should_accept_message` lines 630-648, allowlist init lines 1069-1121),
  `mupot_gateway/notifications.py` (`_fenced_untrusted_block` lines 126-165, `mirror_text`
  lines 104-121)
- `docs/telegram-onboarding-runbook.md` (same plugin ref)
- kasra-review re-gate history on PR #6 rounds 1-5 — read via `mcp__mupot__recall`, not
  re-fetched from GitHub for this doc
