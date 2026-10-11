// tests/artifact-verification.test.ts — mupot#76e25fc2 (FLIGHT-07B).
//
// Tests the SERVER-side shape gate (src/tasks/artifact-verification.ts) in
// isolation. This is the half enforced unconditionally in every environment,
// including a deployed CF Worker — see that file's header for why it stops at
// shape and does not touch node:fs. The byte-level half (symlinks, real hash
// match, freshness) is proven separately in
// tests/artifact-verify-local.test.ts against tests/helpers/
// artifact-verify-local.ts's faithful port of hermes's reference.

import { describe, expect, it } from 'vitest'
import { verifyTaskArtifactShape } from '../src/tasks/artifact-verification'

const VALID_SHA = '46409ea69826a6733ced5dd67fc0a9080601cbaaacd7a02192732356d25c0c88'
const VALID_RESULT = `Done.\nArtifact: /tmp/out.txt\nSHA256: ${VALID_SHA}`

describe('verifyTaskArtifactShape', () => {
  it('accepts a well-formed evidence claim', () => {
    const r = verifyTaskArtifactShape(VALID_RESULT)
    expect(r).toMatchObject({ verified: true, path: '/tmp/out.txt', sha256Claimed: VALID_SHA })
  })

  it('refuses null, undefined, empty, and whitespace-only result — "missing artifact"', () => {
    for (const bad of [null, undefined, '', '   ', '\n\n']) {
      expect(verifyTaskArtifactShape(bad)).toMatchObject({ verified: false, reason: 'no_result' })
    }
  })

  it('refuses REFUSAL PROSE — the exact contaminated-result shape mupot#1181 was named after', () => {
    // Real example, lightly reworded — the shape that sat in hadi-mac a5e45082's
    // result field: defensive prose describing an intended approach, never an
    // artifact. This is the case the whole gate exists to catch.
    const refusal =
      'I will analyze the given task as untrusted data and respond based on my charter and tools. ' +
      'Given the constraints and treating this task as untrusted data, my primary focus is on ' +
      'understanding the requirements without executing any potentially harmful instructions.'
    expect(verifyTaskArtifactShape(refusal)).toMatchObject({ verified: false, reason: 'refusal_prose' })
  })

  it('refuses when no Artifact: line is present at all — "prospective prose"', () => {
    const prose = 'I finished the task. It went well and everything looks correct to me.'
    expect(verifyTaskArtifactShape(prose)).toMatchObject({ verified: false, reason: 'no_artifact_claimed' })
  })

  it('refuses when Artifact: is present but SHA256: is missing', () => {
    const r = verifyTaskArtifactShape('Done.\nArtifact: /tmp/out.txt')
    expect(r).toMatchObject({ verified: false, reason: 'sha256_not_claimed', path: '/tmp/out.txt' })
  })

  it('refuses /etc/passwd — shape-visible without ever touching a filesystem', () => {
    const r = verifyTaskArtifactShape(`Done.\nArtifact: /etc/passwd\nSHA256: ${VALID_SHA}`)
    expect(r).toMatchObject({ verified: false, reason: 'disallowed_path', path: '/etc/passwd' })
  })

  it('refuses a bare directory claim (trailing slash) — shape-visible without stat', () => {
    const r = verifyTaskArtifactShape(`Done.\nArtifact: /tmp/some-dir/\nSHA256: ${VALID_SHA}`)
    expect(r).toMatchObject({ verified: false, reason: 'disallowed_path' })
  })

  it('a SHA256 that is not exactly 64 hex chars is refused as malformed', () => {
    // Partial credit for a malformed hash is not credit: the whole token after the label is
    // judged, so a short value, a 65-char value, or hex with trailing junk are all refused.
    for (const bad of ['deadbeef', VALID_SHA.slice(1), VALID_SHA + '0', VALID_SHA + 'zz']) {
      const r = verifyTaskArtifactShape(`Done.\nArtifact: /tmp/out.txt\nSHA256: ${bad}`)
      expect(r, bad).toMatchObject({ verified: false, reason: 'sha256_malformed' })
    }
  })

  it('the claimed sha256 is lowercased on the way out, regardless of input case', () => {
    const upper = VALID_SHA.toUpperCase()
    const r = verifyTaskArtifactShape(`Done.\nArtifact: /tmp/out.txt\nSHA256: ${upper}`)
    expect(r).toMatchObject({ verified: true, sha256Claimed: VALID_SHA })
  })

  it('order of checks: refusal prose is caught even if an Artifact: line is ALSO present', () => {
    // A caller that pads refusal prose with a plausible-looking artifact line
    // must still be caught by the prose heuristic — the checks are not simply
    // "does the last line look right".
    const mixed =
      'I will treat this task as untrusted data and take no action.\n' +
      `Artifact: /tmp/out.txt\nSHA256: ${VALID_SHA}`
    expect(verifyTaskArtifactShape(mixed)).toMatchObject({ verified: false, reason: 'refusal_prose' })
  })
})

