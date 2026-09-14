# Human decision channel contract

Status: architecture note, written 2026-09-14 by Kasra from receipts on mupot PR #1407
(`kasra/telegram-project-onboarding-20260913`, merged to `main` at `49a344aa`) and its
gate history. Not a release contract. Hadi decides scope; updates by PR only.

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
  (`src/members/project-invites.ts:284-288,337`, `createProjectInvite`).
- The claim is one atomic statement (`CLAIM_INVITE_SQL`,
  `src/members/project-invites.ts:224-252`) with conjuncts that must all hold in the
  SAME statement, not a JS pre-check that can race it:
  - single-use: `accepted_at IS NULL`
  - not expired: `pairing_expires_at > ?8`
  - project active: `EXISTS (... projects.status = 'active')`
  - the exact squad-project edge still exists: `EXISTS (... project_squad_access ...)`
  - the authenticated transport receipt is in `state = 'processing'` for this exact
    `(tenant, update_id, digest, telegram_user_id)` (the "receipt-processing conjunct")
- Identity used to claim is the medium's own **immutable** user id (Telegram's
  `message.from.id`), never a display name, username, or any other field the human or
  transport can freely re-supply (`src/im/index.ts:857-872`, `telegramDisplayName` is
  documented COSMETIC ONLY — never identity, authority, or part of the request digest).
- A capability grant can never invite above the inviter's own effective rank
  (`actorRankOnSquad`, `src/members/project-invites.ts:163-186`; `cannot_grant_above_own_rank`).

Adversarial finding this closes: PR #1407's own re-gate proved two of the `EXISTS`
conjuncts (`projects.status='active'`, the `project_squad_access` edge) are **singly
expressed** — no JS twin, single caller — and load-bearing: deleting either lets a
redemption into an archived project or a revoked edge succeed and write a `capabilities`
row. A conjunct with no test proving it is load-bearing is not a fence, it is decoration.

### (b) Ingress authority

The transport boundary is a **shared secret, verified before any parsing of the body**:

- `IM_WEBHOOK_SECRET` compared with `timingSafeEqual`
  (`src/im/index.ts:911-916`, `src/lib/crypto.ts`), never a plain `===`.
- Unconfigured secret seals the endpoint closed with `503 webhook_not_configured`
  (`src/im/index.ts:911-913`) — an absent secret must never default to "accept
  everything," it must default to "accept nothing."
- Mismatched or missing secret returns `401` (`src/im/index.ts:914-917`) before the body
  is even parsed as JSON.
- Body size is capped before decode (`IM_WEBHOOK_MAX_BODY_BYTES = 64 * 1024`,
  `src/im/index.ts:66,900-905`) and UTF-8-validated with `fatal: true`
  (`readCappedBody`, `src/im/index.ts:72-82`).

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
- `memberAuth` builds a flat `AuthContext` with `role: 'member'` (always — never
  `'admin'`/`'owner'`) and the member's **live, re-resolved** capability grants
  (`resolveCapabilities`, called fresh on every message — `src/im/index.ts:356,400-403`).
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
(`legacyOwnerAdmin(auth)`, `src/tasks/index.ts:93`) tests only the coarse role, which is
frozen at `'member'` here. This was verified by execution: probes with an org-scope owner
grant row and, separately, an org-scope admin grant row were both refused. This makes the
channel strictly narrower than an authenticated web/HTTP session for that one gate, and
brings it to parity with MCP (`auth.role` is likewise always `'member'` there).

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
   This write is **not atomic with** the webhook reservation's `completed` stamp — see gap
   below.
3. **Notification** — a Routine entering a human wait separately attempts one delivery
   (`notifyHumanWait`, `src/routines/actions.ts:391-421`) keyed by the stable
   `request_id = routine-human:<run-id>:<action-key>` (`humanWaitRequestId`,
   `src/routines/actions.ts:293-298`). `NotifyHumanWaitOutcome` distinguishes
   `no_recipient` / `no_decision` / `delivery_refused` from an actual delivery
   (`src/routines/actions.ts:376-421`) so a caller can tell "nobody to notify" from
   "notification attempted and failed" — these used to collapse into one boolean
   (Athena addendum H).

