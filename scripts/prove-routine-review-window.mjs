// Dedicated review worktree only. Temporarily mutate one guard, require assertion
// failures, restore byte-for-byte, and require the restored suite to exit zero.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const watchdog = 'src/flight/watchdog.ts'
const clock = 'src/routines/review-window.ts'
const actions = 'src/routines/actions.ts'
const cases = [
  ['review-evaluation', watchdog, "status === 'running' && review?.requested_at && review.deadline_at", 'false'],
  ['expiry-boundary', watchdog, 'nowMs >= deadline', 'nowMs > deadline'],
  ['running-budget', watchdog, 'DEFAULT_RUNNING_STALL_TIMEOUT_MS = 60 * 60 * 1000', 'DEFAULT_RUNNING_STALL_TIMEOUT_MS = 120 * 60 * 1000'],
  ['scan-starvation', watchdog, "AND (${flightReviewValueSql('f', 'deadline')} IS NULL\n          OR ${flightReviewValueSql('f', 'deadline')} <= ?3)", 'AND (?3 IS NOT NULL)'],
  ['atomic-review-fence', watchdog, "AND ((${flightReviewValueSql('flights', 'deadline')} = ?7)\n            OR (?7 IS NULL AND ${flightReviewValueSql('flights', 'deadline')} IS NULL))", 'AND (?7 IS NULL OR ?7 IS NOT NULL)'],
  ['canonical-expiry-reason', watchdog, "if (evalResult.reason === 'review_window_expired') reason = 'review_window_expired'", "if (false) reason = 'review_window_expired'"],
  ['review-task-expiry', watchdog, "?12 = 1 AND status = 'review'", "?12 = 0 AND status = 'review'"],
  ['linked-run-terminal', watchdog, 'AND flight_id = ?4\n          AND status IN', 'AND flight_id <> ?4\n          AND status IN'],
  ['default-window', clock, 'DEFAULT_ROUTINE_REVIEW_WINDOW_MS = 24 * 60 * 60 * 1000', 'DEFAULT_ROUTINE_REVIEW_WINDOW_MS = 2 * 60 * 60 * 1000'],
  ['maximum-config', clock, 'MAX_ROUTINE_REVIEW_WINDOW_MS = 7 *', 'MAX_ROUTINE_REVIEW_WINDOW_MS = 30 *'],
  ['review-state', clock, "${run}.waiting_reason = 'review'", '1 = 1'],
  ['current-action', clock, "a.status IN ('waiting','pending')", "a.status IN ('waiting','pending','running')"],
  ['event-action-key', clock, "AND a.action_key = json_extract(${metadata}, '$.action_key')", 'AND 1 = 1'],
  ['event-attempt', clock, "(json_type(${metadata}, '$.attempt') IS NULL OR json_extract(${metadata}, '$.attempt') = ${run}.attempt)", '1 = 1'],
  ['event-producer', clock, "e.actor_type = 'system' AND e.actor_id = '${ROUTINE_ACTOR}'", '1 = 1'],
  ['snapshot-max', clock, '${snapshot} <= ${maximum}', '1 = 1'],
  ['snapshot-min', clock, '${snapshot} >= ${minimum}', '1 = 1'],
  ['mutable-clock', clock, "e.occurred_at, '+24 hours'", "${run}.updated_at, '+24 hours'"],
  ['authorized-task-project', clock, "t.project_id IS json_extract(authorized.value, '$.project_id')", '1 = 1'],
  ['deadline-snapshot', actions, '{ review_deadline_at: routineReviewDeadline(env, now) }', '{}'],
  ['resume-clock', actions, 'UPDATE flights SET resumed_at = ?1', 'UPDATE flights SET resumed_at = resumed_at'],
  ['reobserve-clock', actions, 'UPDATE flights\n          SET resumed_at = ?1', 'UPDATE flights\n          SET resumed_at = resumed_at'],
  ['expired-action', actions, '!pending?.deadline || Date.parse(pending.deadline) <= Date.now()', 'false'],
  ['public-run-deadline', 'src/routines/public.ts', 'review_deadline_at: run.review_deadline_at ?? null', 'review_deadline_at: null'],
  ['task-deadline', clock, 'return deadline ? { ...task, routine_review_deadline_at: deadline } : task', 'return task'],
  ['needs-you-deadline', 'src/attention/service.ts', 'COALESCE(${reviewDeadline}, p.target_date) AS deadline_at', 'p.target_date AS deadline_at'],
]
const requested = new Set(process.argv.slice(2))
const selected = requested.size ? cases.filter(([name]) => requested.has(name)) : cases
if (selected.length !== (requested.size || cases.length)) throw new Error('unknown mutation name')

function suite() {
  return spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
    'tests/routine-review-window.test.ts', '--maxWorkers=2'], { cwd: root, encoding: 'utf8', timeout: 120_000 })
}
const baseline = suite()
if (baseline.status !== 0) {
  process.stderr.write(baseline.stdout + baseline.stderr)
  throw new Error('unmutated baseline must exit zero')
}
const results = []
for (const [name, path, before, after] of selected) {
  const file = new URL(path, new URL('../', import.meta.url))
  const original = readFileSync(file, 'utf8')
  if (!original.includes(before)) throw new Error(`mutation target missing: ${name}`)
  let result
  try {
    writeFileSync(file, original.replaceAll(before, after))
    result = suite()
  } finally { writeFileSync(file, original) }
  const output = result.stdout + result.stderr
  const killed = result.status === 1 && /AssertionError:/.test(output) && /Tests\s+\d+ failed/.test(output)
  results.push({ guard: name, exit: result.status, killed })
  console.log(`${name}: ${killed ? 'KILLED' : 'UNPROVEN'} (exit ${result.status})`)
  if (!killed) process.stderr.write(output)
}
const restored = suite()
console.log(JSON.stringify({ mutations: results, restored_exit: restored.status }, null, 2))
if (restored.status !== 0 || results.some(result => !result.killed)) process.exitCode = 1
