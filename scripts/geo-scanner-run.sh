#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${MUPOT_GEO_SCANNER_REPO:-"$SCRIPT_DIR/.."}"
CLI_PATH="$REPO_DIR/fleet-runtime/geo-scanner/cli.mjs"

CONFIG_FILE="${GEO_SCANNER_CONFIG_FILE:-$HOME/.mumega/geo-scanner-viamar.json}"
POSTHOG_TOKEN_FILE="${POSTHOG_PROJECT_TOKEN_FILE:-$HOME/.mumega/geo-scanner-posthog.token}"
MUPOT_TOKEN_FILE="${MUPOT_AGENT_TOKEN_FILE:-$HOME/.mumega/geo-scanner-agent.token}"
TOKEN_FILE="$(mktemp "${TMPDIR:-/tmp}/geo-scanner-vertex-token.XXXXXX")"

cleanup() {
  rm -f "$TOKEN_FILE"
}
trap cleanup EXIT

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud is required for per-run Vertex token minting" >&2
  exit 1
fi

if [ ! -r "$CONFIG_FILE" ]; then
  echo "missing GEO_SCANNER_CONFIG_FILE at $CONFIG_FILE" >&2
  exit 1
fi

if [ ! -r "$POSTHOG_TOKEN_FILE" ] || [ ! -r "$MUPOT_TOKEN_FILE" ]; then
  echo "missing POSTHOG_PROJECT_TOKEN_FILE or MUPOT_AGENT_TOKEN_FILE" >&2
  exit 1
fi

GOOGLE_TOKEN="$(gcloud auth application-default print-access-token)"
if [ -z "$GOOGLE_TOKEN" ] || [ ${#GOOGLE_TOKEN} -lt 16 ]; then
  echo "failed to mint a fresh Google Vertex access token" >&2
  exit 1
fi

umask 077
printf '%s\n' "$GOOGLE_TOKEN" > "$TOKEN_FILE"

GEO_VERTEX_ACCESS_TOKEN_FILE="$TOKEN_FILE" \
  GEO_SCANNER_CONFIG_FILE="$CONFIG_FILE" \
  POSTHOG_PROJECT_TOKEN_FILE="$POSTHOG_TOKEN_FILE" \
  MUPOT_AGENT_TOKEN_FILE="$MUPOT_TOKEN_FILE" \
exec node "$CLI_PATH"
