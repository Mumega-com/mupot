# fleet-runtime — host-side agent runtime for the pot

The **distributable, sterile** companion to the pot worker. The worker (`src/fleet/`) *verifies*
signed-attach and computes presence; this runtime *runs on a host*, proves each agent's identity
by signature, heartbeats only the agents whose runtime is actually alive, and
can drain each live agent's Mupot inbox into a local handler.

Fork the pot → you get this. No tenant is hardcoded: `base_url` + `tenant` come from your config.

## The model

- **Agent identity ≠ runtime.** An agent is a durable identity (member + Ed25519 key + RBAC);
  the runtime (claude-code / codex / hermes) is a swappable shell. See `docs/agent-running-on-mupot.md`.
- **No placed secret.** The host holds a private key; the pot stores only the public key. Each
  attach and signed inbox read is a signature — nothing secret is transported or placed.
- **Truthful presence.** The daemon probes each agent's runtime; it heartbeats only the live
  ones, so the pot's presence reflects reality (`live` while running → `stale` when it dies).
- **Consume after delivery.** Inbox drain peeks first, hands the JSON batch to a local command,
  and consumes from Mupot only after that command exits 0.

## Files

| file | role |
|---|---|
| `agent-keygen.mjs` | generate an agent's Ed25519 keypair (private stays on host, 0600) |
| `register-agent-key.sh` | register the **public** key in the pot (`agent_keys`) via wrangler |
| `attach-signed.mjs` | one-shot signed attach (CLI) |
| `fleet-sign.mjs` | shared signer core (no tenant default) |
| `install.mjs` | non-destructive host installer for runtime scripts, templates, and systemd units |
| `fleet-daemon.mjs` | presence heartbeat loop, optional signed inbox drain, signed shutdown detach |
| `daemon.example.json` | config template (set base_url, tenant, agents, probes) |
| `fleet-daemon.service` | systemd user unit |
| `inbox-handler.mjs` | durable local handoff command for daemon inbox batches |
| `inbox-handler.example.json` | per-agent spool + launch command config |
| `fleet-control-daemon.mjs` | signed open/close/restart consumer for `POST /api/fleet/control` |
| `control-request.mjs` | host verifier for `fleet-control.v1` requests |
| `control.example.json` | control-daemon config template |
| `fleet-control-daemon.service` | systemd user unit for host lifecycle control |
| `host-receipt.mjs` | non-destructive local verifier that emits a redacted host-install receipt |
| `runtime-receipt.mjs` | one-shot live daemon-cycle receipt for signed attach + inbox drain |
| `control-receipt.mjs` | one-shot live control receipt for signed open/close/restart |
| `cutover-receipt.mjs` | verifies host/runtime/control receipts before SOS removal |
| `cutover-probe.mjs` | queues inbox and lifecycle probes that live receipts must observe |
| `receipt-bundle.mjs` | saves host/runtime/control receipts, final gate, and manifest in one directory |

## Quickstart (per agent)

```bash
# 1. keypair — private key stays on this host
node fleet-runtime/agent-keygen.mjs my-agent          # prints AGENT_PUBKEY=...

# 2. resolve the pot member this agent authenticates AS (optional but recommended)
npx wrangler d1 execute <db> --remote --json \
  --command "SELECT id, display_name FROM members WHERE tenant='<your-tenant>';"

# 3. register the PUBLIC key (public material only)
TENANT_SLUG=<your-tenant> ./fleet-runtime/register-agent-key.sh my-agent <AGENT_PUBKEY> <member_id>

# 4. one-shot attach to verify
node fleet-runtime/attach-signed.mjs https://YOUR-POT my-agent --tenant <your-tenant> --type builder --runtime claude-code
```

## Install on a host

From a checkout, lay down the runtime scripts, systemd user units, editable
config templates, and receipt directories:

```bash
npm run fleet:install
```

or directly from a checkout:

