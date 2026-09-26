#!/usr/bin/env node
// scripts/hygiene-archive.mjs — receipted archive/unarchive CLI (mupot#1496).
//
// Calls the live pot's REST actions surface (POST /actions/archive_row,
// /actions/unarchive_row, /actions/archive_plan_expand) with a bearer read
// from a token file — never printed, never placed in argv.
//
// NOTE: archive_row/unarchive_row/archive_plan_expand all refuse an
// agent-bound bearer (operator_principal_required) — this CLI needs an
// UNBOUND org-admin bearer or an operator dashboard session token. An
// agent's own welded credential (e.g. a Kasra seat token) cannot apply a plan.
//
// TWO-STEP WORKFLOW (Round 2 / adversarial P1-5): a `where`-shaped bulk entry
// is expanded to a concrete id list ONLY in plan mode (never re-derived at
// apply time — that was the exact bug: a live filter can silently drift
// between "what a human reviewed" and "what actually got archived"). Plan
// mode writes the fully-expanded, literal id list to `<plan>.expanded.json`.
// Apply mode ONLY accepts a plan file whose entries are ALL literal
// {table,id,reason} — it refuses outright if it finds an unexpanded `where`
// entry, rather than silently expanding (and possibly re-matching a
// different set of rows) on your behalf.
//
// mupot#1496 Round 3 scope cut: `table: "tasks"` is NOT SUPPORTED — the
// server refuses both archive_row/unarchive_row and archive_plan_expand for
// tasks with 409 not_supported (task archiving needs its own action-boundary
// pass across ~10 task-mutating tools; tracked as
// https://github.com/Mumega-com/mupot/issues/1571). Plan mode refuses any
// `table: "tasks"` entry outright — literal {table,id} or `where`-shaped —
// rather than letting it reach the server only to fail there.
//
// Usage:
//   node scripts/hygiene-archive.mjs --plan plan.json
//     → expands any `where` entries, prints the reviewed id list, writes
//       plan.json.expanded.json. Nothing is archived.
//   node scripts/hygiene-archive.mjs --plan plan.json.expanded.json --apply
//     → applies EXACTLY that file's literal id list. Fails the file outright
//       if it still contains an unexpanded `where` entry.
//   node scripts/hygiene-archive.mjs --plan plan.json.expanded.json --apply --unarchive
//
// plan.json is a JSON array of literal entries:
//   { "table": "members"|"agents"|"squads"|"projects", "id": "<id>", "reason": "<reason>" }
// `reason` is required on every entry. There is currently no bulk/`where`-filter shape —
// that existed only for tasks (see the scope-cut note above) and plan mode now refuses it.
//
// Note: archive_row('members') always suspends + revokes the member's live
// tokens/sessions as part of archiving — there is no revoke flag to pass.
// archive_row('agents') requires the agent already be status=inactive (call
// deactivate_agent first); this CLI does not deactivate on your behalf.
//
// Env:
//   MUPOT_BASE_URL     default https://mupot.mumega.com
//   MUPOT_TOKEN_FILE   required — path to a file containing the bearer token (no default;
//                      refuses to guess a path for a credential this sensitive)

import { readFileSync, writeFileSync } from 'node:fs'

const MUPOT_BASE_URL = (process.env.MUPOT_BASE_URL || 'https://mupot.mumega.com').replace(/\/+$/, '')
const TOKEN_FILE = process.env.MUPOT_TOKEN_FILE

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

/** PLAN MODE ONLY: validates every entry is a literal {table,id,reason} for
 *  a supported table, refusing `table: "tasks"` (either shape) and any
 *  `where`-shaped bulk filter — that shape existed only for tasks, which is
 *  not supported (mupot#1496 Round 3 scope cut, #1571). Named `expandPlan`
 *  for the CLI's two-step workflow shape; there is nothing left to expand
 *  now that the only entries accepted are already literal. */
async function expandPlan(token, rawPlan) {
  const expanded = []
  for (const entry of rawPlan) {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`invalid plan entry: ${JSON.stringify(entry)}`)
    }
    if (!entry.reason || typeof entry.reason !== 'string') {
      throw new Error(`plan entry missing reason: ${JSON.stringify(entry)}`)
    }
    // mupot#1496 Round 3 scope cut / Round 4 (coordinator confirmation-pass
    // finding): task archiving is not supported — refuse HERE, in plan mode,
    // for both shapes (a literal {table:'tasks',id} and a `where`-shaped bulk
    // filter), rather than letting either reach the server only to 409 there.
    // The header used to advertise a tasks-only bulk-filter shape that no
    // longer exists; this is the enforcement half of correcting that.
    if (entry.table === 'tasks') {
      throw new Error(
        `plan entry table 'tasks' is not supported — task archiving was removed from ` +
        `archive_row/unarchive_row/archive_plan_expand in mupot#1496 Round 3 (see ` +
        `https://github.com/Mumega-com/mupot/issues/1571): ${JSON.stringify(entry)}`,
      )
    }
    if (entry.where) {
      throw new Error(
        `plan entry has a 'where' filter, but bulk filters were tasks-only and task ` +
        `archiving is not supported: ${JSON.stringify(entry)}`,
      )
    }
    if (!entry.table || !entry.id) {
      throw new Error(`plan entry missing table/id: ${JSON.stringify(entry)}`)
    }
    expanded.push({ table: entry.table, id: entry.id, reason: entry.reason })
  }
  return expanded
}

/** APPLY MODE ONLY: the plan file must ALREADY be a flat, literal list — no
 *  `where` entries. Applying re-derives NOTHING; it archives/unarchives
 *  exactly the ids on disk. */
function assertFullyExpanded(rawPlan) {
  const unexpanded = rawPlan.filter((e) => e && typeof e === 'object' && e.where)
  if (unexpanded.length > 0) {
    throw new Error(
      `--apply requires a fully-expanded plan (literal {table,id,reason} entries only) — ` +
      `found ${unexpanded.length} unexpanded 'where' entry(ies). Run without --apply first ` +
      `to produce <plan>.expanded.json, review it, then apply THAT file.`,
    )
  }
  for (const entry of rawPlan) {
    if (!entry || typeof entry !== 'object' || !entry.table || !entry.id || !entry.reason) {
      throw new Error(`--apply plan entry missing table/id/reason: ${JSON.stringify(entry)}`)
    }
  }
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

  if (!APPLY) {
    // Plan mode: expand, print, write the reviewed snapshot. Never archives anything.
    const entries = await expandPlan(token, rawPlan)
    console.log(`plan: ${entries.length} row(s) to ${UNARCHIVE ? 'unarchive' : 'archive'}`)
    for (const e of entries) console.log(`  - ${e.table}/${e.id}: ${e.reason}`)
    const expandedPath = `${planPath}.expanded.json`
    writeFileSync(expandedPath, JSON.stringify(entries, null, 2))
    console.log(`\nplan mode only — nothing written. Reviewed id list saved to ${expandedPath}.`)
    console.log(`Re-run with: node scripts/hygiene-archive.mjs --plan ${expandedPath} --apply${UNARCHIVE ? ' --unarchive' : ''}`)
    return
  }

  // Apply mode: the plan file IS the exact, already-reviewed id list. No expansion call.
  assertFullyExpanded(rawPlan)
  const entries = rawPlan

  const tool = UNARCHIVE ? 'unarchive_row' : 'archive_row'
  let ok = 0
  let failed = 0
  for (const e of entries) {
    const callArgs = { table: e.table, id: e.id, reason: e.reason }
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
