# Telegram login and onboarding audit

Researched 2026-10-28 against this checkout. Code audit only. No production
probe, no secrets. Search was `telegram`, `im_bot_username`, `/im/webhook`,
`human_origin`, `approval-bot`, `miniapp` under `src/` and `docs/`.

A new human does not walk one login. Four bots and two bind dialects share
the words "Telegram", "Connect", and `/muapprove`. The page they start on
mints a pairing code for a bot this worker does not speak as. Whether they
ever see a reply depends on a relay that is not in this repo.

## The four bots

| Bot | Secret / setting | Speaks as | What a human does there |
|---|---|---|---|
| Decision channel | `org_settings.im_bot_username` only. This worker holds no token for it. | Hermes (or whoever relays `POST /im/webhook`) | `/start <code>`, `/muneeds`, `/muapprove`, `/mureject`, `/login` |
| Notification bridge | `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | This worker, `sendMessage`, one chat | Task pings for that single chat. Not per member. |
| Approval bot | `APPROVAL_BOT_TOKEN`, `APPROVAL_BOT_WEBHOOK_SECRET`, `APPROVAL_BOT_USERNAME` | This worker, `POST /im/approve/webhook` | Elevation taps and `/muapprove <elevation id>` |
| Mini App bot | `TELEGRAM_MINIAPP_BOT_TOKEN` + `TELEGRAM_MINIAPP_BOT_ID` | This worker, web_app button | "Set up this phone" and "Review and decide" |

`src/types.ts:248-269` records the incident (mupot#1420): deriving a username
from `TELEGRAM_BOT_TOKEN` opened the notification bot. The decision username
is now a display setting. Nothing in bind or authz reads it
(`src/dashboard/settings.ts:28-38`). The wizard still puts the notification
token and the decision username on one form (`src/dashboard/wizard.ts:951-971`),
so an owner can save the notification bot's @name into `im_bot_username`.
The shape check does not require the name to end in `bot`
(`src/dashboard/settings.ts:44-54`). The approval bot's check does
(`src/approval-bot/config.ts:19-20`).

The channel adapter calls itself the canonical Telegram path and calls
`src/im/index.ts` back-compat (`src/channels/adapters/telegram.ts:8-11`).
The account deep link and the decision-card comments say the opposite.
Both doors authenticate with `IM_WEBHOOK_SECRET`.

## 1. My Account → Connect Telegram

Route: `GET /account` renders the Telegram panel (`src/dashboard/account.ts:648-650`,
section at `637`). The button is client script. It does not complete the bind.

What the human sees, in order:

1. No bridged member (`auth.memberId` empty). Title "No member profile linked".
   Hint: ask an admin under People & Access. No button.
   `src/dashboard/account.ts:335-340`. No `next_step` field; the hint is the next step.
2. Member missing or not `active`. Title "Account not active". No hint, no button.
   `344-348`.
3. `telegram_chat_id` set. Pill "Connected", optional "bound \<time\> UTC",
   Disconnect. `351-370`.
4. Below org-admin, and no non-home squad they can see. Title "Telegram not
   connected". Detail says they need an active project squad. Hint: ask an org
   admin to add them. `378-387`.
5. Org admin, and no active project linked to a non-home squad. Same title.
   Detail says there is nothing to bind access to. No hint. `385`.
6. Eligible. Pill "Not connected". Copy: "Connect your Telegram to approve and
   be notified through chat." A project/squad picker, then **Connect Telegram**.
   `422-433`.

The "notified" sentence is the notification bridge (`notifyHadi`,
`src/telegram-bridge/bus_notify.ts:153-164`), which posts to one
`TELEGRAM_CHAT_ID`. Binding a member does not add them to that chat.

`MEMBER_BIND_MINT_FLOOR` is `'admin'` (`src/members/project-invites.ts:41`).
Below that floor the page is self-service (`account.ts:374-378`): only squads
where the viewer is at least observer, and the requested capability is always
`observer` (`account.ts:189-190`), including for a lead. The picker prints
`(observer)`. Redemption will not downgrade an existing higher grant
(`project-invites.ts:1055-1058`), so the label looks like a demotion and is not
one. Home squads are excluded in SQL (`account.ts:183`, `s.kind != 'home'`)
and refused at mint (`project-invites.ts:587`, `home_scope_not_invitable`).
A person whose only squad is their home squad gets state 4. That is the usual
new member.

Pressing Connect `POST`s `/api/members/invites` (`account.ts:260-270`) with
their own member id, the picked project/squad, capability, and a 24h expiry
(`account.ts:56`). Server path: `parseInvite` → `authorizeInvite` →
`createProjectInvite` (`src/members/index.ts:1225-1252`). A human session
(no `boundAgentId`) passes the structural chokepoint immediately
(`src/operators/chokepoint.ts:826`). An agent token is refused there
(`create_invite` is `agentLane: 'refuse'`, `chokepoint.ts:165`).

Self-service inside `createProjectInvite` (`project-invites.ts:619-638`):

- Target must be the caller's own member id.
- Channel must be `dashboard`. No bound agent, no seat, no attached chat.
- `checkWebSession` must be fresh. Otherwise `reauth_required` or `forbidden`.
- Squad rank is then capped at observer. No standing on that squad → `forbidden`.

The account script special-cases one error: `reauth_required` navigates to
`/auth/reauth?return=/account` (`account.ts:307-308`). Every other failure
becomes `Could not connect (<error or status>).` (`309-311`). The JSON body
is `{ error }` with no `next_step` (`members/index.ts:1252`). Codes the human
can hit from this button, and the status (`projectInviteErrorStatus`,
`members/index.ts:1207-1222`):

| error | status | next step on the page |
|---|---|---|
| `reauth_required` | 403 | yes — reauth URL |
| `forbidden` | 403 | raw code |
| `cannot_grant_above_own_rank` | 403 | raw code |
| `member_not_active` | 403 | raw code |
| `home_scope_not_invitable` | 403 | raw code (picker should already have hidden home) |
| `member_not_found` | 404 | raw code |
| `member_missing_email` | 400 | raw code |
| `invalid_expiry` / `invalid_*` | 400 | raw code |
| `project_not_found`, `project_squad_not_linked` | 404 | raw code |
| `project_not_active`, `archived_project` | 400 | raw code |
| `pairing_code_collision` | 409 | raw code |
| `squad_archived` | 409 | raw code (handler, before the service) |
| network throw | — | "Network error — try again." |

A 201 shows the pairing code in the page (`account.ts:273-305`). The button
stays disabled. The page does not poll for `telegram_chat_id`. "Connected"
appears only after a reload, and only after the bot redeem succeeds. Minting
the code is presented as the connect action.

Deep link, when `im_bot_username` is a valid stored username
(`account.ts:403-404`, `283-291`):

`https://t.me/<username>?start=<pairing_code>`

