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
| `SESSIONS` | KV | dashboard sessions, OAuth request nonce/state, lightweight cache |
| `OAUTH_KV` | KV | OAuth 2.1 provider clients, grants, and access-token state |
| `BLOBS` | R2 | blobs/files |
| `AI` | Workers AI | default model |
| `AGENT`, `SQUAD` | Durable Objects | per-unit state + alarms |
| `TASK_WORKFLOW` | Workflows | durable task pipeline |

DO, Workflows, and AI are code-defined (declared in the toml); the rest are created once
per pot.

## Provision

```bash
npx wrangler login                 # on the TARGET account
scripts/provision-pot.sh acme      # creates resources, writes wrangler.acme.toml, applies migrations
```

The script writes tenant-scoped resource names and bindings into
`wrangler.acme.toml`; no resource ID copying is required. Deploy once, then choose
one dashboard owner setup method against that exact config.

```bash
npx wrangler deploy --config wrangler.acme.toml

# Option A: Google dashboard login
bash scripts/secrets.sh --pot acme
npx wrangler deploy --config wrangler.acme.toml

# Option B: no OAuth provider for the first owner
bash scripts/secrets.sh --pot acme --bootstrap-owner
npx wrangler deploy --config wrangler.acme.toml
# Open https://<your-pot-url>/auth/bootstrap and enter your email plus the printed token.
npx wrangler secret delete BOOTSTRAP_OWNER_TOKEN --config wrangler.acme.toml
```

The bootstrap route is intentionally available only while dashboard OAuth is
unconfigured. Its D1-backed singleton claim allows one owner session only; deleting
the secret after use removes the remaining deployment credential.

## Secrets

Secrets are Worker secrets (`wrangler secret put`), never in the toml.
- `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` — dashboard login.
- `BOOTSTRAP_OWNER_TOKEN` — generated only by `secrets.sh --bootstrap-owner` for a
  one-time first owner when dashboard OAuth is intentionally absent. Remove it after use.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — optional MCP OAuth 2.1
  provider credentials when exposing the Google-backed OAuth flow.
- Per-integration (optional): `GHL_API_KEY` / `GHL_LOCATION_ID` / `GHL_WEBHOOK_SECRET`.
- **BYO MCP credentials** for a loop: `LOOP_SECRET_<name>` (the token) + a
  `LOOP_SECRET_<name>_HOST` var (the only host it may travel to). See
  [loop-manifest-contract.md](./loop-manifest-contract.md). Platform secrets are outside
  this namespace and are unreachable from a tenant manifest.

## Staying in sync with upstream

A self-hosted pot is the same code as upstream mupot. For production upgrades,
backups, rollback, restore, and incident response, use the
[production self-hosting runbook](./production-runbook.md). The short happy path
is:

```bash
git pull
node scripts/mupot-update.mjs acme          # dry-run if the pot is in pots.manifest.json
npx wrangler d1 migrations apply mupot-acme --remote --config wrangler.acme.toml
npx wrangler deploy --config wrangler.acme.toml
```

Migrations are additive and ordered; applying them is idempotent (already-applied
migrations are skipped).

## What you get

A governed loop runtime on your own infra: declare loops (`POST /api/loops`), the cron
drives them within a hard dollar cap, every customer-facing act waits at a human gate
(`/approvals`), and everything is audited — on data that never leaves your account.
