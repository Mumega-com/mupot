// CI summary contract: a merged shard report is evidence only if every shard result
// is present, successful, and names every test file exactly once.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { summarizeVitestReport, VitestSummaryError } from '../scripts/ci-vitest-summary.mjs'

function report(overrides = {}) {
  return {
    success: true,
    numTotalTests: 3,
    numPassedTests: 3,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numTotalTestSuites: 2,
    numPassedTestSuites: 2,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    testResults: [
      { name: '/repo/tests/fast.test.ts', status: 'passed', startTime: 1_000, endTime: 1_010, message: '', assertionResults: [{ status: 'passed' }] },
      { name: '/repo/tests/slow.test.ts', status: 'passed', startTime: 2_000, endTime: 2_140, message: '', assertionResults: [{ status: 'passed' }, { status: 'passed' }] },
    ],
    ...overrides,
  }
}

const EXPECTED_FILES = ['/repo/tests/fast.test.ts', '/repo/tests/slow.test.ts']

function summarize(input, expectedFiles = EXPECTED_FILES) {
  return summarizeVitestReport(input, expectedFiles)
}

test('rejects an expected test file omitted from an otherwise coherent report', () => {
  const partial = report({
    numTotalTests: 1,
    numPassedTests: 1,
    numTotalTestSuites: 1,
    numPassedTestSuites: 1,
    testResults: [report().testResults[0]],
  })
  assert.throws(() => summarizeVitestReport(partial, EXPECTED_FILES), /missing expected test file/)
})

test('rejects a result for a test file outside the independently discovered manifest', () => {
  const extra = report({
    numTotalTests: 4,
    numPassedTests: 4,
    numTotalTestSuites: 3,
    numPassedTestSuites: 3,
    testResults: [...report().testResults, {
      name: '/repo/tests/unexpected.test.ts', status: 'passed', startTime: 3_000, endTime: 3_010, message: '', assertionResults: [{ status: 'passed' }],
    }],
  })
  assert.throws(() => summarizeVitestReport(extra, EXPECTED_FILES), /unexpected test file/)
})

test('rejects duplicate files in the independently discovered manifest', () => {
  assert.throws(
    () => summarizeVitestReport(report(), [...EXPECTED_FILES, EXPECTED_FILES[0]]),
    /duplicate expected test file/,
  )
})

test('summarizes total counts and slowest files from successful merged shards', () => {
  const summary = summarize(report())
  assert.deepEqual(summary.counts, { files: 2, tests: 3, passed: 3, failed: 0, pending: 0, todo: 0 })
  assert.deepEqual(summary.slowestFiles, [
    { name: '/repo/tests/slow.test.ts', durationMs: 140, tests: 2 },
    { name: '/repo/tests/fast.test.ts', durationMs: 10, tests: 1 },
  ])
})

test('rejects a report with a failing result even if counts claim success', () => {
  const bad = report({ testResults: [{ ...report().testResults[0], status: 'failed', message: 'boom' }] })
  assert.throws(() => summarize(bad, [bad.testResults[0].name]), VitestSummaryError)
})

test('rejects an error attached to an otherwise passed file', () => {
  const bad = report({ testResults: [{ ...report().testResults[0], message: 'worker teardown error' }] })
  assert.throws(() => summarize(bad, [bad.testResults[0].name]), /reported an error/)
})

test('rejects a report whose result list is absent', () => {
  const bad = report()
  delete bad.testResults
  assert.throws(() => summarize(bad), /testResults/)
})

test('rejects a report with a nonterminal test suite', () => {
  assert.throws(
    () => summarize(report({ numPassedTestSuites: 1, numPendingTestSuites: 1 })),
    /nonterminal test suites/,
  )
})

test('rejects a nonterminal assertion even when its reported counts add up', () => {
  const bad = report({
    numTotalTests: 2,
    numPassedTests: 1,
    numPendingTests: 1,
    testResults: [{
      ...report().testResults[0],
      assertionResults: [{ status: 'passed' }, { status: 'pending' }],
    }],
  })
  assert.throws(() => summarize(bad, [bad.testResults[0].name]), /nonterminal assertion/)
})

test('rejects an unsupported disabled assertion status', () => {
  const bad = report({
    numTotalTests: 2,
    numPassedTests: 1,
    numPendingTests: 1,
    testResults: [{
      ...report().testResults[0],
      assertionResults: [{ status: 'passed' }, { status: 'disabled' }],
    }],
  })
  assert.throws(() => summarize(bad, [bad.testResults[0].name]), /unknown status/)
})

test('counts an intentional skipped assertion as skipped', () => {
  const skipped = report({
    numTotalTests: 2,
    numPassedTests: 1,
    numPendingTests: 1,
    testResults: [{
      ...report().testResults[0],
      assertionResults: [{ status: 'passed' }, { status: 'skipped' }],
    }],
  })
  const summary = summarize(skipped, [skipped.testResults[0].name])
  assert.equal(summary.counts.pending, 1)
})

test('rejects a duplicate test file after merged shard reports overlap', () => {
  const bad = report()
  bad.testResults.push({ ...bad.testResults[0], startTime: 3_000, endTime: 3_010 })
  assert.throws(() => summarize(bad, EXPECTED_FILES), /duplicate test file/)
})