The code is 32 random bytes, base64url, 43 characters (`project-invites.ts:347-356`).
Telegram's `start` payload allows `A-Za-z0-9_-` up to 64 characters, so the
payload fits. Under the link: "Tap Start in Telegram. Once the bot confirms
the link, send /muneeds … then /muapprove \<task id\> or /mureject \<task id\> \<reason\>."
If the username is unset or fails `IM_BOT_USERNAME_RE`, there is no link.
Copy: "Message the bot and send: /start \<code\>" and "Ask your owner to set
the decision bot username" (`account.ts:292-299`). That is a real next step.
The owner sets it at `/admin/im-settings` (owner only; others see "Owner only"
with a hint, `im-settings.ts:129-172`) or wizard step 6.

### Disconnect

`DELETE /api/members/members/:id/telegram` (`account.ts:222`, handler
`members/index.ts:1711-1781`). Self-unbind skips the admin capability check
(`1702-1706`) and still runs `targetRankCeiling` (`1731`). Confirm dialog,
then either reload or `Disconnect failed (<error>).` (`229-230`). No reauth
redirect on this button.

Refusals: `member_not_found` 404, `telegram_not_bound` 404, ceiling refusal
(shape from `targetRankCeiling`), plus a 0-row race that does not return
`telegram_unbound: true`. None of those carry `next_step`. Success also
revokes Mini App devices (`1779`). The page does not say the phone setup
died with the bind.

