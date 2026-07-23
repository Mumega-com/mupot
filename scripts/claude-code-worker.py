#!/usr/bin/env python3
"""Headless Claude Code CLI -> mupot loop driver (runtime-adapter/v1, BYOA slice 3).

Turns a `claude-code` agent into a dispatchable technician that picks up mupot
tasks and returns branches for a human/Kasra gate. Conforms to runtime-adapter/v1
(scripts/runtime_adapter_v1.py): declared runtime type `claude-code`,
server-derived identity/tenant/capability, signed attach domain `fleet-attach:v1`
(bearer attach when no host key), land-at-review contract.

Dispatch: `claude -p "<prompt>"` headless with `--output-format stream-json`.
Remote MCP via worktree `.mcp.json` (`type: "http"`, `url`,
`headers.Authorization`) — same shape as packs/claude-code/flock-agent.

The loop is trustworthy BY CONSTRUCTION: claude never self-closes a task
(mupot's no-self-close guard) and never touches the remote — the trusted
driver does push/PR and moves the task to `review`. Claude only writes code in
an isolated worktree.

Flow per task (assignee = claude-code agent, status = open):
  0. boot         -> boot_context + attach(runtime=claude-code) + Port-1 presence
  1. claim        -> task_update status=in_progress
  2. isolate      -> git worktree add -b claude-code/task-<id8> <wt> main
  3. mcp          -> write .mcp.json (type:http + Authorization) into the worktree
  4. dispatch     -> claude -p --output-format stream-json [PROMPT]
  5. verify       -> claude must have committed; run tsc (no fake-green)
  6. deliver      -> driver pushes the branch + opens the PR (claude never does)
  7. report       -> land_at_review (status=review, gate_owner set, PR linked)
  8. notify       -> ping Kasra-core to gate; remove the worktree (keep branch/PR)

The driver NEVER merges or deploys. Kasra-core gates the PR and verdicts the task.

Config (env):
  MUPOT_MCP              default https://mupot.mumega.com/mcp
  MUPOT_API_BASE         default derived from MUPOT_MCP
  CLAUDE_CODE_TOKEN      default ~/.fleet/agents/claude-code-member.token
  CLAUDE_CODE_KEY        optional ~/.fleet/agents/<agent>.key for signed attach
  CLAUDE_BIN             default 'claude'
  REPO                   default /home/mumega/mupot
  GATE_OWNER             default 'gate:kasra-core'
  MODEL                  optional --model override
  MAX_TASKS              default 1
  TIMEOUT                default 1800
  DRY_RUN                '1' = poll + print, do nothing
  MINT_ATTACH            '1' = mint/attach e2e path (dry-run ok without live Claude creds)
  OPERATOR_TOKEN         admin token path for live mint (optional; dry-run skips)
  SKIP_PERMISSIONS       default '1' → --dangerously-skip-permissions (headless)

Usage:
  python3 scripts/claude-code-worker.py                 # one-shot, up to MAX_TASKS
  DRY_RUN=1 python3 scripts/claude-code-worker.py       # show what it would do
  MINT_ATTACH=1 DRY_RUN=1 python3 scripts/claude-code-worker.py  # mint+attach plan
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

# Allow `python3 scripts/claude-code-worker.py` to import the sibling adapter module.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from runtime_adapter_v1 import (  # noqa: E402
    CONTRACT_ID,
    LAND_AT_STATUS,
    SIGNED_ATTACH_DOMAIN,
    AdapterConfig,
    RuntimeIdentity,
    api_base_from_mcp,
    boot_session,
    claim_in_progress,
    config_from_env,
    land_at_review,
    mcp_call,
    poll_open_tasks,
    read_token,
    report_blocked,
)

RUNTIME_TYPE = "claude-code"
AGENT_TYPE = "builder"
LIFECYCLE = "on_demand"

CLAUDE_CODE_TOKEN_PATH = Path(
    os.environ.get("CLAUDE_CODE_TOKEN", str(Path.home() / ".fleet/agents/claude-code-member.token"))
)
CLAUDE_CODE_KEY_PATH = Path(os.environ.get("CLAUDE_CODE_KEY", "")) if os.environ.get("CLAUDE_CODE_KEY") else None
CLAUDE_BIN = os.environ.get("CLAUDE_BIN", "claude")
REPO = Path(os.environ.get("REPO", "/home/mumega/mupot"))
MODEL = os.environ.get("MODEL", "").strip()
MAX_TASKS = int(os.environ.get("MAX_TASKS", "1"))
TIMEOUT = int(os.environ.get("TIMEOUT", "1800"))
DRY_RUN = os.environ.get("DRY_RUN", "") == "1"
MINT_ATTACH = os.environ.get("MINT_ATTACH", "") == "1"
OPERATOR_TOKEN_PATH = Path(os.environ.get("OPERATOR_TOKEN", "")) if os.environ.get("OPERATOR_TOKEN") else None
SKIP_PERMISSIONS = os.environ.get("SKIP_PERMISSIONS", "1") == "1"

REPO_SLUG = os.environ.get("REPO_SLUG", "Mumega-com/mupot")
WORKTREE_ROOT = Path(os.environ.get("WORKTREE_ROOT", "/home/mumega/mupot-worktrees"))
MUPOT_MCP = os.environ.get("MUPOT_MCP", "https://mupot.mumega.com/mcp")

MCP_SERVER_NAME = "mupot"
MCP_JSON_NAME = ".mcp.json"
OUTPUT_FORMAT = "stream-json"


def log(msg: str) -> None:
    print(f"[claude-code-worker] {msg}", flush=True)


def git(*args: str, cwd: Path | None = None, check: bool = True) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env.pop("GITHUB_TOKEN", None)  # gh token shadow guard
    return subprocess.run(
        ["git", *args], cwd=str(cwd or REPO), env=env, check=check, capture_output=True, text=True
    )


def mcp_json_document(mcp_url: str, token: str) -> dict:
    """Remote HTTP MCP for Claude Code — type:http + url + headers.Authorization."""
    return {
        "mcpServers": {
            MCP_SERVER_NAME: {
                "type": "http",
                "url": mcp_url,
                "headers": {
                    "Authorization": f"Bearer {token}",
                },
            }
        }
    }


def mcp_json_template(mcp_url: str) -> dict:
    """Placeholder-shaped document for dry-run / docs (no live token)."""
    return mcp_json_document(mcp_url=mcp_url, token="<MUPOT_MEMBER_TOKEN>")


def ensure_worktree_mcp_json(worktree: Path, mcp_url: str, token: str, *, write: bool) -> str:
    """Write `.mcp.json` into the worktree so headless `claude -p` loads mupot MCP.

    Returns the JSON text. Refuses SSE (`type: "sse"`).
    """
    doc = mcp_json_document(mcp_url=mcp_url, token=token)
    server = doc["mcpServers"][MCP_SERVER_NAME]
    if server.get("type") == "sse":
        raise RuntimeError("Claude Code BYOA adapter requires type:http, not sse")
    if "Authorization" not in server.get("headers", {}):
        raise RuntimeError("Claude Code .mcp.json must set headers.Authorization")
    text = json.dumps(doc, indent=2) + "\n"
    if not write:
        return text
    path = worktree / MCP_JSON_NAME
    path.write_text(text)
    path.chmod(0o600)
    # Keep the token out of any accidental commit Claude might attempt.
    gitignore = worktree / ".gitignore"
    ignore_line = MCP_JSON_NAME
    if gitignore.is_file():
        existing = gitignore.read_text()
        if ignore_line not in existing.splitlines():
            gitignore.write_text(existing.rstrip() + "\n" + ignore_line + "\n")
    else:
        gitignore.write_text(ignore_line + "\n")
    log(f"wrote type:http {MCP_JSON_NAME} to {path}")
    return text


def build_brief(task: dict, worktree: Path, branch: str) -> str:
    return "\n".join(
        [
            f"You are the claude-code agent. Task from mupot (id {task['id']}).",
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
            f"- Do NOT commit or modify {MCP_JSON_NAME} (gitignored; driver-owned).",
        ]
    )


def claude_run(worktree: Path, brief: str) -> subprocess.CompletedProcess:
    cmd = [
        CLAUDE_BIN,
        "-p",
        brief,
        "--output-format",
        OUTPUT_FORMAT,
    ]
    if SKIP_PERMISSIONS:
        cmd.append("--dangerously-skip-permissions")
    if MODEL:
        cmd += ["--model", MODEL]
    log(f"dispatching {CLAUDE_BIN} -p --output-format {OUTPUT_FORMAT} (timeout {TIMEOUT}s) ...")
    return subprocess.run(cmd, cwd=str(worktree), capture_output=True, text=True, timeout=TIMEOUT)


def verify(worktree: Path, branch: str) -> tuple[bool, str]:
    """claude must have committed real work + it must compile. No fake-green."""
    commits = git("log", "main..HEAD", "--oneline", cwd=worktree, check=False).stdout.strip()
    if not commits:
        return False, "no commits — claude-code produced no work"
    tsc = subprocess.run(["npx", "tsc", "--noEmit"], cwd=str(worktree), capture_output=True, text=True)
    if tsc.returncode != 0:
        return False, f"tsc errors:\n{tsc.stdout[-1500:]}{tsc.stderr[-500:]}"
    return True, f"commits:\n{commits}"


def deliver(worktree: Path, branch: str, task: dict) -> str:
    """Driver (trusted) pushes + opens the PR. claude never touches the remote."""
    git("push", "-u", "origin", branch, cwd=worktree)
    env = dict(os.environ)
    env.pop("GITHUB_TOKEN", None)
    title = f"claude-code: {task.get('title','')[:60]}"
    pr_body = (
        f"Dispatched to the `claude-code` agent headless via the mupot loop "
        f"({CONTRACT_ID}, runtime={RUNTIME_TYPE}) for task `{task['id']}`.\n\n"
        f"Task done-when: {task.get('done_when','')}\n\n"
        "Driver verified: claude-code committed real work + `tsc --noEmit` clean. "
        f"**Kasra-core gates this PR before merge** (task lands at `{LAND_AT_STATUS}`; "
        "claude-code cannot self-close it)."
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
    branch = f"claude-code/task-{short}"
    worktree = WORKTREE_ROOT / f"claude-code-{short}"
    log(f"=== task {short}: {task.get('title','')[:60]} ===")
    if DRY_RUN:
        log("DRY_RUN — would claim, write .mcp.json, dispatch claude -p, verify, PR, review. Skipping.")
        return

    claim_in_progress(cfg, task_id=tid)
    WORKTREE_ROOT.mkdir(parents=True, exist_ok=True)
    git("worktree", "add", "-b", branch, str(worktree), "main")
    try:
        ensure_worktree_mcp_json(worktree, cfg.mcp_url, cfg.token, write=True)
        proc = claude_run(worktree, build_brief(task, worktree, branch))
        log(f"claude exit {proc.returncode}; output tail:\n{(proc.stdout or '')[-800:]}")
        ok, note = verify(worktree, branch)
        if not ok:
            log(f"verify FAILED: {note}")
            report_blocked(
                cfg,
                task_id=tid,
                body=f"{task.get('body','')}\n\n---\nclaude-code loop BLOCKED: {note}",
            )
            return
        pr_url = deliver(worktree, branch, task)
        land_at_review(
            cfg,
            task_id=tid,
            body=f"{task.get('body','')}\n\n---\nclaude-code loop -> {LAND_AT_STATUS}. PR: {pr_url}\n{note}",
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
             "kasra", f"claude-code loop: task {task['id'].split('-')[0]} in review, PR ready to gate: {pr_url}"],
            capture_output=True, text=True, timeout=20,
        )
    except Exception as exc:  # noqa: BLE001 - notify is best-effort
        log(f"notify kasra failed (non-fatal): {exc}")


def run_mint_attach(*, dry_run: bool) -> int:
    """Mint a claude-code agent + token and attach (dry-run ok without live Claude creds).

    Live path needs OPERATOR_TOKEN (admin) for create_agent + mint_agent_token.
    Dry-run prints the plan, shows the type:http .mcp.json shape, and stops before
    calling the pot or `claude -p`.
    """
    mcp_url = MUPOT_MCP
    api_base = os.environ.get("MUPOT_API_BASE") or api_base_from_mcp(mcp_url)
    slug = os.environ.get("CLAUDE_CODE_AGENT_SLUG", "claude-code")
    squad = os.environ.get("CLAUDE_CODE_SQUAD", "core")
    template = json.dumps(mcp_json_template(mcp_url), indent=2)

    log(f"{CONTRACT_ID} mint-attach path runtime={RUNTIME_TYPE} attach_domain={SIGNED_ATTACH_DOMAIN}")
    log(f"mcp endpoint: {mcp_url}")
    log(f"api base: {api_base}")
    log(f".mcp.json shape (type:http + headers.Authorization):\n{template}")
    log(
        f"plan: create_agent {{ squad: {squad!r}, slug: {slug!r}, name: 'Claude Code', "
        f"model: 'claude' }} → mint_agent_token {{ agent: {slug!r} }} → "
        f"write worktree {MCP_JSON_NAME} → attach(runtime={RUNTIME_TYPE!r}) → "
        f"land work at {LAND_AT_STATUS!r}"
    )

    if dry_run:
        log(
            "DRY_RUN mint-attach — not calling create_agent/mint_agent_token/attach; "
            "no live Claude credentials required. Conformance: .mcp.json uses "
            "type:http + url + headers.Authorization only."
        )
        return 0

    if OPERATOR_TOKEN_PATH is None or not OPERATOR_TOKEN_PATH.is_file():
        log("OPERATOR_TOKEN required for live mint-attach (or set DRY_RUN=1)")
        return 2

    op_cfg = AdapterConfig(
        mcp_url=mcp_url,
        api_base_url=api_base,
        token=read_token(OPERATOR_TOKEN_PATH),
        runtime=RUNTIME_TYPE,
        agent_type=AGENT_TYPE,
        lifecycle=LIFECYCLE,
        user_agent=f"claude-code-worker/1.0 (+mupot; {CONTRACT_ID}; mint-attach)",
        gate_owner=os.environ.get("GATE_OWNER", "gate:kasra-core"),
        key_path=None,
    )
    created = mcp_call(
        op_cfg,
        "create_agent",
        {"squad": squad, "slug": slug, "name": "Claude Code", "model": "claude", "role": "builder"},
    )
    agent = created.get("agent") if isinstance(created.get("agent"), dict) else {}
    agent_id = agent.get("id")
    log(f"create_agent ok id={agent_id!r} slug={agent.get('slug')!r}")
    minted = mcp_call(op_cfg, "mint_agent_token", {"agent": slug, "label": f"{slug}-member"})
    token_obj = minted.get("token") if isinstance(minted.get("token"), dict) else {}
    raw = token_obj.get("raw")
    if not isinstance(raw, str) or not raw:
        raise RuntimeError(f"mint_agent_token returned no raw token: {minted}")
    CLAUDE_CODE_TOKEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    CLAUDE_CODE_TOKEN_PATH.write_text(raw + "\n")
    CLAUDE_CODE_TOKEN_PATH.chmod(0o600)
    log(f"wrote agent token to {CLAUDE_CODE_TOKEN_PATH} (show-once raw stored locally)")

    agent_cfg = config_from_env(
        token_path=CLAUDE_CODE_TOKEN_PATH,
        runtime=RUNTIME_TYPE,
        agent_type=AGENT_TYPE,
        user_agent=f"claude-code-worker/1.0 (+mupot; {CONTRACT_ID})",
        lifecycle=LIFECYCLE,
        key_path=CLAUDE_CODE_KEY_PATH,
    )
    identity = boot_session(
        agent_cfg,
        presence_adapter="claude-code",
        presence_capabilities=["build"],
        log=log,
    )
    log(f"mint-attach complete agent={identity.agent_id} tenant={identity.tenant}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Claude Code topology-A runtime-adapter/v1 driver")
    parser.add_argument(
        "--mint-attach",
        action="store_true",
        help="Mint claude-code agent + token and attach (respects DRY_RUN)",
    )
    args = parser.parse_args(argv)
    mint_attach = bool(args.mint_attach) or MINT_ATTACH

    if mint_attach:
        return run_mint_attach(dry_run=DRY_RUN)

    if not CLAUDE_CODE_TOKEN_PATH.exists():
        log(f"no claude-code token at {CLAUDE_CODE_TOKEN_PATH} (or run MINT_ATTACH=1 DRY_RUN=1 first)")
        return 2

    cfg = config_from_env(
        token_path=CLAUDE_CODE_TOKEN_PATH,
        runtime=RUNTIME_TYPE,
        agent_type=AGENT_TYPE,
        user_agent=f"claude-code-worker/1.0 (+mupot; {CONTRACT_ID})",
        lifecycle=LIFECYCLE,
        key_path=CLAUDE_CODE_KEY_PATH,
    )
    log(f"{CONTRACT_ID} attach_domain={SIGNED_ATTACH_DOMAIN} land_at={LAND_AT_STATUS}")
    if DRY_RUN:
        template = json.dumps(mcp_json_template(cfg.mcp_url), indent=2)
        log(
            f"DRY_RUN — would boot_session(runtime={RUNTIME_TYPE}), poll own-assignee open tasks, "
            f"write {MCP_JSON_NAME}, claude -p --output-format {OUTPUT_FORMAT}, verify, PR, land_at_review"
        )
        log(f".mcp.json shape:\n{template}")
        try:
            identity: RuntimeIdentity = boot_session(
                cfg,
                presence_adapter="claude-code",
                presence_capabilities=["build"],
                log=log,
            )
            tasks = poll_open_tasks(cfg, identity, limit=MAX_TASKS)
            log(f"{len(tasks)} open task(s) assigned to claude-code ({identity.agent_id})")
            for task in tasks:
                run_task(cfg, task)
        except Exception as exc:  # noqa: BLE001 - dry-run may lack live pot access
            log(f"DRY_RUN boot/poll skipped ({exc})")
        return 0

    identity = boot_session(
        cfg,
        presence_adapter="claude-code",
        presence_capabilities=["build"],
        log=log,
    )
    tasks = poll_open_tasks(cfg, identity, limit=MAX_TASKS)
    log(f"{len(tasks)} open task(s) assigned to claude-code ({identity.agent_id})")
    for task in tasks:
        try:
            run_task(cfg, task)
        except Exception as exc:  # noqa: BLE001 - one task's failure must not kill the loop
            log(f"task {task.get('id')} errored: {exc}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
