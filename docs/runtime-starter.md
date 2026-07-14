# Mupot Runtime Starter

This is the operator runbook for a customer-owned Mupot runtime. It installs the
same sterile runtime on macOS with launchd or Linux with systemd, keeps credentials
in the host secret store, and produces a copied bundle that can be verified after
transfer.

The starter supports two topologies:

- **Co-resident:** Hermes and Codex run on one host under one pair of user services.
- **Distributed:** each host filters the same starter manifest to its local agent;
  for example, Hermes on a Mac and Codex on a VPS.

Generate the exact host plan instead of assembling a second command path:

```bash
npm run fleet:starter -- --plan --manifest fleet-runtime/starter.example.json
npm run fleet:starter -- --plan --manifest fleet-runtime/starter.example.json --agent manager
npm run fleet:starter -- --plan --manifest fleet-runtime/starter.example.json --agent builder
```

## Credential Boundary

Private agent keys stay under `$HOME/.fleet/agents` with mode `0600`. The panel
JWK on the host is public material. Export `MUPOT_AGENT_TOKEN_<AGENT>` and
`MUPOT_OWNER_TOKEN` only in the interactive process or inject them from a secret
manager. Do not put bearer values in JSON config, receipts, plist/unit
environments, shell history, or evidence attachments.

## Install Without Activation

Use an absolute Node path and retain the install receipt:

```bash
mkdir -p "$HOME/.fleet/receipts"
node fleet-runtime/install.mjs \
  --service-manager auto \
  --node "$(command -v node)" \
  > "$HOME/.fleet/receipts/install.json"
```

The first run creates editable templates and normally reports `warn`. Edit
`daemon.json`, `inbox-handler.json`, `control.json`, and `flights.json`; install
the private agent keys and public panel key; run `trust-bootstrap.mjs`; then rerun
the same non-destructive install command so `install.json` records the configured
layout. Installation renders definitions but does not load them unless
`--activate` is supplied.

## macOS With launchd

Run lifecycle commands as the logged-in user. No `sudo` is required:

```bash
node fleet-runtime/service-manager.mjs install --service-manager launchd \
  > "$HOME/.fleet/receipts/service-install.json"
node "$HOME/.fleet/runtime/service-manager.mjs" status --service-manager launchd \
  > "$HOME/.fleet/receipts/service.json"
node "$HOME/.fleet/runtime/host-receipt.mjs" \
  --require-services --service-manager launchd \
  > "$HOME/.fleet/receipts/host.json"
```

The equivalent one-command install path is
`node fleet-runtime/install.mjs --activate --service-manager launchd`, but the
separate install and activation steps are preferable when collecting proof.

## Linux With systemd

Install and query the systemd user services first:

```bash
node fleet-runtime/service-manager.mjs install --service-manager systemd \
  > "$HOME/.fleet/receipts/service-install.json"
node "$HOME/.fleet/runtime/service-manager.mjs" status --service-manager systemd \
  > "$HOME/.fleet/receipts/service.json"
```

Logout continuity requires lingering. This is an explicit operator-authorized
host action, separate from the unprivileged installer:

```bash
loginctl enable-linger "$USER"
node "$HOME/.fleet/runtime/service-manager.mjs" status --service-manager systemd \
  > "$HOME/.fleet/receipts/service-after-linger.json"
node "$HOME/.fleet/runtime/host-receipt.mjs" \
  --require-services --service-manager systemd \
  > "$HOME/.fleet/receipts/host.json"
```

The installer can activate explicitly with
`node fleet-runtime/install.mjs --activate --service-manager systemd --enable-linger`
only when the operator has intentionally selected that policy. It never invokes
`sudo`.

## Governed Start And Stop Evidence

Use one directory per local agent. The active control service remains the sole
consumer of the signed control inbox; `control-receipt.mjs --observe-state`
correlates each queued probe to the daemon's redacted state.

