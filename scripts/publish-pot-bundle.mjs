#!/usr/bin/env node
// scripts/publish-pot-bundle.mjs — the R2-publish half of bundle option B
// (docs/workflows/tenant-provision.md "Bundle source trade-off" / "CI publish output
// contract"). Builds THIS worker's own bundle via scripts/build-pot-worker-bundle.mjs,
// computes its sha256, and PUTs it to the `mupot-pot-bundles` R2 bucket at
// `${RELEASE_SHA}/worker.js` with the EXACT custom-metadata contract
// `loadPotWorkerBundle` (src/pots/service.ts) verifies against before trusting an R2
// bundle for a real tenant deploy.
//
//   node scripts/publish-pot-bundle.mjs [--config <wrangler.toml>] [--release-sha <sha>]
//                                       [--bucket <name>] [--outdir <dir>]
//
// Requires CLOUDFLARE_ACCOUNT_ID (the same variable `wrangler deploy` itself already reads)
// PLUS a DEDICATED, bucket-scoped R2 credential pair — R2_POT_BUNDLES_ACCESS_KEY_ID and
// R2_POT_BUNDLES_SECRET_ACCESS_KEY — in the environment. Deliberately NOT
// CLOUDFLARE_API_TOKEN: see scripts/lib/pot-bundle-r2.mjs's header and
// docs/workflows/tenant-provision.md "Minting the R2 credential pair" for why (Athena
// round-1 ruling, 2026-09-22) and exactly how an operator mints and stores the pair.
// Neither credential value ever appears in argv or in any printed/logged output — a
// missing/blank var is refused by NAME only, before the bundle is even built.
//
// Refuses to publish from a dirty working tree, or when --release-sha/RELEASE_SHA does not
// exactly match `git rev-parse HEAD` — the same discipline scripts/deploy.mjs applies
// before it will stamp a build (see assertPublishPreconditions in
// scripts/lib/pot-bundle-r2.mjs for why: the object's key IS a claim about which commit
// built it, and that claim must be provably true before anything is written).
//
// Idempotent for the SAME bytes: re-publishing the same RELEASE_SHA with an unchanged tree
// re-builds and re-PUTs, and a conditional write (If-None-Match) treats a matching existing
// digest as success — safe to re-run after a transient failure. NOT idempotent across
// DIFFERENT bytes under the same RELEASE_SHA — that is refused outright
// (`bundle_sha_conflict`, exit 1) rather than silently overwritten, since a published
// commit's bundle must be immutable (see scripts/lib/pot-bundle-r2.mjs's
// putPotWorkerBundleObject for the exact mechanism).

import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  POT_WORKER_BUNDLE_R2_BUCKET_DEFAULT,
  assertPublishPreconditions,
  readR2PotBundlesCredentials,
  putPotWorkerBundleObject,
} from './lib/pot-bundle-r2.mjs'
import { matchConfigFlag } from './lib/wrangler-config-arg.mjs'

function capture(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  return (r.stdout || '').trim()
}

function parseArgs(argv) {
  const opts = { config: null, releaseSha: null, bucket: null, outdir: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const configMatch = matchConfigFlag(argv, i)
    if (configMatch) {
      opts.config = configMatch.value
      i += configMatch.consumed - 1
      continue
    }
    if (a === '--release-sha') opts.releaseSha = argv[++i]
    else if (a === '--bucket') opts.bucket = argv[++i]
    else if (a === '--outdir') opts.outdir = argv[++i]
    else {
      console.error(`✘ unrecognized argument '${a}'`)
      process.exit(1)
    }
  }
  return opts
}

/** Reads the built bundle file directly out of `outdir` — a directory THIS script always
 *  controls (either caller-supplied via --outdir, or a fresh mkdtemp it owns) — rather than
 *  trusting the last line of the build subprocess's stdout to be the path (Kasra-core
 *  round-2 finding, 2026-09-22: fragile if that script's stdout contract ever changes, and
 *  strictly redundant work when the real answer is "list the directory I told it to write
 *  to"). Mirrors scripts/build-pot-worker-bundle.mjs's own single-.js-file assumption. */
function readBuiltBundle(outdir) {
  const jsFiles = readdirSync(outdir).filter((f) => f.endsWith('.js'))
  if (jsFiles.length === 0) {
    console.error(`✘ no .js bundle found in ${outdir} after the build step.`)
    process.exit(1)
  }
  if (jsFiles.length > 1) {
    console.error(
      `⚠ ${jsFiles.length} .js files in ${outdir} (multi-module build) — using '${jsFiles[0]}'; ` +
        'inspect the directory if this is not the right one.',
    )
  }
  return readFileSync(join(outdir, jsFiles[0]), 'utf8')
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))

  const dirty = capture('git', ['status', '--porcelain']).length > 0
  const headSha = capture('git', ['rev-parse', 'HEAD'])
  const releaseSha = opts.releaseSha || process.env.RELEASE_SHA || headSha

  try {
    assertPublishPreconditions({ dirty, headSha, releaseSha })
  } catch (err) {
    console.error(`✘ ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  if (!accountId || !accountId.trim()) {
    console.error('✘ CLOUDFLARE_ACCOUNT_ID is not set in the environment.')
    process.exit(1)
  }

  // No network call has happened yet — checked before even building the bundle, so a
  // missing credential fails fast with zero wasted work (same "resolve the source before
  // doing anything billable" discipline provisionSovereignPot's own ENABLEMENT GATE uses).
  let creds
  try {
    creds = readR2PotBundlesCredentials()
  } catch (err) {
    console.error(`✘ ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  const bucket = opts.bucket || process.env.POT_WORKER_BUNDLE_R2_BUCKET || POT_WORKER_BUNDLE_R2_BUCKET_DEFAULT

  const outdir = opts.outdir || mkdtempSync(join(tmpdir(), 'mupot-pot-bundle-publish-'))
  const buildArgs = ['scripts/build-pot-worker-bundle.mjs', '--outdir', outdir]
  if (opts.config) buildArgs.push('--config', opts.config)
  console.error(`→ building bundle via: node ${buildArgs.join(' ')}`)
  const build = spawnSync('node', buildArgs, { stdio: 'inherit' })
  if (build.status !== 0) {
    console.error('✘ scripts/build-pot-worker-bundle.mjs failed — see output above.')
    process.exit(build.status ?? 1)
  }
  const bodyText = readBuiltBundle(outdir)

  console.error(`→ publishing to r2://${bucket}/${releaseSha}/worker.js ...`)
  let receipt
  try {
    receipt = await putPotWorkerBundleObject({
      accountId,
      bucket,
      releaseSha,
      bodyText,
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
    })
  } catch (err) {
    if (err && err.code === 'bundle_sha_conflict') {
      console.error(
        `✘ ${err.message} Existing: ${err.existingSha256 ?? 'unreadable'}. Attempted: ${err.attemptedSha256}. ` +
          'This is refused, not overwritten — a published RELEASE_SHA bundle is immutable.',
      )
      process.exit(1)
    }
    console.error(`✘ ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  console.log(
    JSON.stringify({
      ok: true,
      bucket: receipt.bucket,
      key: receipt.key,
      sha256: receipt.sha256,
      size: receipt.size,
      already_published: receipt.alreadyPublished,
    }),
  )
}

main().catch((err) => {
  console.error(`✘ internal error: ${err instanceof Error ? err.stack || err.message : String(err)}`)
  process.exit(1)
})
