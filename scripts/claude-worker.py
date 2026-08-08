#!/usr/bin/env python3
"""Headless claude -> mupot loop driver (small-model execution lane).

Claims `open` build tasks the CLAUDE TECHNICIAN may own: tasks UNASSIGNED on the
board, or tasks assigned to the claude technician's own agent id (CLAUDE_AGENT_ID).
It runs them with a CHEAP Claude model (default: haiku). Same trust shape as
cursor-worker.py: the model never self-closes a task and never touches the remote —
the trusted driver does push/PR and moves the task to `review` for Kasra-core to gate.

Claim fence (mupot #742): a technician NEVER claims a task whose
assignee_agent_id is set and != its own agent id. This lane historically
impersonated kasra (KASRA_AGENT_ID=c855f82c) and claimed kasra's tasks — the
live double-dispatch that built a broken TS parallel on a kasra-assigned task
(mumega-com#740). The impersonation is removed: kasra-assigned tasks are
invisible to this lane; only unassigned (or claude-own) tasks are claimable.

Gate tasks are naturally excluded: the gate lane lives in status=review, and this
driver polls status=open only. A cheap model doing the work changes nothing about
what merges — the gate does.

Flow per task (assignee = null or claude, status = open):
  1. claim        -> task_update status=in_progress
  2. isolate      -> git worktree add -b claude/task-<id8> <wt> main
  3. dispatch     -> claude -p --model <model> --dangerously-skip-permissions "<brief>"
  4. verify       -> claude must have committed; run tsc (no fake-green)
  5. deliver      -> driver pushes the branch + opens the PR
  6. report       -> task_update status=review, gate_owner set, PR linked
  7. notify       -> ping Kasra-core via mupot MCP send; remove the worktree

The driver NEVER merges or deploys. Kasra-core gates the PR and verdicts the task.

Config (env):
  MUPOT_MCP            default https://mupot.mumega.com/mcp
  KASRA_TOKEN          default ~/.fleet/agents/kasra-agent.token
                       (driver auth for delivery/gate ops; replace with a dedicated
                       claude-technician token when the claude agent is minted, #742)
  CLAUDE_AGENT_ID      default '' — the claude technician's OWN agent id; '' means
                       only UNASSIGNED tasks are claimable (never kasra's / anyone
                       else's). Set to the claude technician's own id when minted.
  REPO                 default /home/mumega/mupot
  GATE_OWNER           default 'gate:kasra-core'
  CLAUDE_WORKER_MODEL  default 'haiku' ('' = harness default)
  MAX_TASKS            default 1 (per run)
  TIMEOUT              default 1800 (seconds per claude run)
  DRY_RUN              '1' = poll + print, do nothing

Usage:
  python3 scripts/claude-worker.py            # one-shot, up to MAX_TASKS
  DRY_RUN=1 python3 scripts/claude-worker.py  # show what it would do
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

# Claim fence (#742): shared with all operator-loop technicians.
sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
from claim_fence import claimable

MUPOT_MCP = os.environ.get("MUPOT_MCP", "https://mupot.mumega.com/mcp")
KASRA_TOKEN_PATH = Path(os.environ.get("KASRA_TOKEN", str(Path.home() / ".fleet/agents/kasra-agent.token")))
# The claude technician's OWN agent id on the mumega pot. This lane used to
# impersonate kasra (KASRA_AGENT_ID=c855f82c) — that impersonation is the
# double-dispatch root cause (mupot #742): it let the lane claim tasks the
# operator explicitly assigned to kasra and build broken parallels. The lane
# now claims ONLY tasks assigned to its own id, or UNASSIGNED tasks. Default
# "" = no own-assigned lane yet, so only unassigned tasks are claimable;
# set CLAUDE_AGENT_ID to the claude technician's own agent id when minted.
CLAUDE_AGENT_ID = os.environ.get("CLAUDE_AGENT_ID", "")
REPO = Path(os.environ.get("REPO", "/home/mumega/mupot"))
GATE_OWNER = os.environ.get("GATE_OWNER", "gate:kasra-core")
MODEL = os.environ.get("CLAUDE_WORKER_MODEL", "haiku").strip()
MAX_TASKS = int(os.environ.get("MAX_TASKS", "1"))
TIMEOUT = int(os.environ.get("TIMEOUT", "1800"))
DRY_RUN = os.environ.get("DRY_RUN", "") == "1"

REPO_SLUG = os.environ.get("REPO_SLUG", "Mumega-com/mupot")
WORKTREE_ROOT = Path(os.environ.get("WORKTREE_ROOT", "/home/mumega/mupot-worktrees"))


def log(msg: str) -> None:
    print(f"[claude-worker] {msg}", flush=True)


def token() -> str:
    return KASRA_TOKEN_PATH.read_text().strip()


def mcp(tool: str, args: dict) -> dict:
    """Call a mupot MCP tool as the kasra agent. Returns the tool's `result`."""
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
            "User-Agent": "claude-worker/1.0 (+mupot)",
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


