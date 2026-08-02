#!/usr/bin/env python3
"""Headless codex -> mupot loop driver.

Turns the `codex` agent (Codex CLI) into a dispatchable technician that picks
up mupot tasks and returns branches for a human/Kasra gate. Same trust shape
as cursor-worker.py: codex never self-closes a task and never touches the
remote — the trusted driver does push/PR and moves the task to `review` for
Kasra-core to gate. codex only writes code in an isolated worktree.

Default model is the small/cheap tier (gpt-5.3-codex-spark, canary-verified
2026-08-02): the loop philosophy is decision/execution split — cheap models
execute the majority of work, the expensive gate decides what merges.

Flow per task (assignee = codex, status = open):
  1. claim        -> task_update status=in_progress
  2. isolate      -> git worktree add -b codex/task-<id8> <wt> main
  3. dispatch     -> codex exec --cd <wt> --sandbox danger-full-access -m <model> "<brief>"
  4. verify       -> codex must have committed; run tsc (no fake-green)
  5. deliver      -> driver pushes the branch + opens the PR (codex never does)
  6. report       -> task_update status=review, gate_owner set, PR linked
  7. notify       -> ping Kasra-core via mupot MCP send; remove the worktree

The driver NEVER merges or deploys. Kasra-core gates the PR and verdicts the task.

Config (env):
  MUPOT_MCP           default https://mupot.mumega.com/mcp
  CODEX_TOKEN         default ~/.fleet/agents/codex-member.token
  CODEX_AGENT_ID      default 1eb0e718-... (the codex agent on the mumega pot)
  REPO                default /home/mumega/mupot
  GATE_OWNER          default 'gate:kasra-core'
  CODEX_WORKER_MODEL  default 'gpt-5.3-codex-spark' ('' = harness default)
  MAX_TASKS           default 1 (per run)
  TIMEOUT             default 1800 (seconds per codex run)
  DRY_RUN             '1' = poll + print, do nothing

Usage:
  python3 scripts/codex-worker.py            # one-shot, up to MAX_TASKS
  DRY_RUN=1 python3 scripts/codex-worker.py  # show what it would do
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

MUPOT_MCP = os.environ.get("MUPOT_MCP", "https://mupot.mumega.com/mcp")
CODEX_TOKEN_PATH = Path(os.environ.get("CODEX_TOKEN", str(Path.home() / ".fleet/agents/codex-member.token")))
CODEX_AGENT_ID = os.environ.get("CODEX_AGENT_ID", "1eb0e718-3799-48d9-b468-926da7905b45")
REPO = Path(os.environ.get("REPO", "/home/mumega/mupot"))
GATE_OWNER = os.environ.get("GATE_OWNER", "gate:kasra-core")
MODEL = os.environ.get("CODEX_WORKER_MODEL", "gpt-5.3-codex-spark").strip()
MAX_TASKS = int(os.environ.get("MAX_TASKS", "1"))
TIMEOUT = int(os.environ.get("TIMEOUT", "1800"))
DRY_RUN = os.environ.get("DRY_RUN", "") == "1"

REPO_SLUG = os.environ.get("REPO_SLUG", "Mumega-com/mupot")
WORKTREE_ROOT = Path(os.environ.get("WORKTREE_ROOT", "/home/mumega/mupot-worktrees"))


def log(msg: str) -> None:
    print(f"[codex-worker] {msg}", flush=True)


def token() -> str:
    return CODEX_TOKEN_PATH.read_text().strip()


def mcp(tool: str, args: dict) -> dict:
    """Call a mupot MCP tool as the codex agent. Returns the tool's `result`."""
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
            "User-Agent": "codex-worker/1.0 (+mupot)",
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
    """Best-effort Port-1 self-registration; idempotent upsert, never fatal.

    Capability tags must match src/tasks/effort-route.ts HARNESS_CAPABILITIES
    for slug=codex: build + review.
    """
    try:
        mcp("presence_register", {
            "adapter": "codex",
            "kind": "agent_system",
            "project_id": None,
            "capabilities": ["build", "review"],
        })
        log("presence: registered/refreshed (adapter=codex, capabilities=[build,review])")
    except Exception as exc:  # noqa: BLE001 - presence is best-effort, never fatal
        log(f"presence_register failed (non-fatal): {exc}")


def poll_open_tasks() -> list[dict]:
    res = mcp("task_list", {"assignee_agent_id": CODEX_AGENT_ID, "status": "open", "limit": MAX_TASKS})
    return res.get("tasks", [])[:MAX_TASKS]


def build_brief(task: dict, worktree: Path, branch: str) -> str:
    return "\n".join(
        [
            f"You are the codex agent. Task from mupot (id {task['id']}).",
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
        ]
    )


