import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CHECK_RECEIPT_TYPE,
  checkBundle,
  formatPlan,
  normalizeVersion,
  parseArgs,
} from '../scripts/release-integrity-receipt.mjs'

const VERSION = '0.23.0'
const TAG = `v${VERSION}`

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'mupot-release-integrity-'))
}

function git(repo: string, args: string[]) {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
}

function writeRepo(mutate?: (repo: string, outDir: string) => void) {
  const repo = tempDir()
  const outDir = join(repo, 'tmp', 'release-integrity', TAG)
  mkdirSync(join(repo, 'src', 'mcp'), { recursive: true })
  mkdirSync(join(repo, 'docs', 'releases'), { recursive: true })
  mkdirSync(outDir, { recursive: true })

  writeFileSync(join(repo, 'package.json'), JSON.stringify({
    name: 'mupot',
    version: VERSION,
  }, null, 2))
  writeFileSync(join(repo, 'package-lock.json'), JSON.stringify({
    name: 'mupot',
    version: VERSION,
    lockfileVersion: 3,
    packages: {
      '': {
        name: 'mupot',
        version: VERSION,
      },
    },
  }, null, 2))
  writeFileSync(join(repo, 'src', 'version.ts'), `export const MUPOT_PUBLIC_API_VERSION = '${VERSION}' as const\n`)
  writeFileSync(join(repo, 'src', 'mcp', 'index.ts'), [
    "import { MUPOT_PUBLIC_API_VERSION } from '../version'",
    'export const serverInfo = { version: MUPOT_PUBLIC_API_VERSION }',
    '',
  ].join('\n'))
  writeFileSync(join(repo, 'CHANGELOG.md'), `# Changelog\n\n## [${VERSION}] - 2026-07-09\n\n- Trusted Runtime.\n`)
  writeFileSync(join(repo, 'ROADMAP.md'), `# Roadmap\n\n## ${TAG} - Trusted Runtime\n\nRelease metadata aligned.\n`)
  writeFileSync(join(repo, 'docs', 'releases', 'v0.23.0-trusted-runtime.md'), `# Mupot ${TAG} - Trusted Runtime\n\nRelease integrity must pass.\n`)
  writeFileSync(join(outDir, 'github-milestone.json'), JSON.stringify({
    title: `${TAG} - Trusted Runtime`,
    state: 'closed',
    open_issues: 0,
  }, null, 2))
  writeFileSync(join(outDir, 'github-release.json'), JSON.stringify({
    tagName: TAG,
    name: `${TAG} - Trusted Runtime`,
    isDraft: false,
    isPrerelease: false,
    targetCommitish: 'pending',
    publishedAt: '2026-07-13T00:00:00Z',
  }, null, 2))

  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' })
  git(repo, ['add', '.'])
  git(repo, ['-c', 'user.email=test@example.com', '-c', 'user.name=Mupot Test', 'commit', '-m', 'release fixture'])
  git(repo, ['tag', TAG])
  const tagSha = execFileSync('git', ['-C', repo, 'rev-list', '-n', '1', TAG], { encoding: 'utf8' }).trim()
  writeFileSync(join(outDir, 'github-tag.json'), JSON.stringify({
    sha: tagSha,
    html_url: `https://github.test/commit/${tagSha}`,
  }, null, 2))
  writeFileSync(join(outDir, 'github-release.json'), JSON.stringify({
    tagName: TAG,
    name: `${TAG} - Trusted Runtime`,
    isDraft: false,
    isPrerelease: false,
    targetCommitish: tagSha,
    publishedAt: '2026-07-13T00:00:00Z',
  }, null, 2))

  mutate?.(repo, outDir)

  return { repo, outDir }
}

