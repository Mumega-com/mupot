#!/usr/bin/env bash
# Corrected Kasra mupot Stop-hook fragment (YC27).
#
# REPLACE the Kasra-only mupot branch in ~/.claude/hooks/check-inbox.sh that
# currently does: inbox peek=false → format without request_id → stderr →
# {"suppressOutput":true}. That path consumes durable rows without injecting
# them into the Claude Code turn, so ACKs never correlate.
#
# Authoritative consume+deliver is scripts/kasra-inbox-watch.mjs (peek → tmux
# handoff with request_id/in_reply_to → consume-on-success).
#
# This fragment is intentionally NON-CONSUMING. If unread mupot mail exists it
# blocks Stop with a correlation-preserving reason so an in-flight Kasra turn
# continues; the watcher still owns consume-once.
#
# Drop-in: source this after AGENT is resolved, or paste the body into the
# existing Stop hook in place of the old mupot block.

if [ "${AGENT}" != "kasra" ]; then
  return 0 2>/dev/null || true
fi

MUPOT_TOKEN_FILE="${MUPOT_TOKEN_FILE:-/home/mumega/.fleet/agents/kasra-agent.token}"
if [ ! -f "${MUPOT_TOKEN_FILE}" ]; then
  return 0 2>/dev/null || true
fi

MUPOT_TOKEN="$(cat "${MUPOT_TOKEN_FILE}" 2>/dev/null)"
if [ -z "${MUPOT_TOKEN}" ]; then
  return 0 2>/dev/null || true
fi

# peek=true — NEVER consume from the Stop hook.
MUPOT_RESP="$(curl -sf -m 5 "https://mupot.mumega.com/mcp" \
  -H "Authorization: Bearer ${MUPOT_TOKEN}" \
  -H "content-type: application/json" \
  -H "user-agent: kasra-stop-hook-peek/1.0 (+mupot)" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"inbox","arguments":{"limit":5,"peek":true}}}' 2>/dev/null || true)"

if [ -z "${MUPOT_RESP}" ]; then
  return 0 2>/dev/null || true
fi

MUPOT_BLOCK="$(printf '%s' "${MUPOT_RESP}" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    inner = json.loads(d["result"]["content"][0]["text"])
    msgs = inner.get("result", {}).get("messages", [])
except Exception:
    msgs = []
if not msgs:
    raise SystemExit(0)
lines = [
    "You have unread mupot inbox mail (peek only — not consumed).",
    "Authoritative delivery/consume is kasra-inbox-watch; ACK with kind=ack and in_reply_to=<request_id>.",
    "",
]
for m in msgs[-5:]:
    lines.append(
        f"- seq={m.get(\"seq\")} id={m.get(\"id\")} kind={m.get(\"kind\")} "
        f"from={m.get(\"from_agent\")} request_id={m.get(\"request_id\")} "
        f"in_reply_to={m.get(\"in_reply_to\")} body={m.get(\"body\",\"\")}"
    )
print(json.dumps({"decision": "block", "reason": "\n".join(lines)}))
' 2>/dev/null || true)"

if [ -n "${MUPOT_BLOCK}" ]; then
  printf '%s\n' "${MUPOT_BLOCK}"
  exit 0
fi
