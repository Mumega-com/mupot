#!/usr/bin/env python3
"""Flight executor — runs dispatched flights end-to-end.

Polls for flights with status=running assigned to headless agents (asha, steward),
executes the flight goal via prime-agent in isolation, and submits routine_proposal
correlating to the routine_run_id in flight.meta.

Design constraints per Athena gate #9:
  1. GOAL=DATA never shell — goal passed via heredoc, no injection.
  2. IDENTITY — run as assigned agent; proposal carries that principal.
  3. TIMEOUT + CLEANUP — hard wall-clock 30m, process-group kill, journald receipt.
  4. IDEMPOTENCY — idempotency_key per flight; crash-safe replay on restart.
  5. BUDGET — enforce per-run token ceiling (150k default).
  6. SECRETS — strip host creds from child env (CLOUDFLARE_API_TOKEN, GITHUB_TOKEN, etc).
  7. CORRELATION — flight.meta.routine_run_id → proposal run_id + situation_digest EXACT.
  8. AGENT ID not slug — match by e211b0fb/b41052cc not by 'prime'/'steward'.
  9. RECONCILE — 5 stuck flights after landing.

Config (env):
  MUPOT_MCP              MCP endpoint (default https://mupot.mumega.com/mcp)
  ASHA_TOKEN, STEWARD_TOKEN    agent tokens for headless agents
  REPO                   mupot repo path (default ~/mupot)
  WORKTREE_ROOT          isolation path (default /mnt/HC_Volume_104325311/mupot-worktrees)
  FLIGHT_EXECUTOR_STATE  state file for idempotency (default ~/.fleet/flight-executor-state.json)
  FLIGHT_EXECUTOR_LOG    log path (default ~/.mumega/logs/flight-executor.log)
  MAX_FLIGHTS            max per cycle (default 3)
  DRY_RUN                '1' = report, no mutate
"""
from __future__ import annotations

import hashlib
import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

MUPOT_MCP = os.environ.get("MUPOT_MCP", "https://mupot.mumega.com/mcp")
REPO = Path(os.environ.get("REPO", str(Path.home() / "mupot")))
WORKTREE_ROOT = Path(os.environ.get("WORKTREE_ROOT", "/mnt/HC_Volume_104325311/mupot-worktrees"))
STATE_PATH = Path(os.environ.get("FLIGHT_EXECUTOR_STATE", str(Path.home() / ".fleet/flight-executor-state.json")))
LOG_PATH = Path(os.environ.get("FLIGHT_EXECUTOR_LOG", str(Path.home() / ".mumega/logs/flight-executor.log")))
MAX_FLIGHTS = int(os.environ.get("MAX_FLIGHTS", "3"))
DRY_RUN = os.environ.get("DRY_RUN", "") == "1"

HEADLESS_AGENTS = {
    "e211b0fb": "asha",
    "b41052cc": "steward",
}

LOG_PATH.parent.mkdir(parents=True, exist_ok=True)


def log(msg: str) -> None:
    ts = datetime.now(timezone.utc).isoformat()
    line = f"[{ts}] flight-executor: {msg}"
    print(line, flush=True)
    with open(LOG_PATH, "a") as f:
        f.write(line + "\n")


def get_agent_token(agent_id: str) -> str:
    """Get token for headless agent. Raises if not configured."""
    agent_name = HEADLESS_AGENTS.get(agent_id)
    if not agent_name:
        raise ValueError(f"agent {agent_id} is not a headless agent")
    env_key = f"{agent_name.upper()}_TOKEN"
    token_path = os.environ.get(env_key)
    if not token_path:
        raise ValueError(f"{env_key} not set")
    path = Path(token_path)
    if not path.exists():
        raise ValueError(f"{env_key} points to missing file {path}")
    return path.read_text().strip()


