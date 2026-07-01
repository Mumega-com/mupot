# fleet-runtime — host-side agent runtime for the pot

The **distributable, sterile** companion to the pot worker. The worker (`src/fleet/`) *verifies*
signed-attach and computes presence; this runtime *runs on a host*, proves each agent's identity
by signature, and heartbeats only the agents whose runtime is actually alive.

Fork the pot → you get this. No tenant is hardcoded: `base_url` + `tenant` come from your config.

## The model

- **Agent identity ≠ runtime.** An agent is a durable identity (member + Ed25519 key + RBAC);
  the runtime (claude-code / codex / hermes) is a swappable shell. See `docs/agent-running-on-mupot.md`.
- **No placed secret.** The host holds a private key; the pot stores only the public key. Each
  attach is a signature — nothing secret is transported or placed.
- **Truthful presence.** The daemon probes each agent's runtime; it heartbeats only the live
  ones, so the pot's presence reflects reality (`live` while running → `stale` when it dies).

## Files

| file | role |
|---|---|
| `agent-keygen.mjs` | generate an agent's Ed25519 keypair (private stays on host, 0600) |
| `register-agent-key.sh` | register the **public** key in the pot (`agent_keys`) via wrangler |
| `attach-signed.mjs` | one-shot signed attach (CLI) |
| `fleet-sign.mjs` | shared signer core (no tenant default) |
| `fleet-daemon.mjs` | presence heartbeat loop (probe → signed-attach live agents) |
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

## Run the daemon (continuous presence)

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
