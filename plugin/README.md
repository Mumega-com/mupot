# mupot Hermes Plugin

Provision and operate your own [mupot](https://github.com/Mumega-com/mupot) instance on
Cloudflare — org/RBAC/board/memory with an optional idempotent brain — from inside Hermes.

## Quick install

```bash
# Hermes plugin (provisioning tools + bundled operator skill):
hermes plugins install Mumega-com/mupot-plugin

# Companion CF skill tap (Workers/D1/KV/R2/Wrangler context):
hermes skills install cloudflare/skills
```

After install, Hermes prompts for `MUPOT_CF_ACCOUNT_ID` and `MUPOT_CF_API_TOKEN`.

### Getting your CF API token

You need a **scoped** token — NOT your Global API Key.

Create one at:
```
https://dash.cloudflare.com/profile/api-tokens?template=mupot
```
*(token-template link — G8: pre-configured with the 5 minimum permission groups)*

Minimum permissions required:
- Workers Scripts: Edit
- D1: Edit
- Workers KV Storage: Edit
- Account Settings: Read

### Skill-only install (Claude Code, OpenClaw, Codex, etc.)

If you don't use Hermes, drop the bundled skill anywhere your agent loads skills:

```bash
cp -r skills/mupot-operator ~/.claude/skills/
```

## Deploy to Cloudflare (no CLI)

For non-Hermes users who just want to deploy a mupot instance directly:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Mumega-com/mupot)

*(G9 — reads `wrangler.example.toml`, provisions bindings, deploys. Zero-code path.)*

## Three tools

| Tool | What it does |
|------|-------------|
| `mupot_provision` | Idempotent D1 + KV create, `wrangler.<slug>.toml` generation. Dry-run by default. |
| `mupot_status` | Probe `/health` → `{ok, tenant, url}` |
| `mupot_brain_enable` | Emit the steps to wire the DMN brain (qwen3.7-plus, 15-min scan, scoped token) |

## v0.1 scope / deferred

**In v0.1:**
- BYO-CF via API token paste (Model B — unblocked today)
- D1 + KV (SESSIONS + OAUTH_KV) provisioning with idempotent list-guard
- `wrangler.toml` generation from template
- Brain profile + cron plan emission (real-file cron, not symlink)
- Deploy-to-Cloudflare button

**Deferred (v0.2+):**
- CF OAuth one-click (pending Mumega OAuth app public approval)
- Full SDK provisioner (no wrangler dependency)
- OAuth secret automation
- R2 / Vectorize / Queues provisioning (add via re-run)
- `mupot_revoke_token` post-provision cleanup
- `pot_registry` / `pot_owners` migrations for the "Your Pots" console

## Key risks

| Risk | Mitigation |
|------|-----------|
| CF token on disk | Least-scoped token (5 groups). Rotate after provision. CF OAuth coming. |
| Migration drift | ALWAYS `--dry-run` first. Tool emits this as a required step, never auto-applies. |
| Brain token scope | Must be `task:read + priority:write` only. NOT `mcp:*`. Cron script enforces this. |
| Cron symlink | Real file only. Symlink → silent non-execution. Tool template uses real file. |
| Workers slot | Free tier = 100. Tool warns near limit. Centralised Workers-for-Platforms rejected (breaks sovereignty). |

## Development

```bash
# Run tests (no network, no CF account needed):
cd plugin
python3 -m pytest tests/ -v
```
