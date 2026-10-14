#!/usr/bin/env node
// Turn Vitest's merged JSON report into an auditable CI summary. The merge step is
// intentionally separate: this script treats a partial or failed report as no result.

import { appendFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export class VitestSummaryError extends Error {}

function requireNonNegativeInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new VitestSummaryError(`${field} must be a non-negative integer`)
  }
  return value
}

function requireReport(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new VitestSummaryError('Vitest JSON report must be an object')
  }
  return value
}

function requireExpectedFiles(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new VitestSummaryError('expected test file manifest must be a non-empty array')
  }
  const names = new Set()
  for (const [index, name] of value.entries()) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new VitestSummaryError(`expected test file manifest entry ${index} is invalid`)
    }
    if (names.has(name)) throw new VitestSummaryError(`duplicate expected test file: ${name}`)
    names.add(name)
  }
  return names
}

/**
 * Validate the merged default-run report and return the count and timing projection
 * written to CI. The report is not accepted merely because the merge command exited 0:
 * a failed suite, missing result list, or overlapping shard is still a failed run.
 */
export function summarizeVitestReport(input, expectedFiles, limit = 30) {
  const report = requireReport(input)
  const expectedNames = requireExpectedFiles(expectedFiles)
  if (report.success !== true) throw new VitestSummaryError('Vitest report did not succeed')

  const totals = {
    tests: requireNonNegativeInteger(report.numTotalTests, 'numTotalTests'),
    passed: requireNonNegativeInteger(report.numPassedTests, 'numPassedTests'),
    failed: requireNonNegativeInteger(report.numFailedTests, 'numFailedTests'),
    pending: requireNonNegativeInteger(report.numPendingTests, 'numPendingTests'),
    todo: requireNonNegativeInteger(report.numTodoTests, 'numTodoTests'),
    suites: requireNonNegativeInteger(report.numTotalTestSuites, 'numTotalTestSuites'),
    passedSuites: requireNonNegativeInteger(report.numPassedTestSuites, 'numPassedTestSuites'),
    failedSuites: requireNonNegativeInteger(report.numFailedTestSuites, 'numFailedTestSuites'),
    pendingSuites: requireNonNegativeInteger(report.numPendingTestSuites, 'numPendingTestSuites'),
  }
  if (totals.failed !== 0 || totals.failedSuites !== 0) {
    throw new VitestSummaryError(`Vitest report contains ${totals.failed} failed tests and ${totals.failedSuites} failed suites`)
  }
  if (totals.pendingSuites !== 0) {
    throw new VitestSummaryError(`Vitest report contains ${totals.pendingSuites} nonterminal test suites`)
  }
  if (totals.tests !== totals.passed + totals.failed + totals.pending + totals.todo) {
    throw new VitestSummaryError('Vitest test counts do not add up')
  }
  if (totals.suites !== totals.passedSuites + totals.failedSuites + totals.pendingSuites) {
    throw new VitestSummaryError('Vitest suite counts do not add up')
  }
  if (!Array.isArray(report.testResults) || report.testResults.length === 0) {
    throw new VitestSummaryError('Vitest report has no testResults')
  }
  if (!Number.isInteger(limit) || limit < 1) throw new VitestSummaryError('summary limit must be a positive integer')

  const names = new Set()
  const assertionCounts = { passed: 0, failed: 0, pending: 0, todo: 0 }
  const files = report.testResults.map((result, index) => {
    if (!result || typeof result !== 'object' || typeof result.name !== 'string' || result.name.length === 0) {
      throw new VitestSummaryError(`testResults[${index}] is missing a file name`)
    }
    if (names.has(result.name)) throw new VitestSummaryError(`duplicate test file in merged report: ${result.name}`)
    names.add(result.name)
    if (result.status !== 'passed') throw new VitestSummaryError(`test file failed: ${result.name}`)
    if (typeof result.message !== 'string' || result.message.length > 0) {
      throw new VitestSummaryError(`test file reported an error: ${result.name}`)
    }
    if (!Array.isArray(result.assertionResults)) {
      throw new VitestSummaryError(`test file is missing assertion results: ${result.name}`)
    }
    for (const assertion of result.assertionResults) {
      if (!assertion || typeof assertion !== 'object') {
        throw new VitestSummaryError(`test file has an invalid assertion result: ${result.name}`)
      }
      if (assertion.status === 'failed') throw new VitestSummaryError(`test assertion failed in ${result.name}`)
      if (Array.isArray(assertion.failureMessages) && assertion.failureMessages.length > 0) {
        throw new VitestSummaryError(`test assertion reported an error in ${result.name}`)
      }
      if (assertion.status === 'passed') assertionCounts.passed += 1
      else if (assertion.status === 'failed') assertionCounts.failed += 1
      else if (assertion.status === 'todo') assertionCounts.todo += 1
      else if (assertion.status === 'skipped') assertionCounts.pending += 1
      else if (assertion.status === 'pending') throw new VitestSummaryError(`nonterminal assertion in ${result.name}`)
      else throw new VitestSummaryError(`test assertion has an unknown status in ${result.name}`)
    }
    if (!Number.isFinite(result.startTime) || !Number.isFinite(result.endTime) || result.endTime < result.startTime) {
      throw new VitestSummaryError(`test file has invalid timing: ${result.name}`)
    }
    return {
      name: result.name,
      durationMs: result.endTime - result.startTime,
      tests: result.assertionResults.length,
    }
  })

  if (totals.tests !== assertionCounts.passed + assertionCounts.failed + assertionCounts.pending + assertionCounts.todo) {
    throw new VitestSummaryError('Vitest assertion results do not add up to numTotalTests')
  }
  for (const field of ['passed', 'failed', 'pending', 'todo']) {
    if (totals[field] !== assertionCounts[field]) {
      throw new VitestSummaryError(`Vitest ${field} count does not match assertion results`)
    }
  }
  const missing = [...expectedNames].filter((name) => !names.has(name))
  if (missing.length > 0) throw new VitestSummaryError(`missing expected test file: ${missing.join(', ')}`)
  const unexpected = [...names].filter((name) => !expectedNames.has(name))
  if (unexpected.length > 0) throw new VitestSummaryError(`unexpected test file: ${unexpected.join(', ')}`)
  return {
    counts: { files: files.length, tests: totals.tests, passed: totals.passed, failed: totals.failed, pending: totals.pending, todo: totals.todo },
    slowestFiles: files.sort((a, b) => b.durationMs - a.durationMs || a.name.localeCompare(b.name)).slice(0, limit),
  }
}

