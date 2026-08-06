#!/usr/bin/env bash
# Run the local Wrangler-backed browser and runtime evidence suites in CI.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PORT="${MUPOT_LOCAL_PORT:-8787}"
BASE_URL="${MUPOT_LOCAL_URL:-http://127.0.0.1:${PORT}}"
DEFAULT_EVIDENCE_DIR="${ROOT_DIR}/tmp/local-evidence"
DEFAULT_SMOKE_DIR="${ROOT_DIR}/tmp/local-smoke"
DEFAULT_CONFORMANCE_DIR="${ROOT_DIR}/tmp/local-runtime-conformance"
DEFAULT_ROUTINE_DIR="${ROOT_DIR}/tmp/local-project-routine"
ARTIFACT_MARKER=".mupot-local-evidence-artifacts"

resolve_path() {
  node -e '
    const path = require("node:path")
    console.log(path.resolve(process.argv[1], process.argv[2]))
  ' "${ROOT_DIR}" "$1"
}

EVIDENCE_DIR="$(resolve_path "${MUPOT_LOCAL_EVIDENCE_DIR:-${DEFAULT_EVIDENCE_DIR}}")"
SMOKE_DIR="$(resolve_path "${MUPOT_SMOKE_ARTIFACTS:-${DEFAULT_SMOKE_DIR}}")"
CONFORMANCE_DIR="$(resolve_path "${MUPOT_CONFORMANCE_ARTIFACTS:-${DEFAULT_CONFORMANCE_DIR}}")"
ROUTINE_DIR="$(resolve_path "${MUPOT_ROUTINE_ARTIFACTS:-${DEFAULT_ROUTINE_DIR}}")"
WRANGLER_LOG="${EVIDENCE_DIR}/wrangler-dev.log"
WRANGLER_PID_FILE="${EVIDENCE_DIR}/wrangler.pid"
RELEASE_SHA="$(git -C "${ROOT_DIR}" rev-parse HEAD)"
PACKAGE_VERSION="$(node -p "require('${ROOT_DIR}/package.json').version")"

assert_endpoint_free() {
  if node -e '
    const net = require("node:net")
    const target = new URL(process.argv[1])
    const port = Number(target.port || (target.protocol === "https:" ? 443 : 80))
    const socket = net.createConnection({ host: target.hostname, port })
    socket.setTimeout(750)
    socket.once("connect", () => {
      socket.destroy()
      process.exit(0)
    })
    socket.once("error", () => process.exit(1))
    socket.once("timeout", () => {
      socket.destroy()
      process.exit(1)
    })
  ' "${BASE_URL}"; then
    echo "selected endpoint is already served: ${BASE_URL}" >&2
    exit 1
  fi
}

validate_artifact_dir() {
  local target="$1"
  local trusted_default="$2"

  case "${target}" in
    ""|/|"${ROOT_DIR}"|"${ROOT_DIR}/tmp")
      echo "refusing to clear unsafe artifact directory: ${target}" >&2
      exit 1
      ;;
  esac
  if [ -e "${target}" ] \
    && [ "${target}" != "${trusted_default}" ] \
    && [ ! -f "${target}/${ARTIFACT_MARKER}" ]; then
    echo "refusing to clear unmarked artifact directory: ${target}" >&2
    exit 1
  fi
}

assert_artifact_dirs_non_overlapping() {
  node -e '
    const path = require("node:path")
    const directories = [
      ["evidence", process.argv[1]],
      ["browser", process.argv[2]],
      ["runtime", process.argv[3]],
      ["routine", process.argv[4]],
    ]
    const contains = (parent, child) => {
      const relative = path.relative(parent, child)
      return relative === ""
        || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    }
    for (let left = 0; left < directories.length; left += 1) {
      for (let right = left + 1; right < directories.length; right += 1) {
        const [leftName, leftPath] = directories[left]
        const [rightName, rightPath] = directories[right]
        if (contains(leftPath, rightPath) || contains(rightPath, leftPath)) {
          console.error(`artifact directories must be pairwise non-overlapping: ${leftName}=${leftPath}; ${rightName}=${rightPath}`)
          process.exit(1)
        }
      }
    }
  ' "${EVIDENCE_DIR}" "${SMOKE_DIR}" "${CONFORMANCE_DIR}" "${ROUTINE_DIR}"
}

