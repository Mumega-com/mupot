// tests/build-pot-worker-bundle-args.test.ts — scripts/build-pot-worker-bundle.mjs's own
// argv allowlist (--outdir <dir>, --config/-c <file>). Spawns the REAL script as a child
// process — the refusal cases below all exit before `wrangler deploy --dry-run` is ever
// invoked, so they are cheap; the one acceptance case actually runs a real dry-run build
// (no network call, no auth beyond parsing wrangler.example.toml — confirmed runnable in
// this sandbox, 2026-09-22).
//
// mupot#1524 round-2 P2-2 (successor PR): a value that itself starts with `-`
// (`--outdir --x`, `--config --dry-run=false`, `--config=--x`) must be REFUSED, never
// accepted as a literal argument — this script's whole reason to exist is refusing to
// forward arbitrary argv to `wrangler deploy --dry-run` (see the script's own header); an
// allowlist that can be defeated by a flag disguised as another flag's value is not an
// allowlist.

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

function runScript(args: string[]) {
  return spawnSync(process.execPath, ['scripts/build-pot-worker-bundle.mjs', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
}

describe('scripts/build-pot-worker-bundle.mjs argv allowlist', () => {
  it('refuses --outdir --x (a flag value that itself looks like a flag)', () => {
    const result = runScript(['--outdir', '--x'])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/--outdir requires a value/)
  })

  it('refuses --outdir with no following value at all', () => {
    const result = runScript(['--outdir'])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/--outdir requires a value/)
  })

  it('refuses --config --dry-run=false (a flag value that itself looks like a flag)', () => {
    const result = runScript(['--config', '--dry-run=false'])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/unrecognized argument '--config'/)
  })

  it('refuses --config=--x (single-token form, dash-prefixed value)', () => {
    const result = runScript(['--config=--x'])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/unrecognized argument '--config=--x'/)
  })

  it('refuses -c --help', () => {
    const result = runScript(['-c', '--help'])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/unrecognized argument '-c'/)
  })

  it('refuses an arbitrary unrecognized argument (never silently forwarded)', () => {
    const result = runScript(['--dry-run=false'])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/unrecognized argument '--dry-run=false'/)
  })

  // Positive control — proves the refusals above are refusing something real, not just
  // exercising a codepath that would refuse everything: with a legitimate --outdir and
  // --config, the script still runs a real (network-free) wrangler dry-run build.
  it('accepts a legitimate --outdir <dir> --config <file> and produces a .js bundle', () => {
    const outdir = mkdtempSync(join(tmpdir(), 'mupot-build-pot-worker-bundle-test-'))
    try {
      const result = runScript(['--outdir', outdir, '--config', 'wrangler.example.toml'])
      expect(result.status).toBe(0)
      const printedPath = result.stdout.trim().split('\n').pop()!
      expect(printedPath).toContain(outdir)
      const jsFiles = readdirSync(outdir).filter((f) => f.endsWith('.js'))
      expect(jsFiles.length).toBeGreaterThan(0)
    } finally {
      rmSync(outdir, { recursive: true, force: true })
    }
  }, 60_000)
})
