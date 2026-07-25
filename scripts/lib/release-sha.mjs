// scripts/lib/release-sha.mjs — the ONE place that decides how a deploy gets
// stamped with the exact commit it was built from.
//
// Closes mupot#443 (Part A): GET /health was reporting `commit: null` in
// production because RELEASE_SHA was a manually-remembered env var
// (`RELEASE_SHA=$(git rev-parse HEAD) wrangler deploy`) — exactly the kind of
// step a human forgets. This module is imported by BOTH deploy entrypoints
// (scripts/deploy.mjs for a single pot, scripts/mupot-update.mjs for the
// multi-pot orchestrator) so there is exactly one implementation to keep
// correct, never two that can drift out of sync with each other or with
// src/health.ts's own validation.
//
// src/health.ts independently re-validates the same 40-hex shape server-side
// (never trusts the deploy-time stamp blindly) — this module is what keeps a
// bad value from ever being sent in the first place.

const FULL_SHA_RE = /^[0-9a-f]{40}$/i

/** True iff `sha` is a full 40-hex commit sha (mirrors src/health.ts's own check). */
export function isFullSha(sha) {
  return typeof sha === 'string' && FULL_SHA_RE.test(sha)
}

/**
 * Build the extra `wrangler deploy` CLI args that stamp RELEASE_SHA for this
 * exact commit. Throws (does not silently degrade) when `sha` isn't a full
 * 40-hex commit — an unstamped production deploy should be a loud failure at
 * deploy time, not a silent `commit: null` discovered days later.
 */
export function releaseShaDeployArgs(sha) {
  if (!isFullSha(sha)) {
    throw new Error(
      `refusing to stamp RELEASE_SHA: '${sha}' is not a full 40-hex commit sha ` +
        '(got a short sha, a branch name, or nothing resolvable — run `git rev-parse HEAD`)',
    )
  }
  return ['--var', `RELEASE_SHA:${sha}`]
}
