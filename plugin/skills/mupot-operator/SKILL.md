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

## Provision flow

**Prerequisites:**
1. A Cloudflare account (free tier is sufficient for a single pot)
2. A scoped CF API token — use the token-template link in README.md:
   minimum permissions: Workers Scripts:Edit, D1:Edit, Workers KV Storage:Edit, Account Settings:Read
3. `MUPOT_CF_ACCOUNT_ID` and `MUPOT_CF_API_TOKEN` set in your environment

**Step 1 — Dry-run plan:**
```
mupot_provision(slug="acme", brand="Acme Corp", cf_account_id="...", cf_api_token="...")
# Returns a plan. confirm defaults to False — nothing is created yet.
```

**Step 2 — Review the plan.** Check for existing resources (idempotent list-guard).
If your D1 or KV already exists, the tool skips creation.

**Step 3 — Apply:**
```
mupot_provision(slug="acme", brand="Acme Corp", cf_account_id="...", cf_api_token="...",
                confirm=True, dry_run=False)
# Creates D1 + KV, writes wrangler.acme.toml.
```

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
5. Hermes hotloads cron config without daemon restart

## Pitfalls

### Pitfall 1 — CF token on disk (Risk 1)
Your `MUPOT_CF_API_TOKEN` lives in Hermes `.env.secrets` in plaintext.
Mitigate: use the minimum-scope token (5 permission groups, not Edit-All). After
provisioning, consider running `mupot_revoke_token` (v0.2) or manually rotating the token
in the CF dashboard. CF OAuth (one-click, no token on disk) is coming once Mumega's OAuth
app passes CF public vetting.

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

### Pitfall 4 — Brain token must be scoped (Risk 3)
`MUMEGA_BRAIN_TOKEN_<SLUG>` must carry ONLY `task:read` + `priority:write`.
Using `mcp:*` would grant full bus control to an always-on automated agent. The cron
script template enforces this by checking and refusing to start without the right token.

### Pitfall 5 — Workers free-tier slot (Risk 5)
Each pot = one Workers slot. Free tier = 100 slots. If you're near the limit, the
`mupot_provision` tool will warn you. Workers-for-Platforms centralisation is explicitly
rejected (it breaks pot sovereignty) — each user must stay within their own slot budget.

## v0.1 scope / deferred

**In v0.1:**
- BYO-CF via API token paste (Model B)
- D1 + KV (SESSIONS + OAUTH_KV) provisioning
- `wrangler.toml` generation
- Brain profile + cron plan emission
- Deploy-to-Cloudflare button (README)

**Deferred to v0.2+:**
- CF OAuth one-click (pending Mumega OAuth app public approval)
- Full SDK provisioner (no wrangler dep): `client.workers.scripts.update()`
- OAuth secret automation (guided prompt + CF secrets API)
- R2 / Vectorize / Queues provisioning (add via re-run)
- `mupot_revoke_token` post-provision
- `pot_registry` / `pot_owners` D1 migrations for the "Your Pots" console (G4)
