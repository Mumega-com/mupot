#!/usr/bin/env bash
# mupot-bridge.sh — deliver mupot inbox mail into a Claude Code session.
#
# WHAT THIS IS
#
# Claude Code has no API for injecting a message into a running session. The only place an
# outside process can speak is the Stop hook: it runs when the model reaches a turn
# boundary, and JSON on its stdout of the form {"decision":"block","reason":"..."} re-enters
# the model with that text. So this is a drain that runs at end-of-turn, not a daemon that
# pushes. A message arriving mid-turn waits for the turn to finish. That is the harness's
# limit, not a design choice.
#
# ORDER IS LOAD-BEARING: peek -> spool -> inject -> consume.
#
# `inbox` without peek:true CONSUMES — the pot marks the batch read in the same statement
# that returns it. Consume-before-inject means a crash, a failed hook, or a killed turn
# loses the message from the pot AND from the session, with no trace. So: peek first, write
# to disk, inject, and only then consume. Worst case is a duplicate on disk; never a hole.
#
# IDENTITY COMES FROM THE CREDENTIAL, NOT THE ENVIRONMENT.
#
# The seat is whatever the token says it is — we call check_in and use the agent_id the pot
# returns. Deriving identity from $AGENT_NAME or from the working directory is how a seat
# ends up draining someone else's inbox: mupot#889 found three token files whose name said
# one agent and whose credential belonged to another. A token cannot be wrong about who it
# is; a directory can.
#
# SINGLE OWNER. One drainer per seat, enforced by flock. If you install this, disable any
# other consumer for the same seat (an older inbox hook, a <seat>-inbox-capture unit, a
# responder). Two things draining one inbox produces messages injected twice, or acked by
# the process that did not show them.
#
# USAGE
#   mupot-bridge.sh                 # seat from MUPOT_BRIDGE_SEAT
#   mupot-bridge.sh <seat>          # explicit
#   mupot-bridge.sh --self-test     # verify credential + reachability, consume nothing
#
# CONFIG (all optional except the seat)
#   MUPOT_BRIDGE_SEAT   seat slug; the token is looked up from it
#   MUPOT_TOKEN_FILE    full path to the agent-bound token (overrides the default layout)
#   MUPOT_ENDPOINT      default https://mupot.mumega.com/mcp
#   MUPOT_BRIDGE_HOME   state + spool root, default ~/.mupot-bridge
#   MUPOT_BRIDGE_LIMIT  messages per drain, default 10

set -uo pipefail

SEAT=""
SELF_TEST=0
case "${1:-}" in
  --self-test) SELF_TEST=1 ;;
  -*) echo "unknown option: $1" >&2; exit 2 ;;
  "") : ;;
  *) SEAT="$1" ;;
esac

SEAT="${SEAT:-${MUPOT_BRIDGE_SEAT:-}}"
HOME_DIR="${MUPOT_BRIDGE_HOME:-${HOME}/.mupot-bridge}"
ENDPOINT="${MUPOT_ENDPOINT:-https://mupot.mumega.com/mcp}"
LIMIT="${MUPOT_BRIDGE_LIMIT:-10}"
mkdir -p "$HOME_DIR/spool"

# A hook must never break the session it runs in. Every failure path from here on prints
# the no-op envelope and exits 0 — a bridge that can't reach the pot should be silent, not
# fatal. Failures are recorded in the log instead.
LOG="${HOME_DIR}/bridge.log"
quiet_exit() { [ "$SELF_TEST" -eq 1 ] && { echo "SELF-TEST: $1"; exit 1; }; echo '{"suppressOutput": true}'; exit 0; }
note() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG" 2>/dev/null || true; }

[ -n "$SEAT" ] || quiet_exit "no seat: set MUPOT_BRIDGE_SEAT or pass one as \$1"

