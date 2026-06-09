#!/usr/bin/env bash
# provision-pot.sh — stand up a sovereign mupot pot on YOUR OWN Cloudflare account.
#
# This is the self-host path (#37): the tenant owns the data and runs the pot on their
# own account — the one thing the hyperscalers structurally cannot offer. It creates the
# Cloudflare resources a pot needs, then prints the exact follow-up steps.
#
# Prereqs: `npx wrangler login` (or CLOUDFLARE_API_TOKEN) on the target account.
# Usage:   scripts/provision-pot.sh <pot-slug>
set -euo pipefail

POT="${1:?usage: scripts/provision-pot.sh <pot-slug>   (e.g. acme)}"
VEC_DIMS="${VEC_DIMS:-768}" # match your Workers AI embedding model (bge-base-en = 768)

echo "── Provisioning sovereign mupot pot: ${POT} ─────────────────────────────────"
echo "Each command prints an ID — paste it into wrangler.${POT}.toml (step A below)."
echo

echo "→ D1 database (DB binding)…"
npx wrangler d1 create "mupot-${POT}" || true

echo "→ Vectorize index (VEC binding)…"
npx wrangler vectorize create "mupot-${POT}-vec" --dimensions="${VEC_DIMS}" --metric=cosine || true

echo "→ Queues (BUS producer/consumer + DLQ)…"
npx wrangler queues create "mupot-${POT}-events" || true
npx wrangler queues create "mupot-${POT}-events-dlq" || true

echo "→ KV namespace (SESSIONS binding)…"
npx wrangler kv namespace create "mupot-${POT}-sessions" || true

echo "→ R2 bucket (BLOBS binding)…"
npx wrangler r2 bucket create "mupot-${POT}-blobs" || true

cat <<EOF

── Resources created. Finish the pot: ───────────────────────────────────────────
A. cp wrangler.toml wrangler.${POT}.toml
   - set name = "mupot-${POT}"
   - paste the IDs printed above (d1 database_id, vectorize name, kv id, r2 bucket,
     queue names: mupot-${POT}-events / -events-dlq, workflow name mupot-${POT}-task-workflow)
   - [vars]: TENANT_SLUG = "${POT}" (+ BRAND, Google OAuth client id, etc.)

B. Secrets (never in the toml):
   npx wrangler secret put OAUTH_CLIENT_SECRET   --config wrangler.${POT}.toml
   # optional, per integration the pot's loops use:
   npx wrangler secret put GHL_API_KEY           --config wrangler.${POT}.toml
   npx wrangler secret put GHL_LOCATION_ID       --config wrangler.${POT}.toml
   npx wrangler secret put GHL_WEBHOOK_SECRET    --config wrangler.${POT}.toml
   # to let a loop authenticate to a BYO MCP server (namespaced + host-pinned):
   npx wrangler secret put LOOP_SECRET_<name>    --config wrangler.${POT}.toml
   #   and set LOOP_SECRET_<name>_HOST = <the host it may travel to> in [vars]

C. Apply migrations + deploy:
   npx wrangler d1 migrations apply mupot-${POT} --remote --config wrangler.${POT}.toml
   npx wrangler deploy --config wrangler.${POT}.toml

The pot is now yours — your account, your data, your CF bill. It stays compatible with
upstream mupot: pull, re-apply migrations, re-deploy.
EOF
