#!/usr/bin/env bash
# mupot standing operator — supervised multi-technician loop.
#
# Always-on governed dispatcher: each cycle polls the mumega pot board for
# tasks assigned to each wired technician (cursor, mumcp) and status=open,
# dispatches them via the matching *-worker.py driver, then sleeps and
# repeats. Both drivers already enforce the gate on their own:
#   - cursor-worker.py: isolated git worktree, verify (tsc/tests), driver
#     pushes + opens a PR, task -> review, gate_owner=gate:kasra-core.
#     Cursor never touches the remote and cannot self-close its own task
#     (mupot no-self-close guard, PR #417).
#   - mumcp-worker.py: headless claude -p in the WordPress project dir,
#     WordPress writes are server-forced DRAFT, task -> review,
#     gate_owner=gate:kasra-core.
# Neither driver merges, deploys, publishes, or verdicts a task — that stays
# with the human/Kasra-core gate via task_verdict. This supervisor adds no
# new capability on top of either driver; it only sequences+repeats them.
#
# Idle-safe by construction: both drivers filter task_list to their own
# assignee_agent_id + status=open. An empty board (no tasks assigned to
# either agent) is a no-op cycle — no worktree, no dispatch, no task_update.
#
# Single-instance (flock). Never dies on one cycle's failure — a bad cycle
# (network blip, one driver erroring) logs and the loop continues; the next
# cycle tries again. Structured logs. SIGTERM-clean (drains current cycle,
# exits 0 — systemd Restart=always covers unexpected death).
set -uo pipefail

REPO="${REPO:-/home/mumega/mupot}"
INTERVAL="${OPERATOR_INTERVAL:-300}"           # seconds between polls
MAX_TASKS="${MAX_TASKS:-1}"                    # tasks per driver per cycle
LOG_DIR="${OPERATOR_LOG_DIR:-$HOME/.fleet/logs}"
LOCK="${OPERATOR_LOCK:-$HOME/.fleet/operator.lock}"
mkdir -p "$LOG_DIR" "$(dirname "$LOCK")"

# All stdout/stderr (this script's own log lines AND both drivers' output,
# since run_driver appends to the same file) land in one structured log —
# whether launched interactively, under systemd (journal gets nothing extra
# to duplicate), or backgrounded.
exec >>"$LOG_DIR/operator.log" 2>&1

ts(){ date -u +%FT%TZ; }
log(){ echo "[$(ts)] operator: $*"; }

exec 9>"$LOCK"
if ! flock -n 9; then log "another instance holds $LOCK — exiting"; exit 0; fi

STOP=0
on_term(){ log "SIGTERM/SIGINT — draining, will exit after current cycle"; STOP=1; }
trap on_term TERM INT

log "up (repo=$REPO interval=${INTERVAL}s max_tasks=$MAX_TASKS pid=$$)"

run_driver(){
  # $1 = human label, $2 = script path, rest = extra env already exported by caller
  local label="$1" script="$2"
  if [ ! -f "$script" ]; then
    log "$label: driver not found at $script — skipping this cycle"
    return 0
  fi
  if MAX_TASKS="$MAX_TASKS" REPO="$REPO" python3 "$script" >>"$LOG_DIR/operator.log" 2>&1; then
    log "$label: cycle ok"
  else
    local rc=$?
    log "$label: cycle exited $rc (continuing — will retry next interval)"
  fi
}

while [ "$STOP" -eq 0 ]; do
  run_driver "cursor" "$REPO/scripts/cursor-worker.py"
  run_driver "mumcp"  "$REPO/scripts/mumcp-worker.py"

  # Sleep in short slices so SIGTERM is honored promptly instead of blocking
  # for up to $INTERVAL seconds.
  slept=0
  while [ "$slept" -lt "$INTERVAL" ] && [ "$STOP" -eq 0 ]; do
    sleep 5
    slept=$((slept + 5))
  done
done

log "clean exit (SIGTERM drained)"
exit 0
