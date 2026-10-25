# seatlink discovery (S2, mumega-com#1351)

The seatlink bridge itself (`seatlink.mjs`, the Herdr plugin) is **not tracked in this repo**: its
source lives with the plugin tree (`docs/plugins/mupot-seatlink.md` is only a pointer). This
directory holds the two pieces S2 adds, as tracked, tested, dependency-free ES modules:

| File | What |
|---|---|
| `discover.mjs` | Pure functions: `buildSeatSet` (herdr seat label -> mupot peer slug -> token file, with `seats.json` overrides), `classifyStreamFailure` / `runSeatStream` (the stream failure policy). |
| `seatlink-discover.mjs` | CLI: `--discover` prints `{seats, skipped}`. Read-only; never writes `seats.json`, never prints a token. |
| `discover.test.mjs` | Fixture tests (`node --test 'plugins/seatlink/*.test.mjs'`, wired in CI). |

## Facts about herdr's CLI (checked 2026-10-10)

`herdr agent list` and `herdr workspace list` take no flags and print a JSON envelope
(`{"id":..,"result":{"agents":[..]}}`) by default. **There is no `--json` flag** (it errors with usage).
Seat identity is the workspace `label` (fallback: agent `name`), never what a pane says about itself.

## Join rule

`muvps_kasra` -> normalized `muvps-kasra` -> tried as a peer slug, then `kasra`. Exactly one peer must match;
zero -> `no_peer_match`, several -> `ambiguous_peer_match` (skipped, never guessed). The token file is
`<token-dir>/<peer-slug>-agent-bound.token` (default `~/.fleet/agents`); missing -> `no_token_file`.
A `seats.json` entry with the same `herdr` name wins wholesale, and entries herdr does not list are kept.

## Stream failure policy

Applies **once the installed bridge is wired per this README** (see "Wiring" below); the installed copy is unchanged today.

- `401`, or `403` whose body says `not_agent_bound`: terminal for that seat. One line
  `SEAT DEAF: <seat> inbox stream refused with HTTP ... NOT retrying`, then the loop returns.
- any other `403` (policy/WAF) and any `5xx`: 5-minute backoff, and the token file is re-read every cycle
  (`readToken()`), so a re-minted token recovers without a restart.
- network errors / 429: 1s -> 30s doubling backoff.
- a normal stream end sleeps 1s before reconnecting (no hot loop).

## Discovery skips (never silent)

`no_label`, `duplicate_label` (second pane with the same herdr label), `no_peer_match`, `ambiguous_peer_match`,
`invalid_peer_slug` (must match `^[a-z0-9][a-z0-9-]{0,63}$` before it is joined into a token path),
`no_token_file`, and `duplicate_peer_claim` (two herdr seats resolving to one mupot agent id: both skipped).

## Wiring into the installed bridge (manual, by the operator)

Not done by this change (the installed copy under `~/.local/share/mupot-seatlink` was read, not edited).
In `openInboxStream`, replace the `if (!res.ok) throw new Error(...)` with
`if (!res.ok) throw Object.assign(new Error(\`HTTP ${res.status}\`), { status: res.status })`, and run the
body of `run` through `runSeatStream({ seat: entry.herdr, openOnce, readToken, log, sleep })`, with the 403 `body` text attached to the thrown error as `.body`. In `startInboxStreams`,
when started with `--discover`, build `cfg.seats` from `buildSeatSet(...)` instead of reading only `seats.json`.

## Push mode (SeatEventsDO client)

`seat-events-client.mjs` replaces per-seat `/api/inbox/stream` polls with one WebSocket per host.
Config (all optional; absent = SSE exactly as before): top-level
`"seat_events": {"host_id": "<agent id>", "tenant": "<TENANT_SLUG>", "host_key_file": "~/.fleet/agents/seatlink-host.key"}`
plus `"seat_events": true` and `"agent_id": "<agent uuid/id>"` on each seat to opt in (canary one seat first).
Key: `node bin/seatlink-hostkey-gen.mjs` (mode 600, refuses existing file / group-writable dir); register the printed
`public_key` with `register_agent_key`; a seat_event_grants row per seat is required (operator action).
No automatic SSE fallback: while a grant is live the stream route returns 409 `notify_owned_by_fleet_host`.
Rollback is operator-only: revoke the seat's grant, then remove `seat_events` from the seat.
