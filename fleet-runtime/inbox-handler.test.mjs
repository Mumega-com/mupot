// node --test inbox-handler.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  handleBatch,
  runCommand,
  validateConfig,
  validatePayload,
  writeSpoolFiles,
} from './inbox-handler.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'mupot-inbox-handler-'))

const rawConfig = (dir = tmp()) => ({
  spool_dir: dir,
  agents: [
    { agent_id: 'agent-one', command: 'node handle.mjs', run_for: ['request'] },
    { agent_id: 'agent-two' },
  ],
})

const rawPayload = () => ({
  tenant: 't',
  base_url: 'https://pot.example.com',
  agent_id: 'agent-one',
  messages: [{
    seq: 7,
    id: 'msg-1',
    from_agent: 'review',
    from_member: 'm-review',
    kind: 'request',
    body: 'do the work',
    request_id: 'rid-1',
    in_reply_to: null,
    created_at: 'now',
  }],
  remaining: 0,
})

test('validateConfig: normalizes agents and rejects duplicates', () => {
  const cfg = validateConfig(rawConfig('/tmp/mupot-spool-test'))
  assert.equal(cfg.agents.get('agent-one').command, 'node handle.mjs')
  assert.deepEqual([...cfg.agents.get('agent-one').runFor], ['request'])
  assert.equal(cfg.agents.get('agent-two').command, '')
  assert.throws(() => validateConfig({ spool_dir: '/tmp/x', agents: [{ agent_id: 'a' }, { agent_id: 'a' }] }), /duplicate/)
  assert.throws(() => validateConfig({ spool_dir: '/tmp/x', agents: [{ agent_id: 'a', command: 'echo ok', run_for: ['typo'] }] }), /run_for/)
})

test('validatePayload: accepts the daemon batch shape and rejects malformed bodies', () => {
  const payload = validatePayload(rawPayload())
  assert.equal(payload.agent_id, 'agent-one')
  assert.equal(payload.messages[0].body, 'do the work')
  assert.throws(() => validatePayload({ ...rawPayload(), agent_id: '../bad' }), /agent_id/)
  assert.throws(() => validatePayload({ ...rawPayload(), messages: [{ ...rawPayload().messages[0], kind: 'evil' }] }), /kind/)
})

test('writeSpoolFiles: writes one 0600 JSON record per message under the agent spool', () => {
  const cfg = validateConfig(rawConfig(tmp()))
  const payload = validatePayload(rawPayload())
  const files = writeSpoolFiles(cfg.agents.get('agent-one'), payload, () => 'received')
  assert.equal(files.length, 1)
  assert.ok(files[0].includes('agent-one'))
  assert.equal(statSync(files[0]).mode & 0o777, 0o600)
  const record = JSON.parse(readFileSync(files[0], 'utf8'))
  assert.equal(record.received_at, 'received')
  assert.equal(record.message.request_id, 'rid-1')
})

test('handleBatch: persists first, then runs configured command for matching kind', async () => {
  const cfg = validateConfig(rawConfig(tmp()))
  const payload = validatePayload(rawPayload())
  const calls = []
  const res = await handleBatch(cfg, payload, {
    now: () => 'received',
    runCommand: async (cmd, stdinPayload, timeoutMs) => {
      calls.push({ cmd, parsed: JSON.parse(stdinPayload), timeoutMs })
      return { ok: true, code: 0 }
    },
  })
  assert.equal(res.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].cmd, 'node handle.mjs')
  assert.equal(calls[0].parsed.files.length, 1)
  assert.equal(JSON.parse(readFileSync(calls[0].parsed.files[0], 'utf8')).message.body, 'do the work')
})

test('handleBatch: skips command when no message kind matches run_for', async () => {
  const cfg = validateConfig(rawConfig(tmp()))
  const payload = validatePayload({
    ...rawPayload(),
    messages: [{ ...rawPayload().messages[0], kind: 'ack', request_id: null, in_reply_to: 'rid-1' }],
  })
  let called = false
  const res = await handleBatch(cfg, payload, {
    runCommand: async () => { called = true; return { ok: true, code: 0 } },
  })
  assert.equal(res.ok, true)
  assert.equal(res.command, 'skipped')
  assert.equal(called, false)
})

test('handleBatch: command failure returns ok=false so fleet-daemon keeps messages unread', async () => {
  const cfg = validateConfig(rawConfig(tmp()))
  const payload = validatePayload(rawPayload())
  const res = await handleBatch(cfg, payload, {
    runCommand: async () => ({ ok: false, code: 9 }),
  })
  assert.equal(res.ok, false)
  assert.equal(res.code, 9)
})

test('handleBatch: productized profiles persist first and activate through the direct runner', async () => {
  const dir = tmp()
  const raw = rawConfig(dir)
  delete raw.agents[0].command
  delete raw.agents[0].run_for
  raw.agents[0].profile = {
    schema: 'mupot.agent-profile/v1',
    agent_id: 'agent-one',
    adapter: 'hermes',
    command: ['/opt/homebrew/bin/hermes', 'chat', '--toolsets', 'mumega_dme'],
    allowed_senders: ['review'],
    run_for: ['request'],
    timeout_ms: 120000,
  }
  const cfg = validateConfig(raw)
  const payload = validatePayload(rawPayload())
  const calls = []
  const result = await handleBatch(cfg, payload, {
    now: () => 'received',
    runProfile: async (profile, batch) => {
      calls.push({ profile, batch })
      assert.equal(JSON.parse(readFileSync(batch.files[0], 'utf8')).received_at, 'received')
      return { ok: true, code: 0, activated_messages: 1 }
    },
  })

  assert.equal(result.ok, true)
  assert.equal(result.command, 'profile:hermes')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].batch.messages[0].project_id, null)
})

test('runCommand: passes JSON stdin to a real child process', async () => {
  const ok = await runCommand(
    `node -e "let s=''; process.stdin.on('data', d => s += d); process.stdin.on('end', () => process.exit(JSON.parse(s).ok ? 0 : 1))"`,
    JSON.stringify({ ok: true }),
  )
  assert.deepEqual(ok, { ok: true, code: 0 })
})
