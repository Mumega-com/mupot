import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHECK_RECEIPT_TYPE, DEPLOYMENT_RECEIPT_TYPE, checkBundle, formatPlan, normalizeVersion } from '../scripts/release-candidate-receipt.mjs'

const VERSION = '0.23.0-rc.1'
const TAG = `v${VERSION}`

function fixture(mutate?: (dir: string, outDir: string, commit: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'mupot-rc-receipt-'))
  const outDir = join(dir, 'tmp', 'release-candidate', TAG)
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'mupot', version: VERSION }))
  writeFileSync(join(dir, 'src', 'version.ts'), `export const MUPOT_PUBLIC_API_VERSION = '${VERSION}' as const\n`)
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Mupot Test', 'commit', '-m', 'rc'], { cwd: dir, stdio: 'ignore' })
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
  execFileSync('git', ['tag', TAG], { cwd: dir })
  writeFileSync(join(outDir, 'deployment.json'), JSON.stringify({
    receipt_type: DEPLOYMENT_RECEIPT_TYPE,
    observed_at: '2026-07-10T16:00:00.000Z',
    target: { base_url: 'https://mupot.example.com', rc_version: TAG, tag: TAG, commit },
    health: { ok: true, service: 'mupot', tenant: 'example', version: VERSION },
  }))
  writeFileSync(join(outDir, 'github-release.json'), JSON.stringify({ tagName: TAG, isPrerelease: true, isDraft: false, targetCommitish: commit }))
  mutate?.(dir, outDir, commit)
  return { dir, outDir }
}

describe('release candidate receipt checker', () => {
  it('normalizes prerelease versions and prints an evidence plan', () => {
    expect(normalizeVersion(TAG)).toEqual({ semver: VERSION, tag: TAG })
    expect(formatPlan({ version: TAG, outDir: 'tmp/rc' })).toContain('release-candidate-check.json')
  })

  it('passes when tag, source versions, deployment receipt, and prerelease agree', () => {
    const { dir, outDir } = fixture()
    const receipt = checkBundle({ repoRoot: dir, outDir, version: TAG })
    expect(receipt.receipt_type).toBe(CHECK_RECEIPT_TYPE)
    expect(receipt.status).toBe('pass')
  })

  it('fails when the deployed health version is not the candidate version', () => {
    const { dir, outDir } = fixture((_, evidenceDir) => {
      const path = join(evidenceDir, 'deployment.json')
      const receipt = JSON.parse(readFileSync(path, 'utf8'))
      receipt.health.version = '0.21.1'
      writeFileSync(path, JSON.stringify(receipt))
    })
    const receipt = checkBundle({ repoRoot: dir, outDir, version: TAG })
    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({ check: 'deployment_health_version_matches', ok: false }))
  })

  it('fails when the GitHub prerelease target is not the candidate commit', () => {
    const { dir, outDir } = fixture((_, evidenceDir) => {
      writeFileSync(join(evidenceDir, 'github-release.json'), JSON.stringify({ tagName: TAG, isPrerelease: true, isDraft: false, targetCommitish: 'main' }))
    })
    const receipt = checkBundle({ repoRoot: dir, outDir, version: TAG })
    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({ check: 'github_prerelease_target_matches_candidate_commit', ok: false }))
  })
})
