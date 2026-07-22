#!/usr/bin/env python3
"""Headless mumcp -> mupot loop driver.

Connects the vps-mumcp agent (WordPress/Elementor automation, runs as
`mumcp-agent.service` -> Claude Code in tmux session `mumcp`, cwd
/mnt/HC_Volume_104325311/projects/sitepilotai) to mupot governance the same
way scripts/cursor-worker.py connects `cursor`: poll for open tasks assigned
to the mumcp agent, claim, dispatch the work to the real runtime, verify,
and hand off to a human/Kasra-core gate via `review` status. mumcp NEVER
publishes on its own — its own WordPress output governance already forces
DRAFT server-side (server-forced draft, human-approval-before-publish); this
loop does not change that, it only adds mupot as a second, parallel work
source alongside mumcp's existing GitHub-issues/BACKLOG.md flow.

Dispatch mechanism (decided after checking both options live on the host):
  - The `mumcp` tmux session is a LIVE, long-running interactive Claude Code
    REPL (already mid-conversation when checked) with no reliable
    machine-readable "done" boundary. `tmux send-keys` into it would
    interleave with whatever it is already doing and risks corrupting a
    session a human may be watching.
  - A headless `claude -p` run in the SAME project directory, with the SAME
    flags the systemd unit uses to launch the interactive session
    (`--model sonnet --dangerously-skip-permissions`), gets the identical
    tool surface (project .mcp.json, CLAUDE.md, WordPress/MCPWP access) in a
    fresh, isolated, scriptable process — exit code + captured stdout, no
    interference with the live session. This mirrors the proven
    cursor-worker.py pattern (`cursor-agent -p` headless), so: headless -p
    is what this driver uses. tmux send-keys is not used.

Flow per task (assignee = mumcp agent, status = open):
  1. claim    -> task_update status=in_progress
  2. dispatch -> `claude -p --output-format json` in MUMCP_PROJECT_DIR with a
                 brief that hard-instructs: WordPress changes land as DRAFT
                 only, never publish/merge; report a structured
                 MUMCP_RESULT JSON block at the end.
  3. verify   -> parse stdout for the MUMCP_RESULT block; a claim of
                 "done"/"draft_created" with no evidence (post id / url /
                 command output) is treated as unverified, not success (no
                 fake green).
  4. review   -> task_update status=review, gate_owner=gate:kasra-core,
                 draft evidence appended to the task body.
  5. notify   -> best-effort mupot MCP send to kasra; non-fatal if it fails.

The driver NEVER approves, publishes, merges, or deploys. Kasra-core (a
human-gated squad) verdicts the task via task_verdict; mumcp's own plugin-
side approval flow additionally gates any actual publish action.

Config (env):
  MUPOT_MCP           default https://mupot.mumega.com/mcp
  MUMCP_TOKEN         default ~/.fleet/agents/mumega-mumcp-member.token
  MUMCP_AGENT_ID      default e6695da3-2e04-45b8-b4af-acddaa7c1438 (mumega-mumcp, verified
                      agent-bound via boot_context/orient — see PR description)
  MUMCP_SQUAD_ID      default c0e87a6d-77de-4cf8-89a3-79e5843cdd30 (MCPWP Core)
  GATE_OWNER          default 'gate:kasra-core'
  MUMCP_PROJECT_DIR   default /mnt/HC_Volume_104325311/projects/sitepilotai (mumcp runtime cwd)
  CLAUDE_BIN          default 'claude'
  MODEL               default 'sonnet' (matches mumcp-agent.service)
  MAX_TASKS           default 1 (per run)
  TIMEOUT             default 1800 (seconds per headless run)
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
import urllib.request
from pathlib import Path

MUPOT_MCP = os.environ.get("MUPOT_MCP", "https://mupot.mumega.com/mcp")
MUMCP_TOKEN_PATH = Path(os.environ.get("MUMCP_TOKEN", str(Path.home() / ".fleet/agents/mumega-mumcp-member.token")))
MUMCP_AGENT_ID = os.environ.get("MUMCP_AGENT_ID", "e6695da3-2e04-45b8-b4af-acddaa7c1438")
MUMCP_SQUAD_ID = os.environ.get("MUMCP_SQUAD_ID", "c0e87a6d-77de-4cf8-89a3-79e5843cdd30")
GATE_OWNER = os.environ.get("GATE_OWNER", "gate:kasra-core")
MUMCP_PROJECT_DIR = Path(os.environ.get("MUMCP_PROJECT_DIR", "/mnt/HC_Volume_104325311/projects/sitepilotai"))
CLAUDE_BIN = os.environ.get("CLAUDE_BIN", "claude")
MODEL = os.environ.get("MODEL", "sonnet")
MAX_TASKS = int(os.environ.get("MAX_TASKS", "1"))
TIMEOUT = int(os.environ.get("TIMEOUT", "1800"))
DRY_RUN = os.environ.get("DRY_RUN", "") == "1"

RESULT_RE = re.compile(r"```MUMCP_RESULT\s*(\{.*?\})\s*```", re.DOTALL)


def log(msg: str) -> None:
    print(f"[mumcp-worker] {msg}", flush=True)


def token() -> str:
    return MUMCP_TOKEN_PATH.read_text().strip()


def mcp(tool: str, args: dict) -> dict:
    """Call a mupot MCP tool as the mumcp agent. Returns the tool's `result`."""
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
            "User-Agent": "mumcp-worker/1.0 (+mupot)",
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


