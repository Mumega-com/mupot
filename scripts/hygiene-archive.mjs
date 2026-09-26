#!/usr/bin/env node
// scripts/hygiene-archive.mjs — receipted archive/unarchive CLI (mupot#1496).
//
// Calls the live pot's REST actions surface (POST /actions/archive_row,
// /actions/unarchive_row, /actions/archive_plan_expand) with a bearer read
// from a token file — never printed, never placed in argv.
//
// Usage:
//   node scripts/hygiene-archive.mjs --plan plan.json                # plan mode (default)
//   node scripts/hygiene-archive.mjs --plan plan.json --apply         # apply mode
//   node scripts/hygiene-archive.mjs --plan plan.json --apply --unarchive
//
// plan.json is a JSON array of entries, either:
//   { "table": "members"|"agents"|"squads"|"projects"|"tasks", "id": "<id>", "reason": "<reason>" }
// or, tasks-only, a bulk filter that expands server-side via archive_plan_expand:
//   { "table": "tasks", "where": { "status": ["open","in_progress"], "created_before": "2026-09-12", "project_ids": [...] }, "reason": "<reason>" }
// A `where` entry has NO `id` — it is expanded to one entry per matching task id
// before anything is applied. `reason` is required on every entry (literal or where-shaped).
//
// Env:
//   MUPOT_BASE_URL     default https://mupot.mumega.com
//   MUPOT_TOKEN_FILE   required — path to a file containing the bearer token (no default;
//                      refuses to guess a path for a credential this sensitive)
//   REVOKE             "1" to pass revoke:true on every members/agents archive_row call
//                      (only meaningful with --apply; plan mode never touches state)

import { readFileSync } from 'node:fs'

const MUPOT_BASE_URL = (process.env.MUPOT_BASE_URL || 'https://mupot.mumega.com').replace(/\/+$/, '')
const TOKEN_FILE = process.env.MUPOT_TOKEN_FILE
const REVOKE = process.env.REVOKE === '1'

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const UNARCHIVE = args.includes('--unarchive')
const planIdx = args.indexOf('--plan')
const planPath = planIdx !== -1 ? args[planIdx + 1] : null

function usageError(message) {
  console.error(`hygiene-archive: ${message}`)
  console.error('Usage: node scripts/hygiene-archive.mjs --plan <plan.json> [--apply] [--unarchive]')
  process.exitCode = 1
  return null
}

function loadToken() {
  if (!TOKEN_FILE) {
    usageError('MUPOT_TOKEN_FILE is required (no default — refusing to guess a path for a bearer credential)')
    return null
  }
  try {
    return readFileSync(TOKEN_FILE, 'utf8').trim()
  } catch (err) {
    console.error(`hygiene-archive: could not read MUPOT_TOKEN_FILE (${TOKEN_FILE}): ${err.message}`)
    return null
  }
}

async function callAction(token, tool, args) {
  const res = await fetch(`${MUPOT_BASE_URL}/actions/${tool}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'hygiene-archive-cli/1.0 (+mupot#1496)',
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(30_000),
  })
  const payload = await res.json().catch(() => ({}))
  return { httpStatus: res.status, ...payload }
}

/** Expand a JSON plan entry into one or more concrete {table,id,reason} rows.
 *  A `where`-shaped tasks entry calls archive_plan_expand (read-only) and
 *  fans out to one entry per matching id — this never mutates anything by
 *  itself, in EITHER plan or apply mode; only the subsequent per-id
 *  archive_row/unarchive_row calls (apply mode only) write anything. */
async function expandPlan(token, rawPlan) {
  const expanded = []
  for (const entry of rawPlan) {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`invalid plan entry: ${JSON.stringify(entry)}`)
    }
    if (!entry.reason || typeof entry.reason !== 'string') {
      throw new Error(`plan entry missing reason: ${JSON.stringify(entry)}`)
    }
    if (entry.where) {
      if (entry.table !== 'tasks') {
        throw new Error(`plan entry has a 'where' filter but table is not 'tasks': ${JSON.stringify(entry)}`)
      }
      const result = await callAction(token, 'archive_plan_expand', { table: 'tasks', where: entry.where })
      if (!result.ok) {
        throw new Error(`archive_plan_expand failed: ${JSON.stringify(result)}`)
      }
      const { ids } = result.result
      console.log(`plan: 'where' filter on tasks expanded to ${ids.length} id(s): ${JSON.stringify(ids)}`)
      for (const id of ids) expanded.push({ table: 'tasks', id, reason: entry.reason })
    } else {
      if (!entry.table || !entry.id) {
        throw new Error(`plan entry missing table/id: ${JSON.stringify(entry)}`)
      }
      expanded.push({ table: entry.table, id: entry.id, reason: entry.reason })
    }
  }
  return expanded
}

async function main() {
  if (!planPath) return usageError('--plan <file.json> is required')
  const token = loadToken()
  if (!token) return

  let rawPlan
  try {
    rawPlan = JSON.parse(readFileSync(planPath, 'utf8'))
  } catch (err) {
    console.error(`hygiene-archive: could not read/parse plan file (${planPath}): ${err.message}`)
    process.exitCode = 1
    return
  }
  if (!Array.isArray(rawPlan)) {
    console.error('hygiene-archive: plan file must be a JSON array')
    process.exitCode = 1
    return
  }

  const entries = await expandPlan(token, rawPlan)
  console.log(`plan: ${entries.length} row(s) to ${UNARCHIVE ? 'unarchive' : 'archive'}`)
  for (const e of entries) console.log(`  - ${e.table}/${e.id}: ${e.reason}`)

  if (!APPLY) {
    console.log('\nplan mode only — nothing written. Re-run with --apply to execute.')
    return
  }

  const tool = UNARCHIVE ? 'unarchive_row' : 'archive_row'
  let ok = 0
  let failed = 0
  for (const e of entries) {
    const callArgs = { table: e.table, id: e.id, reason: e.reason }
    if (!UNARCHIVE && REVOKE && (e.table === 'members' || e.table === 'agents')) callArgs.revoke = true
    const result = await callAction(token, tool, callArgs)
    if (result.ok) {
      ok += 1
      console.log(`OK   ${e.table}/${e.id}: ${JSON.stringify(result.result)}`)
    } else {
      failed += 1
      console.error(`FAIL ${e.table}/${e.id}: ${JSON.stringify({ error: result.error, detail: result.detail })}`)
    }
  }
  console.log(`\napply complete: ${ok} ok, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

try {
  await main()
} catch (err) {
  console.error(`hygiene-archive: ${err.message}`)
  process.exitCode = 1
}
