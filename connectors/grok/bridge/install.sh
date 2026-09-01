#!/usr/bin/env bash
# install.sh — wire the mupot grok-inbox-watch daemon into a grok-cli seat.
#
# Deliberately boring, same discipline as connectors/claude/bridge/install.sh: it verifies
# the credential and identity BEFORE writing anything, renders one systemd user unit, and
# tells you exactly what it changed. It refuses rather than guesses, and it is safe to
# re-run. Unlike the Claude bridge it does NOT enable or start the unit — see "What this
# does not do" below. That is a deliberate boundary of this installer, not a limitation to
# work around.
#
#   ./install.sh --seat muvps_loom --agent-id <bound-agent-id>
#   ./install.sh --seat muvps_loom --agent-id <id> --token-file /path/to/token
#   ./install.sh --seat muvps_loom --agent-id <id> --tmux-session grok:1
#   ./install.sh --seat muvps_loom --agent-id <id> --dry-run
#   ./install.sh --uninstall --seat muvps_loom
#
# WHY IT VERIFIES FIRST: a watcher that installs cleanly and then silently fails to
# authenticate — or drains the wrong agent's mail — is worse than one that refuses. mupot#1258
# is exactly a seat that looked healthy (mupot accepted every send) while nothing on the
# receiving end ever read a line. So the credential AND the agent-id binding are proven
# against the live pot, with the seat argument actually passed, before a single unit file is
# written.
#
# WHY --agent-id IS REQUIRED, NOT DEFAULTED: mupot#1154 was a seat slug hardcoded in host
# config — whichever body launched first drained someone else's mail. scripts/grok-inbox-watch.mjs
# has no compiled-in agent default (unlike the per-known-agent codex/kasra watchers) precisely
# so a copy-pasted unit can never silently point at the wrong identity. This installer inherits
# that refusal.

set -euo pipefail

SEAT=""; AGENT_ID=""; TOKEN_FILE=""; TMUX_SESSION=""; DRY=0; UNINSTALL=0
ENDPOINT="${MUPOT_MCP:-https://mupot.mumega.com/mcp}"
INTERVAL_SEC="${INTERVAL_SEC:-30}"
while [ $# -gt 0 ]; do
  case "$1" in
    --seat) SEAT="${2:?--seat needs a value}"; shift 2 ;;
    --agent-id) AGENT_ID="${2:?--agent-id needs a value}"; shift 2 ;;
    --token-file) TOKEN_FILE="${2:?--token-file needs a value}"; shift 2 ;;
    --tmux-session) TMUX_SESSION="${2:?--tmux-session needs a value}"; shift 2 ;;
    --endpoint) ENDPOINT="${2:?--endpoint needs a value}"; shift 2 ;;
    --interval-sec) INTERVAL_SEC="${2:?--interval-sec needs a value}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "$SEAT" ] || { echo "refusing: --seat is required (the watcher must know whose inbox it drains, and which tmux pane to type into)" >&2; exit 2; }

# Repo root = three levels up from this script (connectors/grok/bridge/install.sh).
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SRC_DIR}/../../.." && pwd)"
WATCHER="${REPO_ROOT}/scripts/grok-inbox-watch.mjs"
[ -f "$WATCHER" ] || { echo "refusing: expected the watcher at ${WATCHER} — is this a full mupot checkout, not just the connectors/ dir?" >&2; exit 1; }

UNIT_NAME="grok-inbox-watch-${SEAT}.service"
UNIT_DIR="${HOME}/.config/systemd/user"
UNIT_PATH="${UNIT_DIR}/${UNIT_NAME}"
TOKEN_FILE="${TOKEN_FILE:-${HOME}/.fleet/agents/${SEAT}-agent-bound.token}"
TMUX_SESSION="${TMUX_SESSION:-$SEAT}"
NODE_BIN="$(command -v node || true)"

