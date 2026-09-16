# Human decision channel contract

Status: architecture note, written 2026-09-14 by Kasra from receipts on mupot PR #1407
(`kasra/telegram-project-onboarding-20260913`, merged to `main` at `49a344aa`) and its
gate history. Not a release contract. Hadi decides scope; updates by PR only.

Updated 2026-09-15 (round 6, Athena gate `efdb0b08`) for mupot PR #1411
(`kasra/telegram-bind-existing-member-20260914`): the "net-new humans only" gap named in
clause (g) below is closed. This revision replaces round 4's actor/target-ceiling
description (a shape round 5 reverted, see `src/auth/capability.ts`'s own
`exceedsTargetRankCeiling` history) with the shape that actually shipped — see clause (a)
below — and corrects clause (g)'s unbind description to match round 5's self-unbind
addition.

## One sentence

A "decision channel" is any medium through which a human can join a Mupot project and
cast a verdict Mupot then treats as binding. Telegram/Hermes is the first instance, not
the design. Per Hadi (2026-09-14): "it's not limited to Telegram and Hermes — it's about
the method of communication and the harness."

## Why this document exists

`docs/operations/telegram-project-onboarding.md` and `src/im/index.ts` implement one
concrete channel. Five gate rounds on PR #1407 (kasra AMBER fix, Athena addendum A-H, two
adversarial re-gates) found the same class of defect appearing at different layers:
identity read from the wrong place, a fence bound to a stale clock, a role coarsened
until it could never satisfy a gate. This document names the properties those rounds
converged on, so the next channel (Slack, WhatsApp, email, SMS) is graded against a
checklist instead of re-discovering each defect by hand. It is a decision record, not a
promise that any current line of code satisfies every clause below — clause (g) names
the known gaps.

## The properties, in order of where an attacker or a race would hit them

### (a) Invite binding

A human enters a project through one **single-use, server-hashed** invitation:

- The raw secret (`pairing_code`) is returned to the creator exactly once and never
  stored; only its SHA-256 digest (`pairing_hash`) persists
  (`src/members/project-invites.ts:552-564,577-591`, `createProjectInvite`).
- The claim is one atomic statement (`CLAIM_INVITE_SQL`,
  `src/members/project-invites.ts:337-371`) with conjuncts that must all hold in the
  SAME statement, not a JS pre-check that can race it:
  - single-use: `accepted_at IS NULL`
  - not expired: `pairing_expires_at > ?`
  - project active: `EXISTS (... projects.status = 'active')`
  - the exact squad-project edge still exists: `EXISTS (... project_squad_access ...)`
  - the authenticated transport receipt is in `state = 'processing'` for this exact
    `(tenant, update_id, digest, telegram_user_id)` (the "receipt-processing conjunct")
  - mupot#1411: when the invite carries a `member_id` (binding an EXISTING member's
    Telegram identity instead of minting a net-new one), an additional EXISTS clause
    requires the target row to satisfy `MEMBER_BIND_ELIGIBLE_SQL` (exact non-NULL
    tenant match, `status = 'active'`, Telegram-identity compatible) at claim time —
    see clause (g) below.
- Identity used to claim is the medium's own **immutable** user id (Telegram's
  `message.from.id`), never a display name, username, or any other field the human or
  transport can freely re-supply (`src/im/index.ts:857-872`, `telegramDisplayName` is
  documented COSMETIC ONLY — never identity, authority, or part of the request digest).
- A capability grant can never invite above the inviter's own effective rank. TWO
  distinct paths, per mupot#1411: the **net-new** path (no `member_id` — a fresh member
  is minted, nothing to take over) keeps the original squad-local ceiling
  (`actorRankOnSquad`, `src/members/project-invites.ts`; `cannot_grant_above_own_rank`).
  The **member-bind** path (`member_id` set — attaching Telegram to an EXISTING
  identity, itself a credential mint) requires ORG-scope admin
  (`actorRankOnScopeFor(env, auth, 'org', null)`) AND that the target does not outrank
  the actor ANYWHERE (`exceedsTargetRankCeiling`, `src/auth/capability.ts`) — the two
  sides of that comparison are DELIBERATELY ASYMMETRIC, not the same quantity, and this
  is the round-5 shape after round 4 shipped the symmetric version and then had to revert
  it as its own escalation (see the round-5 note in `exceedsTargetRankCeiling`'s own
  docstring): the **target** is GLOBAL (`targetMaxRankAcrossScopes` — the maximum of every
  capability-grant row the target holds on ANY scope, unioned with their role-plane rank
  via the `lower(email)` members↔users bridge), while the **actor** is ORG-SCOPE-LOCAL
  (`actorRankOnScopeFor(env, auth, 'org', null)` — an org-scope capability grant unioned
  with the session's own `auth.role`, never inflated by a grant the actor happens to hold
  on some unrelated squad or department). The check refuses iff the target's global rank
  exceeds the actor's org-scope-local rank; a principal is always self-exempt from
  outranking themselves, independent of either side's computation.

Adversarial finding this closes: PR #1407's own re-gate proved two of the `EXISTS`
conjuncts (`projects.status='active'`, the `project_squad_access` edge) are **singly
expressed** — no JS twin, single caller — and load-bearing: deleting either lets a
redemption into an archived project or a revoked edge succeed and write a `capabilities`
row. A conjunct with no test proving it is load-bearing is not a fence, it is decoration.

### (b) Ingress authority

