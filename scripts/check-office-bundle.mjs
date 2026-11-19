#!/usr/bin/env node
// check-office-bundle — fail if the built project-office Worker bundle (or its sourcemap)
// contains the build-toolchain packages behind the picomatch advisory.
//
// WHY THIS EXISTS: the project-office PRODUCTION audit once exempted picomatch
// GHSA-fc5q-39xc-vjpf (exemption since removed) only because picomatch (reached via
// agents -> vite / @rolldown/plugin-babel -> tinyglobby -> fdir) is build-time and never
// ships. That claim is the sole reason the prod exemption is allowed, so CI must prove it
// on every build instead of trusting a comment.
//
// Usage: node scripts/check-office-bundle.mjs <outdir from `wrangler deploy --dry-run --outdir`>
import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FORBIDDEN = ['picomatch', 'vite', 'tinyglobby', 'fdir', '@rolldown']

// Match the package name as a whole token, not a substring: bare `vite` is inside
// `invite` (a MIME type in the bundle), which is not the package.
const wordRe = (term) => new RegExp(`(?<![\\w@-])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`)

/** Returns [{ file, term }] for every forbidden term found in a bundle file. */
export function scanBundle(files) {
  const hits = []
  for (const [file, text] of files) {
    for (const term of FORBIDDEN) if (wordRe(term).test(text)) hits.push({ file, term })
  }
  return hits
}

function main() {
  const dir = process.argv[2]
  if (!dir) { console.error('usage: check-office-bundle.mjs <outdir>'); return 1 }
  let names
  try {
    names = readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => relative(dir, join(e.parentPath, e.name)))
  } catch (err) {
    console.error(`✗ check-office-bundle: cannot read ${dir}: ${err.message}`); return 1
  }
  // Fail closed: the check is meaningless if the bundle or its map was not produced.
  for (const need of ['index.js', 'index.js.map']) {
    if (!names.includes(need)) { console.error(`✗ check-office-bundle: ${need} not found in ${dir}`); return 1 }
  }
  // Scan EVERY emitted file (recursively) except wrangler's README.md.
  const hits = scanBundle(names.filter((n) => n !== 'README.md')
    .map((n) => [n, readFileSync(join(dir, n), 'utf8')]))
  if (hits.length > 0) {
    for (const h of hits) console.error(`✗ check-office-bundle: ${h.file} contains "${h.term}"`)
    console.error('  The picomatch exemption assumes the toolchain is not in the bundle. See issue #2453.')
    return 1
  }
  console.log(`✓ check-office-bundle: no ${FORBIDDEN.join('/')} in any emitted file`)
  return 0
}

// Fail-closed entry guard: compare real paths so symlinks and spaces still run main().
function isEntryPoint() {
  if (!process.argv[1]) return false
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1])) } catch { return false }
}
if (isEntryPoint()) process.exit(main())
