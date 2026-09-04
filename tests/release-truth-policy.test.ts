import { describe, expect, it } from 'vitest'
// @ts-expect-error -- .mjs policy script, no type declarations by design
import { checkReleaseTruth, newestSemverTag, compareSemverTags, DECLARED_DOCS } from '../scripts/release-truth-policy.mjs'

const TAGS = ['v0.17.0', 'v0.18.0', 'v0.19.0', 'v0.23.0', 'v0.23.0-rc.1', 'v0.25.0']
const VERSION = '0.30.0'

function check(body: string, opts: { version?: string; tags?: string[] } = {}) {
  return checkReleaseTruth({
    docs: new Map([['CHANGELOG.md', body]]),
    packageVersion: opts.version ?? VERSION,
    tags: opts.tags ?? TAGS,
  }) as string[]
}

describe('release-truth policy — the declared surface', () => {
  it('names every document that carries release-truth claims', () => {
    expect(DECLARED_DOCS).toEqual([
      'CHANGELOG.md',
      'ROADMAP.md',
      'docs/releases/next-flights.md',
      'docs/releases/v0.30.0.md',
    ])
  })
})

describe('R1 — a current-`main` assertion may not carry a SHA', () => {
  it('rejects a pinned main commit, which its own merge falsifies', () => {
    const findings = check('- **Current source version:** `0.30.0` on `main` at `7d58d36be5a67a6e859f4513bc9fc65523aab1a8`.')
    expect(findings).toHaveLength(1)
    expect(findings[0]).toContain('R1 no-main-sha')
  })

  it('rejects a short SHA too — abbreviating does not make it durable', () => {
    expect(check('| Current source version | `0.30.0` | Present on `main` at `7d58d36b` |')[0]).toContain('R1')
  })

  it('accepts a pointer to the authoritative source', () => {
    expect(check('- **Current source version:** `0.30.0` on `main`; read `git rev-parse origin/main`.')).toEqual([])
  })

  it('accepts a SHA in an ancestry statement, which is a monotonic DAG invariant', () => {
    expect(check('Current `main` history: `55c1c3ef` is an ancestor of the deployed commit.')).toEqual([])
  })

  it('accepts an ancestry statement wrapped onto the next line', () => {
    expect(check('Current `main` includes #1252 (`55c1c3ef` is\nan ancestor of it) and does not backfill rows.')).toEqual([])
  })
})

describe('R2 — an asserted source version must match package.json', () => {
  it('rejects a version the package no longer reports', () => {
    const findings = check('- **Current source version:** `0.29.0` on `main`.')
    expect(findings).toHaveLength(1)
    expect(findings[0]).toContain('R2 version-agrees')
    expect(findings[0]).toContain('0.29.0')
    expect(findings[0]).toContain('0.30.0')
  })

  it('accepts the version the package actually reports', () => {
    expect(check('- **Current source version:** `0.30.0` on `main`.')).toEqual([])
  })

  it('catches drift caused by a bump elsewhere, with the document untouched', () => {
    expect(check('- **Current source version:** `0.30.0` on `main`.', { version: '0.31.0' })[0]).toContain('R2')
  })
})

describe('R3 — an asserted latest tag must match the repository', () => {
  it('rejects a stale tag claim', () => {
    const findings = check('- **Latest tagged stable release:** `v0.23.0`.')
    expect(findings).toHaveLength(1)
    expect(findings[0]).toContain('R3 tag-agrees')
    expect(findings[0]).toContain('v0.25.0')
  })

  it('accepts the newest semver tag', () => {
    expect(check('- **Latest tagged stable release:** `v0.25.0`.')).toEqual([])
  })

  it('catches drift caused by cutting a tag, with the document untouched', () => {
    expect(check('- **Latest tagged stable release:** `v0.25.0`.', { tags: [...TAGS, 'v0.30.0'] })[0]).toContain('R3')
  })
})

describe('R4 — a production SHA must be labelled as a record', () => {
  it('rejects an unlabelled production SHA, which a deploy silently falsifies', () => {
    const findings = check('- **Current production deployment:** `0.30.0` at `7d58d36be5a67a6e859f4513bc9fc65523aab1a8`.')
    expect(findings).toHaveLength(1)
    expect(findings[0]).toContain('R4 prod-sha-labelled')
  })

  it('accepts a SHA labelled as the last recorded deploy', () => {
    expect(check('- **Current production deployment:** last recorded deploy `7d58d36be5a67a6e859f4513bc9fc65523aab1a8`.')).toEqual([])
  })

  it('accepts a date-qualified record, including an intervening article', () => {
    expect(check('#1252 is in the current production deployment as of the 2026-09-02 `7d58d36b` deploy.')).toEqual([])
  })

  it('accepts a label that wraps onto the neighbouring line', () => {
    expect(check('- **Current production deployment:** `0.30.0` at\n  `7d58d36b`, last recorded deploy.')).toEqual([])
  })
})

describe('fail-closed — never report clean because it could not look', () => {
  it('refuses to pass when no semver tag is visible, rather than skipping R3', () => {
    const findings = check('- **Latest tagged stable release:** `v0.25.0`.', { tags: [] })
    expect(findings).toHaveLength(1)
    expect(findings[0]).toContain('hard failure, not a skip')
  })

  it('treats a tags list with no semver entries as unusable, not as zero drift', () => {
    expect(check('anything', { tags: ['nightly', 'latest'] })[0]).toContain('no semver tags visible')
  })

  it('refuses to pass when the package version is unavailable', () => {
    const findings = checkReleaseTruth({ docs: new Map(), packageVersion: undefined, tags: TAGS }) as string[]
    expect(findings[0]).toContain('refusing to report clean')
  })

  it('reports a clean document set as clean, so the checker is not vacuously red', () => {
    expect(check('- **Current source version:** `0.30.0` on `main`; read `git rev-parse origin/main`.')).toEqual([])
  })
})

describe('semver tag ordering', () => {
  it('orders numerically, not lexically — v0.9.0 is older than v0.25.0', () => {
    expect(newestSemverTag(['v0.9.0', 'v0.25.0'])).toBe('v0.25.0')
  })

  it('ignores prerelease tags when choosing the newest stable tag', () => {
    expect(newestSemverTag(['v0.23.0-rc.1', 'v0.23.0'])).toBe('v0.23.0')
  })

  it('returns null when nothing is a semver tag', () => {
    expect(newestSemverTag(['nightly'])).toBeNull()
  })

  it('compares patch precision', () => {
    expect(compareSemverTags('v1.2.3', 'v1.2.4')).toBeLessThan(0)
  })
})
