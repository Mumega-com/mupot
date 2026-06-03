#!/usr/bin/env bash
# register-discord.sh — register mupot's Discord slash commands and point Discord's
# interactions endpoint at this worker.
#
# What it does (two steps, each reported independently):
#   1. PUT  applications/<APP_ID>/commands       → global commands /task /status /link
#   2. PATCH applications/@me                     → set interactions_endpoint_url
#
# Auth: a bot token, read ONLY from $DISCORD_BOT_TOKEN. The token is sent in the
# Authorization header on the outbound HTTPS calls and is NEVER echoed, logged, or
# written to disk. Do not pass it on the command line (it would leak into ps/history).
#
# Usage:
#   DISCORD_BOT_TOKEN=xxxx ./scripts/register-discord.sh
#   DISCORD_BOT_TOKEN=xxxx DISCORD_APP_ID=... WORKER_URL=... ./scripts/register-discord.sh
#
# Defaults: DISCORD_APP_ID=1491154350624735262
#           WORKER_URL=https://mupot.weathered-scene-2272.workers.dev
#
# IMPORTANT — ordering: step 2 sets the interactions endpoint URL. Discord immediately
# sends a PING to that URL and REJECTS the PATCH unless the URL answers the PING with a
# valid PONG. So the worker (with the Discord adapter respond() seam + DISCORD_PUBLIC_KEY
# secret) MUST be deployed BEFORE you run step 2. If step 2 fails, deploy first, re-run.

set -euo pipefail

DISCORD_API="https://discord.com/api/v10"
APP_ID="${DISCORD_APP_ID:-1491154350624735262}"
WORKER_URL="${WORKER_URL:-https://mupot.weathered-scene-2272.workers.dev}"
INTERACTIONS_URL="${WORKER_URL%/}/channels/discord/webhook"

if [[ -z "${DISCORD_BOT_TOKEN:-}" ]]; then
  echo "ERROR: DISCORD_BOT_TOKEN is not set. Export it (do not pass it as an argument)." >&2
  exit 1
fi

# Auth header built once; never printed. (Set after the guard so it's always populated.)
AUTH_HEADER="Authorization: Bot ${DISCORD_BOT_TOKEN}"

echo "mupot Discord registration"
echo "  app id:            ${APP_ID}"
echo "  worker:            ${WORKER_URL}"
echo "  interactions url:  ${INTERACTIONS_URL}"
echo

# ── Step 1: register global slash commands ────────────────────────────────────
# A bulk-overwrite PUT replaces the full global command set with exactly these three.
COMMANDS_JSON='[
  {
    "name": "task",
    "description": "Add a task to this channel'\''s squad",
    "type": 1,
    "options": [
      { "name": "title", "description": "What needs doing", "type": 3, "required": true }
    ]
  },
  {
    "name": "status",
    "description": "Show this squad'\''s current status",
    "type": 1
  },
  {
    "name": "link",
    "description": "Connect yourself to this workspace with an admin-issued code",
    "type": 1,
    "options": [
      { "name": "code", "description": "The link code an admin gave you", "type": 3, "required": true }
    ]
  }
]'

echo "[1/2] Registering global commands (/task, /status, /link)..."
http_code=$(curl -sS -o /tmp/mupot-discord-cmds.out -w '%{http_code}' \
  -X PUT "${DISCORD_API}/applications/${APP_ID}/commands" \
  -H "${AUTH_HEADER}" \
  -H 'Content-Type: application/json' \
  -d "${COMMANDS_JSON}")

if [[ "${http_code}" == "200" || "${http_code}" == "201" ]]; then
  echo "      OK (HTTP ${http_code}) — commands registered."
else
  echo "      FAILED (HTTP ${http_code}). Response:" >&2
  cat /tmp/mupot-discord-cmds.out >&2 || true
  echo >&2
  rm -f /tmp/mupot-discord-cmds.out
  exit 1
fi
rm -f /tmp/mupot-discord-cmds.out

# ── Step 2: set the interactions endpoint URL ─────────────────────────────────
# Discord PINGs INTERACTIONS_URL during this PATCH; the worker's respond() seam must
# already be deployed (with DISCORD_PUBLIC_KEY set) or Discord rejects the URL.
echo "[2/2] Setting interactions endpoint URL..."
echo "      NOTE: Discord will PING ${INTERACTIONS_URL} to validate it."
echo "            The worker MUST already be deployed (respond() + DISCORD_PUBLIC_KEY)."
http_code=$(curl -sS -o /tmp/mupot-discord-app.out -w '%{http_code}' \
  -X PATCH "${DISCORD_API}/applications/@me" \
  -H "${AUTH_HEADER}" \
  -H 'Content-Type: application/json' \
  -d "{\"interactions_endpoint_url\":\"${INTERACTIONS_URL}\"}")

if [[ "${http_code}" == "200" ]]; then
  echo "      OK (HTTP ${http_code}) — interactions endpoint set."
else
  echo "      FAILED (HTTP ${http_code}). Response:" >&2
  cat /tmp/mupot-discord-app.out >&2 || true
  echo >&2
  echo "      Most common cause: the endpoint failed Discord's PING validation." >&2
  echo "      Deploy the worker first (npm run deploy), then re-run this script." >&2
  rm -f /tmp/mupot-discord-app.out
  exit 1
fi
rm -f /tmp/mupot-discord-app.out

echo
echo "Done. Slash commands registered and interactions endpoint pointed at the worker."
