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

CAGED EXECUTION (2026-08-03, per codex's own security audit): the model
subprocess runs as the dedicated low-privilege user ``lane-codex`` with an
empty environment — it cannot read mumega's home, tokens, or services, and
holds only its own codex OAuth. The model gets a git-less COPY of the
worktree in /home/lane-codex/work; the trusted driver rsyncs changes back,
commits, verifies, and delivers. The model never touches git or the remote.

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
            "Work ONLY in your current directory (a snapshot of the repo prepared for you).",
            "",
            f"TITLE: {task.get('title','')}",
            f"DONE WHEN: {task.get('done_when','')}",
            "",
            "BRIEF:",
            task.get("body", "") or "(no body — infer from title/done_when)",
            "",
            "RULES (hard):",
            "- Edit files in this directory to complete the task. There is NO git here and no",
            "  network remotes — the trusted driver diffs your changes, commits, and delivers;",
            "  a human gates the PR. Do not attempt git/push/PR/deploy. CONTEXT.md has recent history.",
            "- Run `npx tsc --noEmit` and the affected `npx vitest run` yourself; node_modules is",
            "  provided. The change must be clean+green before you finish.",
            "- Write a one-paragraph summary of WHAT you changed and WHY to .lane-summary.md",
            "  in the directory root — the driver uses it as the commit body.",
            "- Pure, minimal, behavior-correct. If blocked or the task is unsafe, change nothing",
            "  except .lane-summary.md explaining why.",
        ]
    )


LANE_USER = os.environ.get("LANE_USER", "lane-codex")
LANE_WORK_ROOT = Path(os.environ.get("LANE_WORK_ROOT", "/home/lane-codex/work"))
LANE_CODEX_BIN = os.environ.get("LANE_CODEX_BIN", "/usr/local/bin/codex")


def _cage_dir(short: str) -> Path:
    return LANE_WORK_ROOT / f"task-{short}"


def _cage_out(worktree: Path, short: str) -> Path:
    """Copy the checkout (minus .git) into the cage, owned by the lane user."""
    cage = _cage_dir(short)
    subprocess.run(["sudo", "-n", "rm", "-rf", str(cage)], check=True)
    subprocess.run(["sudo", "-n", "mkdir", "-p", str(cage)], check=True)
    subprocess.run(
        ["sudo", "-n", "rsync", "-a", "--exclude=.git", f"{worktree}/", f"{cage}/"],
        check=True,
    )
    subprocess.run(["sudo", "-n", "chown", "-R", f"{LANE_USER}:{LANE_USER}", str(cage)], check=True)
    # Working deps: shared read-mostly store owned by the lane (refreshed out of
    # band when the lockfile changes). Without this the model cannot run
    # tsc/vitest and edits blind — the crippled-sandbox failure mode.
    subprocess.run(
        ["sudo", "-n", "-u", LANE_USER, "ln", "-sfn",
         f"/home/{LANE_USER}/deps/node_modules", str(cage / "node_modules")],
        check=False,
    )
    return cage


class HostileCageOutput(RuntimeError):
    """The cage returned something the driver must not process (symlink attack)."""


# The cage runs untrusted model output; the driver is trusted and holds every
# repo credential. A symlink crossing that boundary turns the driver into the
# model's file-read primitive: the model writes `.lane-summary.md -> /home/
# mumega/.fleet/agents/<token>`, rsync -a faithfully recreates the *link*, and
# any driver-side read follows it straight out of the repo and into a pushed
# commit body. The repo tracks zero symlinks (`git ls-tree -r main` mode 120000
# == 0), so the driver refuses all of them rather than trying to classify safe
# ones. The single exception is the root node_modules link the driver itself
# creates for tsc/vitest — never something the cage can author, since
# node_modules is excluded from the sync in both directions.
_ALLOWED_LINKS = {"node_modules"}


def _reject_symlinks(worktree: Path) -> None:
    """Refuse any symlink the cage produced. Fail loud, never silently strip."""
    offenders = []
    for path in worktree.rglob("*"):
        if not path.is_symlink():
            continue
        rel = path.relative_to(worktree)
        if rel.parts and rel.parts[0] == ".git":
            continue
        if str(rel) in _ALLOWED_LINKS:
            continue
        offenders.append(f"{rel} -> {os.readlink(path)}")
    if offenders:
        raise HostileCageOutput(
            "cage returned symlink(s); refusing to process the delivery: "
            + "; ".join(sorted(offenders))
        )


def _cage_back(worktree: Path, short: str) -> None:
    """Bring the model's edits back into the driver's worktree (driver commits).

    --safe-links drops links resolving outside the tree at the rsync boundary;
    _reject_symlinks is the belt to that suspenders, catching in-tree links and
    any rsync flag regression. Both run before the driver reads a single byte.
    """
    cage = _cage_dir(short)
    subprocess.run(
        ["sudo", "-n", "rsync", "-a", "--safe-links", "--delete", "--exclude=.git",
         "--exclude=node_modules", "--exclude=CONTEXT.md",
         f"{cage}/", f"{worktree}/"],
        check=True,
    )
    subprocess.run(["sudo", "-n", "chown", "-R", "mumega:mumega", str(worktree)], check=True)
    subprocess.run(["sudo", "-n", "rm", "-rf", str(cage)], check=False)
    _reject_symlinks(worktree)


