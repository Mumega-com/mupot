#!/usr/bin/env node
// scripts/cleanup-home-channel-grants.mjs — idempotent data hygiene for FP-01 Slice 1 v2
// (G-FP1b point 4/P0-2, Athena adversarial round 1).
//
// WHY THIS EXISTS
//
// channel_capability_grants is written by src/channels/sync.ts's ensureSquadGrant, which —
// before this fix — could mint a channel-derived grant on a kind='home' squad (an org admin
// bound a channel to someone's home via POST /api/channels/bindings, then every member of
// that channel got a standing `lead`/`member` row on the home). Both the writer
// (ensureSquadGrant) and the binding-creation route (POST /bindings) now refuse a home
// target, and src/auth/capability.ts's resolveCapabilities additionally JOINs squads.kind and
// drops any channel_capability_grants row on a home squad at READ time — so an
// already-poisoned row can no longer resolve as live authority even before this script runs.
//
// This script is the follow-up DATA HYGIENE step: it deletes those now-dead rows outright,
// rather than leaving them to sit inert forever. Not a migration (avoids the #1428/#1458 0156
// migration-numbering collision Athena's review flagged) — a plain idempotent DELETE, safe to
// run zero, one, or many times against any tenant's D1.
//
// USAGE
//   node scripts/cleanup-home-channel-grants.mjs --db <wrangler d1 database name> [--dry-run]
//
// This shells out to `wrangler d1 execute` so it runs against the SAME D1 binding production
// uses — it does not open a second, hand-rolled DB connection.

import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const dbIndex = args.indexOf('--db')
const dbName = dbIndex !== -1 ? args[dbIndex + 1] : null
const remote = args.includes('--remote')

if (!dbName) {
  console.error('Usage: node scripts/cleanup-home-channel-grants.mjs --db <d1-database-name> [--dry-run] [--remote]')
  process.exit(1)
}

const SELECT_SQL = `
  SELECT ccg.id, ccg.member_id, ccg.squad_id, ccg.capability
    FROM channel_capability_grants ccg
    JOIN squads s ON s.id = ccg.squad_id
   WHERE s.kind = 'home';
`.trim()

const DELETE_SQL = `
  DELETE FROM channel_capability_grants
   WHERE id IN (
     SELECT ccg.id
       FROM channel_capability_grants ccg
       JOIN squads s ON s.id = ccg.squad_id
      WHERE s.kind = 'home'
   );
`.trim()

function runD1(sql) {
  const flags = ['d1', 'execute', dbName, '--command', sql, '--json']
  if (remote) flags.push('--remote')
  else flags.push('--local')
  const out = execFileSync('npx', ['wrangler', ...flags], { encoding: 'utf8' })
  return JSON.parse(out)
}

const found = runD1(SELECT_SQL)
const rows = found?.[0]?.results ?? []
console.log(`cleanup-home-channel-grants: ${rows.length} poisoned channel_capability_grants row(s) found on a home squad.`)
for (const row of rows) {
  console.log(`  ${row.id} member=${row.member_id} squad=${row.squad_id} capability=${row.capability}`)
}

if (rows.length === 0) {
  console.log('Nothing to clean up.')
  process.exit(0)
}

if (dryRun) {
  console.log('\n--dry-run: no rows deleted. Re-run without --dry-run to delete them.')
  process.exit(0)
}

runD1(DELETE_SQL)
console.log(`\nDeleted ${rows.length} row(s).`)
