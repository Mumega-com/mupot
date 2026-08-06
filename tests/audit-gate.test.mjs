// tests/audit-gate.test.mjs — hermetic tests for the dev-audit allowlist gate.
//
// Every case below is a bypass that was REPRODUCED against a previous version of
// scripts/audit-gate.mjs during review. They are not hypotheticals. Each one exists so
// that specific hole stays shut.
//
// Hermetic on purpose: `evaluate` and `loadAllowlist` are pure, so nothing here touches
// the network, the registry, or the real lockfile. A gate whose tests need a working
// registry cannot be trusted to run when the registry is what is broken.
//
// Run: node --test tests/audit-gate.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluate, loadAllowlist, runAudit, AuditGateError } from '../scripts/audit-gate.mjs'
import { pathsToNode, LockfileGraphError } from '../scripts/lockfile-paths.mjs'

const UNDICI_GHSA = 'GHSA-4cwx-7wf7-3272'

/** The accepted finding, exactly as it appears in .github/audit-allowlist.json. */
function allowEntry(over = {}) {
  return {
    ghsa: UNDICI_GHSA,
    package: 'undici',
    severity: 'high',
    nodes: ['node_modules/undici'],
    isDirect: false,
    paths: [['node_modules/wrangler@4.0.0#sha512-WRANGLER', 'node_modules/miniflare@4.0.0#sha512-MINIFLARE', 'node_modules/undici@7.0.0#sha512-UNDICI']],
    why: 'dev toolchain only',
    accepted_on: '2026-08-04',
    ...over,
  }
}

/** An npm-audit-shaped report carrying one advisory. */
function report({
  pkg = 'undici', ghsa = UNDICI_GHSA, severity = 'high',
  nodes = ['node_modules/undici'], isDirect = false, chain = true, miniflareDirect = false,
} = {}) {
  const vulnerabilities = {
    [pkg]: {
      name: pkg,
      severity,
      nodes,
      isDirect,
      effects: chain ? ['miniflare'] : [],
      via: [{ source: 1130718, name: pkg, title: 'undici thing', url: `https://github.com/advisories/${ghsa}`, severity }],
    },
  }
  if (chain) {
    // The real shape: undici -> miniflare -> wrangler. Only the leaf carries the
    // blocking advisory; the ancestors appear as moderate entries.
    vulnerabilities.miniflare = { name: 'miniflare', severity: 'moderate', nodes: ['node_modules/miniflare'], isDirect: miniflareDirect, effects: ['wrangler'], via: [pkg] }
    vulnerabilities.wrangler = { name: 'wrangler', severity: 'moderate', nodes: ['node_modules/wrangler'], isDirect: true, effects: [], via: ['miniflare'] }
  }
  return { vulnerabilities }
}

/** A package-lock fixture matching `report()`: root -> wrangler -> miniflare -> undici. */
function lockfile({ undiciDirect = false, miniflareDirect = false, alias = false, workspace = false } = {}) {
  const rootDev = { wrangler: '^4' }
  if (undiciDirect) rootDev.undici = '^7'
  if (miniflareDirect) rootDev.miniflare = '^4'
  if (alias) rootDev['wrangler-alias'] = 'npm:wrangler@4.0.0'
  const packages = {
    '': { name: 'fixture', version: '1.0.0', devDependencies: rootDev },
    'node_modules/wrangler': { version: '4.0.0', dev: true, integrity: 'sha512-WRANGLER', dependencies: { miniflare: '^4' } },
    'node_modules/miniflare': { version: '4.0.0', dev: true, integrity: 'sha512-MINIFLARE', dependencies: { undici: '^7' } },
    'node_modules/undici': { version: '7.0.0', dev: true, integrity: 'sha512-UNDICI' },
  }
  if (alias) packages['node_modules/wrangler-alias'] = { name: 'wrangler', version: '4.0.0', dev: true, integrity: 'sha512-WRANGLER', dependencies: { miniflare: '^4' } }
  if (workspace) {
    packages[''].workspaces = ['packages/*']
    packages['node_modules/demo-ws'] = { link: true, resolved: 'packages/demo' }
    packages['packages/demo'] = { version: '1.0.0', devDependencies: { miniflare: '^4' } }
  }
  return { lockfileVersion: 3, packages }
}

