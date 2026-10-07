// mupot#1765 — reporter safety: allowlist refuses writes, payload carries counts only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertAllowedOrcaCommand, buildPayload, summarize, ORCA_READ_ALLOWLIST } from '../scripts/harness-capacity-reporter.mjs'

const SECRET = 'CANARY_TERMINAL_TEXT_7f3a9c'  // must never appear in a payload
const NOW = 1_800_000_000_000
const raw = {
  terminals: { ok: true, result: { terminals: [
    { handle: 'h1', connected: true, orphaned: false, agentIdentity: 'claude', lastOutputAt: NOW - 1000, preview: `export KEY=${SECRET}`, title: `deploy ${SECRET}`, worktreeId: '/home/x/secret-path' },
    { handle: 'h2', connected: true, orphaned: false, agentIdentity: null, lastOutputAt: NOW - 3_600_000, preview: SECRET, title: SECRET },
    { handle: 'h4', connected: true, orphaned: true, agentIdentity: 'claude', lastOutputAt: NOW, preview: SECRET, title: SECRET },
    { handle: 'h3', connected: false, orphaned: true, agentIdentity: 'claude', lastOutputAt: NOW, preview: SECRET, title: SECRET },
  ] } },
  workers: { ok: true, result: { workers: [
    { workerState: 'running', resource: { releaseState: 'retained' }, branch: `feat/${SECRET}` },
    { workerState: 'succeeded', resource: { releaseState: 'unknown' } },
  ] } },
  worktrees: { ok: true, result: { worktrees: [
    { repo: SECRET, liveTerminalCount: 2, branch: SECRET }, { repo: 'r', liveTerminalCount: 0 },
  ] } },
}

test('summarize computes counts', () => {
  const { counts } = summarize(raw, NOW)
  assert.deepEqual(counts, {
    live_terminals: 2, agent_sessions: 1, busy_recent: 1, orphaned_terminals: 2,
    workers_active: 1, workers_release_unknown: 1, worktrees_with_live: 1,
  })
})

test('payload contains no terminal text, titles, paths or branches', () => {
  const payload = buildPayload({ hostKey: 'hadi-mac', maxAgents: 4, raw, now: NOW })
  const s = JSON.stringify(payload)
  for (const bad of [SECRET, 'secret-path', 'preview', 'title', 'feat/', 'export KEY']) assert.ok(!s.includes(bad), bad)
  for (const [k, v] of Object.entries(payload)) {
    if (k === 'summary') for (const x of Object.values(v)) assert.equal(typeof x, 'number')
    else assert.ok(typeof v === 'number' || k === 'harness' || k === 'host_key', k)
  }
})

test('allowlist accepts only exact read commands and refuses writes', () => {
  for (const ok of ORCA_READ_ALLOWLIST) assertAllowedOrcaCommand([...ok])
  for (const bad of [['terminal', 'send'], ['terminal', 'list', 'extra'], ['orchestration', 'worker-stop'],
    ['computer-use'], ['worktree', 'rm'], ['status', '--x'], [], ['host', 'remove'], ['terminal']]) {
    assert.throws(() => assertAllowedOrcaCommand(bad), /refused/)
  }
})

test('invalid host key refused', () => {
  assert.throws(() => buildPayload({ hostKey: 'Bad Host/..', raw, now: NOW }))
})
