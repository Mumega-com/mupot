#!/usr/bin/env node
// scripts/check-cli-bundle-fresh.mjs - src/cli/bundle.generated.ts must be exactly what
// scripts/gen-cli-bundle.mjs produces from the CURRENT cli/mupot.mjs. Otherwise GET /cli
// would serve stale bytes while the repo shows a newer CLI.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DEFAULT_OUTPUT_FILE, generateCliBundleModule, readCliSource } from './gen-cli-bundle.mjs'

export function checkCliBundleFresh() {
  const fresh = generateCliBundleModule(readCliSource())
  let current = null
  try { current = readFileSync(DEFAULT_OUTPUT_FILE, 'utf8') } catch (e) { if (!e || e.code !== 'ENOENT') throw e }
  return { ok: fresh === current, missing: current === null }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = checkCliBundleFresh()
  if (!r.ok) {
    process.stderr.write(`src/cli/bundle.generated.ts is ${r.missing ? 'missing' : 'stale'}: run \`npm run gen:cli-bundle\` and commit it.\n`)
    process.exit(1)
  }
  process.stdout.write('cli bundle is fresh\n')
}
