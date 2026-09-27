# Seat events: one body-free channel per fleet host

Branch `hadi-orca/seat-events-channel`, off `origin/main` 921dbcd. **Not deployed.**
It stays inert until the `SEAT_EVENTS` binding exists **and** `REALTIME_SEAT_EVENTS=1`.

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
(`hostMayReceive`, one indexed query):

1. **Signed host identity.** The host signs this message with its Ed25519 key, registered in
   `agent_keys` (the same identity used by signed attach and signed inbox):
   `seat-events-ticket:v1 \n tenant \n host_agent_id \n sorted,unique,agents \n ts \n nonce`.
   The rules:
   - the signature must be fresh (±300 s);
   - the nonce is burned in the shared ledger, and only after the signature verifies;
   - the tenant is part of the signed bytes, so no cross-pot replay;
   - the key's member must be active.
2. **An explicit grant.** A `seat_event_grants` row (migration 0176) authorizes *that host* for
   *that agent*. An org admin writes it with `POST /api/fleet/events/grants`. It can optionally be
   scoped to a project, in which case the agent must still have access to that project. The
   self-reported `fleet_agents.host` is never consulted.
3. **The agent is active.**

A ticket request returns **one** ticket for the host:
- it lasts 60 s and can be used once;
- the DO stores only its SHA-256 hash;
- it is scoped to the agents that passed all three checks (the rest come back in `refused`).

The WebSocket upgrade is forwarded to the DO without `Authorization` or `Cookie`. The ticket
travels in the first frame, never in the URL.

## One consumer per UUID; migrating Herdr to Orca

- **Durable fence:** at most one live grant per agent (partial unique index). Moving an agent means
  revoking the old grant and granting a new one. There is no implicit takeover.
- **Live fence:** the DO lets one socket hold an agent.
  - When the same host reconnects, its old socket receives `superseded`.
  - When a grant has moved, the old host's socket receives `revoked` (`grant_moved`).
  - While another host is still authorized, a newcomer gets `held_by_other_host`.
- **Herdr fence:** while the flag is on, `GET /api/inbox/stream` returns 409
  `notify_owned_by_fleet_host` for any agent with a live grant. A Herdr seatlink and an Orca host
  therefore cannot both be prompting the same seat. Revoking the grant reopens the stream.

## Protocol (v1)

| Direction | Frame |
|---|---|
| host → pot | `{type:'hello', v:1, ticket, since:{<agent>: <seq>}}`: the only client frame |
| pot → host | `ready {protocol, host, subscriptions:[{agent, ok, reason?}]}` |
| | `backlog {agent, unread, complete, hints[≤50]}`: catch-up from D1 above `since` |
| | `hint {agent, hint}`: one committed row |
| | `revoked {agent, reason}` / `superseded {agent, reason}` |
| | `error {reason}` then close 4401 (`ticket_invalid`, `protocol_unsupported`) |
| host ↔ pot | `ping` / `pong`: the runtime auto-response, which doesn't wake the DO or read D1 |

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
| DO publish fails | consumer throws → Queue retry → DLQ; the row is in D1 and recovered by reconnect backlog |
| Queue redelivers | the DO drops a hint id it has already published (bounded memory); after hibernation the host drops it by id/seq floor |
| Host offline | hints for agents with no socket are dropped; D1 keeps the rows; `backlog` on reconnect |
| Grant revoked / host member disabled | next hint → `revoked`, nothing disclosed; a ticket minted before the revoke doesn't open |
| Burst | one small frame per landed row; backlog capped at 50 plus an exact `unread` count; ≤64 agents per ticket |
| Flag off | `/api/fleet/events/*` → JSON 404; consumer never calls the DO; `/stream` unfenced |

**Latency.** Hints ride the existing Queue, which already provides durability, retry and the DLQ.
`wrangler.example.toml` sets `max_batch_timeout = 1` for `mupot-events`. A direct publish at the
commit seam, beside the `emit`, would cut the queue hop, but it isn't built. Add it only if
measured commit→hint p95 is too slow. Duplicates are already harmless, so both paths could run
together.

## Deploy checklist (not done; needs owner approval)

1. Add to the real `wrangler.toml`:
   - the `[[durable_objects.bindings]] SEAT_EVENTS / SeatEventsDO` binding;
   - a `[[migrations]]` entry with `new_sqlite_classes = ["SeatEventsDO"]`, using the next unused
     tag in *that* file;
   - `max_batch_timeout = 1`.
2. Apply D1 migration `0176_seat_event_grants.sql`.
3. Deploy with the flag **off**, then confirm the `/api/fleet/events/ticket` route returns 404 JSON.
4. Register the host key (`agent_keys`) for the host identity, then write the grants.
5. `REALTIME_SEAT_EVENTS=1`, then take the live proofs below.

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
  - duplicate events;
  - sequence gaps and reconnect catch-up;
  - backpressure;
  - revoked ownership;
  - dual consumers;
  - redirect and bearer leakage.
- `node scripts/kill-witness-seat-events.mjs` removes each guard in turn and requires a red test.
  Its exit status is the number of guards whose removal went unnoticed.
