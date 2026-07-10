# Deploy mupot to your Cloudflare account

These two scripts replace most hand-editing of `wrangler.toml`. After forking,
you run them once and you have a live pot on **your** Cloudflare account. The
setup script creates `wrangler.toml` from `wrangler.example.toml` when needed,
fills the Cloudflare resource ids it can discover, and leaves tenant-specific
vars for you to review. Substrate only: nothing here touches business content.

## Prerequisites

- Node 18+ and the repo dependencies installed: `npm install`
- A Cloudflare account, authenticated once: `wrangler login`
- Either an OAuth app (Google or Telegram) for dashboard login, or the one-time
  bootstrap-owner ceremony for the first local owner. OAuth uses the callback URI
  `https://<your-deployment>/auth/callback`.

## Local browser workflow smoke

Use this before merging production-sensitive dashboard, task, auth, Hermes, or
runtime changes. It runs against the local test Wrangler config and produces
release evidence in `tmp/local-smoke`.

```bash
npm run migrate:local:test
npm run seed:local:test
npm run dev:local:test

# in another shell, after Wrangler prints the local URL:
npm run smoke:local
```

The harness uses `/auth/dev-login`, which is enabled only when
`LOCAL_TEST_AUTH=1` in `wrangler-local-test.toml`. It verifies:

- local owner login and unauthenticated dashboard redirect behavior
- the authenticated dashboard route crawl, including the `/ops` health console
- `/send` validation, task creation, `done_when`, lifecycle completion, and
  visible result rendering
- `/approvals` rejection validation and real verdict approval
- Hermes `/im/webhook` help/status/task flows with `IM_WEBHOOK_SECRET`
- dashboard refresh after a Hermes-created task

Artifacts:

- `tmp/local-smoke/report.json`
- `tmp/local-smoke/home.png`
- `tmp/local-smoke/fleet.png`
- `tmp/local-smoke/ops-health.png`
- `tmp/local-smoke/send-workflow.png`
- `tmp/local-smoke/approvals-workflow.png`
- `tmp/local-smoke/hermes-dashboard-update.png`
- `tmp/local-smoke/failure-*.json` when a workflow fails
- `tmp/local-smoke/failure-*.png` when a workflow fails

`npm run smoke:local` writes `report.json` and prints the same JSON report to
stdout. The report contains the page crawl, workflow results, Hermes checks,
runtime contract name, artifact directory, and report path.

## Local runtime adapter conformance

Use this with the same local Wrangler server when changing signed runtime,
inbox, or detach behavior:

```bash
npm run migrate:local:test
npm run seed:local:test
npm run dev:local:test

# in another shell, after Wrangler prints the local URL:
npm run conformance:runtime:local
```

The local seed creates a non-production `agent-conformance` key and a welded
sender token. The harness proves `runtime-adapter/v1` over HTTP: signed attach,
replay refusal, bearer send to the runtime inbox, signed inbox peek/consume,
consume-once behavior, fleet control request signing/delivery, and signed detach.
It writes `tmp/local-runtime-conformance/report.json` and prints the same JSON
report to stdout. Failures write `tmp/local-runtime-conformance/failure-*.json`
when the process can create artifacts.

## CI local evidence

GitHub Actions runs the same local evidence gate with:

```bash
bash scripts/ci-local-evidence.sh
```

The script applies local D1 migrations, seeds the local fixtures, starts
`wrangler dev` with `wrangler-local-test.toml`, waits for `/health`, runs
`npm run smoke:local`, and then runs `npm run conformance:runtime:local`.
Actions uploads `tmp/local-evidence`, `tmp/local-smoke`, and
`tmp/local-runtime-conformance` as the `local-evidence` artifact.

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

# 5. Set dashboard OAuth secrets (read silently — never echoed, never written to disk/git).
bash scripts/secrets.sh

# 6. Re-deploy to pick the secrets up, then open your deployment and log in.
npm run deploy
```

Open your deployment and log in. **The first person to log in becomes `owner`**;
from there the in-app setup wizard walks you through seeding your org
(departments → squads → agents). You're live.

> Tip: if `secret put` complains the Worker doesn't exist yet, run `npm run deploy`
> once first (step 4), then `bash scripts/secrets.sh`. Re-deploy afterward. For
> an OAuth-free first owner, replace step 5 with `bash scripts/secrets.sh --bootstrap-owner`,
> re-deploy, open `/auth/bootstrap`, and delete the bootstrap secret after claiming the owner session.

For an additional isolated pot in the same checkout, use a slug instead of
copying resource identifiers by hand:

```bash
bash scripts/setup.sh --pot acme
npx wrangler deploy --config wrangler.acme.toml
bash scripts/secrets.sh --pot acme
npx wrangler deploy --config wrangler.acme.toml
```

For an OAuth-free first owner on a new self-hosted pot, deploy once and run:

```bash
bash scripts/secrets.sh --pot acme --bootstrap-owner
npx wrangler deploy --config wrangler.acme.toml
```

Open `<your-pot-url>/auth/bootstrap`, submit the printed token and the owner's
email, then delete `BOOTSTRAP_OWNER_TOKEN` with Wrangler. Until deletion, only the
claimed owner may use the secret to resume a session; the route is disabled when
dashboard OAuth is configured.

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
| KV        | `OAUTH_KV`           | id written back to `wrangler.toml` |
| R2        | `mupot-blobs`        | blobs                              |

Then it applies the D1 migrations remotely (`wrangler d1 migrations apply mupot
--remote`). Re-running after a partial failure picks up where it left off.

With `--pot acme`, the script instead provisions `mupot-acme` resources,
writes `wrangler.acme.toml`, and applies migrations through that config.

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
