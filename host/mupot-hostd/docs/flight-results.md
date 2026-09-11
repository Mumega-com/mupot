# Flight results — hostd-canonical-host-20260910

## Flight 1
PASS (contracts + dual-consumer fence). Gate: hadi-grok.

## Flight 2 (read-only host)
Implemented Tasks 2–6 in `host/mupot-hostd`.

- Store: WAL SQLite, nine tables + audit_events, restart-safe cursors.
- Identity: bearer wins; Keychain handles on macOS; Linux fail-closed.
- Adapters: mupot read RPCs only; herdr Unix client protocol 22 allow-list; github/inkwell/mirror/codex fixtures via loopback-capable harness.
- Freshness/context: six states; owner beats newer summary.
- RPC: runtime dir 0700, socket 0600, peer-user check, MCP stdio bridge. Writes → ApprovalRequired.
- **Not done this flight:** launchd install, live Codex app config rewrite, live Herdr/Mupot smoke (fixture-supported subset only).

### Live Codex smoke
Missing — no app config rewrite authorized. Fixture proof only.

### mumachine
Untouched. Connect GUI remains separate.
