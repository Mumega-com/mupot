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
//
// mupot#571 review fixes (post-#443):
//   1. RELEASE_SHA is derived from `git rev-parse HEAD` ONLY. A caller can
//      never inject an arbitrary value — see `assertNoCallerReleaseSha`,
//      which both deploy entrypoints run against any forwarded/extra CLI
//      args BEFORE spawning wrangler.
//   2. A dirty tree or a HEAD that is not on/descended-from `main` must never
//      produce a bare "clean-looking" 40-hex stamp — see the `clean` option
//      on `releaseShaDeployArgs` (adds a `-dirty` suffix) and the matching
//      parse-side `clean` field on `publicHealth` in src/health.ts.

import { spawnSync } from 'node:child_process'

const FULL_SHA_RE = /^[0-9a-f]{40}$/i
const DIRTY_STAMP_RE = /^[0-9a-f]{40}-dirty$/i
const RELEASE_SHA_VAR_RE = /^RELEASE_SHA[:=]/i

/** True iff `sha` is a full 40-hex commit sha (mirrors src/health.ts's own check). */
export function isFullSha(sha) {
  return typeof sha === 'string' && FULL_SHA_RE.test(sha)
}

/** True iff `stamp` is a full 40-hex sha, optionally with the `-dirty` suffix. */
export function isValidStamp(stamp) {
  return isFullSha(stamp) || (typeof stamp === 'string' && DIRTY_STAMP_RE.test(stamp))
}

/**
 * Refuse a caller-supplied `--var RELEASE_SHA:...` (or `--var=RELEASE_SHA:...`)
 * smuggled into the args forwarded to `wrangler deploy`. Both deploy
 * entrypoints compute RELEASE_SHA themselves, from git, as the single source
 * of truth (see `releaseShaDeployArgs` below) and append it to the wrangler
 * invocation — if a caller's own forwarded args are appended afterward (or
 * wrangler otherwise lets a later flag win), an attacker-chosen "clean"
 * 40-hex value could be stamped into production without it ever being the
 * real deployed commit. Throws rather than trusting CLI flag-precedence
 * behavior to save us.
 */
export function assertNoCallerReleaseSha(extraArgs) {
  const args = Array.isArray(extraArgs) ? extraArgs : []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (typeof a !== 'string') continue
    if (a.startsWith('--var=') && RELEASE_SHA_VAR_RE.test(a.slice('--var='.length))) {
      throw new Error(
        `refusing caller-supplied RELEASE_SHA override via '${a}' — RELEASE_SHA is derived ` +
          'from git (`git rev-parse HEAD`), never from caller-supplied CLI args.',
      )
    }
    if (a === '--var' && typeof args[i + 1] === 'string' && RELEASE_SHA_VAR_RE.test(args[i + 1])) {
      throw new Error(
        `refusing caller-supplied RELEASE_SHA override via '--var ${args[i + 1]}' — RELEASE_SHA ` +
          'is derived from git (`git rev-parse HEAD`), never from caller-supplied CLI args.',
      )
    }
  }
}

/**
 * Build the extra `wrangler deploy` CLI args that stamp RELEASE_SHA for this
 * exact commit. Throws (does not silently degrade) when `sha` isn't a full
 * 40-hex commit — an unstamped production deploy should be a loud failure at
 * deploy time, not a silent `commit: null` discovered days later.
 *
 * `clean` (default true) must be computed by the caller from real git state:
 * `false` when the working tree is dirty OR HEAD is not on/descended-from
 * `main`. When `false`, the stamp gets a `-dirty` suffix so a bundle built
 * from an unverifiable or modified tree can never advertise a bare, clean
 * commit identity — `src/health.ts` parses the suffix back out into an
 * explicit `clean: false` field rather than silently reporting a sha that
 * looks indistinguishable from a real, clean release.
 */
export function releaseShaDeployArgs(sha, { clean = true } = {}) {
  if (!isFullSha(sha)) {
    throw new Error(
      `refusing to stamp RELEASE_SHA: '${sha}' is not a full 40-hex commit sha ` +
        '(got a short sha, a branch name, or nothing resolvable — run `git rev-parse HEAD`)',
    )
  }
  const stamp = clean ? sha : `${sha}-dirty`
  return ['--var', `RELEASE_SHA:${stamp}`]
}

/** True iff `ref` resolves in this checkout (branch, remote-tracking ref, etc). */
function refExists(ref, { cwd } = {}) {
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd, encoding: 'utf8' })
  return r.status === 0
}

/**
 * True iff `sha` is `main` itself or a descendant of it, checked against
 * `origin/main` first (the authoritative remote state) and falling back to a
 * local `main` branch if the remote ref isn't available. Unverifiable (e.g. a
 * shallow clone with neither ref present) fails CLOSED to `false` — an
 * unprovable ancestry is never treated as "on main".
 */
export function isMainDescendant(sha, { cwd } = {}) {
  if (!isFullSha(sha)) return false
  for (const ref of ['origin/main', 'main']) {
    if (!refExists(ref, { cwd })) continue
    const r = spawnSync('git', ['merge-base', '--is-ancestor', sha, ref], { cwd, encoding: 'utf8' })
    if (r.status === 0) return true
  }
  return false
}
