"""Claim fence for the operator-loop technicians (mupot task 65045a7d / mumega-com#742).

The operator loop (mupot-operator.service -> scripts/operator-loop.sh -> the
*-worker.py build drivers) claims board tasks with task_update status=in_progress
— a path that historically ignored assignee_agent_id. Live incident: the claude
lane claimed task 731d1634 which was EXPLICITLY assigned to kasra (c855f82c) and
built a broken TS parallel (src/flight-executor/executor.ts, tsc errors) while
kasra-code was already building the real thing (mumega-com#740). Two builders,
one task.

Rule (the fence): a technician may claim a task ONLY when
  - the task is UNASSIGNED (assignee_agent_id null), or
  - the task is assigned to the technician's OWN agent id.
A task explicitly assigned to a DIFFERENT agent must be skipped: claiming it
double-dispatches work the operator already routed to someone else.

This is the host-side claim gate. The server-side execute path already enforces
the same rule in canAgentExecuteTask (src/agents/execute.ts); the MCP task_update
tool itself has no assignee check, so the technician drivers must fence here.
"""
from __future__ import annotations


def claimable(task: dict, own_agent_id: str) -> tuple[bool, str]:
    """Return (may_claim, skip_reason).

    may_claim is True for UNASSIGNED tasks and for tasks assigned to
    own_agent_id; False (with a loggable reason) when the task is explicitly
    assigned to a different agent.
    """
    assignee = task.get("assignee_agent_id")
    if not assignee:
        return True, ""
    if assignee == own_agent_id:
        return True, ""
    return False, (
        f"assignee_agent_id={assignee} is set and != technician's own agent id "
        f"{own_agent_id!r} — explicit task assignment fence (mupot #742): skipping claim"
    )