def codex_run(worktree: Path, brief: str) -> subprocess.CompletedProcess:
    # --full-auto wraps codex in a bwrap sandbox, which cannot create its network
    # namespace on this host (bwrap: loopback: Failed RTM_NEWADDR — Ubuntu
    # unprivileged-userns restriction), so every write in the run fails.
    # Containment here is the isolated worktree + no-remote-access + PR gate,
    # same trust level as athena-worker (--force --trust) and claude-worker
    # (--dangerously-skip-permissions). Hadi-approved 2026-08-02 (option A).
    cmd = ["codex", "exec", "--cd", str(worktree), "--sandbox", "danger-full-access"]
    if MODEL:
        cmd += ["-m", MODEL]
    cmd.append(brief)
    log(f"dispatching codex exec (model={MODEL or 'default'}, timeout {TIMEOUT}s) ...")
    return subprocess.run(cmd, cwd=str(worktree), capture_output=True, text=True, timeout=TIMEOUT)


def verify(worktree: Path, branch: str) -> tuple[bool, str]:
    """codex must have committed real work + it must compile. No fake-green."""
    commits = git("log", "main..HEAD", "--oneline", cwd=worktree, check=False).stdout.strip()
    if not commits:
        return False, "no commits — codex produced no work"
    tsc = subprocess.run(["npx", "tsc", "--noEmit"], cwd=str(worktree), capture_output=True, text=True)
    if tsc.returncode != 0:
        return False, f"tsc errors:\n{tsc.stdout[-1500:]}{tsc.stderr[-500:]}"
    return True, f"commits:\n{commits}"


def deliver(worktree: Path, branch: str, task: dict) -> str:
    """Driver (trusted) pushes + opens the PR. codex never touches the remote."""
    git("push", "-u", "origin", branch, cwd=worktree)
    env = dict(os.environ)
    env.pop("GITHUB_TOKEN", None)
    title = f"codex: {task.get('title','')[:60]}"
    pr_body = (
        f"Dispatched to the `codex` agent ({MODEL or 'codex default'}) headless via the mupot loop "
        f"for task `{task['id']}`.\n\n"
        f"Task done-when: {task.get('done_when','')}\n\n"
        "Driver verified: codex committed real work + `tsc --noEmit` clean. "
        "**Kasra-core gates this PR before merge** (the task is in `review`; codex cannot self-close it)."
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
    body = f"{task.get('body','')}\n\n---\ncodex loop -> review. PR: {pr_url}\n{note}"
    mcp("task_update", {"task_id": task["id"], "status": "review", "gate_owner": GATE_OWNER, "body": body})


def report_blocked(task: dict, reason: str) -> None:
    body = f"{task.get('body','')}\n\n---\ncodex loop BLOCKED: {reason}"
    mcp("task_update", {"task_id": task["id"], "status": "blocked", "body": body})


def run_task(task: dict) -> None:
    tid = task["id"]
    short = tid.split("-")[0]
    branch = f"codex/task-{short}"
    worktree = WORKTREE_ROOT / f"codex-{short}"
    log(f"=== task {short}: {task.get('title','')[:60]} ===")
    if DRY_RUN:
        log("DRY_RUN — would claim, dispatch codex, verify, PR, review. Skipping.")
        return

    mcp("task_update", {"task_id": tid, "status": "in_progress"})
    WORKTREE_ROOT.mkdir(parents=True, exist_ok=True)
    git("worktree", "add", "-b", branch, str(worktree), "main")
    try:
        proc = codex_run(worktree, build_brief(task, worktree, branch))
        log(f"codex exit {proc.returncode}; output tail:\n{(proc.stdout or '')[-800:]}")
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
    """Best-effort mupot inbox ping so Kasra-core gates the PR. Non-fatal if it fails."""
    try:
        to = os.environ.get("NOTIFY_TO", "kasra")
        mcp(
            "send",
            {
                "to": to,
                "body": (
                    f"codex loop: task {task['id'].split('-')[0]} in review, "
                    f"PR ready to gate: {pr_url}"
                ),
            },
        )
    except Exception as exc:  # noqa: BLE001 - notify is best-effort
        log(f"notify kasra failed (non-fatal): {exc}")


def main() -> int:
    if not CODEX_TOKEN_PATH.exists():
        log(f"no codex token at {CODEX_TOKEN_PATH}")
        return 2
    register_presence()
    tasks = poll_open_tasks()
    log(f"{len(tasks)} open task(s) assigned to codex")
    for task in tasks:
        try:
            run_task(task)
        except Exception as exc:  # noqa: BLE001 - one task's failure must not kill the loop
            log(f"task {task.get('id')} errored: {exc}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
