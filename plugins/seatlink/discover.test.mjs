// plugins/seatlink/discover.test.mjs — fixtures only: no herdr, no mupot, no filesystem.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSeatSet, classifyStreamFailure, parseHerdrAgents, parseHerdrWorkspaces, parsePeers,
  runSeatStream, slugCandidates, LONG_BACKOFF_MS,
} from './discover.mjs'

const herdrAgentsRaw = JSON.stringify({ id: 'cli:agent:list', result: { agents: [
  { agent: 'claude', pane_id: 'wJ:p6', workspace_id: 'wJ' },
  { agent: 'codex', pane_id: 'wW:p1', workspace_id: 'wW' },
  { agent: 'hermes', pane_id: 'w11:p1', workspace_id: 'w11' },
  { agent: 'claude', pane_id: 'wG:p1', workspace_id: 'wG' },
  { agent: 'claude', pane_id: 'wZ:p1', workspace_id: 'wZ' },
  { agent: 'claude', pane_id: 'wN:p1', workspace_id: 'wN' },
] } })
const workspacesRaw = JSON.stringify({ id: 'cli:workspace:list', result: { type: 'workspace_list', workspaces: [
  { workspace_id: 'wJ', label: 'muvps_kasra' },
  { workspace_id: 'wW', label: 'muvps_athena' },
  { workspace_id: 'w11', label: 'muvps_hermes' },
  { workspace_id: 'wG', label: 'muvps_loom' },
  { workspace_id: 'wZ', label: 'dup' },
  { workspace_id: 'wN', label: 'notoken' },
] } })
const peers = parsePeers({ peers: [
  { id: 'id-kasra', slug: 'kasra' },
  { id: 'id-athena', slug: 'athena' },
  { id: 'id-loom', slug: 'muvps-loom' },
  { id: 'id-dup1', slug: 'dup' },
  { id: 'id-dup2', slug: 'DUP' },
  { id: 'id-notoken', slug: 'notoken' },
  { slug: 'malformed' },
] })
const tokens = new Set(['kasra', 'athena', 'muvps-loom', 'dup'])
const tokenFileFor = (slug) => (tokens.has(slug) ? `/t/${slug}-agent-bound.token` : null)
const base = { herdrAgents: parseHerdrAgents(herdrAgentsRaw), herdrWorkspaces: parseHerdrWorkspaces(workspacesRaw), peers, tokenFileFor }

test('slug candidates: muvps_ prefix is optional, underscore == dash', () => {
  assert.deepEqual(slugCandidates('muvps_kasra'), ['muvps-kasra', 'kasra'])
  assert.deepEqual(slugCandidates('kasra'), ['kasra'])
  assert.deepEqual(slugCandidates(''), [])
})

test('join: herdr workspace label -> peer slug -> token file; every seat lands in seats or skipped with a reason', () => {
  const { seats, skipped } = buildSeatSet(base)
  const byName = Object.fromEntries(seats.map((s) => [s.herdr, s]))
  assert.deepEqual(byName.muvps_kasra, { herdr: 'muvps_kasra', mupot_agent_id: 'id-kasra', mupot_token_file: '/t/kasra-agent-bound.token', source: 'discover' })
  assert.equal(byName.muvps_athena.mupot_agent_id, 'id-athena')
  assert.equal(byName.muvps_loom.mupot_agent_id, 'id-loom', 'exact muvps-loom slug wins before the prefix is stripped')
  const reasons = Object.fromEntries(skipped.map((s) => [s.herdr, s.reason]))
  assert.equal(reasons.muvps_hermes, 'no_peer_match')
  assert.equal(reasons.dup, 'ambiguous_peer_match')
  assert.equal(reasons.notoken, 'no_token_file')
  assert.equal(seats.length + skipped.length, 6)
})

test('malformed peers are dropped, not joined', () => {
  assert.equal(peers.some((p) => p.slug === 'malformed'), false)
})

