# Asha-Luna Machinery Candidate — bundle manifest

Candidate only. Nothing here activates anything; nothing here was installed,
enabled, minted, or started. Promotion is gated by River's decision request
`asha-luna-machinery-20260913`.

## Files

| File | Purpose | Install target (promotion-time, AFTER gates) |
|---|---|---|
| `config.asha.yaml` | Hermes profile config template — Luna model route (fork-configurable), kanban rail, lean memory | `~/.hermes/profiles/asha/config.yaml` |
| `SOUL.asha.md` | Asha SOUL: identity, cause, MU.100.001 §2.2 findings law, boundaries | `~/.hermes/profiles/asha/SOUL.md` |
| `asha.alias.sh` | CLI alias that pins the profile (`hermes -p asha "$@"`) — fixes the responder's default-profile launch | `~/.local/bin/asha` (chmod 755) |
| `asha-responder.service.drop-in` | systemd drop-in: `RESPONDER_BIN` → asha alias, `RESPONDER_FLAVOR=hermes`, routines/tasks pinned off | `/etc/systemd/system/asha-responder.service.d/override.conf` |
| `hashes.pins` | sha256 fingerprints (token + machinery + retired units) pinned at authoring | reference only |
| `smoke-asha-luna-candidate.sh` | deterministic smoke — exact profile/model + no activation | run from this dir |

## Smoke

```bash
./smoke-asha-luna-candidate.sh                # baseline: templates + no activation
./smoke-asha-luna-candidate.sh --mode=promotion-ready   # installed artifacts match templates
ASHA_SMOKE_EXPECT_MODEL=<m> ASHA_SMOKE_EXPECT_PROVIDER=<p> ./smoke-asha-luna-candidate.sh  # fork proof
```

Read-only: no network, no model calls, no state changes. Exit 0 == all PASS.

## What the design preserves (by construction — no code in `~/.fleet/prime/` changed)

- Durable capture: `inbox-watch.py` lease→spool→ack, at-least-once (`~/.fleet/prime/inbox-watch.py`)
- Singleton: flock on responder + watcher (one process per agent, ever)
- Loop breaker / rate: auto-reply marker, hourly reply cap, parking lanes
  (`machine/`, `routines/`, `stale/`, `failed/` — never a silent drop)
- Staleness gate: `RECENT_WINDOW_HOURS` — old mail parks in `stale/`, never answered
- Credential stripping: `CLOUDFLARE_API_TOKEN` / `GITHUB_TOKEN` / `MUPOT_ADMIN_TOKEN`
  stripped from child environments, token single-sourced from the 600-mode file

## Architectural reference

- Full rationale + evidence: `docs/research/2026-09-13-asha-luna-machinery-candidate.md`
- Kanban rail design: `docs/research/2026-09-13-asha-brain-mupot-native-revival.md`
- Asha spine: `docs/spine/agents/asha.md` · keystone: `docs/spine/the-keystone-agent-receiving.md`