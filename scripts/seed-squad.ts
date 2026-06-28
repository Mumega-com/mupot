// scripts/seed-squad.ts — apply-gated squad seed (S196 Slice A).
//
// APPLY-GATED: this script is NEVER run automatically. Invoke explicitly:
//   npx wrangler d1 execute mupot --local --command "SELECT 1"  # verify local D1
//   # Then via a wrangler script or custom deploy step that calls seedSquadMembers()
//
// The prod seed (Hadi go required) runs via:
//   npx wrangler d1 execute mupot --remote \
//     --command "INSERT OR IGNORE INTO members ..." (generated from seedSquadMembers)
//
// This file is a reference entrypoint for local testing only.
// Do NOT deploy this as a Worker — it is a utility script.
//
// Usage (local):
//   SQUAD_ID=<optional-squad-uuid> npx tsx scripts/seed-squad.ts

import { seedSquadMembers } from '../src/members/squad-seed'
import type { Env } from '../src/types'

// This script is for documentation + local dry-run generation only.
// The actual prod seed requires Hadi's direct go and is applied via
// wrangler d1 execute with the generated SQL (INSERT OR IGNORE statements).

const squadId = process.env['SQUAD_ID'] ?? null

console.log('Squad seed definitions (S196 Slice A):')
console.log(`Squad scope: ${squadId ?? '(org scope fallback — no squadId provided)'}`)
console.log('')
console.log('This script documents the seed payload. To apply:')
console.log('  - Local: npm run migrate:local then call seedSquadMembers via a test')
console.log('  - Prod:  Hadi go required. Apply via wrangler d1 execute --remote')
console.log('')
console.log('Apply-gated steps (NOT done in this branch — await Hadi go):')
console.log('  1. wrangler d1 migrations apply mupot --remote (ensure schema is current)')
console.log('  2. Call seedSquadMembers(env, squadId?) via a Worker script endpoint')
console.log('     OR generate SQL from deterministicMemberId() and apply via wrangler d1 execute')
console.log('  3. Verify: SELECT id, email, display_name FROM members;')
console.log('             SELECT member_id, scope_type, scope_id, capability FROM capabilities;')

// Type annotation to satisfy TypeScript — this script is not run as a Worker
const _unused: typeof seedSquadMembers = seedSquadMembers
const _unusedEnv: Env | null = null
void _unusedEnv
