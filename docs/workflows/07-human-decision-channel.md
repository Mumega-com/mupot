# Human decision channel (harness-attested origin)

Lets a human decide a gated task by talking to their **own** agent in natural language,
instead of typing a raw command into mupot's own Telegram bot. The agent's harness (never
the model) stamps the human's message onto the agent's `task_verdict` call; mupot resolves
that stamp to the member and writes the verdict as them. mupot#1424 (freshness/text
binding), #1425 (the mechanism itself, 5 adversarial fix rounds).

## Trigger

An agent-bound caller invokes `task_verdict` with a `human_origin` object attached,
relaying a message the human sent it over Telegram.

## Actor(s)

- The human decider (a mupot member).
- Their own agent's harness — the attestation boundary. mupot trusts a stamp only because
  the harness is the one thing that saw the raw Telegram update; mupot never does.
- mupot server-side: re-checks every conjunct itself rather than trusting the stamp
  (`src/im/origin-verdict.ts:79-88`).

## Tool/route sequence

1. `task_verdict` (`src/mcp/index.ts:1886`) with `human_origin: { channel: "telegram",
   user_id, chat_id, message_id, message_at, text }` (schema `src/mcp/index.ts:1856-1877`).
   `message_at` and `text` are both **required** — `text` must name the target task id
   (full, or an 8+ hex-char prefix) or the stamp is refused (`task_not_named`).
2. `resolveHarnessAttestedOrigin` (`src/im/origin-verdict.ts:667`), called from
   `src/mcp/index.ts:1970`, only when `auth.boundAgentId` is set (non-agent-bound callers
   supplying `human_origin` get a hard `400 human_origin_not_applicable`).
3. `dryRunAuthorize` — **read-only**, checks every conjunct in order (agent owned by a
   member; owner active; origin is well-formed, private-chat-shaped
   (`user_id === chat_id`), and fresh — within 10 minutes past / 60 seconds future of the
   server clock; origin resolves to (or may first-bind) that same member; no conflict of
   interest (deciding member isn't the assignee agent's own owner in a way that self-
   verdicts); not rate-limited (one applied `human_origin` verdict per member per 30s);
   `evaluateVerdictGates` — the SAME predicate every verdict surface uses — actually
   authorizes this task+verdict; `assertVerdictWritable`'s project-evidence fence holds.
4. `commitOriginDecision` (`src/im/origin-verdict.ts:451`) — reached only if the dry run
   authorized — writes the reservation, the verdict, and (if needed) the first Telegram
   bind in **one atomic `env.DB.batch()`**, anchored on the verdict row (see Receipts).
5. Response returns `{ task, verdict, human_origin: { applied: true, bound_now } }` on
   success, or `{ applied: false, reason: <conjunct> }` and falls back to the calling
   agent's own seat authority on any soft failure — never silently.

Baseline/fallback channel (no harness-attestation, direct to mupot's own Telegram bot):
a human types `/approve <task-id> [note]` or `/reject <task-id> <reason>` straight into
mupot's `/im/webhook`; parsed at `src/im/index.ts:262-270`, executed by `verdictReply`
(`src/im/index.ts:676`), calling the same `writeVerdict`/`evaluateVerdictGates` predicate.

## Human gate

Every defense that is server-checkable is enforced server-side, not merely assumed of the
harness (`src/im/origin-verdict.ts:79-88`): agent ownership (`agents.owner_member_id`,
settable only by an org-scope admin under a target-rank ceiling), member active,
private-chat shape, freshness (`message_at` within window), origin resolving to/first-
binding the correct member, no conflict of interest, per-member rate limit, the shared
`evaluateVerdictGates` capability check, and the project-evidence fence. Any single
conjunct failing falls back to the agent's own authority (never a raise); only two things
are hard call-refusals: a non-agent-bound caller supplying `human_origin` at all, and a
replayed origin message (`409 origin_replayed`).

**Known residual, documented not fixed** (`src/im/origin-verdict.ts:97-100`): the
target-rank ceiling on `owner_member_id` is evaluated once, at set time — a member later
promoted keeps a binding set while they were lower-ranked, unrechecked.

## Receipt(s) written

All landed in the **same D1 batch**, anchored on the verdict row
(`EXISTS (SELECT 1 FROM task_verdicts WHERE id = ?)` gates every later statement —
"no verdict row ⇒ nothing else lands," `src/im/origin-verdict.ts:441-449`):

- `telegram_webhook_receipts` — replay reservation, `(tenant, update_id)` unique,
  `update_id = origin:telegram:<chat_id>:<message_id>`.
- `task_verdicts` — `decided_via = 'agent_attested_origin'`, `decided_by` = the resolved
  member, `origin_agent_id` = the calling agent, bound to `proposal_id` when applicable
  (`buildVerdictStatements`, `src/tasks/service.ts`).
- `members.telegram_chat_id` / `telegram_bound_at` — only on first bind.
- `telegram_origin_bind_receipts` — only on first bind; columns `id, tenant, member_id,
  agent_id, chat_id, message_id, created_at`.

## What the person sees

mupot itself renders no chat text for the harness-attested path — the reply the human
sees is composed by their own agent's harness from the JSON outcome
(`{applied, bound_now}` or `{applied:false, reason}`). On the baseline `/im/webhook`
`/approve`/`/reject` path, mupot's own literal replies (`src/im/index.ts:676-757`)
include: `Approved "<title>".` / `Rejected "<title>".` / `Add a rejection reason: reject
<ref> <reason>.` / `No task named "<ref>" here.` / `You don't have permission to decide
that task (need member on its squad).` / `"<title>" is <status>, not waiting for
approval.`

## Tests that pin it

- `tests/task-verdict-human-origin.test.ts`
- `tests/agent-owner-member.test.ts`
- `tests/dashboard-account-telegram-connect.test.ts`
- `tests/journey-new-member.test.ts`

## Known gaps

- Target-rank ceiling on `agents.owner_member_id` is checked only at set time, not
  re-checked continuously (documented residual, not fixed).
- Member capability re-check inside the commit batch is JS, not SQL — a real but
  bounded (single-request, same-process) window between the dry run's capability read
  and the commit (`src/im/origin-verdict.ts:101-108`).
- See `docs/architecture/human-decision-channel-contract.md` for the full checklist this
  channel is graded against, including open gaps named in its own clause (g).
