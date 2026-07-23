#!/usr/bin/env python3
"""Headless Codex CLI -> mupot loop driver (runtime-adapter/v1, BYOA slice 2).

Turns a `codex` agent into a dispatchable technician that picks up mupot tasks
and returns branches for a human/Kasra gate. Conforms to runtime-adapter/v1
(scripts/runtime_adapter_v1.py): declared runtime type `codex`, server-derived
identity/tenant/capability, signed attach domain `fleet-attach:v1` (bearer
attach when no host key), land-at-review contract.

Dispatch: `codex exec [PROMPT]` headless with `--sandbox` + `--json`. Remote
MCP is streamable-HTTP only via `~/.codex/config.toml` `[mcp_servers.mupot]`
(`url` + `bearer_token_env_var` — NO SSE).

The loop is trustworthy BY CONSTRUCTION: codex never self-closes a task
(mupot's no-self-close guard) and never touches the remote — the trusted
driver does push/PR and moves the task to `review`. Codex only writes code in
an isolated worktree.

Flow per task (assignee = codex agent, status = open):
  0. boot         -> boot_context + attach(runtime=codex) + Port-1 presence
  1. claim        -> task_update status=in_progress
  2. isolate      -> git worktree add -b codex/task-<id8> <wt> main
  3. dispatch     -> codex exec --sandbox <mode> --json -C <wt> [PROMPT]
  4. verify       -> codex must have committed; run tsc (no fake-green)
  5. deliver      -> driver pushes the branch + opens the PR (codex never does)
  6. report       -> land_at_review (status=review, gate_owner set, PR linked)
  7. notify       -> ping Kasra-core to gate; remove the worktree (keep branch/PR)

The driver NEVER merges or deploys. Kasra-core gates the PR and verdicts the task.

Config (env):
  MUPOT_MCP              default https://mupot.mumega.com/mcp
  MUPOT_API_BASE         default derived from MUPOT_MCP
  CODEX_TOKEN            default ~/.fleet/agents/codex-member.token
  CODEX_KEY              optional ~/.fleet/agents/<agent>.key for signed attach
  CODEX_BIN              default 'codex'
  CODEX_HOME             default ~/.codex (config.toml location)
  CODEX_MCP_ENV_VAR      default MUPOT_MCP_TOKEN (bearer_token_env_var name)
  REPO                   default /home/mumega/mupot
  GATE_OWNER             default 'gate:kasra-core'
  MODEL                  optional --model override
  SANDBOX                default workspace-write (read-only|workspace-write; danger-full-access disallowed)
  MAX_TASKS              default 1
  TIMEOUT                default 1800
  DRY_RUN                '1' = poll + print, do nothing
  MINT_ATTACH            '1' = mint/attach e2e path (dry-run ok without live Codex creds)
  OPERATOR_TOKEN         admin token path for live mint (optional; dry-run skips)

Usage:
  python3 scripts/codex-worker.py                 # one-shot, up to MAX_TASKS
  DRY_RUN=1 python3 scripts/codex-worker.py       # show what it would do
  MINT_ATTACH=1 DRY_RUN=1 python3 scripts/codex-worker.py  # mint+attach plan
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

# Allow `python3 scripts/codex-worker.py` to import the sibling adapter module.
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
from codex_child_env import (  # noqa: E402
    build_codex_child_env,
    resolve_sandbox,
)

RUNTIME_TYPE = "codex"
AGENT_TYPE = "builder"
LIFECYCLE = "on_demand"

CODEX_TOKEN_PATH = Path(os.environ.get("CODEX_TOKEN", str(Path.home() / ".fleet/agents/codex-member.token")))
CODEX_KEY_PATH = Path(os.environ.get("CODEX_KEY", "")) if os.environ.get("CODEX_KEY") else None
CODEX_BIN = os.environ.get("CODEX_BIN", "codex")
CODEX_HOME = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))
CODEX_MCP_ENV_VAR = os.environ.get("CODEX_MCP_ENV_VAR", "MUPOT_MCP_TOKEN")
CODEX_CONFIG = CODEX_HOME / "config.toml"
REPO = Path(os.environ.get("REPO", "/home/mumega/mupot"))
MODEL = os.environ.get("MODEL", "").strip()
MAX_TASKS = int(os.environ.get("MAX_TASKS", "1"))
TIMEOUT = int(os.environ.get("TIMEOUT", "1800"))
SANDBOX = os.environ.get("SANDBOX", "workspace-write").strip()
DRY_RUN = os.environ.get("DRY_RUN", "") == "1"
MINT_ATTACH = os.environ.get("MINT_ATTACH", "") == "1"
OPERATOR_TOKEN_PATH = Path(os.environ.get("OPERATOR_TOKEN", "")) if os.environ.get("OPERATOR_TOKEN") else None

REPO_SLUG = os.environ.get("REPO_SLUG", "Mumega-com/mupot")
WORKTREE_ROOT = Path(os.environ.get("WORKTREE_ROOT", "/home/mumega/mupot-worktrees"))
MUPOT_MCP = os.environ.get("MUPOT_MCP", "https://mupot.mumega.com/mcp")

MCP_SERVER_NAME = "mupot"
MCP_STANZA_MARKER = f"[mcp_servers.{MCP_SERVER_NAME}]"


def log(msg: str) -> None:
    print(f"[codex-worker] {msg}", flush=True)


def git(*args: str, cwd: Path | None = None, check: bool = True) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env.pop("GITHUB_TOKEN", None)  # gh token shadow guard
    return subprocess.run(
        ["git", *args], cwd=str(cwd or REPO), env=env, check=check, capture_output=True, text=True
    )


def mcp_config_stanza(mcp_url: str, env_var: str) -> str:
    """Streamable-HTTP remote MCP for Codex — url + bearer_token_env_var, NO SSE."""
    return "\n".join(
        [
            MCP_STANZA_MARKER,
            f'url = "{mcp_url}"',
            f'bearer_token_env_var = "{env_var}"',
            "",
        ]
    )


def ensure_codex_mcp_config(mcp_url: str, env_var: str, *, write: bool) -> str:
    """Ensure ~/.codex/config.toml has [mcp_servers.mupot] streamable-HTTP stanza.

    Returns the stanza text. Refuses SSE (`type = "sse"` / transport=sse).
    """
    stanza = mcp_config_stanza(mcp_url=mcp_url, env_var=env_var)
    if not write:
        return stanza
    CODEX_HOME.mkdir(parents=True, exist_ok=True)
    existing = CODEX_CONFIG.read_text() if CODEX_CONFIG.is_file() else ""
    prior = re.search(
        rf"\[mcp_servers\.{re.escape(MCP_SERVER_NAME)}\][\s\S]*?(?=\n\[|\Z)",
        existing,
    )
    if prior and re.search(r'type\s*=\s*"sse"|transport\s*=\s*"sse"', prior.group(0)):
        raise RuntimeError(
            f"{CODEX_CONFIG} has SSE mcp_servers.{MCP_SERVER_NAME} — remove it; "
            "Codex supports streamable-HTTP only (url + bearer_token_env_var)"
        )
    if prior and f'bearer_token_env_var = "{env_var}"' in prior.group(0) and f'url =' in prior.group(0):
        log(f"mcp config already present in {CODEX_CONFIG}")
        return stanza
    # Drop a prior mupot stanza (any shape) then append the correct one.
    cleaned = re.sub(
        rf"\[mcp_servers\.{re.escape(MCP_SERVER_NAME)}\][\s\S]*?(?=\n\[|\Z)",
        "",
        existing,
    ).rstrip()
    new_text = (cleaned + "\n\n" + stanza).lstrip() + "\n" if cleaned else stanza
    CODEX_CONFIG.write_text(new_text)
    log(f"wrote streamable-HTTP mcp_servers.{MCP_SERVER_NAME} to {CODEX_CONFIG}")
    return stanza


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
            "- You have the mupot MCP server for read-only context (task_list, recall, boot_context).",
        ]
    )


def codex_run(worktree: Path, brief: str, token: str) -> subprocess.CompletedProcess:
    sandbox = resolve_sandbox(SANDBOX)
    cmd = [
        CODEX_BIN,
        "exec",
        "--sandbox",
        sandbox,
        "--json",
        "-C",
        str(worktree),
    ]
    if MODEL:
        cmd += ["--model", MODEL]
    cmd.append(brief)
    env = build_codex_child_env(
        dict(os.environ),
        mcp_env_var=CODEX_MCP_ENV_VAR,
        token=token,
    )
    log(f"dispatching {CODEX_BIN} exec --sandbox {sandbox} --json (timeout {TIMEOUT}s) ...")
    return subprocess.run(cmd, cwd=str(worktree), env=env, capture_output=True, text=True, timeout=TIMEOUT)


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
        f"Dispatched to the `codex` agent headless via the mupot loop "
        f"({CONTRACT_ID}, runtime={RUNTIME_TYPE}) for task `{task['id']}`.\n\n"
        f"Task done-when: {task.get('done_when','')}\n\n"
        "Driver verified: codex committed real work + `tsc --noEmit` clean. "
        f"**Kasra-core gates this PR before merge** (task lands at `{LAND_AT_STATUS}`; "
        "codex cannot self-close it)."
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
    branch = f"codex/task-{short}"
    worktree = WORKTREE_ROOT / f"codex-{short}"
    log(f"=== task {short}: {task.get('title','')[:60]} ===")
    if DRY_RUN:
        log("DRY_RUN — would claim, dispatch codex exec, verify, PR, review. Skipping.")
        return

    claim_in_progress(cfg, task_id=tid)
    WORKTREE_ROOT.mkdir(parents=True, exist_ok=True)
    git("worktree", "add", "-b", branch, str(worktree), "main")
    try:
        ensure_codex_mcp_config(cfg.mcp_url, CODEX_MCP_ENV_VAR, write=True)
        proc = codex_run(worktree, build_brief(task, worktree, branch), cfg.token)
        log(f"codex exit {proc.returncode}; output tail:\n{(proc.stdout or '')[-800:]}")
        ok, note = verify(worktree, branch)
        if not ok:
            log(f"verify FAILED: {note}")
            report_blocked(
                cfg,
                task_id=tid,
                body=f"{task.get('body','')}\n\n---\ncodex loop BLOCKED: {note}",
            )
            return
        pr_url = deliver(worktree, branch, task)
        land_at_review(
            cfg,
            task_id=tid,
            body=f"{task.get('body','')}\n\n---\ncodex loop -> {LAND_AT_STATUS}. PR: {pr_url}\n{note}",
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
             "kasra", f"codex loop: task {task['id'].split('-')[0]} in review, PR ready to gate: {pr_url}"],
            capture_output=True, text=True, timeout=20,
        )
    except Exception as exc:  # noqa: BLE001 - notify is best-effort
        log(f"notify kasra failed (non-fatal): {exc}")


def run_mint_attach(*, dry_run: bool) -> int:
    """Mint a codex agent + token and attach (dry-run acceptable without live Codex creds).

    Live path needs OPERATOR_TOKEN (admin) for create_agent + mint_agent_token.
    Dry-run prints the plan, writes/shows the streamable-HTTP config.toml stanza,
    and stops before calling the pot or `codex exec`.
    """
    mcp_url = MUPOT_MCP
    api_base = os.environ.get("MUPOT_API_BASE") or api_base_from_mcp(mcp_url)
    slug = os.environ.get("CODEX_AGENT_SLUG", "codex")
    squad = os.environ.get("CODEX_SQUAD", "core")
    stanza = ensure_codex_mcp_config(mcp_url, CODEX_MCP_ENV_VAR, write=not dry_run)

    log(f"{CONTRACT_ID} mint-attach path runtime={RUNTIME_TYPE} attach_domain={SIGNED_ATTACH_DOMAIN}")
    log(f"mcp endpoint: {mcp_url}")
    log(f"api base: {api_base}")
    log(f"config.toml stanza (streamable-HTTP, no SSE):\n{stanza}")
    log(
        f"plan: create_agent {{ squad: {squad!r}, slug: {slug!r}, name: 'Codex', "
        f"model: 'codex' }} → mint_agent_token {{ agent: {slug!r} }} → "
        f"export {CODEX_MCP_ENV_VAR}=<raw> → attach(runtime={RUNTIME_TYPE!r}) → "
        f"land work at {LAND_AT_STATUS!r}"
    )

    if dry_run:
        log(
            "DRY_RUN mint-attach — not calling create_agent/mint_agent_token/attach; "
            "no live Codex credentials required. Conformance: config uses "
            "url + bearer_token_env_var only."
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
        user_agent=f"codex-worker/1.0 (+mupot; {CONTRACT_ID}; mint-attach)",
        gate_owner=os.environ.get("GATE_OWNER", "gate:kasra-core"),
        key_path=None,
    )
    created = mcp_call(
        op_cfg,
        "create_agent",
        {"squad": squad, "slug": slug, "name": "Codex", "model": "codex", "role": "builder"},
    )
    agent = created.get("agent") if isinstance(created.get("agent"), dict) else {}
    agent_id = agent.get("id")
    log(f"create_agent ok id={agent_id!r} slug={agent.get('slug')!r}")
    minted = mcp_call(op_cfg, "mint_agent_token", {"agent": slug, "label": f"{slug}-member"})
    token_obj = minted.get("token") if isinstance(minted.get("token"), dict) else {}
    raw = token_obj.get("raw")
    if not isinstance(raw, str) or not raw:
        raise RuntimeError(f"mint_agent_token returned no raw token: {minted}")
    CODEX_TOKEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    CODEX_TOKEN_PATH.write_text(raw + "\n")
    CODEX_TOKEN_PATH.chmod(0o600)
    log(f"wrote agent token to {CODEX_TOKEN_PATH} (show-once raw stored locally)")

    agent_cfg = config_from_env(
        token_path=CODEX_TOKEN_PATH,
        runtime=RUNTIME_TYPE,
        agent_type=AGENT_TYPE,
        user_agent=f"codex-worker/1.0 (+mupot; {CONTRACT_ID})",
        lifecycle=LIFECYCLE,
        key_path=CODEX_KEY_PATH,
    )
    identity = boot_session(
        agent_cfg,
        presence_adapter="codex",
        log=log,
    )
    log(f"mint-attach complete agent={identity.agent_id} tenant={identity.tenant}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Codex topology-A runtime-adapter/v1 driver")
    parser.add_argument(
        "--mint-attach",
        action="store_true",
        help="Mint codex agent + token and attach (respects DRY_RUN)",
    )
    args = parser.parse_args(argv)
    mint_attach = bool(args.mint_attach) or MINT_ATTACH

    if mint_attach:
        return run_mint_attach(dry_run=DRY_RUN)

    try:
        sandbox = resolve_sandbox(SANDBOX)
    except ValueError as exc:
        log(str(exc))
        return 2
    if not CODEX_TOKEN_PATH.exists():
        log(f"no codex token at {CODEX_TOKEN_PATH} (or run MINT_ATTACH=1 DRY_RUN=1 first)")
        return 2

    cfg = config_from_env(
        token_path=CODEX_TOKEN_PATH,
        runtime=RUNTIME_TYPE,
        agent_type=AGENT_TYPE,
        user_agent=f"codex-worker/1.0 (+mupot; {CONTRACT_ID})",
        lifecycle=LIFECYCLE,
        key_path=CODEX_KEY_PATH,
    )
    log(f"{CONTRACT_ID} attach_domain={SIGNED_ATTACH_DOMAIN} land_at={LAND_AT_STATUS}")
    ensure_codex_mcp_config(cfg.mcp_url, CODEX_MCP_ENV_VAR, write=not DRY_RUN)
    if DRY_RUN:
        log(
            f"DRY_RUN — would boot_session(runtime={RUNTIME_TYPE}), poll own-assignee open tasks, "
            f"codex exec --sandbox {sandbox} --json, verify, PR, land_at_review"
        )
        # Still resolve identity when a token exists so dry-run exercises the contract path.
        try:
            identity: RuntimeIdentity = boot_session(
                cfg,
                presence_adapter="codex",
                log=log,
            )
            tasks = poll_open_tasks(cfg, identity, limit=MAX_TASKS)
            log(f"{len(tasks)} open task(s) assigned to codex ({identity.agent_id})")
            for task in tasks:
                run_task(cfg, task)
        except Exception as exc:  # noqa: BLE001 - dry-run may lack live pot access
            log(f"DRY_RUN boot/poll skipped ({exc})")
        return 0

    identity = boot_session(
        cfg,
        presence_adapter="codex",
        log=log,
    )
    tasks = poll_open_tasks(cfg, identity, limit=MAX_TASKS)
    log(f"{len(tasks)} open task(s) assigned to codex ({identity.agent_id})")
    for task in tasks:
        try:
            run_task(cfg, task)
        except Exception as exc:  # noqa: BLE001 - one task's failure must not kill the loop
            log(f"task {task.get('id')} errored: {exc}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
