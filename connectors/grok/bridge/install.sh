#!/usr/bin/env bash
# install.sh — wire the mupot Stop-hook drain into a Grok TUI seat.
#
# Complementary to the herdr polling connector (scripts/grok-inbox-watch.mjs).
# This is end-of-turn only. It cannot wake an idle prompt.
#
#   ./install.sh --seat muvps_loom
#   ./install.sh --seat muvps_loom --dry-run
#   ./install.sh --uninstall
#
# Verifies the credential against the live pot BEFORE writing any hook file.
# A hook that installs cleanly and then silently fails to authenticate is worse
# than one that refuses.
#
# THIS TASK MUST NOT RUN THIS SCRIPT. Kasra standing orders: do not install.

set -euo pipefail

SEAT=""; TOKEN_FILE=""; DRY=0; UNINSTALL=0
ENDPOINT="${MUPOT_ENDPOINT:-https://mupot.mumega.com/mcp}"
while [ $# -gt 0 ]; do
  case "$1" in
    --seat) SEAT="${2:?--seat needs a value}"; shift 2 ;;
    --token-file) TOKEN_FILE="${2:?--token-file needs a value}"; shift 2 ;;
    --endpoint) ENDPOINT="${2:?--endpoint needs a value}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_FLEET="$(cd "$SRC_DIR/../../../fleet-runtime" && pwd)"
DEST_DIR="${MUPOT_BRIDGE_HOME:-${HOME}/.grok/mupot-inbox}"
HOOK_FILE="${HOME}/.grok/hooks/mupot-inbox.json"
NODE="$(command -v node)"

if [ "$UNINSTALL" -eq 1 ]; then
  [ "$DRY" -eq 1 ] && { echo "(dry run) would remove $HOOK_FILE"; exit 0; }
  rm -f "$HOOK_FILE"
  echo "Removed $HOOK_FILE. Bridge files left at $DEST_DIR."
  exit 0
fi

[ -n "$SEAT" ] || { echo "refusing: --seat is required" >&2; exit 2; }
[ -n "$NODE" ] || { echo "refusing: node is required" >&2; exit 2; }

mkdir -p "$DEST_DIR" "${HOME}/.grok/hooks"
install -m 0755 "$SRC_DIR/grok-bridge.mjs" "$DEST_DIR/grok-bridge.mjs"
install -m 0644 "$REPO_FLEET/grok-inbox-adapter.mjs" "$DEST_DIR/grok-inbox-adapter.mjs"
install -m 0644 "$REPO_FLEET/claude-code-inbox-adapter.mjs" "$DEST_DIR/claude-code-inbox-adapter.mjs"

echo "Verifying the credential against ${ENDPOINT} (nothing is consumed):"
VERIFY=(env "MUPOT_BRIDGE_SEAT=$SEAT" "MUPOT_ENDPOINT=$ENDPOINT")
[ -n "$TOKEN_FILE" ] && VERIFY+=("MUPOT_TOKEN_FILE=$TOKEN_FILE")
if ! "${VERIFY[@]}" "$NODE" "$DEST_DIR/grok-bridge.mjs" --self-test; then
  echo "REFUSING TO INSTALL — the credential did not authenticate." >&2
  echo "  Nothing was written to $HOOK_FILE." >&2
  exit 1
fi

if [ "$DRY" -eq 1 ]; then
  echo "(dry run) credential is good; $HOOK_FILE NOT written."
  exit 0
fi

CMD="MUPOT_BRIDGE_SEAT=${SEAT}"
[ -n "$TOKEN_FILE" ] && CMD="${CMD} MUPOT_TOKEN_FILE=${TOKEN_FILE}"
CMD="${CMD} MUPOT_ENDPOINT=${ENDPOINT} ${NODE} ${DEST_DIR}/grok-bridge.mjs"

python3 - "$HOOK_FILE" "$CMD" <<'PY'
import json, sys
path, command = sys.argv[1], sys.argv[2]
data = {
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {"type": "command", "command": command, "timeout": 30}
        ]
      }
    ]
  }
}
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
print(f"  wrote {path}")
PY

cat <<EOF

Installed Stop-hook drain for seat ${SEAT}.
This does NOT wake an idle prompt. Keep the herdr polling unit for that.

One consumer rule: do not also run a bearer consume on this inbox from a
second Stop hook. Polling + Stop compose because polling delivers via herdr
prompt (starts a turn) and this hook drains at genuine end_turn.

EOF
