#!/usr/bin/env node
// scripts/check-schema-chain-fresh.mjs — src/pots/schema-chain.generated.ts must be exactly
// what scripts/gen-schema-chain.mjs would produce from the CURRENT migrations/*.sql.
//
// WHY THIS EXISTS
//
// The schema chain (mupot#1285 Tier C slice 1) is baked into the deployed bundle at build
// time because a Worker cannot read migrations/*.sql off disk at request time. That baking
// step can drift the instant someone adds a migration without regenerating: the deployed
// chain would then be missing the new file, and a freshly provisioned Tier C pot would get a
// D1 schema silently short one migration — the exact "correct on the day it's written, rots
// on the next unrelated commit" shape check-test-schema-source.mjs and
// check-migration-numbering.mjs both exist to close for their own surfaces. This is the same
// discipline for the schema chain: a hard gate, no baseline, because the file did not exist
// before this change — there is no pre-existing-offender population to grandfather.
//
// THE CHECK
//
// Call the SAME pure `generateSchemaChainModule()` the generator's CLI uses to write the
// file, and string-compare it against what is currently on disk. No `git diff`, no
// subprocess, no filesystem write from this script — deliberately, so
// tests/check-schema-chain-fresh.test.mjs can drive `checkSchemaChainFresh` with synthetic
// "generated" and "current" strings and exercise both the fresh and stale paths without ever
// touching a real file or a real migrations directory.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { generateSchemaChainModule, DEFAULT_OUTPUT_FILE } from './gen-schema-chain.mjs'

/**
 * Pure comparison: does `currentContent` match what `generate()` produces right now?
 * Returns a result object rather than throwing, so callers (CLI here, tests elsewhere) can
 * decide how to report it.
 */
export function checkSchemaChainFresh(generate, currentContent) {
  const fresh = generate()
  if (fresh === currentContent) {
    return { ok: true, fresh }
  }
  return { ok: false, fresh, current: currentContent, firstDiffLine: firstDifferingLine(fresh, currentContent) }
}

function firstDifferingLine(a, b) {
  const linesA = a.split('\n')
  const linesB = b.split('\n')
  const max = Math.max(linesA.length, linesB.length)
  for (let i = 0; i < max; i += 1) {
    if (linesA[i] !== linesB[i]) return i + 1
  }
  return null
}

function readCurrent(outputFile) {
  try {
    return readFileSync(outputFile, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

function runCli() {
  const outputFile = DEFAULT_OUTPUT_FILE
  const current = readCurrent(outputFile)
  if (current === null) {
    console.error(`Guard — schema chain: ${outputFile} does not exist.`)
    console.error('Run `npm run gen:schema-chain` and commit the result.')
    process.exit(1)
  }

  const result = checkSchemaChainFresh(generateSchemaChainModule, current)
  if (result.ok) {
    console.log(`Guard — schema chain: ${outputFile} is fresh.`)
    process.exit(0)
  }

  console.error(`Guard — schema chain: ${outputFile} is STALE.`)
  console.error(
    'It does not match what `scripts/gen-schema-chain.mjs` produces from the current migrations/*.sql.',
  )
  console.error(`First differing line: ${result.firstDiffLine ?? '(length differs)'}`)
  console.error('')
  console.error('Fix: run `npm run gen:schema-chain` and commit the regenerated file.')
  process.exit(1)
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  runCli()
}
