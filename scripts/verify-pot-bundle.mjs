#!/usr/bin/env node
// scripts/verify-pot-bundle.mjs — the operator receipt for scripts/publish-pot-bundle.mjs.
// GETs a previously-published `${RELEASE_SHA}/worker.js` object back from the
// `mupot-pot-bundles` R2 bucket and independently re-verifies its digest against the
// recorded `sha256` custom metadata — exactly the check `loadPotWorkerBundle`
// (src/pots/service.ts) performs before trusting the bundle for a real tenant deploy, run
// here as a standalone confirmation an operator (or CI) can call for any past release.
//
//   node scripts/verify-pot-bundle.mjs <release-sha> [--bucket <name>]
//
// Requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment (same two
// variables scripts/publish-pot-bundle.mjs and `wrangler` itself already read).
//
// Read-only — unlike publish-pot-bundle.mjs this does not touch the local working tree at
// all (no dirty-tree/HEAD-match check): it verifies whatever RELEASE_SHA is asked for,
// which may be the current HEAD, a past release, or a release built on a different
// machine entirely.
//
// Exit 0 + prints a `{"ok":true,...}` receipt on a verified match. Exit 1 + a
// `{"ok":false,"reason":...}` receipt on any failure (missing object, missing metadata,
// digest mismatch, transport error) — never a silent "looks fine" for a 200 that merely
// proves the bytes were readable.

import { deriveR2S3Credentials, verifyPotWorkerBundleObject, POT_WORKER_BUNDLE_R2_BUCKET_DEFAULT } from './lib/pot-bundle-r2.mjs'

function parseArgs(argv) {
  const opts = { releaseSha: null, bucket: null }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--bucket') opts.bucket = argv[++i]
    else positional.push(a)
  }
  opts.releaseSha = positional[0] || null
  return opts
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (!opts.releaseSha) {
    console.error('usage: node scripts/verify-pot-bundle.mjs <release-sha> [--bucket <name>]')
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

  let creds
  try {
    creds = await deriveR2S3Credentials({ apiToken })
  } catch (err) {
    console.log(JSON.stringify({ ok: false, reason: err instanceof Error ? err.message : String(err) }))
    process.exit(1)
  }

  const result = await verifyPotWorkerBundleObject({
    accountId,
    bucket,
    releaseSha: opts.releaseSha,
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
  })

  console.log(JSON.stringify(result))
  process.exit(result.ok ? 0 : 1)
}

main().catch((err) => {
  console.log(JSON.stringify({ ok: false, reason: `internal error: ${err instanceof Error ? err.message : String(err)}` }))
  process.exit(1)
})