function withAllowlistFile(contents, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'audit-gate-'))
  const path = join(dir, 'allowlist.json')
  writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents))
  try {
    return fn(path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── The accepted baseline ────────────────────────────────────────────────────

test('the exact accepted finding passes', () => {
  const { violations, stale } = evaluate(report(), [allowEntry()], lockfile())
  assert.deepEqual(violations, [])
  assert.deepEqual(stale, [])
})

// ── BYPASS 2 (reproduced in review): same GHSA, different package or path ────
//
// An advisory is accepted because of WHERE it sits — dev toolchain, not shippable
// surface. The same CVE arriving through a different package or a different
// dependency path is a different fact and must not inherit the exemption.

test('BYPASS: same allowlisted GHSA under a DIFFERENT package is rejected', () => {
  const { violations } = evaluate(report({ pkg: 'some-prod-dep' }), [allowEntry()], lockfile())
  assert.equal(violations.length, 1)
  assert.match(violations[0], /IS allowlisted, but as undici/)
})

test('BYPASS: same allowlisted GHSA at a DIFFERENT install location is rejected', () => {
  const lock = lockfile()
  lock.packages['node_modules/miniflare/node_modules/undici'] = { version: '9.9.9', dev: true }
  const { violations } = evaluate(
    report({ nodes: ['node_modules/miniflare/node_modules/undici'] }),
    [allowEntry()], lock,
  )
  assert.equal(violations.length, 1)
  assert.match(violations[0], /different finding/)
})

// ── BYPASS 3 (reproduced in review): severity escalation ─────────────────────

test('BYPASS: same allowlisted GHSA re-rated high -> critical is rejected', () => {
  const { violations } = evaluate(report({ severity: 'critical' }), [allowEntry()], lockfile())
  assert.equal(violations.length, 1)
  assert.match(violations[0], /critical/)
})

// ── BYPASS 4 (reproduced in review): direct dependency inherits the exemption ─
//
// `nodes` is where a package is INSTALLED, not how it was REACHED. Adding undici as a
// direct dev dependency produced the same GHSA, same severity and same nodes, so the
// tuple matched and the gate passed. But the exemption's whole justification is the
// ancestry — we carry this only because wrangler needs miniflare. A direct dependency
// destroys that justification while looking identical by install location.

test('BYPASS: the allowlisted advisory as a DIRECT dependency is rejected', () => {
  const { violations } = evaluate(report({ isDirect: true }), [allowEntry()], lockfile({ undiciDirect: true }))
  assert.equal(violations.length, 1)
  assert.match(violations[0], /direct=true/)
})

test('BYPASS: a direct undici edge is rejected even if audit still says isDirect false', () => {
  // Defence in depth: the lockfile path set changes even when the audit summary does not.
  const { violations } = evaluate(report(), [allowEntry()], lockfile({ undiciDirect: true }))
  assert.equal(violations.length, 1)
})

test('BYPASS: the advisory reached by a DIFFERENT chain is rejected', () => {
  // Same package, same install location, same severity — but reached via a different
  // root edge. That is a different decision, not the accepted one.
  const { violations } = evaluate(report(), [allowEntry()], lockfile({ miniflareDirect: true }))
  assert.equal(violations.length, 1)
  assert.match(violations[0], /different finding/)
})

// ── BYPASS 5 (reproduced in review): effects is a NAME SET, not a causal path ─
//
// Making miniflare a DIRECT dev dependency left the flattened ancestry set identical
// — still {miniflare, wrangler} — while the accepted justification ("we carry
// miniflare only because wrangler needs it") became false. Reproduced under npm 9.9.4
// and 10.9.8. Fixing bypass 4 with a sorted name set was the same error as fixing it
// with `nodes`, one level up: binding a projection instead of the thing itself.

test('BYPASS: a new DIRECT edge to an ancestor changes the accepted shape', () => {
  const { violations } = evaluate(report(), [allowEntry()], lockfile({ miniflareDirect: true }))
  assert.equal(violations.length, 1)
  assert.match(violations[0], /different finding/)
})

test('pathsToNode returns the single lockfile chain, with node identity and version', () => {
  assert.deepEqual(pathsToNode(lockfile(), 'node_modules/undici'), [
    ['node_modules/wrangler@4.0.0#sha512-WRANGLER', 'node_modules/miniflare@4.0.0#sha512-MINIFLARE', 'node_modules/undici@7.0.0#sha512-UNDICI'],
  ])
})

// ── BYPASS 6 (reproduced in review): npm ALIASES ─────────────────────────────
//
// `wrangler-alias@npm:wrangler@4.102.0` is a second, distinct root edge to the same
// package. `npm audit --json` keys `vulnerabilities` by package NAME, so both edges
// collapsed into one chain and the gate passed with zero violations. This is where the
// audit summary stopped being fixable — its key space is names, so it cannot express
// node identity at all. Paths now come from the lockfile, keyed by node path.

test('BYPASS: an ALIASED second root edge produces a distinct path', () => {
  const paths = pathsToNode(lockfile({ alias: true }), 'node_modules/undici')
  assert.equal(paths.length, 2)
  assert.ok(paths.some((p) => p[0] === 'node_modules/wrangler-alias@4.0.0#sha512-WRANGLER'))
  assert.ok(paths.some((p) => p[0] === 'node_modules/wrangler@4.0.0#sha512-WRANGLER'))
})

test('BYPASS: the aliased tree is rejected against the accepted single path', () => {
  const { violations } = evaluate(report(), [allowEntry()], lockfile({ alias: true }))
  assert.equal(violations.length, 1)
  assert.match(violations[0], /wrangler-alias/)
})

test('a direct edge to the vulnerable package itself adds a path', () => {
  const paths = pathsToNode(lockfile({ undiciDirect: true }), 'node_modules/undici')
  assert.equal(paths.length, 2)
  assert.ok(paths.some((p) => p.length === 1))
})

test('a direct edge to an intermediate adds a shorter path', () => {
  const paths = pathsToNode(lockfile({ miniflareDirect: true }), 'node_modules/undici')
  assert.equal(paths.length, 2)
  assert.ok(paths.some((p) => p.length === 2))
})

// ── BYPASS 7 (reproduced in review): workspaces are invisible root edges ─────
//
// npm records a workspace as a `link: true` node whose `resolved` points at the
// workspace directory. Skipping link records disconnected every workspace's
// dependencies, so a workspace with a DIRECT miniflare dependency contributed no path
// at all and the gate passed. A workspace's devDependencies are installed exactly like
// the root's, which is the part the first fix missed.

test('BYPASS: a workspace direct dependency creates a real path', () => {
  const paths = pathsToNode(lockfile({ workspace: true }), 'node_modules/undici')
  assert.equal(paths.length, 2)
  assert.ok(paths.some((p) => p.some((seg) => seg.startsWith('packages/demo@'))))
})

test('BYPASS: the workspace tree is rejected against the accepted single path', () => {
  const { violations } = evaluate(report(), [allowEntry()], lockfile({ workspace: true }))
  assert.equal(violations.length, 1)
  assert.match(violations[0], /packages\/demo/)
})

test('a link record with a MISSING target fails closed', () => {
  const lock = lockfile({ workspace: true })
  delete lock.packages['packages/demo']
  assert.throws(() => pathsToNode(lock, 'node_modules/undici'), /link target/)
})

// ── BYPASS 8 (reproduced in review): path + version is not identity ──────────
//
// A locally built tarball named wrangler@4.102.0 occupied the same lockfile path at the
// same version and produced a byte-identical path, while being a different artifact.
// Identity now carries `integrity`, falling back to a normalized `resolved` source.

test('BYPASS: a substituted artifact at the same path and version is rejected', () => {
  const lock = lockfile()
  lock.packages['node_modules/wrangler'].integrity = 'sha512-DIFFERENT-ARTIFACT'
  const { violations } = evaluate(report(), [allowEntry()], lock)
  assert.equal(violations.length, 1)
  assert.match(violations[0], /DIFFERENT-ARTIFACT/)
})

test('a file: source with no integrity is still distinguished by resolved', () => {
  const lock = lockfile()
  delete lock.packages['node_modules/wrangler'].integrity
  lock.packages['node_modules/wrangler'].resolved = 'file:../evil/wrangler-4.0.0.tgz'
  const paths = pathsToNode(lock, 'node_modules/undici')
  assert.match(paths[0][0], /resolved:file:/)
})

test('registry host differences do not churn identity', () => {
  // Same artifact from a mirror must not read as a different node.
  const a = lockfile(); const b = lockfile()
  delete a.packages['node_modules/wrangler'].integrity
  delete b.packages['node_modules/wrangler'].integrity
  a.packages['node_modules/wrangler'].resolved = 'https://registry.npmjs.org/wrangler/-/wrangler-4.0.0.tgz'
  b.packages['node_modules/wrangler'].resolved = 'https://mirror.internal/wrangler/-/wrangler-4.0.0.tgz'
  assert.deepEqual(pathsToNode(a, 'node_modules/undici'), pathsToNode(b, 'node_modules/undici'))
})

// ── Lockfile ambiguity fails closed ──────────────────────────────────────────

test('an unresolvable declared dependency fails closed', () => {
  const lock = lockfile()
  lock.packages['node_modules/miniflare'].dependencies.ghost = '^1'
  assert.throws(() => pathsToNode(lock, 'node_modules/undici'), /cannot resolve/)
})

test('an OPTIONAL uninstalled dependency does not fail', () => {
  const lock = lockfile()
  lock.packages['node_modules/miniflare'].optionalDependencies = { ghost: '^1' }
  assert.doesNotThrow(() => pathsToNode(lock, 'node_modules/undici'))
})

test('an optional PEER that is uninstalled does not fail', () => {
  const lock = lockfile()
  lock.packages['node_modules/miniflare'].peerDependencies = { ghost: '^1' }
  lock.packages['node_modules/miniflare'].peerDependenciesMeta = { ghost: { optional: true } }
  assert.doesNotThrow(() => pathsToNode(lock, 'node_modules/undici'))
})

test('a REQUIRED peer that is uninstalled fails closed', () => {
  const lock = lockfile()
  lock.packages['node_modules/miniflare'].peerDependencies = { ghost: '^1' }
  assert.throws(() => pathsToNode(lock, 'node_modules/undici'), /cannot resolve/)
})

test('a target missing from the lockfile fails closed', () => {
  assert.throws(() => pathsToNode(lockfile(), 'node_modules/nope'), LockfileGraphError)
})

test('an ORPHAN node reachable from no root edge fails closed', () => {
  const lock = lockfile()
  delete lock.packages['node_modules/miniflare'].dependencies
  assert.throws(() => pathsToNode(lock, 'node_modules/undici'), /reachable from no root/)
})

test('a lockfile without a packages map fails closed', () => {
  assert.throws(() => pathsToNode({ lockfileVersion: 1 }, 'node_modules/undici'), LockfileGraphError)
})

test('a cycle in an UNRELATED subtree does not break enumeration', () => {
  // Real lockfiles contain these (browserslist <-> update-browserslist-db). Pruning
  // revisits is simple-path semantics, not the cycle-erasure review objected to when
  // the input was the audit summary rather than the lockfile.
  const lock = lockfile()
  lock.packages[''].devDependencies.cyclic_a = '^1'
  lock.packages['node_modules/cyclic_a'] = { version: '1.0.0', dependencies: { cyclic_b: '^1' } }
  lock.packages['node_modules/cyclic_b'] = { version: '1.0.0', dependencies: { cyclic_a: '^1' } }
  assert.deepEqual(pathsToNode(lock, 'node_modules/undici').length, 1)
})

test('nearest-wins resolution picks a nested copy over the hoisted one', () => {
  const lock = lockfile()
  lock.packages['node_modules/miniflare/node_modules/undici'] = { version: '9.9.9', dev: true }
  const paths = pathsToNode(lock, 'node_modules/miniflare/node_modules/undici')
  assert.deepEqual(paths, [[
    'node_modules/wrangler@4.0.0#sha512-WRANGLER', 'node_modules/miniflare@4.0.0#sha512-MINIFLARE',
    'node_modules/miniflare/node_modules/undici@9.9.9#source:unknown',
  ]])
})

test('UNKNOWN: an unresolvable advisory id makes staleness undecidable, not "gone"', () => {
  // Review finding: with a blocking finding whose id cannot be resolved, the gate used
  // to print "A fix shipped — delete these entries" while a blocking finding was
  // visibly present. It cannot know that. Classify as UNKNOWN and say so.
  const r = {
    vulnerabilities: {
      undici: {
        name: 'undici', severity: 'high', nodes: ['node_modules/undici'], isDirect: false, effects: [],
        via: [{ title: 'no url', severity: 'high' }],
      },
    },
  }
  const { violations, stale } = evaluate(r, [allowEntry()], lockfile())
  assert.equal(violations.length, 1)
  assert.match(violations[0], /no resolvable GHSA/)
  assert.equal(stale.length, 1)
  assert.equal(stale[0].reason, 'unknown')
})

test('an allowlist entry with isDirect true is rejected outright', () => {
  withAllowlistFile({ allowed: [allowEntry({ isDirect: true })] }, (p) => {
    assert.throws(() => loadAllowlist(p), /cannot inherit the transitive-toolchain exemption/)
  })
})

// ── BYPASS 1 (reproduced in review), now hermetic ────────────────────────────
//
// Previously proven only end-to-end with a fake npm on PATH. `runAudit` takes an
// injectable exec so the exit-code contract is testable without a registry.

function execThatExits(status, stdout) {
  return () => {
    const err = new Error(`Command failed with exit code ${status}`)
    err.status = status
    err.stdout = stdout
    err.stderr = 'npm ERR! simulated'
    throw err
  }
}

const ALLOWED_JSON = JSON.stringify(report())

test('BYPASS: npm exiting 2 with parseable JSON is a FAILURE, not a clean audit', () => {
  assert.throws(
    () => runAudit(process.cwd(), execThatExits(2, ALLOWED_JSON)),
    /exited 2 .*Refusing to interpret a failed audit as a clean one/s,
  )
})

test('npm exiting 1 (findings) is the normal path and parses', () => {
  const r = runAudit(process.cwd(), execThatExits(1, ALLOWED_JSON))
  assert.ok(r.vulnerabilities.undici)
})

test('npm exiting 0 parses', () => {
  const r = runAudit(process.cwd(), () => JSON.stringify({ vulnerabilities: {} }))
  assert.deepEqual(r.vulnerabilities, {})
})

test('npm exiting 1 with UNPARSEABLE output fails rather than passing', () => {
  assert.throws(() => runAudit(process.cwd(), execThatExits(1, 'not json')), AuditGateError)
})

test('a killed npm (signal, no status) fails', () => {
  assert.throws(() => runAudit(process.cwd(), () => { const e = new Error('killed'); e.signal = 'SIGKILL'; throw e }), AuditGateError)
})

// ── Both failure directions ──────────────────────────────────────────────────

test('a high advisory that is not allowlisted at all is rejected', () => {
  const { violations } = evaluate(report({ ghsa: 'GHSA-aaaa-bbbb-cccc' }), [allowEntry()], lockfile())
  assert.equal(violations.length, 1)
})

test('STALE/GONE: an advisory that disappeared is reported as gone', () => {
  const { violations, stale } = evaluate({ vulnerabilities: {} }, [allowEntry()], lockfile())
  assert.deepEqual(violations, [])
  assert.equal(stale.length, 1)
  assert.equal(stale[0].ghsa, UNDICI_GHSA)
  assert.equal(stale[0].reason, 'gone')
})

test('STALE/MOVED: a still-present advisory reached differently is NOT reported as gone', () => {
  // The footgun this classification exists to prevent: the entry no longer matches, so
  // it is stale — but the finding is LIVE and only its route changed. Reporting this as
  // "gone, delete it" would make deleting a real exemption the cheapest way to green the
  // build, while the advisory itself stays in the tree.
  const { violations, stale } = evaluate(report({ isDirect: true }), [allowEntry()], lockfile({ undiciDirect: true }))
  assert.equal(violations.length, 1)
  assert.equal(stale.length, 1)
  assert.equal(stale[0].reason, 'moved')
})

test('STALE/GONE when the advisory downgrades below the blocking bar', () => {
  // A high that becomes moderate is genuinely no longer a blocking finding, so the
  // exemption really is dead config and should be deleted.
  const { violations, stale } = evaluate(report({ severity: 'moderate' }), [allowEntry()], lockfile())
  assert.deepEqual(violations, [])
  assert.equal(stale[0].reason, 'gone')
})

test('moderate advisories neither block nor satisfy an allowlist entry', () => {
  // They are below the blocking bar, so they must not count as "present" — otherwise a
  // high that gets DOWNGRADED would keep its exemption alive instead of going stale.
  const { violations, stale } = evaluate(report({ severity: 'moderate' }), [allowEntry()], lockfile())
  assert.deepEqual(violations, [])
  assert.equal(stale.length, 1)
})

test('an advisory with no resolvable GHSA id fails closed', () => {
  const r = {
    vulnerabilities: {
      mystery: { name: 'mystery', severity: 'high', nodes: ['node_modules/mystery'], via: [{ title: 'no url', severity: 'high' }] },
    },
  }
  const { violations } = evaluate(r, [], lockfile())
  assert.equal(violations.length, 1)
  assert.match(violations[0], /no resolvable GHSA/)
})

test('severity falls back to the package aggregate when the advisory omits it', () => {
  const r = report()
  delete r.vulnerabilities.undici.via[0].severity
  assert.deepEqual(evaluate(r, [allowEntry()], lockfile()).violations, [])
})

// ── Unusable input must fail, never pass ─────────────────────────────────────

test('a report with no vulnerabilities object throws rather than passing', () => {
  assert.throws(() => evaluate({}, []), AuditGateError)
  assert.throws(() => evaluate(null, []), AuditGateError)
})

test('an empty audit with an empty allowlist is a legitimate pass', () => {
  const { violations, stale } = evaluate({ vulnerabilities: {} }, [], lockfile())
  assert.deepEqual(violations, [])
  assert.deepEqual(stale, [])
})

// ── Allowlist schema is strict ───────────────────────────────────────────────

test('a missing allowlist file throws', () => {
  assert.throws(() => loadAllowlist('/nonexistent/allowlist.json'), AuditGateError)
})

test('a malformed allowlist throws', () => {
  withAllowlistFile('not json', (p) => assert.throws(() => loadAllowlist(p), AuditGateError))
})

test('an entry missing a required field throws', () => {
  for (const field of ['ghsa', 'package', 'severity', 'nodes', 'isDirect', 'paths', 'why', 'accepted_on']) {
    const entry = allowEntry()
    delete entry[field]
    withAllowlistFile({ allowed: [entry] }, (p) => {
      assert.throws(() => loadAllowlist(p), new RegExp(`missing required field "${field}"`))
    })
  }
})

test('allowlisting a non-blocking severity throws instead of silently pre-forgiving', () => {
  withAllowlistFile({ allowed: [allowEntry({ severity: 'moderate' })] }, (p) => {
    assert.throws(() => loadAllowlist(p), /only high\/critical block/)
  })
})

test('duplicate entries throw', () => {
  withAllowlistFile({ allowed: [allowEntry(), allowEntry()] }, (p) => {
    assert.throws(() => loadAllowlist(p), /duplicate/)
  })
})

test('the real allowlist in this repo satisfies the schema', () => {
  // Guards against the checked-in file drifting out of the shape the gate requires —
  // a broken allowlist would otherwise only surface on the next CI run.
  const allowed = loadAllowlist()
  assert.ok(Array.isArray(allowed))
})

test('node and path order in the allowlist entry does not matter', () => {
  // Two root edges (real wrangler + an alias) give two paths. Declaring them in the
  // opposite order must still match — ordering is normalized, not significant.
  const lock = lockfile({ alias: true })
  const paths = [
    ['node_modules/wrangler@4.0.0#sha512-WRANGLER', 'node_modules/miniflare@4.0.0#sha512-MINIFLARE', 'node_modules/undici@7.0.0#sha512-UNDICI'],
    ['node_modules/wrangler-alias@4.0.0#sha512-WRANGLER', 'node_modules/miniflare@4.0.0#sha512-MINIFLARE', 'node_modules/undici@7.0.0#sha512-UNDICI'],
  ]
  const { violations } = evaluate(report(), [allowEntry({ paths: [...paths].reverse() })], lock)
  assert.deepEqual(violations, [])
})
