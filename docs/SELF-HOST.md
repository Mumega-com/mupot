# Self-hosting mupot — your account, your data

mupot is a **sovereign** agent substrate: a tenant can run a pot on their **own**
Cloudflare account. The data never leaves your account, you pay your own CF bill, and you
stay compatible with upstream. This is the one property the hyperscaler agent platforms
structurally cannot match.

## One pot = one Cloudflare Worker + its bindings

A pot is a single Worker (`wrangler.<pot>.toml`) bound to:

| Binding | Resource | Purpose |
|---------|----------|---------|
| `DB` | D1 | org, tasks, gates, loops, prospects, meter |
| `VEC` | Vectorize | memory / semantic search |
| `BUS` | Queues (+ DLQ) | internal event bus |
| `SESSIONS` | KV | sessions, OAuth state |
| `BLOBS` | R2 | blobs/files |
| `AI` | Workers AI | default model |
| `AGENT`, `SQUAD` | Durable Objects | per-unit state + alarms |
| `TASK_WORKFLOW` | Workflows | durable task pipeline |

DO, Workflows, and AI are code-defined (declared in the toml); the rest are created once
per pot.

## Provision

```bash
npx wrangler login                 # on the TARGET account
scripts/provision-pot.sh acme      # creates D1/Vectorize/Queues/KV/R2 for pot "acme"
```

Then follow the printed steps: copy `wrangler.toml` → `wrangler.acme.toml`, paste the
resource IDs, set `[vars]` (`TENANT_SLUG`, OAuth), put secrets, apply migrations, deploy.

## Secrets

Secrets are Worker secrets (`wrangler secret put`), never in the toml.
- `OAUTH_CLIENT_SECRET` — Google sign-in.
- Per-integration (optional): `GHL_API_KEY` / `GHL_LOCATION_ID` / `GHL_WEBHOOK_SECRET`.
- **BYO MCP credentials** for a loop: `LOOP_SECRET_<name>` (the token) + a
  `LOOP_SECRET_<name>_HOST` var (the only host it may travel to). See
  [loop-manifest-contract.md](./loop-manifest-contract.md). Platform secrets are outside
  this namespace and are unreachable from a tenant manifest.

## Staying in sync with upstream

A self-hosted pot is the same code as upstream mupot, so updating is a git operation —
but pre-1.0, **minor versions may break**, so treat an upgrade as a small runbook, not a
blind pull:

```bash
# 0. one-time: track upstream alongside your fork
git remote add upstream https://github.com/Mumega-com/mupot

# 1. read what you're taking BEFORE you take it
git fetch upstream
git log --oneline HEAD..upstream/main   # the commits
#    → open CHANGELOG.md on upstream/main: breaking notes live under the version heading

# 2. merge upstream into your fork's main (rebase if you carry no local commits)
git merge upstream/main                 # resolve conflicts in YOUR files only —
                                        # wrangler.<pot>.toml and your packs are yours;
                                        # src/ conflicts mean you forked core: prefer
                                        # upstream and re-apply your change on top

# 3. verify locally before anything touches your account
npm install && npm run typecheck && npm test

# 4. apply migrations, then deploy (this order — new code may read new columns)
npx wrangler d1 migrations apply mupot-acme --remote --config wrangler.acme.toml
npx wrangler deploy --config wrangler.acme.toml

# 5. smoke: /health, log in, open /fleet — then check `wrangler tail` for a minute
```

Migrations are additive and ordered; applying them is idempotent (already-applied
migrations are skipped), and they are designed to be safe to apply *before* the matching
deploy. Never edit a shipped migration — add a new one.

**Security fixes:** upstream security patches land as ordinary commits on `main` and are
called out in the CHANGELOG's `### Security` blocks. If you run a pot that faces real
users, watch upstream releases (GitHub → Watch → Releases) and take security updates on
sight — the steps above, same order, no skipping step 3.

**The fork contract that keeps upgrades cheap:** keep your changes in the places designed
for them — `wrangler.<pot>.toml` (config), Worker secrets, your own packs/connectors, and
new files. The further you fork `src/`, the more step 2 costs you. If you need a change
in core, PR it upstream instead — that is what keeps every pot on the same substrate.

## What you get

A governed loop runtime on your own infra: declare loops (`POST /api/loops`), the cron
drives them within a hard dollar cap, every customer-facing act waits at a human gate
(`/approvals`), and everything is audited — on data that never leaves your account.
