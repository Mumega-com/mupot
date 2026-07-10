import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CHECK_RECEIPT_TYPE,
  REQUIRED_CHECKS,
  REQUIRED_ISSUES,
  REQUIRED_RECEIPTS,
  checkBundle,
  formatPlan,
  parseArgs,
} from '../scripts/release-readiness-receipt.mjs'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'mupot-release-readiness-'))
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2))
}

function writeBundle(dir: string, mutate?: (dir: string) => void) {
  mkdirSync(join(dir, 'host-go'), { recursive: true })
  for (const required of REQUIRED_RECEIPTS) {
    writeJson(join(dir, required.file), {
      receipt_type: required.receipt_type,
      status: 'pass',
      checked_at: '2026-07-10T00:00:00.000Z',
      evidence: {
        objective: required.objective,
        issue: required.issue,
      },
    })
  }

  writeJson(join(dir, 'github-issues.json'), REQUIRED_ISSUES.map((number) => ({
    number,
    title: `issue ${number}`,
    state: 'CLOSED',
    url: `https://github.test/issues/${number}`,
  })))

  writeJson(join(dir, 'github-checks.json'), REQUIRED_CHECKS.map((name) => ({
    name,
    bucket: 'pass',
    state: 'SUCCESS',
    link: `https://github.test/checks/${encodeURIComponent(name)}`,
  })))

  mutate?.(dir)
}

describe('release readiness receipt checker', () => {
  it('parses plan and check arguments', () => {
    expect(parseArgs(['--plan', '--version', 'v0.23.0']).plan).toBe(true)
    expect(parseArgs(['--check', '--out-dir', './tmp/release-readiness']).check).toBe(true)
  })

  it('prints the final release-readiness evidence plan', () => {
    const plan = formatPlan({
      outDir: 'tmp/release-readiness/v0.23.0',
      version: 'v0.23.0',
      repo: 'Mumega-com/mupot',
    })

    expect(plan).toContain('Mupot v0.23 final release-readiness evidence plan')
    expect(plan).toContain('fresh-install-check.json')
    expect(plan).toContain('github-issues.json')
    expect(plan).toContain('github-checks.json')
    expect(plan).toContain('release-readiness-check.json')
  })

  it('passes when every objective receipt, issue, and CI check is present and passing', () => {
    const dir = tempDir()
    writeBundle(dir)

    const receipt = checkBundle({ outDir: dir, version: 'v0.23.0' })

    expect(receipt.receipt_type).toBe(CHECK_RECEIPT_TYPE)
    expect(receipt.status).toBe('pass')
    expect(receipt.summary.required_receipts).toBe(REQUIRED_RECEIPTS.length)
    expect(receipt.summary.required_issues).toBe(REQUIRED_ISSUES.length)
    expect(receipt.summary.required_ci_checks).toBe(REQUIRED_CHECKS.length)
  })

  it('fails when a required receipt has the wrong type', () => {
    const dir = tempDir()
    writeBundle(dir, () => {
      const required = REQUIRED_RECEIPTS[0]
      writeJson(join(dir, required.file), {
        receipt_type: 'wrong/v1',
        status: 'pass',
      })
    })

    const receipt = checkBundle({ outDir: dir, version: 'v0.23.0' })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'receipt_type_matches',
      expected: REQUIRED_RECEIPTS[0].receipt_type,
    }))
  })

  it('fails when a release tracker issue is still open', () => {
    const dir = tempDir()
    writeBundle(dir, () => {
      writeJson(join(dir, 'github-issues.json'), REQUIRED_ISSUES.map((number) => ({
        number,
        state: number === 150 ? 'OPEN' : 'CLOSED',
      })))
    })

    const receipt = checkBundle({ outDir: dir, version: 'v0.23.0' })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'required_issue_closed',
      issue: 150,
    }))
  })

  it('fails when a required CI check did not pass', () => {
    const dir = tempDir()
    writeBundle(dir, () => {
      writeJson(join(dir, 'github-checks.json'), REQUIRED_CHECKS.map((name) => ({
        name,
        bucket: name === 'local-evidence' ? 'fail' : 'pass',
        state: name === 'local-evidence' ? 'FAILURE' : 'SUCCESS',
      })))
    })

    const receipt = checkBundle({ outDir: dir, version: 'v0.23.0' })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'required_ci_check_passed',
      check_name: 'local-evidence',
    }))
  })
})
