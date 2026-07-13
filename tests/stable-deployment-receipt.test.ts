import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as stableReceipt from '../scripts/stable-deployment-receipt.mjs'

const VERSION = '0.23.0'
const TAG = `v${VERSION}`

function fixture(mutate?: (dir: string, outDir: string, commit: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'mupot-stable-deployment-'))
  const outDir = join(dir, 'tmp', 'stable-deployment', TAG)
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'mupot', version: VERSION }))
  writeFileSync(join(dir, 'src', 'version.ts'), `export const MUPOT_PUBLIC_API_VERSION = '${VERSION}' as const\n`)
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['add', 'package.json', 'src/version.ts'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Mupot Test', 'commit', '-m', 'stable release'], { cwd: dir, stdio: 'ignore' })
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
  execFileSync('git', ['tag', TAG], { cwd: dir })
  writeFileSync(join(outDir, 'deployment.json'), JSON.stringify({
    receipt_type: 'mupot-stable-deployment/v1',
    observed_at: '2026-07-13T16:00:00.000Z',
    target: { base_url: 'https://mupot.example.com', version: TAG, tag: TAG, commit },
    health: { ok: true, service: 'mupot', tenant: 'example', version: VERSION, commit },
  }))
  mutate?.(dir, outDir, commit)
  return { dir, outDir, commit }
}

