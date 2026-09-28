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
  // mupot#1594 P2-C: grant scope — host standing to create, rank ceiling to revoke
  ['host must have standing in the target squad to be granted (P2-C)', 'src/agents/seat-events.ts', "if (!(await hostHasStandingInSquad(env, input.hostAgentId, agent.squad_id))) {", 'if (false) {'],
  ['a lead cannot revoke a grant a higher-rank principal created (P2-C)', 'src/agents/seat-events-routes.ts', "if (hasCapability(creatorGrants, 'org', null, 'admin')) {", 'if (false) {'],
  // mupot#1594 P3: the 404-vs-403 agent-existence oracle must be uniform. Isolated from the
  // combined rank-ceiling mutation above (P1-1 entry) by weakening the RANK MINIMUM instead
  // of deleting the whole condition — a below-lead member must still be refused.
  ['grant-target existence oracle is uniform, never distinguishes missing from no-standing (P3)', 'src/agents/seat-events-routes.ts', "await canOnSquad(c.env, principal.grants, row.squad_id, 'lead')", "await canOnSquad(c.env, principal.grants, row.squad_id, 'member')"],
  // mupot#1594 P2-B: the Herdr fence must fail CLOSED on a D1 error, never open
  ['fence fails CLOSED on a transient D1 error, never opens (P2-B)', 'src/agents/inbox-routes.ts', "if (status === 'error') {\n        return c.json({ error: 'fence_check_failed' }, 503, { 'Retry-After': '2', 'Cache-Control': 'no-store' })\n      }", ''],
  // mupot#1594 P1-A: route-level ticket pre-check, upgrade rate limit, hibernation-safe deadline
  ['upgrade route pre-checks (consumes) the ticket before ever forwarding to the DO (P1-A)', 'src/agents/seat-events-routes.ts', "if (!consumed.ok) return c.json({ error: 'ticket_invalid' }, 401, NO_STORE)", ''],
  // mupot#1595 P3 (kasra-review round 1): the ORIGINAL version of this entry mutated the
  // SUCCESS return (`return row !== null` → `true`), never the catch — so it was mislabelled
  // as witnessing fail-closed when it actually witnessed nothing about the error path at all.
  // Now targets the catch's own `return` directly.
  ['ticket pre-check consume fails CLOSED on a D1 error (P1-A / P3)', 'src/agents/seat-events.ts', "console.error('[seat-events] ticket pre-check consume failed (refusing, fail-closed):', err instanceof Error ? err.message : err)\n    return { ok: false, reason: 'error' }", "console.error('[seat-events] ticket pre-check consume failed (refusing, fail-closed):', err instanceof Error ? err.message : err)\n    return { ok: true, hostAgentId: 'x' }"],
  ['upgrade route is rate-limited per IP, independent of /ticket (P1-A)', 'src/agents/seat-events-routes.ts', "if (!(await underUpgradeRateLimit(c.env, clientIp(c)))) return c.json({ error: 'rate_limited' }, 429, NO_STORE)", ''],
  // mupot#1595 P1 (kasra-review round 1, Probe Z2): the ticket pre-check is now SINGLE-USE —
  // an atomic UPDATE ... WHERE used_at IS NULL. Without that conjunct the SAME ticket reopens
  // the pre-check indefinitely within its TTL.
  ['ticket pre-check consume is single-use (used_at IS NULL) (P1)', 'src/agents/seat-events.ts', 'WHERE tenant = ?1 AND hash = ?2 AND used_at IS NULL AND expires_at >= ?3', 'WHERE tenant = ?1 AND hash = ?2 AND expires_at >= ?3'],
  // mupot#1595 P3 (kasra-review round 1): the tenant conjunct in the SAME consume query —
  // survived the original round because no test proved cross-tenant rejection.
  ['ticket pre-check consume is tenant-scoped (P3)', 'src/agents/seat-events.ts', 'WHERE tenant = ?1 AND hash = ?2 AND used_at IS NULL AND expires_at >= ?3', 'WHERE ?1 = ?1 AND hash = ?2 AND used_at IS NULL AND expires_at >= ?3'],
  // mupot#1595 P3 (kasra-review round 1): IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) used to
  // collapse into the SAME shared bucket as every other IPv4-mapped address (and ::1).
  ['IPv4-mapped IPv6 addresses key by their embedded IPv4 address (P3)', 'src/agents/seat-events.ts', 'const mapped = ip.match(IPV4_MAPPED_RE)', 'const mapped = null'],
  // mupot#1595 P2 (kasra-review round 1, Probe Z5): "nothing deletes old windows" — neither
  // rate-limit table pruned itself.
  ["ticket rate-limit table is pruned (P2)", 'src/agents/seat-events.ts', "await pruneRateLimitTable(env, 'seat_events_ticket_rate_limits', nowMs, TICKET_RATE_LIMIT_WINDOW_SEC)", ''],
  ["upgrade rate-limit table is pruned (P2)", 'src/agents/seat-events.ts', "await pruneRateLimitTable(env, 'seat_events_upgrade_rate_limits', nowMs, UPGRADE_RATE_LIMIT_WINDOW_SEC)", ''],
  // mupot#1595 P3 (kasra-review round 1): "underUpgradeRateLimit's catch mutated to fail
  // open: survived. No test covers it." Same gap existed, unnoticed, in underTicketRateLimit.
  ['underTicketRateLimit fails CLOSED on a D1 error (P3)', 'src/agents/seat-events.ts', "console.error('[seat-events] ticket rate-limit check failed (refusing, fail-closed):', err instanceof Error ? err.message : err)\n    return false", "console.error('[seat-events] ticket rate-limit check failed (refusing, fail-closed):', err instanceof Error ? err.message : err)\n    return true"],
  ['underUpgradeRateLimit fails CLOSED on a D1 error (P3)', 'src/agents/seat-events.ts', "console.error('[seat-events] upgrade rate-limit check failed (refusing, fail-closed):', err instanceof Error ? err.message : err)\n    return false", "console.error('[seat-events] upgrade rate-limit check failed (refusing, fail-closed):', err instanceof Error ? err.message : err)\n    return true"],
  // mupot#1595 P1 (codex round-2 review): host squad standing is revalidated on EVERY
  // delivery decision (mint/redeem/fence/hint), not only checked at grant creation.
  ['host standing is revalidated on every delivery, not just at grant creation (P1)', 'src/agents/seat-events.ts', 'AND ${HOST_STANDING_SQL}', ''],
  // mupot#1595 P1 (codex round-2 review): legacy (pre-mupot#1594) socket attachments must be
  // decoded as authenticated, or a hibernated socket from the previous deploy is silently
  // treated as pending forever after this code wakes it.
  ['legacy socket attachment shape is decoded as authenticated (P1)', 'src/agents/seat-events.ts', "if (typeof r.host === 'string' && Array.isArray(r.agents) && r.sub === undefined && r.connectedAt === undefined) {", 'if (false) {'],
  // mupot#1595 P2 (codex round-2 review): the pot-wide authenticated cap must be re-checked
  // at the pending→authenticated transition (hello), not only at DO accept time.
  ['authenticated cap re-checked at hello, not only at accept (P2)', 'src/agents/seat-events.ts', "if (podAcceptRefusal({ authenticated: authenticatedNow, pending: 0 }) === 'pot_full') {", 'if (false) {'],
  // mupot#1595 P2 (codex round-2 review): the alarm reschedules at the EARLIEST surviving
  // pending socket's own deadline, not a fresh now+AUTH_DEADLINE_SEC.
  ['alarm reschedules at the earliest pending deadline, not a fresh interval (P2)', 'src/agents/seat-events.ts', 'return (Math.min(...pendingConnectedAtSec) + AUTH_DEADLINE_SEC) * 1000', 'return (Math.max(...pendingConnectedAtSec) + AUTH_DEADLINE_SEC) * 1000'],
  // mupot#1595 P1/P2 (codex round-2 review): grant scope — creator's EFFECTIVE authority on
  // the target squad (not just org-scope admin) gates a lead's revoke; a suspended creator's
  // stale capability rows must not; the revoke is bound to the exact grant id just authorized.
  ['revoke ceiling compares EFFECTIVE rank on the target squad, not org-scope only (P1)', 'src/agents/seat-events-routes.ts', 'if (creatorRank > revokerRank) {', 'if (false) {'],
  ["a suspended creator's stale capability rows do not impose a revoke ceiling (P2)", 'src/agents/seat-events-routes.ts', 'live.granted_by_member_id !== principal.memberId && (await isMemberActive(c.env, live.granted_by_member_id))', 'live.granted_by_member_id !== principal.memberId && true'],
  ['revoke is bound to the exact grant id just authorized, not just agent_id (P2)', 'src/agents/seat-events.ts', "input.grantId\n      ? `UPDATE seat_event_grants", "false\n      ? `UPDATE seat_event_grants"],
  ['authenticated sockets are capped separately from pending ones (P1-A)', 'src/agents/seat-events.ts', "if (counts.authenticated >= MAX_SOCKETS_PER_POT) return 'pot_full'", 'if (false) return \'pot_full\''],
  ['pending sockets get their OWN small cap (P1-A)', 'src/agents/seat-events.ts', "if (counts.pending >= MAX_PENDING_SOCKETS_PER_POT) return 'pending_full'", 'if (false) return \'pending_full\''],
  ['a pending sweep is never postponed by a later connect (P1-A)', 'src/agents/seat-events.ts', 'if (existing === null || desired < existing) return desired', 'return desired'],
  // revoked ownership
  ['re-authorize at redeem', 'src/agents/seat-events.ts', "if (status !== 'granted') {", 'if (false) {'],
  ['re-authorize every hint', 'src/agents/seat-events.ts', "if (status === 'not_granted') {", 'if (false) {'],
  ['host member must be active', 'src/agents/seat-events.ts', "JOIN members m ON m.id = k.member_id AND m.tenant = k.tenant AND m.status = 'active'\n        WHERE g.tenant", 'JOIN members m ON m.id = k.member_id AND m.tenant = k.tenant\n        WHERE g.tenant'],
  // duplicates / catch-up / backpressure
  ['dedup of republished hints', 'src/agents/seat-events.ts', 'if (!this.recent.add(hint.id)) return { sent: 0, duplicate: true, revoked: 0 }', ''],
  ['catch-up honours the cursor', 'src/agents/seat-events.ts', 'AND read_at IS NULL AND seq > ?3\n      ORDER BY seq ASC LIMIT ?4', 'AND read_at IS NULL AND seq > 0 AND ?3 = ?3\n      ORDER BY seq ASC LIMIT ?4'],
  ['catch-up skips read rows', 'src/agents/seat-events.ts', 'WHERE tenant = ?1 AND to_agent = ?2 AND read_at IS NULL AND seq > ?3', 'WHERE tenant = ?1 AND to_agent = ?2 AND seq > ?3'],
  ['backlog cap', 'src/agents/seat-events.ts', 'list.slice(0, BACKLOG_HINT_LIMIT)', 'list'],
  ['agents-per-ticket cap', 'src/agents/seat-events.ts', 'agentsRaw.length > MAX_AGENTS_PER_TICKET', 'false'],
  // dual consumer
  ['one live grant per agent (index)', 'migrations/0176_seat_event_grants.sql', 'CREATE UNIQUE INDEX IF NOT EXISTS idx_seat_event_grants_one_live_host', 'CREATE INDEX IF NOT EXISTS idx_seat_event_grants_one_live_host'],
  ['other authorized host keeps the agent', 'src/agents/seat-events.ts', "if (otherStatus !== 'not_granted') return 'held_by_other_host'", "if (false) return 'held_by_other_host'"],
  ['old socket dropped on supersede/move', 'src/agents/seat-events.ts', '      this.drop(other, st, agent, frame)\n', ''],
  ['legacy stream fenced for granted agents', 'src/agents/inbox-routes.ts', '    if (grant) {', '    if (false) {'],
  // mupot#1589 P2-1: the fence must equal the delivery predicate, not just "a row exists"
  ['fence predicate equals delivery predicate (P2-1)', 'src/agents/inbox-routes.ts', 'const status = await authorizeSeatDelivery(c.env, grant.host_agent_id, id.boundAgentId)', "const status = 'granted' as const"],
  // HTTP surface
  ['upgrade strips Authorization/Cookie', 'src/agents/seat-events-routes.ts', "presenceLiveDoUpgradeRequest(new URL('https://seat-events/connect'), c.req.raw)", "new Request('https://seat-events/connect', c.req.raw)"],
  ['ticket response no-store', 'src/agents/seat-events-routes.ts', "const NO_STORE = { 'Cache-Control': 'no-store' }", 'const NO_STORE = {}'],
  ['JSON catch-all, never a redirect', 'src/agents/seat-events-routes.ts', "seatEventsApp.all('*', (c) => c.json({ error: 'not_found' }, 404))", ''],
  // mupot#1589 P1-1: agent-bound refusal + org-admin/squad-lead rank ceiling on grant writes
  ['agent-bound token refused on grant writes (P1-1)', 'src/agents/seat-events-routes.ts', 'if (id.boundAgentId) return { ok: false, status: 403, error: \'operator_principal_required\' }', ''],
  ['grants need org admin OR squad lead, never below (P1-1)', 'src/agents/seat-events-routes.ts', "if (hasCapability(principal.grants, 'org', null, 'admin')) return { ok: true }", 'return { ok: true }'],
  ['grant rank ceiling checks the TARGET agent\'s own squad, not a caller-asserted one (P1-1)', 'src/agents/seat-events-routes.ts', "if (row && (await canOnSquad(c.env, principal.grants, row.squad_id, 'lead'))) return { ok: true }", 'if (row) return { ok: true }'],
  // mupot#1589 P1-2: refuse an upgrade with no credential-shaped ticket before the DO is reached
  ['ticket presence+format gate before the DO is reached (P1-2)', 'src/agents/seat-events-routes.ts', "if (!ticket || !isWellFormedTicket(ticket)) return c.json({ error: 'ticket_required' }, 401, NO_STORE)", ''],
  // NOTE: this one lives entirely in the DO shell (seat-events-do.ts), which this test suite
  // never instantiates (no workerd) — pre-existing structural gap, unchanged by mupot#1594;
  // podAcceptRefusal's OWN thresholds are witnessed directly (P1-A entries below).
  ['pod socket cap enforced before accept (P1-2)', 'src/agents/seat-events-do.ts', 'const refusal = podAcceptRefusal({ authenticated, pending })', 'const refusal = null'],
  ['auth deadline closes a never-authenticated socket, reading its OWN attachment not an in-memory map (P1-2/P1-4)', 'src/agents/seat-events.ts', 'if (at === undefined || now - at < AUTH_DEADLINE_SEC) continue', 'continue'],
  ['oversized frame closed (P1-2)', 'src/agents/seat-events.ts', 'if (byteLength > MAX_FRAME_BYTES) return this.closeSocket(sock, CLOSE_PROTOCOL_ABUSE, \'frame_too_large\')', ''],
  ['junk frames close the socket past the cap (P1-2)', 'src/agents/seat-events.ts', 'if (n > MAX_JUNK_FRAMES) this.closeSocket(sock, CLOSE_PROTOCOL_ABUSE, \'junk_frames\')', ''],
  ['per-host socket cap (P1-2)', 'src/agents/seat-events.ts', 'if (heldByHost >= MAX_SOCKETS_PER_HOST) return this.reject(sock, \'host_socket_limit\')', ''],
  // mupot#1589 P2-3: a transient D1 error must not read as a confirmed revocation
  ["publish skips (not revokes) on a transient error (P2-3)", 'src/agents/seat-events.ts', "if (status === 'error') {", 'if (false) {'],
  ["claim defers to the holder on a transient error, never steals (P2-3)", 'src/agents/seat-events.ts', "if (otherStatus !== 'not_granted') return 'held_by_other_host'", "if (otherStatus === 'granted') return 'held_by_other_host'"],
  ['flag gates the channel', 'src/agents/seat-events.ts', 'return env.REALTIME_SEAT_EVENTS === SEAT_EVENTS_FLAG && env.SEAT_EVENTS !== undefined', 'return env.SEAT_EVENTS !== undefined'],
  // consumer — mupot#1589 P1-3: the seat leg must be isolated from Hermes delivery
  [
    'seat-hint failure is isolated, never cancels Hermes delivery (P1-3)',
    'src/bus/consumer.ts',
    "      try {\n        const seat = await publishSeatHint(env, event.tenant, event.payload)\n        if (!seat.ok) {\n          console.error('bus: message.created — seat hint publish failed (isolated, not retried)', {\n            tenant: event.tenant,\n            message_id: p?.message_id,\n            error: seat.error,\n            metric: 'seat_events.hint_publish_failed',\n          })\n        }\n      } catch (err) {\n        console.error('bus: message.created — seat hint publish threw (isolated, not retried)', {\n          tenant: event.tenant,\n          message_id: p?.message_id,\n          error: redactSecretPatterns(err instanceof Error ? err.message : String(err)),\n          metric: 'seat_events.hint_publish_failed',\n        })\n      }\n",
    "      const seat = await publishSeatHint(env, event.tenant, event.payload)\n      if (!seat.ok) {\n        console.error('bus: message.created seat hint publish failed', { tenant: event.tenant, message_id: p?.message_id, error: seat.error })\n        throw new Error('message.created seat hint failed: ' + seat.error)\n      }\n",
  ],
  // mupot#1589 P3: the unauthenticated ticket-mint endpoint must be rate limited
  ['ticket-mint rate limit (P3)', 'src/agents/seat-events-routes.ts', "if (!(await underTicketRateLimit(c.env, clientIp(c)))) return c.json({ error: 'rate_limited' }, 429, NO_STORE)", ''],
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
