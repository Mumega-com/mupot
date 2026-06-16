---
name: mupot-operator
description: >
  Operator knowledge for mupot — the Cloudflare-native agent substrate.
  Covers provisioning a new pot, understanding org/RBAC/board/memory concepts,
  enabling the DMN brain, and avoiding known pitfalls (migration drift, token scope,
  cron symlink failure). Load when a user wants to set up, operate, or troubleshoot mupot.
version: "0.1.0"
required_environment_variables:
  - MUPOT_CF_ACCOUNT_ID
  - MUPOT_CF_API_TOKEN
optional_environment_variables:
  - MUPOT_SLUG
  - MUPOT_BRAND
  - MUPOT_OAUTH_PROVIDER
tools:
  - mupot_provision
  - mupot_status
  - mupot_brain_enable
companion_skills:
  - cloudflare/skills  # official CF skill tap (Workers/D1/KV/R2/Wrangler/Vectorize)
---

# mupot Operator Skill

> **v0.1 is PLAN-ONLY.** `mupot_provision` emits a structured plan and the exact
> wrangler CLI commands to run. It does NOT call the Cloudflare API directly — no SDK
> client is bundled in v0.1. Run the emitted commands yourself. Real auto-apply lands
> in v0.2.

## What mupot is

mupot is a **Cloudflare-native sovereign agent substrate** — org, RBAC, board, memory, and
bus in a single Cloudflare Worker. Each user owns their own instance (their own D1, KV,
Workers slot) under their own Cloudflare account. No Mumega server sees your data.

Core concepts:
- **Pot** — one mupot deployment = one Cloudflare Worker (`mupot-<slug>.workers.dev`)
- **Org** — your organisation, with members, roles, and capability grants
- **Board** — task board (work units, gates, done_when predicates)
- **Memory** — D1 relational + Vectorize semantic recall (Vectorize deferred to v0.2)
- **Brain** — an optional always-on DMN prioritiser (qwen3.7-plus via OpenRouter, free tier)

## Provision flow (v0.1 — plan-only)

**Prerequisites:**
1. A Cloudflare account (free tier is sufficient for a single pot)
2. A scoped CF API token — minimum permissions: Workers Scripts:Edit, D1:Edit,
   Workers KV Storage:Edit, Account Settings:Read
3. `MUPOT_CF_ACCOUNT_ID` and `MUPOT_CF_API_TOKEN` set in your environment

**Step 1 — Get the plan:**
```
mupot_provision(slug="acme", brand="Acme Corp", cf_account_id="...", cf_api_token="...")
# Returns a plan with exact wrangler CLI commands. confirm defaults to False.
# v0.1: this is ALL the tool does — it plans, not applies.
```

**Step 2 — Review the plan.** Check for existing resources (idempotent list-guard).
If your D1 or KV already exists, the tool notes skips.

**Step 3 — Run the emitted wrangler commands yourself (v0.1 — manual):**
```bash
# Commands are in result["next_steps"]. Example for slug="acme":

# Create D1 database:
npx wrangler d1 create mupot-acme

# Create KV namespaces:
npx wrangler kv namespace create mupot-acme-sessions
npx wrangler kv namespace create mupot-acme-oauth

# Copy wrangler.example.toml → wrangler.acme.toml and fill in the IDs above.
```

> v0.2 will bundle the Cloudflare SDK and run steps 1–3 automatically via
> `confirm=True, dry_run=False`. In v0.1, those flags return the same plan-only
> response (no live CF calls are made either way without an SDK client).

**Step 4 — Deploy + migrate (follow next_steps exactly):**
```bash
# Deploy the worker
npx wrangler deploy --config wrangler.acme.toml

# !! MIGRATION SAFETY — always dry-run first (see Pitfall 2 below)
npx wrangler d1 migrations apply mupot-acme --dry-run --config wrangler.acme.toml
# Review the output. Only run without --dry-run once you've confirmed no destructive ops.
npx wrangler d1 migrations apply mupot-acme --config wrangler.acme.toml

# Set OAuth secrets (required for the dashboard login)
npx wrangler secret put OAUTH_CLIENT_ID --config wrangler.acme.toml
npx wrangler secret put OAUTH_CLIENT_SECRET --config wrangler.acme.toml
```

