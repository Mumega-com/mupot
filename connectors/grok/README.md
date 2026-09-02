# Grok connector — Stop-hook receive

Grok TUI already speaks MCP, so **send** works with an agent-bound token. This
folder is the other half: **receive at end of turn**.

It is **not** the idle-wake path. `scripts/grok-inbox-watch.mjs` on
`kasra/grok-connector` (herdr `agent prompt`, 30s tick) starts a turn for a
sitting prompt. A Stop hook cannot: Stop fires only on genuine turn completion
(`reason == end_turn`). A seat with only this hook goes silent exactly when it
is doing nothing. The two artifacts compose; they must not share a consume.

## Install (do not run from an ungated task)

```bash
./connectors/grok/bridge/install.sh --seat <your-seat>
./connectors/grok/bridge/install.sh --seat <your-seat> --dry-run
```

The installer verifies `check_in` against the live pot **before** writing
`~/.grok/hooks/mupot-inbox.json`. Identity comes from the credential
(`~/.fleet/agents/<seat>-agent-bound.token`). There is no `$AGENT_NAME`
fallback.

## Contract

`fleet-runtime/grok-inbox-adapter.mjs` reuses the Claude YC27 contract:

- `formatClaudeCodeNudge` / `formatGrokNudge` — keeps seq, id, request_id, in_reply_to
- `planInboxConsume` — consume 0 unless delivered == peeked (correct here: one Stop block can carry the batch)
- `bearerConsumerAllowed` — missing fence mode **refuses**, never fail-open to bearer_only
- `verifyConsumedBatch` — multiplicity, concurrent drain
- `assertCanonicalRuntimeIdentity`
- `isUnsafeStopHookDelivery`

Grok-specific: drain only `end_turn`; skip session-end Stop; skip re-inject when
`stopHookActive` and this turn already delivered; stop blocking at 8 continuations.

Order is load-bearing: **peek → spool → `{decision:block,reason}` → consume**.

## What this is not

- Not a push. Not idle-wake.
- Not the polling systemd unit. Do not install that from this branch.
- Not a new bearer. Not stacked on `kasra/grok-connector` or `5585fe76`.