TOKEN_FILE="${MUPOT_TOKEN_FILE:-${HOME}/.fleet/agents/${SEAT}-agent-bound.token}"
# Strict: no fallback to a differently-named token for this seat. A bridge that quietly
# falls back drains the wrong inbox while looking healthy (mupot#889).
[ -s "$TOKEN_FILE" ] || quiet_exit "no readable token at the configured path for seat '$SEAT'"
TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")"

pot() {
  local body
  body=$(printf '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"%s","arguments":%s}}' "$1" "$2")
  curl -4 -sS --max-time 25 -X POST "$ENDPOINT" \
    -H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json' \
    -d "$body" 2>/dev/null | python3 -c '
import json, sys
try: d = json.load(sys.stdin)
except Exception: sys.exit(0)
if d.get("error"): sys.exit(0)
c = (d.get("result") or {}).get("content") or []
print(c[0]["text"] if c and "text" in c[0] else json.dumps(d.get("result") or {}))' 2>/dev/null
}

# check_in resolves identity from the bearer token itself, so this both proves the
# credential works and tells us which agent it actually belongs to.
WHOAMI="$(pot check_in '{}' | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["result"]["agent_id"])
except Exception: pass' 2>/dev/null)"
[ -n "$WHOAMI" ] || quiet_exit "token did not authenticate against ${ENDPOINT}"

if [ "$SELF_TEST" -eq 1 ]; then
  echo "SELF-TEST OK"
  echo "  seat:     $SEAT"
  echo "  endpoint: $ENDPOINT"
  echo "  bound to: $WHOAMI"
  DEPTH="$(pot inbox "{\"limit\":1,\"peek\":true}" | python3 -c 'import json,sys
try:
    r=json.load(sys.stdin)["result"]; print("%s unread (remaining %s)" % (len(r.get("messages",[])), r.get("remaining")))
except Exception: print("?")' 2>/dev/null)"
  echo "  inbox:    $DEPTH   (peeked, nothing consumed)"
  exit 0
fi

# One drainer per seat. Two overlapping turns would otherwise both peek and both inject.
exec 9>"${HOME_DIR}/${SEAT}.lock"
flock -n 9 || quiet_exit "another drain is in flight"

PEEK="$(pot inbox "{\"limit\":${LIMIT},\"peek\":true}")"
[ -n "$PEEK" ] || quiet_exit "inbox peek failed"

TEXT="$(printf '%s' "$PEEK" | python3 -c '
import json, sys
try: r = json.load(sys.stdin).get("result", {})
except Exception: sys.exit(0)
me = sys.argv[1]
out = []
for m in r.get("messages", []):
    # Do not echo our own sends back at ourselves: a self-reply loop looks like a live
    # conversation and burns turns.
    if str(m.get("from_agent")) == me:
        continue
    rid = (" [request_id:%s]" % m["request_id"]) if m.get("request_id") else ""
    out.append("  seq %s from %s%s\n  %s" % (
        m.get("seq"), str(m.get("from_agent"))[:24], rid, str(m.get("body"))[:1500]))
print("\n\n".join(out))' "$WHOAMI" 2>/dev/null)"

[ -n "$TEXT" ] || quiet_exit ""

STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$$"
printf '%s' "$PEEK" > "${HOME_DIR}/spool/${STAMP}.peek.json"   # durable BEFORE consuming
pot inbox "{\"limit\":${LIMIT},\"peek\":false}" > "${HOME_DIR}/spool/${STAMP}.consumed.json" 2>/dev/null
note "delivered seat=${SEAT} stamp=${STAMP}"

python3 - "$TEXT" <<'PY'
import json, sys
print(json.dumps({"decision": "block", "reason":
    "Mail arrived on your mupot inbox. It has been consumed from the pot and written to "
    "the local spool, so it will NOT be delivered again — handle it now, or it exists only "
    "on disk.\n\n" + sys.argv[1] +
    "\n\nIf a message carries [request_id:<id>], reply with {ack_for:<id>, ok:true}."}))
PY