test('seats.json override wins wholesale and is kept even when herdr does not list the seat', () => {
  const overrides = [
    { herdr: 'muvps_kasra', mupot_agent_id: 'pinned', mupot_token_file: '/o/k.token' },
    { herdr: 'offline_seat', mupot_agent_id: 'x', mupot_token_file: '/o/x.token' },
  ]
  const { seats } = buildSeatSet({ ...base, overrides })
  const byName = Object.fromEntries(seats.map((s) => [s.herdr, s]))
  assert.equal(byName.muvps_kasra.mupot_agent_id, 'pinned')
  assert.equal(byName.muvps_kasra.source, 'override')
  assert.equal(byName.offline_seat.source, 'override')
})

test('bad herdr output parses to an empty list, never throws', () => {
  assert.deepEqual(parseHerdrAgents('not json'), [])
  assert.deepEqual(parseHerdrAgents({ error: 'x' }), [])
})

test('401 policy: 401 and 403-not_agent_bound stop with one loud line naming the seat; 5xx / network retry', () => {
  for (const [status, body] of [[401, ''], [403, '{"error":"not_agent_bound"}']]) {
    const v = classifyStreamFailure('muvps_kasra', status, body)
    assert.equal(v.action, 'stop')
    assert.match(v.line, /muvps_kasra/)
    assert.match(v.line, new RegExp(String(status)))
  }
  for (const status of [429, null]) assert.equal(classifyStreamFailure('s', status).action, 'retry')
  for (const [status, body] of [[403, ''], [403, 'forbidden'], [500, ''], [502, ''], [503, '']]) {
    assert.equal(classifyStreamFailure('s', status, body).action, 'backoff', `${status} ${body}`)
  }
})

test('runSeatStream: a 401 logs exactly one line, calls openOnce exactly once, never sleeps', async () => {
  const lines = []
  let opens = 0
  let sleeps = 0
  const out = await runSeatStream({
    seat: 'muvps_loom',
    openOnce: async () => { opens++; throw Object.assign(new Error('HTTP 401'), { status: 401 }) },
    log: (l) => lines.push(l),
    sleep: async () => { sleeps++ },
    shouldContinue: () => opens < 5, // a regressed policy fails fast instead of looping forever
  })
  assert.deepEqual(out, { stopped: true, status: 401 })
  assert.equal(opens, 1)
  assert.equal(sleeps, 0)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /muvps_loom/)
})

test('runSeatStream: network errors back off 1s,2s,4s... capped at 30s, then a 401 stops it', async () => {
  const delays = []
  let n = 0
  const out = await runSeatStream({
    seat: 's',
    openOnce: async () => {
      n++
      if (n <= 8) throw new Error('ECONNRESET')
      throw Object.assign(new Error('HTTP 401'), { status: 401 })
    },
    log: () => {},
    sleep: async (ms) => { delays.push(ms) },
    shouldContinue: () => n < 20,
  })
  assert.equal(out.stopped, true)
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000])
})

test('duplicate peer claim: two herdr seats resolving to one mupot agent id are BOTH skipped', () => {
  const { seats, skipped } = buildSeatSet({
    herdrAgents: [{ name: 'a', workspace_id: 'w1', pane_id: 'w1:p1' }, { name: 'b', workspace_id: 'w2', pane_id: 'w2:p1' }, { name: 'c', workspace_id: 'w3', pane_id: 'w3:p1' }],
    herdrWorkspaces: [{ workspace_id: 'w1', label: 'muvps_kasra' }, { workspace_id: 'w2', label: 'kasra' }, { workspace_id: 'w3', label: 'athena' }],
    peers: [{ id: 'id-kasra', slug: 'kasra' }, { id: 'id-athena', slug: 'athena' }],
    tokenFileFor: (s) => `/t/${s}.token`,
  })
  assert.deepEqual(seats.map((s) => s.herdr), ['athena'])
  const dup = skipped.filter((s) => s.reason === 'duplicate_peer_claim')
  assert.deepEqual(dup.map((s) => s.herdr).sort(), ['kasra', 'muvps_kasra'])
  assert.ok(dup.every((s) => s.mupot_agent_id === 'id-kasra'))
})

