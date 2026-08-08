#!/usr/bin/env bash
# flight-executor-loop — run flights to completion, supervised loop.
#
# Polls running flights assigned to headless agents (asha, steward),
# executes each via prime-agent, submits routine_proposal, marks landed.
# Idempotency-safe; crash-recoverable; respects timeout + budget.
#
# Config (env):
#   REPO                  mupot repo (default ~/mupot)
#   FLIGHT_EXECUTOR_INTERVAL  seconds between polls (default 120)
#   MAX_FLIGHTS           per cycle (default 3)
#   ASHA_TOKEN, STEWARD_TOKEN   agent tokens
#   DRY_RUN               '1' = report, no mutate

set -uo pipefail

REPO="${REPO:-$HOME/mupot}"
INTERVAL="${FLIGHT_EXECUTOR_INTERVAL:-120}"
MAX_FLIGHTS="${MAX_FLIGHTS:-3}"
LOG_DIR="${FLIGHT_EXECUTOR_LOG_DIR:-$HOME/.fleet/logs}"
LOCK="${FLIGHT_EXECUTOR_LOCK:-$HOME/.fleet/flight-executor.lock}"
mkdir -p "$LOG_DIR" "$(dirname "$LOCK")"

exec >>"$LOG_DIR/flight-executor.log" 2>&1

ts(){ date -u +%FT%TZ; }
log(){ echo "[$(ts)] flight-executor: $*"; }

exec 9>"$LOCK"
if ! flock -n 9; then log "another instance holds $LOCK — exiting"; exit 0; fi

STOP=0
on_term(){ log "SIGTERM/SIGINT — draining, will exit after current cycle"; STOP=1; }
trap on_term TERM INT

log "up (repo=$REPO interval=${INTERVAL}s max_flights=$MAX_FLIGHTS pid=$$)"

while [ "$STOP" -eq 0 ]; do
  if [ -f "$REPO/scripts/flight-executor-worker.py" ]; then
    if MAX_FLIGHTS="$MAX_FLIGHTS" python3 "$REPO/scripts/flight-executor-worker.py"; then
      log "cycle ok"
    else
      local rc=$?
      log "cycle exited $rc (continuing — will retry next interval)"
    fi
  else
    log "flight-executor-worker.py not found at $REPO/scripts/flight-executor-worker.py — skipping"
  fi

  # Sleep in short slices so SIGTERM is honored promptly.
  slept=0
  while [ "$slept" -lt "$INTERVAL" ] && [ "$STOP" -eq 0 ]; do
    sleep 5
    slept=$((slept + 5))
  done
done

log "clean exit (SIGTERM drained)"
exit 0
