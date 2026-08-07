# Channel identity and caller authority

**Status:** SPEC — supersedes the hardcoded sender allowlist shipped in #769
**Applies to:** every IM platform, not Telegram. Telegram is the first implementation, not the design.

## The idea, in one line

**A message from a channel acts with the CALLER's authority, not the bot's.**

You DM the bot → it acts as you. Gavin DMs it → it acts as Gavin. Gavin @-mentions it in a
group → still Gavin. The agent working on its own → its own agent token. The bot is a
**door**, not an identity.

## Why the allowlist shipped in #769 is the wrong shape

`TELEGRAM_ALLOWED_SENDERS=765204057` answers exactly one question: *may this person speak
at all?* It cannot answer *what may this person do?* — and that is the only question worth
answering.

It also does not survive contact with customers:

- every tenant's users would live in **our** Worker config
- adding a customer = a **deploy**
- one flat list across all tenants = **no isolation between them**
- it is per-platform, so Discord and Slack each grow their own list

The security *floor* it established is correct and stays: fail closed, verify before
parse, refuse the unknown. Only the **list** is replaced.

## THE SECURITY PRINCIPLE THAT DRIVES THE DESIGN

> *"My Telegram is as secure as my Gmail — because if I have you on it, you have access to
> my Gmail."* — Hadi, 2026-08-07

**A channel binding inherits the blast radius of everything the bound member can reach.**
Binding a Telegram account to a member with Gmail, Cloudflare and D1 access makes that
Telegram account a credential for Gmail, Cloudflare and D1. The channel is not "a chat
app" — it is **an authentication factor for the union of that member's capabilities.**

Three consequences, all non-negotiable:

1. **Binding is a deliberate act, never inferred.** No auto-binding from a display name, a
   phone number, or an email string in a payload. mupot already learned this the hard way —
   `channels/index.ts:102`: *"email auto-bind was REMOVED. The shared-token webhook verify
   does not cryptographically prove the payload's sender email, so auto-binding from it let
   a [caller forge identity]."* Same rule, every platform.
2. **Binding is revocable and enumerable.** You must be able to ask *"which channel
   identities can act as me?"* and remove one without touching the others.
3. **The bind ceremony must be at least as strong as the weakest thing it unlocks.** A
   member with production access should not be bindable by clicking a link in a chat. This
   is why the login flow below exists.

## Model

```
  inbound message
        │
        ▼
  1. AUTHENTICITY   platform-specific: is this really from the platform?
        │           (Telegram secret token · Discord Ed25519 · Slack v0 signature)
        ▼           fail → 401, nothing parsed
  2. IDENTITY       (platform, platform_user_id) → member_id
        │           NOT resolvable → 403, nothing dispatched, no side effect
        ▼
  3. AUTHORITY      member_id → capabilities (existing RBAC, unchanged)
        │           over-scope intent → refused with the reason
        ▼
  4. ACT            dispatch carries the CALLER's capabilities, not the bot's
```

Step 1 already exists per platform. Step 3 already exists (RBAC, the email→member bridge).
**Step 2 is the missing piece, and it is one table.**

### `channel_identity`

| column | notes |
|---|---|
| `platform` | `telegram` \| `discord` \| `slack` \| `google_chat` \| `whatsapp` |
| `platform_user_id` | the platform's **immutable numeric/opaque id** — never a username |
| `member_id` | FK → members |
| `tenant` | tenant scope |
| `bound_at`, `bound_by`, `bound_method` | audit: who authorised this and how |
| `revoked_at` | soft-revoke, so history survives |

Unique on `(platform, platform_user_id, tenant)`.