**Step 5 — Verify:**
```
mupot_status(url="https://mupot-acme.workers.dev")
# Returns {ok: true, tenant: "acme", url: "https://mupot-acme.workers.dev"}
```

## Brain enable

The brain is an optional always-on DMN (Default Mode Network) prioritiser — a cheap
qwen3.7-plus Hermes session that scans your board every 15 minutes and ranks work.

```
mupot_brain_enable(slug="acme")
# Returns a plan with: config.yaml content, cron script content, cron entry, next_steps.
# Follow the next_steps to write the files and register the cron.
```

Then follow the `next_steps` in the result:
1. Create `~/.hermes/profiles/mupot-acme-brain/config.yaml`
2. Write the cron script as a **real file** (not a symlink — see Pitfall 3)
3. Register the cron entry in `~/.hermes/cron/jobs.json`
4. Set `MUMEGA_BRAIN_TOKEN_ACME` to a **scoped token** (task:read + priority:write only)
   — **operator's responsibility**: the plugin documents this requirement but cannot
   enforce token scope (no token introspection available in the cron context)
5. Hermes hotloads cron config without daemon restart

## Pitfalls

### Pitfall 1 — CF token on disk (Risk 1)
Your `MUPOT_CF_API_TOKEN` lives in Hermes `.env.secrets` in plaintext.
Mitigate: use the minimum-scope token (5 permission groups, not Edit-All). After
provisioning, consider rotating the token in the CF dashboard. CF OAuth (one-click, no
token on disk) is coming once Mumega's OAuth app passes CF public vetting.

### Pitfall 2 — Migration drift landmine (Risk 2)
**NEVER run `npx wrangler d1 migrations apply --remote` without `--dry-run` first.**

The digid tenant learned this the hard way (migration 0026 → member_tokens table was
rebuilt OOB, live data in the way). `IF NOT EXISTS` does not protect you from future
destructive operations. Always:
1. `--dry-run` → read every line of output
2. Only apply if you see no DROP, no destructive ALTER

### Pitfall 3 — Cron symlink failure (Risk: silent non-execution)
Hermes cron scheduler reads the script path directly. A symlink to a missing target causes
a **silent** non-execution — no error, no log, the brain simply never runs. Always write
a **real file** for the cron script. `mupot_brain_enable` outputs a real-file template.

### Pitfall 4 — Brain token scope (Risk 3 — operator responsibility)
`MUMEGA_BRAIN_TOKEN_<SLUG>` must carry ONLY `task:read` + `priority:write`.
Using `mcp:*` would grant full bus control to an always-on automated agent.

**The cron script checks that the token is SET, but cannot verify its scope.** The
Mumega bus does not expose token introspection to the cron context. The operator must
supply the correctly-scoped token — this is documented but not enforced by the plugin.

### Pitfall 5 — Workers free-tier slot (Risk 5)
Each pot = one Workers slot. Free tier = 100 slots. If you're near the limit, the
`mupot_provision` tool will warn you. Workers-for-Platforms centralisation is explicitly
rejected (it breaks pot sovereignty) — each user must stay within their own slot budget.

## v0.1 scope / deferred

**In v0.1 (plan-only):**
- Dry-run plan with exact wrangler CLI commands for manual execution
- Idempotent list-guard logic (skip existing D1/KV)
- `wrangler.toml` generation when an injected CF client is provided (test/CI path)
- Brain profile + cron plan emission
- Deploy-to-Cloudflare button (README)

**Deferred to v0.2+:**
- Real auto-apply: bundles `cloudflare` SDK, auto-creates D1/KV resources
- CF OAuth one-click (pending Mumega OAuth app public approval)
- Full SDK provisioner (no wrangler dep): `client.workers.scripts.update()`
- OAuth secret automation (guided prompt + CF secrets API)
- R2 / Vectorize / Queues provisioning (add via re-run)
- `mupot_revoke_token` post-provision
- `pot_registry` / `pot_owners` D1 migrations for the "Your Pots" console (G4)
- `hermes plugins install Mumega-com/mupot-plugin` standalone repo (publish-time step)
