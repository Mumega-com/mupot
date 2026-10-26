// src/tasks/evidence.ts — completion evidence kinds (E2, Athena conditions on task 565da9e9) behind the
// Security Bar rule `task.update.artifact-shape-gate`.
//
// What changed vs. verifyTaskArtifactShape (src/tasks/artifact-verification.ts, which is UNCHANGED and is still
// the whole answer at under_attack): at onboarding/operating a result may ALSO be one of these explicit kinds.
// Kinds are explicit, never a silent default: prose with none of them is refused at every level.
//
//   file      "Artifact: <path>" + "SHA256: <64-hex>"  (the existing shape; the digest is CLAIMED, not verified)
//   repo      a repository/PR/commit URL naming owner/repo, plus a FULL commit id (40 or 64 hex) in the text
//   snapshot  an explicit "Snapshot: <label>" line; the digest is computed BY THE SERVER over the result text
//
// Approval binding is unchanged at every level: a verdict binds to the exact submission id and the SERVER
// digest (task_result_submissions.result_digest). For repo/snapshot kinds the receipt's artifact_sha256 column
// carries that same server-computed digest (the column needs 64 hex and a commit id may be 40), and artifact_path
// carries "<url>@<commit>" / "snapshot:<label>". Placeholder, refusal-prose and disallowed-path evidence stays
// refused (floor task.evidence.no-placeholder).

import type { Env } from '../types'
import { sha256Hex } from '../members/service'
import { policy, relaxes, type PolicyScope } from '../policy/bar'
import { verifyTaskArtifactShape, type ArtifactRejectionReason } from './artifact-verification'

export type EvidenceKind = 'file' | 'repo' | 'snapshot'

export type TaskEvidence =
  | { verified: true; kind: EvidenceKind; path: string; sha256Claimed: string }
  | { verified: false; reason: ArtifactRejectionReason | 'evidence_kind_missing'; path?: string }

/** Reasons that mean "no usable evidence of ANY kind": relaxing the rule must not rescue these (floor). */
const NEVER_RESCUED: ReadonlySet<string> = new Set(['no_result', 'refusal_prose', 'disallowed_path', 'artifact_placeholder', 'sha256_placeholder'])

const REPO_URL_RE = /https:\/\/(?:github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/(?:pull\/\d+|commit\/([0-9a-f]{40}|[0-9a-f]{64})|tree\/([0-9a-f]{40}|[0-9a-f]{64})|-\/merge_requests\/\d+))?/i
const COMMIT_RE = /(?<![0-9a-fA-F])([0-9a-f]{40}|[0-9a-f]{64})(?![0-9a-fA-F])/g
const SNAPSHOT_RE = /^[ \t>*_`-]*Snapshot:[ \t]*(\S[^\r\n]{0,199})$/im

function isPlaceholderHex(h: string): boolean {
  if (/^(.)\1*$/.test(h)) return true
  for (const period of [2, 4, 8, 16]) {
    if (h.length % period === 0 && h === h.slice(0, period).repeat(h.length / period)) return true
  }
  return false
}

function repoEvidence(text: string): { path: string } | null {
  const m = REPO_URL_RE.exec(text)
  if (!m) return null
  const owner = m[1]
  const repo = m[2]
  if (!owner || !repo || /^\.+$/.test(owner) || /^\.+$/.test(repo)) return null
  // A commit id embedded in the URL counts; otherwise one must stand in the text. A short sha is never enough.
  const candidates = [m[3], m[4], ...[...text.matchAll(COMMIT_RE)].map((x) => x[1])].filter((x): x is string => typeof x === 'string')
  const commit = candidates.map((c) => c.toLowerCase()).find((c) => !isPlaceholderHex(c))
  if (!commit) return null
  return { path: `${m[0]}@${commit}` }
}

/**
 * Judge a result as completion evidence at the CURRENT bar level.
 * `ctx` identifies who/what for the would_block record written when the relaxed kinds rescue a result the
 * strict shape would have refused.
 */
export async function verifyTaskEvidence(
  env: Env,
  resultBody: string | null | undefined,
  ctx: { actor: string; scopeRef: string; scope?: PolicyScope },
): Promise<TaskEvidence> {
  const strict = verifyTaskArtifactShape(resultBody)
  if (strict.verified) return { verified: true, kind: 'file', path: strict.path, sha256Claimed: strict.sha256Claimed }
  if (NEVER_RESCUED.has(strict.reason) || !resultBody) return strict

  // Only now is the bar consulted: the strict shape already refused, so a relaxation is the thing being asked.
  const d = await policy(env, ctx.scope ?? {}, 'task.update.artifact-shape-gate')
  if (!d.relaxed) return strict

  let found: { kind: EvidenceKind; path: string } | null = null
  const repo = repoEvidence(resultBody)
  if (repo) found = { kind: 'repo', path: repo.path }
  else {
    const snap = SNAPSHOT_RE.exec(resultBody)
    // A snapshot label alone is not evidence: the result must carry content beyond the label line.
    if (snap && resultBody.replace(snap[0], '').trim().length >= 20) found = { kind: 'snapshot', path: `snapshot:${(snap[1] ?? '').trim()}` }
  }
  if (!found) return { verified: false, reason: strict.reason === 'sha256_malformed' ? 'sha256_malformed' : 'evidence_kind_missing', ...(strict.path ? { path: strict.path } : {}) }

  if (!(await relaxes(env, 'task.update.artifact-shape-gate', { actor: ctx.actor, scopeRef: ctx.scopeRef, detail: `kind=${found.kind}`, ...(ctx.scope ? { scope: ctx.scope } : {}) }))) return strict
  return { verified: true, kind: found.kind, path: found.path, sha256Claimed: await sha256Hex(resultBody) }
}
