#!/usr/bin/env python3
"""Steward — the loop's self-care lane. Makes the system self-perpetuating.

Every cycle it repairs the board conditions that previously required a human
(or Kasra by hand, five times on 2026-08-02/03 alone):

  1. AUTO-REISSUE: terminal `blocked` tasks whose block reason is a known
     infra failure (not a review verdict) get re-created as fresh `open`
     tasks — the server has no requeue transition (mupot#635), so re-issue
     IS the requeue. Dedup marker in the body prevents loops; one re-issue
     per lineage, ever, without a human.
  2. ORPHAN-REISSUE: `in_progress` tasks older than ORPHAN_HOURS with no
     live worktree are SIGTERM orphans — same re-issue path.
  3. DIGEST: once per DIGEST_EVERY_SECONDS, a one-paragraph status to the
     principal's Telegram via `hermes send` (deterministic pipe, no agent):
     open/in-progress/review/blocked counts, what the steward repaired,
     and anything waiting on a human.

Rank-not-act discipline (mubot spec, task 67ab59aa): the steward only ever
CREATES tasks and SENDS digests. It never verdicts, closes, merges, edits
code, or touches services. Everything it makes flows through the same lanes
and gates as any other work.

Config (env):
  MUPOT_MCP, KASRA_TOKEN     as the other drivers
  ORPHAN_HOURS               default 2
  DIGEST_EVERY_SECONDS       default 21600 (6h)
  DIGEST_TARGET              default 'telegram' (hermes send -t value)
  STEWARD_STATE              default ~/.fleet/steward-state.json
  DRY_RUN                    '1' = report what it would do, do nothing
"""
from __future__ import annotations

import json
import os
import subprocess
import time
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

MUPOT_MCP = os.environ.get("MUPOT_MCP", "https://mupot.mumega.com/mcp")
TOKEN_PATH = Path(os.environ.get("KASRA_TOKEN", str(Path.home() / ".fleet/agents/kasra-agent.token")))
ORPHAN_HOURS = float(os.environ.get("ORPHAN_HOURS", "2"))
DIGEST_EVERY = int(os.environ.get("DIGEST_EVERY_SECONDS", "21600"))
DIGEST_TARGET = os.environ.get("DIGEST_TARGET", "telegram")
STATE_PATH = Path(os.environ.get("STEWARD_STATE", str(Path.home() / ".fleet/steward-state.json")))
WORKTREE_ROOT = Path(os.environ.get("WORKTREE_ROOT", "/home/mumega/mupot-worktrees"))
DRY_RUN = os.environ.get("DRY_RUN", "") == "1"

REISSUE_MARKER = "steward-reissue-of:"
# Block reasons that are infra failures, safe to auto-retry once. Review
# verdicts, gate BLOCKs, and anything unrecognized stay human.
RETRIABLE_SNIPPETS = (
    "no commits",
    "no changes",
    "tsc errors:",
    "This is not the tsc command",
    "bwrap:",
    "timed out",
    "Orphaned:",
)


def log(msg: str) -> None:
    print(f"[steward] {msg}", flush=True)