CODE_SUFFIXES = (".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx", ".json", ".sql")
BODY_MAX_CHARS = 60_000


def _link_node_modules(worktree: Path) -> None:
    """Fresh worktrees share the repo's .git but NOT node_modules, so `npx tsc`
    resolves the wrong package ("This is not the tsc command you are looking
    for") and verify fails on every task. Symlink the repo's install into the
    worktree; skip silently if the repo has none."""
    src = (REPO / "node_modules").resolve()
    dst = worktree / "node_modules"
    if src.is_dir() and not dst.exists():
        dst.symlink_to(src)


def _cap_body(body: str) -> str:
    """The mupot endpoint rejects oversized requests (HTTP 413), and a lost
    receipt means the task gets re-processed every cycle. Budget the JSON-
    ENCODED size (escaping inflates newline-heavy bodies), keep the head
    (original statement) plus the newest receipts tail, and cut the tail at a
    receipt boundary so the newest receipt survives complete with its marker."""
    def encoded_len(s: str) -> int:
        return len(json.dumps(s).encode())

    if encoded_len(body) <= BODY_MAX_CHARS:
        return body
    head = body[:4000]
    tail_budget = BODY_MAX_CHARS - encoded_len(head) - 200
    tail = body[-max(tail_budget // 2, 4000):]
    while encoded_len(tail) > tail_budget and len(tail) > 1000:
        tail = tail[len(tail) // 4:]
    boundary = tail.find("\n---\n")
    if 0 <= boundary <= len(tail) // 2:
        tail = tail[boundary:]
    return (
        head
        + "\n\n... [task body truncated: server request cap; newest receipts kept below] ...\n"
        + tail
    )


def poll_open_tasks() -> list[dict]:
    # Fetch a bounded window, then fence-filter and cap at MAX_TASKS. Slicing to
    # MAX_TASKS BEFORE the fence would let one non-claimable ranked task starve
    # every claimable one behind it (the lane would idle on an assigned task it
    # must skip).
    args: dict = {"status": "open", "limit": max(MAX_TASKS, 25)}
    if CLAUDE_AGENT_ID:
        args["assignee_agent_id"] = CLAUDE_AGENT_ID
    res = mcp("task_list", args)
    tasks = res.get("tasks", [])
    # Claim fence (#742): keep only tasks this technician may claim (unassigned,
    # or assigned to the claude technician's own agent id).
    return [t for t in tasks if claimable(t, CLAUDE_AGENT_ID)[0]][:MAX_TASKS]


def build_brief(task: dict, worktree: Path, branch: str) -> str:
    return "\n".join(
        [
            # ── stable prefix (see tech-grok-worker.build_brief for why order matters)
            "You are a headless build lane for the kasra agent, working a task from mupot.",
            "",
            "RULES (hard):",
            "- Make the change and COMMIT it in this worktree. Do NOT push, do NOT open a PR,",
            "  do NOT merge, do NOT deploy — the driver handles delivery and a human gates it.",
            "- Run `npx tsc --noEmit` and the affected `npx vitest run` yourself; the change must be clean+green.",
            "- Pure, minimal, behavior-correct. If blocked or the task is unsafe, commit nothing and explain why.",
            "",
            # ── per-task tail: everything below changes every dispatch ──────────────
            f"TASK ID: {task['id']}",
            f"WORKTREE: {worktree} (branch {branch}, already checked out) — work ONLY here.",
            "",
            f"TITLE: {task.get('title','')}",
            f"DONE WHEN: {task.get('done_when','')}",
            "",
            "BRIEF:",
            task.get("body", "") or "(no body — infer from title/done_when)",
        ]
    )


def claude_run(worktree: Path, brief: str) -> subprocess.CompletedProcess:
    cmd = ["claude", "-p", "--dangerously-skip-permissions"]
    if MODEL:
        cmd += ["--model", MODEL]
    cmd.append(brief)
    log(f"dispatching claude -p (model={MODEL or 'default'}, timeout {TIMEOUT}s) ...")
    return subprocess.run(cmd, cwd=str(worktree), capture_output=True, text=True, timeout=TIMEOUT)


def verify(worktree: Path, branch: str) -> tuple[bool, str]:
    """claude must have committed real work + it must compile. No fake-green."""
    commits = git("log", "main..HEAD", "--oneline", cwd=worktree, check=False).stdout.strip()
    if not commits:
        return False, "no commits — claude produced no work"
    status_out = git("diff", "--name-status", "-M", "main..HEAD", cwd=worktree, check=False).stdout
    changed = [f for line in status_out.splitlines() for f in line.split("\t")[1:]]
    if changed and not any(f.endswith(CODE_SUFFIXES) for f in changed):
        return True, f"docs-only diff — tsc skipped\ncommits:\n{commits}"
    _link_node_modules(worktree)
    tsc = subprocess.run(["npx", "tsc", "--noEmit"], cwd=str(worktree), capture_output=True, text=True)
    if tsc.returncode != 0:
        return False, f"tsc errors:\n{tsc.stdout[-1500:]}{tsc.stderr[-500:]}"
    return True, f"commits:\n{commits}"


def deliver(worktree: Path, branch: str, task: dict) -> str:
    """Driver (trusted) pushes + opens the PR. The model never touches the remote."""
    git("push", "-u", "origin", branch, cwd=worktree)
    env = dict(os.environ)
    env.pop("GITHUB_TOKEN", None)
    title = f"claude: {task.get('title','')[:60]}"
    pr_body = (
        f"Dispatched to the claude small-model lane ({MODEL or 'default'}) headless via the mupot loop "
        f"for task `{task['id']}` (unassigned, or assigned to the claude technician).\n\n"
        f"Task done-when: {task.get('done_when','')}\n\n"
        "Driver verified: the model committed real work + `tsc --noEmit` clean. "
        "**Kasra-core gates this PR before merge** (the task is in `review`; the lane cannot self-close it)."
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
    body = f"{task.get('body','')}\n\n---\nclaude loop -> review. PR: {pr_url}\n{note}"
    mcp("task_update", {"task_id": task["id"], "status": "review", "gate_owner": GATE_OWNER, "body": _cap_body(body)})


def report_blocked(task: dict, reason: str) -> None:
    body = f"{task.get('body','')}\n\n---\nclaude loop BLOCKED: {reason}"
    mcp("task_update", {"task_id": task["id"], "status": "blocked", "body": _cap_body(body)})


def run_task(task: dict) -> None:
    tid = task["id"]
    short = tid.split("-")[0]
    branch = f"claude/task-{short}"
    worktree = WORKTREE_ROOT / f"claude-{short}"
    log(f"=== task {short}: {task.get('title','')[:60]} ===")
    if DRY_RUN:
        log("DRY_RUN — would claim, dispatch claude, verify, PR, review. Skipping.")
        return

    # Claim fence (#742): never claim a task explicitly assigned to a DIFFERENT
    # agent (e.g. kasra); unassigned tasks (assignee null) remain claimable.
    may_claim, skip_reason = claimable(task, CLAUDE_AGENT_ID)
    if not may_claim:
        log(f"SKIP task {short}: {skip_reason}")
        return

    mcp("task_update", {"task_id": tid, "status": "in_progress"})
    WORKTREE_ROOT.mkdir(parents=True, exist_ok=True)
    git("worktree", "add", "-b", branch, str(worktree), "main")
    _link_node_modules(worktree)
    try:
        proc = claude_run(worktree, build_brief(task, worktree, branch))
        log(f"claude exit {proc.returncode}; output tail:\n{(proc.stdout or '')[-800:]}")
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
                    f"claude loop: task {task['id'].split('-')[0]} in review, "
                    f"PR ready to gate: {pr_url}"
                ),
            },
        )
    except Exception as exc:  # noqa: BLE001 - notify is best-effort
        log(f"notify kasra failed (non-fatal): {exc}")


def main() -> int:
    if not KASRA_TOKEN_PATH.exists():
        log(f"no kasra token at {KASRA_TOKEN_PATH}")
        return 2
    if CLAUDE_AGENT_ID:
        # Orphan visibility only makes sense for the lane's own-assigned tasks; with
        # no dedicated claude agent yet (CLAUDE_AGENT_ID unset) the lane claims only
        # unassigned tasks and there is no orphan class to warn about.
        try:
            stuck = mcp("task_list", {"assignee_agent_id": CLAUDE_AGENT_ID, "status": "in_progress", "limit": 5}).get("tasks", [])
            for s_task in stuck:
                log(
                    f"WARNING orphaned in_progress task {s_task['id'][:8]} "
                    f"({s_task.get('title', '')[:50]}) — likely a SIGTERMed dispatch; the status "
                    f"machine has no requeue transition, re-issue it manually"
                )
        except Exception:  # noqa: BLE001 - orphan check is advisory, never fatal
            pass
    tasks = poll_open_tasks()
    log(f"{len(tasks)} open task(s) claimable by the claude lane")
    for task in tasks:
        try:
            run_task(task)
        except Exception as exc:  # noqa: BLE001 - one task's failure must not kill the loop
            log(f"task {task.get('id')} errored: {exc}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
