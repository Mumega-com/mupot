# Seat events: one body-free channel per fleet host

Branch `hadi-orca/seat-events-channel`, off `origin/main` 921dbcd. **Canary-deployed to prod
2026-09-27** at commit `f51ca40845e3faadfdc5580ad7d736bf3c802619`, `REALTIME_SEAT_EVENTS=1`. It
stays inert everywhere else until the `SEAT_EVENTS` binding exists **and**
`REALTIME_SEAT_EVENTS=1`. **As of this writing all `seat_event_grants` are revoked in prod** —
the channel is live but nothing is currently subscribed.

**mupot#1594 (gate on #1593 @ `f9212ca0`, adversarial comment 5860990271) fixes:**

- **P1-A** (anonymous lockout via forged-ticket sockets): the upgrade route checked ticket
  SHAPE only (43 chars) before forwarding to the DO — 200/200 forged tickets reached
  `acceptWebSocket` in the probe. Now closed four ways, see "Route-level ticket pre-check" and
  "WebSocket abuse controls" below.
- **P2-B** (`inbox-routes.ts`'s Herdr fence failed OPEN on a D1 error): `hostMayReceive`'s
  boolean collapse mapped a transient error to "not eligible," which fell through the fence
  and opened the legacy stream. Now fails CLOSED (503) — see "Herdr fence" below.
- **P2-C** (grant scope): a grant's host had no standing check at all, and a squad lead's
  revoke had no rank ceiling against a higher-authority creator. See "Authorization" below.
- **P3**: 404-vs-403 existence oracle unified, a timeout on the seat-hint publish, IPv6
  rate-limit bucketing. (Audited for any logging of a ticket-bearing URL on this surface —
  found none to strip; noted so a future log line doesn't reintroduce it.)

**mupot#1589 adversarial gate (kasra-review, round 1) found five P1s against that exact commit,
two of them live in prod with no grant required to reach.** `kasra/seat-events-p1-fixes`
(branched from the same pinned prod SHA, Hadi's commit kept intact underneath) fixes:

- **P1-1** (live): an agent-bound bearer could create/revoke grants → Authorization §2 below.
- **P1-2** (live): an unauthenticated WebSocket reached the DO with no deadline or cap →
  "WebSocket upgrade" note below Authorization, and the Protocol table's close-code rows.
- **P1-3**: a seat-hint failure cancelled Hermes delivery → Failure behaviour table.
- **P2-1**: the Herdr fence used a narrower predicate than delivery → "Herdr fence" bullet below.
- **P2-3**: one transient D1 error read as a revocation → Failure behaviour table.
- **P3**: `POST /ticket` had no rate limit → migration `0177`, `underTicketRateLimit`.

P1-4 (deploy/toml reconciliation) and P1-5 (migration-number collision with #1588) are
ops/sequencing, not code, and are tracked separately — see the Deploy checklist. P2-2 (a second
consumer can hold a Herdr stream open across a grant write) and P2-4 (project scope is an
eligibility precondition, not a delivery filter) are left as follow-up issues, not fixed here.

## Why

`GET /api/inbox/stream` costs one server-side D1 poll per open stream: a 1 s read plus a bearer
revalidation on every tick. A host running N seats across projects holds N streams open for
good. The seat-events channel gives each fleet host **one** WebSocket, and Mupot pushes to it
only when an `agent_messages` row actually lands.

## Flow

```
send / task_dispatch ── INSERT agent_messages ──▶ BUS.emit('message.created')      existing seam (messages.ts):
                                                  │                                 only on a real insert, no body
                                                  ▼  Queue (retry ×3, DLQ)
                                   consumer 'message.created'
                                     1. publishSeatHint ──▶ SeatEventsDO /hint     throws on failure → Queue retry
                                     2. Hermes leg (unchanged)
                                                  ▼
                                   SeatEventsDO (one per pot, WS hibernation, no alarm)
                                     re-authorize grant ─▶ {type:'hint'} to the ONE socket holding the agent
                                                  ▼
                                   fleet host (Orca mupot-seatlink) ── waits for the seat's turn to end,
                                     types one "read your inbox" notice; the seat reads + inbox_acks ITSELF
```

## Authorization

All of the following are required, and all are re-checked on every hint
(`hostMayReceive`/`authorizeSeatDelivery`, one indexed query):

1. **Signed host identity.** The host signs this message with its Ed25519 key, registered in
   `agent_keys` (the same identity used by signed attach and signed inbox):
   `seat-events-ticket:v1 \n tenant \n host_agent_id \n sorted,unique,agents \n ts \n nonce`.
   The rules:
   - the signature must be fresh (±300 s);
   - the nonce is burned in the shared ledger, and only after the signature verifies;
   - the tenant is part of the signed bytes, so no cross-pot replay;
   - the key's member must be active.
2. **An explicit grant.** A `seat_event_grants` row (migration 0176) authorizes *that host* for
   *that agent*. `POST /api/fleet/events/grants` writes it, and `DELETE /api/fleet/events/grants/:agent`
   revokes it — both are RBAC acts and require a **human member principal**: an
   `operator_principal_required` refusal on an agent-bound bearer, then org admin OR at least
   `lead` on the **target agent's own squad** (squads self-serve is the product direction; never
   cross-squad — the squad is always re-resolved fresh from the agent's own row). It can
   optionally be scoped to a project, in which case the agent must still have access to that
   project. The self-reported `fleet_agents.host` is never consulted.
   - **mupot#1594 P2-C, creating a grant:** the HOST must also have standing near the target
     agent's own squad — either the host identity IS itself an `agents` row whose home squad
     (`agents.squad_id`) is the target's ("registered to it"), or the member who registered the
     host's OWN signing key (`agent_keys.member_id`) holds squad-member-or-above capability on
     the target squad (`canOnSquad`, the SAME ladder the grant-writer rank ceiling above uses).
     Refusal: 403 `host_no_squad_standing`.
   - **mupot#1594 P2-C, revoking a grant:** a squad lead may only revoke grants inside their
     own authority. If the live grant's creator (`granted_by_member_id`) currently holds org
     admin, a non-admin revoker is refused (403 `forbidden_higher_authority`) — a lead cannot
     silently undo an org admin's routing decision. The creator's capability is checked LIVE at
     revoke time, not what they held when they created the grant (matches this codebase's
     re-check-every-time convention elsewhere: `authorizeSeatDelivery`, `hostMayReceive`). An
     org admin revoker is exempt and can revoke anything.
3. **The agent is active.**

### Route-level ticket pre-check (mupot#1594 P1-A)

The `/ticket` mint's shape-only successor turned out not to be enough: `isWellFormedTicket`
(the upgrade route's ONLY check before this fix) is a 43-char alphabet check, not verification
— 200/200 forged tickets reached `SeatEventsDO`'s `/connect` in the adversarial probe, each
consuming a socket slot before `tickets.take()` ever got a chance to refuse it inside the DO.

`POST /ticket` now writes a second, lightweight record into `seat_events_tickets` (migration
0180, tenant + sha256 hash + expiry — no agent list, no payload) at the SAME time it seeds the
DO's own storage copy. The upgrade route (`GET /`) checks that record — one indexed D1 SELECT,
no DO round-trip — before ever forwarding the WebSocket upgrade. A forged 43-char string has to
collide with a real 256-bit secret's SHA-256 hash to pass this, the same unforgeability
guarantee an HMAC signature would give, deliberately WITHOUT minting a new signing secret (which
would need a `wrangler secret put` in prod before it did anything — this migration-only table
needs no such rollout step). The single-use burn is untouched: it still happens exactly once,
inside the DO, over the hello frame. A D1 error during the pre-check fails CLOSED (401), same
posture as the rate limiters below.

Both `/ticket` and the upgrade route (`GET /`) are now rate-limited per IP, using the SAME
atomic fixed-window D1 UPSERT…WHERE count<cap pattern, in SEPARATE buckets (a ticket-mint flood
and an upgrade flood are independent failure modes). Both bucket IPv6 addresses down to their
/64 (`ipRateLimitKey`) before keying the limiter — the smallest block an RIR normally delegates,
so finer bucketing charges an attacker nothing to defeat by rotating within their own block.

A ticket request returns **one** ticket for the host:
- it lasts 60 s and can be used once;
- the DO stores only its SHA-256 hash;
- it is scoped to the agents that passed all three checks (the rest come back in `refused`).

The WebSocket upgrade is forwarded to the DO without `Authorization` or `Cookie`. The ticket
still travels in the first (`hello`) frame for redemption, exactly as before — but since the
P1-2 fix, the SAME ticket must **also** ride as a `?ticket=` query parameter on the upgrade
request itself, format-checked at the Worker route before the DO is ever called. A bare
`Upgrade: websocket` with no ticket at all — the shape mupot#1589's PROBE-G used — is now
refused (401 `ticket_required`) without reaching the DO. Orca hosts must pass the ticket they
already hold (from `POST /ticket`'s response) on the connect URL, not only in the hello frame.

## One consumer per UUID; migrating Herdr to Orca

- **Durable fence:** at most one live grant per agent (partial unique index). Moving an agent means
  revoking the old grant and granting a new one. There is no implicit takeover.
- **Live fence:** the DO lets one socket hold an agent.
  - When the same host reconnects, its old socket receives `superseded`.
  - When a grant has moved, the old host's socket receives `revoked` (`grant_moved`).
  - While another host is still authorized, a newcomer gets `held_by_other_host`.
- **Herdr fence:** while the flag is on, `GET /api/inbox/stream` returns 409
  `notify_owned_by_fleet_host` for any agent with a **live, deliverable** grant. A Herdr
  seatlink and an Orca host therefore cannot both be prompting the same seat. Revoking the
  grant reopens the stream. mupot#1589 P2-1: the fence now checks the SAME predicate delivery
  uses (`authorizeSeatDelivery`) rather than "does a grant row exist" — a grant whose host
  member is suspended, whose host key was deleted, or whose project the agent no longer has can
  never actually deliver, so it no longer fences the agent out of both channels at once either.
  mupot#1594 P2-B: that predicate is TRI-STATE (`'granted' | 'not_granted' | 'error'`), and the
  fence used to consume it through `hostMayReceive`, the BOOLEAN collapse that maps `'error'`
  to `false` — indistinguishable from a confirmed `'not_granted'`. A transient D1 error
  therefore read as "cannot deliver," the fence fell through, and the legacy stream opened wide
  (200) with no fence at all on exactly the request a real D1 blip would hit. The route now
  consumes the tri-state directly: `'error'` refuses 503 `fence_check_failed` (`Retry-After: 2`),
  `'granted'` fences 409 unchanged, and only a definitive `'not_granted'` opens the stream.

## Protocol (v1)

| Direction | Frame |
|---|---|
| host → pot | `{type:'hello', v:1, ticket, since:{<agent>: <seq>}}`: the only client frame |
| pot → host | `ready {protocol, host, subscriptions:[{agent, ok, reason?}]}` |
| | `backlog {agent, unread, complete, hints[≤50]}`: catch-up from D1 above `since` |
| | `hint {agent, hint}`: one committed row |
| | `revoked {agent, reason}` / `superseded {agent, reason}` |
| | `error {reason}` then close 4401 (`ticket_invalid`, `protocol_unsupported`, `host_socket_limit`) |
| | close 4408 `auth_timeout`: connected and never sent a valid hello within `AUTH_DEADLINE_SEC` |
| | close 4400 `frame_too_large` / `junk_frames`: oversized or unparseable/wrong-type frames |
| host ↔ pot | `ping` / `pong`: the runtime auto-response, which doesn't wake the DO or read D1 |

mupot#1589 P1-2 added the last two close-code rows as belt-and-braces DO-side controls: a
per-socket frame-size cap (`MAX_FRAME_BYTES`), a junk-frame counter that closes the socket past
`MAX_JUNK_FRAMES`, an auth deadline that closes a socket that connected and never completed
hello, and a per-host cap (`MAX_SOCKETS_PER_HOST`) on concurrent authenticated sockets.

**mupot#1594 P1-A hardened three of those controls:**

- **The auth deadline now survives hibernation and DO eviction.** It used to live in an
  in-memory `ConnectClock` (a `WeakMap` keyed on the socket wrapper), which is gone the moment
  the DO is evicted or hibernates — the adversarial probe held a pending socket open 3600s by
  forcing an evict between connect and the deadline. The connect time now lives on the
  WebSocket's own `serializeAttachment` payload (alongside the eventual `{host, agents}`
  state), so it is read back correctly by whichever DO instance is running when the sweep next
  fires, hibernated or not.
- **The sweep alarm is never postponed.** `ctx.storage.setAlarm` REPLACES any pending alarm
  rather than taking the earlier of the two, and every connect used to call it unconditionally
  — a host (or an attacker) reconnecting faster than `AUTH_DEADLINE_SEC` pushed the sweep out
  indefinitely. `nextAuthDeadlineAlarm` (pure, in `seat-events.ts`) only arms a NEW alarm when
  none is pending or the new deadline is strictly earlier.
- **Authenticated and pending sockets are capped SEPARATELY.** Before this, ALL open sockets —
  authenticated or not — counted against the single `MAX_SOCKETS_PER_POT` (500) ceiling, which
  IS the anonymous-lockout mechanism: 200 forged-ticket connections ate the same budget
  Hermes/Orca hosts need. `podAcceptRefusal` now checks `authenticated >= MAX_SOCKETS_PER_POT`
  and, independently, `pending >= MAX_PENDING_SOCKETS_PER_POT` (64) — a pending flood can never
  crowd out an authenticated host, and vice versa.

A hint carries exactly `HINT_FIELDS`: `id, seq, to_agent, from_agent, kind, request_id,
in_reply_to, target_seat, project_id, created_at`. It never carries a body. The catch-up query
selects those columns by name.

## Separate ledgers

- **Transport:** hints and notices, recorded host-side.
- **Consumption:** `read_at` and `inbox_ack`, done by the seat with its own credential.
- **Settlement:** task, artifact and verdict receipts.

This change touches only the first. It never marks a row read and never writes a task receipt.

## Failure behaviour

| Case | Behaviour |
|---|---|
| DO publish fails | **mupot#1589 P1-3:** caught and logged (`metric: seat_events.hint_publish_failed`), never thrown — the seat leg can no longer cancel Hermes delivery. The row is in D1 and recovered by reconnect backlog regardless. |
| Hermes delivery fails | unchanged: consumer throws → Queue retry → DLQ, independent of the seat leg's outcome |
| Queue redelivers | the DO drops a hint id it has already published (bounded memory); after hibernation the host drops it by id/seq floor. A retry driven by a Hermes failure can re-publish a seat hint — harmless, since the seat leg no longer causes retries of its own, there is no retry "because of" it to double anything. |
| Host offline | hints for agents with no socket are dropped; D1 keeps the rows; `backlog` on reconnect |
| Grant revoked / host member disabled | next hint → `revoked`, nothing disclosed; a ticket minted before the revoke doesn't open |
| **mupot#1589 P2-3:** one transient D1 error re-authorizing a grant | that ONE hint is skipped for that socket — no `revoked` frame, no close, the grant and every other subscription are untouched. Only a confirmed `not_granted` evicts. |
| **mupot#1594 P2-B:** a transient D1 error checking the Herdr fence | `GET /api/inbox/stream` refuses 503 `fence_check_failed` (`Retry-After: 2`) — it used to fail OPEN (200) via `hostMayReceive`'s boolean collapse of the same error. |
| **mupot#1594 P1-A:** the seat-hint publish (Worker → DO `/hint`) hangs | bounded to 5 s (`AbortSignal.timeout`) so a wedged or slow-to-wake DO cannot hold the whole `handleQueue` call hostage; on timeout it is caught exactly like any other publish failure (P1-3's isolation, above). |
| Burst | one small frame per landed row; backlog capped at 50 plus an exact `unread` count; ≤64 agents per ticket |
| Flag off | `/api/fleet/events/*` → JSON 404; consumer never calls the DO; `/stream` unfenced |

**Latency.** Hints ride the existing Queue, which already provides durability, retry and the DLQ.
`wrangler.example.toml` sets `max_batch_timeout = 1` for `mupot-events`. A direct publish at the
commit seam, beside the `emit`, would cut the queue hop, but it isn't built. Add it only if
measured commit→hint p95 is too slow. Duplicates are already harmless, so both paths could run
together.

## Deploy checklist

Canary-deployed 2026-09-27 from an unmerged, dirty tree, at commit `f51ca408` — see
`docs/architecture/three-pillars-and-kernel.md`-adjacent ops notes for how prod's local
`wrangler.toml` and D1 migration head diverge from what is on `origin/main` right now
(mupot#1589 P1-4, and the migration-number collision with #1588 tracked as P1-5). Those two are
ops/sequencing work for whoever merges this and #1588, not something this branch's code fixes.
Migration `0176_seat_event_grants.sql` is **already applied** on prod D1; a later branch added
`0177_seat_events_ticket_rate_limit.sql` (P3) on top, and **this branch (mupot#1594) adds
`0180_seat_events_route_precheck.sql`** — two new, purely additive tables (`seat_events_tickets`,
the route-level ticket pre-check; `seat_events_upgrade_rate_limits`, the upgrade route's own
rate limiter) — apply 0180 BEFORE deploying. No prod secret needs provisioning for any of
this PR's fixes (the ticket pre-check deliberately uses a D1 table instead of a new signing
secret — see "Route-level ticket pre-check" above).

1. Add to the real `wrangler.toml`:
   - the `[[durable_objects.bindings]] SEAT_EVENTS / SeatEventsDO` binding;
   - a `[[migrations]]` entry with `new_sqlite_classes = ["SeatEventsDO"]`, using the EXACT
     server tag already in use (read it first — see P1-4 note above; do not assume);
   - `max_batch_timeout = 1`.
2. Apply D1 migrations `0176_seat_event_grants.sql` (done on prod), `0177_seat_events_ticket_
   rate_limit.sql`, and `0180_seat_events_route_precheck.sql` (this branch).
3. Deploy with the flag **off**, then confirm the `/api/fleet/events/ticket` route returns 404 JSON.
4. Register the host key (`agent_keys`) for the host identity, then write the grants — from a
   human member session (org admin, or a lead on the agent's own squad), never an agent-bound
   token (mupot#1589 P1-1).
5. `REALTIME_SEAT_EVENTS=1`, then take the live proofs below.
6. Orca hosts must pass their ticket as `?ticket=` on the WebSocket connect URL as well as in
   the hello frame (mupot#1589 P1-2) — a bare upgrade with no ticket query param now 401s
   before the DO is ever called.

## Live proof still owed

- commit→hint latency p50/p95, from the host's `hinted` receipt versus the row's `created_at`;
- D1 statements per second at idle for a fleet: `/stream` per seat vs one channel;
- a network drop, a message sent while offline, then recovery via `backlog`;
- revoking a grant during a live socket, which should produce a `revoked` frame;
- with the flag on, a granted agent's Herdr stream gets 409.

## Tests

- `npx vitest run tests/seat-events.test.ts` runs the witnesses for:
  - body leakage;
  - cross-agent and cross-host subscription;
  - forged, expired and replayed tickets and signatures;
  - duplicate events (mupot#1589 P1-3: the seat-DO-down isolation case and its flag-off control);
  - sequence gaps and reconnect catch-up;
  - backpressure;
  - revoked ownership (mupot#1589 P2-3: transient-error cases, both in `publish` and in `claim`);
  - dual consumers;
  - redirect and bearer leakage;
  - **grant writer authorization (mupot#1589 P1-1):** agent-bound refusal on create AND revoke,
    a squad lead granting/revoking on their own squad, cross-squad refusal, below-lead refusal;
  - **WebSocket abuse controls (mupot#1589 P1-2 / mupot#1594 P1-A):** the auth deadline
    (including a SIMULATED HIBERNATION case — fresh hub, same socket attachment), junk-frame
    and oversized-frame closes, the per-host socket cap, and `podAcceptRefusal`'s pure
    authenticated-vs-pending thresholds;
  - **ticket rate limit (mupot#1589 P3):** atomicity under concurrency, independent per-IP
    buckets, and the route's 429;
  - **Herdr fence parity (mupot#1589 P2-1):** a live-but-undeliverable grant no longer fences;
  - **Herdr fence fail-closed (mupot#1594 P2-B):** a transient D1 error refuses 503, never opens;
  - **grant scope (mupot#1594 P2-C):** a lead cannot route to a host with no standing on their
    squad; a host that IS itself a squad agent passes; a lead cannot revoke an org-admin-created
    grant but CAN revoke a peer lead's; an org admin can revoke anything;
  - **route-level ticket pre-check (mupot#1594 P1-A):** 200 forged tickets reach 0 DO fetches;
    D1-error fail-closed on both the pre-check read and the pre-check write;
  - **upgrade rate limit (mupot#1594 P1-A):** the upgrade route's own 429, independent of
    `/ticket`'s bucket, and `ipRateLimitKey`'s IPv6 /64 bucketing;
  - **uniform existence oracle (mupot#1594 P3):** a missing agent, a no-standing lead, and a
    below-lead member all get the identical 404 `agent_not_visible`.
- `node scripts/kill-witness-seat-events.mjs` removes each guard in turn and requires a red test.
  Its exit status is the number of guards whose removal went unnoticed.
