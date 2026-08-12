#!/usr/bin/env bash
# install.sh — wire the mupot bridge into a Claude Code seat.
#
# Deliberately boring: it copies one script, verifies the credential BEFORE touching any
# config, adds one Stop hook entry, and tells you exactly what it changed. It refuses
# rather than guesses, and it is safe to re-run.
#
#   ./install.sh --seat kasra
#   ./install.sh --seat kasra --token-file /path/to/token    # non-standard layout
#   ./install.sh --seat kasra --dry-run
#   ./install.sh --uninstall
#
# WHY IT VERIFIES FIRST: a bridge that installs cleanly and then silently fails to
# authenticate is worse than one that refuses — you would believe you were reachable while
# your inbox filled up. So the credential is proven against the live pot before a single
# line of settings.json is written.

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
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
DEST_DIR="${MUPOT_BRIDGE_HOME:-${HOME}/.mupot-bridge}"
DEST="${DEST_DIR}/mupot-bridge.sh"
SETTINGS="${HOME}/.claude/settings.json"

python3 - "$SETTINGS" "$DEST" "$SEAT" "$UNINSTALL" "$DRY" <<'PY' || exit 1
import json, os, sys
settings_path, dest, seat, uninstall, dry = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == "1", sys.argv[5] == "1"
if not os.path.exists(settings_path):
    print(f"refusing: no Claude Code settings at {settings_path} — is this a Claude Code host?")
    sys.exit(1)
data = json.load(open(settings_path))
hooks = data.setdefault("hooks", {})
stop = hooks.setdefault("Stop", [])
cmd = f'MUPOT_BRIDGE_SEAT={seat} bash {dest}'
present = any(cmd.split("bash ")[-1] in json.dumps(e) for e in stop)
print(f"  settings:     {settings_path}")
print(f"  Stop hooks:   {len(stop)} already registered")
print(f"  this bridge:  {'ALREADY PRESENT' if present else 'not present'}")
if uninstall:
    print("  action:       remove" if present else "  action:       nothing to remove")
else:
    print("  action:       " + ("no change needed" if present else "append one Stop hook"))
PY

if [ "$UNINSTALL" -eq 1 ]; then
  [ "$DRY" -eq 1 ] && { echo "(dry run) would remove the hook entry and leave $DEST in place"; exit 0; }
  python3 - "$SETTINGS" "$DEST" <<'PY'
import json, sys
p, dest = sys.argv[1], sys.argv[2]
d = json.load(open(p))
stop = d.get("hooks", {}).get("Stop", [])
kept = [e for e in stop if dest not in json.dumps(e)]
d["hooks"]["Stop"] = kept
json.dump(d, open(p, "w"), indent=2)
print(f"  removed {len(stop) - len(kept)} entry(ies). Bridge script left at {dest}.")
PY
  echo "Uninstalled. Re-enable any consumer you disabled (a responder, an inbox-capture unit)."
  exit 0
fi

[ -n "$SEAT" ] || { echo "refusing: --seat is required (the bridge must know whose inbox it drains)" >&2; exit 2; }

# ── verify the credential BEFORE touching config ─────────────────────────────
mkdir -p "$DEST_DIR"
install -m 0755 "${SRC_DIR}/mupot-bridge.sh" "$DEST"
echo
echo "Verifying the credential against ${ENDPOINT} (nothing is consumed):"
# Build the env explicitly. An empty ${VAR:+...} expansion produces a null word that
# TERMINATES bash's assignment prefix, so the next VAR=value is parsed as a command name.
# That failed closed here (the installer refused rather than proceeding), which is the
# right direction to fail — but it refused for the wrong reason.
VERIFY_ENV=(env "MUPOT_BRIDGE_SEAT=$SEAT" "MUPOT_ENDPOINT=$ENDPOINT")
[ -n "$TOKEN_FILE" ] && VERIFY_ENV+=("MUPOT_TOKEN_FILE=$TOKEN_FILE")
if ! "${VERIFY_ENV[@]}" bash "$DEST" --self-test; then
  echo
  echo "REFUSING TO INSTALL — the credential did not authenticate." >&2
  echo "  Nothing was written to settings.json. Fix the token, then re-run." >&2
  exit 1
fi

if [ "$DRY" -eq 1 ]; then
  echo
  echo "(dry run) credential is good; settings.json NOT modified."
  exit 0
fi

python3 - "$SETTINGS" "$DEST" "$SEAT" "${TOKEN_FILE:-}" "$ENDPOINT" <<'PY'
import json, shutil, sys, time
settings, dest, seat, token_file, endpoint = sys.argv[1:6]
shutil.copy(settings, f"{settings}.bak-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}")
d = json.load(open(settings))
stop = d.setdefault("hooks", {}).setdefault("Stop", [])
if any(dest in json.dumps(e) for e in stop):
    print("  already installed; settings.json unchanged.")
    sys.exit(0)
env = f"MUPOT_BRIDGE_SEAT={seat}"
if token_file: env += f" MUPOT_TOKEN_FILE={token_file}"
if endpoint:   env += f" MUPOT_ENDPOINT={endpoint}"
stop.append({"hooks": [{"type": "command", "command": f"{env} bash {dest}", "timeout": 20}]})
json.dump(d, open(settings, "w"), indent=2)
print(f"  appended one Stop hook (backup written alongside settings.json).")
PY

cat <<EOF

Installed.

  bridge:  $DEST
  seat:    $SEAT
  spool:   ${DEST_DIR}/spool
  log:     ${DEST_DIR}/bridge.log

IMPORTANT — ONE CONSUMER PER INBOX. A mupot inbox can only be drained once: whoever reads
it first marks the mail read. If anything else already consumes this seat's inbox, turn it
off now or messages will land in one place and not the other:

  systemctl --user disable --now ${SEAT}-inbox-capture.service 2>/dev/null || true
  systemctl --user disable --now ${SEAT}-responder.service     2>/dev/null || true

and remove any older inbox hook for this seat from ${SETTINGS}.

Delivery happens at the END of a turn — Claude Code has no mid-session injection API, so a
message arriving while the model is working waits for it to finish. Test it with:

  bash $DEST --self-test
EOF