test('duplicate herdr label is skipped with a reason, never silently dropped', () => {
  const { seats, skipped } = buildSeatSet({
    herdrAgents: [{ name: 'x', workspace_id: 'w1', pane_id: 'w1:p1' }, { name: 'x', workspace_id: 'w1', pane_id: 'w1:p2' }],
    herdrWorkspaces: [{ workspace_id: 'w1', label: 'kasra' }],
    peers: [{ id: 'id-kasra', slug: 'kasra' }],
    tokenFileFor: (s) => `/t/${s}.token`,
  })
  assert.equal(seats.length, 1)
  assert.deepEqual(skipped, [{ herdr: 'kasra', pane_id: 'w1:p2', reason: 'duplicate_label' }])
})

test('peer slug is validated before it reaches a path: traversal / odd slugs are skipped', () => {
  const calls = []
  for (const slug of ['../etc/passwd', 'a/b', '-lead', 'UP', 'a'.repeat(65), 'sp ace']) {
    const { seats, skipped } = buildSeatSet({
      herdrAgents: [{ name: 'n', workspace_id: 'w1' }],
      herdrWorkspaces: [{ workspace_id: 'w1', label: slug }],
      peers: [{ id: 'id-1', slug }],
      tokenFileFor: (s) => { calls.push(s); return `/t/${s}.token` },
    })
    assert.equal(seats.length, 0, slug)
    assert.ok(['invalid_peer_slug', 'no_peer_match'].includes(skipped[0].reason), `${slug} -> ${skipped[0].reason}`)
  }
  const { skipped } = buildSeatSet({
    herdrAgents: [{ name: 'n', workspace_id: 'w1' }],
    herdrWorkspaces: [{ workspace_id: 'w1', label: 'a/b' }],
    peers: [{ id: 'id-1', slug: 'a/b' }],
    tokenFileFor: () => '/x',
  })
  assert.equal(skipped[0].reason, 'invalid_peer_slug')
  assert.deepEqual(calls, [], 'tokenFileFor is never called with an unvalidated slug')
})

test('runSeatStream: 403 without not_agent_bound and 5xx back off 5 min, re-read the token every cycle, never stop', async () => {
  const delays = []
  const tokensSeen = []
  let reads = 0
  let n = 0
  const out = await runSeatStream({
    seat: 's',
    readToken: () => `tok${++reads}`,
    openOnce: async (tok) => {
      tokensSeen.push(tok)
      n++
      throw Object.assign(new Error('refused'), n % 2 ? { status: 403, body: 'waf' } : { status: 503 })
    },
    log: () => {},
    sleep: async (ms) => { delays.push(ms) },
    shouldContinue: () => n < 4,
  })
  assert.equal(out.stopped, false)
  assert.deepEqual(delays, [LONG_BACKOFF_MS, LONG_BACKOFF_MS, LONG_BACKOFF_MS, LONG_BACKOFF_MS])
  assert.deepEqual(tokensSeen, ['tok1', 'tok2', 'tok3', 'tok4'])
})

test('runSeatStream: 403 with not_agent_bound stops once', async () => {
  let n = 0
  const out = await runSeatStream({
    seat: 's',
    openOnce: async () => { n++; throw Object.assign(new Error('x'), { status: 403, body: '{"error":"not_agent_bound"}' }) },
    log: () => {}, sleep: async () => {}, shouldContinue: () => n < 5,
  })
  assert.deepEqual(out, { stopped: true, status: 403 })
  assert.equal(n, 1)
})

test('runSeatStream: a normal stream end sleeps 1s before reconnecting (no hot loop)', async () => {
  const delays = []
  let n = 0
  await runSeatStream({
    seat: 's', openOnce: async () => { n++ }, log: () => {},
    sleep: async (ms) => { delays.push(ms) }, shouldContinue: () => n < 3,
  })
  assert.deepEqual(delays, [1000, 1000, 1000])
})
