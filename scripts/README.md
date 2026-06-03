# Deploy mupot to your Cloudflare account

These two scripts replace hand-editing `wrangler.toml`. After forking, you run
them once and you have a live pot on **your** Cloudflare account — no bespoke
surgery. Substrate only: nothing here touches business content.

## Prerequisites

- Node 18+ and the repo dependencies installed: `npm install`
- A Cloudflare account, authenticated once: `wrangler login`
- An OAuth app (Google or Telegram) for login — you'll need its client id +
  secret. Set the redirect/callback URI to `https://<your-deployment>/auth/callback`.

## One-time deploy (fork → deploy → log in)

```bash
# 1. Use this template on GitHub → your own fork, then clone it.
npm install
wrangler login                 # authenticate to YOUR Cloudflare account

# 2. Provision the resources (D1, Vectorize, Queues, KV, R2) + run migrations.
#    Idempotent — safe to re-run; ids are written back into wrangler.toml.
bash scripts/setup.sh

# 3. Set TENANT_SLUG + BRAND (+ OAUTH_PROVIDER) in wrangler.toml [vars].

# 4. First deploy (creates the Worker so secrets can attach to it).
npm run deploy

# 5. Set your secrets (read silently — never echoed, never written to disk/git).
bash scripts/secrets.sh

# 6. Re-deploy to pick the secrets up, then open your deployment and log in.
npm run deploy
```

Open your deployment and log in. **The first person to log in becomes `owner`**;
from there the in-app setup wizard walks you through seeding your org
(departments → squads → agents). You're live.

> Tip: if `secret put` complains the Worker doesn't exist yet, run `npm run deploy`
> once first (step 4), then `bash scripts/secrets.sh`. Re-deploy afterward.

## What `setup.sh` does

Idempotent provisioner — detects already-created resources and skips them, and
leaves any id already present in `wrangler.toml` untouched. It creates:

| Resource  | Name / binding       | Notes                              |
| --------- | -------------------- | ---------------------------------- |
| D1        | `mupot`              | id written back to `wrangler.toml` |
| Vectorize | `mupot-memory`       | 768 dims, cosine                   |
| Queue     | `mupot-events`       | events / leads                     |
| Queue     | `mupot-events-dlq`   | dead-letter                        |
| KV        | `SESSIONS`           | id written back to `wrangler.toml` |
| R2        | `mupot-blobs`        | blobs                              |

Then it applies the D1 migrations remotely (`wrangler d1 migrations apply mupot
--remote`). Re-running after a partial failure picks up where it left off.

## What `secrets.sh` does

Prompts for each secret and pipes it straight to `wrangler secret put`. Values
are read silently (`read -r -s`) and the value lives only in a transient shell
variable — never echoed, never written to any file, never committed.

| Secret                | Required | For                                    |
| --------------------- | -------- | -------------------------------------- |
| `OAUTH_CLIENT_ID`     | yes      | login                                  |
| `OAUTH_CLIENT_SECRET` | yes      | login                                  |
| `GITHUB_TOKEN`        | no       | mirroring tasks to GitHub Issues       |
| `AI_GATEWAY_TOKEN`    | no       | routing models via Cloudflare AI Gateway |

Re-runnable — setting a secret again overwrites it.

## Security

- **No secret ever lands in `wrangler.toml` or git.** Only Cloudflare resource
  ids (not sensitive) are written back into `wrangler.toml`.
- Secrets are entered interactively, piped over stdin, and never appear in your
  shell history or the process list.
- `.gitignore` already excludes `.dev.vars`, `.env`, and `*.token`. Keep it that
  way — this is a public template.
- Your CF keys, your OAuth app, your GitHub token. You hold every key; you can
  revoke at any time.
