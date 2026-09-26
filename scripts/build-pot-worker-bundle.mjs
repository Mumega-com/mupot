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
//   node scripts/build-pot-worker-bundle.mjs [--outdir <dir>] [--config <wrangler.toml>]
//
// ONLY `--outdir <dir>` and a `--config`/`-c <file>` (or `--config=<file>`) are accepted —
// ANYTHING else is refused outright, never forwarded. Two reasons this is an allowlist and
// not "forward everything to wrangler" (which an earlier version of this script did):
// (1) Kasra-core round-2 finding (2026-09-22): forwarding arbitrary argv to
// `wrangler deploy --dry-run` means a caller-supplied `--dry-run=false` (or any flag this
// script doesn't know about) could turn a documented no-network dry-run build into a REAL
// deploy — exactly the "must not touch live Cloudflare" boundary this script exists to
// hold. (2) `--config` needed the SAME three-spelling recognition
// (`scripts/lib/wrangler-config-arg.mjs`) scripts/deploy.mjs uses, so a multi-tenant
// colony's `-c wrangler.acme.toml` or `--config=wrangler.acme.toml` deploy builds its OWN
// bundle here too, not the default config's.
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
import { matchConfigFlag } from './lib/wrangler-config-arg.mjs'

const args = process.argv.slice(2)
let outdir = null
let configPath = null
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--outdir') {
    const value = args[i + 1]
    // mupot#1524 round-2 P2-2: a value that itself starts with `-` is refused as a
    // likely-missing-value (e.g. `--outdir --x`) rather than accepted as a literal
    // directory named `--x` — the same discipline `matchConfigFlag` now applies to
    // `--config`/`-c` (scripts/lib/wrangler-config-arg.mjs), for the same reason: a flag
    // silently absorbed as another flag's value can turn a documented no-network
    // dry-run build into something else this script never validated.
    if (typeof value !== 'string' || value.startsWith('-')) {
      console.error('✘ --outdir requires a value (got none, or a value starting with "-", which is refused as a likely flag).')
      process.exit(1)
    }
    outdir = value
    i++
    continue
  }
  const configMatch = matchConfigFlag(args, i)
  if (configMatch) {
    configPath = configMatch.value
    i += configMatch.consumed - 1
    continue
  }
  console.error(
    `✘ unrecognized argument '${a}' — this script accepts ONLY --outdir <dir> and ` +
      '--config/-c <file> (or --config=<file>); nothing else is forwarded to wrangler.',
  )
  process.exit(1)
}
if (!outdir) outdir = mkdtempSync(join(tmpdir(), 'mupot-pot-bundle-'))
const forwardedArgs = configPath ? ['--config', configPath] : []

const res = spawnSync('npx', ['wrangler', 'deploy', '--dry-run', '--outdir', outdir, ...forwardedArgs], { stdio: 'inherit' })
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