def mcp(tool: str, args: dict) -> dict:
    body = json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool, "arguments": args}}
    ).encode()
    req = urllib.request.Request(
        MUPOT_MCP,
        data=body,
        headers={
            "Authorization": f"Bearer {TOKEN_PATH.read_text().strip()}",
            "content-type": "application/json",
            "User-Agent": "steward-worker/1.0 (+mupot)",
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


def load_state() -> dict:
    try:
        return json.loads(STATE_PATH.read_text())
    except Exception:  # noqa: BLE001 - fresh state on any read problem
        return {"reissued": {}, "last_digest": 0}


def save_state(state: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=1))
    tmp.replace(STATE_PATH)


def list_tasks(status: str) -> list[dict]:
    return mcp("task_list", {"status": status, "limit": 50}).get("tasks", [])


def lineage_root(task: dict) -> str:
    """Follow steward markers so a lineage is only ever re-issued once."""
    body = task.get("body", "")
    idx = body.find(REISSUE_MARKER)
    if idx >= 0:
        return body[idx + len(REISSUE_MARKER):][:36]
    return task["id"]


def is_retriable(task: dict) -> bool:
    tail = task.get("body", "")[-2000:]
    return any(s in tail for s in RETRIABLE_SNIPPETS)


def reissue(task: dict, reason: str, state: dict) -> str | None:
    root = lineage_root(task)
    if root in state["reissued"]:
        return None  # one automatic retry per lineage; after that, humans
    base_body = task.get("body", "").split("\n\n---\n")[0]
    body = (
        f"{base_body}\n\n{REISSUE_MARKER}{root}\n"
        f"Steward auto-reissue {datetime.now(timezone.utc).isoformat()} — prior copy "
        f"{task['id'][:8]} was {task['status']} ({reason}). One automatic retry per "
        f"lineage; if this copy fails too it stays for a human."
    )
    if DRY_RUN:
        log(f"DRY_RUN would reissue {task['id'][:8]} ({reason})")
        return None
    new = mcp("task_create", {
        "squad_id": task.get("squad_id", "squad-core"),
        "project_id": task.get("project_id"),
        "title": task.get("title", "")[:200],
        "done_when": task.get("done_when", "(carried from prior copy)"),
        "body": body,
        "assignee_agent_id": task.get("assignee_agent_id"),
    })["task"]
    state["reissued"][root] = new["id"]
    log(f"reissued {task['id'][:8]} -> {new['id'][:8]} ({reason})")
    return new["id"]


def orphan_age_hours(task: dict) -> float:
    try:
        updated = datetime.fromisoformat(task["updated_at"].replace("Z", "+00:00"))
    except Exception:  # noqa: BLE001
        return 0.0
    return (datetime.now(timezone.utc) - updated).total_seconds() / 3600


def has_live_worktree(task: dict) -> bool:
    short = task["id"].split("-")[0]
    return any(WORKTREE_ROOT.glob(f"*-{short}"))


def send_digest(state: dict, repaired: list[str]) -> None:
    if time.time() - state.get("last_digest", 0) < DIGEST_EVERY:
        return
    counts = {}
    for status in ("open", "in_progress", "review", "blocked"):
        try:
            counts[status] = len(list_tasks(status))
        except Exception:  # noqa: BLE001
            counts[status] = -1
    lines = [
        f"🧭 Steward digest {datetime.now(timezone.utc).strftime('%H:%M')}Z — board: "
        + ", ".join(f"{k} {v}" for k, v in counts.items()),
    ]
    if repaired:
        lines.append("repaired this cycle: " + "; ".join(repaired))
    if counts.get("review", 0) > 0:
        lines.append(f"{counts['review']} task(s) sit in review — gates/humans needed.")
    msg = "\n".join(lines)
    if DRY_RUN:
        log(f"DRY_RUN digest:\n{msg}")
        return
    proc = subprocess.run(
        ["hermes", "send", "-t", DIGEST_TARGET, msg],
        capture_output=True, text=True, timeout=60,
    )
    if proc.returncode == 0:
        state["last_digest"] = time.time()
        log("digest sent")
    else:
        log(f"digest send failed (non-fatal): {proc.stderr[-200:]}")


def main() -> int:
    if not TOKEN_PATH.exists():
        log(f"no token at {TOKEN_PATH}")
        return 2
    state = load_state()
    repaired: list[str] = []

    for task in list_tasks("blocked"):
        if is_retriable(task):
            new_id = reissue(task, "retriable infra failure", state)
            if new_id:
                repaired.append(f"blocked {task['id'][:8]}→{new_id[:8]}")

    for task in list_tasks("in_progress"):
        if orphan_age_hours(task) >= ORPHAN_HOURS and not has_live_worktree(task):
            new_id = reissue(task, f"orphaned in_progress >{ORPHAN_HOURS}h, no worktree", state)
            if new_id:
                repaired.append(f"orphan {task['id'][:8]}→{new_id[:8]}")

    send_digest(state, repaired)
    if not DRY_RUN:
        save_state(state)
    log(f"cycle done — {len(repaired)} repair(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