def register_presence() -> None:
    """Best-effort Port-1 self-registration so the concierge's dispatcher sees
    mumcp as an online 'build' capability. registerModule is an idempotent
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
            "adapter": "mumcp",
            "kind": "agent_system",
            "project_id": None,
            "capabilities": ["build"],
        })
        log("presence: registered/refreshed (adapter=mumcp, capabilities=[build])")
    except Exception as exc:  # noqa: BLE001 - presence is best-effort, never fatal
        log(f"presence_register failed (non-fatal): {exc}")


def poll_open_tasks() -> list[dict]:
    res = mcp(
        "task_list",
        {"squad_id": MUMCP_SQUAD_ID, "assignee_agent_id": MUMCP_AGENT_ID, "status": "open", "limit": MAX_TASKS},
    )
    return res.get("tasks", [])[:MAX_TASKS]


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
    """No fake green: require the structured MUMCP_RESULT block, status=done, AND
    non-empty evidence. A bare status:"done" claim with no evidence is NOT verified."""
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


def report_review(task: dict, result: dict) -> None:
    body = (
        f"{task.get('body', '')}\n\n---\nmumcp loop -> review.\n"
        f"summary: {result.get('summary', '')}\n"
        f"evidence: {result.get('evidence', '')}\n"
        f"draft_only: {result.get('draft_only', True)} -- NOT published; awaiting gate."
    )
    mcp("task_update", {"task_id": task["id"], "status": "review", "gate_owner": GATE_OWNER, "body": body})


def report_blocked(task: dict, reason: str) -> None:
    body = f"{task.get('body', '')}\n\n---\nmumcp loop BLOCKED: {reason}"
    mcp("task_update", {"task_id": task["id"], "status": "blocked", "body": body})


def run_task(task: dict) -> None:
    tid = task["id"]
    short = tid.split("-")[0]
    log(f"=== task {short}: {task.get('title', '')[:60]} ===")
    if DRY_RUN:
        log("DRY_RUN -- would claim, dispatch headless claude, verify, move to review. Skipping.")
        return

    mcp("task_update", {"task_id": tid, "status": "in_progress"})
    try:
        proc = dispatch(task)
    except subprocess.TimeoutExpired:
        report_blocked(task, f"headless claude timed out after {TIMEOUT}s")
        return
    ok, note, result = verify(proc)
    if not ok:
        log(f"verify FAILED: {note}")
        report_blocked(task, note)
        return
    report_review(task, result)
    log(f"delivered -> review. {note}")
    _notify_kasra(task, note)


def _notify_kasra(task: dict, note: str) -> None:
    """Best-effort mupot inbox ping so Kasra-core gates the task. Non-fatal if it fails.

    Uses MCP `send` (D1 agent_messages), not the retired SOS Redis bus-send path.
    """
    try:
        to = os.environ.get("NOTIFY_TO", "kasra")
        mcp(
            "send",
            {
                "to": to,
                "body": (
                    f"mumcp loop: task {task['id'].split('-')[0]} in review ({note}) "
                    f"-- gate + verdict needed"
                ),
            },
        )
    except Exception as exc:  # noqa: BLE001 - notify is best-effort
        log(f"notify kasra failed (non-fatal): {exc}")


def main() -> int:
    if not MUMCP_TOKEN_PATH.exists():
        log(f"no mumcp token at {MUMCP_TOKEN_PATH}")
        return 2
    register_presence()
    tasks = poll_open_tasks()
    log(f"{len(tasks)} open task(s) assigned to mumcp")
    for task in tasks:
        try:
            run_task(task)
        except Exception as exc:  # noqa: BLE001 - one task's failure must not kill the loop
            log(f"task {task.get('id')} errored: {exc}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
