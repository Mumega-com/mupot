#!/usr/bin/env node
// Kill-witness pass for the seat-events channel: remove each safety guard, one at a time, and
// require tests/seat-events.test.ts to go red. A guard whose removal no test notices is untested,
// whatever the coverage number says.
//
//   node scripts/kill-witness-seat-events.mjs      # exit status = number of surviving mutations
//
// Mutates files IN PLACE and restores the original bytes in `finally` (and on SIGINT). Run it on
// a clean tree; it refuses when a target file has uncommitted changes it did not make.

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const M = [
  // body leakage
  ['hint allowlist (no spread)', 'src/agents/seat-events.ts', 'return {\n    id: p.message_id,', 'return {\n    ...(p as object),\n    id: p.message_id,'],
  // cross-agent / cross-host
  ['ticket grants only granted agents', 'src/agents/seat-events.ts', 'if (await hostMayReceive(env, host, agent)) granted.push(agent)', 'granted.push(agent)'],
  ['grant is per host', 'src/agents/seat-events.ts', 'WHERE g.tenant = ?1 AND g.host_agent_id = ?2 AND g.agent_id = ?3', 'WHERE g.tenant = ?1 AND ?2 = ?2 AND g.agent_id = ?3'],
  ['publish only to sockets holding the agent', 'src/agents/seat-events.ts', 'if (!st?.agents.includes(hint.to_agent)) continue', 'if (!st) continue'],
  // forged / expired / replayed
  ['signature verified', 'src/agents/seat-events.ts', "if (!valid) return { ok: false, status: 401, error: 'unauthorized' }", ''],
  ['nonce single-use', 'src/agents/seat-events.ts', "if (!fresh) return { ok: false, status: 409, error: 'replay' }", ''],
  ['freshness window', 'src/agents/seat-events.ts', 'if (Math.abs(now - ts) > TICKET_WINDOW_SEC)', 'if (false)'],
  ['tenant bound into signature', 'src/agents/seat-events.ts', '[TICKET_SIG_DOMAIN, p.tenant, p.host_agent_id', '[TICKET_SIG_DOMAIN, p.host_agent_id'],
  ['ticket single-use (delete on take)', 'src/agents/seat-events.ts', 'if (rec) await storage.delete(key)', ''],
  ['ticket expiry', 'src/agents/seat-events.ts', 'if (!rec || rec.expires_at < this.nowSec())', 'if (!rec)'],
  ['expired tickets purged', 'src/agents/seat-events.ts', 'if (dead.length) await storage.delete(dead)', ''],
  // revoked ownership
  ['re-authorize at redeem', 'src/agents/seat-events.ts', 'if (!(await this.authorize(rec.host, agent))) {', 'if (false) {'],
  ['re-authorize every hint', 'src/agents/seat-events.ts', 'if (!(await this.authorize(st.host, hint.to_agent))) {', 'if (false) {'],
  ['host member must be active', 'src/agents/seat-events.ts', "JOIN members m ON m.id = k.member_id AND m.tenant = k.tenant AND m.status = 'active'\n        WHERE g.tenant", 'JOIN members m ON m.id = k.member_id AND m.tenant = k.tenant\n        WHERE g.tenant'],
  // duplicates / catch-up / backpressure
  ['dedup of republished hints', 'src/agents/seat-events.ts', 'if (!this.recent.add(hint.id)) return { sent: 0, duplicate: true, revoked: 0 }', ''],
  ['catch-up honours the cursor', 'src/agents/seat-events.ts', 'AND read_at IS NULL AND seq > ?3\n      ORDER BY seq ASC LIMIT ?4', 'AND read_at IS NULL AND seq > 0 AND ?3 = ?3\n      ORDER BY seq ASC LIMIT ?4'],
  ['catch-up skips read rows', 'src/agents/seat-events.ts', 'WHERE tenant = ?1 AND to_agent = ?2 AND read_at IS NULL AND seq > ?3', 'WHERE tenant = ?1 AND to_agent = ?2 AND seq > ?3'],
  ['backlog cap', 'src/agents/seat-events.ts', 'list.slice(0, BACKLOG_HINT_LIMIT)', 'list'],
  ['agents-per-ticket cap', 'src/agents/seat-events.ts', 'agentsRaw.length > MAX_AGENTS_PER_TICKET', 'false'],
  // dual consumer
  ['one live grant per agent (index)', 'migrations/0176_seat_event_grants.sql', 'CREATE UNIQUE INDEX IF NOT EXISTS idx_seat_event_grants_one_live_host', 'CREATE INDEX IF NOT EXISTS idx_seat_event_grants_one_live_host'],
  ['other authorized host keeps the agent', 'src/agents/seat-events.ts', "if (st.host !== host && (await this.authorize(st.host, agent))) return 'held_by_other_host'", ''],
  ['old socket dropped on supersede/move', 'src/agents/seat-events.ts', '      this.drop(other, st, agent, frame)\n', ''],
  ['legacy stream fenced for granted agents', 'src/agents/inbox-routes.ts', '    if (grant) {', '    if (false) {'],
  // HTTP surface
  ['upgrade strips Authorization/Cookie', 'src/agents/seat-events-routes.ts', "presenceLiveDoUpgradeRequest(new URL('https://seat-events/connect'), c.req.raw)", "new Request('https://seat-events/connect', c.req.raw)"],
  ['ticket response no-store', 'src/agents/seat-events-routes.ts', "const NO_STORE = { 'Cache-Control': 'no-store' }", 'const NO_STORE = {}'],
  ['JSON catch-all, never a redirect', 'src/agents/seat-events-routes.ts', "seatEventsApp.all('*', (c) => c.json({ error: 'not_found' }, 404))", ''],
  ['grants need org admin', 'src/agents/seat-events-routes.ts', "return hasCapability(grants, 'org', null, 'admin') ? { memberId: id.memberId } : null", 'return { memberId: id.memberId }'],
  ['flag gates the channel', 'src/agents/seat-events.ts', 'return env.REALTIME_SEAT_EVENTS === SEAT_EVENTS_FLAG && env.SEAT_EVENTS !== undefined', 'return env.SEAT_EVENTS !== undefined'],
  // consumer
  ['failed publish retries', 'src/bus/consumer.ts', '        throw new Error(`message.created seat hint failed: ${seat.error}`)\n', ''],
]

