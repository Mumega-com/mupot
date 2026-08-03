import { execFileSync, spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { REQUIRED_PR_CHECKS } from '../scripts/release-readiness-receipt.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scanner = join(repoRoot, 'scripts', 'design-status-contract-policy.mjs')
const tempDirectories: string[] = []

function createRepo(files: Record<string, string>, tracked: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'mupot-design-status-'))
  tempDirectories.push(root)
  execFileSync('git', ['init', '--quiet'], { cwd: root })

  for (const [path, contents] of Object.entries(files)) {
    const absolutePath = join(root, path)
    mkdirSync(dirname(absolutePath), { recursive: true })
    writeFileSync(absolutePath, contents)
  }

  if (tracked.length > 0) {
    execFileSync('git', ['add', '--', ...tracked], { cwd: root })
  }
  return root
}

function createTrackedRepo(files: Record<string, string>): string {
  return createRepo(files, Object.keys(files))
}

function runScanner(root: string) {
  return spawnSync(process.execPath, [scanner, '--root', root], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
}

function designContract(id: string, extras: Record<string, unknown>): string {
  return `${JSON.stringify({ id, status: 'design', ...extras }, null, 2)}\n`
}

afterEach(() => {
  for (const root of tempDirectories.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('design-status contract policy', () => {
  it('accepts the three current design-branch patterns when explicitly marked', () => {
    // Pattern A (location): brain-learning-ranker under docs/design-contracts/
    // Pattern B (marker): owner-experience and tier2-user-chat in docs/ with designOnly
    const root = createTrackedRepo({
      'docs/design-contracts/brain-learning-ranker-v1.json': designContract(
        'brain-learning-ranker/v1',
        { spec: 'docs/superpowers/specs/2026-07-27-brain-learning-ranker-design.md' },
      ),
      'docs/owner-experience-v1.json': designContract('owner-experience/v1', {
        designOnly: true,
        spec: 'docs/superpowers/specs/2026-07-27-owner-experience-unified-surface-design.md',
      }),
      'docs/tier2-user-chat-v1.json': designContract('tier2-user-chat/v1', {
        designOnly: true,
        spec: 'docs/superpowers/specs/2026-07-27-tier2-stateless-user-chat-design.md',
      }),
      'docs/runtime-adapter-v1.json': `${JSON.stringify(
        { id: 'runtime-adapter/v1', status: 'documented' },
        null,
        2,
      )}\n`,
    })

    const result = runScanner(root)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('design-status contract policy: ok')
    expect(result.stderr).toBe('')
  })

  it('rejects unmarked design status for each of the three branch contract ids', () => {
    const root = createTrackedRepo({
      'docs/brain-learning-ranker-v1.json': designContract('brain-learning-ranker/v1', {}),
      'docs/owner-experience-v1.json': designContract('owner-experience/v1', {}),
      'docs/tier2-user-chat-v1.json': designContract('tier2-user-chat/v1', {}),
    })

    const result = runScanner(root)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("contract 'brain-learning-ranker/v1' has status 'design'")
    expect(result.stderr).toContain("contract 'owner-experience/v1' has status 'design'")
    expect(result.stderr).toContain("contract 'tier2-user-chat/v1' has status 'design'")
    expect(result.stderr).toContain('docs/design-contracts/** or top-level "designOnly": true')
    expect(result.stderr).toContain('Remediation:')
    expect(result.stderr).toContain('design-status policy violations: 3')
  })

  it('rejects design status in runtime and release registries even with the marker', () => {
    const root = createTrackedRepo({
      'src/contracts/brain-learning-ranker-v1.json': designContract('brain-learning-ranker/v1', {
        designOnly: true,
      }),
      'fleet-runtime/owner-experience-v1.json': designContract('owner-experience/v1', {
        designOnly: true,
      }),
      'docs/releases/tier2-user-chat-v1.json': designContract('tier2-user-chat/v1', {
        designOnly: true,
      }),
    })

    const result = runScanner(root)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('runtime/release registry path')
    expect(result.stderr).toContain('src/contracts/brain-learning-ranker-v1.json')
    expect(result.stderr).toContain('fleet-runtime/owner-experience-v1.json')
    expect(result.stderr).toContain('docs/releases/tier2-user-chat-v1.json')
    expect(result.stderr).toContain('design-status policy violations: 3')
  })

  it('rejects nested runtime paths and nested pots.manifest.json even with the marker', () => {
    const root = createTrackedRepo({
      'apps/web/src/contracts/brain-learning-ranker-v1.json': designContract('brain-learning-ranker/v1', {
        designOnly: true,
      }),
      'services/edge/deploy/owner-experience-v1.json': designContract('owner-experience/v1', {
        designOnly: true,
      }),
      'apps/foo/pots.manifest.json': designContract('tier2-user-chat/v1', {
        designOnly: true,
      }),
    })

    const result = runScanner(root)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('runtime/release registry path')
    expect(result.stderr).toContain('apps/web/src/contracts/brain-learning-ranker-v1.json')
    expect(result.stderr).toContain('services/edge/deploy/owner-experience-v1.json')
    expect(result.stderr).toContain('apps/foo/pots.manifest.json')
    expect(result.stderr).toContain('design-status policy violations: 3')
  })

  it('accepts nested non-runtime design contracts when explicitly marked', () => {
    const root = createTrackedRepo({
      'docs/specs/nested/owner-experience-v1.json': designContract('owner-experience/v1', {
        designOnly: true,
      }),
      'packages/docs/tier2-user-chat-v1.json': designContract('tier2-user-chat/v1', {
        designOnly: true,
      }),
    })

    const result = runScanner(root)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('design-status contract policy: ok')
    expect(result.stderr).toBe('')
  })

  it('inspects array and map registries — rejects unmarked design entries', () => {
    const root = createTrackedRepo({
      'docs/registry-array.json': `${JSON.stringify(
        [
          { id: 'brain-learning-ranker/v1', status: 'design' },
          { id: 'runtime-adapter/v1', status: 'documented' },
        ],
        null,
        2,
      )}\n`,
      'docs/registry-map.json': `${JSON.stringify(
        {
          contracts: {
            owner: { id: 'owner-experience/v1', status: 'design' },
            chat: { id: 'tier2-user-chat/v1', status: 'documented' },
          },
        },
        null,
        2,
      )}\n`,
    })

    const result = runScanner(root)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("contract 'brain-learning-ranker/v1' has status 'design'")
    expect(result.stderr).toContain("contract 'owner-experience/v1' has status 'design'")
    expect(result.stderr).toContain('design-status policy violations: 2')
  })

  it('inspects id-keyed top-level maps and arbitrary single-wrapper keys', () => {
    const root = createTrackedRepo({
      'src/contracts/id-keyed-map.json': `${JSON.stringify(
        {
          'brain-learning-ranker/v1': {
            id: 'brain-learning-ranker/v1',
            status: 'design',
            designOnly: true,
          },
        },
        null,
        2,
      )}\n`,
      'src/contracts/named-map.json': `${JSON.stringify(
        {
          brain: { id: 'owner-experience/v1', status: 'design', designOnly: true },
        },
        null,
        2,
      )}\n`,
      'docs/registry-items-wrapper.json': `${JSON.stringify(
        {
          items: [{ id: 'tier2-user-chat/v1', status: 'design' }],
        },
        null,
        2,
      )}\n`,
      'pots.manifest.json': `${JSON.stringify(
        {
          'runtime-adapter/v1': { id: 'runtime-adapter/v1', status: 'design' },
        },
        null,
        2,
      )}\n`,
    })

    const result = runScanner(root)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('src/contracts/id-keyed-map.json')
    expect(result.stderr).toContain("contract 'brain-learning-ranker/v1' has status 'design'")
    expect(result.stderr).toContain('src/contracts/named-map.json')
    expect(result.stderr).toContain("contract 'owner-experience/v1' has status 'design'")
    expect(result.stderr).toContain('docs/registry-items-wrapper.json')
    expect(result.stderr).toContain("contract 'tier2-user-chat/v1' has status 'design'")
    expect(result.stderr).toContain('pots.manifest.json')
    expect(result.stderr).toContain("contract 'runtime-adapter/v1' has status 'design'")
    expect(result.stderr).toContain('design-status policy violations: 4')
  })

  it('inspects array and map registries — accepts designOnly or non-design entries', () => {
    const root = createTrackedRepo({
      'docs/registry-array.json': `${JSON.stringify(
        [
          { id: 'brain-learning-ranker/v1', status: 'design', designOnly: true },
          { id: 'runtime-adapter/v1', status: 'documented' },
        ],
        null,
        2,
      )}\n`,
      'docs/registry-map.json': `${JSON.stringify(
        {
          contracts: {
            owner: { id: 'owner-experience/v1', status: 'design', designOnly: true },
            chat: { id: 'tier2-user-chat/v1', status: 'documented' },
          },
        },
        null,
        2,
      )}\n`,
      'docs/design-contracts/registry-array.json': `${JSON.stringify(
        [{ id: 'tier2-user-chat/v1', status: 'design' }],
        null,
        2,
      )}\n`,
      'docs/id-keyed-ok.json': `${JSON.stringify(
        {
          'owner-experience/v1': {
            id: 'owner-experience/v1',
            status: 'design',
            designOnly: true,
          },
        },
        null,
        2,
      )}\n`,
    })

    const result = runScanner(root)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('design-status contract policy: ok')
    expect(result.stderr).toBe('')
  })

  it('warns on unrecognized contract ids on runtime paths; silent elsewhere; never hard-fails', () => {
    const root = createTrackedRepo({
      'src/contracts/bad-id.json': `${JSON.stringify(
        { id: 'Owner_Experience/v1.0', status: 'design', designOnly: true },
        null,
        2,
      )}\n`,
      'pots.manifest.json': `${JSON.stringify(
        [{ id: 'not_a_contract', status: 'documented' }],
        null,
        2,
      )}\n`,
      'tests/fixtures/ordinary-id-status.json': `${JSON.stringify(
        { id: 'fixture-row-1', status: 'pending' },
        null,
        2,
      )}\n`,
      'docs/notes-bad-id.json': `${JSON.stringify(
        { id: 'Owner_Experience/v1.0', status: 'design', designOnly: true },
        null,
        2,
      )}\n`,
    })

    const result = runScanner(root)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('design-status contract policy: ok')
    expect(result.stderr).toContain('warning:')
    expect(result.stderr).toContain('unrecognized contract-like object with id')
    expect(result.stderr).toContain('Owner_Experience/v1.0')
    expect(result.stderr).toContain('not_a_contract')
    expect(result.stderr).toContain('src/contracts/bad-id.json')
    expect(result.stderr).toContain('pots.manifest.json')
    expect(result.stderr).not.toContain('tests/fixtures/ordinary-id-status.json')
    expect(result.stderr).not.toContain('docs/notes-bad-id.json')
    expect(result.stderr).not.toContain('design-status policy violations:')
  })

  it('hard-fails unparseable JSON on runtime paths; warns elsewhere', () => {
    const root = createTrackedRepo({
      'src/contracts/broken.json': '{ id: "runtime-adapter/v1", status: "documented", }\n',
      'docs/broken.json': '{ id: "runtime-adapter/v1", status: "documented", }\n',
    })

    const result = runScanner(root)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('src/contracts/broken.json')
    expect(result.stderr).toContain('unparseable JSON')
    expect(result.stderr).toContain('design-status policy violations: 1')
    expect(result.stderr).toContain('warning:')
    expect(result.stderr).toContain('docs/broken.json')
  })

  it('skips known-JSONC and .design-status-ignore matches with notes', () => {
    const root = createTrackedRepo({
      'tsconfig.json': '{ "compilerOptions": { "strict": true, } }\n',
      'tsconfig.build.json': '{ "extends": "./tsconfig.json", }\n',
      '.vscode/settings.json': '{ "editor.formatOnSave": true, }\n',
      '.devcontainer/devcontainer.json': '{ "name": "mupot", }\n',
      'tests/fixtures/ignored-broken.json': '{ not json\n',
      'docs/visible-broken.json': '{ also not json\n',
      '.design-status-ignore': '# ignore fixture parse noise\ntests/fixtures/ignored-broken.json\n',
    })

    const result = runScanner(root)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('design-status contract policy: ok')
    expect(result.stderr).toContain('note:')
    expect(result.stderr).toContain('skipped known-JSONC')
    expect(result.stderr).toContain('tsconfig.json')
    expect(result.stderr).toContain('tsconfig.build.json')
    expect(result.stderr).toContain('.vscode/settings.json')
    expect(result.stderr).toContain('.devcontainer/devcontainer.json')
    expect(result.stderr).toContain('skipped by .design-status-ignore')
    expect(result.stderr).toContain('tests/fixtures/ignored-broken.json')
    expect(result.stderr).toContain('warning:')
    expect(result.stderr).toContain('docs/visible-broken.json')
    expect(result.stderr).not.toContain('design-status policy violations:')
  })

  it('hard-fails recognized contracts when normalize(status) starts with design', () => {
    const root = createTrackedRepo({
      'src/contracts/design-cased.json': `${JSON.stringify(
        { id: 'brain-learning-ranker/v1', status: 'DESIGN', designOnly: true },
        null,
        2,
      )}\n`,
      'src/contracts/design-space.json': `${JSON.stringify(
        { id: 'owner-experience/v1', status: ' design-space ', designOnly: true },
        null,
        2,
      )}\n`,
      'src/contracts/design-only-status.json': `${JSON.stringify(
        { id: 'tier2-user-chat/v1', status: 'design-only', designOnly: true },
        null,
        2,
      )}\n`,
      'src/contracts/documented-ok.json': `${JSON.stringify(
        { id: 'runtime-adapter/v1', status: 'documented' },
        null,
        2,
      )}\n`,
    })

    const result = runScanner(root)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('src/contracts/design-cased.json')
    expect(result.stderr).toContain('src/contracts/design-space.json')
    expect(result.stderr).toContain('src/contracts/design-only-status.json')
    expect(result.stderr).toContain("status 'DESIGN'")
    expect(result.stderr).toContain("status ' design-space '")
    expect(result.stderr).toContain("status 'design-only'")
    expect(result.stderr).not.toContain('src/contracts/documented-ok.json')
    expect(result.stderr).toContain('design-status policy violations: 3')
  })

  it('treats status design-only as design status, not as a designOnly marker', () => {
    // Ambiguity: "design-only" looks like the marker vocabulary, but as a
    // status string it is design-status via prefix normalization. A string
    // designOnly marker value must not authorize or invent design status.
    const root = createTrackedRepo({
      'docs/design-only-status-unmarked.json': `${JSON.stringify(
        { id: 'brain-learning-ranker/v1', status: 'design-only' },
        null,
        2,
      )}\n`,
      'docs/string-marker-not-authorization.json': `${JSON.stringify(
        { id: 'owner-experience/v1', status: 'design', designOnly: 'design-only' },
        null,
        2,
      )}\n`,
      'docs/string-marker-documented-ok.json': `${JSON.stringify(
        { id: 'tier2-user-chat/v1', status: 'documented', designOnly: 'design-only' },
        null,
        2,
      )}\n`,
      'docs/boolean-marker-ok.json': `${JSON.stringify(
        { id: 'runtime-adapter/v1', status: 'design-only', designOnly: true },
        null,
        2,
      )}\n`,
    })

    const result = runScanner(root)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('docs/design-only-status-unmarked.json')
    expect(result.stderr).toContain("status 'design-only'")
    expect(result.stderr).toContain('docs/string-marker-not-authorization.json')
    expect(result.stderr).toContain('not explicitly design-only')
    expect(result.stderr).not.toContain('docs/string-marker-documented-ok.json')
    expect(result.stderr).not.toContain('docs/boolean-marker-ok.json')
    expect(result.stderr).toContain('design-status policy violations: 2')
  })

  it('reports symlinked and non-UTF-8 tracked JSON instead of dropping them', () => {
    const root = createTrackedRepo({
      'docs/safe-v1.json': `${JSON.stringify({ id: 'runtime-adapter/v1', status: 'documented' }, null, 2)}\n`,
      'docs/target-contract.json': designContract('brain-learning-ranker/v1', { designOnly: true }),
    })

    const symlinkPath = join(root, 'docs/link-contract.json')
    symlinkSync('target-contract.json', symlinkPath)
    execFileSync('git', ['add', '--', 'docs/link-contract.json'], { cwd: root })

    const nonUtf8Path = join(root, 'docs/binary.json')
    writeFileSync(nonUtf8Path, Buffer.from([0x7b, 0xff, 0x7d, 0x0a]))
    execFileSync('git', ['add', '--', 'docs/binary.json'], { cwd: root })

    const result = runScanner(root)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('unreadable tracked JSON')
    expect(result.stderr).toContain('docs/link-contract.json')
    expect(result.stderr).toContain('symbolic link')
    expect(result.stderr).toContain('docs/binary.json')
    expect(result.stderr).toContain('non-UTF-8')
    expect(result.stderr).toContain('design-status policy violations: 2')
  })

  it('ignores nested status fields and non-contract JSON', () => {
    const root = createTrackedRepo({
      'docs/owner-experience-v1.json': `${JSON.stringify(
        {
          id: 'owner-experience/v1',
          status: 'documented',
          unmetDependencies: [{ id: 'per-project-docs-ui', status: 'design-only' }],
        },
        null,
        2,
      )}\n`,
      'package.json': `${JSON.stringify({ name: 'fixture', version: '0.0.0' }, null, 2)}\n`,
      'docs/notes.json': `${JSON.stringify({ status: 'design', note: 'not a contract' }, null, 2)}\n`,
    })

    const result = runScanner(root)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('design-status contract policy: ok')
    expect(result.stderr).toBe('')
  })

  it('ignores untracked design contracts', () => {
    const root = createRepo(
      {
        'docs/safe-v1.json': `${JSON.stringify({ id: 'runtime-adapter/v1', status: 'documented' }, null, 2)}\n`,
        'docs/leaky-v1.json': designContract('brain-learning-ranker/v1', {}),
      },
      ['docs/safe-v1.json'],
    )

    const result = runScanner(root)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('design-status contract policy: ok')
    expect(result.stderr).toBe('')
  })

  it('skips staged deletions without aborting the run', () => {
    const root = createTrackedRepo({
      'docs/safe-v1.json': `${JSON.stringify({ id: 'runtime-adapter/v1', status: 'documented' }, null, 2)}\n`,
      'docs/gone-v1.json': designContract('brain-learning-ranker/v1', {}),
    })
    unlinkSync(join(root, 'docs/gone-v1.json'))

    const result = runScanner(root)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('design-status contract policy: ok')
    expect(result.stderr).toBe('')
  })

  it('smoke-scans the real repository root cleanly', () => {
    const result = runScanner(repoRoot)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('design-status contract policy: ok')
    expect(result.stderr).toBe('')
  })

  it('registers design-status-policy in CI and required status checks', () => {
    const workflow = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8')
    expect(workflow).toMatch(/^\s*design-status-policy:\s*$/m)
    expect(workflow).toContain('node scripts/design-status-contract-policy.mjs')
    expect(REQUIRED_PR_CHECKS).toContain('design-status-policy')
  })
})
