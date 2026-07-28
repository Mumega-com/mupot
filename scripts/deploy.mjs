#!/usr/bin/env node
// scripts/deploy.mjs — the direct-deploy entrypoint for a single pot (`npm run
// deploy`). Wraps `wrangler deploy` and ALWAYS stamps the build with the exact
// commit HEAD is on, via RELEASE_SHA (see scripts/lib/release-sha.mjs and
// src/health.ts / src/dashboard/deployment.ts).
//
// Closes mupot#443 Part A. Before this, GET /health reported `commit: null` in
// production because stamping RELEASE_SHA was a manual step
// (`RELEASE_SHA=$(git rev-parse HEAD) wrangler deploy`) nobody remembered to
// run. Baking it into the tool itself means it is no longer possible to
// forget — every deploy through this entrypoint is stamped, full stop.
//
//   npm run deploy                     # deploy the repo-default wrangler.toml (mumega)
//   npm run deploy -- --config wrangler.acme.toml --message "..."
//
// (any extra args are forwarded to `wrangler deploy` verbatim)
//
// Refuses a dirty working tree by default — the bundle wouldn't correspond to
// any single commit, so the RELEASE_SHA stamp would misreport what's actually
// live. Override with MUPOT_ALLOW_DIRTY_DEPLOY=1 for a deliberate local test
// deploy only; never use this for a real production deploy. Even with the
// override, the stamp is marked non-clean (`-dirty` suffix) — an overridden
// dirty/off-main deploy never gets to look like a verified clean release
// (mupot#571).
//
// RELEASE_SHA is derived from git ONLY. Any extra/forwarded arg that tries to
// smuggle its own `--var RELEASE_SHA:...` is refused outright — see
// assertNoCallerReleaseSha in scripts/lib/release-sha.mjs (mupot#571).

import { spawnSync } from 'node:child_process'
import { assertNoCallerReleaseSha, isMainDescendant, releaseShaDeployArgs } from './lib/release-sha.mjs'

function capture(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  return (r.stdout || '').trim()
}

const extra = process.argv.slice(2)

try {
  assertNoCallerReleaseSha(extra)
} catch (err) {
  console.error(`✘ ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}

const dirty = capture('git', ['status', '--porcelain']).length > 0
if (dirty && process.env.MUPOT_ALLOW_DIRTY_DEPLOY !== '1') {
  console.error(
    '✘ refusing to deploy from a DIRTY working tree — the deployed bundle would not match ' +
      'any single commit, so RELEASE_SHA (GET /health `commit`) would misreport it. Commit ' +
      'or stash first, or set MUPOT_ALLOW_DIRTY_DEPLOY=1 to override for a deliberate local ' +
      'test deploy (never for production).',
  )
  process.exit(1)
}

const fullSha = capture('git', ['rev-parse', 'HEAD'])
const onMain = isMainDescendant(fullSha)
const clean = !dirty && onMain

if (!clean) {
  console.error(
    `⚠ this deploy is NOT a verified clean release (${dirty ? 'dirty working tree' : "HEAD not on/descended-from 'main'"}) ` +
      "— stamping RELEASE_SHA with a '-dirty' suffix so it can never be mistaken for one.",
  )
}

let releaseArgs
try {
  releaseArgs = releaseShaDeployArgs(fullSha, { clean })
} catch (err) {
  console.error(`✘ ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}

const res = spawnSync('npx', ['wrangler', 'deploy', ...releaseArgs, ...extra], { stdio: 'inherit' })
process.exit(res.status ?? 1)