const dirty = spawnSync('git', ['status', '--porcelain', '--', ...new Set(M.map((m) => m[1]))], { encoding: 'utf8' }).stdout.trim()
if (dirty && !process.env.KILL_WITNESS_ALLOW_DIRTY) {
  console.error('refusing: target files have uncommitted changes (commit first, or set KILL_WITNESS_ALLOW_DIRTY=1):\n' + dirty)
  process.exit(2)
}

let current = null
const restore = () => {
  if (current) writeFileSync(current.file, current.original)
  current = null
}
process.on('SIGINT', () => {
  restore()
  process.exit(130)
})

let survivors = 0
for (const [name, file, from, to] of M) {
  const original = readFileSync(file, 'utf8')
  if (!original.includes(from)) {
    console.log(`??       ${name}: pattern not found in ${file}`)
    survivors++
    continue
  }
  current = { file, original }
  try {
    writeFileSync(file, original.replace(from, to))
    const r = spawnSync('npx', ['vitest', 'run', 'tests/seat-events.test.ts'], { encoding: 'utf8', timeout: 300_000 })
    const killed = r.status !== 0
    console.log(`${killed ? 'KILLED  ' : 'SURVIVED'} ${name}`)
    if (!killed) survivors++
  } finally {
    restore()
  }
}
console.log(`${M.length - survivors}/${M.length} guards witnessed`)
process.exit(survivors)
