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
//
// POST-DEPLOY BUNDLE PUBLISH (mupot#1285/#1516 enablement — docs/workflows/
// tenant-provision.md "the actual 'PUT it to R2 after a successful deploy' step in
// scripts/deploy.mjs is the follow-up"). After a successful, CLEAN deploy, this script
// runs scripts/publish-pot-bundle.mjs so the R2 bucket `loadPotWorkerBundle` reads always
// carries THIS deploy's own bundle under its own RELEASE_SHA. A deploy whose bundle fails
// to publish must not report success silently — the publish step's exit code is this
// script's own exit code. Skip with `--skip-bundle-publish` (e.g. a colony with no
// POT_WORKER_BUNDLE_BUCKET wired up yet, or CI running scripts/deploy.mjs somewhere that
// legitimately has no CLOUDFLARE_API_TOKEN scoped for R2). A deploy that is not a verified
// clean release (dirty override, or off-main) never attempts the publish at all — its
// RELEASE_SHA carries a `-dirty` suffix that `assertPublishPreconditions` (scripts/lib/
// pot-bundle-r2.mjs) would refuse anyway, and that is a correct, PRINTED skip, not a
// silent gap.

import { spawnSync } from 'node:child_process'
import { assertNoCallerReleaseSha, isMainDescendant, releaseShaDeployArgs } from './lib/release-sha.mjs'
import { generateBuildInfo } from './generate-build-info.mjs'

// Automatically stamp src/build-info.ts prior to deploy
generateBuildInfo()

function capture(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  return (r.stdout || '').trim()
}

const rawArgs = process.argv.slice(2)
const skipBundlePublish = rawArgs.includes('--skip-bundle-publish')
const extra = rawArgs.filter((a) => a !== '--skip-bundle-publish')
const configFlagIndex = extra.indexOf('--config')
const configPath = configFlagIndex >= 0 ? extra[configFlagIndex + 1] : null

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
if (res.status !== 0) {
  // The deploy itself failed — there is no successful build to publish a bundle for.
  process.exit(res.status ?? 1)
}

if (skipBundlePublish) {
  console.error('→ skipping bundle publish (--skip-bundle-publish).')
  process.exit(0)
}

if (!clean) {
  console.error(
    '→ skipping bundle publish: this deploy is not a verified clean release ' +
      `(RELEASE_SHA stamped as '${fullSha}-dirty') — publish-pot-bundle.mjs would refuse it ` +
      'anyway (it only ever publishes an exact HEAD commit from a clean tree).',
  )
  process.exit(0)
}

const publishArgs = ['scripts/publish-pot-bundle.mjs', '--release-sha', fullSha]
if (configPath) publishArgs.push('--config', configPath)
console.error(`→ deploy succeeded — publishing the bundle: node ${publishArgs.join(' ')}`)
const publish = spawnSync('node', publishArgs, { stdio: 'inherit' })
if (publish.status !== 0) {
  const retryCmd = `node scripts/publish-pot-bundle.mjs --release-sha ${fullSha}${configPath ? ` --config ${configPath}` : ''}`
  console.error(
    '✘ the deploy itself succeeded, but publishing its bundle to R2 FAILED (see output ' +
      'above) — this deploy is NOT reporting success, because a tenant provisioned right ' +
      `now would get this RELEASE_SHA's bundle from nowhere. Re-run \`${retryCmd}\` once ` +
      'fixed, or pass --skip-bundle-publish if this deploy target deliberately has no ' +
      'bundle bucket wired up.',
  )
  process.exit(publish.status ?? 1)
}
process.exit(0)