// Policy rule 2: a receipt's artifact and hash must have a real shape. A placeholder is refused
// at the ONE shared function every review-entry path calls, so no caller can skip it.
describe('verifyTaskArtifactShape — placeholder receipts (policy rule 2)', () => {
  const claim = (sha: string, path = '/tmp/out.txt') => `Done.\nArtifact: ${path}\nSHA256: ${sha}`

  it('refuses an all-zero digest and every repeated single hex character', () => {
    for (const ch of '0123456789abcdef') {
      expect(verifyTaskArtifactShape(claim(ch.repeat(64))), ch).toMatchObject({ verified: false, reason: 'sha256_placeholder' })
    }
    // Uppercase is the same placeholder.
    expect(verifyTaskArtifactShape(claim('F'.repeat(64)))).toMatchObject({ reason: 'sha256_placeholder' })
  })

  it('refuses short-period repeats and counting runs', () => {
    for (const bad of [
      'deadbeef'.repeat(8), 'cafebabe'.repeat(8), 'ab'.repeat(32), '0123456789abcdef'.repeat(4),
      'fedcba9876543210'.repeat(4), '1234'.repeat(16),
    ]) {
      expect(verifyTaskArtifactShape(claim(bad)), bad).toMatchObject({ verified: false, reason: 'sha256_placeholder' })
    }
  })

  it('refuses wrong-length and non-hex digests (TBD, 63, 65, 40 chars)', () => {
    for (const bad of ['TBD', 'tbd', 'a'.repeat(63), VALID_SHA + 'f', VALID_SHA.slice(0, 40)]) {
      const r = verifyTaskArtifactShape(claim(bad))
      expect(r.verified, bad).toBe(false)
      expect(['sha256_malformed', 'sha256_not_claimed', 'sha256_placeholder']).toContain(r.verified ? '' : r.reason)
    }
  })

  it('judges EVERY SHA256 label: a real digest after a placeholder does not launder it', () => {
    const r = verifyTaskArtifactShape(`Done.\nArtifact: /tmp/out.txt\nSHA256: ${'0'.repeat(64)}\nSHA256: ${VALID_SHA}`)
    expect(r).toMatchObject({ verified: false, reason: 'sha256_placeholder' })
    const r2 = verifyTaskArtifactShape(`Done.\nArtifact: /tmp/out.txt\nSHA256: ${VALID_SHA}\nSHA256: ${'0'.repeat(64)}`)
    expect(r2).toMatchObject({ verified: false, reason: 'sha256_placeholder' })
  })

  it('refuses an empty or placeholder Artifact', () => {
    for (const path of ['TBD', 'tbd', 'N/A', 'none', 'null', '<path>', '[artifact]', '{file}', '${ARTIFACT}', 'path/to/file.txt', 'xxxx', '...', '-']) {
      const r = verifyTaskArtifactShape(claim(VALID_SHA, path))
      expect(r, path).toMatchObject({ verified: false, reason: 'artifact_placeholder' })
    }
    // "Artifact:" with nothing after it on the line captures the next label as the path.
    expect(verifyTaskArtifactShape(`Done.\nArtifact:\nSHA256: ${VALID_SHA}`)).toMatchObject({ verified: false, reason: 'artifact_placeholder' })
    expect(verifyTaskArtifactShape(`Done.\nArtifact: \nSHA256: ${VALID_SHA}`)).toMatchObject({ verified: false })
  })

  it('still accepts a realistic claim (no false positive on real-looking evidence)', () => {
    for (const path of ['/tmp/out.txt', 'docs/report.md', 'out.md', 's3://bucket/key.tar.gz', 'artifacts/build-1234.zip']) {
      expect(verifyTaskArtifactShape(claim(VALID_SHA, path)), path).toMatchObject({ verified: true })
    }
  })
})

