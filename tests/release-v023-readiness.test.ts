import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

const releaseDoc = read('../docs/releases/v0.23.0-trusted-runtime.md')
const roadmap = read('../ROADMAP.md')
const controlRoadmap = read('../docs/control-plane-roadmap.md')
const readme = read('../README.md')
const pkg = JSON.parse(read('../package.json')) as { version: string; scripts: Record<string, string> }
const workflow = read('../.github/workflows/ci.yml')

describe('v0.23.0 Trusted Runtime release gate', () => {
  it('is the named current release target across top-level docs', () => {
    for (const doc of [releaseDoc, roadmap, controlRoadmap, readme]) {
      expect(doc).toContain('v0.23.0')
      expect(doc).toContain('Trusted Runtime')
    }

    expect(readme).toContain('./docs/releases/v0.23.0-trusted-runtime.md')
    expect(roadmap).toContain('docs/releases/v0.23.0-trusted-runtime.md')
    expect(controlRoadmap).toContain('releases/v0.23.0-trusted-runtime.md')
  })

  it('pins the ten release objectives and their evidence expectations', () => {
    for (const objective of [
      'Reproducible installation',
      'Trusted agent identity',
      'Scoped authority',
      'Complete work lifecycle',
      'External verification',
      'Independent evidence',
      'Operational reliability',
      'Automated release confidence',
      'Release integrity',
      'Production soak',
    ]) {
      expect(releaseDoc).toContain(objective)
    }

    for (const evidence of [
      '#274',
      '#150',
      '#277',
      '#279',
      '#280',
      '#284',
      'fresh-install-check.json',
      'mupot-fresh-install/v1',
      'work-lifecycle-check.json',
      'mupot-work-lifecycle/v1',
      'external-pr-cycle-check.json',
      'mupot-external-pr-cycle/v1',
      'production-soak-check.json',
      'mupot-production-soak/v1',
      'manifest.json',
      'cutover-gate.json',
      'export-receipt.json',
      'manifest-check.json',
      'staging-recovery-check.json',
      'mupot-staging-recovery-rehearsal/v1',
      'v0.23.0-rc.1',
      'seven-day production soak',
      'package.json',
      'src/version.ts',
      'CHANGELOG.md',
      'GitHub Release',
      'release-integrity-check.json',
      'mupot-release-integrity/v1',
      'release-readiness-check.json',
      'mupot-v023-release-readiness/v1',
    ]) {
      expect(releaseDoc).toContain(evidence)
    }
  })

  it('keeps out-of-scope work out of the release definition', () => {
    for (const deferred of [
      'marketplace',
      'economy',
      'new departments',
      'full SOS retirement',
      'GCP portability',
      'autonomous-brain expansion',
    ]) {
      expect(releaseDoc).toContain(deferred)
      expect(roadmap).toContain(deferred)
    }
  })

  it('does not pretend the package has shipped before release blockers pass', () => {
    expect(pkg.version).not.toBe('0.23.0')
    expect(releaseDoc).toContain('Do not bump `package.json` or tag until all release blockers pass.')
  })

  it('names the automated gates required for a release candidate', () => {
    for (const command of [
      'npm audit --audit-level=high',
      'npm run typecheck',
      'npm test',
      'node --test fleet-runtime/*.test.mjs',
      'bash scripts/ci-local-evidence.sh',
      'npm run receipt:fresh-install:plan',
      'npm run receipt:work-lifecycle:plan',
      'npm run receipt:external-pr-cycle:plan',
      'npm run receipt:staging-recovery:plan',
      'npm run receipt:production-soak:plan',
      'npm run receipt:release-integrity:plan',
      'npm run receipt:release-readiness:plan',
      'npx wrangler deploy --dry-run --config wrangler.example.toml',
    ]) {
      expect(releaseDoc).toContain(command)
    }

    expect(workflow).toContain('local-evidence:')
    expect(workflow).toContain('bash scripts/ci-local-evidence.sh')
    expect(pkg.scripts['smoke:local']).toBe('node scripts/local-browser-smoke.mjs')
    expect(pkg.scripts['conformance:runtime:local']).toBe('node scripts/local-runtime-conformance.mjs')
    expect(pkg.scripts['receipt:fresh-install:check']).toBe('node scripts/fresh-install-receipt.mjs --check')
    expect(pkg.scripts['receipt:work-lifecycle:check']).toBe('node scripts/work-lifecycle-receipt.mjs --check')
    expect(pkg.scripts['receipt:external-pr-cycle:check']).toBe('node scripts/external-pr-cycle-receipt.mjs --check')
    expect(pkg.scripts['receipt:staging-recovery:check']).toBe('node scripts/staging-recovery-rehearsal.mjs --check')
    expect(pkg.scripts['receipt:production-soak:check']).toBe('node scripts/production-soak-receipt.mjs --check')
    expect(pkg.scripts['receipt:release-integrity:check']).toBe('node scripts/release-integrity-receipt.mjs --check')
    expect(pkg.scripts['receipt:release-readiness:check']).toBe('node scripts/release-readiness-receipt.mjs --check')
  })
})
