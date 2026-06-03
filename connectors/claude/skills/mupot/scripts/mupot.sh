#!/usr/bin/env bash
# mupot.sh — thin client for the mupot MCP seam, used by the /mupot skill.
#
# Usage:
#   mupot.sh <tool> [--key value]...
#
# Examples:
#   mupot.sh status
#   mupot.sh status --agent_id "$AGENT_ID"
#   mupot.sh task_create --squad_id "$SQUAD_ID" --title "Ship it" --body "details"
#   mupot.sh recall --query "pricing" --limit 5
#   mupot.sh remember --text "Decided: launch at \$49/mo"
#
# Env (required):
#   MUPOT_URL           your pot base URL, e.g. https://mupot.your-org.workers.dev
#   MUPOT_MEMBER_TOKEN  the raw member token (channel: workspace)
#
# The token is sent ONLY in the Authorization header. It is never printed.
# Identity is derived server-side by the pot from the token — this script passes
# NO identity field, ever.

set -euo pipefail

err() { printf 'mupot: %s\n' "$1" >&2; exit 1; }

[ -n "${MUPOT_URL:-}" ]          || err "MUPOT_URL is not set"
[ -n "${MUPOT_MEMBER_TOKEN:-}" ] || err "MUPOT_MEMBER_TOKEN is not set"
command -v curl >/dev/null 2>&1  || err "curl is required"
command -v jq   >/dev/null 2>&1  || err "jq is required"

[ "$#" -ge 1 ] || err "usage: mupot.sh <tool> [--key value]..."

tool="$1"; shift

# Build the args object from --key value pairs. --limit is coerced to a number;
# everything else is a string. No key is an identity field — the pot ignores any
# such field anyway and derives the actor from the bearer token.
args='{}'
while [ "$#" -gt 0 ]; do
  case "$1" in
    --*)
      key="${1#--}"
      [ "$#" -ge 2 ] || err "missing value for --$key"
      val="$2"
      shift 2
      if [ "$key" = "limit" ] || [ "$key" = "maxActions" ]; then
        args="$(printf '%s' "$args" | jq --arg k "$key" --argjson v "$val" '.[$k] = $v')"
      else
        args="$(printf '%s' "$args" | jq --arg k "$key" --arg v "$val" '.[$k] = $v')"
      fi
      ;;
    *)
      err "unexpected argument: $1 (use --key value)"
      ;;
  esac
done

payload="$(jq -n --arg tool "$tool" --argjson args "$args" '{tool: $tool, args: $args}')"

# -sS: quiet but show errors. We print the HTTP body (JSON) and exit non-zero on
# a non-2xx status so the skill can surface 401/403/404 plainly.
http_code="$(
  curl -sS -o /tmp/mupot_resp.$$ -w '%{http_code}' \
    -X POST "${MUPOT_URL%/}/mcp" \
    -H "Authorization: Bearer ${MUPOT_MEMBER_TOKEN}" \
    -H 'Content-Type: application/json' \
    --data "$payload"
)"

cat /tmp/mupot_resp.$$
rm -f /tmp/mupot_resp.$$

case "$http_code" in
  2*) exit 0 ;;
  *)  printf '\nmupot: HTTP %s\n' "$http_code" >&2; exit 1 ;;
esac