If a historical `telegram_origin_bind_receipts` row exists, the connected
panel says "Bound via agent \<name\> … from message \<id\>" (`account.ts:359-364`).
The origin path no longer binds a chat (`origin-verdict.ts:294-298`). The
line can describe an old receipt on a chat that was later bound from this page.

## 2. Redeem: `/start` on the decision bot

`POST /im/webhook` is mounted at `/im/webhook` (`src/index.ts:143`,
`ROUTES.im` is `/im`). The handler returns JSON `{ ok, reply, bound, member_id,
home_squad_id, intake_state }` for a relay to paste `reply` into the chat
(`src/im/index.ts:1334-1341`). This route never calls `sendMessage`. A bot
whose `setWebhook` points straight here shows the human nothing: Telegram
does not render that JSON.

Transport refusals are non-200 and have no `reply`, so a relay that only
prints `reply` stays silent. None include `next_step`:

| condition | status | error | human sees |
|---|---|---|---|
| body not JSON / empty | 400 | `invalid_json` | silence |
| body over cap | 413 | `payload_too_large` | silence |
| `IM_WEBHOOK_SECRET` unset | 503 | `webhook_not_configured` | silence |
| secret header mismatch | 401 | `unauthorized` | silence |
| not an object | 400 | `invalid_update` | silence |
| chat id unparsable | 400 | `no_chat_id` | silence |
| sender id unparsable | 400 | `no_user_id` | silence |
| update id unparsable | 400 | `no_update_id` | silence |
| chat type not `private`, or sender id ≠ chat id | 400 | `private_chat_required` | silence (`1375-1376`) |
| text longer than 4096 | 400 | `message_too_long` | silence |
| reservation conflict | 409 | reservation error or `update_in_progress` | silence or the stored prior reply |

The private-chat rule is `message.chat.type === 'private'` and
`from.id === chat.id` (`1375`). A group, a channel, or a supergroup gets
400 and no sentence telling them to open a private chat. The approval bot
is explicit about the same fence and also stays quiet in groups
(`src/approval-bot/decide.ts:142-145`); there the silence is so a group
does not see the decision. On the decision bot it also hides the next step
from someone who added the bot to a group.

Forwarded messages that are still a private chat get a 200 and a sentence:
"Send commands directly from your private chat; forwarded commands are refused."
(`im/index.ts:365`). That one has a next step.

`/start <payload>` is the only join shape (`parseIntent`, `253-254`). Bare
`/start` (opening the bot with no payload) is not a join. An unbound chat
then gets: "You're not registered with this workspace yet. Ask an admin to
invite you, then connect Telegram." (`411`). That is the wrong next step for
someone holding a pairing code who opened the bot from search instead of the
deep link. The sentence does not mention `/start <code>`.

A real `/start <code>` with a reserved private envelope calls
`redeemTelegramProjectInvite` (`368-376`). Every failure becomes one sentence:
"Could not join. Ask an admin for a new invitation." (`405`). The comment
above it (`377-381`) refuses to echo the error enum, because
`invalid_or_expired_pairing_code` vs `ambiguous_pairing_code` vs
`telegram_identity_conflict` vs `member_already_exists` would be an oracle.
The collapse also hides the cases that are not an oracle and that the human
can fix without an admin:

| redeem error | what happened | what they are told |
|---|---|---|
| `invalid_or_expired_pairing_code` | bad, used, or expired code (24h on the account button; up to 7 days elsewhere) | ask an admin |
| `ambiguous_pairing_code` | hash collision across rows | ask an admin |
| `telegram_identity_conflict` | this member is already bound to a different Telegram user (`810-820`) | ask an admin |
| `member_already_exists` | net-new email already has a member | ask an admin |
| `invite_minter_authority_lost` | minter dropped below the floor, or the target outgrew them (`914-924`) | ask an admin |
| `redemption_failed` | claim/bind batch did not land | ask an admin |
| `update_receipt_invalid` / `update_already_completed` | receipt state | ask an admin |

A self-service user can mint a fresh code themselves on `/account`. The bot
does not say that. An identity conflict is fixed by Disconnect on the account
that already holds this Telegram, then connecting again. The bot does not say
that.

Success: "Joined project \<id\>. Use /needs to see what needs your attention."
(`478-479`). The account page told them `/muneeds`. The alias exists
(`229-235`: `muneeds` → `needs`), and the file header says Hermes owns the
bare `/needs`, `/approve`, `/reject`, and `/answer` commands (`224-228`).
The success line teaches the command Hermes swallows. It also never mentions
`/login` / `/mulogin`, which is the only way a member created by this redeem
gets a web sign-in (`414-436`).

`docs/workflows/02-first-person-telegram-intake.md:12-16` describes a probe
body `{kind: first_person_status_probe, user_id, chat_id}` posted at this
webhook. The handler does not read `kind`. That body fails `no_chat_id` /
`no_user_id` and never returns `intake_state`. `intake_state` is attached
only to a normal private update that already passed the fence (`1406-1417`).
The line numbers in that doc do not match this file. If the plugin still
sends the documented probe, first-person intake never starts. This repo
cannot confirm the plugin.

## 3. Commands after the chat is bound

`normalizeImCommand` (`237-242`) strips `@bot` and maps only these aliases:
`muneeds`, `muapprove`, `mureject`, `muanswer`, `mulogin`. Bare and `/mu`
forms then share one handler. Unbound chats never reach that switch except
for `/start`.

`/login` and `/mulogin` (`416-436`), private envelope required:

| result | sentence | next step in the sentence |
|---|---|---|
| not a private envelope | "Send /login from your direct Telegram conversation with me." | yes |
| `PUBLIC_ORIGIN` empty | "Web sign-in is not configured for this workspace. Ask an admin." | yes |
| `already_has_login` | open the workspace and sign in | yes |
| `no_email` | ask an admin to add an email, or use a new invitation | yes |
| `agent_backed` | "This account cannot use a web sign-in link." | no |
| other mint failure | "Could not create a sign-in link." | no |
| success | browser link, "valid 10 minutes, one use", do not share | yes |

The link TTL is `TELEGRAM_LOGIN_LINK_TTL_SECONDS = 600` (`src/auth/telegram-login-link.ts:29`).
The reply is stored on the webhook receipt so a duplicate delivery can resend
it (`im/index.ts:429-435`). The relay and the receipt both see the bearer.
Confirming it needs a fresh browser sign-in whose verified email matches the
member. That confirm page is a separate route (`/auth/telegram-link`); this
audit did not re-walk its UI copy.

`/needs` and `/muneeds` (`489-538`). Empty: "Nothing needs your attention in
your accessible projects." Truncated scan: "More may be waiting for you. Open
the dashboard Needs You inbox to see it." Each row's actions:

- approve → `/muapprove <source_id>`
- reject → `/mureject <source_id> <reason>`
- answer → `/answer <source_id> <choice>` (bare; Hermes owns `/answer`; the alias `/muanswer` is not what the row prints, `501-504`)
- view → `safe_url`

No error code. A project-access row appends who/project/level/reason before
the command (`520-525`). Overflow tells them to open the item or the dashboard.