def _write_cage_context(worktree: Path) -> None:
    """The cage has no .git — give the model recent history for orientation."""
    log_out = git("log", "--oneline", "-15", cwd=worktree, check=False).stdout
    (worktree / "CONTEXT.md").write_text(
        "# Repo context (snapshot — no git available here)\n\n"
        "Recent commits on main:\n```\n" + log_out + "```\n"
    )


def codex_run(worktree: Path, brief: str, short: str) -> subprocess.CompletedProcess:
    # Caged execution: the model runs as LANE_USER with env -i — no mumega
    # home access, no service control, no inherited secrets. It edits a
    # git-less copy; the driver owns all git and remote operations.
    _write_cage_context(worktree)
    cage = _cage_out(worktree, short)
    cmd = [
        "sudo", "-n", "-u", LANE_USER,
        "env", "-i", f"HOME=/home/{LANE_USER}", "PATH=/usr/local/bin:/usr/bin:/bin",
        LANE_CODEX_BIN, "exec", "--cd", str(cage), "--skip-git-repo-check",
        "--sandbox", "danger-full-access",
    ]
    if MODEL:
        cmd += ["-m", MODEL]
    cmd.append(brief)
    log(f"dispatching caged codex exec (user={LANE_USER}, model={MODEL or 'default'}, timeout {TIMEOUT}s) ...")
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=TIMEOUT)
    finally:
        _cage_back(worktree, short)


# The commit body is the one place cage-authored text reaches a pushed artifact,
# so it is read with O_NOFOLLOW: even if _reject_symlinks were bypassed or a
# future edit reordered the calls, the read itself cannot traverse a link. The
# cap bounds how much a hostile summary can smuggle into a commit message.
MAX_SUMMARY_BYTES = 8192


def _read_summary(summary_file: Path) -> str:
    """Read the model's commit body without ever following a symlink."""
    try:
        fd = os.open(summary_file, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return ""
    except OSError as exc:  # ELOOP == the path is a symlink; treat as hostile
        raise HostileCageOutput(
            f".lane-summary.md is a symlink (-> {os.readlink(summary_file)}); "
            "refusing to read it into a commit body"
        ) from exc
    try:
        with os.fdopen(fd, "r", encoding="utf-8", errors="replace") as fh:
            return fh.read(MAX_SUMMARY_BYTES).strip()
    except OSError:
        return ""


def verify(worktree: Path, branch: str) -> tuple[bool, str]:
    """The cage returns file edits, not commits: the driver stages and commits
    them (summary from .lane-summary.md), then verifies. No fake-green."""
    summary_file = worktree / ".lane-summary.md"
    summary = _read_summary(summary_file)
    if summary_file.is_symlink() or summary_file.exists():
        summary_file.unlink()
    ctx = worktree / "CONTEXT.md"
    if ctx.exists():
        ctx.unlink()
    status = git("status", "--porcelain", cwd=worktree, check=False).stdout.strip()
    if status:
        git("add", "-A", cwd=worktree)
        msg = "lane(codex): caged task delivery\n\n" + (summary or "(model provided no .lane-summary.md)")
        git("commit", "-m", msg, cwd=worktree)
    commits = git("log", "main..HEAD", "--oneline", cwd=worktree, check=False).stdout.strip()
    if not commits:
        return False, "no changes — codex produced no work" + (f" (summary: {summary[:400]})" if summary else "")
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
    mcp("task_update", {"task_id": task["id"], "status": "review", "gate_owner": GATE_OWNER, "body": _cap_body(body)})


def report_blocked(task: dict, reason: str) -> None:
    body = f"{task.get('body','')}\n\n---\ncodex loop BLOCKED: {reason}"
    mcp("task_update", {"task_id": task["id"], "status": "blocked", "body": _cap_body(body)})


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
    _link_node_modules(worktree)
    try:
        proc = codex_run(worktree, build_brief(task, worktree, branch), short)
        log(f"codex exit {proc.returncode}; output tail:\n{(proc.stdout or '')[-800:]}")
        ok, note = verify(worktree, branch)
        if not ok and "tsc errors" in note:
            # One self-repair bounce: the cage sees its own compile errors once.
            log("verify failed on tsc — one repair bounce")
            repair_brief = build_brief(task, worktree, branch) + (
                "\n\nREPAIR ROUND: your previous edits fail `npx tsc --noEmit` with the"
                f" errors below. Fix them; change nothing else.\n\n{note[-3000:]}"
            )
            proc = codex_run(worktree, repair_brief, short)
            log(f"repair exit {proc.returncode}; output tail:\n{(proc.stdout or '')[-400:]}")
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
    try:
        stuck = mcp("task_list", {"assignee_agent_id": CODEX_AGENT_ID, "status": "in_progress", "limit": 5}).get("tasks", [])
        for s_task in stuck:
            log(
                f"WARNING orphaned in_progress task {s_task['id'][:8]} "
                f"({s_task.get('title', '')[:50]}) — likely a SIGTERMed dispatch; the status "
                f"machine has no requeue transition, re-issue it manually"
            )
    except Exception:  # noqa: BLE001 - orphan check is advisory, never fatal
        pass
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
