"""Tests for the operator-loop claim fence (mupot task 65045a7d / mumega-com#742).

The fence: a technician may claim a board task ONLY when it is UNASSIGNED
(assignee_agent_id null) or assigned to the technician's OWN agent id. A task
explicitly assigned to a DIFFERENT agent must be skipped — the live incident was
the claude lane claiming task 731d1634 assigned to kasra (c855f82c) and building
a broken TS parallel (mumega-com#740).

Like test_steward_worker.py, these tests do NOT hit a live mupot server. They
load the shared fence predicate directly and drive the technician drivers'
run_task()/poll_open_tasks() with a monkeypatched mcp() — the same boundary the
loop tests on the server side (tests/mcp-task-tools.test.ts) covers.

Run: pytest scripts/test_claim_fence.py -v
(No pytest config exists in this repo for scripts/*.py — run directly.)
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

SCRIPTS = Path(__file__).parent

KASRA_AGENT_ID = "c855f82c-1eeb-409d-94d2-f11e9dd18968"
TECH_GROK_AGENT_ID = "141e954c-115c-45dc-918e-b02931317b9b"


def _load_by_path(filename: str, module_name: str):
    """scripts/*-worker.py filenames contain hyphens, so they cannot be imported
    with a normal `import` statement — load them by path instead."""
    spec = importlib.util.spec_from_file_location(module_name, SCRIPTS / filename)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def claim_fence():
    return _load_by_path("lib/claim_fence.py", "claim_fence_under_test")


@pytest.fixture()
def claude_worker(monkeypatch: pytest.MonkeyPatch):
    module = _load_by_path("claude-worker.py", "claude_worker_under_test")
    monkeypatch.setattr(module, "DRY_RUN", False)
    monkeypatch.setattr(module, "CLAUDE_AGENT_ID", "")
    return module


@pytest.fixture()
def tech_grok_worker(monkeypatch: pytest.MonkeyPatch):
    module = _load_by_path("tech-grok-worker.py", "tech_grok_worker_under_test")
    monkeypatch.setattr(module, "DRY_RUN", False)
    return module


def _base_task(**overrides: Any) -> dict:
    task = {
        "id": "74000000-0000-0000-0000-000000000001",
        "squad_id": "squad-core",
        "project_id": None,
        "title": "Build the real thing",
        "done_when": "the thing works",
        "body": "kasra-code is already building this.",
        "status": "open",
        "assignee_agent_id": KASRA_AGENT_ID,
    }
    task.update(overrides)
    return task


class _FakeProc:
    def __init__(self, returncode: int = 0, stdout: str = "", stderr: str = ""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def _stub_build_driver(module, monkeypatch: pytest.MonkeyPatch, calls: list, tmp_path: Path) -> None:
    """Stub everything after the claim so run_task() stops at the boundary we
    assert on (the task_update in_progress claim) — never touches git/gh/claude."""
    monkeypatch.setattr(module, "WORKTREE_ROOT", tmp_path)

    def fake_mcp(tool: str, args: dict) -> dict:
        calls.append((tool, args))
        return {"task": {"id": args.get("task_id", "x"), **args}}

    def fake_git(*_args, **_kwargs):
        return _FakeProc()

    monkeypatch.setattr(module, "mcp", fake_mcp)
    monkeypatch.setattr(module, "git", fake_git)
    monkeypatch.setattr(module, "_link_node_modules", lambda _w: None)
    for run_name in ("claude_run", "athena_run", "codex_run"):
        if hasattr(module, run_name):
            monkeypatch.setattr(module, run_name, lambda *a, **k: _FakeProc())
    if hasattr(module, "verify"):
        monkeypatch.setattr(module, "verify", lambda *a, **k: (True, "commits: fake"))
    if hasattr(module, "deliver"):
        monkeypatch.setattr(module, "deliver", lambda *a, **k: "https://github.com/Mumega-com/mupot/pull/1")
    if hasattr(module, "report_review"):
        monkeypatch.setattr(module, "report_review", lambda *a, **k: None)
    if hasattr(module, "report_blocked"):
        monkeypatch.setattr(module, "report_blocked", lambda *a, **k: None)
    if hasattr(module, "_notify_kasra"):
        monkeypatch.setattr(module, "_notify_kasra", lambda *a, **k: None)


def _claim_calls(calls: list) -> list:
    return [c for c in calls if c[0] == "task_update" and c[1].get("status") == "in_progress"]


# ── fence predicate unit tests ────────────────────────────────────────────────

def test_claimable_unassigned_task_is_claimable(claim_fence):
    """No regression: an UNASSIGNED task (assignee null) stays claimable."""
    task = _base_task(assignee_agent_id=None)
    may_claim, reason = claim_fence.claimable(task, TECH_GROK_AGENT_ID)
    assert may_claim is True
    assert reason == ""


def test_claimable_own_assigned_task_is_claimable(claim_fence):
    """A task assigned to the technician's OWN agent id stays claimable."""
    task = _base_task(assignee_agent_id=TECH_GROK_AGENT_ID)
    may_claim, reason = claim_fence.claimable(task, TECH_GROK_AGENT_ID)
    assert may_claim is True
    assert reason == ""


def test_claimable_task_assigned_to_other_agent_is_skipped(claim_fence):
    """THE fence: a technician must NOT claim a task whose assignee_agent_id is
    set AND != the technician's own agent id."""
    task = _base_task(assignee_agent_id=KASRA_AGENT_ID)
    may_claim, reason = claim_fence.claimable(task, TECH_GROK_AGENT_ID)
    assert may_claim is False
    assert KASRA_AGENT_ID in reason
    assert TECH_GROK_AGENT_ID in reason


# ── claude-worker integration (the reported incident) ─────────────────────────

def test_claude_worker_skips_task_assigned_to_kasra(claude_worker, monkeypatch, tmp_path):
    """The incident, fixed: the claude lane (own agent id '', NOT kasra's) must
    NOT claim a task explicitly assigned to kasra — no task_update claim, no
    worktree."""
    calls: list = []
    _stub_build_driver(claude_worker, monkeypatch, calls, tmp_path)

    claude_worker.run_task(_base_task(assignee_agent_id=KASRA_AGENT_ID))

    assert _claim_calls(calls) == [], (
        "claude lane claimed a kasra-assigned task — double-dispatch (mumega-com#740) is not fixed"
    )
    assert list(tmp_path.iterdir()) == [], "skip must not create a worktree"


def test_claude_worker_claims_unassigned_task(claude_worker, monkeypatch, tmp_path):
    """No regression: the claude lane still claims UNASSIGNED tasks."""
    calls: list = []
    _stub_build_driver(claude_worker, monkeypatch, calls, tmp_path)

    claude_worker.run_task(_base_task(assignee_agent_id=None))

    assert len(_claim_calls(calls)) == 1, "unassigned task must remain claimable"


def test_claude_worker_poll_filters_out_other_assigned_tasks(claude_worker, monkeypatch):
    """The poll must not hand the lane tasks it cannot claim: with the lane's own
    agent id unset, an other-assigned open task is filtered out, an unassigned
    open task is kept."""
    module = claude_worker
    monkeypatch.setattr(module, "CLAUDE_AGENT_ID", "")
    monkeypatch.setattr(
        module, "mcp",
        lambda tool, args: {"tasks": [
            _base_task(assignee_agent_id=KASRA_AGENT_ID),
            _base_task(id="74000000-0000-0000-0000-000000000002", assignee_agent_id=None),
        ]},
    )
    tasks = module.poll_open_tasks()
    assert [t["id"] for t in tasks] == ["74000000-0000-0000-0000-000000000002"]


# ── tech-grok integration (no regression for legit dispatch) ──────────────────

def test_tech_grok_worker_claims_own_assigned_task(tech_grok_worker, monkeypatch, tmp_path):
    """Legit dispatch unchanged: a task assigned to the technician's OWN agent id
    is still claimed."""
    calls: list = []
    _stub_build_driver(tech_grok_worker, monkeypatch, calls, tmp_path)

    tech_grok_worker.run_task(_base_task(assignee_agent_id=TECH_GROK_AGENT_ID))

    assert len(_claim_calls(calls)) == 1, "own-assigned task must remain claimable"


def test_tech_grok_worker_skips_task_assigned_to_kasra(tech_grok_worker, monkeypatch, tmp_path):
    """The fence also guards tech-grok: a task assigned to kasra is skipped even
    if it somehow reaches run_task (e.g. reassigned between poll and claim)."""
    calls: list = []
    _stub_build_driver(tech_grok_worker, monkeypatch, calls, tmp_path)

    tech_grok_worker.run_task(_base_task(assignee_agent_id=KASRA_AGENT_ID))

    assert _claim_calls(calls) == [], "tech-grok must not claim a kasra-assigned task"
    assert list(tmp_path.iterdir()) == [], "skip must not create a worktree"