```bash
node fleet-runtime/install.mjs
```

If you copied only the `fleet-runtime` directory to a host, run `node install.mjs`
from inside that copied directory.

The installer emits `receipt_type: "mupot-fleet-install-receipt/v1"`. A first
install usually returns `status:"warn"` because `~/.fleet/*.json` was created
from templates and must be edited. It preserves existing config files unless
you pass `--force-config`, so rerunning it is safe for script/unit updates.

To keep the install receipt with the later cutover evidence, save it as JSON
before running the bundle:

```bash
mkdir -p ~/.fleet/receipts
node fleet-runtime/install.mjs > ~/.fleet/receipts/install.json
```

Edit these generated files before enabling services:

- `~/.fleet/daemon.json`
- `~/.fleet/inbox-handler.json`
- `~/.fleet/control.json`
- `~/.fleet/flights.json`

Then place agent private keys under `~/.fleet/agents/` with `chmod 600`, place
the panel public key at `~/.fleet/panel.pub.jwk`, and run the host receipt.

## Run the daemon (continuous presence + optional inbox drain)

```bash
systemctl --user daemon-reload
loginctl enable-linger "$USER"                                # survive logout/reboot
systemctl --user enable --now fleet-daemon.service
journalctl --user -u fleet-daemon -f
```

**Probes must detect death, not past-life.** A probe is a shell command that exits 0 iff the
runtime is alive *now*. Use liveness signals (`tmux has-session`, `systemctl is-active`) or a
**freshness** check (`find marker -mmin -5`), never a bare `test -f marker` (passes forever once
the marker exists → heartbeats a dead agent).

To let the daemon deliver Mupot inbox messages to a runtime hook, add an optional `inbox`
block to that agent. The maintained handler is the safest default because it writes every
message to a 0600 local spool file before it exits 0:

```json
{
  "agent_id": "agent-one",
  "type": "builder",
  "runtime": "claude-code",
  "probe": "tmux has-session -t agent-one 2>/dev/null",
  "inbox": {
    "command": "node $HOME/.fleet/runtime/inbox-handler.mjs $HOME/.fleet/inbox-handler.json",
    "limit": 20
  }
}
```

The command receives one JSON object on stdin:

```json
{
  "tenant": "acme",
  "base_url": "https://YOUR-POT.example.com",
  "agent_id": "agent-one",
  "messages": [
    {
      "seq": 1,
      "id": "msg-id",
      "from_agent": "review",
      "kind": "request",
      "body": "do the work",
      "request_id": "rid-1"
    }
  ],
  "remaining": 0
}
```

Configure the handler:

```bash
cp fleet-runtime/inbox-handler.example.json ~/.fleet/inbox-handler.json
mkdir -p ~/.fleet/handlers
```

The handler validates the daemon payload, writes each message under
`~/.fleet/inbox/<agent_id>/`, then runs the configured per-agent command only when a message
kind matches `run_for`. The command receives JSON on stdin with `files[]`, `messages[]`,
`agent_id`, `tenant`, and `base_url`. Exit `0` only after the runtime has accepted or persisted
the batch. A non-zero exit, crash, or timeout leaves the Mupot messages unread for the next
daemon tick. The inbox read is signed with the agent's Ed25519 key and POSTed to
`/api/inbox/signed`; it does not need a bearer token.

## Run the control daemon (remote open/close)

The dashboard and API emit signed control requests with `FLEET_PANEL_SK`:

```bash
POST /api/fleet/control { "agent_id": "agent-one", "verb": "start" }
```

The host does not trust the inbox by itself. `fleet-control-daemon.mjs` reads the configured
consumer agent inbox through `/api/inbox/signed`, verifies the `fleet-control.v1` signature
with the panel **public** key, burns the nonce in `~/.fleet/control-nonces.json`, then runs:

```bash
node ~/.fleet/runtime/flight.mjs open|close <agent> ~/.fleet/flights.json
```

