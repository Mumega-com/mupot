# mupot-hostd contracts (Flight 1 Task 1)

Sanitized bindings only. No credentials. No claim that cached observations are current.

## Package placement

| Path | Role |
|---|---|
| `/Users/hadi/dev/worktrees/mupot-hostd` | Isolated worktree, branch `cursor/mupot-hostd` (from `codex/mumachine-onboarding` @ `edb0db5`) |
| `host/mupot-hostd` | This crate — sibling of `host/mumachine` |
| `host/mumachine` | **Mupot Connect 0.1.0 GUI** — separate product; do not merge hostd into it |

`mumachine` stays a separate Connect GUI. hostd is a daemon/broker crate, not a second Connect.

## Inspected SHAs (read-only)

| Surface | Path / ref | Notes |
|---|---|---|
| mumachine / Connect | worktree `mumachine-onboarding` `host/mumachine` @ `edb0db5` | HTTP actions: `boot_context`, `orient`, `check_in`, device code/token poll. No inbox consume. |
| mupot public checkout base | branch `cursor/mupot-hostd` @ `edb0db5` | Created for this flight |
| Mirror | `/Users/hadi/dev/mumega/mirror` @ `e51861a5` | `plugins/memory/routes.py`: `/search`, `/store`, `/recent/{agent}`, `/stats`, `/experience/recall`, … |
| Inkwell | `Mumega-com` @ `e8a8f107` `workers/inkwell-api/src/lib/tenant-content.ts` | `getContent` / `putContent` — **no** `If-Match` / idempotency key observed → capabilities omit `compare_revision` and `idempotency` until proven |
| Codex memory | public docs URL unavailable at plan time | Adapter declared **read-only and disabled** until opt-out/session exclusion is proven |

## Bound flight artifacts

| Artifact | Owner | Bound in crate |
|---|---|---|
| `INBOX-FENCE.md` (Hermes `870a5024`, task `f4083fc8`) | hadi-hermes | `policy::FENCED_LIVE_SEAT_UUIDS`, `tests/fixtures/dual_consumer.json` |
| `HERDR-ADAPTER.md` (River `f23a6c2c`, task `4536e8a4`) | hadi-river | `policy::HERDR_ALLOWED_METHODS`, `HERDR_FORBIDDEN_METHODS`, `herdr_method_allowed`, `HERDR_PROTOCOL=22` |

Flight folder: `/Users/hadi/dev/agents/dara/designs/hostd-canonical-host-20260910/`.

## Authority map (fact class → owner)

Matches the approved design. Display names, task titles, qNFT prose, and session labels are **not** authorities.

## Allowed Mupot RPCs (hostd) — INBOX-FENCE

- `boot_context`
- `status`
- `receipt_get` (alias `execution_receipt_get`)

Forbidden for hostd: `inbox`, `inbox_lease`, `inbox_ack`, `send`, `squad_message`, `connect`, `mint_agent_token`, `grant_agent_capability`, SSE, poll-cursor, consume.

## Allowed Herdr methods (hostd) — HERDR-ADAPTER §3

Exact names (not `snapshot`):

- `ping`
- `session.snapshot`
- `agent.list`
- `agent.get`
- `pane.get`
- `pane.list`
- `pane.process_info`
- `workspace.list`
- `workspace.get`

Hard forbid includes `agent.prompt`, `server.stop`, pane send_*, plugin.*, `events.subscribe`, and bare `snapshot`.

## Dual-consumer fence

Seatlink 0.2.2 owns live seat mail (one-SSE monopoly). Contract tests refuse SSE / poll_cursor / consume / inbox_ack for every UUID in `INBOX-FENCE.md`, including Hermes `870a5024-…` and both River rows `f23a6c2c-…` and `bec1bb7a-…`.

## Source capabilities frozen in code

See `declared_capabilities()` in `src/contract.rs`. Missing live operations map to `UnsupportedContract`, not invented endpoints.

## Compiler

Recorded at Task 1 run: `rustc 1.97.1` / `cargo 1.97.1` (Homebrew).

## Flight 2 status

Tasks 2–6 implemented in this crate. See `docs/flight-results.md`.
F1 contract tests remain green. Gate: hadi-grok.

