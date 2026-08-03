# Operator Loop Runbook

Standing multi-technician loop for autonomous mupot build and review. Four execution lanes (tech-grok, claude, mumcp, and codex—currently paused) poll for open tasks, execute work in isolated git worktrees, and hand results to the review gate for Kasra-core approval. The system is self-perpetuating: orphaned and blocked work auto-reissues via steward-worker, and the gate never self-closes.

**Table of Contents**
- [Architecture](#architecture)
- [Model Assignments](#model-assignments)
- [Task Lifecycle](#task-lifecycle)
- [Known Failure Modes](#known-failure-modes)
- [Deployment](#deployment)
- [Monitoring](#monitoring)

---

## Architecture

### Dispatcher: `scripts/operator-loop.sh`

Main loop (5-minute cycle by default, 300s `OPERATOR_INTERVAL`). Spawns each driver in sequence, drains on SIGTERM for clean shutdown.

**Key behaviors:**
- Single-instance (flock guard): only one operator running at a time.
- Idle-safe: empty task boards are a no-op (no worktree, no git, no dispatch).
- Cycle failure doesn't kill the loop: each driver failure logs and continues; next cycle retries.
- Logging: all output (operator's own log lines + all drivers' output) goes to `$OPERATOR_LOG_DIR/operator.log` (default `~/.fleet/logs/operator.log`).
- SIGTERM drains: current cycle completes, then exit 0; systemd handles restart.

**Build lanes (per cycle, in order):**

1. **tech-grok-worker.py** — Grok 4.5, Cursor CLI harness. Minted 2026-08-03 per PR #641 as a distinct executor identity separate from Athena (the coordinator). Dispatches via `cursor-agent -p` in isolated worktrees.

2. **mumcp-worker.py** — Claude Sonnet. WordPress/Elementor automation on the separate MCPWP squad. Dispatches via `claude -p` in the mumcp project directory. WordPress writes are server-forced DRAFT; never publishes.

3. **codex-worker.py** — GPT-5.3 Codex Spark (default; cheaper tier). **PAUSED by default per security audit 2026-08-03** (PR #645 BLOCK): the `--sandbox danger-full-access` flag grants host-level read of home, tokens, and services. Resume only when running as a dedicated low-privilege user/container. Enable with `CODEX_LANE_ENABLED=1`.

4. **claude-worker.py** — Claude Haiku (cheap execution lane). Executes the majority of build work; expensive Kasra session reserved for gating and decisions.

**Gate lane (runs after build lanes):**

5. **review-worker.py** — Adversarial review gate. Claude Opus (default), zero tools, isolated scratch cwd, zero MCP/auto-memory/skills. Polls tasks with status=review + gate_owner=gate:kasra-core + a PR link. Never merges by default (REVIEW_AUTOMERGE=0). Returns a verdict receipt; Kasra-core task_verdict finalizes.

**Self-healing:**

6. **steward-worker.py** — Auto-repair. Reissues terminal blocked/orphaned tasks as fresh open tasks (one reissue per lineage, ever). Sends status digests to the principal via Telegram. Never verdicts, never closes—everything it creates flows through the normal lanes and gates.

### Trust Shape

- **Execution never touches the remote:** workers create isolated worktrees from main, commit/push via the driver, open PRs via the driver. The model process has zero git/gh access.
- **No self-close:** drivers move tasks to status=review; Kasra-core gates via task_verdict. Even the review gate (a model process) never verdicts or merges—it posts receipts only.
- **Gate-only authority:** Kasra-core (member 14136dec-5062-bf0a-832c-1765bad314fa) is the sole holder of the gate:kasra-core capability. Anything routed through gate_owner=gate:kasra-core requires Kasra's explicit task_verdict to finalize.
- **Decision/execution split:** small models (Haiku, Spark) execute; expensive models (Opus, Grok) gate. Reserve Kasra's interactive session tokens for decisions, not grinding.

---

## Model Assignments

Each driver defaults to a model tuned for its role. Change via environment variables.

### By Driver

| Driver | Env Var | Default | Purpose |
|--------|---------|---------|---------|
| tech-grok | `MODEL` | Grok 4.5 (hardcoded in cursor-agent) | Build technician; only override via cursor-agent flags if needed |
| mumcp | `MODEL` | sonnet | WordPress automation; matches mumcp-agent.service |
| claude | `CLAUDE_WORKER_MODEL` | haiku | Cheap execution lane; override with other model slugs (e.g., opus, sonnet) |
| codex | `CODEX_WORKER_MODEL` | gpt-5.3-codex-spark | Cheap execution; paused by default |
| review | `MODEL` | opus | Adversarial review gate; stronger model for diverse eye |

### How to Change Models

**At runtime (one cycle):**
```bash
CLAUDE_WORKER_MODEL=sonnet python3 scripts/claude-worker.py
REVIEW_AUTOMERGE=0 python3 scripts/review-worker.py
```

**For the service (persistent):**
Edit `/usr/lib/systemd/user/mupot-operator.service` (or `~/.config/systemd/user/mupot-operator.service` if user-scoped) and add to the `[Service]` section:
```ini
Environment=CLAUDE_WORKER_MODEL=sonnet
```

Then restart:
```bash
systemctl --user daemon-reload
systemctl --user restart mupot-operator.service
```

**For one driver only:**
Set env before calling the script in operator-loop.sh. To modify the dispatcher's own loop, add env lines in `.service` and reload+restart.

---

## Task Lifecycle

Tasks move: `open` → `in_progress` → `review` → (human verdict) → done/blocked/rejected.

### Terminal States (No Requeue)

Mupot has **no requeue transition** (PR #635). Once a task reaches `blocked` or `rejected`, calling `task_update` with `status=open` is a new task, not a state machine requeue.

**Steward's re-issue pattern (PR #650):**
- Detects terminal blocked tasks with retriable block reasons (tsc errors, bwrap sandbox, timed out, no commits).
- Reads the task body for the dedup marker `steward-reissue-of:<original-id>`.
- Creates a fresh open task with the SAME title/body, tagged `steward-reissue-of:<prior-id>`.
- One automatic reissue per lineage; if this new task fails too, it stays for a human.

**Example block reason → auto-reissue:**
- `"tsc errors: ..."` → YES, reissue.
- `"bwrap: Sandbox unavailable"` → YES, reissue.
- `"review gate verdicted: BLOCK"` → NO, human gate; steward skips.
- `"Unknown: ..."` → NO, unrecognized; steward skips.

### Steward Configuration

| Env Var | Default | Meaning |
|---------|---------|---------|
| `ORPHAN_HOURS` | 2 | Tasks in progress older than this are orphaned (likely SIGTERM killed) and reissued. |
| `DIGEST_EVERY_SECONDS` | 21600 (6h) | Send status digest to the principal every N seconds. |
| `DIGEST_TARGET` | telegram | Hermes send destination (telegram, discord, etc.). |
| `STEWARD_STATE` | ~/.fleet/steward-state.json | Local dedup state for reissues and digests. |
| `DRY_RUN` | 0 | Set to '1' to report what would be repaired without making changes. |

---

## Known Failure Modes

### 1. **Worktree TSC Failure**

**Symptom:** Every claude/codex task fails at verify with `"This is not the tsc command you are looking for"`.

**Root cause:** Fresh git worktrees share the repo's `.git` but NOT `node_modules`. `npx tsc` in the worktree resolves the wrong package (possibly a global install or the worktree's own empty node_modules).

**Fix:** Drivers call `_link_node_modules()` to symlink the repo's node_modules into each worktree before running tsc. If this is missing or the symlink fails:

```bash
cd /home/mumega/mupot-worktrees
rm -f claude-task-*/node_modules  # Clean stale symlinks
# Drivers re-run and re-create the symlink on the next cycle.
```

Or manually verify:
```bash
ls -l /home/mumega/mupot-worktrees/claude-task-abc123/node_modules
# Should be a symlink → /home/mumega/mupot/node_modules
```

**Script locations:**
- claude-worker.py, line 109–117: `_link_node_modules()`
- codex-worker.py, line 109–117: `_link_node_modules()`
- tech-grok-worker.py, line 109–117: `_link_node_modules()`

---

### 2. **HTTP 413 Receipt Loss**

**Symptom:** Task update fails with HTTP 413 Payload Too Large. Task body grows from receipts, next cycle reprocesses it.

**Root cause:** The mupot endpoint rejects oversized `task_update` calls. A lost receipt means the task is re-processed every cycle (inefficient, not a blocker).

**Fix:** Drivers cap the task body before updating. The `_cap_body()` function (all drivers, lines 120–143):
- Keeps the first 4000 chars (original task statement).
- Budgets the tail for newest receipts (keeps recent history).
- Cuts at a receipt boundary (`\n---\n`) so the newest receipt survives intact.

**Manual check:**
```python
# If a task's body has grown too large, manually fetch and trim:
# (Run in a driver script or REPL)
import json, urllib.request
# Fetch the task, read its body, find the oldest receipt, delete it.
# Re-issue the task if it's stuck in a loop.
```

**Workaround if receipts pile up:**
```bash
# Steward dry-run to see what it would reissue:
DRY_RUN=1 python3 scripts/steward-worker.py

# If the task is retriable, the steward will reissue on the next cycle.
# If manually needed, fetch the task and call task_create with a new title
# referencing the old ID: "Reissue of <task-id>".
```

---

### 3. **SIGTERM Orphans**

**Symptom:** A task stuck in status=in_progress for hours; no worktree in `/home/mumega/mupot-worktrees/`; the driver crashed or was killed mid-cycle.

**Root cause:** The driver was SIGTERM-killed (systemd, manual, or timeout) after claiming the task but before moving it to review. The worktree cleanup code never ran.

**Steward's auto-detection:**
- Polls tasks with status=in_progress.
- Checks if a corresponding worktree exists under `WORKTREE_ROOT`.
- If the task's `updated_at` is older than `ORPHAN_HOURS`, it's orphaned.
- Reissues it as a fresh open task (marked `steward-reissue-of:<task-id>`).

**Manual intervention if steward is paused:**
```bash
# Check for orphaned worktrees and stale in_progress tasks:
ls -la /home/mumega/mupot-worktrees/  # Orphan worktrees?
# In mupot dashboard or via MCP: task_list(status='in_progress') → check updated_at

# To force reissue:
# Call task_create with title="Reissue of <orphan-task-id>", same body + brief.
# Or wait for steward to run (default ORPHAN_HOURS=2).
```

**Visibility log marker:** The operator.log will show orphan warnings when steward detects them:
```
[steward] found orphaned task <id>: in_progress > 2h, no worktree — reissuing.
```

---

### 4. **Bwrap Sandbox Unavailable**

**Symptom:** Codex lane fails with `"bwrap: Sandbox unavailable"` or permission denied.

**Root cause:** The `--sandbox danger-full-access` flag in codex-worker.py requires `bwrap` (Bubblewrap) to be installed and configured. On the Hetzner host where codex runs, it may not be available or the user lacks permissions.

**Current status:** Codex lane is paused by default per PR #645. The problem is known (security audit 2026-08-03). Resume only after running codex as a dedicated low-privilege user/container.

**If you must run codex:**
1. Install bubblewrap: `apt-get install bubblewrap` (requires host sudo).
2. Configure user permissions (ask ops).
3. Set `CODEX_LANE_ENABLED=1` in the service or env.
4. Watch the first run's log; if bwrap still fails, the cage predicate (#645) must be resolved.

**For now:** Leave codex paused. Tech-grok (Cursor) + claude (Haiku) provide 2 execution lanes.

---

### 5. **PR Diff Fetch Timeout or 404**

**Symptom:** Review gate fails with "diff fetch failed" or PR not found on GitHub.

**Root cause:** The review-worker calls `gh pr diff` to fetch the PR diff. Network blips or a deleted PR cause this. The gate treats any diff fetch error as verdict=RED (fail-closed).

**Fix:** Automatic — the driver treats this as a temporary failure and logs the error. Next cycle, if the PR is still reachable, the review retries. If the PR was deleted, the task is stuck; a human must verdict it.

**Manual check:**
```bash
gh pr view <owner/repo>#<pr-number> --json url,state
# Verify the PR exists and is open/merged (not draft if it shouldn't be).
```

---

### 6. **Model Timeout**

**Symptom:** Claude or Codex run exceeds `TIMEOUT` (default 1800s for build, 900s for review). Driver logs timeout error; task moves to blocked.

**Root cause:** The model is slow (complex task, rate-limited, network latency) or hung.

**Fix:** 
- Increase `TIMEOUT` env var (seconds) if the task is genuinely complex.
- Or wait for steward to reissue (if the block reason matches a retriable snippet, e.g., "timed out").
- Check `operator.log` for the actual error; if it's a transient network issue, the reissue should succeed.

**Example:**
```bash
TIMEOUT=3600 python3 scripts/claude-worker.py  # 1 hour instead of 30 min
```

---

## Deployment

### Initial Setup

1. **Install mupot operator service:**
   ```bash
   cp scripts/mupot-operator.service ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable mupot-operator.service
   ```

2. **Create the log directory:**
   ```bash
   mkdir -p ~/.fleet/logs ~/.fleet/state
   chmod 700 ~/.fleet
   ```

3. **Prepare tokens:**
   Each driver reads a token file:
   - `claude-worker.py`: `~/.fleet/agents/kasra-agent.token`
   - `codex-worker.py`: `~/.fleet/agents/codex-member.token`
   - `mumcp-worker.py`: `~/.fleet/agents/mumega-mumcp-member.token`
   - `tech-grok-worker.py`: `~/.fleet/agents/tech-grok-member.token`
   - `review-worker.py`: `~/.fleet/agents/kasra-member.token`
   - `steward-worker.py`: `~/.fleet/agents/kasra-agent.token`

   Tokens are minted via the mupot dashboard or MCP (task `mint_agent_token`). Ensure they have the correct squad scope and capability grants (gate:kasra-core for the review/steward/gate, build for the others).

4. **Start the service:**
   ```bash
   systemctl --user start mupot-operator.service
   systemctl --user status mupot-operator.service
   ```

5. **Verify it's running:**
   ```bash
   tail -f ~/.fleet/logs/operator.log
   # Should show: "[$(ts)] operator: up (repo=/home/mumega/mupot interval=300s max_tasks=1 pid=<pid>)"
   ```

### Updating the Operator Code

When PRs update the operator loop (scripts/operator-loop.sh, *-worker.py, steward-worker.py):

1. **Fast-forward the kasra-operator branch:**
   ```bash
   cd /home/mumega/mupot
   git fetch origin
   git checkout kasra-operator
   git merge --ff-only origin/kasra-operator
   ```

2. **Verify changes:**
   ```bash
   npx tsc --noEmit
   npx vitest run  # Only if affected tests exist
   ```

3. **Restart the service:**
   ```bash
   systemctl --user restart mupot-operator.service
   systemctl --user status mupot-operator.service
   ```

   The service immediately picks up the new code. Current cycle completes; next cycle runs the new drivers.

4. **Watch the logs:**
   ```bash
   tail -f ~/.fleet/logs/operator.log
   # Confirm the new drivers are running without errors.
   ```

### Rolling Back

If a deployment breaks the loop:

```bash
cd /home/mumega/mupot
git checkout kasra-operator~1  # Or a specific known-good commit
systemctl --user restart mupot-operator.service
tail -f ~/.fleet/logs/operator.log
```

---

## Monitoring

### Log Locations

| Log | Path | Contents |
|-----|------|----------|
| Operator + all drivers | `~/.fleet/logs/operator.log` | Structured lines: `[timestamp] operator: message` or `[timestamp] [driver-name]: message`. Append-only per cycle. |
| Review gate dedup state | `~/.fleet/state/review-worker-reviewed.json` | JSON: `{"<head-sha>": true, ...}`. Persisted to dedupe PR reviews at the same commit. |
| Steward state | `~/.fleet/steward-state.json` | JSON: `{"reissued": {"<task-id>": "<issue-id>"}, "last_digest": <unix-ts>}`. Tracks reissued tasks and digest timing. |

### Key Log Patterns

**Operator startup:**
```
[2026-08-03T10:00:00Z] operator: up (repo=/home/mumega/mupot interval=300s max_tasks=1 pid=12345)
```

**Driver success:**
```
[2026-08-03T10:05:00Z] claude-worker: cycle ok
[2026-08-03T10:05:10Z] review: cycle ok
```

**Driver failure (continues):**
```
[2026-08-03T10:10:00Z] claude-worker: cycle exited 1 (continuing — will retry next interval)
```

**Orphan reissue:**
```
[2026-08-03T10:15:00Z] steward: reissued orphan task <id>: in_progress > 2h, no worktree.
```

**Empty board (idle):**
```
[2026-08-03T10:20:00Z] claude-worker: cycle ok (0 tasks to process)
```

**Review gate verdict:**
```
[2026-08-03T10:25:00Z] review: PR Mumega-com/mupot#456 head <sha>: verdict GREEN, 0 p0, 0 p1.
```

**SIGTERM drain:**
```
[2026-08-03T10:30:00Z] operator: SIGTERM/SIGINT — draining, will exit after current cycle
[2026-08-03T10:35:00Z] operator: clean exit (SIGTERM drained)
```

### Health Checks

**Is the operator running?**
```bash
systemctl --user is-active mupot-operator.service
# Output: active | inactive
```

**How long since the last cycle?**
```bash
stat -c %y ~/.fleet/logs/operator.log | head -1
# If older than OPERATOR_INTERVAL (300s) + 60s buffer, the loop may be hung.
```

**Are tasks being claimed?**
```bash
tail -100 ~/.fleet/logs/operator.log | grep -E "claimed|cycle ok"
# Should see driver logs indicating tasks processed or "0 tasks" if board is empty.
```

**Are review-gate dedupes working?**
```bash
cat ~/.fleet/state/review-worker-reviewed.json | jq 'keys | length'
# Should grow with each PR reviewed, showing dedupe state is being written.
```

**Has steward repaired anything?**
```bash
tail -50 ~/.fleet/logs/operator.log | grep -E "steward.*reissued"
# If steward is working, you'll see reissue markers when orphans/blocked tasks are found.
```

### Observability Gaps (Known Limits)

The operator loop has minimal built-in observability. For deeper insight:

1. **Task board state:** Check mupot dashboard or call `task_list` via MCP (filter by assignee, status, gate_owner).
2. **Driver-model fallback chains:** Not logged; check env vars (`CLAUDE_WORKER_MODEL`, etc.) against defaults in the scripts.
3. **Review receipts:** Appended to the task body, not a separate log. View via task_get or dashboard.
4. **Worktree disk usage:** Monitor `/home/mumega/mupot-worktrees/` manually; old worktrees are cleaned up after tasks move to review.

---

## Summary

The operator loop is a standing system that:
- Polls once per 300s (configurable).
- Dispatches work to 2–4 execution lanes (tech-grok, claude, mumcp, optionally codex).
- Gates all merges through Kasra-core (no self-close).
- Auto-repairs blocked/orphaned tasks via steward.
- Logs all activity to one file for audit and debugging.

To operate it:
- Monitor `operator.log` for cycle health and driver logs.
- Adjust model assignments via env if needed.
- Restart via systemd on code changes.
- Trust steward to reissue terminal tasks if the block reason is retriable.
- Escalate to a human if a task is stuck in a non-retriable state.

For troubleshooting, consult the known failure modes above and check the script docstrings (each *-worker.py has a full header comment with config and flow details).