Configure it:

```bash
cp fleet-runtime/control.example.json ~/.fleet/control.json
cp fleet-runtime/fleet-control-daemon.service ~/.config/systemd/user/
```

`consumer_agent_id` must be the same agent as `FLEET_CONSUMER_AGENT` in the Worker. That
consumer needs an Ed25519 agent key registered in Mupot so it can read its own inbox without a
bearer token. `panel_public_key` must be the public JWK corresponding to the Worker's
`FLEET_PANEL_SK`; never put the private panel key on the host.

Supported verbs:

- `start` → `flight.mjs open <agent>`
- `stop` → `flight.mjs close <agent>`
- `restart` → `flight.mjs close <agent>` then `flight.mjs open <agent>`
- `status` → verified no-op, consumed as a health/probe request

Malformed, stale, bad-signature, or replayed requests are consumed without executing so one
poison message cannot block later control. A verified command failure is also consumed because
the nonce is already burned before process touch; inspect the journal and issue a fresh command.

## Flights (the activation unit) — `flight.mjs`

Agents don't sit warm. They **fly** bounded bursts and land. mupot brings the runtime up for a
flight; the agent works; it lands and the runtime goes down. Tokens burn only between takeoff
and land — idle is zero.

```bash
node fleet-runtime/flight.mjs open  my-agent   # takeoff: run `launch` → signed-attach (→ live)
node fleet-runtime/flight.mjs close my-agent   # land: run `teardown` → signed-detach (→ offline)
node fleet-runtime/flight.mjs list             # show configured flights
```

Config `~/.fleet/flights.json` (see `flights.example.json`): per agent, `launch` (a **non-blocking**
command that brings the runtime up, e.g. `tmux new-session -d`) + `teardown` (brings it down).
`open` runs `launch` then signs an attach — a **point-in-time** takeoff ping that flips presence
`live` (and, if attach fails after launch, rolls the runtime back so nothing is orphaned). `close`
runs `teardown`; a clean teardown then signs `/api/fleet/detach-signed` so the pot reports
`offline`. If no teardown is configured, close skips signed detach because it cannot prove the
runtime stopped. A failed teardown reports `LAND_UNCERTAIN` (runtime may still be up) rather
than a false `LANDED`.

Note: a single `flight open` proves the runtime was up *at takeoff* + a valid signature — it does
NOT guarantee sustained liveness. Continuous truthful presence (`live` while running → `stale`
when it dies) is the **heartbeat daemon's** job (`fleet-daemon.mjs`), which re-attaches on a
cadence. Run the daemon alongside flights for a runtime that should report presence for its whole
flight; use bare `flight open/close` for the lifecycle transitions.

The **remote trigger** — mupot `POST /api/fleet/control {agent_id, verb:start}` → signed
control-request → host control-daemon → runs the flight — is the ATC layer (fleet-control
`daemon.py`/`engine.py`); it needs the consumer agent minted + the control-daemon installed
(owner-gated). Until then, flights run locally via `flight.mjs`.

## Control live receipt

After the host receipt passes and an owner/admin has queued a control request
from Mupot, run one live control poll:

```bash
node ~/.fleet/runtime/control-receipt.mjs \
  --control ~/.fleet/control.json
```

or from a checkout:

```bash
npm run receipt:control
```

The control receipt runs the same path as the control daemon once:

- signs `/api/inbox/signed` as the fleet consumer agent
- verifies the queued `fleet-control.v1` request with the panel public key
- burns the nonce in the local ledger
- maps `start|stop|restart|status` to the flight layer
- consumes the control message after handling

It prints JSON with `receipt_type: "mupot-fleet-control-receipt/v1"`. A
`status:"pass"` receipt proves Mupot lifecycle control reached the host flight
layer. `status:"warn"` with `control_inbox_idle` means the signed consumer inbox
read worked, but no control request was queued; trigger one from Mupot and rerun.

