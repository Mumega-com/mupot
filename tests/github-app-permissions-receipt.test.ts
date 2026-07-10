import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CHECK_RECEIPT_TYPE,
  REQUIRED_APP_PERMISSIONS,
  checkBundle,
  formatPlan,
  parseArgs,
} from '../scripts/github-app-permissions-receipt.mjs'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'mupot-github-app-permissions-'))
}

function writeApp(dir: string, permissions: Record<string, string> = REQUIRED_APP_PERMISSIONS) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'github-app.json'), JSON.stringify({
    id: 123456,
    slug: 'mupot',
    html_url: 'https://github.com/apps/mupot',
    permissions,
  }, null, 2))
}

describe('GitHub App permissions receipt checker', () => {
  it('parses plan and check arguments', () => {
    expect(parseArgs(['--plan', '--app', 'mupot']).plan).toBe(true)
    expect(parseArgs(['--check', '--out-dir', './tmp/github-app-permissions/mupot']).check).toBe(true)
  })

  it('prints the #151 evidence plan', () => {
    const plan = formatPlan({
      outDir: 'tmp/github-app-permissions/mupot',
      app: 'mupot',
    })

    expect(plan).toContain('Mupot v0.23 GitHub App least-privilege evidence plan')
    expect(plan).toContain('GET /app')
    expect(plan).toContain('github-app.json')
    expect(plan).toContain('github-app-permissions-check.json')
    expect(plan).toContain('workflows: none')
  })

  it('passes when the App has only the v0.23 least-privilege set', () => {
    const dir = tempDir()
    writeApp(dir)

    const receipt = checkBundle({ outDir: dir, app: 'mupot' })

    expect(receipt.receipt_type).toBe(CHECK_RECEIPT_TYPE)
    expect(receipt.status).toBe('pass')
    expect(receipt.summary.required_app_permissions).toBe(Object.keys(REQUIRED_APP_PERMISSIONS).length)
  })

  it('fails when workflows permission is still enabled', () => {
    const dir = tempDir()
    writeApp(dir, {
      ...REQUIRED_APP_PERMISSIONS,
      workflows: 'write',
    })

    const receipt = checkBundle({ outDir: dir, app: 'mupot' })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'github_app_workflows_disabled',
      actual: 'write',
    }))
  })

  it('fails when extra organization admin permissions are present', () => {
    const dir = tempDir()
    writeApp(dir, {
      ...REQUIRED_APP_PERMISSIONS,
      organization_secrets: 'write',
    })

    const receipt = checkBundle({ outDir: dir, app: 'mupot' })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'github_app_has_no_extra_permissions',
      extras: [{ permission: 'organization_secrets', actual: 'write' }],
    }))
  })

  it('fails when the exported App slug is not the expected App', () => {
    const dir = tempDir()
    writeApp(dir)
    writeFileSync(join(dir, 'github-app.json'), JSON.stringify({
      id: 654321,
      slug: 'wrong-app',
      permissions: REQUIRED_APP_PERMISSIONS,
    }, null, 2))

    const receipt = checkBundle({ outDir: dir, app: 'mupot' })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'github_app_slug_matches',
      expected: 'mupot',
      actual: 'wrong-app',
    }))
  })
})
