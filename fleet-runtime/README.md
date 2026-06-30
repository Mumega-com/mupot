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

## Notes
- `interval_sec` is clamped to `[15,120]` and must stay under the pot's presence TTL (default 180s).
- v1 has no signed `/detach`: on daemon stop, presence decays to `stale` (honest interim).
- Supersedes the bearer-token `adapter.py` flow for the signed path.
