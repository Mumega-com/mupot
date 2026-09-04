import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHECK_RECEIPT_TYPE, DEPLOYMENT_RECEIPT_TYPE, checkBundle, formatPlan, normalizeSourceVersion, normalizeVersion, parseArgs } from '../scripts/release-candidate-receipt.mjs'

const VERSION = '0.23.0-rc.1'
const TAG = `v${VERSION}`

function fixture(mutate?: (dir: string, outDir: string, commit: string) => void, sourceVersion = VERSION) {
  const dir = mkdtempSync(join(tmpdir(), 'mupot-rc-receipt-'))
  const outDir = join(dir, 'tmp', 'release-candidate', TAG)
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'mupot', version: sourceVersion }))
  writeFileSync(join(dir, 'src', 'version.ts'), `export const MUPOT_PUBLIC_API_VERSION = '${sourceVersion}' as const\n`)
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Mupot Test', 'commit', '-m', 'rc'], { cwd: dir, stdio: 'ignore' })
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
  execFileSync('git', ['tag', TAG], { cwd: dir })
  writeFileSync(join(outDir, 'deployment.json'), JSON.stringify({
    receipt_type: DEPLOYMENT_RECEIPT_TYPE,
    observed_at: '2026-07-10T16:00:00.000Z',
    target: { base_url: 'https://mupot.example.com', rc_version: TAG, source_version: sourceVersion, tag: TAG, commit },
    health: { ok: true, service: 'mupot', tenant: 'example', version: sourceVersion, commit, clean: true },
  }))
  writeFileSync(join(outDir, 'github-release.json'), JSON.stringify({ tagName: TAG, isPrerelease: true, isDraft: false, targetCommitish: commit, publishedAt: '2026-07-10T16:00:00.000Z' }))
  writeFileSync(join(outDir, 'github-tag.json'), JSON.stringify({ sha: commit, html_url: `https://github.test/commit/${commit}` }))
  mutate?.(dir, outDir, commit)
  return { dir, outDir }
}

