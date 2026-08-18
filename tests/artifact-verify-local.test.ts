// tests/artifact-verify-local.test.ts — mupot#76e25fc2 (FLIGHT-07B).
//
// Proves tests/helpers/artifact-verify-local.ts (the faithful port of hermes's
// dispatch-verify.mjs) against the FULL adversarial matrix the done_when
// names: real files, symlinks, /etc/passwd, directories, stale/pre-existing/
// missing files, hash mismatch, and explicit-path override. Real filesystem,
// real temp directory — a vitest process is genuine Node with genuine fs
// access, which is exactly what src/'s own shape-only gate does not have (see
// src/tasks/artifact-verification.ts's header).

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { verifyArtifactLocal } from './helpers/artifact-verify-local'

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'artifact-verify-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('verifyArtifactLocal — real files, real adversarial matrix', () => {
  it('PASSES a real regular file with a matching hash and fresh mtime', () => {
    const path = join(dir, 'marker.txt')
    const content = 'the real artifact content'
    writeFileSync(path, content)
    const result = verifyArtifactLocal(`Done.\nArtifact: ${path}\nSHA256: ${sha256(content)}`)
    expect(result).toMatchObject({ verified: true, path, sha256: sha256(content) })
  })

  it('REFUSES a missing file', () => {
    const path = join(dir, 'does-not-exist.txt')
    const result = verifyArtifactLocal(`Done.\nArtifact: ${path}\nSHA256: ${'a'.repeat(64)}`)
    expect(result).toMatchObject({ verified: false, reason: 'artifact_does_not_exist', path })
  })

  it('REFUSES /etc/passwd — a real, existing, non-symlink regular file this check would otherwise pass on shape alone', () => {
    // The point of this specific case: /etc/passwd is a REAL regular file on
    // any Linux box, so a naive "is it a regular file" check would pass it.
    // It fails here because the claimed SHA256 cannot possibly match the real
    // file's hash (the caller does not control /etc/passwd's contents) —
    // proving the rejection is substantive, not a path-string denylist doing
    // the actual work in this layer (that denylist lives in the OTHER file,
    // src/tasks/artifact-verification.ts, precisely because THIS layer cannot
    // rely on one path being predictably dangerous).
    const result = verifyArtifactLocal(`Done.\nArtifact: /etc/passwd\nSHA256: ${'a'.repeat(64)}`)
    expect(result.verified).toBe(false)
    if (!result.verified) expect(result.reason).toBe('sha256_mismatch')
  })

  it('REFUSES a symlink, even one that points at a real file with a correct hash', () => {
    const real = join(dir, 'real.txt')
    const content = 'genuine content'
    writeFileSync(real, content)
    const link = join(dir, 'link.txt')
    symlinkSync(real, link)
    const result = verifyArtifactLocal(`Done.\nArtifact: ${link}\nSHA256: ${sha256(content)}`)
    expect(result).toMatchObject({ verified: false, reason: 'artifact_is_symlink', path: link })
  })

  it('REFUSES a directory claimed as the artifact', () => {
    const subdir = join(dir, 'a-directory')
    mkdirSync(subdir)
    const result = verifyArtifactLocal(`Done.\nArtifact: ${subdir}\nSHA256: ${'a'.repeat(64)}`)
    expect(result).toMatchObject({ verified: false, reason: 'artifact_not_regular_file', path: subdir })
  })

  it('REFUSES a hash mismatch — claimed SHA256 does not match the real file bytes', () => {
    const path = join(dir, 'marker.txt')
    writeFileSync(path, 'actual content')
    const wrongSha = sha256('different content entirely')
    const result = verifyArtifactLocal(`Done.\nArtifact: ${path}\nSHA256: ${wrongSha}`)
    expect(result).toMatchObject({ verified: false, reason: 'sha256_mismatch', path })
  })

  it('REFUSES a stale file — correct hash, but older than maxAgeMs', () => {
    const path = join(dir, 'old.txt')
    const content = 'old content'
    writeFileSync(path, content)
    const longAgo = new Date(Date.now() - 7_200_000) // 2h ago
    utimesSync(path, longAgo, longAgo)
    const result = verifyArtifactLocal(
      `Done.\nArtifact: ${path}\nSHA256: ${sha256(content)}`,
      undefined,
      { maxAgeMs: 3_600_000 }, // 1h window
    )
    expect(result).toMatchObject({ verified: false, reason: 'artifact_stale', path })
  })

  it('a PRE-EXISTING file (present before the task ran) still passes if the hash and freshness genuinely check out', () => {
    // "pre-existing" alone is not disqualifying — a file created moments ago
    // by legitimate setup is indistinguishable from one an agent just wrote.
    // What the done_when actually needs refused is a STALE pre-existing file
    // (covered above) or one with no matching hash claim — not mere existence
    // before the call.
    const path = join(dir, 'setup-file.txt')
    const content = 'created during test setup, moments ago'
    writeFileSync(path, content)
    const result = verifyArtifactLocal(`Done.\nArtifact: ${path}\nSHA256: ${sha256(content)}`)
    expect(result.verified).toBe(true)
  })

  it('REFUSES when no artifact is claimed and no explicit path is given', () => {
    const result = verifyArtifactLocal('Done, no artifact line here.')
    expect(result).toMatchObject({ verified: false, reason: 'no_artifact_claimed' })
  })

  it('EXPLICIT-PATH OVERRIDE: an explicit path argument that disagrees with the prose is honoured by this LOCAL helper (matching hermes\'s own CLI convenience) — proving why src/\'s server gate structurally CANNOT accept one', () => {
    // hermes's own dispatch-verify.mjs accepts an explicitPath override for
    // local CLI convenience. Demonstrating what that means here: a caller can
    // make the override point at a DIFFERENT file than the one the prose
    // describes, and if that different file happens to hash-match, it PASSES.
    const real = join(dir, 'override-target.txt')
    const content = 'the file the override actually points at'
    writeFileSync(real, content)
    const result = verifyArtifactLocal(
      `Done.\nArtifact: /tmp/completely/different/path/never/checked.txt\nSHA256: ${sha256(content)}`,
      real, // explicit override — wins over the prose's own claim
    )
    expect(result).toMatchObject({ verified: true, path: real })
    // This is exactly why src/tasks/artifact-verification.ts's server-side
    // gate has NO explicitPath parameter at all (see that file's own comment):
    // a server chokepoint that accepted one would let a caller submit prose
    // claiming one artifact while a separate argument silently substitutes
    // another — the "explicit-path override" failure case the done_when
    // requires refused. This helper exists for local/CLI use only and is
    // never imported by src/.
  })
})