## Host install receipt

After installing and editing `fleet-daemon`, `inbox-handler`, and
`fleet-control-daemon` config, run a non-destructive receipt before asking
Mupot to consume live work:

```bash
node ~/.fleet/runtime/host-receipt.mjs \
  --daemon ~/.fleet/daemon.json \
  --inbox ~/.fleet/inbox-handler.json \
  --control ~/.fleet/control.json
```

or from a checkout:

```bash
npm run receipt:host
```

The receipt validates:

- daemon, inbox-handler, and control-daemon config shapes
- real `base_url` and `tenant` values instead of copied placeholders
- agent private key files exist with `0600`-style permissions
- daemon inbox-enabled agents have matching handler config
- panel public key, flights config, and flight script paths exist for remote control

It prints JSON with `receipt_type: "mupot-fleet-host-receipt/v1"`. A `status:"pass"`
receipt proves host wiring is ready for live attach/inbox/control smoke tests. Add
`--exec-probes` only when you want the receipt to run the configured liveness probes.

## Runtime live receipt

After the host receipt passes and at least one managed runtime is actually up,
run a one-cycle live receipt for the agent you are cutting over:

```bash
node ~/.fleet/runtime/runtime-receipt.mjs \
  --daemon ~/.fleet/daemon.json \
  --agent my-agent
```

or from a checkout:

```bash
npm run receipt:runtime -- --agent my-agent
```

The runtime receipt runs the same path as the daemon service once:

- executes the configured liveness probe
- signs `/api/fleet/attach-signed`
- signs `/api/inbox/signed` in peek mode
- hands any messages to the configured local inbox command
- consumes messages from Mupot only after handler exit `0`

It prints JSON with `receipt_type: "mupot-fleet-runtime-receipt/v1"`. A
`status:"pass"` receipt proves that selected agent's live runtime can heartbeat
and drain Mupot inbox work. `status:"warn"` with `inbox_no_messages_to_handoff`
means the signed inbox route worked, but no queued message was available to prove
handler delivery; send a cutover probe message and rerun it.

## SOS cutover gate

Do not remove an agent's SOS bus/wake path from the runtime config until the
host, runtime, and control receipts have all passed and the combined gate passes:

```bash
node ~/.fleet/runtime/cutover-receipt.mjs \
  --agent my-agent \
  --host ~/.fleet/receipts/host.json \
  --runtime ~/.fleet/receipts/runtime-my-agent.json \
  --control ~/.fleet/receipts/control-start-my-agent.json \
  --control ~/.fleet/receipts/control-stop-my-agent.json
```

or from a checkout:

```bash
npm run receipt:cutover -- \
  --agent my-agent \
  --host ./receipts/host.json \
  --runtime ./receipts/runtime-my-agent.json \
  --control ./receipts/control-start-my-agent.json \
  --control ./receipts/control-stop-my-agent.json
```

It prints JSON with `receipt_type: "mupot-sos-cutover-gate/v1"`. A
`status:"pass"` receipt proves that:

- the host pre-flight receipt passed
- the selected agent's runtime receipt passed signed attach and inbox handoff
- lifecycle control has start and stop evidence for that same agent

By default the gate requires both `start` and `stop` lifecycle evidence. A
single `restart` control receipt can satisfy both because the control daemon
runs close then open for that verb.

## Resumable receipt bundle

For live rollout, prefer writing every receipt for an agent into one 0700 bundle
directory. The bundle command runs the existing receipt tools, saves their JSON
output as 0600 files, runs the final cutover gate over all passing receipts in
that directory, and writes `manifest.json`:

```bash
node ~/.fleet/runtime/receipt-bundle.mjs \
  --agent my-agent \
  --out-dir ~/.fleet/receipts/my-agent \
  --install-receipt ~/.fleet/receipts/install.json \
  --skip-runtime \
  --skip-control
```

