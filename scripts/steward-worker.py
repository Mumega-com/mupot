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
import urllib.error
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

LIST_LIMIT = 100  # server hard-caps task_list at 100 and exposes no offset
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
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            payload = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        # The server puts the useful reason (e.g. assignee_not_in_squad) in the
        # body, which the raw HTTPError hides behind a bare status code.
        detail = exc.read().decode(errors="replace")[:400]
        raise RuntimeError(f"mupot {tool} http {exc.code}: {detail}") from exc
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
    return mcp("task_list", {"status": status, "limit": LIST_LIMIT}).get("tasks", [])


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


def live_lineages() -> set[str]:
    """Lineage roots that already have a copy someone could still work on.

    The state file is the fast path, but it is local and losable; the board is the
    truth. Deriving the guard from the board too means a wiped or rolled-back state
    file can no longer cause a second copy of work that is already queued.
    """
    roots: set[str] = set()
    for status in ("open", "in_progress", "review"):
        try:
            tasks = list_tasks(status)
        except Exception as exc:  # noqa: BLE001 - a partial guard beats none
            log(f"live-lineage scan of {status} failed ({exc}) — relying on state file")
            continue
        roots.update(lineage_root(task) for task in tasks)
        if len(tasks) >= LIST_LIMIT:
            # No offset parameter exists, so a full page means the scan is partial and
            # this guard cannot prove a lineage is absent. Say so rather than imply
            # coverage the query never had; the state file remains the real dedup.
            log(f"live-lineage scan of {status} truncated at {LIST_LIMIT} — guard is partial")
    return roots


def reissue(task: dict, reason: str, state: dict, live: set[str]) -> str | None:
    root = lineage_root(task)
    if root in state["reissued"] or root in live:
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
    payload = {
        "squad_id": task.get("squad_id") or "squad-core",
        "project_id": task.get("project_id"),
        "title": task.get("title", "")[:200],
        "done_when": task.get("done_when") or "(carried from prior copy)",
        "body": body,
    }
    # mupot#659 P0 fix / "amplifier" close: reissue used to always go through task_create
    # with NO provenance marker, so a blocked task that originated from a governed
    # external integration (e.g. Linear, external_source set — migrations/0077 on the
    # server) came back on the reissued copy as an ordinary, unmarked, trusted-looking
    # task — laundering it straight into the normal task.created bus wake the original
    # import deliberately suppressed (skipEvent). Carry the marker forward whenever the
    # prior copy had one, so the reissued task keeps every downstream guard the marker
    # gates (no auto-pickup, admin-gated reassignment, untrusted-content prompt fence).
    external_source = task.get("external_source")
    if external_source:
        payload["external_source"] = external_source
    assignee = task.get("assignee_agent_id")
    try:
        new = mcp("task_create", {**payload, "assignee_agent_id": assignee} if assignee else payload)["task"]
    except RuntimeError as exc:
        # The original assignee may have left the squad (roster changes, expired
        # technician tokens). The work still needs doing — re-issue unassigned so
        # any squad member can claim it.
        if "assignee_not_in_squad" not in str(exc):
            raise
        log(f"{task['id'][:8]}: assignee {str(assignee)[:8]} no longer in squad — re-issuing unassigned")
        new = mcp("task_create", payload)["task"]
    state["reissued"][root] = new["id"]
    # Persist the moment the copy exists. The dedup record used to be written only
    # after the whole cycle finished, so any later failure (or a SIGTERM mid-cycle)
    # discarded it and the next cycle re-issued the SAME lineage again — that is how
    # 2026-08-03 produced two copies of the same task ten minutes apart. A duplicate
    # on the board is worse than a lost cycle, so the marker lands first.
    save_state(state)
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
    def render(value: int) -> str:
        # list_tasks pages at 50; a full page means "at least", not "exactly".
        return "?" if value < 0 else (f"{value}+" if value >= LIST_LIMIT else str(value))

    lines = [
        f"🧭 Steward digest {datetime.now(timezone.utc).strftime('%H:%M')}Z — board: "
        + ", ".join(f"{k} {render(v)}" for k, v in counts.items()),
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
    live = live_lineages()

    def repair(task: dict, reason: str, label: str) -> None:
        # One unrepairable task must never cost the cycle its other repairs.
        try:
            new_id = reissue(task, reason, state, live)
        except Exception as exc:  # noqa: BLE001 - keep stewarding the rest
            log(f"{label} {task['id'][:8]}: re-issue failed, left for a human — {exc}")
            return
        if new_id:
            live.add(lineage_root(task))
            repaired.append(f"{label} {task['id'][:8]}→{new_id[:8]}")

    for task in list_tasks("blocked"):
        if is_retriable(task):
            repair(task, "retriable infra failure", "blocked")

    for task in list_tasks("in_progress"):
        if orphan_age_hours(task) >= ORPHAN_HOURS and not has_live_worktree(task):
            repair(task, f"orphaned in_progress >{ORPHAN_HOURS}h, no worktree", "orphan")

    send_digest(state, repaired)
    if not DRY_RUN:
        save_state(state)
    log(f"cycle done — {len(repaired)} repair(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