**Never key on a username or handle.** Telegram usernames, Discord handles and Slack
display names are user-mutable and can be released and re-registered by someone else. A
display-name binding is a spoofable credential. (Same defect class as the actor id fixed in
#769.)

## Platform adapters — what differs, what does not

Only **step 1** and **the id field** are platform-specific. Steps 2–4 are shared.

| platform | authenticity | immutable caller id | mention semantics |
|---|---|---|---|
| Telegram | `X-Telegram-Bot-Api-Secret-Token` | `message.from.id` (int) | `@bot` in text |
| Discord | Ed25519 signature header | `member.user.id` (snowflake) | `<@bot_id>` in mentions |
| Slack | v0 signing secret + timestamp | `event.user` (`U…`) | `app_mention` event |
| Google Chat | Bearer JWT (Google-signed) | `message.sender.name` | `@bot` in annotations |

A mention is a **routing hint, never a credential** — on every platform. Group scope decides
*whether to look*, identity decides *what may happen*.

## Binding ceremony

**Now (keep it simple, per Hadi):** an admin binds explicitly —
`channel_bind {platform, platform_user_id, member_id}`. Deliberate, audited, revocable.

**Next (the login flow):** unbound caller receives a one-time mupot login link → authenticates
with Google → the resulting session proves *which member they are* → mupot writes the binding.
Session may expire; the **binding persists** until revoked. This makes the ceremony as strong
as the Google account, which satisfies the principle above.

**Never:** binding inferred from a name, an email string in a payload, or first-contact.

## Self-service binding — a member links their own channel

**No human should type another person's platform id.** `bound_method: 'admin'` asserts an
identity nobody verified, and it does not survive customers: every new member would queue
behind an operator.

**The member proves their own identity, and never hands over a credential:**

```
1. member logs into the mupot dashboard      <- this IS the proof of which member they are
2. "Connect Telegram" -> short-lived, single-use link code
3. member messages the bot:  /link ABC123
4. ingress sees an unbound caller WITH a valid code
   -> binding written: bound_method='verified_login', bound_by=<their own member id>
```

**Why this is safe with no API key and no pasted id:**

| fact | proven by |
|---|---|
| which member this is | the authenticated dashboard session |
| which platform account this is | **the platform itself** — Telegram reports `from.id`, which the sender cannot forge |
| that they are the same person | possession of a single-use code only that session could obtain |

The bot learns the platform id **from the platform** — the one thing it can actually prove.

**Code requirements:** single-use, short TTL (~10 min), bound to one member, invalidated on
use or expiry, rate-limited per member. A leaked code must expire before it is useful and
must bind at most one account.

**Platform-neutral.** Only step 3 differs — `/link` in Telegram, a slash command in Slack,
a bot DM in Discord. Steps 1, 2 and 4 are shared, the same property that makes resolution
platform-agnostic.

**Prior art already in the schema:** `members.telegram_chat_id TEXT UNIQUE` has existed
since `0002_members.sql` — a single-platform version of this mapping, found by running
tests against the real schema. `channel_identity` generalises it and adds revocation and
audit; a later migration should reconcile them. Until then `channel_identity` is
authoritative for ingress.

## Autonomous work is unchanged

When an agent acts on its own — routine, cron, self-directed — it uses **its own
agent-bound token** and its own capabilities. Caller authority applies only when a human
initiated the turn. That distinction is already correct in mupot and this spec does not
touch it.

## What this replaces

- `TELEGRAM_ALLOWED_SENDERS` — deleted. Superseded by `channel_identity`.
- The standalone `/api/integrations/telegram` ingress and the pre-existing
  `/channels/:platform/webhook` become **one seam**. Two paths with two authorisation
  models on one surface means the next channel author guesses, and **the weaker one sets
  the real level**. (Found by mubot probing a path nobody mentioned.)

The fail-closed behaviour proven live in #769 is preserved exactly: unresolvable identity
refuses, with no dispatch and no side effect — the same as an unlisted sender does today.

## Done when

1. `channel_identity` exists with the binding recorded and revocable.
2. A message from a **bound** caller dispatches with **that member's** capabilities — verified
   by two different members getting two different outcomes on the same command.
3. A message from an **unbound** caller is refused with **no dispatch and no side effect** —
   asserted on the side effect, not the status code.
4. A **second platform** (Discord) works through the same steps 2–4 with only a new adapter.
5. `TELEGRAM_ALLOWED_SENDERS` is gone from code and config.