or from a checkout:

```bash
npm run receipt:bundle -- \
  --agent my-agent \
  --out-dir ./receipts/my-agent \
  --install-receipt ./receipts/install.json \
  --skip-runtime \
  --skip-control
```

The first run proves host wiring and writes a failing final gate until live
runtime and lifecycle evidence exist. If `--install-receipt` is supplied, the
bundle copies it into `install.json` and accepts installer `status:"warn"` as
non-failing because the later host pre-flight receipt proves edited config and
key readiness. Queue the live inbox probe and `start` control request without
putting tokens on the command line, and save the redacted queue receipt:

```bash
MUPOT_AGENT_TOKEN='<welded-sender-token>' \
MUPOT_OWNER_TOKEN='<owner-token>' \
node ~/.fleet/runtime/cutover-probe.mjs \
  --base-url https://YOUR-POT.example.com \
  --agent my-agent \
  --queue-inbox \
  --control start \
  > ~/.fleet/receipts/my-agent/probe-start.json
```

Then collect the runtime handoff and `start` control receipts:

```bash
node ~/.fleet/runtime/receipt-bundle.mjs \
  --agent my-agent \
  --out-dir ~/.fleet/receipts/my-agent \
  --probe-receipt ~/.fleet/receipts/my-agent/probe-start.json \
  --skip-host \
  --control-label start
```

Queue a `stop` control request and collect the second live control receipt:

```bash
MUPOT_OWNER_TOKEN='<owner-token>' \
node ~/.fleet/runtime/cutover-probe.mjs \
  --base-url https://YOUR-POT.example.com \
  --agent my-agent \
  --control stop \
  > ~/.fleet/receipts/my-agent/probe-stop.json

node ~/.fleet/runtime/receipt-bundle.mjs \
  --agent my-agent \
  --out-dir ~/.fleet/receipts/my-agent \
  --probe-receipt ~/.fleet/receipts/my-agent/probe-stop.json \
  --skip-host \
  --skip-runtime \
  --control-label stop
```

To recheck an already gathered evidence directory without touching the live host
runtime, use read-only verification. This reuses `host.json`,
`runtime-*.json`, and `control-*.json`, then rewrites only `cutover-gate.json`
and `manifest.json`:

```bash
node ~/.fleet/runtime/receipt-bundle.mjs \
  --agent my-agent \
  --out-dir ~/.fleet/receipts/my-agent \
  --verify-only
```

At any point while collecting evidence, inspect the current host-go state
without polling the host or rewriting files:

```bash
node ~/.fleet/runtime/receipt-bundle.mjs \
  --agent my-agent \
  --out-dir ~/.fleet/receipts/my-agent \
  --status
```

or from a checkout:

```bash
npm run receipt:bundle:status -- --agent my-agent --out-dir ./receipts/my-agent
```

It prints `receipt_type: "mupot-fleet-receipt-bundle-status/v1"` and checks
the issue #274 evidence contract: install receipt, host receipt, queued probe
receipts, runtime receipt, per-agent start/stop control evidence,
`cutover-gate.json`, `manifest.json`, and copied-bundle manifest verification
when present. It exits non-zero until the evidence is ready, and its `next_steps`
name the next host action to run, including missing `agent:verb` lifecycle
evidence before the final gate is rebuilt.

To produce the clean attachable copy for #274, export from the working receipt
directory into a fresh directory. The export command copies only `manifest.json`
and the receipt artifacts named in that manifest, then runs the same manifest
check against the exported directory. The exported `manifest.json` is made
portable: receipt artifact paths are local filenames and the exported `out_dir`
is `.`; the working source manifest is not rewritten.

```bash
node ~/.fleet/runtime/receipt-bundle.mjs \
  --out-dir ~/.fleet/receipts/my-agent \
  --export-dir ~/.fleet/receipts/my-agent-attach \
  --export
```