reset_artifact_dir() {
  local target="$1"
  rm -rf -- "${target}"
  mkdir -p -- "${target}"
  : >"${target}/${ARTIFACT_MARKER}"
}

assert_endpoint_free
validate_artifact_dir "${EVIDENCE_DIR}" "${DEFAULT_EVIDENCE_DIR}"
validate_artifact_dir "${SMOKE_DIR}" "${DEFAULT_SMOKE_DIR}"
validate_artifact_dir "${CONFORMANCE_DIR}" "${DEFAULT_CONFORMANCE_DIR}"
validate_artifact_dir "${ROUTINE_DIR}" "${DEFAULT_ROUTINE_DIR}"
assert_artifact_dirs_non_overlapping
reset_artifact_dir "${EVIDENCE_DIR}"
reset_artifact_dir "${SMOKE_DIR}"
reset_artifact_dir "${CONFORMANCE_DIR}"
reset_artifact_dir "${ROUTINE_DIR}"
STATE_DIR="$(mktemp -d "${EVIDENCE_DIR}/state.XXXXXX")"
cd "${ROOT_DIR}"

WRANGLER=(npx --no-install wrangler)
if ! npx --no-install wrangler --version >/dev/null 2>&1; then
  WRANGLER=(npx wrangler)
fi

dev_pid=""
current_dev_pid() {
  if [ -f "${WRANGLER_PID_FILE}" ]; then
    tr -cd '0-9' <"${WRANGLER_PID_FILE}"
  fi
}

process_alive() {
  local pid="$1"
  [ -n "${pid}" ] && kill -0 "${pid}" >/dev/null 2>&1 || return 1
  local state
  state="$(ps -o stat= -p "${pid}" 2>/dev/null | tr -d '[:space:]')"
  [ -n "${state}" ] && [[ "${state}" != Z* ]]
}

stop_wrangler() {
  local pid
  pid="$(current_dev_pid)"
  if process_alive "${pid}"; then
    kill "${pid}" >/dev/null 2>&1 || true
    if [ "${pid}" = "${dev_pid}" ]; then wait "${pid}" >/dev/null 2>&1 || true; fi
  fi
  rm -f -- "${WRANGLER_PID_FILE}"
  dev_pid=""
}

cleanup() {
  stop_wrangler
  if [[ -n "${STATE_DIR}" && "${STATE_DIR}" == "${EVIDENCE_DIR}"/state.* ]]; then
    rm -rf -- "${STATE_DIR}"
  fi
}
trap cleanup EXIT

say() {
  printf '==> %s\n' "$*"
}

assert_dev_process_alive() {
  local pid
  pid="$(current_dev_pid)"
  if ! process_alive "${pid}"; then
    tail -n 120 "${WRANGLER_LOG}" >&2 || true
    echo "spawned Wrangler process is not alive after health became ready" >&2
    exit 1
  fi
}

start_wrangler() {
  "${WRANGLER[@]}" dev \
    --local \
    --config wrangler-local-test.toml \
    --persist-to "${STATE_DIR}" \
    --port "${PORT}" \
    --test-scheduled \
    --var "RELEASE_SHA:${RELEASE_SHA}" \
    --var "PUBLIC_ORIGIN:${BASE_URL}" \
    --show-interactive-dev-session=false \
    --log-level warn \
    >>"${WRANGLER_LOG}" 2>&1 &
  dev_pid="$!"
  printf '%s\n' "${dev_pid}" >"${WRANGLER_PID_FILE}"
}

