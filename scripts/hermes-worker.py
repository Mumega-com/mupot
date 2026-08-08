#!/usr/bin/env python3
"""Hermes-Sol constant-agent host driver (Port 3).

Keeps KayHermes visible on the Port-1 presence roster and (optionally) posts a
Luna heartbeat through the pot's Hermes chat API so the always-on front-door
stays warm without spending Sol tokens. The chat surface itself lives on the
pot (`GET /hermes`, `POST /api/hermes/chat`); this script is the host-side
heartbeat + presence half — same shape as tech-grok-worker.py's register_presence.

Diverse-gate note: scripts/review-worker.py accepts REVIEW_BACKEND=hermes-sol
to run the adversarial eye on GPT-5.6 Sol via `hermes -z` (retires the Codex
diverse-eye dependency). This driver does NOT auto-merge or verdict.

Config (env):
  MUPOT_MCP          default https://mupot.mumega.com/mcp
  HERMES_TOKEN       default ~/.fleet/agents/kayhermes-member.token
  HERMES_BASE_URL    default https://mupot.mumega.com  (chat API origin)
  HERMES_PROJECT_ID  optional project scope for presence (default null bucket)
  LUNA_HEARTBEAT     '1' posts a cheap Luna ping to /api/hermes/chat (default '0')
  DRY_RUN            '1' = print, no MCP/HTTP mutating calls

Usage:
  python3 scripts/hermes-worker.py
  LUNA_HEARTBEAT=1 python3 scripts/hermes-worker.py
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

MUPOT_MCP = os.environ.get("MUPOT_MCP", "https://mupot.mumega.com/mcp")
HERMES_TOKEN_PATH = Path(
    os.environ.get("HERMES_TOKEN", str(Path.home() / ".fleet/agents/kayhermes-member.token"))
)
HERMES_BASE_URL = os.environ.get("HERMES_BASE_URL", "https://mupot.mumega.com").rstrip("/")
HERMES_PROJECT_ID = os.environ.get("HERMES_PROJECT_ID", "").strip() or None
LUNA_HEARTBEAT = os.environ.get("LUNA_HEARTBEAT", "") == "1"
DRY_RUN = os.environ.get("DRY_RUN", "") == "1"


def log(msg: str) -> None:
    print(f"[hermes-worker] {msg}", flush=True)


def token() -> str:
    return HERMES_TOKEN_PATH.read_text().strip()


def mcp(tool: str, args: dict) -> dict:
    body = json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool, "arguments": args}}
    ).encode()
    req = urllib.request.Request(
        MUPOT_MCP,
        data=body,
        headers={
            "Authorization": f"Bearer {token()}",
            "content-type": "application/json",
            "User-Agent": "hermes-worker/1.0 (+mupot)",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        payload = json.loads(resp.read())
    if "error" in payload:
        raise RuntimeError(f"mupot {tool} error: {payload['error']}")
    inner = json.loads(payload["result"]["content"][0]["text"])
    if not inner.get("ok", True):
        raise RuntimeError(f"mupot {tool} not ok: {inner}")
    return inner.get("result", inner)


def register_presence() -> None:
    """Port-1 self-registration: chat + dispatch + gate capabilities so the
    concierge/roster see Hermes online as the constant front-door."""
    args = {
        "adapter": "hermes",
        "kind": "agent_system",
        "project_id": HERMES_PROJECT_ID,
        "capabilities": ["chat", "dispatch", "gate"],
    }
    if DRY_RUN:
        log(f"DRY_RUN presence_register {args}")
        return
    try:
        mcp("presence_register", args)
        log("presence: registered/refreshed (adapter=hermes, capabilities=[chat,dispatch,gate])")
    except Exception as exc:  # noqa: BLE001 — presence is best-effort
        log(f"presence_register failed (non-fatal): {exc}")


def luna_heartbeat() -> None:
    """Cheap Luna ping through the pot chat API (no Sol spend on heartbeat)."""
    url = f"{HERMES_BASE_URL}/api/hermes/chat"
    body = json.dumps({"message": "ping"}).encode()
    if DRY_RUN:
        log(f"DRY_RUN POST {url} {{message: ping}}")
        return
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Authorization": f"Bearer {token()}",
            "content-type": "application/json",
            "User-Agent": "hermes-worker/1.0 (+mupot)",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read())
        tier = (payload.get("route") or {}).get("tier")
        log(f"luna heartbeat ok tier={tier!r} reply={str(payload.get('reply', ''))[:80]!r}")
    except urllib.error.HTTPError as exc:
        log(f"luna heartbeat HTTP {exc.code}: {exc.read()[:200]!r}")
    except Exception as exc:  # noqa: BLE001
        log(f"luna heartbeat failed (non-fatal): {exc}")


def main() -> int:
    if not HERMES_TOKEN_PATH.is_file():
        log(f"missing token file: {HERMES_TOKEN_PATH}")
        return 2
    register_presence()
    if LUNA_HEARTBEAT:
        luna_heartbeat()
    return 0


if __name__ == "__main__":
    sys.exit(main())