### (g) Known gaps at v1 — do not treat these as closed

- **Net-new humans only.** Redeeming an invite whose email already belongs to an existing
  member refuses with `member_already_exists` and makes no partial writes. Binding a new
  channel identity (e.g. Telegram) to an *existing* member (e.g. someone with a web
  login) is explicitly out of scope and must not be worked around by inviting that
  member's own email — it needs its own reviewed change
  (`docs/operations/telegram-project-onboarding.md`, top section).
- **No invite revocation route.** There is no HTTP route to revoke an unused invite; the
  runbook's only path is a direct, approved DB `UPDATE` expiring one exact row by id.
- **`gate:agent-self-completion` is coarse-role-only over this channel** (see (d) above) —
  not "extended to check real capability grants," simply refused entirely. Extending IM
  to carry this gate is explicit future work, not a silent limitation to paper over.
- **Non-atomic verdict write.** `writeVerdict` changes `tasks.status` before inserting the
  append-only `task_verdicts` row. An interruption between the two writes can leave a
  terminal-looking task with no verdict receipt while the update stays fenced
  `processing`. This channel inherits that gap; it does not repair it. Reconcile by
  reading both the task status and the latest verdict row — a mismatch is an incident,
  not something to paper over by manufacturing a new decision.

## Second-channel checklist (Slack, WhatsApp, email, SMS)

What is **adapter-thin** — replace, do not redesign:

- The webhook secret comparison, body cap, and UTF-8 validation shape (b) carries over
  unchanged: every channel needs a shared-secret-verified, size-capped, fail-closed
  ingress.
- The digest-based replay reservation shape (c) carries over: compute a digest over
  whatever fields the new transport supplies as its own "this exact event" identity
  (Slack: `event_id`; email: `Message-Id` + a content hash; SMS: provider message SID).
- The gate evaluator (`evaluateVerdictGates`) and verdict writer (`writeVerdict`) are
  already channel-agnostic — a second channel calls the SAME functions `src/im/index.ts`
  calls, building its own `AuthContext` the same way. Do not fork a second gate check.
- The fence discipline (e) generalizes directly: "private conversation," "sender is the
  channel-native immutable id," "no forwarded/relayed content" all have direct Slack
  (DM-only, `user.id`, no forwarded-message block), WhatsApp, and SMS (no equivalent of
  forwarding metadata exists — treat every inbound as first-party) analogues.

What **must change**, not merely adapt:

- **Schema shape.** `members.telegram_chat_id` and `telegram_webhook_receipts` are
  Telegram-specific column/table names carrying Telegram-specific semantics (immutable
  numeric chat id). A second channel needs either its own `members.<channel>_id` column
  and its own receipts table (fast, but repeats the `telegram_` prefix pattern per
  channel and needs a repeated migration + repeated fence logic per channel), or a
  refactor to a generic `member_channel_identities (member_id, channel, external_id)` +
  `channel_webhook_receipts (tenant, channel, update_id, ...)` shape before a second
  channel ships. Prefer the generic shape once a second channel is real — the
  `telegram_` prefix was the right call for a first instance, not a pattern to repeat.
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

## Sources read

- `docs/architecture/mupot-core.md` (mupot `main` @ `49a344aa`)
- `docs/operations/telegram-project-onboarding.md` (same ref)
- `src/im/index.ts`, `src/members/project-invites.ts`, `src/routines/actions.ts` (same ref)
- `src/tasks/index.ts:93,1417` (`legacyOwnerAdmin`, `evaluateVerdictGates`; same ref)
- mupot PR #1407 gate history (Kasra AMBER fix, Athena addendum A-H, two adversarial
  re-gates) — read via `mcp__mupot__recall`, not re-fetched from GitHub for this doc
