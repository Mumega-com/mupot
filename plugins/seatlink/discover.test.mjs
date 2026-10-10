// plugins/seatlink/discover.test.mjs — fixtures only: no herdr, no mupot, no filesystem.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSeatSet, classifyStreamFailure, parseHerdrAgents, parseHerdrWorkspaces, parsePeers,
  runSeatStream, slugCandidates,
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

test('401 policy: 401 and 403 stop with one loud line naming the seat; 5xx / network retry', () => {
  for (const status of [401, 403]) {
    const v = classifyStreamFailure('muvps_kasra', status)
    assert.equal(v.action, 'stop')
    assert.match(v.line, /muvps_kasra/)
    assert.match(v.line, new RegExp(String(status)))
  }
  for (const status of [500, 502, 429, null]) assert.equal(classifyStreamFailure('s', status).action, 'retry')
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
  })
  assert.deepEqual(out, { stopped: true, status: 401 })
  assert.equal(opens, 1)
  assert.equal(sleeps, 0)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /muvps_loom/)
})

test('runSeatStream: transient errors back off 1s,2s,4s... capped at 30s, then a 401 stops it', async () => {
  const delays = []
  let n = 0
  const out = await runSeatStream({
    seat: 's',
    openOnce: async () => {
      n++
      if (n <= 8) throw Object.assign(new Error('HTTP 503'), { status: 503 })
      throw Object.assign(new Error('HTTP 401'), { status: 401 })
    },
    log: () => {},
    sleep: async (ms) => { delays.push(ms) },
  })
  assert.equal(out.stopped, true)
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000])
})
