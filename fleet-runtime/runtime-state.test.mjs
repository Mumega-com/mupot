import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  controlState,
  heartbeatState,
  readRuntimeState,
  writeRuntimeState,
} from './runtime-state.mjs'

function recordingFs() {
  const calls = []
  const files = new Map()
  return {
    calls,
    files,
    statSync(path) {
      calls.push(['stat', path])
      return { isDirectory: () => path === '/state' }
    },
    openSync(path, flag, mode) {
      calls.push(['open', path, flag, mode])
      files.set(path, '')
      return 42
    },
    writeFileSync(fd, value) {
      calls.push(['write', fd, value])
    },
    fsyncSync(fd) {
      calls.push(['fsync', fd])
    },
    closeSync(fd) {
      calls.push(['close', fd])
    },
    renameSync(from, to) {
      calls.push(['rename', from, to])
      files.set(to, files.get(from) ?? '')
      files.delete(from)
    },
    unlinkSync(path) {
      calls.push(['unlink', path])
      files.delete(path)
    },
    readFileSync(path) {
      calls.push(['read', path])
      return files.get(path)
    },
  }
}

test('writeRuntimeState atomically writes a mode-0600 JSON file in its existing parent directory', () => {
  const fs = recordingFs()
  writeRuntimeState('/state/daemon.json', { schema: 'test/v1', tick: 1 }, { fs, tempName: () => '.daemon.json.tmp' })

  assert.deepEqual(fs.calls.map((call) => call.slice(0, 3)), [
    ['stat', '/state'],
    ['open', '/state/.daemon.json.tmp', 'wx'],
    ['write', 42, '{"schema":"test/v1","tick":1}\n'],
    ['fsync', 42],
    ['close', 42],
    ['rename', '/state/.daemon.json.tmp', '/state/daemon.json'],
  ])
  assert.equal(fs.calls[1][3], 0o600)
  assert.equal(fs.files.has('/state/.daemon.json.tmp'), false)
  assert.equal(fs.files.get('/state/daemon.json'), '')
})

test('writeRuntimeState preserves a prior state when rename fails and cleans its temporary file', () => {
  const fs = recordingFs()
  fs.files.set('/state/daemon.json', '{"tick":1}\n')
  fs.renameSync = (from, to) => {
    fs.calls.push(['rename', from, to])
    throw new Error('rename failed')
  }

  assert.throws(
    () => writeRuntimeState('/state/daemon.json', { tick: 2 }, { fs, tempName: () => '.daemon.json.tmp' }),
    /rename failed/,
  )
  assert.equal(fs.files.get('/state/daemon.json'), '{"tick":1}\n')
  assert.equal(fs.files.has('/state/.daemon.json.tmp'), false)
  assert.deepEqual(fs.calls.at(-1), ['unlink', '/state/.daemon.json.tmp'])
})

test('writeRuntimeState leaves an existing temporary collision untouched when exclusive open fails', () => {
  const fs = recordingFs()
  fs.files.set('/state/.daemon.json.tmp', 'previous temporary state')
  fs.openSync = (path, flag, mode) => {
    fs.calls.push(['open', path, flag, mode])
    throw new Error('EEXIST')
  }

  assert.throws(
    () => writeRuntimeState('/state/daemon.json', { tick: 2 }, { fs, tempName: () => '.daemon.json.tmp' }),
    /EEXIST/,
  )
  assert.equal(fs.files.get('/state/.daemon.json.tmp'), 'previous temporary state')
  assert.equal(fs.calls.some(([operation]) => operation === 'unlink'), false)
})

test('writeRuntimeState rejects a temporary path that aliases the target before filesystem effects', () => {
  for (const tempName of ['daemon.json', '.', '..']) {
    const fs = recordingFs()
    assert.throws(
      () => writeRuntimeState('/state/daemon.json', { tick: 2 }, { fs, tempName: () => tempName }),
      /temporary name/,
    )
    assert.equal(fs.calls.length, 0)
  }
})