`/approve` and `/muapprove`, `/reject` and `/mureject` (`295-305`, `733-828`).
The ref must be 6–64 of `[A-Za-z0-9_-]`. An 8+ character prefix resolves to
one task (`710-730`); shorter than 8 and not an exact id → "No task named …".
Two prefix matches → "Use the full task id." Reject with no reason →
`Add a rejection reason: /mureject <ref> <reason>.` That next step uses the
alias. Other sentences (permission, no gate, wrong status, self-verdict,
archived, expired, race, evidence fence, dedicated office tool) name the
condition. The office one names `office.review_approval`. Expired says the
requester has to resubmit. None of these are a `next_step` field; the
sentence is the whole contract. Approve may carry trailing words; the IM
parser keeps them as `note` (`295-304`). The harness path refuses that same
trailing text (below).

`/answer` failures echo the raw service error: `Could not answer: ${result.error}.`
(`450`). No map, no next step.

Help (`318-323`) lists the bare commands Hermes owns, plus `/login`, and does
not list `/muneeds`, `/muapprove`, `/mureject`, `/muanswer`, or `/mulogin`.
Unknown text gets "Sorry, I didn't catch that." plus that help (`455-456`).

`/status`, `/wake`, `fleet`, `directive`, and `task:` are the same seam.
They are not the login path. Fleet and directive repeat the forwarded-message
refusal with their own sentence (`641-642`, `875-876`) even though line 365
already returned for every forwarded update. Those two sentences are dead.

## 4. `human_origin` on `task_verdict`

This is not a command the human types at mupot. The harness stamps the human's
Telegram message onto `task_verdict` (`src/mcp/index.ts:2766-2804`,
`src/im/origin-verdict.ts:681-725`). A direct `/muapprove` on `/im/webhook`
writes the verdict as the member and does not go through this stamp
(`src/gates/decision-card.ts:10-16`).

Hard refusals, no fallback, no `next_step` in the tool error:

- Caller is not an allowlisted workspace agent token: `400 human_origin_not_applicable`
  (`mcp/index.ts:2796-2804`). Allowlist is `HUMAN_ORIGIN_ATTESTOR_TOKEN_IDS`
  (`src/im/origin-attestors.ts:15-21`). Empty list refuses everyone.
- Same code for directory OAuth, any seat, or a harness-credential session.
- Replayed update: `409 origin_replayed` (`2816-2817`).

Every other failure is returned as `human_origin: { applied: false, reason }`
and the call continues as the agent's own authority (`2771-2774`, `2847-2850`).
The human is not told. Reasons (`origin-verdict.ts`):

| reason | when | next step for the human |
|---|---|---|
| `text_required` | `text` omitted | none on the tool result |
| `invalid_origin_shape` | bad ids, non-telegram channel, bad timestamp, empty/huge text | none |
| `origin_stale` | `message_at` older than 10 minutes or more than 60s in the future (`175-176`, `227-229`) | none |
| `task_not_named` | task id or an 8+ hex prefix is not in the text (`251-257`) | none |
| `origin_verb_mismatch` | the whole message is not one command (`268-281`) | none |
| `agent_not_owned` | calling agent has no `owner_member_id` | none |
| `member_inactive` | owner missing or not active | none |
| `origin_chat_not_bound` | owner has no `telegram_chat_id` yet (`423-424`) | connect on /account; the tool does not say so |
| `origin_member_mismatch` | bound chat id ≠ stamped chat id | none |
| `assignee_conflict` | caller is the assignee, or the member owns the assignee | none |
| `origin_rate_limited` | one applied origin verdict per member per 30s (`183`, `305-315`) | none |
| `origin_not_gate_authorized` | gate / rank | none |
| `project_write_forbidden` | evidence fence | none |
| `gate_requires_dedicated_predicate` | `gate:office` | IM path names the tool; this reason does not |

The anchored command (`268`) is the whole message, case-insensitive:
optional slash, optional `mu`, `approve` or `reject`, optional `@bot`,
a task ref, and a reason only on reject. Questions, "don't approve", a pasted
card, and non-English verbs are `origin_verb_mismatch`. The private-chat
check is `user_id === chat_id` on the stamp (`211`), not a Telegram signature.
`message_at` is caller-supplied; the file says so (`171-174`). A harness can
stamp "now" on an old line and pass the 10-minute window. That is the
documented trust boundary, not a second clock bug.

