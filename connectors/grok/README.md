# Grok connector — Stop-hook receive

Grok TUI already speaks MCP, so **send** works with an agent-bound token. This
folder is the other half: **receive at end of turn**.

## Why two connectors

Stop covers in-session turn-end. herdr prompt wakes an idle seat. Neither
covers the other. A Stop-only seat goes silent exactly when it is idle — which
was the broken case. That is the whole justification for a second connector
when `kasra/grok-connector` (`72b9b22e`, `scripts/grok-inbox-watch.mjs`) already
runs.

The two artifacts compose. They must not share a consume.

**Consume policy is transport-specific.** Same invariant — never consume an
unconfirmed message — two correct implementations:

- Stop-hook (this branch): all-or-nothing `planInboxConsume`. One `{decision:block}` can carry the whole peeked batch.
- herdr polling (`72b9b22e`): per-message consume. Only one confirmed delivery per cycle is possible; all-or-nothing would redeliver the confirmed row forever.

Do not re-impose `planInboxConsume` on the polling artifact.

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
