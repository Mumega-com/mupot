// Run only in a builder/review worktree: temporarily mutate one owned source file,
// require assertion failures, restore byte-for-byte, then require the real suite green.
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const service = 'src/telemetry/route-latency.ts'
const api = 'src/dashboard/route-latency.ts'
const cases = [
  ['percentile-rank', service, 'Math.ceil(fraction * sorted.length)', 'Math.floor(fraction * sorted.length)'],
  ['sample-floor', service, 'values.length >= LATENCY_SAMPLE_FLOOR', 'values.length >= 1'],
  ['coverage-fraction', service, 'values.length / total', '1'],
  ['denominator-consistency', service, 'values.length <= total', 'true'],
  ['M6_M7-complete-gap', service, 'values.length < total || ', ''],
  ['M11-warmup-boundary', service, 'since <= start', 'since < start'],
  ['collection-warmup', service, 'since !== null && since <= start', 'true'],
  ['M13-collection-tenant', service, 'FROM route_latency_collection WHERE tenant = ?1 AND route = ?2', 'FROM route_latency_collection WHERE route = ?2'],
  ['tenant-isolation', service, 'WHERE tenant = ?1 AND route = ?2 AND observed_at_ms >= ?3', 'WHERE route = ?2 AND observed_at_ms >= ?3'],
  ['M5-window-end', service, 'observed_at_ms < ?4', 'observed_at_ms <= ?4'],
  ['sample-retention', service, 'DELETE FROM route_latency_samples WHERE tenant = ?1 AND route = ?2 AND observed_at_ms < ?3', 'DELETE FROM route_latency_samples WHERE tenant = ?1 AND route = ?2 AND observed_at_ms < ?3 AND 0'],
  ['counter-retention', service, 'DELETE FROM route_latency_requests WHERE tenant = ?1 AND route = ?2 AND bucket_ms < ?3', 'DELETE FROM route_latency_requests WHERE tenant = ?1 AND route = ?2 AND bucket_ms < ?3 AND 0'],
  ['cutoff-route-index', service, 'tenant = ?1 AND route = ?2 AND observed_at_ms < ?3', 'tenant = ?1 AND observed_at_ms < ?3'],
  ['sample-cap', service, 'LIMIT -1 OFFSET ?3)', 'LIMIT -1 OFFSET (?3 + 1))'],
  ['literal-cap', service, 'export const MAX_LATENCY_SAMPLES = 20_000', 'export const MAX_LATENCY_SAMPLES = 200_000'],
  ['literal-retention', service, 'export const RETENTION_MS = 14 * DAY_MS', 'export const RETENTION_MS = 30 * DAY_MS'],
  ['route-allowlist', service, 'route !== BOARD_LATENCY_ROUTE', 'false'],
  ['duration-validation', service, '!Number.isFinite(duration) || duration < 0', 'false'],
  ['timestamp-validation', service, '!Number.isSafeInteger(value) || value < 0', 'false'],
  ['sample-time-bounds', service, 'observedAt < now - RETENTION_MS || observedAt > now', 'false'],
  ['off-path-persistence', service, 'if (waitUntil) waitUntil(work)', 'await work'],
  ['timer-counter-order', service, 'const start = performance.now()', 'await countRouteRequest(env, BOARD_LATENCY_ROUTE, observedAt); const start = performance.now()'],
  ['failure-marker', service, 'await env.SESSIONS.put(', 'await Promise.resolve('],
  ['failure-marker-unique', service, 'failurePrefix(env.TENANT_SLUG, observedAt) + crypto.randomUUID()', "failurePrefix(env.TENANT_SLUG, observedAt) + 'same-key'"],
  ['window-bounds', service, '!Number.isInteger(days) || days < 1 || days > 13', 'false'],
  ['M1-admin-tenant', api, 'auth.tenant !== c.env.TENANT_SLUG || ', ''],
  ['admin-role', api, '!isOrgAdmin(auth)', 'false'],
  ['no-store', api, "'no-store'", "'public'"],
  ['query-selectors', api, "c.req.query('route') !== undefined || !/^(?:[1-9]|1[0-3])$/.test(raw)", 'false'],
  ['canonical-query-only', 'src/dashboard/index.ts', "&& new URL(c.req.url).search === ''", ''],
  ['get-method-scope', 'src/dashboard/index.ts', "c.req.method === 'GET' &&", 'true &&'],
  ['real-page-instrumentation', 'src/dashboard/index.ts', 'return canonical ? measureBoardRead(c.env, run, waitUntilFromContext(c)) : run()', 'return run()'],
  ['schema-route-guard', 'migrations/0268_route_latency_retention.sql', "CHECK (route = 'GET /dashboard/kanban')", ''],
  ['maintenance-wiring', 'src/index.ts', "['board-latency-retention', () => pruneRouteLatency(env)]", "['board-latency-retention', () => Promise.resolve()]"],
  ['dashboard-mount', 'src/dashboard/index.ts', "dashboardApp.route('/', routeLatencyApp)", "dashboardApp.route('/unused', routeLatencyApp)"],
]

const requested = new Set(process.argv.slice(2))
const selected = requested.size === 0 ? cases : cases.filter(([name]) => requested.has(name))
if (selected.length !== (requested.size || cases.length)) throw new Error('unknown mutation name')

function suite(files = ['tests/route-latency.test.ts', 'tests/route-latency-routes.test.ts', 'tests/route-latency-maintenance.test.ts', 'tests/route-latency-round2.test.ts']) {
  return spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...files, '--maxWorkers=2'], {
    cwd: root, encoding: 'utf8', timeout: 120_000,
  })
}
const baseline = suite()
if (baseline.status !== 0) {
  process.stderr.write(baseline.stdout + baseline.stderr)
  throw new Error('unmutated baseline must exit 0')
}
const report = []
for (const [name, path, before, after] of selected) {
  const url = new URL(path, new URL('../', import.meta.url))
  const original = readFileSync(url, 'utf8')
  if (!original.includes(before)) throw new Error(`mutation target missing: ${name}`)
  let result
  try {
    writeFileSync(url, original.replaceAll(before, after))
    const files = path === service || path.startsWith('migrations/') ? ['tests/route-latency.test.ts', 'tests/route-latency-round2.test.ts']
      : path === 'src/index.ts' ? ['tests/route-latency-maintenance.test.ts'] : ['tests/route-latency-routes.test.ts', 'tests/route-latency-round2.test.ts']
    result = suite(files)
  } finally {
    writeFileSync(url, original)
  }
  const output = result.stdout + result.stderr
  // Compile/import/setup failures are not proof that a behavioral guard was tested.
  const killed = result.status === 1 && /AssertionError:/.test(output) && /Tests\s+\d+ failed/.test(output)
  report.push({ guard: name, mutant_exit: result.status, killed })
  console.log(`${name}: ${killed ? 'KILLED' : 'UNPROVEN'} (exit ${result.status})`)
  if (!killed) process.stderr.write(output)
}
const restored = suite()
console.log(`restored suite: exit ${restored.status}`)
console.log(JSON.stringify({ mutations: report, restored_exit: restored.status }, null, 2))
if (report.some(row => !row.killed) || restored.status !== 0) process.exitCode = 1