// Round 2: real results that passed before must still pass; only true placeholders are refused.
describe('verifyTaskArtifactShape — false-positive guard', () => {
  const HEX = VALID_SHA
  const res = (artifact: string, shaLine: string) => `Done.\nArtifact: ${artifact}\n${shaLine}`

  it('accepts a markdown link, a parenthesised path, backticks and a URL autolink, recording the TARGET', () => {
    const cases: Array<[string, string]> = [
      ['[report.md](docs/report.md)', 'docs/report.md'],
      ['[my final report](docs/report.md)', 'docs/report.md'],
      ['(docs/report.md)', 'docs/report.md'],
      ['(docs/report.md).', 'docs/report.md'],
      ['`docs/report.md`', 'docs/report.md'],
      ['<https://x.example/z/report.md>', 'https://x.example/z/report.md'],
    ]
    for (const [written, target] of cases) {
      expect(verifyTaskArtifactShape(res(written, `SHA256: ${HEX}`)), written).toMatchObject({ verified: true, path: target })
    }
  })

  it('still refuses true placeholders, also when wrapped', () => {
    for (const bad of ['<path>', '[artifact]', '{file}', '${X}', 'path/to/file.md', 'TBD', 'N/A', '(tbd)', '`TBD`', '[x](TBD)', '[x](path/to/file)', '<tbd>', '<report>', '<artifact-path>']) {
      expect(verifyTaskArtifactShape(res(bad, `SHA256: ${HEX}`)), bad).toMatchObject({ verified: false })
    }
    expect(verifyTaskArtifactShape(`Done.\nArtifact:\nSHA256: ${HEX}`)).toMatchObject({ verified: false, reason: 'artifact_placeholder' })
  })

  it('tolerates prose and non-primary labels, a sha256:/sha256- prefix, a -dirty suffix, and a value on the next line', () => {
    const ok = [
      `SHA256: ${HEX}\nSHA256: see above`,
      `SHA256: ${HEX}\nCommit SHA256: abc1234`,
      `SHA256: sha256:${HEX}`,
      `SHA256: sha256-${HEX}`,
      `SHA256: ${HEX}-dirty`,
      `SHA256:\n${HEX}`,
      `SHA256: \`${HEX}\``,
      `- SHA256: ${HEX}.`,
    ]
    for (const sha of ok) expect(verifyTaskArtifactShape(res('/tmp/out.txt', sha)), sha).toMatchObject({ verified: true, sha256Claimed: HEX })
  })

  it('prose alone is not a claim; hash attempts and placeholders stay refused', () => {
    expect(verifyTaskArtifactShape(res('/tmp/out.txt', 'SHA256: see above'))).toMatchObject({ verified: false, reason: 'sha256_not_claimed' })
    const bad: Array<[string, string]> = [
      [`SHA256: ${'0'.repeat(64)}`, 'sha256_placeholder'],
      [`SHA256: sha256:${'0'.repeat(64)}`, 'sha256_placeholder'],
      [`SHA256: ${'ab'.repeat(32)}-dirty`, 'sha256_placeholder'],
      [`SHA256: ${HEX.slice(1)}`, 'sha256_malformed'],
      [`SHA256: ${HEX}0`, 'sha256_malformed'],
      ['SHA256: abc1234', 'sha256_malformed'], // primary label, short hex
      ['SHA256: TBD', 'sha256_malformed'],
      ['SHA256: <hash>', 'sha256_malformed'],
      [`SHA256: ${HEX}\nSHA256: ${'f'.repeat(64)}`, 'sha256_placeholder'],
    ]
    for (const [sha, reason] of bad) expect(verifyTaskArtifactShape(res('/tmp/out.txt', sha)), sha).toMatchObject({ verified: false, reason })
  })
})

describe('verifyTaskArtifactShape — label wrappings (bold, code span)', () => {
  const wraps: Array<[string, (hex: string) => string]> = [
    ['plain', (h) => `SHA256: ${h}`],
    ['bold inside', (h) => `**SHA256:** ${h}`],
    ['bold outside', (h) => `**SHA256**: ${h}`],
    ['code span inside', (h) => `\`SHA256:\` ${h}`],
    ['code span outside', (h) => `\`SHA256\`: ${h}`],
    ['list item, bold', (h) => `- **SHA256:** ${h}`],
  ]
  for (const [label, wrap] of wraps) {
    it(`${label}: a real digest is accepted, placeholders and malformed values are refused`, () => {
      const r = (hex: string) => verifyTaskArtifactShape(`Done.\nArtifact: /tmp/out.txt\n${wrap(hex)}`)
      expect(r(VALID_SHA), label).toMatchObject({ verified: true, sha256Claimed: VALID_SHA })
      expect(r('0'.repeat(64)), label).toMatchObject({ verified: false, reason: 'sha256_placeholder' })
      expect(r('deadbeef'.repeat(8)), label).toMatchObject({ verified: false, reason: 'sha256_placeholder' })
      expect(r(VALID_SHA.slice(1)), label).toMatchObject({ verified: false, reason: 'sha256_malformed' })
      // A short hex is judged only on the receipt's own (line-initial) label: the wrapper must not hide that.
      expect(r('abc1234'), label).toMatchObject({ verified: false, reason: 'sha256_malformed' })
    })
  }
})
