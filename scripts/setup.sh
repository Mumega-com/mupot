#!/usr/bin/env bash
# mupot — one-shot resource provisioner for YOUR Cloudflare account.
#
# What it does (idempotent): creates the Cloudflare resources this app needs on the
# account you are logged into with wrangler, creates wrangler.toml from
# wrangler.example.toml when needed, writes the generated ids back into
# wrangler.toml (replacing the <YOUR_*> placeholders), then applies the D1
# migrations. Re-running is safe: already-created resources are detected and
# skipped, and ids already filled in are left untouched.
#
# It provisions, in order:
#   - D1 database         "mupot"            (relational org + engram metadata)
#   - Vectorize index     "mupot-memory"     (768 dims, cosine — semantic recall)
#   - Queue               "mupot-events"     (async events / leads)
#   - Queue               "mupot-events-dlq" (dead-letter)
#   - KV namespace        SESSIONS           (sessions / config cache)
#   - KV namespace        OAUTH_KV           (OAuth provider state)
#   - R2 bucket           "mupot-blobs"      (blobs)
#
# Substrate only. This script never touches any tenant business content; it just
# stands up the empty pot. No secrets are read or written here — see secrets.sh.
#
# Usage:
#   wrangler login          # once, to authenticate to YOUR account
#   bash scripts/setup.sh
#
# Safe to re-run any number of times.

set -euo pipefail

# ── locate the repo root (this script lives in scripts/) ──────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
WRANGLER_TOML="${ROOT_DIR}/wrangler.toml"
WRANGLER_EXAMPLE_TOML="${ROOT_DIR}/wrangler.example.toml"

# ── resource names (must match wrangler.toml + src/types.ts Env) ──────────────
D1_NAME="mupot"
VEC_NAME="mupot-memory"
VEC_DIMS="768"
VEC_METRIC="cosine"
QUEUE_NAME="mupot-events"
QUEUE_DLQ_NAME="mupot-events-dlq"
KV_BINDING="SESSIONS"
OAUTH_KV_BINDING="OAUTH_KV"
R2_NAME="mupot-blobs"

# wrangler invocation — prefer a repo-local install, fall back to npx.
WRANGLER=(npx --no-install wrangler)
if ! npx --no-install wrangler --version >/dev/null 2>&1; then
  WRANGLER=(npx wrangler)
fi