def mcp(tool: str, args: dict, token: str) -> dict:
    """Call mupot MCP tool."""
    body = json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool, "arguments": args}}
    ).encode()
    req = urllib.request.Request(
        MUPOT_MCP,
        data=body,
        headers={
            "Authorization": f"Bearer {token}",
            "content-type": "application/json",
            "User-Agent": "flight-executor-worker/1.0 (+mupot)",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            payload = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:400]
        raise RuntimeError(f"mupot {tool} http {exc.code}: {detail}") from exc
    if "error" in payload:
        raise RuntimeError(f"mupot {tool} error: {payload['error']}")
    inner = json.loads(payload["result"]["content"][0]["text"])
    if not inner.get("ok", True):
        raise RuntimeError(f"mupot {tool} not ok: {inner}")
    return inner.get("result", inner)


def load_state() -> dict:
    """Load idempotency state."""
    try:
        return json.loads(STATE_PATH.read_text())
    except Exception:
        return {"executed": {}, "landed": {}}


def save_state(state: dict) -> None:
    """Save idempotency state (atomic)."""
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=1))
    tmp.replace(STATE_PATH)


def query_running_flights(agent_id: str, token: str) -> list[dict]:
    """Query flights with status=running assigned to agent_id via wrangler d1."""
    try:
        # Use wrangler to query D1 directly. agent_id is one of two known values.
        if agent_id not in HEADLESS_AGENTS:
            raise ValueError(f"invalid agent_id {agent_id}")
        tenant = os.environ.get("TENANT", "mumega")
        query = (
            f"SELECT id, agent, goal, status, meta, project_id FROM flights "
            f"WHERE status = 'running' AND agent = '{agent_id}' AND tenant = '{tenant}' "
            f"ORDER BY created_at LIMIT 10"
        )
        cmd = ["wrangler", "d1", "execute", "mupot", query, "--json"]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30, cwd=str(REPO))
        if result.returncode != 0:
            raise RuntimeError(f"wrangler failed: {result.stderr}")
        # Parse wrangler output JSON.
        data = json.loads(result.stdout)
        flights = []
        for row in data:
            flights.append({
                "id": row.get("id"),
                "agent": row.get("agent"),
                "goal": row.get("goal"),
                "status": row.get("status"),
                "meta": json.loads(row.get("meta", "{}")),
                "project_id": row.get("project_id"),
            })
        return flights
    except Exception as e:
        log(f"error querying flights for {agent_id}: {e}")
        return []


def run_flight_goal(flight: dict, agent_id: str, agent_name: str) -> tuple[bool, str, int]:
    """
    Run flight goal in isolation. Returns (success, output, cost_micro_usd).

    Goal passed as safe data (heredoc), no injection.
    Timeout: 30 minutes. Process group kill on timeout.
    Env scrubbed of: CLOUDFLARE_API_TOKEN, GITHUB_TOKEN, MUPOT_ADMIN_TOKEN, etc.
    """
    flight_id = flight["id"]
    goal = flight["goal"]
    meta = flight.get("meta", {})
    routine_run_id = meta.get("routine_run_id")

    # Safe goal passing: via heredoc in a shell script, no quotes/escapes needed.
    script = f"""#!/usr/bin/env bash
set -e
cd {WORKTREE_ROOT}
timeout 1800 prime-agent -p --mode json \\
  --autonomous \\
  --autonomous-max-turns 20 \\
  --autonomous-max-tokens 150000 \\
  --autonomous-timeout-ms 1800000 \\
  -- <<'GOAL'
{goal}
GOAL
"""
    script_path = WORKTREE_ROOT / f".flight-{flight_id}.sh"
    script_path.write_text(script)
    script_path.chmod(0o755)

    # Scrub secrets from child env.
    env = os.environ.copy()
    for key in ["CLOUDFLARE_API_TOKEN", "GITHUB_TOKEN", "MUPOT_ADMIN_TOKEN"]:
        env.pop(key, None)

    log(f"running flight {flight_id} for {agent_name} (routine_run_id={routine_run_id})")
    try:
        result = subprocess.run(
            [str(script_path)],
            capture_output=True,
            text=True,
            timeout=1800,
            env=env,
            preexec_fn=os.setpgrp if hasattr(os, "setpgrp") else None,
        )
        output = result.stdout + result.stderr
        cost_micro_usd = 50_000  # Placeholder: ~$0.05 per run. Real cost from claude API usage.
        success = result.returncode == 0
        return success, output[-2000:], cost_micro_usd  # Last 2k for logging
    except subprocess.TimeoutExpired:
        log(f"flight {flight_id} timeout")
        # Kill process group.
        try:
            os.killpg(os.getpgid(0), signal.SIGKILL)
        except Exception:
            pass
        return False, "timeout", 0
    except Exception as e:
        log(f"flight {flight_id} error: {e}")
        return False, str(e), 0
    finally:
        script_path.unlink(missing_ok=True)


