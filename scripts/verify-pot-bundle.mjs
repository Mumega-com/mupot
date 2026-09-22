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
// Requires CLOUDFLARE_ACCOUNT_ID plus the SAME dedicated, bucket-scoped R2 credential pair
// scripts/publish-pot-bundle.mjs uses — R2_POT_BUNDLES_ACCESS_KEY_ID and
// R2_POT_BUNDLES_SECRET_ACCESS_KEY. Deliberately NOT CLOUDFLARE_API_TOKEN — see
// scripts/lib/pot-bundle-r2.mjs's header for why.
//
// Read-only — unlike publish-pot-bundle.mjs this does not touch the local working tree at
// all (no dirty-tree/HEAD-match check): it verifies whatever RELEASE_SHA is asked for,
// which may be the current HEAD, a past release, or a release built on a different
// machine entirely.
//
// Exit 0 + prints a `{"ok":true,"key","sha256","size","timestamp"}` receipt on a verified
// match. Exit 1 + a `{"ok":false,"reason":...}` receipt on any failure (missing object,
// missing metadata, digest mismatch, transport error) — never a silent "looks fine" for a
// 200 that merely proves the bytes were readable.
//
// The printed receipt NEVER includes `bucket`, `url`, or any other value that can trace
// back to an environment variable (CodeQL js/clear-text-logging, 2026-09-22 — this file
// used to blindly print the full result object, which carried a `CLOUDFLARE_ACCOUNT_ID`-
// derived URL) — see `buildVerifyReceipt` in scripts/lib/pot-bundle-r2.mjs for the exact
// allow-list.

import { readR2PotBundlesCredentials, verifyPotWorkerBundleObject, buildVerifyReceipt, POT_WORKER_BUNDLE_R2_BUCKET_DEFAULT } from './lib/pot-bundle-r2.mjs'

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

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  if (!accountId || !accountId.trim()) {
    console.error('✘ CLOUDFLARE_ACCOUNT_ID is not set in the environment.')
    process.exit(1)
  }
  const bucket = opts.bucket || process.env.POT_WORKER_BUNDLE_R2_BUCKET || POT_WORKER_BUNDLE_R2_BUCKET_DEFAULT

  let creds
  try {
    creds = readR2PotBundlesCredentials()
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

  console.log(JSON.stringify(buildVerifyReceipt(result)))
  process.exit(result.ok ? 0 : 1)
}

main().catch((err) => {
  console.log(JSON.stringify({ ok: false, reason: `internal error: ${err instanceof Error ? err.message : String(err)}` }))
  process.exit(1)
})
