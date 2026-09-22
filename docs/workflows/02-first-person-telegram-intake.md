# First-person intake on Telegram

Mubot's first-contact intake for a bound member it has never talked to: five fixed
questions, answers written to the member's private home memory, then a **proposal**
(never a grant) for project write access. FP-01 Slice 2, mupot#1443. Implementation lives
in the **mupot-plugin** repo (`Mumega-com/mupot-plugin`, `first_person.py`, checked at
`origin/master` commit `8111ae3`), not in mupot itself — mupot's side is a small
additive contract on the `/im/webhook` reply (`src/im/index.ts`, `origin/main` `3c706069`).

## Trigger

A bound member's first private-DM message to Mubot for which mupot's `/im/webhook`
response reports `intake_state: "pending"` (`src/im/index.ts:1097`, type `IntakeState =
'none' | 'pending' | 'complete'`). The plugin never decides "is this a new member" itself
— it probes mupot on every private DM (`_status_probe_body`, `first_person.py:853-860`,
`{"kind": "first_person_status_probe", "user_id", "chat_id"}`) and acts only on the
server's classification.

## Actor(s)

The human (a bound Telegram member), Mubot's native Telegram `MessageHandler`
(`register_first_person_skill`, `first_person.py:350`), and mupot's `/im/webhook`
(`src/im/index.ts`). Mubot's LLM turn never runs during this flow — `first_person.py` is
deterministic plugin code, and the skill's own manifest declares `tools: []` with
`disallowed_tools: [project_squad_set, grant_agent_capability, grant_gate_capability,
manage_access]` (`skills/first-person/SKILL.md`).

## Tool/route sequence

1. **Status probe** — `resolve_member_status` (`first_person.py:863`) calls the
   authenticated `/im/webhook` surface with the probe body above. mupot's
   `memberIntakeEnvelope` (`src/im/index.ts:1109-1145`) is the one place that computes
   `bound`/`member_id`/`home_squad_id`/`intake_state` from a `telegram_chat_id` lookup, a
   home-squad lookup, and one completion query. `intake_state` is `"complete"` only on a
   **decided** outcome: a `task_verdicts` row bound via `proposal_id` (migration 0159) to a
   `project_access` proposal naming this member, **or** a `project_access_grant_receipts`
   row with `kind = 'grant'` (`src/im/index.ts:1207-1222`). A *rejected* verdict still counts
   as complete (it is a decision, not a grant); a merely-existing, undecided proposal does
   not — the earlier existence-based derivation was a cross-member denial of service, since
   any proposer could lock a victim's intake to `"complete"` before any human decided
   (comment, `src/im/index.ts:1171-1180`). A later `kind = 'reintake_authorized'` receipt
   flips the state back to `"pending"` (`:1220,1226-1227`). If migrations 0159/0160 are not
   yet applied, the query is caught and the state degrades to the conservative `"pending"`
   default, never a fabricated `"complete"` (`:1224,1232`). Plugin-side, any
   missing/malformed field resolves to `intake_state: "unknown"`, treated identically to
   "not pending" (`first_person.py:887-891`).
2. **Home squad** — created by mupot alone (see [01 — human onboarding
   door](./01-human-onboarding-door.md) and [08 — home squads and admin-in by
   receipt](./08-home-squads-admin-in-by-receipt.md)); the plugin never calls a
   home-creation tool itself. A bound member with a null `home_squad_id` is left
   untouched until a later probe reports one (`first_person.py`'s design ruling (a),
   header comment).
3. **The five questions**, asked in order, `FIRST_PERSON_QUESTIONS` (`first_person.py:146-155`).
4. **Answer capture** — `_handle_answer` (`first_person.py:2221`): sanitize
   (`_sanitize_answer`) *before* the credential-shape check
   (`_looks_like_credential`) *before* the write — pipeline order is load-bearing (round-3
   P0-A, comment at `first_person.py:2249-2257`). Escape words (`_ESCAPE_WORDS`) pause
   without storing; text shaped like a verdict command (`is_verdict_shaped`) is not
   captured at all and falls through to the host's own decision path (#1425's flow, see
   [07](./07-human-decision-channel.md)).
5. **Write** — `squad_remember` (`first_person.py:2328-2332`), args
   `{squad_id: home_squad_id, text: cleaned_answer, concepts: [question_id]}`. This is the
   only tool in `FIRST_PERSON_ACTIONS` (`mupot_operator.py:90-96`, frozenset
   `{squad_remember, routine_proposal_submit, task_create}`) that stores an answer.
   `squad_remember` is an INSERT, never an upsert; the response's own `engram_id` is the
   confirmation — no read-back is trusted (recall is eventually consistent in production).
