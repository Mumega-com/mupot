#!/usr/bin/env python3
"""mupot inbox -> kasra tmux nudge.

Polls kasra's own mupot inbox (agent-bound token) on an interval. Any new
message gets typed into the `kasra` tmux pane via `tmux send-keys`, the same
mechanism proven live 2026-07-21 for kasra->cursor. Read-only against mupot
(peek=false, so a delivered message is consumed exactly once — this IS the
delivery, there is no second reader).

This exists because push-and-check has a gap: kasra only sees a message when
it happens to poll. Cursor asked "did you send to kasra for gating?" and the
answer was already sitting in the inbox, unread, because nothing woke kasra
up. This closes that gap the same way cursor's tmux session is already wired
(it has mupot MCP registered with --approve-mcps, so it can act on its own
notifications; kasra doesn't have a background poller yet — this is it).

Config (env):
  MUPOT_MCP     default https://mupot.mumega.com/mcp
  KASRA_TOKEN   default ~/.fleet/agents/kasra-agent.token
  TMUX_SESSION  default 'kasra'
  INTERVAL      default 60 (seconds)
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

MUPOT_MCP = os.environ.get("MUPOT_MCP", "https://mupot.mumega.com/mcp")
KASRA_TOKEN_PATH = Path(os.environ.get("KASRA_TOKEN", str(Path.home() / ".fleet/agents/kasra-agent.token")))
TMUX_SESSION = os.environ.get("TMUX_SESSION", "kasra")
INTERVAL = int(os.environ.get("INTERVAL", "60"))


def log(msg: str) -> None:
    ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    print(f"[{ts}] kasra-inbox-watch: {msg}", flush=True)


def token() -> str:
    return KASRA_TOKEN_PATH.read_text().strip()


def mcp_call(name: str, arguments: dict) -> dict:
    body = json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": name, "arguments": arguments},
    }).encode()
    req = urllib.request.Request(
        MUPOT_MCP, data=body,
        headers={"Authorization": f"Bearer {token()}", "content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        payload = json.loads(resp.read())
    if "error" in payload:
        raise RuntimeError(payload["error"])
    text = payload["result"]["content"][0]["text"]
    return json.loads(text)["result"]


def nudge(message: dict) -> None:
    frm = message.get("from_agent", "?")[:8]
    kind = message.get("kind", "message")
    body = message.get("body", "")
    text = f"[mupot inbox] from {frm} ({kind}): {body}"
    subprocess.run(["tmux", "send-keys", "-t", TMUX_SESSION, text], check=False)
    time.sleep(0.5)
    subprocess.run(["tmux", "send-keys", "-t", TMUX_SESSION, "Enter"], check=False)


def one_cycle() -> int:
    result = mcp_call("inbox", {"limit": 10, "peek": False})
    messages = result.get("messages", [])
    for msg in messages:
        nudge(msg)
    if messages:
        log(f"delivered {len(messages)} message(s)")
    return len(messages)


def main() -> int:
    if not KASRA_TOKEN_PATH.exists():
        log(f"no kasra agent token at {KASRA_TOKEN_PATH}")
        return 2
    log(f"up (interval={INTERVAL}s tmux_session={TMUX_SESSION})")
    while True:
        try:
            one_cycle()
        except Exception as exc:  # noqa: BLE001 - one bad cycle must not kill the watcher
            log(f"cycle errored (continuing): {exc}")
        time.sleep(INTERVAL)


if __name__ == "__main__":
    sys.exit(main())