`origin_chat_not_bound` is the trap after a "successful" account connect that
never redeemed: the harness cannot decide until `/start <code>` has written
`telegram_chat_id`. The origin path will not bind it (`294-298`).

## 5. Decision cards

`deliverDecisionCard` (`src/gates/decision-card.ts:103-174`) sends a JSON
`decision_card` into the inbox of agents the member owns whose live token id
is on the attestor allowlist (`70-91`). No such agent → `{ status: 'no_owned_agent' }`
and the caller keeps "requires a human" (`20-24`). The card is not a Telegram
message. `approve` is `/muapprove <first 8 hex of the task id>` (`124-136`).
`reject` is `/mureject <8 hex>` with no reason; `reject_hint` adds `<reason>`.
A harness that pastes the JSON into chat fails `origin_verb_mismatch`. A human
who types the `reject` line with no reason gets the IM "add a reason" sentence,
which is a next step. A human who types the same line into the approval bot
is on a different id space (next section).

## 6. Elevation links, the approval bot, and the Mini App

`request_elevation` tries the approval bot first (`src/mcp/index.ts` around
the `deliverElevationToApprovalBot` call), then the Mini App button, and
always can still return `approve_url`. The bot is off unless
`APPROVAL_BOT_TOKEN` is set (`src/approval-bot/config.ts:1-2`); off means the
route is 404 (`routes.ts:18`) and delivery is `unavailable`. Misconfigured
(token shape, secret length, username, or the token/secret colliding with
the notification bot, the Mini App bot, or `IM_WEBHOOK_SECRET`) is 503
`approval_bot_not_configured` with a reason string that stays server-side
(`config.ts:29-46`). Wrong webhook secret is 401. After the secret, the
handler returns 200 so Telegram does not retry (`routes.ts:4-5`).

The card the human reads (`src/approval-bot/policy.ts:80-95`) ends with:
"Tap a button, or reply /muapprove \<id\> or /mudeny \<id\>." That `/muapprove`
approves an elevation short id (8 chars, no `0`, `1`, `l`, `i`, `o` —
`policy.ts:42-44`). The decision card's `/muapprove` approves a task. Same
spelling, different bots, different ids.

Approval-bot chat copy (`decide.ts`), and whether it tells them what to do:

| case | what they see | next step |
|---|---|---|
| group / channel / sender ≠ chat, callback | toast "Decide in your private chat with this bot." | yes |
| same, ordinary message | nothing (`142-145`) | no |
| forwarded | "A forwarded message cannot decide anything. Type the command yourself." | yes |
| `/start`, `/needs`, `/login`, any other slash command | nothing (`152-154`, `not_our_command`) | no |
| plain text | nothing | no |
| not bound, suspended, or agent-welded | "This Telegram account is not linked to a member who can decide. Link it under My Account (Connect Telegram)." | yes |
| `/muhelp` | help paragraph (`128`) | yes |
| approve/deny with no id | "Name the request: /muapprove \<id\> …" | yes |
| unknown id, or the delivery was not to this member in this chat | "No such pending request for you." | no |
| button from another message | "That button is not for this request." | no |
| action the bot may not carry | "This request needs a stronger approval than a Telegram tap. Open the approval link instead." | partial — no URL in the sentence |
| no web login identity | "Sign in to the dashboard once (any login method) so your approvals have a session, then try again." | yes |
| decision core throw | "The decision could not be recorded. Nothing was changed." | no |
| 200 | "Approved/Denied \<id\>. \<core message\>" | the core message |
| 409/410 | "Request \<id\> is closed: \<message\>" | the core message |
| other core status | "Not decided: \<message\>" | the core message |

