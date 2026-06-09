#!/usr/bin/env bash
# heartbeat.sh — keep a Claude Code flock agent present in the pot's Fleet.
#
# Claude Code is not a daemon, so presence is refreshed by re-announcing on the
# bus. Wire this to a UserPromptSubmit/Stop hook (re-announce every turn) and/or
# run it on a cron (e.g. */5 * * * *) for idle presence. Stop it → the agent ages
# to `dead` in the Fleet ("not there").
#
# Requires: AGENT_NAME (your bus agent name) and a scoped bus token. The token is
# read from $FLOCK_BUS_TOKEN or, if unset, the Authorization header in the local
# .mcp.json — it is NEVER printed.
#
# Usage:  AGENT_NAME=<name> FLOCK_BUS_TOKEN=<token> ./heartbeat.sh
set -euo pipefail

: "${AGENT_NAME:?set AGENT_NAME to your bus agent name}"
BUS_URL="${FLOCK_BUS_URL:-https://mcp.mumega.com}"

# Resolve token without echoing it.
TOKEN="${FLOCK_BUS_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f "${FLOCK_MCP_JSON:-.mcp.json}" ]; then
  TOKEN="$(sed -n 's/.*Bearer \([^"]*\)".*/\1/p' "${FLOCK_MCP_JSON:-.mcp.json}" | head -n1)"
fi
[ -z "$TOKEN" ] && { echo "heartbeat: no token (set FLOCK_BUS_TOKEN)" >&2; exit 1; }

# check_in over the bus — refreshes last_seen so the pot's Fleet keeps us `active`.
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
  -X POST "${BUS_URL%/}/check_in" \
  -H "authorization: Bearer ${TOKEN}" \
  -H 'content-type: application/json' \
  -d "{\"agent\":\"${AGENT_NAME}\"}")"

case "$code" in
  2*) echo "heartbeat: ${AGENT_NAME} checked in (${code})" ;;
  *)  echo "heartbeat: check_in failed (${code})" >&2; exit 1 ;;
esac
