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
// Requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment — the SAME
// two variables `wrangler deploy` itself already reads for authentication, so a real
// deploy's environment needs nothing new. The token value NEVER appears in argv or in any
// printed/logged output — see scripts/lib/pot-bundle-r2.mjs's header for exactly how it is
// used (only ever passed as a fetch Authorization header or hashed in memory).
//
// Refuses to publish from a dirty working tree, or when --release-sha/RELEASE_SHA does not
// exactly match `git rev-parse HEAD` — the same discipline scripts/deploy.mjs applies
// before it will stamp a build (see assertPublishPreconditions in
// scripts/lib/pot-bundle-r2.mjs for why: the object's key IS a claim about which commit
// built it, and that claim must be provably true before anything is written).
//
// Idempotent: re-publishing the same RELEASE_SHA re-builds and re-PUTs (S3 PUT-by-key is
// an overwrite by construction) — safe to re-run after a transient failure.

import { spawnSync } from 'node:child_process'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  POT_WORKER_BUNDLE_R2_BUCKET_DEFAULT,
  assertPublishPreconditions,
  deriveR2S3Credentials,
  putPotWorkerBundleObject,
} from './lib/pot-bundle-r2.mjs'

function capture(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  return (r.stdout || '').trim()
}

function parseArgs(argv) {
  const opts = { config: null, releaseSha: null, bucket: null, outdir: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--config') opts.config = argv[++i]
    else if (a === '--release-sha') opts.releaseSha = argv[++i]
    else if (a === '--bucket') opts.bucket = argv[++i]
    else if (a === '--outdir') opts.outdir = argv[++i]
    else {
      console.error(`✘ unrecognized argument '${a}'`)
      process.exit(1)
    }
  }
  return opts
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

  const apiToken = process.env.CLOUDFLARE_API_TOKEN
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  if (!apiToken || !apiToken.trim()) {
    console.error('✘ CLOUDFLARE_API_TOKEN is not set in the environment.')
    process.exit(1)
  }
  if (!accountId || !accountId.trim()) {
    console.error('✘ CLOUDFLARE_ACCOUNT_ID is not set in the environment.')
    process.exit(1)
  }
  const bucket = opts.bucket || process.env.POT_WORKER_BUNDLE_R2_BUCKET || POT_WORKER_BUNDLE_R2_BUCKET_DEFAULT

  const outdir = opts.outdir || mkdtempSync(join(tmpdir(), 'mupot-pot-bundle-publish-'))
  const buildArgs = ['scripts/build-pot-worker-bundle.mjs', '--outdir', outdir]
  if (opts.config) buildArgs.push('--config', opts.config)
  console.error(`→ building bundle via: node ${buildArgs.join(' ')}`)
  const build = spawnSync('node', buildArgs, { encoding: 'utf8' })
  if (build.status !== 0) {
    console.error(build.stderr || '')
    console.error('✘ scripts/build-pot-worker-bundle.mjs failed — see output above.')
    process.exit(build.status ?? 1)
  }
  const bundlePath = build.stdout.trim().split('\n').pop()
  if (!bundlePath) {
    console.error('✘ scripts/build-pot-worker-bundle.mjs printed no bundle path.')
    process.exit(1)
  }
  const bodyText = readFileSync(bundlePath, 'utf8')

  console.error('→ verifying CLOUDFLARE_API_TOKEN and deriving R2 S3 credentials...')
  let creds
  try {
    creds = await deriveR2S3Credentials({ apiToken })
  } catch (err) {
    console.error(`✘ ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

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
    console.error(`✘ ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  console.log(JSON.stringify({ ok: true, bucket: receipt.bucket, key: receipt.key, sha256: receipt.sha256, size: receipt.size }))
}

main().catch((err) => {
  console.error(`✘ internal error: ${err instanceof Error ? err.stack || err.message : String(err)}`)
  process.exit(1)
})