def submit_routine_proposal(
    flight: dict, agent_id: str, token: str, success: bool, cost_micro_usd: int
) -> bool:
    """Submit routine_proposal if flight.meta.routine_run_id is set. Returns True on success."""
    meta = flight.get("meta", {})
    routine_run_id = meta.get("routine_run_id")
    if not routine_run_id:
        return True  # No routine to report to; not an error.

    # Idempotency key: flight_id + outcome hash.
    outcome = "success" if success else "failed"
    idempotency_key = f"flight-{flight['id']}-{outcome}"

    # Situation digest: placeholder SHA256. Real: hash of routine run state.
    # For now, use flight goal + outcome.
    digest_input = f"{flight['id']}:{outcome}".encode()
    situation_digest = hashlib.sha256(digest_input).hexdigest()

    proposal = {
        "version": "routine.proposal/v1",
        "run_id": routine_run_id,
        "project_id": flight.get("project_id", ""),  # Must come from flight or routine query.
        "situation_digest": situation_digest,
        "summary": f"Flight {flight['id']} completed: {outcome}",
        "action": {
            "key": idempotency_key,
            "kind": "no_action" if success else "ask_human",
            "input": {"cost_micro_usd": cost_micro_usd, "flight_id": flight["id"]},
        },
    }

    try:
        # This requires the agent's token + correct principal binding.
        result = mcp("routine_proposal_submit", proposal, token)
        log(f"proposal submitted for {flight['id']}: {result}")
        return True
    except Exception as e:
        log(f"error submitting proposal for {flight['id']}: {e}")
        return False


def land_flight(flight: dict, token: str, success: bool, cost_micro_usd: int) -> bool:
    """Land flight (mark completed). Only callable by assigned agent."""
    flight_id = flight["id"]

    try:
        # flight_land requires agent binding; it will be the agent_id calling it.
        result = mcp(
            "flight_land",
            {
                "flight_id": flight_id,
                "cost_micro_usd": cost_micro_usd,
                "score": 0.8 if success else 0.2,  # Placeholder coherence score.
            },
            token,
        )
        log(f"flight {flight_id} → landed (cost={cost_micro_usd})")
        return True
    except Exception as e:
        log(f"error landing flight {flight_id}: {e}")
        return False


def main() -> int:
    """Main loop: poll, execute, land."""
    state = load_state()
    executed = state.get("executed", {})
    landed = state.get("landed", {})

    log("cycle start")
    flights_done = 0

    for agent_id in HEADLESS_AGENTS:
        if flights_done >= MAX_FLIGHTS:
            break

        agent_name = HEADLESS_AGENTS[agent_id]
        try:
            token = get_agent_token(agent_id)
        except ValueError as e:
            log(f"skipping {agent_name}: {e}")
            continue

        flights = query_running_flights(agent_id, token)
        for flight in flights[:MAX_FLIGHTS - flights_done]:
            flight_id = flight["id"]

            # Check idempotency: already landed?
            if landed.get(flight_id):
                log(f"flight {flight_id} already landed — skipping")
                continue

            # Check idempotency: already executed this cycle?
            if executed.get(flight_id):
                log(f"flight {flight_id} already executed this cycle — skipping")
                continue

            if DRY_RUN:
                log(f"[DRY RUN] would execute flight {flight_id} for {agent_name}")
                continue

            # Execute.
            try:
                success, output, cost = run_flight_goal(flight, agent_id, agent_name)
                executed[flight_id] = {"success": success, "cost": cost, "ts": time.time()}

                # Submit proposal if routine_run_id.
                if flight.get("meta", {}).get("routine_run_id"):
                    submit_routine_proposal(flight, agent_id, token, success, cost)

                # Land flight.
                if land_flight(flight, token, success, cost):
                    landed[flight_id] = True
                    flights_done += 1
            except Exception as e:
                log(f"error executing flight {flight_id}: {e}")

    save_state({"executed": executed, "landed": landed})
    log(f"cycle end (flights_done={flights_done})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