test('writeRuntimeState rejects secret-looking field names and canonical secret values before creating a file', () => {
  for (const state of [
    { ['author' + 'ization']: 'Be' + 'arer abcdefghijklmnop' },
    { nested: { ['private' + '_key']: 'not-a-key' } },
    { token: 'mupot_abcdefghijklmnop' },
    { credentials: { username: 'operator', password: 'not-a-password' } },
    { result: 'Bearer abcdefghijklmnop' },
    {
      toJSON() {
        return { credentials: 'not-a-secret' }
      },
    },
    {
      toJSON() {
        return { result: 'Bearer abcdefghijklmnop' }
      },
    },
  ]) {
    const fs = recordingFs()
    assert.throws(() => writeRuntimeState('/state/daemon.json', state, { fs }), /prohibited secret-like material/)
    assert.equal(fs.calls.length, 0)
  }
})

test('readRuntimeState reads the published JSON state', () => {
  const fs = recordingFs()
  fs.files.set('/state/daemon.json', '{"tick":2}\n')
  assert.deepEqual(readRuntimeState('/state/daemon.json', { fs }), { tick: 2 })
})

test('heartbeatState emits the exact redacted heartbeat schema', () => {
  const state = heartbeatState({
    pid: 123,
    startedAt: '2026-07-13T12:00:00.000Z',
    tick: 2,
    lastTickAt: '2026-07-13T12:01:15.000Z',
    intervalSec: 75,
    results: [{
      agent: 'agent-one',
      probe: 'alive',
      heartbeat: { ok: true, status: 200 },
      inbox: { messages: 1, action: 'inbox_consumed' },
    }],
  })
  assert.deepEqual(state, {
    schema: 'mupot-fleet-daemon-state/v1',
    pid: 123,
    started_at: '2026-07-13T12:00:00.000Z',
    tick: 2,
    last_tick_at: '2026-07-13T12:01:15.000Z',
    interval_sec: 75,
    agents: [{ agent_id: 'agent-one', probe: 'alive', heartbeat_status: 200, inbox_count: 1, consume: 'consumed' }],
  })
})

test('controlState retains only a reduced non-secret outcome', () => {
  const state = controlState({
    pid: 456,
    startedAt: '2026-07-13T12:00:00.000Z',
    poll: 2,
    lastPollAt: '2026-07-13T12:01:15.000Z',
    pollSec: 5,
    outcome: {
      ok: true,
      action: 'open',
      request: { agent_id: 'agent-one', verb: 'start', ['non' + 'ce']: 'non' + 'ce-123', sig: 'sig' + 'nature-123' },
      token: 'mupot_abcdefghijklmnop',
    },
  })
  assert.deepEqual(state, {
    schema: 'mupot-fleet-control-state/v1',
    pid: 456,
    started_at: '2026-07-13T12:00:00.000Z',
    poll: 2,
    last_poll_at: '2026-07-13T12:01:15.000Z',
    poll_sec: 5,
    last_outcome: { agent_id: 'agent-one', verb: 'start', accepted: true, result: 'open' },
    last_accepted: {
      agent_id: 'agent-one',
      verb: 'start',
      result: 'open',
      request_ref: '1d9664478addbe4ee7186c19b2a2c98e461a77dc1e183654f36916bf9fb51cba',
      observed_at: '2026-07-13T12:01:15.000Z',
    },
  })
  assert.doesNotMatch(JSON.stringify(state), /nonce|signature|token/i)
})

test('controlState preserves the last accepted request while later polls are idle', () => {
  const lastAccepted = {
    agent_id: 'agent-one',
    verb: 'start',
    result: 'open',
    request_ref: 'a'.repeat(64),
    observed_at: '2026-07-13T12:00:05.000Z',
  }
  const state = controlState({
    pid: 456,
    startedAt: '2026-07-13T12:00:00.000Z',
    poll: 3,
    lastPollAt: '2026-07-13T12:00:10.000Z',
    pollSec: 5,
    outcome: { ok: true, action: 'idle' },
    lastAccepted,
  })

  assert.deepEqual(state.last_accepted, lastAccepted)
  assert.deepEqual(state.last_outcome, { agent_id: null, verb: null, accepted: true, result: 'idle' })
})