The transport boundary is a **shared secret, verified before the body is JSON-parsed**
— not before the raw bytes are read at all. The actual order (`src/im/index.ts:899-918`,
step 4 at `:921`) is: (1) size-cap the declared and actual byte length, (2) UTF-8-decode
with `fatal: true`, (3) *then* compare the secret, (4) `JSON.parse` only after the secret
passes. Rejecting an oversized or malformed-encoding body cheaply, before spending a
secret comparison on it, is deliberate — but "verified before any parsing" overstated
it: the size cap and UTF-8 decode are themselves a form of parsing the body, and both
run before the secret check, not after.

- `IM_WEBHOOK_SECRET` compared with `timingSafeEqual`
  (`src/im/index.ts:914-916`, `src/lib/crypto.ts`), never a plain `===`.
- Unconfigured secret seals the endpoint closed with `503 webhook_not_configured`
  (`src/im/index.ts:911-913`) — an absent secret must never default to "accept
  everything," it must default to "accept nothing."
- Mismatched or missing secret returns `401` (`src/im/index.ts:914-917`) before the body
  is parsed as JSON, but after the size cap and UTF-8 decode above.
- Body size is capped before decode (`IM_WEBHOOK_MAX_BODY_BYTES = 64 * 1024`,
  `src/im/index.ts:66,900-905`) and UTF-8-validated with `fatal: true`
  (`readCappedBody`, `src/im/index.ts:72-82`).
- **Duplicate predicate, not yet unified:** `src/channels/adapters/telegram.ts`'s
  `ChannelAdapter.verify` (`:47-52`) implements the identical
  secret-header-comparison logic against the same
  `X-Telegram-Bot-Api-Secret-Token` header name (`src/im/index.ts:914`,
  `src/channels/adapters/telegram.ts:49`), and is live in production via
  `/channels/telegram/...` (`src/channels/index.ts:776`, mounted alongside
  `/im/webhook` in `src/index.ts:110,113`) — this is not a dead duplicate, both
  paths are reachable today. Each copy has its own test suite
  (`tests/im-webhook.test.ts` vs `tests/telegram-adapter.test.ts`), so a fix to one
  does not provably fix the other. Filed as mupot#1412
  (two-copies-of-one-predicate class) rather than folded silently into this doc.

### (c) Replay

Every accepted update reserves **one row per `(tenant, update_id)`** before any
privileged intent is parsed or acted on:

- `reserveTelegramUpdate` (`src/im/index.ts:950-951`, `src/im/telegram-receipts.ts`) is
  called before `handleImMessage`. A reservation failure returns `409` immediately.
- The reservation is keyed on a **digest** of `(update_id, telegram_user_id, chat_id,
  text, forwarding)` (`canonicalJsonDigest`, `src/im/index.ts:943-949`). The same
  `update_id` replayed with a different principal, text, or forwarding marker computes a
  different digest and returns `409 update_conflict` — it does not silently overwrite the
  first reservation or flip a decision already recorded.