or from a checkout:

```bash
npm run receipt:bundle:export -- \
  --out-dir ./receipts/my-agent \
  --export-dir ./receipts/my-agent-attach
```

Attach only the exported directory after the export receipt reports
`receipt_type: "mupot-fleet-receipt-bundle-export/v1"` with `status: "pass"`.
Use `--force` only to overwrite a failed export after fixing the source
evidence or clearing the destination.

To verify a copied bundle without rewriting anything, run the manifest check. It
reads `manifest.json`, checks the recorded receipt artifact SHA-256 hashes, reads
each saved receipt JSON, verifies receipt type/status against the manifest,
requires the host/probe/runtime/control/cutover-gate evidence categories,
recomputes the manifest summary from its recorded checks, verifies the cutover
gate was built for the manifest's selected agents/control verbs/artifacts,
verifies all non-secret receipt target identities agree on the same pot base URL
and tenant, scans the manifest and receipt artifacts for obvious secret material
such as bearer tokens, raw `mupot_` tokens, private-key PEM/JWK data, GitHub
tokens, or authorization fields, verifies the checked directory contains only
`manifest.json` plus the receipt artifacts named in the manifest, verifies every
artifact is present in that same copied directory rather than resolved through an
old absolute host path, verifies `next_steps` does not contradict readiness, and
exits non-zero if any saved file, manifest status, or attachable evidence safety
check drifted:

```bash
node ~/.fleet/runtime/receipt-bundle.mjs \
  --out-dir ~/.fleet/receipts/my-agent \
  --check-manifest
```

or from a checkout:

```bash
npm run receipt:bundle:check -- --out-dir ./receipts/my-agent
```

When `manifest.json` and `cutover-gate.json` both report
`receipt_type: "mupot-fleet-receipt-bundle/v1"` /
`"mupot-sos-cutover-gate/v1"` with `status: "pass"`, the saved evidence is ready
to attach to the cutover record for that agent. Use `--force` only to replace a
same-name failed attempt after fixing the underlying host issue.

The manifest includes SHA-256 hashes for the saved receipt artifacts
(`install.json`, `probe-*.json`, `host.json`, `runtime-*.json`,
`control-*.json`, and `cutover-gate.json`). It does not hash `manifest.json`
inside itself because that file is self-referential. The manifest check emits
`mupot-fleet-receipt-bundle-check/v1`; it accepts installer `pass|warn` and
requires the host, probe, runtime, control, and cutover-gate receipts to be
`status:"pass"`. It also requires probe and runtime artifacts for each selected
agent.
The check receipt includes the SHA-256 of the `manifest.json` file it inspected
and compares `cutover-gate.json.inputs` back to the manifest evidence. It
rejects copied evidence that mixes receipts from different pot base URLs or
tenants. It also rejects advisory `next_steps` guidance that says to attach the
bundle before the hard gate passes, or says to keep SOS wiring after the hard
gate passes. Secret-scan findings include only the JSON path and reason; they do
not echo the suspected secret value.
Directory-scope failures mean the attachable bundle is not self-contained or
contains files outside the allowed evidence set; rebuild a clean copy with only
`manifest.json`, `install.json` when present, `probe-*.json`, `host.json`,
`runtime-*.json`, `control-*.json`, and `cutover-gate.json`.

Every bundle manifest also includes `next_steps`. Treat those as operator
guidance only: the hard gate remains `manifest.json` and `cutover-gate.json`
both reporting `status: "pass"`, and `--check-manifest` enforces that the
advisory guidance does not contradict that state.

## Notes
- `interval_sec` is clamped to `[15,120]` and must stay under the pot's presence TTL (default 180s).
- The daemon sends signed detach on shutdown for agents it successfully heartbeated during
  this daemon run. `flight close` also signs detach after teardown succeeds.
- Supersedes the bearer-token `adapter.py` flow for the signed path.
