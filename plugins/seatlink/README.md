# seatlink discovery (S2, mumega-com#1351)

The seatlink bridge itself (`seatlink.mjs`, the Herdr plugin) is **not tracked in this repo**: its
source lives with the plugin tree (`docs/plugins/mupot-seatlink.md` is only a pointer). This
directory holds the two pieces S2 adds, as tracked, tested, dependency-free ES modules:

| File | What |
|---|---|
| `discover.mjs` | Pure functions: `buildSeatSet` (herdr seat label -> mupot peer slug -> token file, with `seats.json` overrides), `classifyStreamFailure` / `runSeatStream` (the 401 policy). |
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

## 401 policy

An inbox-stream open answered `401` or `403` is terminal for that seat: one line
`SEAT DEAF: <seat> inbox stream refused with HTTP 401 ... NOT retrying`, then the loop returns. Everything
else (network error, 5xx, 429) keeps the existing 1s -> 30s doubling backoff.

## Wiring into the installed bridge (manual, by the operator)

Not done by this change (the installed copy under `~/.local/share/mupot-seatlink` was read, not edited).
In `openInboxStream`, replace the `if (!res.ok) throw new Error(...)` with
`if (!res.ok) throw Object.assign(new Error(\`HTTP ${res.status}\`), { status: res.status })`, and run the
body of `run` through `runSeatStream({ seat: entry.herdr, openOnce, log, sleep })`. In `startInboxStreams`,
when started with `--discover`, build `cfg.seats` from `buildSeatSet(...)` instead of reading only `seats.json`.
