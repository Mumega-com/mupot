#!/usr/bin/env bash
# mupot — secret setter for YOUR Cloudflare account.
#
# Prompts for each secret and pipes it to `wrangler secret put`. Values are read
# silently (read -r -s): nothing is echoed to the terminal, nothing is written to
# any file, nothing is committed. The bootstrap-owner mode deliberately prints a
# generated one-time token so the operator can enter it in the local pot. The
# secret only ever travels stdin → wrangler → Cloudflare; wrangler.toml and git
# stay clean (this is a PUBLIC template repo).
#
# Secrets (see src/types.ts Env):
#   OAUTH_CLIENT_ID      (required) — your OAuth app client id     [Google/Telegram]
#   OAUTH_CLIENT_SECRET  (required) — your OAuth app client secret
#   GITHUB_TOKEN         (optional) — for mirroring tasks to GitHub Issues
#   AI_GATEWAY_TOKEN     (optional) — for routing models via Cloudflare AI Gateway
#   BOOTSTRAP_OWNER_TOKEN (one-time) — bootstrap the first dashboard owner without OAuth
#
# Usage:
#   wrangler login         # once
#   bash scripts/secrets.sh
#   bash scripts/secrets.sh --pot acme
#   bash scripts/secrets.sh --pot acme --bootstrap-owner
#
# Re-runnable: setting a secret again simply overwrites it.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
POT=""
BOOTSTRAP_OWNER=0

usage() {
  cat <<'EOF'
Usage: bash scripts/secrets.sh [--pot <slug>] [--bootstrap-owner]

Without --pot, targets wrangler.toml. With --pot, targets wrangler.<slug>.toml.
--bootstrap-owner skips dashboard OAuth and generates a one-time first-owner token.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --pot)
      [ "$#" -ge 2 ] || { usage >&2; exit 1; }
      POT="$2"
      shift 2
      ;;
    --bootstrap-owner)
      BOOTSTRAP_OWNER=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 1
      ;;
  esac
done

if [ -n "${POT}" ] && ! [[ "${POT}" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]]; then
  printf 'Invalid pot slug %q; use lowercase letters, digits, and hyphens.\n' "${POT}" >&2
  exit 1
fi

if [ -n "${POT}" ]; then
  WRANGLER_TOML="${ROOT_DIR}/wrangler.${POT}.toml"
else
  WRANGLER_TOML="${ROOT_DIR}/wrangler.toml"
fi

WRANGLER=(npx --no-install wrangler)
if ! npx --no-install wrangler --version >/dev/null 2>&1; then
  WRANGLER=(npx wrangler)
fi

say()  { printf '\033[1;36m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
skip() { printf '\033[1;33m∼\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

cd "${ROOT_DIR}"
[ -f "${WRANGLER_TOML}" ] || die "Missing $(basename "${WRANGLER_TOML}"). Run setup first."

# ── preflight ─────────────────────────────────────────────────────────────────
"${WRANGLER[@]}" --version >/dev/null 2>&1 || die "wrangler not available. Run: npm install"
if ! "${WRANGLER[@]}" whoami >/dev/null 2>&1; then
  die "Not logged in to Cloudflare. Run: wrangler login"
fi

# put_secret NAME REQUIRED
#   Prompts (silently) for NAME and pipes it to `wrangler secret put NAME`.
#   REQUIRED=required → empty input re-prompts. REQUIRED=optional → empty skips.
#   The value lives only in a local shell variable, never echoed, never written to
#   disk, and is unset immediately after use.
put_secret() {
  local name="$1" required="$2"
  local value=""

  while true; do
    if [ "$required" = "optional" ]; then
      printf 'Enter %s (optional — press Enter to skip): ' "$name"
    else
      printf 'Enter %s (required): ' "$name"
    fi
    # -s: silent (no echo); -r: raw (no backslash mangling). Read one line.
    IFS= read -r -s value || value=""
    printf '\n'  # the silent read leaves no newline; add one

    if [ -z "$value" ]; then
      if [ "$required" = "optional" ]; then
        skip "${name} skipped."
        unset value
        return 0
      fi
      printf '  (a value is required — try again)\n'
      continue
    fi
    break
  done

  say "Setting ${name}…"
  # Pipe via stdin so the value never appears in argv / process list / history.
  if printf '%s' "$value" | "${WRANGLER[@]}" secret put "$name" --config "${WRANGLER_TOML}" >/dev/null 2>&1; then
    ok "${name} set."
  else
    unset value
    die "Failed to set ${name}. Are you logged in and is the Worker deployed once? (wrangler deploy)"
  fi
  unset value
}

put_secret_value() {
  local name="$1" value="$2"
  say "Setting ${name}…"
  if printf '%s' "$value" | "${WRANGLER[@]}" secret put "$name" --config "${WRANGLER_TOML}" >/dev/null 2>&1; then
    ok "${name} set."
  else
    die "Failed to set ${name}. Are you logged in and is the Worker deployed once? (wrangler deploy)"
  fi
}

say "Setting mupot secrets for $(basename "${WRANGLER_TOML}")."
printf 'Values are read silently and never written to disk or git.\n\n'

if [ "${BOOTSTRAP_OWNER}" -eq 1 ]; then
  BOOTSTRAP_TOKEN="$(node -e "const { randomBytes } = require('node:crypto'); process.stdout.write(randomBytes(32).toString('base64url'))")" \
    || die "Could not generate BOOTSTRAP_OWNER_TOKEN; Node.js is required."
  printf 'One-time owner bootstrap token (record it now; it is not stored in this checkout):\n%s\n\n' "${BOOTSTRAP_TOKEN}"
  put_secret_value BOOTSTRAP_OWNER_TOKEN "${BOOTSTRAP_TOKEN}"
  unset BOOTSTRAP_TOKEN
else
  put_secret OAUTH_CLIENT_ID     required
  put_secret OAUTH_CLIENT_SECRET required
fi

put_secret GITHUB_TOKEN        optional
put_secret AI_GATEWAY_TOKEN    optional

printf '\n'
ok "Secrets configured."
say "Deploy (or re-deploy) to pick them up:  npx wrangler deploy --config \"${WRANGLER_TOML}\""
if [ "${BOOTSTRAP_OWNER}" -eq 1 ]; then
  say "After deploy, open <your-pot-url>/auth/bootstrap and submit your email with the printed token."
  say "After the owner session is created, remove the bootstrap secret:  npx wrangler secret delete BOOTSTRAP_OWNER_TOKEN --config \"${WRANGLER_TOML}\""
fi
