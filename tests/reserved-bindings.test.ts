import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scanner = join(repoRoot, 'scripts', 'reserved-bindings.mjs')
const tempRepos: string[] = []

function createRepo(files: Record<string, string>, tracked = Object.keys(files)): string {
  const root = mkdtempSync(join(tmpdir(), 'mupot-reserved-bindings-'))
  tempRepos.push(root)
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  for (const [path, contents] of Object.entries(files)) {
    writeFileSync(join(root, path), contents)
  }
  if (tracked.length > 0) {
    execFileSync('git', ['add', '--', ...tracked], { cwd: root })
  }
  return root
}

function runScanner(root: string) {
  return spawnSync(process.execPath, [scanner, '--root', root], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
}

afterEach(() => {
  while (tempRepos.length > 0) {
    rmSync(tempRepos.pop()!, { recursive: true, force: true })
  }
})

describe('reserved-bindings guard', () => {
  it('fails on the exact config shape that broke production twice (#699, P0-0)', () => {
    const root = createRepo({
      'wrangler.toml': '[vars]\nTENANT_SLUG = "acme"\nOAUTH_PROVIDER = "google"\n',
    })
    const result = runScanner(root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('wrangler.toml')
    expect(result.stderr).toContain('OAUTH_PROVIDER')
    // The message must name the replacement, not just the offence — a guard that says
    // "this is wrong" without saying "use this instead" gets worked around, not obeyed.
    expect(result.stderr).toContain('IDP_PROVIDER')
  })

  it('passes on the corrected name', () => {
    const root = createRepo({
      'wrangler.toml': '[vars]\nTENANT_SLUG = "acme"\nIDP_PROVIDER = "google"\n',
    })
    const result = runScanner(root)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('no reserved binding names declared')
  })

  it('catches the template, not just the root config — the template is the vector', () => {
    // Every pot is forked from wrangler.example.toml. It never received the #699 rename,
    // so digid/house/viamar/alpha/acctest each inherited a broken OAuth door at creation.
    // One poisoned template is N poisoned pots; this case is the whole point of the guard.
    const root = createRepo({
      'wrangler.example.toml': '[vars]\nOAUTH_PROVIDER = "google"   # google | telegram\n',
    })
    const result = runScanner(root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('wrangler.example.toml')
  })

  it('reports every offending config, not just the first', () => {
    const root = createRepo({
      'wrangler.toml': '[vars]\nOAUTH_PROVIDER = "google"\n',
      'wrangler.example.toml': '[vars]\nOAUTH_PROVIDER = "google"\n',
    })
    const result = runScanner(root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('wrangler.toml')
    expect(result.stderr).toContain('wrangler.example.toml')
    expect(result.stderr).toContain('2 config(s)')
  })

  it('does not fire on a commented mention of the reserved name', () => {
    // Both the real configs and this guard's own source explain WHY the name is reserved.
    // A scanner that cannot tolerate its own documentation forces the documentation out,
    // which is how the knowledge got lost the first time.
    const root = createRepo({
      'wrangler.toml':
        '[vars]\n# OAUTH_PROVIDER is reserved by the OAuth library — use IDP_PROVIDER\nIDP_PROVIDER = "google"\n',
    })
    const result = runScanner(root)
    expect(result.status).toBe(0)
  })

  it('ignores non-wrangler toml files', () => {
    const root = createRepo({
      'other.toml': '[vars]\nOAUTH_PROVIDER = "google"\n',
    })
    const result = runScanner(root)
    expect(result.status).toBe(0)
  })

  it('ignores an untracked config — CI can only speak for what is in the repo', () => {
    // The gitignored per-pot configs are exactly where the live defect sat. This guard
    // deliberately does NOT claim to cover them: asserting a clean scan over files git
    // cannot see would be a false green. Deploy-time preflight owns that half.
    const root = createRepo(
      {
        'wrangler.toml': '[vars]\nIDP_PROVIDER = "google"\n',
        'wrangler.digid.toml': '[vars]\nOAUTH_PROVIDER = "google"\n',
      },
      ['wrangler.toml'],
    )
    const result = runScanner(root)
    expect(result.status).toBe(0)
  })

  it('this repo is clean', () => {
    const result = runScanner(repoRoot)
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })
})
