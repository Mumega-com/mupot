# Deploy preflight — the half CI cannot see

CI gates the repo. It cannot gate a deploy, because the file that configures a deploy
is not in the repo.

The real per-pot wrangler configs — `wrangler.toml`, `wrangler.digid.toml`,
`wrangler.house.toml` and friends — are gitignored. They carry live account ids,
database ids, and tenant vars, so keeping them out of a public template is correct.
The cost is that **no PR reviews them and no test reads them.** They are the one input
to the running worker that passes through no gate at all.

This document exists because that gap cost us a production outage twice, eight days
apart, on the same defect.

## What happened (#699, then P0-0)

`@cloudflare/workers-oauth-provider` injects its helpers into `env.OAUTH_PROVIDER`,
but only into an empty slot:

```js
if (!env.OAUTH_PROVIDER) env.OAUTH_PROVIDER = this.createOAuthHelpers(env)
```

A `[vars]` entry of that name is truthy, so injection is skipped and every caller
receives the string instead of the helpers.

- **2026-08-05 (#699)** — `/auth/login` returned 500 for as long as the wrapper had
  been mounted. Fixed in code by renaming the config var to `IDP_PROVIDER`.
- **2026-08-13 (P0-0)** — `/authorize` returned 400 on *every* fresh OAuth
  registration, which also made the `/oauth/consent` agent-binding path unreachable.

The second one is the instructive one. The #699 fix was correct, merged, and had been
deployed for eight days. `merged` and `deployed` were both true, and the defect was
still live — because the fix never reached the deploy config.

Worse: `wrangler.example.toml`, the template every pot is forked from, never received
the rename at all. So digid, house, viamar, alpha and acctest each inherited a broken
OAuth door **at creation**. One poisoned template is N poisoned pots.

There is even a CI step — the workerd-composition suite — whose own comment says it is
"the suite that would have caught the /auth/login 500 (#699)". It executes `src/index.ts`
*with* the OAuthProvider wrapper that every other test bypasses. It did not catch P0-0
and could not have. We built a test specifically for this failure mode, and the config
channel walked straight past it.

## What CI now covers

`scripts/reserved-bindings.mjs` (CI job `reserved-bindings`) fails the build if a
**tracked** `wrangler*.toml` declares a binding name the runtime owns.

That closes the template — the vector — permanently. It does **not** cover the
gitignored per-pot configs, deliberately. A scan that reported clean over files git
cannot see would be a false green, which is worse than no check at all.

## The operator's half — run before any pot deploy

CI owns the template. You own the config on the deploy host.

```bash
# 1. No reserved binding names in the config you are about to deploy.
grep -nE '^[ \t]*OAUTH_PROVIDER[ \t]*=' wrangler.<pot>.toml && echo 'STOP — rename to IDP_PROVIDER'

# 2. Dry-run and read the binding table. This prints every var that will be live.
npx wrangler deploy --dry-run --outdir /tmp/preflight --config wrangler.<pot>.toml
```

Then read the printed bindings and confirm, specifically:

- `IDP_PROVIDER` present, `OAUTH_PROVIDER` absent
- `PUBLIC_ORIGIN` is a host that actually resolves — it is stamped into every minted
  token and link, so a wrong value produces credentials pointing at nothing. Found live
  on the viamar pot: `https://mupot-viamar.workers.dev`, which does not resolve, because
  workers.dev hosts are `<name>.<subdomain>.workers.dev`.
- `RELEASE_SHA` is supplied — it is set by the release deploy, not by the config, and a
  deploy that forgets it silently drops the build identifier.

## Auditing what is already live

Config on disk is not what is deployed. To read a running worker's actual vars:

```bash
curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/<name>/settings" \
  | jq '.result.bindings[] | select(.type=="plain_text") | {name, text}'
```

Do this after any deploy you did not personally run, and after adopting a pot someone
else created. It is the only way to see what the worker is actually holding.

## Fixing a live pot without shipping code

If a deployed worker carries a bad var but its code is fine, redeploy the **same commit**
with the corrected config rather than deploying `main`:

```bash
git worktree add /tmp/redeploy <deployed-sha>
cp wrangler.<pot>.toml /tmp/redeploy/wrangler.toml
cd /tmp/redeploy && npx wrangler deploy --var RELEASE_SHA:<deployed-sha>
```

This is what cleared P0-0 on the mumega pot. `main` was two commits ahead and carried an
unapplied migration; deploying it would have coupled a schema change to an auth fix
during an outage. Two changes in flight at once on the same surface means you cannot
tell which one broke what.

`wrangler deploy` replaces vars from the config but **does not touch secrets** — verified
on the P0-0 fix, 32 secrets before and after. Confirm it anyway with
`npx wrangler secret list`; a preflight belief you never checked is not a receipt.

## The rule

A fix that lands in code but not in deploy config is not a fix. Config is outside the
gate, so it needs its own pass — and the pass has to be a receipt, not a memory.
