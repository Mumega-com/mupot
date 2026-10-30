// Dedicated review worktree only. Temporarily mutate one guard, require assertion
// failures, restore byte-for-byte, and require the restored suite to exit zero.
import { readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync, execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
// Run once, before the baseline or any mutation. A copy in a primary/deploy
// checkout, a branch checkout, or a tree with anyone's uncommitted work is unsafe.
try {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const directory = realpathSync(resolve(root, git('rev-parse', '--git-dir')))
  const common = realpathSync(resolve(root, git('rev-parse', '--git-common-dir')))
  const branch = spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: root, encoding: 'utf8' })
  if (directory === common || branch.status !== 1 || realpathSync(git('rev-parse', '--show-toplevel')) !== realpathSync(root)) {
    throw new Error('requires a dedicated detached worktree')
  }
  if (git('status', '--porcelain', '--untracked-files=normal')) throw new Error('requires a clean tree')
} catch (error) {
  console.error(`Refusing review-window prover: ${error.message}`)
  process.exit(2)
}
if (process.argv.length === 3 && process.argv[2] === '--check-worktree') {
  console.log('worktree safety checks passed')
  process.exit(0)
}
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
  ['physical-baseline-fence', watchdog, "AND (status = 'sleeping' OR COALESCE(resumed_at, started_at, created_at) = ?8)", 'AND (?8 IS NULL OR ?8 IS NOT NULL)'],
  ['unique-flight-binding', clock, "AND bound_run.status IN ('queued','leased','observing','waiting','running')) = 1", "AND bound_run.status IN ('queued','leased','observing','waiting','running')) >= 1"],
  // Schema ownership and the two reader equalities normally reinforce each
  // other. The corrupt-row tests isolate the complete tenant/project boundary.
  ['event-tenant-correlation', clock, [['AND a.tenant = e.tenant', 'AND 1=1'], ['AND e.tenant = ${run}.tenant', 'AND 1=1']]],
  ['event-project-correlation', clock, [['AND a.project_id = e.project_id', 'AND 1=1'], ['AND e.project_id = ${run}.project_id', 'AND 1=1']]],
  ['sql-late-effect', actions, "OR ${routineEffectDeadlineSql('routine_runs')} > ?", 'OR ? IS NOT NULL'],
  ['running-recovery', actions, "action.status !== 'running' && run.status === 'waiting'", "run.status === 'waiting'"],
  ['decision-ends-review', clock, 'AND ${decided} IS NULL', 'AND 1=1'],
  ['decision-execution-baseline', watchdog, 'Number.isFinite(decisionAt) ? Math.max(physicalBaseline, decisionAt) : physicalBaseline', 'physicalBaseline'],
  ['later-real-resume', watchdog, 'Math.max(physicalBaseline, decisionAt)', 'decisionAt'],
  ['decision-race-fence', watchdog, "AND ((${flightReviewValueSql('flights', 'decided')} = ?9)\n            OR (?9 IS NULL AND ${flightReviewValueSql('flights', 'decided')} IS NULL))", 'AND (?9 IS NULL OR ?9 IS NOT NULL)'],
  ['decision-proposal', clock, 'v.proposal_id = ${action}.id', '1=1'],
  ['decision-task', clock, 'v.task_id = ${action}.source_id', '1=1'],
  ['decision-time', clock, 'v.decided_at > ${action}.created_at', '1=1'],
  ['decision-unreversed', clock, 'v.reversed_at IS NULL', '1=1'],
  ['decision-current-task', clock, 'AND decided_task.status = v.verdict', ''],
  ['decision-latest', clock, 'AND NOT EXISTS (SELECT 1 FROM task_verdicts latest WHERE latest.task_id = v.task_id\n        AND (latest.decided_at > v.decided_at OR (latest.decided_at = v.decided_at AND latest.id > v.id)))', ''],
  ['approved-execution-budget', clock, "THEN strftime('${ISO}', julianday(approved_at) + timeout_ms / 86400000.0)", 'THEN review_deadline'],
  ['late-approval', clock, 'WHEN approved_at < review_deadline', 'WHEN approved_at IS NOT NULL'],
  ['prover-dedicated-worktree', 'scripts/prove-routine-review-window.mjs', "directory === common || branch.status !== 1 || realpathSync(git('rev-parse', '--show-toplevel')) !== realpathSync(root)", 'false', ['tests/prove-routine-review-window-safety.test.ts']],
  ['prover-clean-tree', 'scripts/prove-routine-review-window.mjs', "if (git('status', '--porcelain', '--untracked-files=normal'))", 'if (false)', ['tests/prove-routine-review-window-safety.test.ts']],
]
const requested = new Set(process.argv.slice(2))
const selected = requested.size ? cases.filter(([name]) => requested.has(name)) : cases
if (selected.length !== (requested.size || cases.length)) throw new Error('unknown mutation name')

function suite(files = ['tests/routine-review-window.test.ts']) {
  return spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
    ...files, '--maxWorkers=2'], { cwd: root, encoding: 'utf8', timeout: 120_000 })
}
const baseline = suite()
if (baseline.status !== 0) {
  process.stderr.write(baseline.stdout + baseline.stderr)
  throw new Error('unmutated baseline must exit zero')
}
const results = []
for (const [name, path, before, after, files] of selected) {
  const file = new URL(path, new URL('../', import.meta.url))
  const original = readFileSync(file, 'utf8')
  let mutated = original
  for (const [from, to] of Array.isArray(before) ? before : [[before, after]]) {
    if (!mutated.includes(from)) throw new Error(`mutation target missing: ${name}`)
    mutated = mutated.replaceAll(from, to)
  }
  let result
  try {
    writeFileSync(file, mutated)
    result = suite(files)
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
