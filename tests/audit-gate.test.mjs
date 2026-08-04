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
import { evaluate, loadAllowlist, runAudit, ancestryOf, AuditGateError } from '../scripts/audit-gate.mjs'

const UNDICI_GHSA = 'GHSA-4cwx-7wf7-3272'

/** The accepted finding, exactly as it appears in .github/audit-allowlist.json. */
function allowEntry(over = {}) {
  return {
    ghsa: UNDICI_GHSA,
    package: 'undici',
    severity: 'high',
    nodes: ['node_modules/undici'],
    isDirect: false,
    ancestry: ['miniflare', 'wrangler'],
    why: 'dev toolchain only',
    accepted_on: '2026-08-04',
    ...over,
  }
}

/** An npm-audit-shaped report carrying one advisory. */
function report({
  pkg = 'undici', ghsa = UNDICI_GHSA, severity = 'high',
  nodes = ['node_modules/undici'], isDirect = false, chain = true,
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
    vulnerabilities.miniflare = { name: 'miniflare', severity: 'moderate', nodes: ['node_modules/miniflare'], isDirect: false, effects: ['wrangler'], via: [pkg] }
    vulnerabilities.wrangler = { name: 'wrangler', severity: 'moderate', nodes: ['node_modules/wrangler'], isDirect: true, effects: [], via: ['miniflare'] }
  }
  return { vulnerabilities }
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
  const { violations, stale } = evaluate(report(), [allowEntry()])
  assert.deepEqual(violations, [])
  assert.deepEqual(stale, [])
})

// ── BYPASS 2 (reproduced in review): same GHSA, different package or path ────
//
// An advisory is accepted because of WHERE it sits — dev toolchain, not shippable
// surface. The same CVE arriving through a different package or a different
// dependency path is a different fact and must not inherit the exemption.

test('BYPASS: same allowlisted GHSA under a DIFFERENT package is rejected', () => {
  const { violations } = evaluate(report({ pkg: 'some-prod-dep' }), [allowEntry()])
  assert.equal(violations.length, 1)
  assert.match(violations[0], /IS allowlisted, but as undici/)
})

test('BYPASS: same allowlisted GHSA at a DIFFERENT dependency path is rejected', () => {
  const { violations } = evaluate(
    report({ nodes: ['node_modules/express/node_modules/undici'] }),
    [allowEntry()],
  )
  assert.equal(violations.length, 1)
  assert.match(violations[0], /different finding/)
})

// ── BYPASS 3 (reproduced in review): severity escalation ─────────────────────

test('BYPASS: same allowlisted GHSA re-rated high -> critical is rejected', () => {
  const { violations } = evaluate(report({ severity: 'critical' }), [allowEntry()])
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
  const { violations } = evaluate(report({ isDirect: true }), [allowEntry()])
  assert.equal(violations.length, 1)
  assert.match(violations[0], /direct=true/)
})

test('BYPASS: the allowlisted advisory reached by a DIFFERENT ancestry is rejected', () => {
  // Same package, same install location, same severity — but no longer via
  // wrangler > miniflare. That is a different decision, not the accepted one.
  const { violations } = evaluate(report({ chain: false }), [allowEntry()])
  assert.equal(violations.length, 1)
  assert.match(violations[0], /different finding/)
})

test('ancestryOf walks effects transitively', () => {
  assert.deepEqual(ancestryOf(report(), 'undici'), ['miniflare', 'wrangler'])
})

test('ancestryOf terminates on a dependency cycle', () => {
  // A malformed or cyclic effects graph must not hang the gate.
  const cyclic = { vulnerabilities: { a: { effects: ['b'] }, b: { effects: ['a'] } } }
  assert.deepEqual(ancestryOf(cyclic, 'a'), ['a', 'b'])
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
  const { violations } = evaluate(report({ ghsa: 'GHSA-aaaa-bbbb-cccc' }), [allowEntry()])
  assert.equal(violations.length, 1)
})

test('STALE/GONE: an advisory that disappeared is reported as gone', () => {
  const { violations, stale } = evaluate({ vulnerabilities: {} }, [allowEntry()])
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
  const { violations, stale } = evaluate(report({ isDirect: true }), [allowEntry()])
  assert.equal(violations.length, 1)
  assert.equal(stale.length, 1)
  assert.equal(stale[0].reason, 'moved')
})

test('STALE/GONE when the advisory downgrades below the blocking bar', () => {
  // A high that becomes moderate is genuinely no longer a blocking finding, so the
  // exemption really is dead config and should be deleted.
  const { violations, stale } = evaluate(report({ severity: 'moderate' }), [allowEntry()])
  assert.deepEqual(violations, [])
  assert.equal(stale[0].reason, 'gone')
})

test('moderate advisories neither block nor satisfy an allowlist entry', () => {
  // They are below the blocking bar, so they must not count as "present" — otherwise a
  // high that gets DOWNGRADED would keep its exemption alive instead of going stale.
  const { violations, stale } = evaluate(report({ severity: 'moderate' }), [allowEntry()])
  assert.deepEqual(violations, [])
  assert.equal(stale.length, 1)
})

test('an advisory with no resolvable GHSA id fails closed', () => {
  const r = {
    vulnerabilities: {
      mystery: { name: 'mystery', severity: 'high', nodes: ['node_modules/mystery'], via: [{ title: 'no url', severity: 'high' }] },
    },
  }
  const { violations } = evaluate(r, [])
  assert.equal(violations.length, 1)
  assert.match(violations[0], /no resolvable GHSA/)
})

test('severity falls back to the package aggregate when the advisory omits it', () => {
  const r = report()
  delete r.vulnerabilities.undici.via[0].severity
  assert.deepEqual(evaluate(r, [allowEntry()]).violations, [])
})

// ── Unusable input must fail, never pass ─────────────────────────────────────

test('a report with no vulnerabilities object throws rather than passing', () => {
  assert.throws(() => evaluate({}, []), AuditGateError)
  assert.throws(() => evaluate(null, []), AuditGateError)
})

test('an empty audit with an empty allowlist is a legitimate pass', () => {
  const { violations, stale } = evaluate({ vulnerabilities: {} }, [])
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
  for (const field of ['ghsa', 'package', 'severity', 'nodes', 'why', 'accepted_on']) {
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

test('node order in nodes does not matter', () => {
  const r = report({ nodes: ['node_modules/b', 'node_modules/a'] })
  const { violations } = evaluate(r, [allowEntry({ nodes: ['node_modules/a', 'node_modules/b'] })])
  assert.deepEqual(violations, [])
})
