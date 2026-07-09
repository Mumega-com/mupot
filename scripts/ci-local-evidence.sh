#!/usr/bin/env bash
# Run the local Wrangler-backed browser and runtime evidence suites in CI.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PORT="${MUPOT_LOCAL_PORT:-8787}"
BASE_URL="${MUPOT_LOCAL_URL:-http://127.0.0.1:${PORT}}"
EVIDENCE_DIR="${MUPOT_LOCAL_EVIDENCE_DIR:-${ROOT_DIR}/tmp/local-evidence}"
WRANGLER_LOG="${EVIDENCE_DIR}/wrangler-dev.log"

mkdir -p "${EVIDENCE_DIR}" "${ROOT_DIR}/tmp/local-smoke" "${ROOT_DIR}/tmp/local-runtime-conformance"
cd "${ROOT_DIR}"

WRANGLER=(npx --no-install wrangler)
if ! npx --no-install wrangler --version >/dev/null 2>&1; then
  WRANGLER=(npx wrangler)
fi

dev_pid=""
cleanup() {
  if [ -n "${dev_pid}" ] && kill -0 "${dev_pid}" >/dev/null 2>&1; then
    kill "${dev_pid}" >/dev/null 2>&1 || true
    wait "${dev_pid}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

say() {
  printf '==> %s\n' "$*"
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
}

say "Applying local D1 migrations"
npm run migrate:local:test

say "Seeding local D1 fixtures"
npm run seed:local:test

say "Starting local Wrangler server at ${BASE_URL}"
"${WRANGLER[@]}" dev \
  --config wrangler-local-test.toml \
  --port "${PORT}" \
  --show-interactive-dev-session=false \
  --log-level warn \
  >"${WRANGLER_LOG}" 2>&1 &
dev_pid="$!"

wait_for_health

say "Running browser workflow smoke"
MUPOT_LOCAL_URL="${BASE_URL}" \
MUPOT_SMOKE_ARTIFACTS="${ROOT_DIR}/tmp/local-smoke" \
  npm run smoke:local

say "Running runtime adapter conformance"
MUPOT_LOCAL_URL="${BASE_URL}" \
MUPOT_CONFORMANCE_ARTIFACTS="${ROOT_DIR}/tmp/local-runtime-conformance" \
  npm run conformance:runtime:local

say "Local evidence complete"
