#!/usr/bin/env python3
"""Headless cursor -> mupot loop driver (runtime-adapter/v1 reference).

Turns the `cursor` agent into a dispatchable technician that picks up mupot
tasks and returns branches for a human/Kasra gate. Conforms to
runtime-adapter/v1 (scripts/runtime_adapter_v1.py): declared runtime type
`cursor`, server-derived identity/tenant/capability, signed attach domain
`fleet-attach:v1` (bearer attach when no host key), land-at-review contract.

The loop is trustworthy BY CONSTRUCTION: cursor never self-closes a task
(mupot's no-self-close guard, PR #417) and never touches the remote — the
trusted driver does push/PR and moves the task to `review` for Kasra-core to
gate. cursor only writes code in an isolated worktree.

Flow per task (assignee = cursor, status = open):
  0. boot         -> boot_context + attach(runtime=cursor) + Port-1 presence
  1. claim        -> task_update status=in_progress
  2. isolate      -> git worktree add -b cursor/task-<id8> <wt> main
  3. dispatch     -> cursor-agent -p --force --trust --approve-mcps --workspace <wt>
  4. verify       -> cursor must have committed; run tsc (no fake-green)
  5. deliver      -> driver pushes the branch + opens the PR (cursor never does)
  6. report       -> land_at_review (status=review, gate_owner set, PR linked)
  7. notify       -> ping Kasra-core to gate; remove the worktree (keep branch/PR)

The driver NEVER merges or deploys. Kasra-core gates the PR and verdicts the task.

Config (env):
  MUPOT_MCP        default https://mupot.mumega.com/mcp
  MUPOT_API_BASE   default derived from MUPOT_MCP
  CURSOR_TOKEN     default ~/.fleet/agents/cursor-member.token
  CURSOR_KEY       optional ~/.fleet/agents/<agent>.key for signed attach
  REPO             default /home/mumega/mupot
  GATE_OWNER       default 'gate:kasra-core'
  MODEL            optional cursor --model override
  MAX_TASKS        default 1 (per run)
  TIMEOUT          default 1800 (seconds per cursor run)
  SANDBOX          '1' adds --sandbox enabled
  DRY_RUN          '1' = poll + print, do nothing

Usage:
  python3 scripts/cursor-worker.py            # one-shot, up to MAX_TASKS
  DRY_RUN=1 python3 scripts/cursor-worker.py  # show what it would do
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

# Allow `python3 scripts/cursor-worker.py` to import the sibling adapter module.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from runtime_adapter_v1 import (  # noqa: E402
    CONTRACT_ID,
    LAND_AT_STATUS,
    SIGNED_ATTACH_DOMAIN,
    AdapterConfig,
    RuntimeIdentity,
    boot_session,
    claim_in_progress,
    config_from_env,
    land_at_review,
    poll_open_tasks,
    report_blocked,
)

RUNTIME_TYPE = "cursor"
AGENT_TYPE = "builder"
LIFECYCLE = "on_demand"

CURSOR_TOKEN_PATH = Path(os.environ.get("CURSOR_TOKEN", str(Path.home() / ".fleet/agents/cursor-member.token")))
CURSOR_KEY_PATH = Path(os.environ.get("CURSOR_KEY", "")) if os.environ.get("CURSOR_KEY") else None
REPO = Path(os.environ.get("REPO", "/home/mumega/mupot"))
MODEL = os.environ.get("MODEL", "").strip()
MAX_TASKS = int(os.environ.get("MAX_TASKS", "1"))
TIMEOUT = int(os.environ.get("TIMEOUT", "1800"))
SANDBOX = os.environ.get("SANDBOX", "") == "1"
DRY_RUN = os.environ.get("DRY_RUN", "") == "1"

REPO_SLUG = os.environ.get("REPO_SLUG", "Mumega-com/mupot")
WORKTREE_ROOT = Path(os.environ.get("WORKTREE_ROOT", "/home/mumega/mupot-worktrees"))


def log(msg: str) -> None:
    print(f"[cursor-worker] {msg}", flush=True)


def git(*args: str, cwd: Path | None = None, check: bool = True) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env.pop("GITHUB_TOKEN", None)  # gh token shadow guard
    return subprocess.run(
        ["git", *args], cwd=str(cwd or REPO), env=env, check=check, capture_output=True, text=True
    )


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
        f"Dispatched to the `cursor` agent headless via the mupot loop "
        f"({CONTRACT_ID}, runtime={RUNTIME_TYPE}) for task `{task['id']}`.\n\n"
        f"Task done-when: {task.get('done_when','')}\n\n"
        "Driver verified: cursor committed real work + `tsc --noEmit` clean. "
        f"**Kasra-core gates this PR before merge** (task lands at `{LAND_AT_STATUS}`; "
        "cursor cannot self-close it)."
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


def run_task(cfg: AdapterConfig, task: dict) -> None:
    tid = task["id"]
    short = tid.split("-")[0]
    branch = f"cursor/task-{short}"
    worktree = WORKTREE_ROOT / f"cursor-{short}"
    log(f"=== task {short}: {task.get('title','')[:60]} ===")
    if DRY_RUN:
        log("DRY_RUN — would claim, dispatch cursor, verify, PR, review. Skipping.")
        return

    claim_in_progress(cfg, task_id=tid)
    WORKTREE_ROOT.mkdir(parents=True, exist_ok=True)
    git("worktree", "add", "-b", branch, str(worktree), "main")
    try:
        proc = cursor_run(worktree, build_brief(task, worktree, branch))
        log(f"cursor exit {proc.returncode}; output tail:\n{(proc.stdout or '')[-800:]}")
        ok, note = verify(worktree, branch)
        if not ok:
            log(f"verify FAILED: {note}")
            report_blocked(
                cfg,
                task_id=tid,
                body=f"{task.get('body','')}\n\n---\ncursor loop BLOCKED: {note}",
            )
            return
        pr_url = deliver(worktree, branch, task)
        land_at_review(
            cfg,
            task_id=tid,
            body=f"{task.get('body','')}\n\n---\ncursor loop -> {LAND_AT_STATUS}. PR: {pr_url}\n{note}",
        )
        log(f"delivered -> {LAND_AT_STATUS}. PR: {pr_url}")
        _notify_kasra(task, pr_url)
    finally:
        git("worktree", "remove", str(worktree), "--force", cwd=REPO, check=False)
        git("worktree", "prune", cwd=REPO, check=False)


def _notify_kasra(task: dict, pr_url: str) -> None:
    """Best-effort bus ping so Kasra-core gates the PR. Non-fatal if it fails."""
    try:
        subprocess.run(
            ["python3", str(Path.home() / "scripts/bus-send.py"),
             "kasra", f"cursor loop: task {task['id'].split('-')[0]} in review, PR ready to gate: {pr_url}"],
            capture_output=True, text=True, timeout=20,
        )
    except Exception as exc:  # noqa: BLE001 - notify is best-effort
        log(f"notify kasra failed (non-fatal): {exc}")


def main() -> int:
    if not CURSOR_TOKEN_PATH.exists():
        log(f"no cursor token at {CURSOR_TOKEN_PATH}")
        return 2
    cfg = config_from_env(
        token_path=CURSOR_TOKEN_PATH,
        runtime=RUNTIME_TYPE,
        agent_type=AGENT_TYPE,
        user_agent=f"cursor-worker/1.0 (+mupot; {CONTRACT_ID})",
        lifecycle=LIFECYCLE,
        key_path=CURSOR_KEY_PATH,
    )
    log(f"{CONTRACT_ID} attach_domain={SIGNED_ATTACH_DOMAIN} land_at={LAND_AT_STATUS}")
    identity: RuntimeIdentity = boot_session(
        cfg,
        presence_adapter="cursor",
        log=log,
    )
    tasks = poll_open_tasks(cfg, identity, limit=MAX_TASKS)
    log(f"{len(tasks)} open task(s) assigned to cursor ({identity.agent_id})")
    for task in tasks:
        try:
            run_task(cfg, task)
        except Exception as exc:  # noqa: BLE001 - one task's failure must not kill the loop
            log(f"task {task.get('id')} errored: {exc}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
