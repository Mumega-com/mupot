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

const VALID_SHA = 'a'.repeat(64)
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

  it('a SHA256 that is not 64 hex chars does not match the shape and reads as not-claimed', () => {
    // The regex IS the validation — a 63-char or non-hex value simply fails to
    // match SHA256_RE, which is indistinguishable from "no claim" at the shape
    // layer. That is correct: partial credit for a malformed hash is not credit.
    const r = verifyTaskArtifactShape('Done.\nArtifact: /tmp/out.txt\nSHA256: deadbeef')
    expect(r).toMatchObject({ verified: false, reason: 'sha256_not_claimed' })
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