if [ "$UNINSTALL" -eq 1 ]; then
  if [ -f "$UNIT_PATH" ]; then
    [ "$DRY" -eq 1 ] && { echo "(dry run) would remove ${UNIT_PATH} — you still need to 'systemctl --user disable --now ${UNIT_NAME}' yourself first if it was ever enabled"; exit 0; }
    rm -f "$UNIT_PATH"
    echo "Removed ${UNIT_PATH}."
    echo "If it was ever enabled, also run: systemctl --user disable --now ${UNIT_NAME}"
  else
    echo "nothing to remove: ${UNIT_PATH} does not exist"
  fi
  exit 0
fi

[ -n "$AGENT_ID" ] || { echo "refusing: --agent-id is required — see WHY --agent-id IS REQUIRED above (mupot#1154)" >&2; exit 2; }
[ -n "$NODE_BIN" ] || { echo "refusing: no 'node' on PATH" >&2; exit 1; }

echo
echo "Verifying the credential + seat + identity against ${ENDPOINT} (self-test only — nothing is consumed):"
if ! GROK_SEAT="$SEAT" GROK_AGENT_ID="$AGENT_ID" GROK_TOKEN_FILE="$TOKEN_FILE" MUPOT_MCP="$ENDPOINT" \
     "$NODE_BIN" "$WATCHER" --self-test; then
  echo
  echo "REFUSING TO INSTALL — the self-test failed (bad/missing token, wrong seat, or the" >&2
  echo "credential resolves to a DIFFERENT agent than --agent-id). Nothing was written." >&2
  echo "Re-run with --dry-run once fixed to confirm before installing for real." >&2
  exit 1
fi

if [ "$DRY" -eq 1 ]; then
  echo
  echo "(dry run) self-test passed; ${UNIT_PATH} NOT written."
  exit 0
fi

mkdir -p "$UNIT_DIR"
cat > "$UNIT_PATH" <<EOF
[Unit]
Description=grok-cli mupot inbox watcher for seat ${SEAT} — peek -> spool -> tmux handoff -> consume-on-success (mupot#1258)
Documentation=https://github.com/Mumega-com/mupot/blob/main/connectors/grok/README.md
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${REPO_ROOT}
ExecStart=${NODE_BIN} ${WATCHER}
Environment=MUPOT_MCP=${ENDPOINT}
Environment=GROK_SEAT=${SEAT}
Environment=GROK_AGENT_ID=${AGENT_ID}
Environment=GROK_TOKEN_FILE=${TOKEN_FILE}
Environment=TMUX_SESSION=${TMUX_SESSION}
Environment=INTERVAL_SEC=${INTERVAL_SEC}
Restart=on-failure
RestartSec=15

[Install]
WantedBy=default.target
EOF

cat <<EOF

Wrote ${UNIT_PATH}. It is NOT enabled and NOT started — this installer never activates a
live seat (that decision, and the moment it happens, belongs to whoever owns the seat).

  watcher:      ${WATCHER}
  seat:         ${SEAT}
  agent id:     ${AGENT_ID}
  token file:   ${TOKEN_FILE}
  tmux target:  ${TMUX_SESSION}   (the pane grok-cli's TUI is actually running in — verify
                this is right before enabling; 'tmux list-panes -a' shows what exists)
  endpoint:     ${ENDPOINT}
  interval:     ${INTERVAL_SEC}s

ONE CONSUMER PER INBOX (same rule as every other mupot bridge). Before enabling, make sure
nothing else already drains this seat's inbox:

  systemctl --user list-units 'grok-inbox-watch-*' '*-inbox-capture.*' '*-responder.*'

To actually turn it on, when you are ready:

  systemctl --user daemon-reload
  systemctl --user enable --now ${UNIT_NAME}
  journalctl --user -u ${UNIT_NAME} -f

To verify without enabling anything:

  GROK_SEAT=${SEAT} GROK_AGENT_ID=${AGENT_ID} GROK_TOKEN_FILE=${TOKEN_FILE} \\
    node ${WATCHER} --once
EOF