- A row in `processing` (uncertain outcome, e.g. after a Worker restart) is **not**
  permission to retry or delete; it stays fenced until an operator reconciles the domain
  receipt (`docs/operations/telegram-project-onboarding.md`, "Receipts, restart, and
  retry interpretation").
- The reservation is never released or replaced after an uncertain side effect
  (`src/im/index.ts:956`, comment: "Never release or replace the reservation after an
  uncertain side effect").

### (d) Principal

The verdict is written under **the human's own resolved identity, re-checked at decision
time**, never a service or agent principal:

- Identity is derived exclusively server-side from `members.telegram_chat_id`
  (`memberForChat`, `src/im/index.ts:93-105`); it is never read from message text.
- `memberAuth` (`src/im/index.ts:400-403`) builds a flat `AuthContext` with
  `role: 'member'` (always — never `'admin'`/`'owner'`) and the member's **live,
  re-resolved** capability grants (`resolveCapabilities`, called fresh on every
  message — `src/im/index.ts:356`).
- `/approve` and `/reject` route through the SAME shared gate evaluator as HTTP and MCP
  (`evaluateVerdictGates`, `src/tasks/index.ts:1417`), not a channel-local hand-rolled
  check. `writeVerdict` records `decidedBy: member.id` (`src/im/index.ts:684`) — the
  deciding principal is always the member, never the assignee agent, never a system actor.
- Capability, task status (`review`), gate ownership, and conflict-of-interest
  (`memberOwnsAssigneeAgent`, `src/im/index.ts:583-597`) are all re-read at the moment of
  decision — an already-displayed `/approve <id>` command is not a durable grant if
  capability was revoked in between (`docs/operations/telegram-project-onboarding.md`,
  "Suspension, revocation").

Known behavior change, not a bug: because `memberAuth` hardcodes `role: 'member'`, **no
principal can approve `gate:agent-self-completion` over this channel**, on any basis —
role or capability grant row — because `evaluateVerdictGates`'s check for that one gate
(`legacyOwnerAdmin(auth)`, `src/tasks/index.ts:93,1425-1433`) tests only the coarse role
(`role === 'owner' || role === 'admin'`), which is frozen at `'member'` here and never
reads `AuthContext.capabilities` for this one gate at all. Committed, not manual,
evidence: `tests/im-verdict-gates.test.ts:98` grants a **member**-type
`gate:agent-self-completion` capability row directly (the exact grant the check is
supposed to skip for this gate) and the approve is still refused
(`expect(reply).toMatch(/permission/i)`); `tests/im-verdict-gates.test.ts:114` grants an
**org-scope `admin`** capability row and is likewise refused
(`expect(reply).toMatch(/permission/)`). Correction to an earlier draft of this
document: there is no committed test exercising an org-scope **`owner`** capability row
specifically for this gate over IM — only `admin` (capability) and a direct `member`-type
gate grant are covered; "owner and admin were both refused" was an overstatement not
backed by a citation. The two committed cases above are sufficient to prove the clause
(the check reads only `auth.role`, so a capability row's *value* — member, admin, or
owner — cannot matter), but a dedicated owner-capability test would close the gap
precisely rather than by inference. This makes the channel strictly narrower than an
authenticated web/HTTP session for that one gate, and brings it to parity with MCP
(`auth.role` is likewise always `'member'` there).

### (e) Fences

The channel accepts a message **only** when all of these hold simultaneously
(`src/im/index.ts:932-934,329,535-537,753-755`):

- `message.chat.type === 'private'` — never a group or channel.
- `message.from.id === message.chat.id` — sender and chat owner are the same immutable id.
- No forwarding marker is present (`forward_origin`, `forward_from`, `forward_from_chat`,
  `forward_date` all undefined). A forwarded command returns a fixed refusal string and
  takes no action, including for the highest-privilege verbs (fleet control, brain
  directives) which check `options.forwarded` a second time at their own call sites.
- Identity never comes from message text. Text only ever carries intent
  (`parseIntent`, `src/im/index.ts:213-281`) — the header comment states this as an
  invariant, matching `src/mcp` and `src/auth`'s discipline.

### (f) Receipts

Three distinct events are recorded **separately**, each idempotent on its own key:

1. **Reservation** — `telegram_webhook_receipts` row keyed on `(tenant, update_id)`,
   states `processing` → `completed`, or a `409` for conflict/in-progress
   (`src/im/telegram-receipts.ts`, read back via
   `docs/operations/telegram-project-onboarding.md`'s SQL block).
2. **Decision** — the domain receipt for the decision itself: `task_verdicts` (append-only,
   `writeVerdict`) for `/approve`/`/reject`, or the Routine answer receipt for `/answer`.
   This write is **not atomic with** the webhook reservation's `completed` stamp — a crash
   between the two leaves the reservation `processing` while the decision is already
   durably recorded; see (c) above ("a row in `processing` ... is not permission to retry
   or delete; it stays fenced until an operator reconciles"). This is a SEPARATE fact from
   `writeVerdict`'s own internal atomicity (the `tasks.status` flip and the
   `task_verdicts` INSERT landing in one D1 batch, mupot#1425 round 4, below) — that gap
   is closed; this one (the reservation's OWN `completed` stamp being a second, later
   write) is not, and is not this channel's to fix here.
3. **Notification** — a Routine entering a human wait separately attempts one delivery
   (`notifyHumanWait`, `src/routines/actions.ts:391-428`) keyed by the stable
   `request_id = routine-human:<run-id>:<action-key>` (`humanWaitRequestId`,
   `src/routines/actions.ts:293-298`). `NotifyHumanWaitOutcome`
   (`src/routines/actions.ts:385-389`) distinguishes `no_recipient` / `no_decision` /
   `delivery_refused` from an actual delivery so a caller can tell "nobody to notify"
   from "notification attempted and failed" — these used to collapse into one boolean
   (Athena addendum H).

### (g) Known gaps at v1 — do not treat these as closed

- **Closed by mupot#1411: existing members can now bind.** A project invite created
  with `member_id` set (instead of `email`) attaches a Telegram identity to an
  EXISTING, active, same-tenant member rather than always minting a net-new one.
  Authority floor: org admin (`actorRankOnScopeFor(env, auth, 'org', null)`) AND the
  target must not outrank the actor anywhere (`exceedsTargetRankCeiling` — target
  GLOBAL standing across every scope unioned with the role-plane rank, actor ORG-SCOPE-
  LOCAL standing only; self-exempt). Unbind — `DELETE /api/members/members/:id/telegram` — is gated
  by that SAME org-admin-plus-ceiling floor **OR by the bound member acting on
  themselves** (self-unbind, added round 5: no capability check at all when the caller
  targets their own member row, since a bind victim otherwise has no way to detach an
  identity attached to them without their say). The admin path remains the same
  credential-revocation authority class as minting it; the self path is a remedy, not a
  widening of what an admin may do to someone else.
  Redeeming an invite whose caller-supplied `email` already belongs to an existing
  member (the ORIGINAL net-new path, no `member_id`) is still refused with
  `member_already_exists` and still makes no partial writes — that path is unchanged;
  only the NEW `member_id` path binds an existing identity. See
  `docs/operations/telegram-project-onboarding.md` for the operator-facing runbook.
- **No invite revocation route.** There is no HTTP route to revoke an unused invite; the
  runbook's only path is a direct, approved DB `UPDATE` expiring one exact row by id.
- **`gate:agent-self-completion` is coarse-role-only over this channel** (see (d) above) —
  not "extended to check real capability grants," simply refused entirely. Extending IM
  to carry this gate is explicit future work, not a silent limitation to paper over.
- **Closed by mupot#1425 round 4: verdict write is atomic.** `writeVerdict` (and
  `buildVerdictStatements`, the shared primitive all four verdict surfaces — HTTP MCP,
  IM `/approve`, and harness-attested origin — build on) now lands the `tasks.status`
  UPDATE and the append-only `task_verdicts` INSERT in ONE `env.DB.batch()` call, the
  INSERT gated on a per-call nonce (`claimTimestamp()`) landed-proof `EXISTS` clause on
  the UPDATE's own result, not a bare timestamp comparable across two racing calls. A
  statement THROW rolls back the whole batch; a 0-row conditional UPDATE (K5: another
  verdict already won) makes the INSERT's own `EXISTS` guard unsatisfiable in the same
  transaction, so the loser's INSERT is also a no-op — never "status flipped, no
  receipt" or "receipt written, no status flip." Proven structurally (the verdict
  INSERT and the batch's other statements are pinned to share ONE `env.DB.batch()`
  call, not merely asserted in prose) and behaviorally (forcing a real SQLite failure
  on the verdict statement rolls back everything sharing that array) in
  `tests/task-verdict-human-origin.test.ts`, and against real SQLite with a row-count
  assertion (0 rows for the loser) in `tests/tasks-gate.test.ts` and
  `tests/tasks-verdict-route-e2e.test.ts` (the plain HTTP path).
- **Invite minter re-check cannot see a session-role-only floor (round 6, mupot#1417).**
  An invite's minter authority is re-derived fresh from D1 at redemption
  (`currentMemberOrgRank`/`currentMemberSquadRank`, `src/members/project-invites.ts`) —
  but a minting session's `auth.role` is folded into the actor's rank unconditionally at
  mint time, with no requirement that it be backed by a `capabilities` row or a
  `members.email -> users.role` bridge for that SAME member. A minter whose standing came
  only from that unbridgeable session floor mints successfully and is refused at
  redemption with no real change in authority. Proven by a dedicated test, not fixed.
- **A squad owner's net-new `owner`-capability invite escalates the target's global rank
  (round 6, mupot#1417 item 2 — the SAME defect kasra-review's own gate on `efdb0b08`
  filed independently as mupot#1416; cross-linked round 7, not a second gap).** The
  freshly-minted member becomes untouchable by every org admin's target-rank ceiling
  (suspend, mint, capability grant/revoke, Telegram unbind) — a real, narrow behavior
  change from before this slice existed. Not fixed.
- **`members.email` is case-sensitive UNIQUE (round 6, F4, mupot#1418).** A case-variant
  row can bridge to a role-plane rank it has no real standing for, becoming immune to an
  org admin the same way a real owner is (denial-only, never an authority gain). Not
  fixed — a follow-up issue tracks lowercasing `members.email` on write.

## Second-channel checklist (Slack, WhatsApp, email, SMS)

What is **adapter-thin** — replace, do not redesign:

- The webhook secret comparison, body cap, and UTF-8 validation shape (b) carries over
  unchanged: every channel needs a shared-secret-verified, size-capped, fail-closed
  ingress.
- The digest-based replay reservation shape (c) carries over: compute a digest over
  whatever fields the new transport supplies as its own "this exact event" identity
  (Slack: `event_id`; email: `Message-Id` + a content hash; SMS: provider message SID).
- The gate evaluator (`evaluateVerdictGates`) and verdict writer (`writeVerdict`) are
  already channel-agnostic — a second channel must call the SAME functions
  `src/im/index.ts` calls, building its own `AuthContext` **via the same helper
  path** (`memberAuth`/`memberForChat`, `src/im/index.ts:93-105,356,400-403`), not a
  channel-local re-derivation. Do not fork a second gate check. Building it "the same
  way" also means **inheriting the same coarse-role limitation**: `memberAuth` hardcodes
  `role: 'member'`, so any channel that reuses this helper unmodified reproduces the
  identical `gate:agent-self-completion` gap documented in (d) above and (g) below —
  that gap is not something a second channel can "avoid" by construction; it is fixed,
  if at all, by changing the shared helper (or the gate check), not by each channel
  papering over it separately.
- The fence discipline (e) generalizes directly: "private conversation," "sender is the
  channel-native immutable id," "no forwarded/relayed content" all have direct Slack
  (DM-only, `user.id`, no forwarded-message block), WhatsApp, and SMS (no equivalent of
  forwarding metadata exists — treat every inbound as first-party) analogues.

What **must change**, not merely adapt:

- **Schema shape.** `members.telegram_chat_id` and `telegram_webhook_receipts` are
  Telegram-specific column/table names carrying Telegram-specific semantics (immutable
  numeric chat id). This is not a stylistic nit — it is load-bearing in the invite path
  itself: `CLAIM_INVITE_SQL` (`src/members/project-invites.ts:337-371`) **hardcodes** an
  `EXISTS (SELECT 1 FROM telegram_webhook_receipts receipt WHERE ... receipt.telegram_user_id
  = ? ...)` conjunct (`:357-364`) as one of the atomic claim's fence conditions — a
  second channel cannot claim an invite through this exact statement without either its
  own copy of this table+conjunct or a rewrite of the statement itself. The whole module
  is Telegram-typed end to end, not just at the edges: the redemption input type names
  the field `telegram_user_id` (`src/members/project-invites.ts:101`, the
  `RedeemTelegramProjectInviteInput` interface field — not a runtime assertion), the
  error code is `invalid_telegram_user_id` (`:116`), and the runtime re-asserts the same
  field name twice at redemption time (`:631`, the input-shape check;
  `:646`, the receipt-row comparison). A second channel needs either its own
  `members.<channel>_id` column
  and its own receipts table (fast, but repeats the `telegram_` prefix pattern per
  channel and needs a repeated migration + repeated fence logic per channel), or a
  refactor to a generic `member_channel_identities (member_id, channel, external_id)` +
  `channel_webhook_receipts (tenant, channel, update_id, ...)` shape — including a
  rewrite of `CLAIM_INVITE_SQL`'s receipt conjunct — before a second channel ships.
  Prefer the generic shape once a second channel is real — the `telegram_` prefix was
  the right call for a first instance, not a pattern to repeat.
- **Further Telegram-typed surfaces not yet listed above** (found while re-auditing for
  this revision; likely incomplete, not a closed inventory): the dashboard renders IM
  reachability by testing `m.telegram_chat_id` directly in two places
  (`src/dashboard/index.ts:6115,6324`, `if (m.telegram_chat_id) chSet.add('im')`);
  `src/dashboard/health.ts:537` names `IM_WEBHOOK_SECRET` specifically in the
  operational health check's missing-secrets list; `src/mcp/index.ts:414` selects
  `m.telegram_chat_id AS telegram_chat_id` in a member-lookup query; the generated
  migration chain embeds the `telegram_webhook_receipts` table's Telegram-typed DDL
  verbatim (`src/pots/schema-chain.generated.ts:2813`); and the secret header name
  `X-Telegram-Bot-Api-Secret-Token` is hardcoded at both live verify sites
  (`src/im/index.ts:914`, `src/channels/adapters/telegram.ts:49` — see the duplicate-
  predicate note under (b) above). None of these block a second channel from being
  built alongside Telegram, but each is a place a second channel's own identity will
  need its own equivalent, not a shared read of the Telegram-named field. The
  `ConnectionChannel` union itself is already channel-generic
  (`'workspace' | 'im' | 'dashboard' | 'directory'`, `src/types.ts:577`, consumed at
  `AuthContext.channel?: ConnectionChannel`, `:524`) — `'im'` is the channel-agnostic
  tag; it is the *fields feeding it* above that are Telegram-specific.
- **Identity extraction.** Telegram's `message.from.id === message.chat.id` private-DM
  check is Telegram's specific proof of "this is the account holder in their own private
  conversation." Each channel needs its own equivalent proof, not a generic transplant of
  this exact predicate — Slack's DM channel type, WhatsApp's business-API sender
  verification, and email's DKIM/SPF-verified envelope sender are structurally different
  proofs of the same property and must each be worked out on their own terms.
- **Invite delivery mechanism.** The pairing-code flow assumes a channel where "send a
  short code the human types back" is natural (`/start <code>`). Email/SMS invites likely
  want a one-time link instead of a typed code; the single-use/server-hashed/atomic-claim
  properties in (a) must still hold, but the code-vs-link UX is a real design choice, not
  adapter-thin plumbing.
- **Forwarding semantics.** "Forwarded" is a first-class Telegram message property. Slack
  has no exact equivalent (shared messages, not forwards); email has "Fwd:" subjects and
  quoted bodies, which are heuristic, not authenticated, signals. Each channel needs its
  own honest answer to "can I prove this wasn't relayed by someone else," which may be
  weaker than Telegram's and must be documented as such, not silently assumed equivalent.

## Harness-attested origin (mupot#1424/#1425)

Added 2026-09-16 for `task_verdict`'s `human_origin` field
(`src/im/origin-verdict.ts`, `src/mcp/index.ts`). A second SHAPE of decision channel,
alongside the direct `/im/webhook` above: the human never talks to a webhook at all —
they talk to their OWN agent (KayHermes) in natural language, and that agent's own
mupot calls carry a stamped origin. This section states the trust model plainly rather
than let it be inferred from the code.

**Revision history, each round adversarial and each finding executed, not inferred:**

- **Round 1** (kasra-review BLOCK): side effects (the Telegram identity bind, the
  replay reservation) ran BEFORE the authorization they depended on, and
  `agents.owner_member_id` had no target-rank ceiling. Fixed by splitting resolution
  into a read-only dry run and a write-time commit, reached only when authorized.
- **Round 2** (kasra-review BLOCK + Athena): the round-1 reorder enumerated 2 of 3
  refusals that could still land AFTER a commit — `writeVerdict`'s own project-evidence
  fence fired after a bind had already landed (P0-B); the ceiling compared the RAW
  `owner_member_id` string while the write stored the TRIMMED one, so a single
  whitespace character bypassed it for ANY actor (P0-A); the ceiling had no ORG-SCOPE
  FLOOR paired with it, unlike every sibling authenticate-as-X door in this codebase
  (Athena); agent ownership and member-active were read once in the dry run and never
  re-asserted at commit, so a revocation racing the call was ignored (P1-C); and the
  bind's "landed proof" guard compared a timestamp that could coincide across two
  different rows within the same millisecond, instead of the digest already sitting on
  that row (P3-G).
- **Round 3** closes all of round 2's findings by putting the VERDICT WRITE ITSELF
  inside the same atomic commit as the reservation and the bind — see below —
  normalizing `owner_member_id` once, at the boundary, before either the floor or the
  ceiling ever sees it, pairing the ceiling with an org-scope admin floor, and
  re-asserting agent ownership and member-active as SQL conditions on every statement
  that depends on them.
- **Round 4** (this revision, kasra-review BLOCK + Athena's gate): round 3 put the
  verdict inside the SAME batch as the bind and the reservation, but a batch's three
  statements still carried three DIFFERENT (overlapping, not identical) guard sets —
  the bind's guards could all hold while the verdict's own guard (task
  `status='review'`, among others) did not, landing a durable Telegram bind and an
  append-only audit row for a call the API refused with 409 `verdict_race` (P0-1,
  proven live by a task-status race between the dry run and the commit). Separately,
  the verdict INSERT's own landed-proof compared a bare millisecond timestamp with no
  nonce, so a genuine race LOSER could still insert a `task_verdicts` row — the SAME
  class round 2's P3-G fix closed on the bind statement and left open one statement
  away, on ALL FOUR verdict surfaces (HTTP, MCP, IM `/approve`, and this origin path),
  not just here (P0-2). Fixed structurally, not by enumeration: the VERDICT ROW is now
  the ONE anchor — `buildVerdictStatements` carries the full guard set and is the ONLY
  statement that decides whether the call succeeds; the bind UPDATE and its receipt
  INSERT are demoted to depending SOLELY on `EXISTS (SELECT 1 FROM task_verdicts WHERE
  id = <this call's own UUID>)`, so "no verdict row ⇒ nothing else lands" by
  construction. `claimTimestamp()` (a per-call nonce, not a bare ISO timestamp) is now
  the landed-proof stamp in `buildVerdictStatements` for every caller, closing P0-2
  centrally rather than per-surface. A plugin-gate addendum (P2-1) also binds INTENT
  server-side this round: `human_origin` gains a required `text` field, and the target
  task id must be named in it (full-UUID substring, or an 8+ hex-char prefix of the
  task id's own leading hex characters) or the call refuses with `applied:false,
  reason:'task_not_named'` — a human stamp can no longer be spent by the model on a
  task the human never mentioned. `text`'s sha256 is folded into the replay digest.

**The trust statement, stated once and not softened:** the HARNESS is the attestation
boundary. mupot trusts a `human_origin` stamp only because:

- (a) the calling agent's seat is owned by the resolved member
  (`agents.owner_member_id`, migration 0155 — a column distinct from both the free-text
  `agents.owner` label and `agent_keys`' own `memberOwnsAssigneeAgent`
  conflict-of-interest fact; the three are never conflated), and setting that column
  requires the actor to hold **admin on the ORG scope specifically** (a floor —
  squad-admin, sufficient for every OTHER admin-lane field on `update_agent`, is not
  enough for this one) **and** to clear a target-rank ceiling
  (`exceedsTargetRankCeiling`, src/auth/capability.ts — the identical predicate #1411's
  member-bind-invite path uses for the same class of credential mint): the actor's
  org-scope standing must be at or above the TARGET member's global rank, unless the
  actor is naming their own member id (self-exempt from both the floor and the
  ceiling). The value is normalized (rejected outright if it contains ANY whitespace,
  leading, trailing, or inner — including unicode spaces) BEFORE either check runs, so
  the floor/ceiling and the eventual write can never see two different strings for the
  same field (round 2's exact root cause: the ceiling checked the raw value, the write
  stored the trimmed one).
- (b) that member is bound to the exact chat the origin claims, or first-binds it, but
  ONLY after the ENTIRE decision — reservation, bind, AND the verdict itself — is
  proven authorized (see the ordering below); and
- (c) the message is FRESH and UNREPLAYED.

mupot cannot itself tell a harness-stamped `human_origin` apart from one a MODEL typed
into its own tool call — the server never sees the raw Telegram update, only the stamp
the harness (or, adversarially, the agent loop itself) chose to attach. A plugin-side
gate (the actual Hermes-side code that is supposed to stamp only real Telegram
messages) can silently no-op — an older Hermes build, or `native_gateway` off — and
mupot must not be the second layer that only works when the first one does. So every
defense that IS server-checkable is enforced here, in an order where authorization
gates every write:

1. **Ownership + floor + ceiling** (`agents.owner_member_id`) — re-read fresh every
   call, never self-settable by the agent itself.
2. **Chat fence** (read-only) — the origin's `chat_id` must equal the owning member's
   `telegram_chat_id`, or the member has none yet (a first-bind CANDIDATE — nothing is
   written for this yet).
3. **Conflict of interest** — the calling agent may not itself be the task's assignee,
   and the resolved member may not be the OWNER of the assignee agent
   (`agents.owner_member_id` again, the load-bearing check now that `agent_keys` is
   empty in prod for the pilot agent). `agent_keys`' `memberOwnsAssigneeAgent` is kept
   as an additional, non-load-bearing check. **Known gap** (round 2, P2-E, not fixed in
   this slice): `tasks.assignee_member_id` (the HUMAN-owner column, migration 0150) is
   never consulted — a member who owns a task directly can still approve it via a
   harness-attested origin. Pre-existing on every verdict surface, not introduced here.
4. **Rate limit** — at most one APPLIED harness-attested verdict per resolved MEMBER
   per 30 seconds (`origin_rate_limited` otherwise), keyed on the member, not the
   calling agent.
5. **Squad membership + the REAL gate predicate** — `canOnSquad` and then
   `evaluateVerdictGates`, the SAME function every other verdict surface calls,
   dry-run against the candidate member's fresh capabilities.
6. **The project-evidence fence** (`assertVerdictWritable`, the same check
   `writeVerdict` itself enforces) — checked here, read-only, BEFORE any write. Round
   2's P0-B: this used to live only inside `writeVerdict`, reachable only after the
   bind had already landed.
7. **Freshness** — `message_at` is REQUIRED and must fall within 10 minutes in the past
   or 60 seconds in the future of the server clock (`origin_stale` otherwise), checked
   during parsing, before any of the above. This is a short shelf life for a captured
   `(chat_id, message_id, message_at)` triple, not proof the harness told the truth
   about when the human spoke — `message_at` is caller-supplied, so an injected model
   can stamp a fresh timestamp as easily as a real harness can.
8. **ONLY IF everything above says "authorized"** does this module write anything —
   and, as of round 3, EVERYTHING it writes lands in ONE D1 batch
   (`commitOriginDecision`): the replay reservation, the first-bind UPDATE + its audit
   INSERT (when needed), AND the verdict write itself
   (`buildVerdictStatements`, src/tasks/service.ts). Round 2's P0-B — a refusal that
   could still fire between a commit and a verdict — is closed by construction: there
   is no such gap left to enumerate, because there is no longer a separate "then write
   the verdict" step for a harness-attested decision. Every statement that depends on
   agent ownership or member-active re-asserts BOTH as SQL `EXISTS` conditions at
   commit time (round 2's P1-C: these were read once in the dry run and never
   re-checked — a revocation racing the call was proven to land a bind and a verdict
   anyway). The bind's own landed-proof guard requires BOTH the reservation's
   timestamp AND its `request_digest` to match (round 2's P3-G: timestamp alone can
   coincide across two different rows within the same millisecond). A UNIQUE-constraint
   conflict (another member already holds this chat) aborts the WHOLE batch — the
   reservation and the verdict are never left committed either. **A failure reserves
   nothing.** Replay itself: one decision per origin message, keyed on `(tenant,
   'origin:telegram:' + chat_id + ':' + message_id)` — reuses `telegram_webhook_receipts`
   (0152) verbatim, no forked table. ANY pre-existing row at that key — exact digest
   match or not — refuses the whole call with a hard 409 `origin_replayed`; this path
   never returns a cached prior response the way the live Telegram webhook's own
   reservation helper does.

**Residuals, stated honestly, not silently assumed closed:**

- **Member capabilities cannot be re-asserted as a SQL condition inside the commit
  batch** — `evaluateVerdictGates` is a multi-table, multi-branch JS predicate, not a
  single `EXISTS` clause. The window between the dry run's capability read and the
  commit is real but bounded to one request's own async gap (milliseconds,
  same-process) — not a cross-request race an attacker can widen.
- **The target-rank ceiling on `owner_member_id` is evaluated ONCE, at set time**
  (round 2, P1-D). `dryRunAuthorize` re-reads the column fresh every call, but never
  re-evaluates the ceiling that originally authorised setting it. A member pointed at
  by a lower-ranked (but floor-clearing) actor while holding low standing, later
  promoted to higher standing by someone else, keeps the binding — unre-checked — for
  as long as the column stays set. Tracked as a follow-up issue, not fixed here.
- **A genuine post-commit exception** (the read-only `memberForChat` sanity check, or
  the best-effort bus emit, both AFTER the D1 batch has already committed) leaves the
  reservation in `state='processing'` with no TTL — the SAME accepted-for-the-pilot
  shape the direct `/im/webhook` channel already has ("a row in processing is not
  permission to retry or delete; it stays fenced until an operator reconciles",
  clause (c) above). With round 3's verdict-in-the-batch design this can no longer
  happen as a consequence of a LATER refusal (round 2's P0-B scenario) — the only
  remaining trigger is an actual infrastructure fault in the two reads that happen
  after the batch commits, not a business-logic refusal.
- **A genuine task-status race permanently spends the replay reservation for that
  exact origin message (round 4, accepted for the pilot).** Distinct from the
  now-CLOSED "permanent 409 from ANY business refusal" shape (round 3 closed that: a
  business refusal — `agent_not_owned`, `member_inactive`, `verdict_race`, etc. — now
  completes the reservation with a JSON reason via `completeTelegramUpdate` rather
  than leaving it stuck `processing`). This residual is narrower: replay protection is
  keyed on `(tenant, 'origin:telegram:' + chat_id + ':' + message_id)`, one decision
  per origin MESSAGE. If that message loses a genuine `verdict_race` (another verdict
  won concurrently on the same task), the reservation for THAT exact message is spent
  — the human cannot retry with the same message; they must send a NEW one (a fresh
  `message_id`) to try again. The task's true current state is never hidden — the
  human's next message resolves against fresh state — but the original message itself
  is a one-shot, by design, not a bug to route around.
- **(e) Intent is bound to the task; DIRECTION is not (round 4, Athena's gate,
  accepted for the pilot).** `taskNamedInText` proves the human's message named THIS
  task — a full-UUID substring or an 8+ hex-char prefix of its own leading hex
  characters — but it does not, and cannot, parse or bind the human's intended
  verdict DIRECTION out of free text. A message reading "reject f9408956" paired
  with a tool call carrying `verdict: 'approved'` still satisfies `taskNamedInText`
  and applies as an approval: the task is named correctly, the outcome is not the one
  the words describe. mupot verifies that the human named this task. That the human
  wanted this outcome on it remains the harness's attestation, not the server's.

**The resulting blast radius, stated precisely:** a caller holding an agent-bound seat
can cast, per fresh and unreplayed origin message from a chat the resolved member is
bound to (or eligible to first-bind), exactly the verdicts that member's OWN real,
freshly-resolved capabilities would allow through `evaluateVerdictGates` — no more, no
wider. It can never impersonate a member the floor+ceiling above would have refused to
point that agent at. It can never mint a binding, reserve a replay slot, or write a
verdict for a decision that was not first proven authorized, in full, including the
project-evidence fence. And it can never apply more than one such decision per member
per 30-second window, regardless of how many agents that member owns. Do not describe
this as "per message" without also naming the floor, the ceiling, and the
authorize-before-write ordering above.

**Two hard failures, no fallback.** Every conjunct above failing falls back to the
calling agent's own authority — exactly as if `human_origin` had been omitted, "no
origin, or an origin that does not resolve, runs under the agent seat only" (Hadi,
2026-09-16). Two cases instead refuse the WHOLE call: a non-agent-bound caller supplying
`human_origin` at all (400 `human_origin_not_applicable`), and a replayed origin message
(409 `origin_replayed`). A genuine post-dry-run race on the task's own status (another
verdict won concurrently) surfaces as the SAME `VerdictRaceError` → 409 `verdict_race`
the non-origin path already produces — one shared outcome, not a second race code.

**The fallback is always visible for an agent-bound caller (round 3 addendum, Athena's
plugin gate).** A human whose stamp was burned client-side (or never attached at all)
used to get a response indistinguishable from the pre-feature agent-seat verdict —
`human_origin` was simply absent from the body either way. Now, whenever the caller is
agent-bound: if `human_origin` was supplied and a conjunct refused it, the response
carries `human_origin: { applied: false, reason: '<the conjunct that refused it>' }`
(including `task_not_named` per round 4's intent-binding addendum, above); if
`human_origin` was never supplied at all, the response carries `human_origin: {
applied: false, reason: 'absent' }` instead of omitting the field. A non-agent-bound
principal is unchanged either way — human_origin was never applicable to it, so the
field stays omitted entirely.

**Visibility:** a first-bind-by-origin is no longer write-only. `/account`'s Telegram
section (`src/dashboard/account.ts`, `loadLatestOriginBindReceipt`) shows, for a member
bound this way, which agent vouched for the bind and from which message id — a silent
credential mint is now visible to the member it happened to.

Evidence: `tests/task-verdict-human-origin.test.ts` (every conjunct above, flipped one
at a time, real D1 via `applyAllMigrations`, invoked through `invokeTool` — the same
seam MCP and `/actions/task_verdict` both dispatch through — including the P0-2 proof
that an unauthorized owner never gets bound, the P1-4 proof that an unowned agent
cannot burn a replay slot for a later authorized one, the P0-3 proof that a
self-assigned task refuses 409 `self_verdict` with and without an origin, the P2-5
proof that the rate limit is per-member not per-agent, the P2-7 proof that the
task-detail timeline surfaces `decided_via`/the origin agent, the P0-B proof that a
project-write-fence refusal leaves zero verdicts/binds/receipts, and the P1-C proof
that an ownership revocation racing the commit batch still lands neither a bind nor a
verdict), `tests/agent-owner-member.test.ts` (`owner_member_id` admin-only,
self-lane-forbidden, partition-invariant, the org-scope-floor proof distinct from the
ceiling proof, self-target exemption, and the whitespace-normalization proof across
six forms including a unicode NBSP), and `tests/dashboard-account-telegram-connect.test.ts`
(the origin-bind-receipt display, and its absence for an ordinary invite/button bind).

## Evidence discipline

Every behavioural claim in this document, `agent-harness-contract.md`, and
`decision-channel-conformance.md` carries either a **committed test path:line** or a
**receipt id** (a durable, independently checkable record — a migration hash, an
execution receipt, a PR head SHA someone else can check out and re-run) — never a bare
"this was verified by execution" with no artifact attached. A manual probe, run once by
hand and not committed as a test, is not evidence for this document: nobody reading it
later can tell which ref it ran against, and nothing re-runs it when the code
underneath changes. Round 2 of this PR (Athena gate, 2026-09-14) found exactly this
shape of defect in the (d) Principal section above — a citation-free "probes ... were
both refused" sentence that, on inspection, both overstated what was actually tested
(an "owner" case that has no test) and pointed to nothing a reader could check.

The property this enforces: **a claim in a contract or evidence doc must not be
falsifiable by anything except editing the document itself.** State the property, then
the exact test (or receipt id) and the ref/SHA it was read at. A later push, merge, or
deploy can then only do one of two things to that claim — leave the cited test passing
(the claim still holds) or break it (CI says so, not this document silently going
stale). A claim with no citation, or a citation to something that turns out not to test
what the prose says, is falsifiable by nothing at all except someone re-reading the
document and doubting it — which is what round 2 was.

## Sources read

- `docs/architecture/mupot-core.md` (mupot `main` @ `49a344aa`)
- `docs/operations/telegram-project-onboarding.md` (same ref)
- `src/im/index.ts`, `src/members/project-invites.ts`, `src/routines/actions.ts` (same ref)
- `src/tasks/index.ts:93-95,1417-1433` (`legacyOwnerAdmin`, `evaluateVerdictGates`; same
  ref — round 3 correction: the prior revision's `:85-93` range also swept in the
  unrelated `inTenantScope` helper at `:86-88`, not just `legacyOwnerAdmin`)
- `tests/im-verdict-gates.test.ts:89-143` (round 2, re-read line by line against the
  claim it backs); `src/channels/index.ts:776`, `src/channels/adapters/telegram.ts:47-52`,
  `src/index.ts:110,113` (round 2, duplicate-predicate finding)
- `src/dashboard/index.ts:6110-6120,6320-6330`, `src/dashboard/health.ts:530-542`,
  `src/mcp/index.ts:408-420`, `src/pots/schema-chain.generated.ts:2813`,
  `src/types.ts:520-524,577` (round 2, second-channel checklist omissions)
- mupot PR #1407 gate history (Kasra AMBER fix, Athena addendum A-H, two adversarial
  re-gates) — read via `mcp__mupot__recall`, not re-fetched from GitHub for this doc
- mupot PR #1410 round 1 gate comment (Athena, head `aa6e0a99`, 2026-09-14) — the
  findings this revision fixes