describe('release integrity receipt checker', () => {
  it('parses plan and check arguments', () => {
    expect(parseArgs(['--plan', '--version', TAG]).plan).toBe(true)
    expect(parseArgs(['--check', '--out-dir', './tmp/release-integrity']).check).toBe(true)
    expect(normalizeVersion(VERSION)).toEqual({ semver: VERSION, tag: TAG })
  })

  it('prints the final release evidence plan', () => {
    const plan = formatPlan({
      version: TAG,
      repo: 'Mumega-com/mupot',
      outDir: `tmp/release-integrity/${TAG}`,
    })

    expect(plan).toContain('Mupot v0.23 release-integrity evidence plan')
    expect(plan).toContain('gh api repos/Mumega-com/mupot/milestones')
    expect(plan).toContain('gh release view v0.23.0')
    expect(plan).toContain('repos/Mumega-com/mupot/commits/v0.23.0')
    expect(plan).toContain('github-tag.json')
    expect(plan).toContain('release-integrity-check.json')
    expect(plan).not.toContain('production soak')
  })

  it('passes when local metadata, git tag, milestone, and release agree', () => {
    const { repo, outDir } = writeRepo()

    const receipt = checkBundle({
      repoRoot: repo,
      outDir,
      version: TAG,
      repo: 'Mumega-com/mupot',
    })

    expect(receipt.receipt_type).toBe(CHECK_RECEIPT_TYPE)
    expect(receipt.status).toBe('pass')
    expect(receipt.target.package_version).toBe(VERSION)
    expect(receipt.target.public_api_version).toBe(VERSION)
    expect(receipt.target.release_tag).toBe(TAG)
    expect(receipt.target.github_tag_sha).toBe(receipt.target.git_tag_sha)
  })

  it('fails when package and public API versions are not aligned', () => {
    const { repo, outDir } = writeRepo((repoRoot) => {
      writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({
        name: 'mupot',
        version: '0.22.0',
      }, null, 2))
      writeFileSync(join(repoRoot, 'src', 'version.ts'), "export const MUPOT_PUBLIC_API_VERSION = '0.21.1' as const\n")
    })

    const receipt = checkBundle({ repoRoot: repo, outDir, version: TAG })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'package_version_matches_expected',
    }))
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'public_api_version_matches_expected',
    }))
  })

  it('fails when the lockfile root versions do not match the stable package', () => {
    const { repo, outDir } = writeRepo((repoRoot) => {
      writeFileSync(join(repoRoot, 'package-lock.json'), JSON.stringify({
        name: 'mupot',
        version: '0.23.0-rc.1',
        lockfileVersion: 3,
        packages: {
          '': {
            name: 'mupot',
            version: '0.23.0-rc.1',
          },
        },
      }, null, 2))
    })

    const receipt = checkBundle({ repoRoot: repo, outDir, version: TAG })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'package_lock_version_matches_expected',
    }))
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'package_lock_root_version_matches_expected',
    }))
  })

  it('fails when the GitHub milestone still has open issues', () => {
    const { repo, outDir } = writeRepo((_, evidenceDir) => {
      writeFileSync(join(evidenceDir, 'github-milestone.json'), JSON.stringify({
        title: `${TAG} - Trusted Runtime`,
        state: 'open',
        open_issues: 1,
      }, null, 2))
    })

    const receipt = checkBundle({ repoRoot: repo, outDir, version: TAG })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'github_milestone_closed',
    }))
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'github_milestone_has_no_open_issues',
    }))
  })

  it('fails when the stable GitHub release evidence is missing', () => {
    const { repo, outDir } = writeRepo((_, evidenceDir) => {
      writeFileSync(join(evidenceDir, 'github-release.json'), JSON.stringify({
        tagName: 'v0.22.0',
        name: 'v0.22.0',
        isDraft: false,
        isPrerelease: false,
      }, null, 2))
    })

    const receipt = checkBundle({ repoRoot: repo, outDir, version: TAG })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'github_release_tag_matches_expected',
    }))
  })

  it('fails when the stable release is unpublished or targets another commit', () => {
    const { repo, outDir } = writeRepo()
    writeFileSync(join(outDir, 'github-release.json'), JSON.stringify({
      tagName: TAG,
      name: `${TAG} - Trusted Runtime`,
      isDraft: false,
      isPrerelease: false,
      targetCommitish: 'f'.repeat(40),
      publishedAt: null,
    }, null, 2))

    const receipt = checkBundle({ repoRoot: repo, outDir, version: TAG })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'github_release_published_at_present',
    }))
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'github_release_target_matches_tag_commit',
    }))
  })

  it('fails when the GitHub-resolved tag commit differs from the local tag', () => {
    const { repo, outDir } = writeRepo()
    writeFileSync(join(outDir, 'github-tag.json'), JSON.stringify({
      sha: 'a'.repeat(40),
    }, null, 2))

    const receipt = checkBundle({ repoRoot: repo, outDir, version: TAG })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'github_tag_commit_matches_local_tag',
    }))
  })
})
