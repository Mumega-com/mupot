import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scanner = join(repoRoot, 'scripts', 'no-secrets.mjs')
const tempRepos: string[] = []

function createRepo(files: Record<string, string | Buffer>, tracked = Object.keys(files)): string {
  const root = mkdtempSync(join(tmpdir(), 'mupot-no-secrets-'))
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
  for (const root of tempRepos.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('no-secrets scanner', () => {
  it('detects token shapes in every tracked textual file type', () => {
    const token = `sk-${'A'.repeat(19)}-`
    const extensions = ['ts', 'js', 'mjs', 'sh', 'yml', 'yaml', 'md', 'json', 'sql', 'py', 'toml']
    const files = Object.fromEntries(extensions.map((extension) => [`secret.${extension}`, token]))
    const root = createRepo(files)

    const result = runScanner(root)

    expect(result.status).toBe(1)
    for (const extension of extensions) {
      expect(result.stderr).toContain(`secret.${extension}:1: OpenAI API key`)
    }
    expect(result.stderr).not.toContain(token)
  })

  it('detects GitHub tokens and private-key envelopes', () => {
    const githubToken = `ghp_${'B'.repeat(24)}`
    const privateKey = ['-----BEGIN RSA', 'PRIVATE KEY-----'].join(' ')
    const root = createRepo({
      'token.txt': githubToken,
      'key.txt': privateKey,
    })

    const result = runScanner(root)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('token.txt:1: GitHub personal access token')
    expect(result.stderr).toContain('key.txt:1: private key')
    expect(result.stderr).not.toContain(githubToken)
    expect(result.stderr).not.toContain(privateKey)
  })

  it('detects generic PKCS#8 private-key material', () => {
    const privateKey = [
      '-----BEGIN PRIVATE KEY-----',
      'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=',
      '-----END PRIVATE KEY-----',
    ].join('\n')
    const root = createRepo({ 'key.pem': privateKey })

    const result = runScanner(root)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('key.pem:1: private key')
    expect(result.stderr).not.toContain(privateKey)
  })

  it('detects modern GitHub and JWT shapes', () => {
    const githubFineGrained = ['github', 'pat', 'A'.repeat(24)].join('_')
    const githubOauth = ['gho', 'B'.repeat(24)].join('_')
    const jwt = [
      `eyJ${'D'.repeat(14)}`,
      'E'.repeat(16),
      'F'.repeat(16),
    ].join('.')
    const root = createRepo({
      'github-pat.txt': githubFineGrained,
      'github-oauth.txt': githubOauth,
      'session.txt': jwt,
    })

    const result = runScanner(root)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('github-pat.txt:1: GitHub token')
    expect(result.stderr).toContain('github-oauth.txt:1: GitHub token')
    expect(result.stderr).toContain('session.txt:1: JWT')
    for (const value of [githubFineGrained, githubOauth, jwt]) {
      expect(result.stderr).not.toContain(value)
    }
  })

  it('ignores untracked files and safely skips tracked binaries', () => {
    const token = `sk-${'C'.repeat(24)}`
    const binary = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(token)])
    const root = createRepo(
      {
        'safe.txt': 'no credentials here\n',
        'tracked.bin': binary,
        'untracked.md': token,
      },
      ['safe.txt', 'tracked.bin'],
    )

    const result = runScanner(root)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('no secrets found')
    expect(result.stderr).toBe('')
  })

  it('allows documented short placeholders', () => {
    const root = createRepo({
      'example.md': 'Use `sk-demo` or `ghp_example` in documentation.\n',
      'example.yml': 'OPENAI_API_KEY: sk-your-key\nGITHUB_TOKEN: ghp_your_token\n',
    })

    const result = runScanner(root)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('no secrets found')
    expect(result.stderr).toBe('')
  })
})
