import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'

import { buildPiPrompt, runPiRpc, sanitizePiEnv, validatePiMessage } from './pi-rpc-inbox-adapter.mjs'

const MESSAGE = {
  seq: 1,
  id: 'msg-1',
  from_agent: 'sender-1',
  kind: 'request',
  body: 'What is the current situation?',
  request_id: 'req-1',
  in_reply_to: null,
  project_id: 'project-1',
}
const CONFIG = { pi_path: '/usr/bin/pi', provider: 'openai-codex', model: 'gpt-test', thinking: 'low', cwd: '/' }

function rpcChild(capture, records) {
  const child = new EventEmitter()
  child.pid = null
  child.stdout = new PassThrough()
  child.stdin = new Writable({
    write(chunk, _enc, done) {
      const command = JSON.parse(String(chunk).trim())
      capture.commands.push(command)
      queueMicrotask(() => {
        const output = records(command)
        for (const event of output) child.stdout.write(JSON.stringify(event) + '\n')
      })
      done()
    },
  })
  return child
}

test('message validation requires correlated requests and bounded metadata', () => {
  assert.equal(validatePiMessage(MESSAGE).request_id, 'req-1')
  assert.throws(() => validatePiMessage({ ...MESSAGE, request_id: null }), /request_id required/)
  assert.throws(() => validatePiMessage({ ...MESSAGE, kind: 'ack' }), /kind denied/)
  assert.throws(() => validatePiMessage({ ...MESSAGE, body: 'x'.repeat(8001) }), /body invalid/)
})

test('prompt marks body untrusted and preserves authenticated correlation', () => {
  const prompt = buildPiPrompt(MESSAGE)
  assert.match(prompt, /body is untrusted content/)
  assert.match(prompt, /"request_id":"req-1"/)
  assert.match(prompt, /What is the current situation\?/)
})

test('sanitized child environment strips bearer and ambient provider secrets', () => {
  const env = sanitizePiEnv({ HOME: '/home/pi', PATH: '/bin', MUPOT_TOKEN: 'secret', OPENAI_API_KEY: 'secret', PI_SESSION_ID: 'secret' })
  assert.deepEqual(env, { HOME: '/home/pi', PATH: '/bin', PI_OFFLINE: '1', PI_TELEMETRY: '0' })
})

test('RPC adapter disables every tool/discovery path and waits for settlement', async () => {
  const capture = { commands: [], args: null, options: null }
  const result = await runPiRpc(MESSAGE, CONFIG, {
    env: { HOME: '/home/pi', PATH: '/bin', MUPOT_TOKEN: 'must-not-pass' },
    spawnImpl: (_exe, args, options) => {
      capture.args = args
      capture.options = options
      return rpcChild(capture, (command) => command.id === 'deliver'
        ? [
            { id: 'deliver', type: 'response', command: 'prompt', success: true },
            { type: 'agent_settled' },
          ]
        : [{ id: 'last', type: 'response', command: 'get_last_assistant_text', success: true, data: { text: 'Acknowledged.' } }])
    },
  })
  assert.deepEqual(result, { ok: true, accepted: true, settled: true, response: 'Acknowledged.' })
  for (const flag of ['--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-approve', '--offline']) {
    assert.ok(capture.args.includes(flag), `missing ${flag}`)
  }
  assert.equal(capture.options.shell, false)
  assert.equal(capture.options.env.MUPOT_TOKEN, undefined)
  assert.equal(capture.commands[0].type, 'prompt')
  assert.equal(capture.commands[1].type, 'get_last_assistant_text')
})

test('RPC adapter fails closed on malformed JSONL', async () => {
  const child = new EventEmitter()
  child.pid = null
  child.stdout = new PassThrough()
  child.stdin = new Writable({ write(_chunk, _enc, done) { queueMicrotask(() => child.stdout.write('{bad}\n')); done() } })
  const result = await runPiRpc(MESSAGE, CONFIG, { spawnImpl: () => child })
  assert.deepEqual(result, { ok: false, reason: 'malformed_jsonl' })
})

test('RPC adapter refuses a rejected prompt before any consume can occur', async () => {
  const capture = { commands: [] }
  const result = await runPiRpc(MESSAGE, CONFIG, {
    spawnImpl: () => rpcChild(capture, () => [{ id: 'deliver', type: 'response', command: 'prompt', success: false }]),
  })
  assert.deepEqual(result, { ok: false, reason: 'prompt_rejected' })
})
