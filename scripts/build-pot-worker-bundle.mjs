#!/usr/bin/env node
// scripts/build-pot-worker-bundle.mjs — produce the tenant-pot worker bundle text
// (mupot#1285 requirement 3) WITHOUT deploying anything.
//
// `provisionSovereignPot` needs the running Worker's own built bundle to upload into the
// `mupot-pots` dispatch namespace for a new tenant. Three options were on the table (full
// trade-off in docs/workflows/tenant-provision.md); this script is the tooling for option C
// (explicit `worker_js_code`) AND the first half of option B (CI-published R2 artifact) —
// both need the SAME built bundle text, this script just produces it.
//
//   node scripts/build-pot-worker-bundle.mjs [--outdir <dir>]
//
// Prints the built worker.js path to stdout. Uses `wrangler deploy --dry-run --outdir` —
// dry-run means wrangler builds the bundle and writes it to disk WITHOUT calling the
// Cloudflare API at all (no deploy, no auth required beyond what `wrangler.toml` needs to
// parse). This is why it is safe to run in a session that must not touch live Cloudflare
// resources: `--dry-run` is documented by Cloudflare to skip the upload step entirely.
//
// NOT YET WIRED INTO CI. Today this is a manual/local tool: run it, then pass the printed
// file's contents as `worker_js_code` (MCP `pot_provision` tool) or `body.worker_js_code`
// (POST /api/pots/provision). The R2-publish half of option B (a deploy-time CI step that
// runs this script and PUTs the result to POT_WORKER_BUNDLE_BUCKET keyed by RELEASE_SHA)
// is a follow-up, not built in this PR — see docs/workflows/tenant-provision.md.
//
// UNTESTED IN THIS SESSION: this session has no wrangler.toml (gitignored per
// docs/deploy) and is barred from touching Cloudflare, so `wrangler deploy --dry-run`
// was not actually run here. The command is Cloudflare's documented dry-run/outdir
// contract (developers.cloudflare.com/workers/wrangler/commands/#deploy) — Kasra-core
// should smoke-test this script for real once a wrangler.toml + token are available.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const outdirFlagIndex = args.indexOf('--outdir')
const outdir = outdirFlagIndex >= 0 ? args[outdirFlagIndex + 1] : mkdtempSync(join(tmpdir(), 'mupot-pot-bundle-'))

const res = spawnSync('npx', ['wrangler', 'deploy', '--dry-run', '--outdir', outdir], { stdio: 'inherit' })
if (res.status !== 0) {
  console.error('✘ wrangler dry-run build failed — see output above.')
  process.exit(res.status ?? 1)
}

const jsFiles = readdirSync(outdir).filter((f) => f.endsWith('.js'))
if (jsFiles.length === 0) {
  console.error(`✘ no .js bundle found in ${outdir} after dry-run build.`)
  process.exit(1)
}
if (jsFiles.length > 1) {
  console.error(
    `⚠ ${jsFiles.length} .js files in ${outdir} (multi-module build) — ` +
      'this script assumes a single-file bundle. Inspect the directory and wire the ' +
      'right file(s) explicitly before using this in CI.',
  )
}

const bundlePath = join(outdir, jsFiles[0])
// Touch the file once so a caller piping this script's stdout gets a real byte count sanity
// check, not just a path — a later CI step reads the file itself, not this stdout.
readFileSync(bundlePath)
console.log(bundlePath)
