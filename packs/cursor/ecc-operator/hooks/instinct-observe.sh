#!/usr/bin/env bash
# mupot ECC operator — instinct auto-capture hook (Port 4 / continuous-learning-v2.1).
#
# Captures PreToolUse / PostToolUse events and POSTs them to the pot's
# instinct_observe MCP tool. Requires:
#   MUPOT_MCP_URL   e.g. https://mupot.mumega.com/mcp
#   MUPOT_TOKEN     project-scoped member/agent bearer token
#   MUPOT_PROJECT_ID  mupot project id (UUID)
#
# Wire via Cursor/Claude hooks.json PreToolUse + PostToolUse (matcher "*").
# Missing env → exit 0 (never block the agent turn).

set -euo pipefail

HOOK_PHASE="${1:-}"
if [ -z "$HOOK_PHASE" ]; then
  case "${CLAUDE_HOOK_EVENT_NAME:-}${CURSOR_HOOK_EVENT_NAME:-}" in
    *PreToolUse*|*pre*) HOOK_PHASE="pre" ;;
    *) HOOK_PHASE="post" ;;
  esac
fi

if [ -z "${MUPOT_MCP_URL:-}" ] || [ -z "${MUPOT_TOKEN:-}" ] || [ -z "${MUPOT_PROJECT_ID:-}" ]; then
  exit 0
fi

INPUT_JSON="$(cat || true)"
if [ -z "$INPUT_JSON" ]; then
  exit 0
fi

EVENT="tool_complete"
if [ "$HOOK_PHASE" = "pre" ]; then
  EVENT="tool_start"
fi

# Prefer python for JSON packing; fall back to a minimal payload.
PAYLOAD='{}'
if command -v python3 >/dev/null 2>&1; then
  PAYLOAD="$(EVENT="$EVENT" INPUT_JSON="$INPUT_JSON" python3 - <<'PY'
import json, os
raw = os.environ.get("INPUT_JSON") or "{}"
event = os.environ["EVENT"]
try:
    data = json.loads(raw)
except Exception:
    data = {"raw": raw[:2000]}
tool = data.get("tool_name") or data.get("tool") or data.get("name")
payload = {
    "tool": tool,
    "phase": event,
}
# Keep payloads small — distill only needs pattern signal, not full transcripts.
for key in ("input", "arguments", "output", "error"):
    if key in data and data[key] is not None:
        text = data[key] if isinstance(data[key], str) else json.dumps(data[key])
        payload[key] = text[:1500]
print(json.dumps(payload))
PY
)"
fi

BODY="$(EVENT="$EVENT" PROJECT_ID="$MUPOT_PROJECT_ID" PAYLOAD="$PAYLOAD" SESSION="${MUPOT_SESSION_ID:-}" python3 - <<'PY'
import json, os
print(json.dumps({
  "tool": "instinct_observe",
  "args": {
    "project_id": os.environ["PROJECT_ID"],
    "event": os.environ["EVENT"],
    "payload": json.loads(os.environ.get("PAYLOAD") or "{}"),
    "session_id": os.environ.get("SESSION") or None,
  },
}))
PY
)"

curl -sS -o /dev/null -w '' \
  -X POST "$MUPOT_MCP_URL" \
  -H "Authorization: Bearer $MUPOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  || true

exit 0