A deep link aimed at this bot (owner pasted `APPROVAL_BOT_USERNAME` into
`im_bot_username`) makes Telegram send `/start <pairing code>`. That command
is ignored with no reply (`152-154`). The human taps Start and the chat stays
empty. The account page still shows the pairing code as if connect worked.

Delivery to the bot (`deliver.ts:53-91`): not bound, no deciding human, or
the member may not decide → `not_bound` (the tool then tries the Mini App /
`approve_url`). The human gets nothing from this bot in that case. An attached
chat is not offered here (`58-62`). Send failure is `failed` / `chat_unreachable`
inside the worker; the human is not told why no card arrived.

Mini App sends use `TELEGRAM_MINIAPP_BOT_TOKEN` only (`telegram-miniapp-send.ts:22-36`).
The bot must be a different bot from `TELEGRAM_BOT_TOKEN` (`telegram-miniapp-config.ts:45-48`).
The approval bot must be different again (`approval-bot/config.ts:9-10, 38-42`).
Auto text (`telegram-miniapp-auto.ts:87`): "\<agent\> asks \<what\>. Open it below…
First time on this phone? Set it up under My Account first." Sensitive actions
stay on a passkey. `not_bound` / `disabled` / `failed` / `rate_limited` are
status words on the tool result, not chat messages. Two or more reachable
org admins with a bound chat means nobody is addressed (`decidingHuman`,
`45-68`).

"Set up this phone" (`account.ts:484-504`, `telegram-miniapp-enrol-delivery.ts:35-40`)
sends a web_app button from the Mini App bot, valid 10 minutes, to the bound
private chat. The success line says: "Open the new message from the approvals
bot". `chat_unreachable` says: "open the approvals bot in Telegram and press
Start". The approvals bot is the other bot. Pressing Start there does not
open the Mini App bot's chat, so the button never becomes deliverable.
`telegram_not_bound` does name the section above. `reauth_required` links to
`/auth/reauth?return=/account`. `rate_limited` says wait a few minutes.
Anything else is `Could not send (<error>).`.

initData freshness defaults to 5 minutes, cap 1 hour
(`telegram-miniapp-config.ts:53-59`). That clock is not the 10-minute origin
window and not the 10-minute login link.

## 7. The other bind: `/link` on `/channels/telegram/webhook`

`POST /channels/telegram/webhook` verifies `IM_WEBHOOK_SECRET`, parses the
update, runs a different intent parser, and `sendMessage`s the reply with
`TELEGRAM_BOT_TOKEN` (`channels/adapters/telegram.ts:46-79`,
`channels/index.ts:749-812`). Unbound channel: "This channel is not wired to
a squad yet. Ask an admin to bind it." Unmapped user: "Send \"/link \<code\>\"
with the code an admin gave you." (`343-365`). `/start` is not an intent
(`parseIntent`, `155-192`), so a My Account deep link that lands on this bot
is "I didn't catch that" plus help that only mentions `/link`. Link codes are
minted by `POST /channels/.../link-codes` (`channels/admin.ts:118-137`), not
by the account button. `/account` never shows a `/link` code. The two binds
write different rows: `members.telegram_chat_id` versus `member_identities`.
A channel bind does not satisfy `memberForChat` or `origin_chat_not_bound`.

## Ranked fixes

Each one is a single PR. None of them is "point the deep link at
`TELEGRAM_BOT_TOKEN`" — that is the #1420 incident.

1. **Teach the commands Hermes does not own.** In `src/im/index.ts`, change
   `joinedReply` (`479`), `HELP` (`318-323`), and the answer action in
   `needsReply` (`504`) to `/muneeds`, `/muapprove`, `/mureject`, `/muanswer`,
   and `/mulogin`. Add `/mulogin` to the join sentence for a member who has
   no web sign-in yet. Update `tests/telegram-project-onboarding.test.ts`
   (the join sentence is locked at line 2784). Today the account page and
   the bot disagree, and the bot's version is the command the relay eats.