wait_for_health() {
  local deadline=$((SECONDS + 90))
  until node -e '
    const url = process.argv[1]
    fetch(url).then(async (res) => {
      const json = await res.json().catch(() => null)
      process.exit(res.ok && json?.ok === true ? 0 : 1)
    }).catch(() => process.exit(1))
  ' "${BASE_URL}/health"; do
    if [ -n "${dev_pid}" ] && ! kill -0 "${dev_pid}" >/dev/null 2>&1; then
      tail -n 120 "${WRANGLER_LOG}" >&2 || true
      echo "wrangler dev exited before /health became ready" >&2
      exit 1
    fi
    if [ "${SECONDS}" -ge "${deadline}" ]; then
      tail -n 120 "${WRANGLER_LOG}" >&2 || true
      echo "timed out waiting for ${BASE_URL}/health" >&2
      exit 1
    fi
    sleep 2
  done
  assert_dev_process_alive
  sleep 1
  assert_dev_process_alive
}

say "Applying local D1 migrations"
"${WRANGLER[@]}" d1 migrations apply mupot-local-test \
  --local \
  --config wrangler-local-test.toml \
  --persist-to "${STATE_DIR}"

say "Seeding local D1 fixtures"
"${WRANGLER[@]}" d1 execute mupot-local-test \
  --local \
  --config wrangler-local-test.toml \
  --persist-to "${STATE_DIR}" \
  --file scripts/local-test-seed.sql

say "Starting local Wrangler server at ${BASE_URL}"
: >"${WRANGLER_LOG}"
start_wrangler

wait_for_health

say "Running browser workflow smoke"
assert_dev_process_alive
MUPOT_LOCAL_URL="${BASE_URL}" \
MUPOT_SMOKE_ARTIFACTS="${SMOKE_DIR}" \
  npm run smoke:local

say "Running runtime adapter conformance"
assert_dev_process_alive
MUPOT_LOCAL_URL="${BASE_URL}" \
MUPOT_CONFORMANCE_ARTIFACTS="${CONFORMANCE_DIR}" \
  npm run conformance:runtime:local

say "Running governed Project Routine lifecycle"
assert_dev_process_alive
MUPOT_ROUTINE_OWNER_TOKEN="local-runtime-conformance-owner-token" \
MUPOT_CONFORMANCE_PRIVATE_JWK='{"kty":"OKP","crv":"Ed25519","x":"5hhsUxlkZWNACkMQjUFNIO1-e4bbFtTaLUd7_5L7sdU","d":"8HMGWlPR9d_UaJdSXZDImH431TLG9NNz7cerK-MNIlg","ext":true,"key_ops":["sign"]}' \
MUPOT_ROUTINE_ARTIFACTS="${ROUTINE_DIR}" \
MUPOT_WRANGLER_PID_FILE="${WRANGLER_PID_FILE}" \
MUPOT_LOCAL_STATE_DIR="${STATE_DIR}" \
MUPOT_WRANGLER_LOG="${WRANGLER_LOG}" \
MUPOT_LOCAL_PORT="${PORT}" \
MUPOT_LOCAL_URL="${BASE_URL}" \
  npm run collect:project-routine:local -- \
    --base-url "${BASE_URL}" \
    --out-dir "${ROUTINE_DIR}" \
    --project-id project-mupot \
    --unauthorized-project-id project-mcpwp \
    --squad-id sq-growth \
    --agent-id agent-conformance \
    --unauthorized-agent-id agent-conformance-sender \
    --hooks-module scripts/project-routine-lifecycle-local-hooks.mjs \
    --expected-tenant local \
    --expected-version "${PACKAGE_VERSION}" \
    --expected-commit "${RELEASE_SHA}"

ROUTINE_ID="$(node -p "require('${ROUTINE_DIR}/artifacts/collector-summary.json').routine_id")"
ROUTINE_RUN_ID="$(node -p "require('${ROUTINE_DIR}/artifacts/collector-summary.json').run_id")"
npm run receipt:project-routine:check -- \
  --out-dir "${ROUTINE_DIR}" \
  --pot local \
  --base-url "${BASE_URL}" \
  --project-id project-mupot \
  --routine-id "${ROUTINE_ID}" \
  --routine-run-id "${ROUTINE_RUN_ID}" \
  --expected-commit "${RELEASE_SHA}" \
  --expected-version "${PACKAGE_VERSION}" \
  >"${ROUTINE_DIR}/project-routine-lifecycle-check.json"

say "Local evidence complete"
