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
| `fleet-daemon.mjs` | presence heartbeat loop plus optional signed inbox drain |
| `daemon.example.json` | config template (set base_url, tenant, agents, probes) |
| `fleet-daemon.service` | systemd user unit |

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

## Run the daemon (continuous presence + optional inbox drain)

```bash
mkdir -p ~/.fleet/runtime ~/.config/systemd/user
cp fleet-runtime/*.mjs ~/.fleet/runtime/
cp fleet-runtime/daemon.example.json ~/.fleet/daemon.json    # edit base_url, tenant, REAL probes
cp fleet-runtime/fleet-daemon.service ~/.config/systemd/user/
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
block to that agent:

```json
{
  "agent_id": "agent-one",
  "type": "builder",
  "runtime": "claude-code",
  "probe": "tmux has-session -t agent-one 2>/dev/null",
  "inbox": {
    "command": "$HOME/.fleet/handlers/agent-one-inbox.sh",
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

Exit `0` only after the runtime has persisted or accepted the batch. A non-zero exit, crash,
or timeout leaves the Mupot messages unread for the next daemon tick. The inbox read is signed
with the agent's Ed25519 key and POSTed to `/api/inbox/signed`; it does not need a bearer token.

## Flights (the activation unit) — `flight.mjs`

Agents don't sit warm. They **fly** bounded bursts and land. mupot brings the runtime up for a
flight; the agent works; it lands and the runtime goes down. Tokens burn only between takeoff
and land — idle is zero.

```bash
node fleet-runtime/flight.mjs open  my-agent   # takeoff: run `launch` → signed-attach (→ live)
node fleet-runtime/flight.mjs close my-agent   # land: run `teardown` (→ presence decays = landed)
node fleet-runtime/flight.mjs list             # show configured flights
```

Config `~/.fleet/flights.json` (see `flights.example.json`): per agent, `launch` (a **non-blocking**
command that brings the runtime up, e.g. `tmux new-session -d`) + `teardown` (brings it down).
`open` runs `launch` then signs an attach — a **point-in-time** takeoff ping that flips presence
`live` (and, if attach fails after launch, rolls the runtime back so nothing is orphaned). `close`
runs `teardown`; a clean teardown lands it (presence decays running→`stale`), a failed teardown
reports `LAND_UNCERTAIN` (runtime may still be up) rather than a false `LANDED`.

Note: a single `flight open` proves the runtime was up *at takeoff* + a valid signature — it does
NOT guarantee sustained liveness. Continuous truthful presence (`live` while running → `stale`
when it dies) is the **heartbeat daemon's** job (`fleet-daemon.mjs`), which re-attaches on a
cadence. Run the daemon alongside flights for a runtime that should report presence for its whole
flight; use bare `flight open/close` for the lifecycle transitions.

The **remote trigger** — mupot `POST /api/fleet/control {agent_id, verb:start}` → signed
control-request → host control-daemon → runs the flight — is the ATC layer (fleet-control
`daemon.py`/`engine.py`); it needs the consumer agent minted + the control-daemon installed
(owner-gated). Until then, flights run locally via `flight.mjs`.

## Notes
- `interval_sec` is clamped to `[15,120]` and must stay under the pot's presence TTL (default 180s).
- v1 has no signed `/detach`: on land / daemon stop, presence decays to `stale` (honest interim;
  crisp `offline` needs a signed detach — follow-up).
- Supersedes the bearer-token `adapter.py` flow for the signed path.