6. **Propose, never grant** — once all five questions are answered,
   `_submit_proposal` (`first_person.py:2485`) calls `routine_proposal_submit`
   (`first_person.py:2570-2589`) with `action.kind: "project_access"` — the same tool and
   `kind` landed by [03 — project access chain](./03-project-access-chain.md) (mupot#1490).
   A digest keyed on `first-person:{member_id}:{project_id}` makes a retried submission
   idempotent on the mupot side. On failure, the plugin backs off and retries
   (`_retry_proposal_if_due`) — it never writes the completion marker on a failed or
   unidentifiable submission (round-2 P0-3, `first_person.py:2607-2609`).

## Human gate

There isn't one *inside* this flow — first-person only ever **proposes**. The actual
human decision is [03's](./03-project-access-chain.md) `task_verdict`/`task_verdict_reverse`
gate: a different human (the project's captain/gate owner), on a different surface,
approves or rejects the access. The identity gate that *is* local to this flow is upstream
of it: `intake_state` can only be `"pending"` for a chat mupot already resolved to a
`member_id` via `telegram_chat_id` (`src/im/index.ts:1154`) — an unbound sender gets
`bound: false`, `intake_state: "none"`, and first-person never engages them at all.

## Receipt(s) written

- `squad_remember`'s underlying `remember()` write — one memory row per question, scoped to
  the member's home squad, tagged with the question id as its concept. No separate
  first-person-specific receipt table on the mupot side; the memory rows themselves are the
  record of what was asked and answered.
- A **local, non-durable** completion marker (`runtime.finish(chat_key,
  proposal_id=proposal_id)`, `first_person.py:2647`) recording `{question_id: engram_id}`
  pairs, written once, only after a successfully submitted proposal — never a transcript,
  never per-answer state, never the answer text itself (design ruling (b), header comment
  `first_person.py:71-84`).
- The `project_access` proposal itself lands in [03's](./03-project-access-chain.md)
  `project_access_grant_receipts` table once a human decides it.

## What the person sees

The five questions, verbatim (`FIRST_PERSON_QUESTIONS`, `first_person.py:146-155`):

1. "What's your name?"
2. "What do you do?"
3. "Which project are you here for?"
4. "What's the first thing you want done?"
5. "Anything the team should know about you? (nothing about passwords, keys, or account
   details, please)"

Other replies: "Thanks -- I've sent your access request to the team for a decision."
(`_COMPLETE_REPLY`, `first_person.py:365`) on successful submission; "Please answer the
current question." (`_UNRELATED_ANSWER_REPLY`, `:408`) on an empty/unusable message;
"No problem -- message me whenever you're ready to continue." (`_PAUSED_REPLY`, `:423`) on
an escape word; a credential-refusal reply followed by the current question again
(`_CREDENTIAL_REPLY`, `:371`) if the answer looks like a secret; "Opening your space — one
moment, I'll come back to you." (`_HOME_NOT_READY_REPLY`, `:417`) while waiting on a home
squad; "Your request is awaiting the humans." (`_AWAITING_HUMANS_REPLY`, `:413`) while a
submitted proposal is pending decision.

## Tests that pin it

`mupot-plugin`: `tests/test_first_person.py` (4,325 lines — sanitize-before-credential-check
ordering, escape/pause, verdict-shaped fall-through, credential refusal, retry/backoff,
completion-marker discipline, engram reuse on resume). `mupot`:
`tests/im-intake-state.test.ts` (server-side `intake_state` computation).

## Known gaps

- The mupot-side contract (`intake_state`, `home_squad_id` on the webhook reply, and the
  `routine_proposal_submit` `"project_access"` kind) had to land before this plugin PR could
  merge — both sides now confirmed present at the commits cited above, but they are two
  repos on two independent release cadences; a mupot-side regression on either field
  silently degrades every open intake to `"unknown"` (fail-safe, no data loss, but no
  progress either) with no cross-repo test to catch the drift.
- No test independently confirms `squad_remember`'s memory rows are actually excluded from
  org/project-wide recall — that isolation is asserted by mupot's own `tests/home-memory-isolation.test.ts`
  (see [08](./08-home-squads-admin-in-by-receipt.md)), not by anything in this flow.
- The plugin repo tracks several adversarial-gate round numbers in its own history (PR #17,
  #19, #23, #24, #25, #26, #28) — this doc reflects the code at `master`@`8111ae3` only;
  check `Mumega-com/mupot-plugin` directly for anything landed after that commit.