export function formatSummary(summary) {
  const { counts, slowestFiles } = summary
  const lines = [
    '## Vitest shard summary',
    '',
    `- Files: ${counts.files}`,
    `- Tests: ${counts.tests} (${counts.passed} passed, ${counts.failed} failed, ${counts.pending} skipped, ${counts.todo} todo)`,
    '',
    '### Slowest test files',
    '',
    '| Test window | Tests | File |',
    '| ---: | ---: | --- |',
    ...slowestFiles.map((file) => `| ${file.durationMs.toFixed(1)} ms | ${file.tests} | \`${file.name}\` |`),
    '',
  ]
  return lines.join('\n')
}

export function readExpectedFiles(path) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new VitestSummaryError(`cannot read expected Vitest file manifest: ${error.message}`)
  }
  if (!Array.isArray(manifest)) throw new VitestSummaryError('expected Vitest file manifest must be an array')
  return manifest.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || typeof entry.file !== 'string' || entry.file.length === 0) {
      throw new VitestSummaryError(`expected Vitest file manifest entry ${index} is missing file`)
    }
    return entry.file
  })
}

function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.length !== 2) throw new VitestSummaryError('usage: ci-vitest-summary.mjs <merged-vitest-results.json> <expected-vitest-files.json>')
  let report
  try {
    report = JSON.parse(readFileSync(argv[0], 'utf8'))
  } catch (error) {
    throw new VitestSummaryError(`cannot read merged Vitest report: ${error.message}`)
  }
  const text = formatSummary(summarizeVitestReport(report, readExpectedFiles(argv[1])))
  process.stdout.write(`${text}\n`)
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`)
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`ci-vitest-summary: ${error.message}\n`)
    process.exitCode = 1
  }
}
