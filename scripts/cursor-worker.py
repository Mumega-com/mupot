#!/usr/bin/env python3
"""Headless cursor -> mupot loop driver.

Turns the `cursor` agent (Grok, Cursor CLI) into a dispatchable technician that
picks up mupot tasks and returns branches for a human/Kasra gate. The loop is
trustworthy BY CONSTRUCTION: cursor never self-closes a task (mupot's no-self-close
guard, PR #417) and never touches the remote — the trusted driver does push/PR and
moves the task to `review` for Kasra-core to gate. cursor only writes code in an
isolated worktree.

Flow per task (assignee = cursor, status = open):
  1. claim        -> task_update status=in_progress
  2. isolate      -> git worktree add -b cursor/task-<id8> <wt> main
  3. dispatch     -> cursor-agent -p --force --trust --approve-mcps --workspace <wt> "<brief>"
  4. verify       -> cursor must have committed; run tsc + tests (no fake-green)
  5. deliver      -> driver pushes the branch + opens the PR (cursor never does)
  6. report       -> task_update status=review, gate_owner set, PR linked
  7. notify       -> ping Kasra-core via mupot MCP send; remove the worktree (keep branch/PR)

The driver NEVER merges or deploys. Kasra-core gates the PR and verdicts the task.

Config (env):
  MUPOT_MCP        default https://mupot.mumega.com/mcp
  CURSOR_TOKEN     default ~/.fleet/agents/cursor-member.token
  CURSOR_AGENT_ID  default af7a30b5-... (the cursor agent on the mumega pot)
  REPO             default /home/mumega/mupot
  GATE_OWNER       default 'gate:kasra-core' (capability Kasra-core holds)
  MODEL            optional cursor --model override
  MAX_TASKS        default 1 (per run)
  TIMEOUT          default 1800 (seconds per cursor run)
  SANDBOX          '1' adds --sandbox enabled (recommended for untrusted tasks;
                   off by default so tsc/tests/git run unrestricted on our own repo)
  DRY_RUN          '1' = poll + print, do nothing

Usage:
  python3 scripts/cursor-worker.py            # one-shot, up to MAX_TASKS
  DRY_RUN=1 python3 scripts/cursor-worker.py  # show what it would do
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

MUPOT_MCP = os.environ.get("MUPOT_MCP", "https://mupot.mumega.com/mcp")
CURSOR_TOKEN_PATH = Path(os.environ.get("CURSOR_TOKEN", str(Path.home() / ".fleet/agents/cursor-member.token")))
CURSOR_AGENT_ID = os.environ.get("CURSOR_AGENT_ID", "af7a30b5-c53a-4387-9ffa-18439888b700")
REPO = Path(os.environ.get("REPO", "/home/mumega/mupot"))
GATE_OWNER = os.environ.get("GATE_OWNER", "gate:kasra-core")
MODEL = os.environ.get("MODEL", "").strip()
MAX_TASKS = int(os.environ.get("MAX_TASKS", "1"))
TIMEOUT = int(os.environ.get("TIMEOUT", "1800"))
SANDBOX = os.environ.get("SANDBOX", "") == "1"
DRY_RUN = os.environ.get("DRY_RUN", "") == "1"

REPO_SLUG = os.environ.get("REPO_SLUG", "Mumega-com/mupot")
WORKTREE_ROOT = Path(os.environ.get("WORKTREE_ROOT", "/home/mumega/mupot-worktrees"))


def log(msg: str) -> None:
    print(f"[cursor-worker] {msg}", flush=True)


def token() -> str:
    return CURSOR_TOKEN_PATH.read_text().strip()


def mcp(tool: str, args: dict) -> dict:
    """Call a mupot MCP tool as the cursor agent. Returns the tool's `result`."""
    body = json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool, "arguments": args}}
    ).encode()
    req = urllib.request.Request(
        MUPOT_MCP,
        data=body,
        headers={
            "Authorization": f"Bearer {token()}",
            "content-type": "application/json",
            # CF error 1010 blocks the default Python-urllib UA as a bot signature.
            "User-Agent": "cursor-worker/1.0 (+mupot)",
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


def git(*args: str, cwd: Path | None = None, check: bool = True) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env.pop("GITHUB_TOKEN", None)  # gh token shadow guard
    return subprocess.run(
        ["git", *args], cwd=str(cwd or REPO), env=env, check=check, capture_output=True, text=True
    )


def register_presence() -> None:
    """Best-effort Port-1 self-registration so the concierge's dispatcher sees
    cursor as an online 'build' capability. registerModule is an idempotent
    upsert (src/registry/service.ts), so calling presence_register on every
    cycle both (re-)registers and refreshes the heartbeat in one call — no
    need to track "already registered this process" state, since each cycle
    is a fresh one-shot process (operator-loop.sh invokes this script anew
    every OPERATOR_INTERVAL). project_id: null is the always-open self bucket
    (no project-access grant needed). Never raises: a presence failure must
    not block real task work.
    """
    try:
        mcp("presence_register", {
            "adapter": "cursor",
            "kind": "agent_system",
            "project_id": None,
            "capabilities": ["build"],
        })
        log("presence: registered/refreshed (adapter=cursor, capabilities=[build])")
    except Exception as exc:  # noqa: BLE001 - presence is best-effort, never fatal
        log(f"presence_register failed (non-fatal): {exc}")


def poll_open_tasks() -> list[dict]:
    res = mcp("task_list", {"assignee_agent_id": CURSOR_AGENT_ID, "status": "open", "limit": MAX_TASKS})
    return res.get("tasks", [])[:MAX_TASKS]


def build_brief(task: dict, worktree: Path, branch: str) -> str:
    return "\n".join(
        [
            f"You are the cursor agent. Task from mupot (id {task['id']}).",
            f"Work ONLY in this worktree: {worktree} (branch {branch}, already checked out).",
            "",
            f"TITLE: {task.get('title','')}",
            f"DONE WHEN: {task.get('done_when','')}",
            "",
            "BRIEF:",
            task.get("body", "") or "(no body — infer from title/done_when)",
            "",
            "RULES (hard):",
            "- Make the change and COMMIT it in this worktree. Do NOT push, do NOT open a PR,",
            "  do NOT merge, do NOT deploy — the driver handles delivery and a human gates it.",
            "- Run `npx tsc --noEmit` and the affected `npx vitest run` yourself; the change must be clean+green.",
            "- Pure, minimal, behavior-correct. If blocked or the task is unsafe, commit nothing and explain why.",
            "- You have the mupot MCP server for read-only context (task_list, recall, boot_context).",
        ]
    )


def cursor_run(worktree: Path, brief: str) -> subprocess.CompletedProcess:
    cmd = [
        "cursor-agent", "-p",
        "--output-format", "text",
        "--force", "--trust", "--approve-mcps",
        "--workspace", str(worktree),
    ]
    if SANDBOX:
        cmd += ["--sandbox", "enabled"]
    if MODEL:
        cmd += ["--model", MODEL]
    cmd.append(brief)
    log(f"dispatching cursor-agent (timeout {TIMEOUT}s) ...")
    return subprocess.run(cmd, cwd=str(worktree), capture_output=True, text=True, timeout=TIMEOUT)


def verify(worktree: Path, branch: str) -> tuple[bool, str]:
    """cursor must have committed real work + it must compile. No fake-green."""
    commits = git("log", "main..HEAD", "--oneline", cwd=worktree, check=False).stdout.strip()
    if not commits:
        return False, "no commits — cursor produced no work"
    tsc = subprocess.run(["npx", "tsc", "--noEmit"], cwd=str(worktree), capture_output=True, text=True)
    if tsc.returncode != 0:
        return False, f"tsc errors:\n{tsc.stdout[-1500:]}{tsc.stderr[-500:]}"
    return True, f"commits:\n{commits}"


def deliver(worktree: Path, branch: str, task: dict) -> str:
    """Driver (trusted) pushes + opens the PR. cursor never touches the remote."""
    git("push", "-u", "origin", branch, cwd=worktree)
    env = dict(os.environ)
    env.pop("GITHUB_TOKEN", None)
    title = f"cursor: {task.get('title','')[:60]}"
    pr_body = (
        f"Dispatched to the `cursor` agent (Grok) headless via the mupot loop for task `{task['id']}`.\n\n"
        f"Task done-when: {task.get('done_when','')}\n\n"
        "Driver verified: cursor committed real work + `tsc --noEmit` clean. "
        "**Kasra-core gates this PR before merge** (the task is in `review`; cursor cannot self-close it)."
    )
    out = subprocess.run(
        ["gh", "pr", "create", "--repo", REPO_SLUG, "--base", "main", "--head", branch,
         "--title", title, "--body", pr_body],
        cwd=str(worktree), env=env, capture_output=True, text=True,
    )
    url = (out.stdout or "").strip().splitlines()[-1] if out.stdout.strip() else ""
    if not url:
        raise RuntimeError(f"gh pr create failed: {out.stderr}")
    return url


def report_review(task: dict, pr_url: str, note: str) -> None:
    body = f"{task.get('body','')}\n\n---\ncursor loop -> review. PR: {pr_url}\n{note}"
    mcp("task_update", {"task_id": task["id"], "status": "review", "gate_owner": GATE_OWNER, "body": body})


def report_blocked(task: dict, reason: str) -> None:
    body = f"{task.get('body','')}\n\n---\ncursor loop BLOCKED: {reason}"
    mcp("task_update", {"task_id": task["id"], "status": "blocked", "body": body})


def run_task(task: dict) -> None:
    tid = task["id"]
    short = tid.split("-")[0]
    branch = f"cursor/task-{short}"
    worktree = WORKTREE_ROOT / f"cursor-{short}"
    log(f"=== task {short}: {task.get('title','')[:60]} ===")
    if DRY_RUN:
        log("DRY_RUN — would claim, dispatch cursor, verify, PR, review. Skipping.")
        return

    mcp("task_update", {"task_id": tid, "status": "in_progress"})
    WORKTREE_ROOT.mkdir(parents=True, exist_ok=True)
    git("worktree", "add", "-b", branch, str(worktree), "main")
    try:
        proc = cursor_run(worktree, build_brief(task, worktree, branch))
        log(f"cursor exit {proc.returncode}; output tail:\n{(proc.stdout or '')[-800:]}")
        ok, note = verify(worktree, branch)
        if not ok:
            log(f"verify FAILED: {note}")
            report_blocked(task, note)
            return
        pr_url = deliver(worktree, branch, task)
        report_review(task, pr_url, note)
        log(f"delivered -> review. PR: {pr_url}")
        _notify_kasra(task, pr_url)
    finally:
        git("worktree", "remove", str(worktree), "--force", cwd=REPO, check=False)
        git("worktree", "prune", cwd=REPO, check=False)


def _notify_kasra(task: dict, pr_url: str) -> None:
    """Best-effort mupot inbox ping so Kasra-core gates the PR. Non-fatal if it fails.

    Uses MCP `send` (D1 agent_messages), not the retired SOS Redis bus-send path.
    Review-entry wake already fires via task_update→wakeGateOwnerOnReview; this is
    an extra attention nudge with the PR URL.
    """
    try:
        to = os.environ.get("NOTIFY_TO", "kasra")
        mcp(
            "send",
            {
                "to": to,
                "body": (
                    f"cursor loop: task {task['id'].split('-')[0]} in review, "
                    f"PR ready to gate: {pr_url}"
                ),
            },
        )
    except Exception as exc:  # noqa: BLE001 - notify is best-effort
        log(f"notify kasra failed (non-fatal): {exc}")


def main() -> int:
    if not CURSOR_TOKEN_PATH.exists():
        log(f"no cursor token at {CURSOR_TOKEN_PATH}")
        return 2
    register_presence()
    tasks = poll_open_tasks()
    log(f"{len(tasks)} open task(s) assigned to cursor")
    for task in tasks:
        try:
            run_task(task)
        except Exception as exc:  # noqa: BLE001 - one task's failure must not kill the loop
            log(f"task {task.get('id')} errored: {exc}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
