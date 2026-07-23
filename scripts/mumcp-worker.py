#!/usr/bin/env python3
"""Headless mumcp -> mupot loop driver (runtime-adapter/v1 reference).

Connects the vps-mumcp agent (WordPress/Elementor automation, runs as
`mumcp-agent.service` -> Claude Code in tmux session `mumcp`) to mupot
governance the same way scripts/cursor-worker.py connects `cursor`. Conforms
to runtime-adapter/v1 (scripts/runtime_adapter_v1.py): declared runtime type
`claude-code`, server-derived identity/tenant/capability/squad, signed attach
domain `fleet-attach:v1` (bearer attach when no host key), land-at-review
contract. mumcp NEVER publishes on its own — WordPress output stays DRAFT
server-side; this loop adds mupot as a parallel governed work source.

Dispatch mechanism (decided after checking both options live on the host):
  - The `mumcp` tmux session is a LIVE interactive Claude Code REPL — tmux
    send-keys would interleave and risk corrupting a watched session.
  - A headless `claude -p` run in the SAME project directory, with the SAME
    flags the systemd unit uses (`--model sonnet --dangerously-skip-permissions`),
    gets the identical tool surface in an isolated, scriptable process.
    Mirrors cursor-worker.py (`cursor-agent -p` headless).

Flow per task (assignee = mumcp agent, status = open):
  0. boot     -> boot_context + attach(runtime=claude-code) + Port-1 presence
  1. claim    -> task_update status=in_progress
  2. dispatch -> `claude -p --output-format json` in MUMCP_PROJECT_DIR
  3. verify   -> parse MUMCP_RESULT; done without evidence = unverified
  4. review   -> land_at_review (status=review, gate_owner, draft evidence)
  5. notify   -> best-effort bus ping to kasra

The driver NEVER approves, publishes, merges, or deploys.

Config (env):
  MUPOT_MCP           default https://mupot.mumega.com/mcp
  MUPOT_API_BASE      default derived from MUPOT_MCP
  MUMCP_TOKEN         default ~/.fleet/agents/mumega-mumcp-member.token
  MUMCP_KEY           optional host key for signed attach
  GATE_OWNER          default 'gate:kasra-core'
  MUMCP_PROJECT_DIR   default /mnt/HC_Volume_104325311/projects/sitepilotai
  CLAUDE_BIN          default 'claude'
  MODEL               default 'sonnet'
  MAX_TASKS           default 1
  TIMEOUT             default 1800
  DRY_RUN             '1' = poll + print, do nothing

Usage:
  python3 scripts/mumcp-worker.py            # one-shot, up to MAX_TASKS
  DRY_RUN=1 python3 scripts/mumcp-worker.py  # show what it would do
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

# Allow `python3 scripts/mumcp-worker.py` to import the sibling adapter module.
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

RUNTIME_TYPE = "claude-code"
AGENT_TYPE = "builder"
LIFECYCLE = "on_demand"

MUMCP_TOKEN_PATH = Path(os.environ.get("MUMCP_TOKEN", str(Path.home() / ".fleet/agents/mumega-mumcp-member.token")))
MUMCP_KEY_PATH = Path(os.environ.get("MUMCP_KEY", "")) if os.environ.get("MUMCP_KEY") else None
MUMCP_PROJECT_DIR = Path(os.environ.get("MUMCP_PROJECT_DIR", "/mnt/HC_Volume_104325311/projects/sitepilotai"))
CLAUDE_BIN = os.environ.get("CLAUDE_BIN", "claude")
MODEL = os.environ.get("MODEL", "sonnet")
MAX_TASKS = int(os.environ.get("MAX_TASKS", "1"))
TIMEOUT = int(os.environ.get("TIMEOUT", "1800"))
DRY_RUN = os.environ.get("DRY_RUN", "") == "1"

RESULT_RE = re.compile(r"```MUMCP_RESULT\s*(\{.*?\})\s*```", re.DOTALL)


def log(msg: str) -> None:
    print(f"[mumcp-worker] {msg}", flush=True)


def build_brief(task: dict) -> str:
    return "\n".join(
        [
            f"You are mumega-mumcp (MCPWP WordPress-plugin builder + operator), dispatched by the",
            f"mupot loop driver for task {task['id']} (mupot task, squad MCPWP Core).",
            "",
            f"TITLE: {task.get('title', '')}",
            f"DONE WHEN: {task.get('done_when', '')}",
            "",
            "BRIEF:",
            task.get("body", "") or "(no body -- infer from title/done_when)",
            "",
            "RULES (hard, non-negotiable):",
            "- Any WordPress content change you make MUST land as a DRAFT. Never publish,",
            "  never flip a post/page to 'publish' status, never merge, never deploy.",
            "  A human approves publish afterward -- that is not your job.",
            "- Work only within your existing tool access (WordPress/MCPWP MCP + WP-CLI via",
            "  Bash if the MCPWP REST path is unavailable). Do not invent new credentials.",
            "- If you cannot complete the task safely or the task is unclear/unsafe, do NOT",
            "  guess -- report that in the result block below and explain why.",
            "",
            "REQUIRED OUTPUT (last thing you print, verbatim structure, real values only --",
            "never fabricate a post id, url, or command output you did not actually get back):",
            "```MUMCP_RESULT",
            "{",
            '  "status": "done" | "blocked",',
            '  "summary": "one line, what you actually did or why you could not",',
            '  "evidence": "the real WP-CLI/REST output or ids/urls that prove it, or empty string",',
            '  "draft_only": true',
            "}",
            "```",
        ]
    )


def dispatch(task: dict) -> subprocess.CompletedProcess:
    cmd = [
        CLAUDE_BIN,
        "-p",
        "--output-format", "json",
        "--model", MODEL,
        "--dangerously-skip-permissions",
    ]
    log(f"dispatching headless {CLAUDE_BIN} -p in {MUMCP_PROJECT_DIR} (timeout {TIMEOUT}s) ...")
    return subprocess.run(
        cmd,
        input=build_brief(task),
        cwd=str(MUMCP_PROJECT_DIR),
        capture_output=True,
        text=True,
        timeout=TIMEOUT,
    )


def extract_claude_text(proc: subprocess.CompletedProcess) -> str:
    """claude -p --output-format json prints one JSON object; pull the result text.
    Fall back to raw stdout if it isn't parseable JSON (older CLI versions)."""
    try:
        payload = json.loads(proc.stdout)
        return payload.get("result", "") or json.dumps(payload)
    except (json.JSONDecodeError, AttributeError):
        return proc.stdout or ""


