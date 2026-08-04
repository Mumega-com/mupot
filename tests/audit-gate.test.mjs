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
import { evaluate, loadAllowlist, AuditGateError } from '../scripts/audit-gate.mjs'

const UNDICI_GHSA = 'GHSA-4cwx-7wf7-3272'

/** The accepted finding, exactly as it appears in .github/audit-allowlist.json. */
function allowEntry(over = {}) {
  return {
    ghsa: UNDICI_GHSA,
    package: 'undici',
    severity: 'high',
    nodes: ['node_modules/undici'],
    why: 'dev toolchain only',
    accepted_on: '2026-08-04',
    ...over,
  }
}

/** An npm-audit-shaped report carrying one advisory. */
function report({ pkg = 'undici', ghsa = UNDICI_GHSA, severity = 'high', nodes = ['node_modules/undici'] } = {}) {
  return {
    vulnerabilities: {
      [pkg]: {
        name: pkg,
        severity,
        nodes,
        via: [{ source: 1130718, name: pkg, title: 'undici thing', url: `https://github.com/advisories/${ghsa}`, severity }],
      },
    },
  }
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

// ── Both failure directions ──────────────────────────────────────────────────

test('a high advisory that is not allowlisted at all is rejected', () => {
  const { violations } = evaluate(report({ ghsa: 'GHSA-aaaa-bbbb-cccc' }), [allowEntry()])
  assert.equal(violations.length, 1)
})

test('STALE: an allowlist entry that no longer appears is reported', () => {
  const { violations, stale } = evaluate({ vulnerabilities: {} }, [allowEntry()])
  assert.deepEqual(violations, [])
  assert.equal(stale.length, 1)
  assert.equal(stale[0].ghsa, UNDICI_GHSA)
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
  const r = {
    vulnerabilities: {
      undici: {
        name: 'undici', severity: 'high', nodes: ['node_modules/undici'],
        via: [{ title: 'x', url: `https://github.com/advisories/${UNDICI_GHSA}` }],
      },
    },
  }
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
