"""Property test for scripts/steward-worker.py's reissue() carry-forward fix
(mupot PR #659 P0 / diverse-model adversarial gate BLOCK, "amplifier" finding).

The gate's finding: steward-worker.py reissues terminal `blocked`/orphaned tasks
through the normal task_create MCP tool WITH a task.created bus event ->
dispatchSquad(). Before this fix, reissue() built its task_create payload from a
fixed allowlist of fields (squad_id, project_id, title, done_when, body,
assignee_agent_id) that did not include external_source — so a Linear-origin
blocked task lost its provenance marker on reissue and came back looking like an
ordinary, trusted, local task, laundering it straight into the exact event wake
the original `skipEvent: true` import deliberately suppressed.

This test does NOT hit a live mupot server. It monkeypatches steward_worker.mcp
(the one HTTP chokepoint) with a fake that records every task_create payload, so
the test is a pure property check of reissue()'s OWN payload-construction logic —
the same boundary tests/mcp-task-tools.test.ts covers on the server side (does
task_create honor + return external_source).

Run: pytest scripts/test_steward_worker.py -v
(No pytest config exists in this repo for scripts/*.py — this file is not wired
into `npm test`'s vitest run. Run it directly; see the PR report for output.)
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any

import pytest

MODULE_PATH = Path(__file__).parent / "steward-worker.py"


def _load_steward_worker():
    """scripts/steward-worker.py has a hyphen in its filename, so it cannot be
    imported with a normal `import` statement — load it by path instead."""
    spec = importlib.util.spec_from_file_location("steward_worker_under_test", MODULE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["steward_worker_under_test"] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def steward(monkeypatch: pytest.MonkeyPatch):
    module = _load_steward_worker()
    monkeypatch.setattr(module, "DRY_RUN", False)
    return module


def _base_task(**overrides: Any) -> dict:
    task = {
        "id": "11111111-2222-3333-4444-555555555555",
        "squad_id": "squad-core",
        "project_id": "proj-1",
        "title": "Fix parser",
        "done_when": "Linear issue ENG-1 resolved",
        "body": "https://linear.app/x/issue/ENG-1\nfrom Linear (ENG-1)",
        "status": "blocked",
        "assignee_agent_id": "agent-1",
        "updated_at": "2026-08-03T00:00:00Z",
    }
    task.update(overrides)
    return task


def test_reissue_carries_external_source_forward_when_present(steward, monkeypatch):
    """THE property this PR fixes: a blocked task that came from a governed
    external integration (external_source set) must still carry that marker on
    its reissued copy — otherwise the reissued task re-enters the normal
    task.created event wake unmarked (the "amplifier" the gate flagged).

    On da8be05 (pre-fix) this FAILS for the right reason: the payload sent to
    task_create has no 'external_source' key at all, because reissue() never
    read the field off the prior task.
    """
    captured_calls: list[tuple[str, dict]] = []

    def fake_mcp(tool: str, args: dict) -> dict:
        captured_calls.append((tool, args))
        return {"task": {"id": "new-task-id", **args}}

    monkeypatch.setattr(steward, "mcp", fake_mcp)

    task = _base_task(external_source="linear:ENG")
    state = {"reissued": {}}
    new_id = steward.reissue(task, "timed out", state, set())

    assert new_id == "new-task-id"
    assert len(captured_calls) == 1
    tool, payload = captured_calls[0]
    assert tool == "task_create"
    assert "external_source" in payload, (
        "reissue() dropped the provenance marker — the reissued task_create call "
        "carries no external_source key at all, so the new task is indistinguishable "
        "from a trusted local task (the exact amplifier PR #659's gate flagged)."
    )
    assert payload["external_source"] == "linear:ENG"


def test_reissue_of_a_local_task_does_not_forge_external_source(steward, monkeypatch):
    """A LOCAL task (no external_source on the prior copy) must NOT have the key
    injected on reissue — reissue() only ever carries forward what was already
    there; it never invents provenance."""
    captured_calls: list[tuple[str, dict]] = []

    def fake_mcp(tool: str, args: dict) -> dict:
        captured_calls.append((tool, args))
        return {"task": {"id": "new-task-id", **args}}

    monkeypatch.setattr(steward, "mcp", fake_mcp)

    task = _base_task()  # no external_source key at all — a local task
    state = {"reissued": {}}
    steward.reissue(task, "timed out", state, set())

    _, payload = captured_calls[0]
    assert "external_source" not in payload


def test_reissue_does_not_forward_a_falsy_external_source(steward, monkeypatch):
    """Defensive: task.get('external_source') on an explicit None/'' must not
    land a falsy value in the payload either (task_create's own validation
    would reject a blank string, but reissue() should not even try)."""
    captured_calls: list[tuple[str, dict]] = []

    def fake_mcp(tool: str, args: dict) -> dict:
        captured_calls.append((tool, args))
        return {"task": {"id": "new-task-id", **args}}

    monkeypatch.setattr(steward, "mcp", fake_mcp)

    task = _base_task(external_source=None)
    state = {"reissued": {}}
    steward.reissue(task, "timed out", state, set())

    _, payload = captured_calls[0]
    assert "external_source" not in payload