```bash
AGENT_ID=manager
OUT="$HOME/.fleet/receipts/$AGENT_ID"
mkdir -p "$OUT"

node "$HOME/.fleet/runtime/cutover-probe.mjs" \
  --base-url https://YOUR-POT.example.com \
  --agent "$AGENT_ID" --queue-inbox --control start \
  > "$OUT/probe-start.json"
node "$HOME/.fleet/runtime/control-receipt.mjs" --observe-state \
  --probe-receipt "$OUT/probe-start.json" --verb start \
  > "$OUT/control-start.json"
node "$HOME/.fleet/runtime/receipt-bundle.mjs" \
  --agent "$AGENT_ID" --out-dir "$OUT" \
  --install-receipt "$HOME/.fleet/receipts/install.json" \
  --probe-receipt "$OUT/probe-start.json" --skip-host --skip-control

node "$HOME/.fleet/runtime/continuous-runtime-receipt.mjs" \
  --agent "$AGENT_ID" --service-manager auto --require-control start \
  > "$OUT/continuous.json"

node "$HOME/.fleet/runtime/cutover-probe.mjs" \
  --base-url https://YOUR-POT.example.com \
  --agent "$AGENT_ID" --control stop \
  > "$OUT/probe-stop.json"
node "$HOME/.fleet/runtime/control-receipt.mjs" --observe-state \
  --probe-receipt "$OUT/probe-stop.json" --verb stop \
  > "$OUT/control-stop.json"
node "$HOME/.fleet/runtime/receipt-bundle.mjs" \
  --agent "$AGENT_ID" --out-dir "$OUT" \
  --probe-receipt "$OUT/probe-stop.json" \
  --skip-host --skip-runtime --skip-control
node "$HOME/.fleet/runtime/receipt-bundle.mjs" \
  --agent "$AGENT_ID" --out-dir "$OUT" --verify-only
```

The accepted daemon event must follow the probe timestamp, arrive within the
bounded collection window, match the admitted probe nonce hash, and come from
the PID recorded for the running control service.

## Lifecycle, Starter, And Copied Bundle

The supported service lifecycle is explicit:

```bash
node fleet-runtime/service-manager.mjs install --service-manager auto
node fleet-runtime/service-manager.mjs reload --service-manager auto
node fleet-runtime/service-manager.mjs status --service-manager auto
node fleet-runtime/service-manager.mjs uninstall --service-manager auto
```

After the start, continuous, and stop receipts pass, follow the generated starter
plan to create `starter-receipt.json`. Export and independently verify the copied
bundle:

```bash
node "$HOME/.fleet/runtime/receipt-bundle.mjs" \
  --out-dir "$OUT" --export-dir "$OUT-attach" --export
node "$HOME/.fleet/runtime/receipt-bundle.mjs" \
  --out-dir "$OUT-attach" --check-manifest
```

Attach only the copied bundle when `manifest.json`, `cutover-gate.json`,
`export-receipt.json`, and `manifest-check.json` all report `pass`.

## Data-Preserving Rollback And Recovery

Uninstall unloads only the known user services and removes only their known
definitions. It preserves configs, keys, runtime files, inboxes, job results,
logs, state, and receipts under `$HOME/.fleet`.

```bash
node "$HOME/.fleet/runtime/service-manager.mjs" uninstall --service-manager auto \
  > "$HOME/.fleet/receipts/service-uninstall.json"
```

For recovery, rerun the non-destructive installer, activate the selected service
manager, queue a fresh governed `start`, and require new heartbeat/control counter
advancement. Old receipts do not prove a recovered process.

```bash
node fleet-runtime/install.mjs --activate --service-manager auto \
  > "$HOME/.fleet/receipts/recovery-install.json"
node "$HOME/.fleet/runtime/service-manager.mjs" reload --service-manager auto \
  > "$HOME/.fleet/receipts/recovery-reload.json"
node "$HOME/.fleet/runtime/continuous-runtime-receipt.mjs" \
  --agent "$AGENT_ID" --service-manager auto --require-control start \
  > "$HOME/.fleet/receipts/recovery-continuous.json"
```