describe('stable deployment receipt checker', () => {
  it('provides the stable deployment receipt script', () => {
    expect(existsSync(join(process.cwd(), 'scripts', 'stable-deployment-receipt.mjs'))).toBe(true)
  })

  it('accepts final semver and rejects release candidates', () => {
    const receipt = stableReceipt as Record<string, any>
    expect(receipt.normalizeVersion('v0.23.0')).toEqual({ semver: '0.23.0', tag: 'v0.23.0' })
    expect(receipt.normalizeVersion('0.23.0')).toEqual({ semver: '0.23.0', tag: 'v0.23.0' })
    expect(() => receipt.normalizeVersion('v0.23.0-rc.1')).toThrow(/final semver release/)
  })

  it('parses plan and check inputs including the expected release SHA', () => {
    const receipt = stableReceipt as Record<string, any>
    const releaseSha = 'a'.repeat(40)
    expect(receipt.parseArgs(['--plan', '--version', 'v0.23.0']).plan).toBe(true)
    expect(receipt.parseArgs(['--check', '--summary', '--release-sha', releaseSha])).toEqual(expect.objectContaining({
      check: true,
      summary: true,
      releaseSha,
    }))
  })

  it('prints a redacted stable deployment evidence plan', () => {
    const receipt = stableReceipt as Record<string, any>
    const releaseSha = 'a'.repeat(40)
    const plan = receipt.formatPlan({
      version: 'v0.23.0',
      releaseSha,
      outDir: 'tmp/stable-deployment/v0.23.0',
    })

    expect(plan).toContain('Mupot stable deployment evidence plan')
    expect(plan).toContain('curl -fsS <base-url>/health')
    expect(plan).toContain(`--release-sha ${releaseSha}`)
    expect(plan).toContain('stable-deployment-check.json')
    expect(plan).toContain('--summary')
    expect(plan).toContain('Keep tokens, cookies, private keys, and provider credentials out of receipts.')
  })

  it('passes when final source, release SHA, deployment target, and live health agree', () => {
    const receiptModule = stableReceipt as Record<string, any>
    const { dir, outDir, commit } = fixture()
    const receipt = receiptModule.checkBundle({
      repoRoot: dir,
      outDir,
      version: TAG,
      releaseSha: commit,
    })

    expect(receipt.receipt_type).toBe('mupot-stable-deployment/v1')
    expect(receipt.status).toBe('pass')
    expect(receipt.target).toEqual(expect.objectContaining({
      version: TAG,
      release_sha: commit,
      head_commit: commit,
    }))
    expect(receipt.summary.failed).toBe(0)
  })

  it('fails when package and public API versions are not the final version', () => {
    const receiptModule = stableReceipt as Record<string, any>
    const { dir, outDir, commit } = fixture((repoRoot) => {
      writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'mupot', version: '0.23.0-rc.1' }))
      writeFileSync(join(repoRoot, 'src', 'version.ts'), "export const MUPOT_PUBLIC_API_VERSION = '0.23.0-rc.1' as const\n")
    })
    const receipt = receiptModule.checkBundle({ repoRoot: dir, outDir, version: TAG, releaseSha: commit })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({ check: 'package_version_matches_expected', ok: false }))
    expect(receipt.checks).toContainEqual(expect.objectContaining({ check: 'public_api_version_matches_expected', ok: false }))
  })

  it('fails when the supplied release SHA is not 40 hexadecimal characters', () => {
    const receiptModule = stableReceipt as Record<string, any>
    const { dir, outDir } = fixture()
    const receipt = receiptModule.checkBundle({ repoRoot: dir, outDir, version: TAG, releaseSha: 'main' })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      check: 'expected_release_sha_is_40_hex',
      ok: false,
    }))
  })

  it('fails when the supplied release SHA differs from local HEAD', () => {
    const receiptModule = stableReceipt as Record<string, any>
    const { dir, outDir } = fixture()
    const receipt = receiptModule.checkBundle({
      repoRoot: dir,
      outDir,
      version: TAG,
      releaseSha: 'b'.repeat(40),
    })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      check: 'expected_release_sha_matches_local_head',
      ok: false,
    }))
  })

  it('fails when deployment target tag, version, or commit differs from the release', () => {
    const receiptModule = stableReceipt as Record<string, any>
    const { dir, outDir, commit } = fixture((_, evidenceDir) => {
      const path = join(evidenceDir, 'deployment.json')
      const deployment = JSON.parse(readFileSync(path, 'utf8'))
      deployment.target.version = 'v0.23.0-rc.1'
      deployment.target.tag = 'v0.23.0-rc.1'
      deployment.target.commit = 'c'.repeat(40)
      writeFileSync(path, JSON.stringify(deployment))
    })
    const receipt = receiptModule.checkBundle({ repoRoot: dir, outDir, version: TAG, releaseSha: commit })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({ check: 'deployment_target_version_matches', ok: false }))
    expect(receipt.checks).toContainEqual(expect.objectContaining({ check: 'deployment_target_commit_matches_release_sha', ok: false }))
  })

  it('fails when live health reports a different version or commit', () => {
    const receiptModule = stableReceipt as Record<string, any>
    const { dir, outDir, commit } = fixture((_, evidenceDir) => {
      const path = join(evidenceDir, 'deployment.json')
      const deployment = JSON.parse(readFileSync(path, 'utf8'))
      deployment.health.version = '0.23.0-rc.1'
      deployment.health.commit = 'd'.repeat(40)
      writeFileSync(path, JSON.stringify(deployment))
    })
    const receipt = receiptModule.checkBundle({ repoRoot: dir, outDir, version: TAG, releaseSha: commit })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({ check: 'deployment_health_version_matches', ok: false }))
    expect(receipt.checks).toContainEqual(expect.objectContaining({ check: 'deployment_health_commit_matches_release_sha', ok: false }))
  })

  it('rejects secret patterns without copying secret material into the receipt', () => {
    const receiptModule = stableReceipt as Record<string, any>
    const secret = `Bearer ${'abcdefghijklmnopqrstuvwxyz123456'}`
    const { dir, outDir, commit } = fixture((_, evidenceDir) => {
      const path = join(evidenceDir, 'deployment.json')
      const deployment = JSON.parse(readFileSync(path, 'utf8'))
      deployment.debug_authorization = secret
      writeFileSync(path, JSON.stringify(deployment))
    })
    const receipt = receiptModule.checkBundle({ repoRoot: dir, outDir, version: TAG, releaseSha: commit })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      check: 'artifact_has_no_secret_material',
      label: 'deployment',
      ok: false,
    }))
    expect(JSON.stringify(receipt)).not.toContain(secret)
  })

  it('runs plan, check, and summary modes through the CLI', () => {
    const script = join(process.cwd(), 'scripts', 'stable-deployment-receipt.mjs')
    const { dir, outDir, commit } = fixture()
    const plan = spawnSync(process.execPath, [script, '--plan', '--version', TAG, '--release-sha', commit], { encoding: 'utf8' })
    const check = spawnSync(process.execPath, [
      script,
      '--check',
      '--summary',
      '--repo-root',
      dir,
      '--out-dir',
      outDir,
      '--version',
      TAG,
      '--release-sha',
      commit,
    ], { encoding: 'utf8' })

    expect(plan.status).toBe(0)
    expect(plan.stdout).toContain('Mupot stable deployment evidence plan')
    expect(check.status).toBe(0)
    expect(check.stdout).toContain('mupot-stable-deployment/v1: pass')
    expect(check.stdout).toMatch(/checks: \d+\/\d+ passed/)
  })
})
