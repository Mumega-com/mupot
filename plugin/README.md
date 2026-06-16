# mupot Hermes Plugin

Provision and operate your own [mupot](https://github.com/Mumega-com/mupot) instance on
Cloudflare — org/RBAC/board/memory with an optional idempotent brain — from inside Hermes.

> **v0.1 is PLAN-ONLY.** The `mupot_provision` tool emits a structured plan and the
> exact wrangler CLI commands to run. It does NOT call the Cloudflare API directly — the
> real SDK client is not bundled in v0.1. Real auto-apply lands in v0.2.

## Current install (v0.1 — nested in the mupot repo)

v0.1 lives at `mupot/plugin/` inside the [Mumega-com/mupot](https://github.com/Mumega-com/mupot)
repository. A standalone `Mumega-com/mupot-plugin` repo is the publish-time target — not yet
created. Until v0.2 publishes there, install from source:

```bash
# Clone the mupot repo and load the plugin from the nested path:
git clone https://github.com/Mumega-com/mupot
cd mupot/plugin

# Run tests to verify the scaffold:
python3 -m pytest tests/ -v
```

The `hermes plugins install Mumega-com/mupot-plugin` one-liner is the **future** (v0.2+)
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
| `mupot_provision` | Emits an idempotent plan + exact wrangler CLI commands. **v0.1 = PLAN-ONLY** — run the emitted commands yourself. Real apply in v0.2. |
| `mupot_status` | Probe `/health` → `{ok, tenant, url}` |
| `mupot_brain_enable` | Emit the steps to wire the DMN brain (qwen3.7-plus, 15-min scan, scoped token) |

## v0.1 scope / deferred

**In v0.1 (plan-only scaffold):**
- Dry-run plan: lists what would be created (D1 + KV), emits idempotent list-guard logic
- Exact wrangler CLI commands emitted so the operator can run them manually
- `wrangler.toml` generation when an injected CF client is provided (test/CI path)
- Brain profile + cron plan emission (real-file cron, not symlink)
- Deploy-to-Cloudflare button

**Deferred (v0.2+):**
- Real auto-apply: bundles `cloudflare` SDK, constructs client from token, creates D1/KV
- CF OAuth one-click (pending Mumega OAuth app public approval)
- Full SDK provisioner (no wrangler dependency)
- OAuth secret automation
- `hermes plugins install Mumega-com/mupot-plugin` one-liner (standalone repo publish)
- R2 / Vectorize / Queues provisioning (add via re-run)
- `mupot_revoke_token` post-provision cleanup
- `pot_registry` / `pot_owners` migrations for the "Your Pots" console

## Key risks

| Risk | Mitigation |
|------|-----------|
| CF token on disk | Least-scoped token (5 groups). Rotate after provision. CF OAuth coming. |
| Migration drift | ALWAYS `--dry-run` first. Tool emits this as a required step, never auto-applies. |
| Brain token scope | Must be `task:read + priority:write` only. NOT `mcp:*`. **Operator's responsibility** — the plugin documents the requirement but cannot enforce token scope. |
| Cron symlink | Real file only. Symlink → silent non-execution. Tool template uses real file. |
| Workers slot | Free tier = 100. Tool warns near limit. Centralised Workers-for-Platforms rejected (breaks sovereignty). |

## CF API token (required for v0.2+ auto-apply)

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