# ── pretty output ─────────────────────────────────────────────────────────────
say()  { printf '\033[1;36m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
skip() { printf '\033[1;33m∼\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

if [ ! -f "${WRANGLER_TOML}" ]; then
  [ -f "${WRANGLER_EXAMPLE_TOML}" ] || die "wrangler.example.toml not found at ${WRANGLER_EXAMPLE_TOML} — run from a mupot checkout."
  cp "${WRANGLER_EXAMPLE_TOML}" "${WRANGLER_TOML}"
  ok "Created wrangler.toml from wrangler.example.toml."
fi

# ── preflight: wrangler present + authenticated ───────────────────────────────
say "Checking wrangler is installed and authenticated…"
"${WRANGLER[@]}" --version >/dev/null 2>&1 || die "wrangler not available. Run: npm install"
if ! "${WRANGLER[@]}" whoami >/dev/null 2>&1; then
  die "Not logged in to Cloudflare. Run: wrangler login"
fi
ok "wrangler authenticated."

# ── helpers ───────────────────────────────────────────────────────────────────

# Replace the first occurrence of a placeholder token in wrangler.toml with a
# real id. Uses an exact literal match so it only ever fires on the placeholder,
# never on an already-filled value. Writes atomically via a temp file.
#
#   replace_placeholder PLACEHOLDER VALUE
replace_placeholder() {
  local placeholder="$1" value="$2"
  local tmp
  tmp="$(mktemp)"
  # Process line by line; only the line that still holds the literal placeholder
  # is rewritten. Plain string compare — no regex, so ids with slashes are safe.
  local replaced=0
  while IFS= read -r line || [ -n "$line" ]; do
    if [ "$replaced" -eq 0 ] && [[ "$line" == *"$placeholder"* ]]; then
      line="${line//$placeholder/$value}"
      replaced=1
    fi
    printf '%s\n' "$line" >> "$tmp"
  done < "${WRANGLER_TOML}"
  mv "$tmp" "${WRANGLER_TOML}"
}

# True if wrangler.toml still contains the given placeholder token.
has_placeholder() {
  grep -Fq "$1" "${WRANGLER_TOML}"
}

has_any_placeholder() {
  local placeholder
  for placeholder in "$@"; do
    if has_placeholder "$placeholder"; then
      return 0
    fi
  done
  return 1
}

replace_any_placeholder() {
  local value="$1"
  shift
  local placeholder replaced=0
  for placeholder in "$@"; do
    if has_placeholder "$placeholder"; then
      replace_placeholder "$placeholder" "$value"
      replaced=1
    fi
  done
  [ "$replaced" -eq 1 ]
}

# ── D1 ────────────────────────────────────────────────────────────────────────
provision_d1() {
  if ! has_any_placeholder "REPLACE_WITH_YOUR_D1_ID" "<YOUR_D1_DATABASE_ID>"; then
    skip "D1 id already set in wrangler.toml — skipping create."
    return
  fi
  say "Creating D1 database \"${D1_NAME}\"…"
  local out
  # If the DB already exists wrangler errors; capture both streams and recover
  # the id from a follow-up `d1 info` so a half-finished run is re-runnable.
  if ! out="$("${WRANGLER[@]}" d1 create "${D1_NAME}" 2>&1)"; then
    if printf '%s' "$out" | grep -qi "already exists"; then
      skip "D1 \"${D1_NAME}\" already exists — looking up its id."
      out="$("${WRANGLER[@]}" d1 info "${D1_NAME}" 2>&1)" || die "d1 info failed:\n${out}"
    else
      die "d1 create failed:\n${out}"
    fi
  fi
  # Parse the uuid: from `database_id = "…"` (create) or a `uuid │ …` row (info).
  local id
  id="$(printf '%s\n' "$out" \
    | grep -Eo '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' \
    | head -n1 || true)"
  [ -n "$id" ] || die "Could not parse D1 id from wrangler output:\n${out}"
  replace_any_placeholder "$id" "REPLACE_WITH_YOUR_D1_ID" "<YOUR_D1_DATABASE_ID>" || die "Could not replace D1 id placeholder in wrangler.toml."
  ok "D1 \"${D1_NAME}\" → ${id} (written to wrangler.toml)."
}

# ── Vectorize ─────────────────────────────────────────────────────────────────
# Referenced by index_name in wrangler.toml — no id to write back. Idempotent:
# create, and treat "already exists" as success.
provision_vectorize() {
  say "Creating Vectorize index \"${VEC_NAME}\" (${VEC_DIMS} dims, ${VEC_METRIC})…"
  local out
  if out="$("${WRANGLER[@]}" vectorize create "${VEC_NAME}" \
        --dimensions="${VEC_DIMS}" --metric="${VEC_METRIC}" 2>&1)"; then
    ok "Vectorize \"${VEC_NAME}\" created."
  elif printf '%s' "$out" | grep -qi "already exists"; then
    skip "Vectorize \"${VEC_NAME}\" already exists."
  else
    die "vectorize create failed:\n${out}"
  fi
}

# ── Queues ────────────────────────────────────────────────────────────────────
# Referenced by name; create both the main queue and its dead-letter queue.
provision_queue() {
  local name="$1"
  say "Creating Queue \"${name}\"…"
  local out
  if out="$("${WRANGLER[@]}" queues create "${name}" 2>&1)"; then
    ok "Queue \"${name}\" created."
  elif printf '%s' "$out" | grep -qiE "already exists|already created"; then
    skip "Queue \"${name}\" already exists."
  else
    die "queues create failed:\n${out}"
  fi
}

# ── KV ────────────────────────────────────────────────────────────────────────
provision_kv() {
  local binding="$1"
  shift
  if ! has_any_placeholder "$@"; then
    skip "KV id for ${binding} already set in wrangler.toml — skipping create."
    return
  fi
  say "Creating KV namespace \"${binding}\"…"
  local out
  if ! out="$("${WRANGLER[@]}" kv namespace create "${binding}" 2>&1)"; then
    if printf '%s' "$out" | grep -qi "already exists"; then
      skip "KV namespace \"${binding}\" already exists — looking up its id."
      out="$("${WRANGLER[@]}" kv namespace list 2>&1)" || die "kv namespace list failed:\n${out}"
      # list is JSON: find the entry whose title ends in the binding name.
      local id
      id="$(printf '%s' "$out" | tr ',{}' '\n\n\n' \
        | grep -A1 -i "\"title\".*${binding}" | grep '"id"' \
        | grep -Eo '[0-9a-f]{32}' | head -n1 || true)"
      [ -n "$id" ] || die "Could not find existing KV id for ${binding} in:\n${out}"
      replace_any_placeholder "$id" "$@" || die "Could not replace KV id placeholder for ${binding} in wrangler.toml."
      ok "KV \"${binding}\" → ${id} (written to wrangler.toml)."
      return
    fi
    die "kv namespace create failed:\n${out}"
  fi
  # Fresh create: id is a 32-hex string, printed as id = "…" or "id": "…".
  local id
  id="$(printf '%s\n' "$out" | grep -Eo '[0-9a-f]{32}' | head -n1 || true)"
  [ -n "$id" ] || die "Could not parse KV id from wrangler output:\n${out}"
  replace_any_placeholder "$id" "$@" || die "Could not replace KV id placeholder for ${binding} in wrangler.toml."
  ok "KV \"${binding}\" → ${id} (written to wrangler.toml)."
}

# ── R2 ────────────────────────────────────────────────────────────────────────
# Referenced by bucket_name; create, treat already-exists as success.
provision_r2() {
  say "Creating R2 bucket \"${R2_NAME}\"…"
  local out
  if out="$("${WRANGLER[@]}" r2 bucket create "${R2_NAME}" 2>&1)"; then
    ok "R2 bucket \"${R2_NAME}\" created."
  elif printf '%s' "$out" | grep -qiE "already exists|already owned"; then
    skip "R2 bucket \"${R2_NAME}\" already exists."
  else
    die "r2 bucket create failed:\n${out}"
  fi
}

# ── migrations ────────────────────────────────────────────────────────────────
apply_migrations() {
  if has_any_placeholder "REPLACE_WITH_YOUR_D1_ID" "<YOUR_D1_DATABASE_ID>"; then
    die "D1 id is still a placeholder — cannot apply migrations. (Provisioning failed above.)"
  fi
  say "Applying D1 migrations to the remote database…"
  # migrations apply is itself idempotent (tracks applied migrations in D1).
  "${WRANGLER[@]}" d1 migrations apply "${D1_NAME}" --remote
  ok "Migrations applied."
}

# ── run ───────────────────────────────────────────────────────────────────────
say "Provisioning mupot resources on your Cloudflare account…"
provision_d1
provision_vectorize
provision_queue "${QUEUE_NAME}"
provision_queue "${QUEUE_DLQ_NAME}"
provision_kv "${KV_BINDING}" "REPLACE_WITH_YOUR_KV_ID" "<YOUR_SESSIONS_KV_ID>"
provision_kv "${OAUTH_KV_BINDING}" "<YOUR_OAUTH_KV_ID>"
provision_r2
apply_migrations

printf '\n'
ok "Setup complete."
printf '\n'
say "Next steps:"
printf '   1. Set your secrets:   bash scripts/secrets.sh\n'
printf '   2. Set TENANT_SLUG + BRAND in wrangler.toml [vars]\n'
printf '   3. Deploy:             npm run deploy\n'
printf '   4. Open your deployment and log in — the first login becomes owner.\n'
