#!/usr/bin/env node
// scripts/check-operator-counts-source.mjs — Flight-008 Slice 1 (mupot#1060) structural
// gate: no SECOND implementation of the operator hero-KPI aggregations this slice
// consolidated into src/dashboard/operator-counts.ts.
//
// WHY THIS EXISTS
//
// Before this slice, Home (index.ts), Health (health.ts), and the Fleet-presence tab
// each computed "how many agents are live / need a decision" from independently shaped
// queries, and disagreed (documented example: Home 25 agents vs Health 23; Home 127
// decisions vs Health 130 — see agents/river/docs/flight-008-2026-08-15/
// slice-1-canonical-truth.md, mumega.com repo). The concrete bugs were:
//   - health.ts ran its own `SELECT status, COUNT(*) ... FROM agents GROUP BY status`
//     instead of the canonical agent roster read.
//   - health.ts ran its own `SELECT status, COUNT(*) ... FROM tasks GROUP BY status`
//     instead of operator-counts.ts's loadTaskStatusCounts.
//   - index.ts computed `agents.filter((a) => runtimeStates.get(a.id) === 'live').length`
//     inline instead of calling the shared computeOperatorCounts.
//
// A code review can miss a reintroduced copy of one of these (they are innocuous-looking,
// three-line diffs). This script can't. It fails the moment any src/dashboard/*.ts file
// OTHER than operator-counts.ts (and the one documented, differently-scoped exception in
// radar.ts) contains one of these three shapes.
//
// THE RULE: if you need one of these aggregations, import it from operator-counts.ts.
// Do not re-derive it. If a NEW, genuinely different-scoped variant is required (the way
// radar.ts's per-squad live-member tally is), extend ALLOWED below with a one-line reason
// — do not delete or loosen a pattern to make a real duplicate pass.

import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const DASHBOARD_DIR = join(ROOT, 'src', 'dashboard')
const CANONICAL_FILE = 'operator-counts.ts'

const PATTERNS = [
  {
    id: 'agents-group-by-status',
    describe: '"FROM agents" ... "GROUP BY status" (the old health.ts agent-count query)',
    test: (src) => src.includes('FROM agents') && /GROUP\s+BY\s+status/i.test(src),
    allowed: new Set([CANONICAL_FILE]),
  },
  {
    id: 'tasks-group-by-status',
    describe: '"FROM tasks" ... "GROUP BY status" (the old health.ts task-count query; owned by loadTaskStatusCounts)',
    test: (src) => src.includes('FROM tasks') && /GROUP\s+BY\s+status/i.test(src),
    allowed: new Set([CANONICAL_FILE]),
  },
  {
    id: 'inline-live-runtime-filter',
    describe: "\"runtimeStates.get(...) === 'live'\" (a hand-rolled live-agent tally; owned by computeOperatorCounts)",
    test: (src) => /runtimeStates\.get\([^)]*\)\s*===\s*'live'/.test(src),
    // radar.ts's ONE use is a documented, differently-scoped question (per-squad live
    // MEMBER count for that squad's card, not the pot-wide hero KPI) — it still reads
    // the SAME canonical runtimeStates map computeOperatorCounts does, so mutating the
    // classifier still propagates there. See radar.ts's module header.
    allowed: new Set([CANONICAL_FILE, 'radar.ts']),
  },
]

function listDashboardFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...listDashboardFiles(full))
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

/** Pure — no filesystem. Exported so tests can drive it with synthetic content instead of
 *  writing throwaway files (mirrors classify() in check-test-schema-source.mjs). */
export function violationsForFile(basename, src) {
  const hits = []
  for (const pattern of PATTERNS) {
    if (pattern.allowed.has(basename)) continue
    if (pattern.test(src)) hits.push({ pattern: pattern.id, describe: pattern.describe })
  }
  return hits
}

function main() {
  const files = listDashboardFiles(DASHBOARD_DIR)
  const violations = []

  for (const filePath of files) {
    const basename = filePath.split('/').pop()
    const src = readFileSync(filePath, 'utf8')
    for (const hit of violationsForFile(basename, src)) {
      violations.push({ file: relative(ROOT, filePath), ...hit })
    }
  }

  if (violations.length > 0) {
    console.error(`check-operator-counts-source: ${violations.length} second-implementation violation(s) found.\n`)
    for (const v of violations) {
      console.error(`  ${v.file}\n    pattern: ${v.pattern}\n    ${v.describe}\n`)
    }
    console.error('Fix: import the aggregation from src/dashboard/operator-counts.ts instead of re-deriving it.')
    process.exit(1)
  }

  console.log(`check-operator-counts-source: OK (${files.length} src/dashboard/*.ts files scanned, 0 second implementations).`)
}

const RUN_AS_SCRIPT = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (RUN_AS_SCRIPT) main()
