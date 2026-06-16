# mupot Hermes Plugin

Provision and operate your own [mupot](https://github.com/Mumega-com/mupot) instance on
Cloudflare — org/RBAC/board/memory with an optional idempotent brain — from inside Hermes.

> **v0.2 ships the real CF provisioner.** `mupot_provision` with `confirm=True, dry_run=False`
> calls the Cloudflare API directly (pure stdlib urllib — no extra deps) to create D1 databases
> and KV namespaces, then writes `wrangler.<slug>.toml` with the resolved resource IDs.
> Default (`dry_run=True`) emits a plan without touching Cloudflare. Requires
> `MUPOT_CF_API_TOKEN` and `MUPOT_CF_ACCOUNT_ID` in the environment for apply mode.

## Current install (v0.2 — nested in the mupot repo)

v0.2 lives at `mupot/plugin/` inside the [Mumega-com/mupot](https://github.com/Mumega-com/mupot)
repository. A standalone `Mumega-com/mupot-plugin` repo is the publish-time target — not yet
created. Until v0.3 publishes there, install from source:

```bash
# Clone the mupot repo and load the plugin from the nested path:
git clone https://github.com/Mumega-com/mupot
cd mupot/plugin

# Run tests to verify the provisioner:
python3 -m pytest tests/ -v
```

The `hermes plugins install Mumega-com/mupot-plugin` one-liner is the **future** (v0.3+)
install path once the standalone repo is published.

### Companion CF skill tap (for Hermes users)

```bash
hermes skills install cloudflare/skills
```

### Skill-only install (Claude Code, OpenClaw, Codex, etc.)

If you don't use Hermes, drop the bundled skill anywhere your agent loads skills:

```bash
cp -r skills/mupot-operator ~/.claude/skills/
```

## Deploy to Cloudflare (no CLI)

For users who want to deploy a mupot instance directly:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Mumega-com/mupot)

*(Reads `wrangler.example.toml`, provisions bindings, deploys. Zero-code path.)*

## Three tools

| Tool | What it does |
|------|-------------|
| `mupot_provision` | Idempotent provisioner. Default (dry_run=True): emit a plan. Apply (confirm=True + dry_run=False): create D1 + KV via CF API, write `wrangler.<slug>.toml`. |
| `mupot_status` | Probe `/health` → `{ok, tenant, url}` |
| `mupot_brain_enable` | Emit the steps to wire the DMN brain (qwen3.7-plus, 15-min scan, scoped token) |

## v0.2 scope / deferred

**In v0.2 (real CF provisioner):**
- Real apply: CF REST API via pure stdlib urllib (no extra deps) — creates D1 + KV idempotently
- Idempotent list-guard: paginates all existing resources before creating (no double-create)
- `wrangler.<slug>.toml` written with resolved D1 + KV IDs after apply
- Optional `wrangler deploy` via subprocess (Risk 4: version-check gate first)
- Token security: never in argv, repr, error messages, or toml output
- Brain profile + cron plan emission (real-file cron, not symlink)
- Deploy-to-Cloudflare button

**Deferred (v0.3+):**
- CF OAuth one-click (pending Mumega OAuth app public approval)
- Full SDK provisioner (no wrangler dependency): `client.workers.scripts.update()`
- OAuth secret automation
- `hermes plugins install Mumega-com/mupot-plugin` one-liner (standalone repo publish)
- R2 / Vectorize / Queues provisioning (add via re-run)
- `mupot_revoke_token` post-provision cleanup (needs token ID at mint time)
- `pot_registry` / `pot_owners` migrations for the "Your Pots" console

## Key risks

| Risk | Mitigation |
|------|-----------|
| CF token on disk | Least-scoped token (5 groups). Rotate after provision. CF OAuth coming. |
| Migration drift | ALWAYS `--dry-run` first. Tool emits this as a required step, never auto-applies. |
| Brain token scope | Must be `task:read + priority:write` only. NOT `mcp:*`. **Operator's responsibility** — the plugin documents the requirement but cannot enforce token scope. |
| Cron symlink | Real file only. Symlink → silent non-execution. Tool template uses real file. |
| Workers slot | Free tier = 100. Tool warns near limit. Centralised Workers-for-Platforms rejected (breaks sovereignty). |

## CF API token (required for apply mode)

You need a **scoped** token — NOT your Global API Key.

Create one at:
```
https://dash.cloudflare.com/profile/api-tokens
```

Minimum permissions required:
- Workers Scripts: Edit
- D1: Edit
- Workers KV Storage: Edit
- Account Settings: Read

## Development

```bash
# Run tests (no network, no CF account needed):
cd plugin
python3 -m pytest tests/ -v
```
