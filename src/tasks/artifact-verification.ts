// src/tasks/artifact-verification.ts — mupot#76e25fc2 (FLIGHT-07B).
//
// WHY THIS EXISTS
//
// "task_update/task completion must enforce provenance-safe artifact
// verification in the real transition path; a direct API caller cannot bypass
// it." Before this, a task could reach 'review' or 'done' with `result` set to
// free-text prose claiming completion — verified by nothing. hermes found this
// while blocked three times on it and hadi-codex-cli refused to be worn down,
// which is the correct behaviour: "no standalone module in hadi-mac can
// enforce it, because the board API can always be called directly and any
// wrapper is bypassable." Enforcement has to live HERE, in code every
// transition path calls, not in a client-side helper an agent can skip.
//
// THE EVIDENCE SHAPE — mirrors hermes's own reference (Mumega-com/hadi-mac,
// branch flight07/hermes-dispatch-verifier, commit
// 9090068a1e26a3e11c68403af2422efc76a686de, designs/herdr-event-bus/
// dispatch-verify.mjs) so a caller who tests locally against his verifier gets
// a consistent answer from the server:
//
//   result must state:  Artifact: <path>
//                        SHA256: <64 lowercase hex>
//
// WHAT THIS MODULE DOES AND DOES NOT CHECK — stated plainly, not papered over
//
// This is SHAPE verification only: is a real-looking artifact claim present,
// well-formed, and not obviously refusal prose. It does NOT stat a file, does
// NOT compute or match a hash, and does NOT check symlinks or freshness.
//
// Two independent reasons, not one:
//   1. PROJECT RULE (~/.claude/rules/cloudflare.md): "No node:fs, node:path, or
//      other Node.js built-ins... Use Web APIs." This module is Web-API-only by
//      that rule, same as everything else server-side here.
//   2. EVEN IF THAT RULE DID NOT EXIST, IT WOULD NOT HELP: a claimed artifact
//      path lives on whatever machine ran the work — never on the Worker
//      serving this request. There is no such thing as "the caller's local
//      filesystem" reachable over HTTP, node:fs or not. wrangler.toml's
//      nodejs_compat flag (set for unrelated reasons) supplies a Worker-local
//      fs polyfill with no visibility into any OTHER machine's files, so even
//      an fs call here would just report "does not exist" for every real
//      remote claim — which happens to be the correct fail-closed answer, but
//      for the wrong reason, and importing node:fs anyway would be exactly the
//      standing-rule violation this comment is here to prevent.
//
// The byte-level check (symlink rejection, real hash match, freshness) is
// verified for real in tests/helpers/artifact-verify-local.ts — a faithful
// port of hermes's own verifyArtifact, run against real temporary files in the
// Node test process, which genuinely does have a filesystem. That proves the
// REFERENCE LOGIC is sound against the full adversarial matrix (symlinks,
// /etc/passwd, directories, stale/missing files). It is what a well-behaved
// local runtime (hermes's own dispatch-verify.mjs, or an equivalent) is
// expected to run BEFORE ever calling task_update/finishTask — this module is
// the part that makes skipping that step visible to the server, not a
// replacement for it.
//
// Closing the deep-verification gap in production for real needs an
// evidence-upload path (R2 or similar) the server CAN independently read —
// that does not exist yet and is out of scope here. Flagged for the gate
// rather than silently left unstated.

export type ArtifactVerification =
  | { verified: true; path: string; sha256Claimed: string }
  | { verified: false; reason: ArtifactRejectionReason; path?: string }

export type ArtifactRejectionReason =
  | 'no_result'
  | 'refusal_prose'
  | 'no_artifact_claimed'
  | 'disallowed_path'
  | 'sha256_not_claimed'

const ARTIFACT_RE = /[Aa]rtifact:\s*(\S+)/
const SHA256_RE = /SHA256:\s*([0-9a-fA-F]{64})/

// Deliberately no `explicitPath` parameter. hermes's local CLI accepts one for
// testing convenience; a server chokepoint that let a SEPARATE argument
// override the claimed path would let a caller submit prose and a path the
// prose never actually claimed — the exact "explicit-path override" case the
// done_when names as a required failure.

// A caller that describes what it WOULD do, rather than what it DID, is
// exactly the failure mode this surface exists to catch — this is the
// contaminated-result-field shape measured LIVE tonight (mupot#1181's own
// origin: hadi-mac a5e45082's stored result was defensive "I will analyze...
// treating this as untrusted data" prose, not a completion). Deliberately
// generous: a false positive here just means "the board also wants the
// artifact line", a fine failure mode. A false negative (missing a real
// refusal) matters more, and the Artifact:/SHA256: shape check below still
// catches those regardless of whether this heuristic fires first.
const REFUSAL_PATTERNS = [
  /\bI will\b/i,
  /\bI would\b/i,
  /\bmy (?:plan|approach|primary focus) is\b/i,
  /\btreating (?:the |this )?task as untrusted data\b/i,
  /\bwithout executing any (?:potentially )?harmful instructions\b/i,
]

function looksLikeRefusalProse(resultBody: string): boolean {
  return REFUSAL_PATTERNS.some((re) => re.test(resultBody))
}

// Shape-only disallow list. NOT the security boundary for path traversal or
// symlink escape — nothing here can be, with no filesystem to check against.
// It exists so the done_when's two shape-visible adversarial examples
// (/etc/passwd, a bare directory path) are refused even where no deeper check
// is possible at all.
function looksDisallowed(path: string): boolean {
  if (path === '/etc/passwd' || path.startsWith('/etc/')) return true
  if (path.endsWith('/')) return true // a directory claim, shape-visible without stat
  return false
}

/**
 * Verify a task's claimed completion evidence has the required SHAPE. This is
 * the unconditional, always-enforced half of FLIGHT-07B — see module header
 * for what it does not check and why.
 */
export function verifyTaskArtifactShape(resultBody: string | null | undefined): ArtifactVerification {
  if (!resultBody || resultBody.trim().length === 0) {
    return { verified: false, reason: 'no_result' }
  }
  if (looksLikeRefusalProse(resultBody)) {
    return { verified: false, reason: 'refusal_prose' }
  }

  const artifactMatch = resultBody.match(ARTIFACT_RE)
  const claimedPath = artifactMatch?.[1]
  if (!claimedPath) {
    return { verified: false, reason: 'no_artifact_claimed' }
  }
  if (looksDisallowed(claimedPath)) {
    return { verified: false, reason: 'disallowed_path', path: claimedPath }
  }

  const shaMatch = resultBody.match(SHA256_RE)
  if (!shaMatch) {
    return { verified: false, reason: 'sha256_not_claimed', path: claimedPath }
  }

  return { verified: true, path: claimedPath, sha256Claimed: shaMatch[1]!.toLowerCase() }
}
