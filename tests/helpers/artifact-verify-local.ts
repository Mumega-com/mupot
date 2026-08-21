// tests/helpers/artifact-verify-local.ts — TEST-ONLY faithful port of hermes's
// local reference verifier (Mumega-com/hadi-mac, branch
// flight07/hermes-dispatch-verifier, commit
// 9090068a1e26a3e11c68403af2422efc76a686de,
// designs/herdr-event-bus/dispatch-verify.mjs). Same checks, same order, same
// rejection reasons.
//
// This is NOT server code and is never imported by src/. It exists to prove
// the byte-level half of FLIGHT-07B's contract — the half src/tasks/
// artifact-verification.ts explicitly does not and cannot perform, because a
// CF Worker has no access to a caller's filesystem and the project bans
// node:fs in src/ regardless. A vitest test process is real Node with a real
// filesystem, so THIS file can do what the Worker structurally cannot, and
// the adversarial matrix the done_when asks for (symlinks, /etc/passwd,
// directories, stale/missing files, hash mismatch, explicit-path override) is
// exercised against it for real.

import { lstatSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

export type LocalVerification =
  | { verified: true; path: string; sha256: string; sizeBytes: number }
  | { verified: false; reason: string; path?: string }

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Faithful port of hermes's verifyArtifact. Deliberately does NOT accept an
 * explicitPath override in production use — matching src/'s own contract, and
 * matching the done_when's "explicit-path override" required-failure case.
 * Kept here as an optional PARAMETER for the one test that specifically
 * demonstrates the override is refused (hermes's own CLI accepts one for
 * local convenience; this test suite proves it is not a viable bypass).
 */
export function verifyArtifactLocal(
  resultBody: string,
  explicitPath?: string,
  options: { maxAgeMs?: number; now?: () => number } = {},
): LocalVerification {
  const maxAgeMs = options.maxAgeMs ?? 3_600_000
  const now = options.now ?? Date.now

  const artifactMatch = resultBody.match(/[Aa]rtifact:\s*(\S+)/)
  const claimedPath = explicitPath || artifactMatch?.[1]
  if (!claimedPath) {
    return { verified: false, reason: 'no_artifact_claimed' }
  }

  let lstats
  try {
    lstats = lstatSync(claimedPath)
  } catch {
    return { verified: false, reason: 'artifact_does_not_exist', path: claimedPath }
  }
  if (lstats.isSymbolicLink()) {
    return { verified: false, reason: 'artifact_is_symlink', path: claimedPath }
  }
  if (!lstats.isFile()) {
    return { verified: false, reason: 'artifact_not_regular_file', path: claimedPath }
  }

  const shaMatch = resultBody.match(/SHA256:\s*([0-9a-fA-F]{64})/)
  if (!shaMatch) {
    return { verified: false, reason: 'sha256_not_claimed', path: claimedPath }
  }
  const claimedSha = shaMatch[1]!.toLowerCase()
  const actualSha = sha256File(claimedPath)
  if (claimedSha !== actualSha) {
    return { verified: false, reason: 'sha256_mismatch', path: claimedPath }
  }

  const ageMs = now() - lstats.mtimeMs
  if (ageMs > maxAgeMs) {
    return { verified: false, reason: 'artifact_stale', path: claimedPath }
  }

  return { verified: true, path: claimedPath, sha256: actualSha, sizeBytes: lstats.size }
}
