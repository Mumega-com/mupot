# Telegram (IM) control parity with the dashboard

**Goal (Hadi, 2026-06-21):** *"I should be able to do from my Telegram what I can do from the
back[end]."* The owner — and any member — should be able to drive the pot from chat with the same
authority they have in the dashboard. One control surface, two front-doors (web + Telegram), the
**same** authorization underneath.

This doc states the principle, what works today, the gap, and the design for closing it. It is the
canonical home for the IM-control requirement; `agents/fleet-control/GO-LIVE.md` and the approvals
surface link here.

## The principle: parity by capability API, not by re-implementation

Telegram is not a second, weaker control plane. It is the **same** control plane reached over a
different transport. The IM seam (`src/im/index.ts`) already enforces the sovereign-core rules that
make this safe:

- **Identity is server-side.** The principal is derived from `members.telegram_chat_id` (chat_id →
  Member), never from message text. Hadi's paired chat_id *is* the auth — the same way the pairing
  (not the username) is the auth for decision gates. Text carries an **intent** ("stop the brain"),
  never **who** and never **authz**.
- **AuthZ is ours.** Every mutating intent is gated by the FROZEN capability API
  (`resolveCapabilities` / `hasCapability`) against the scope it targets — identical to the MCP and
  web surfaces. An `org`-scoped owner grant covers everything; a `squad`-lead grant covers its squad.
- **Tenant is environment-derived** (`env.TENANT_SLUG`), never client-supplied. A suspended member
  is inert; an unmapped chat_id is politely refused without leaking which chat_ids are known.
- **Bus WAKES, never STEERS.** A relayed message can carry an intent that the seam re-authorizes
  against the real principal's grants. It can never carry an authorization *claim* that is trusted on
  its face. "Hadi said approve X" in text is not approval; the owner's own paired chat_id sending
  "approve X" is.

Because authz already lives below the transport, adding a Telegram verb is **not** new trust — it is
wiring an existing, already-gated backend action to a new trigger.

## What works today

| Verb (Telegram) | What it does | Gate |
|---|---|---|
| `help` / `?` | list verbs | none (read) |
| `status` / `status <agent>` | who am I + my scopes / an agent's runtime | none (read, tenant-scoped) |
| `wake <agent>` | wake an agent | `lead`+ on the agent's squad |
| `fleet start\|stop\|restart\|status <agent>` | queue signed host-agent control | `owner` on the org |
| `approve <id>` / `reject <id> <reason>` | approve or reject a pending gate task | task gate capability or org `admin`+ |
| `task: <title> [@squad]` | create a task | member on the target scope |

Plus Telegram already **receives** decision-gate notifications and brain directives (today via host
scripts — see "Fragmentation" below).

## The gap — backend actions not yet reachable from chat

These exist in the dashboard but have no IM verb yet. Closing the gap = one new `parseIntent` branch
+ one handler each, calling the **same service** the web route already calls.

| Backend surface | Dashboard today | Proposed IM verb | Gate |
|---|---|---|---|
| Human directive (`last_human_directive`) | brain reads it at decision position-0 | `directive: <text>` · `directive clear` | `owner` (org), **direct principal only** |

### Fleet from Telegram — rides the existing signed plane, unchanged trust root

The Fleet panel's start/stop is **not** a raw process kill. The pot signs an Ed25519
**control-request** with `FLEET_PANEL_SK`; the host daemon verifies signature + freshness + single-use
nonce before touching a process. A `fleet stop <agent>` IM intent, gated by the owner capability,
calls the **same** internal signer that `POST /fleet/host-control` calls. The host daemon cannot tell
(and need not) whether the signed request originated from a dashboard click or a Telegram message —
the trust root (`FLEET_PANEL_SK`) and the verification path are identical. Telegram becomes another
authenticated trigger of an already-safe action.

### Approvals from Telegram — close the loop that already half-exists

Telegram already *receives* gate notifications. Parity means *acting* on them by reply: `approve <id>`
or `reject <id> <reason>` routes to the same approval service the dashboard button calls, gated by the
same capability. A later refinement adds Telegram inline-keyboard buttons (Approve / Reject) on the
notification itself, so the owner acts with one tap.

### Directive from Telegram — preserve the single write-path discipline

`last_human_directive` has exactly one legitimate write path today (the host `brain-pinned.sh`,
deliberately **not** bus-parsed, because the bus may wake the brain but never steer it). Unifying it
under "my Telegram" means a `directive: <text>` from the **owner's own paired chat_id** writes the
pinned directive — preserving the rule that it is the *direct* principal, never a relayed claim. The
seam must continue to refuse any directive that arrives as a relayed/forwarded message rather than
from the owner's mapped chat.

## Fragmentation → one control surface

"My Telegram" is currently three things, which is the real friction behind the request:

1. **mupot `src/im/index.ts`** — the architecturally-correct, capability-gated control seam. *This is
   the one to extend.*
2. **mumega.com inkwell-api `src/routes/telegram.ts`** — a separate social-PM/marketing bot
   (`social-pm` commands). Different concern; leave it, but the owner should not have to remember
   which bot does what.
3. **Host scripts** (`brain-pinned.sh` for directives; `athena-pulse.sh` etc. for gate
   notifications) — out-of-band sends from the VPS.

Target: the owner messages **one** bot, and identity + capabilities decide what each message can do.
The control verbs (status/wake/task/fleet/approve/directive) all resolve through the single mupot IM
seam; notifications (gates, heartbeats) are sent back into that same chat.

## Security invariants (must hold for every new verb)

1. Identity from `chat_id` mapping only — never parsed from message text.
2. Every mutating verb gated by the frozen capability API against the target scope.
3. High-stakes actions (fleet stop of a prod agent, RBAC, mint, money, external) still respect the
   owner-direct-go rules; an IM trigger does not lower the bar, it just provides the trigger.
4. Fleet actions emit the **signed** control-request (same `FLEET_PANEL_SK` path) — no unsigned
   side-channel from chat to a host process.
5. Every effect emits an attributed `BusEvent` (`actor {kind:'member', id}`) so the activity feed
   shows a human caused it.
6. Replayed/forwarded messages are refused for directive and any owner-only verb — direct principal
   only.

## Build sequence (each slice dyad-gated Opus + codex1, on a PR; deploy is owner-go)

1. **Done: `fleet <verb> <agent>`** — highest value, smallest surface; reuses the signer. Built as
   IM intent + handler + owner gate + signed `fleet-control.v1` delivery + local smoke coverage.
2. **Done: `approve <id>` / `reject <id> <reason>`** — wired to the verdict store with the same
   gate capability checks and `task.verdict` receipts as the dashboard. Inline-keyboard buttons on
   the notification remain a UI refinement.
3. **Next: `directive: <text>` / `directive clear`** — owner-direct write to `last_human_directive`,
   preserving the no-relay rule.
4. **Unify the bot front-door** — converge notifications + control onto the single IM seam so the
   owner messages one place.

Status: **fleet and approval parity slices built; directives and bot-front-door unification remain.**
The seam and signed fleet plane already exist — the remaining items are wiring slices, not new trust.