2. **Join failures that are not a code oracle get a next step.** In the
   `join` branch of `handleImMessage` (`src/im/index.ts:405`), keep one
   sentence for bad/expired/ambiguous codes (no enum). For
   `telegram_identity_conflict`, say this Telegram is already linked and
   point at Disconnect on My Account. For `invite_minter_authority_lost`,
   say the invitation is no longer valid and to press Connect again (or ask
   an admin if they did not mint it). Do not print the raw error.

3. **The account button must say what it actually did.** In
   `src/dashboard/account.ts` (`242-319`, `425`): after a 201, say the code
   is not a connection until the bot replies, and say to reload this page.
   Drop "be notified through chat" (`425`) — notifications are one
   `TELEGRAM_CHAT_ID` (`src/telegram-bridge/bus_notify.ts:153-164`). Name
   the decision bot in the success paragraph so it is not the approval bot
   and not the Mini App bot.

4. **Stop calling the Mini App bot the approvals bot.** Two strings in
   `src/dashboard/account.ts` (`496` and `501`) send the human to press Start
   on the wrong bot. The sender is `TELEGRAM_MINIAPP_BOT_TOKEN`
   (`src/secure-moments/telegram-miniapp-send.ts:28-36`). Point at that chat.
   A display username for the Mini App bot (same kind of non-secret setting
   as `im_bot_username`, written from `src/dashboard/im-settings.ts`) is the
   small way to name it. Do not reuse `APPROVAL_BOT_USERNAME`.

5. **`/muapprove` cannot mean two decisions.** The approval card
   (`src/approval-bot/policy.ts:94`) and `HELP` (`src/approval-bot/decide.ts:128`)
   should say the id is the elevation id from this bot's own message, and
   that a task id is decided in the decision bot. The decision-card lines
   (`src/gates/decision-card.ts:135-138`) should say the opposite in one
   clause. Unknown slash commands on the approval bot (`decide.ts:152-154`),
   including `/start`, should get one sentence: this chat is for approval
   buttons; pairing codes go to the decision bot. Otherwise a mis-set
   `im_bot_username` is a silent Start press.

6. **A member with only a home squad can connect.** `loadConnectableSquads`
   drops `kind = 'home'` (`src/dashboard/account.ts:183`) and
   `createProjectInvite` rejects home (`src/members/project-invites.ts:587`),
   so the self-service empty state (`account.ts:380-387`) is the normal new
   account. Add an identity-only self-bind that writes `telegram_chat_id`
   and does not insert a capability row (the observer self-connect already
   promises not to change grants; `project-invites.ts:634-635` and
   `893-895`). Keep the home-squad standing ban. Files:
   `src/members/project-invites.ts`, `src/dashboard/account.ts`, and a
   migration only if `invites.squad_id` cannot be null for this shape.

7. **Private-chat refusals on `/im/webhook` should carry a reply.** For
   `private_chat_required` (`src/im/index.ts:1375-1376`), return 200 with
   `reply` telling them to open a private chat and send the command there,
   so the Hermes relay has something to paste. Leave the approval bot silent
   in groups (`decide.ts:142-145`); that silence is about not leaking a
   decision into a group. Do not add a `sendMessage` on this route using
   `TELEGRAM_BOT_TOKEN`.

8. **`human_origin` refusals need a `next_step` the harness can quote.**
   `humanOriginResponsePayload` (`src/mcp/index.ts:2674-2677`) returns only
   `applied` and `reason`. Add a fixed sentence per reason for
   `origin_stale` (send the command again), `origin_chat_not_bound` (Connect
   Telegram on My Account, then `/start` the code), `origin_verb_mismatch`
   (one `/muapprove` or `/mureject` line, nothing else), and
   `task_not_named`. Keep the agent-authority fallback as it is; the gap is
   that the human never hears which conjunct failed. The 10-minute window
   stays in `src/im/origin-verdict.ts:175-176`.