describe('release candidate receipt checker', () => {
  it('normalizes prerelease versions and prints an evidence plan', () => {
    expect(normalizeVersion(TAG)).toEqual({ semver: VERSION, tag: TAG })
    expect(formatPlan({ version: TAG, outDir: 'tmp/rc' })).toContain('release-candidate-check.json')
  })

  it('shell-quotes every evidence redirection target in plans', () => {
    const outDir = "tmp/rc plan;unsafe'path"
    const plan = formatPlan({ version: TAG, outDir })
    const redirects = plan.match(/^.* > .*$/gm) ?? []

    expect(redirects).toHaveLength(4)
    for (const line of redirects) {
      expect(line).toMatch(/ > '.*'$/)
      expect(line).not.toContain(` > ${outDir}/`)
    }
    expect(plan).toContain("'tmp/rc plan;unsafe'\\''path/github-tag.json'")
  })

  it('parses and prints an explicit source version separately from the RC identity', () => {
    expect(parseArgs(['--check', '--version', 'v0.30.0-rc.1', '--source-version', 'v0.30.0']).sourceVersion).toBe('v0.30.0')
    const plan = formatPlan({ version: 'v0.30.0-rc.1', sourceVersion: 'v0.30.0', outDir: 'tmp/rc' })
    expect(plan).toContain('source package/API version 0.30.0')
    expect(plan).toContain('--source-version v0.30.0')
  })

  it('documents the source-version split in CLI help', () => {
    const help = execFileSync(process.execPath, ['scripts/release-candidate-receipt.mjs', '--help'], { encoding: 'utf8' })
    expect(help).toContain('--version <rc-version>')
    expect(help).toContain('--source-version <version>')
  })

  it('rejects malformed source versions before checking evidence', () => {
    expect(() => normalizeSourceVersion('0.30')).toThrow('expected a source version')
    expect(() => normalizeSourceVersion('0.30.0-beta.1')).toThrow('expected a source version')
  })

  it('passes when tag, source versions, deployment receipt, and prerelease agree', () => {
    const { dir, outDir } = fixture()
    const receipt = checkBundle({ repoRoot: dir, outDir, version: TAG })
    expect(receipt.receipt_type).toBe(CHECK_RECEIPT_TYPE)
    expect(receipt.status).toBe('pass')
  })

  it('passes when an RC tag identifies an exact final-version source build', () => {
    const { dir, outDir } = fixture(undefined, '0.30.0')
    const receipt = checkBundle({ repoRoot: dir, outDir, version: TAG, sourceVersion: 'v0.30.0' })
    expect(receipt.status).toBe('pass')
    expect(receipt.target.source_version).toBe('0.30.0')
  })

  it('fails when the package version differs from the explicit source version', () => {
    const { dir, outDir } = fixture((repoDir) => {
      writeFileSync(join(repoDir, 'package.json'), JSON.stringify({ name: 'mupot', version: '0.29.0' }))
    }, '0.30.0')
    const receipt = checkBundle({ repoRoot: dir, outDir, version: TAG, sourceVersion: 'v0.30.0' })
    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({ check: 'package_version_matches_source', ok: false }))
  })

  it('fails when the deployed health version is not the source version', () => {
    const { dir, outDir } = fixture((_, evidenceDir) => {
      const path = join(evidenceDir, 'deployment.json')
      const receipt = JSON.parse(readFileSync(path, 'utf8'))
      receipt.health.version = '0.21.1'
      writeFileSync(path, JSON.stringify(receipt))
    })
    const receipt = checkBundle({ repoRoot: dir, outDir, version: TAG })
    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({ check: 'deployment_health_version_matches_source', ok: false }))
  })

  it('fails when live health serves a different commit', () => {
    const { dir, outDir } = fixture((_, evidenceDir) => {
      const path = join(evidenceDir, 'deployment.json')
      const receipt = JSON.parse(readFileSync(path, 'utf8'))
      receipt.health.commit = 'f'.repeat(40)
      writeFileSync(path, JSON.stringify(receipt))
    })
    const receipt = checkBundle({ repoRoot: dir, outDir, version: TAG })
    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({ check: 'deployment_health_commit_matches_candidate_commit', ok: false }))
  })

  it('fails when live health reports a dirty build', () => {
    const { dir, outDir } = fixture((_, evidenceDir) => {
      const path = join(evidenceDir, 'deployment.json')
      const receipt = JSON.parse(readFileSync(path, 'utf8'))
      receipt.health.clean = false
      writeFileSync(path, JSON.stringify(receipt))
    })
    const receipt = checkBundle({ repoRoot: dir, outDir, version: TAG })
    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({ check: 'deployment_health_clean', ok: false }))
  })

  it('fails when the deployment target names another source version', () => {
    const { dir, outDir } = fixture((_, evidenceDir) => {
      const path = join(evidenceDir, 'deployment.json')
      const receipt = JSON.parse(readFileSync(path, 'utf8'))
      receipt.target.source_version = '0.29.0'
      writeFileSync(path, JSON.stringify(receipt))
    }, '0.30.0')
    const receipt = checkBundle({ repoRoot: dir, outDir, version: TAG, sourceVersion: 'v0.30.0' })
    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({ check: 'deployment_target_source_version_matches', ok: false }))
  })

  it('accepts a branch-valued GitHub prerelease target when the remote tag resolves the candidate commit', () => {
    const { dir, outDir } = fixture((_, evidenceDir) => {
      writeFileSync(join(evidenceDir, 'github-release.json'), JSON.stringify({ tagName: TAG, isPrerelease: true, isDraft: false, targetCommitish: 'main', publishedAt: '2026-07-10T16:00:00.000Z' }))
    })
    const receipt = checkBundle({ repoRoot: dir, outDir, version: TAG })
    expect(receipt.status).toBe('pass')
  })

  it('fails when the GitHub tag export is missing its canonical commit SHA', () => {
    const { dir, outDir } = fixture((_, evidenceDir) => {
      writeFileSync(join(evidenceDir, 'github-tag.json'), JSON.stringify({ html_url: 'https://github.test/commit/missing' }))
    })
    const receipt = checkBundle({ repoRoot: dir, outDir, version: TAG })
    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({ check: 'github_tag_commit_sha_present', ok: false }))
  })

  it('fails when the GitHub tag resolves another commit', () => {
    const { dir, outDir } = fixture((_, evidenceDir) => {
      writeFileSync(join(evidenceDir, 'github-tag.json'), JSON.stringify({ sha: 'f'.repeat(40), html_url: 'https://github.test/commit/wrong' }))
    })
    const receipt = checkBundle({ repoRoot: dir, outDir, version: TAG })
    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({ check: 'github_tag_commit_matches_candidate_commit', ok: false }))
  })

  it.each([
    ['missing', undefined],
    ['null', null],
    ['array', ['a'.repeat(40)]],
    ['object', { sha: 'a'.repeat(40) }],
    ['uppercase', 'A'.repeat(40)],
  ] as const)('fails closed when the GitHub tag SHA is %s', (_, sha) => {
    const { dir, outDir } = fixture((_, evidenceDir) => {
      writeFileSync(join(evidenceDir, 'github-tag.json'), JSON.stringify({ sha, html_url: 'https://github.test/commit/invalid' }))
    })
    const receipt = checkBundle({ repoRoot: dir, outDir, version: TAG })
    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      check: 'github_tag_commit_sha_present',
      ok: false,
      actual: sha ?? null,
    }))
  })

  it.each([
    ['missing', undefined],
    ['null', null],
    ['malformed', 'not-a-timestamp'],
    ['non-ISO', 'July 10, 2026'],
  ] as const)('fails when the GitHub prerelease publication timestamp is %s', (_, publishedAt) => {
    const { dir, outDir } = fixture((_, evidenceDir) => {
      writeFileSync(join(evidenceDir, 'github-release.json'), JSON.stringify({
        tagName: TAG,
        isPrerelease: true,
        isDraft: false,
        targetCommitish: 'main',
        publishedAt,
      }))
    })
    const receipt = checkBundle({ repoRoot: dir, outDir, version: TAG })
    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      check: 'github_prerelease_published_at_present',
      ok: false,
      actual: publishedAt ?? null,
    }))
  })
})