def verify(proc: subprocess.CompletedProcess) -> tuple[bool, str, dict]:
    """No fake green: require MUMCP_RESULT, status=done, AND non-empty evidence."""
    if proc.returncode != 0:
        return False, f"headless claude exit {proc.returncode}: {(proc.stderr or '')[-800:]}", {}
    text = extract_claude_text(proc)
    m = RESULT_RE.search(text)
    if not m:
        return False, f"no MUMCP_RESULT block in output -- unverified. tail:\n{text[-800:]}", {}
    try:
        result = json.loads(m.group(1))
    except json.JSONDecodeError as exc:
        return False, f"MUMCP_RESULT block not valid JSON: {exc}", {}
    if result.get("status") != "done":
        return False, f"mumcp reported status={result.get('status')!r}: {result.get('summary', '')}", result
    if not result.get("evidence"):
        return False, "status=done but evidence is empty -- refusing to treat as verified (no fake green)", result
    return True, result.get("summary", ""), result


def run_task(cfg: AdapterConfig, task: dict) -> None:
    tid = task["id"]
    short = tid.split("-")[0]
    log(f"=== task {short}: {task.get('title', '')[:60]} ===")
    if DRY_RUN:
        log("DRY_RUN -- would claim, dispatch headless claude, verify, move to review. Skipping.")
        return

    claim_in_progress(cfg, task_id=tid)
    try:
        proc = dispatch(task)
    except subprocess.TimeoutExpired:
        report_blocked(
            cfg,
            task_id=tid,
            body=f"{task.get('body', '')}\n\n---\nmumcp loop BLOCKED: headless claude timed out after {TIMEOUT}s",
        )
        return
    ok, note, result = verify(proc)
    if not ok:
        log(f"verify FAILED: {note}")
        report_blocked(
            cfg,
            task_id=tid,
            body=f"{task.get('body', '')}\n\n---\nmumcp loop BLOCKED: {note}",
        )
        return
    land_at_review(
        cfg,
        task_id=tid,
        body=(
            f"{task.get('body', '')}\n\n---\nmumcp loop -> {LAND_AT_STATUS}.\n"
            f"summary: {result.get('summary', '')}\n"
            f"evidence: {result.get('evidence', '')}\n"
            f"draft_only: {result.get('draft_only', True)} -- NOT published; awaiting gate."
        ),
    )
    log(f"delivered -> {LAND_AT_STATUS}. {note}")
    _notify_kasra(task, note)


def _notify_kasra(task: dict, note: str) -> None:
    """Best-effort bus ping so Kasra-core gates the task. Non-fatal if it fails."""
    try:
        subprocess.run(
            ["python3", str(Path.home() / "scripts/bus-send.py"),
             "kasra", f"mumcp loop: task {task['id'].split('-')[0]} in review ({note}) -- gate + verdict needed"],
            capture_output=True, text=True, timeout=20,
        )
    except Exception as exc:  # noqa: BLE001 - notify is best-effort
        log(f"notify kasra failed (non-fatal): {exc}")


def main() -> int:
    if not MUMCP_TOKEN_PATH.exists():
        log(f"no mumcp token at {MUMCP_TOKEN_PATH}")
        return 2
    cfg = config_from_env(
        token_path=MUMCP_TOKEN_PATH,
        runtime=RUNTIME_TYPE,
        agent_type=AGENT_TYPE,
        user_agent=f"mumcp-worker/1.0 (+mupot; {CONTRACT_ID})",
        lifecycle=LIFECYCLE,
        key_path=MUMCP_KEY_PATH,
    )
    log(f"{CONTRACT_ID} attach_domain={SIGNED_ATTACH_DOMAIN} land_at={LAND_AT_STATUS}")
    identity: RuntimeIdentity = boot_session(
        cfg,
        presence_adapter="mumcp",
        presence_capabilities=["build"],
        log=log,
    )
    # Own-assignee filter; squad omitted so mupot derives it from the bound agent
    # (server-side). Optional MUMCP_SQUAD_ID remains a non-authority filter only.
    squad_filter = os.environ.get("MUMCP_SQUAD_ID") or identity.squad_id
    tasks = poll_open_tasks(cfg, identity, limit=MAX_TASKS, squad_id=squad_filter)
    log(f"{len(tasks)} open task(s) assigned to mumcp ({identity.agent_id})")
    for task in tasks:
        try:
            run_task(cfg, task)
        except Exception as exc:  # noqa: BLE001 - one task's failure must not kill the loop
            log(f"task {task.get('id')} errored: {exc}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
