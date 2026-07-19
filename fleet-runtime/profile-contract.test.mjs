import test from 'node:test'
import assert from 'node:assert/strict'

import {
  AGENT_PROFILE_SCHEMA,
  normalizeAgentProfile,
  validateAgentProfile,
} from './profile-contract.mjs'

function validProfile() {
  return {
    schema: AGENT_PROFILE_SCHEMA,
    agent_id: 'hadi-mupot-dme',
    adapter: 'hermes',
    command: ['/opt/homebrew/bin/hermes', 'chat', '--toolsets', 'mumega_dme'],
    allowed_senders: ['hadi-codex-cli'],
    allowed_project_ids: ['project-a'],
    run_for: ['request'],
    timeout_ms: 120000,
  }
}

test('accepts an exact least-privilege agent profile', () => {
  const profile = validProfile()
  assert.deepEqual(normalizeAgentProfile(profile), profile)
  assert.deepEqual(validateAgentProfile(profile), profile)
})

test('rejects unknown fields, relative executables, shell strings, and acknowledgement activation', () => {
  const unknown = { ...validProfile(), fabricated: true }
  const relative = { ...validProfile(), command: ['hermes', 'chat'] }
  const shell = { ...validProfile(), command: '/opt/homebrew/bin/hermes chat' }
  const ack = { ...validProfile(), run_for: ['ack'] }

  for (const profile of [unknown, relative, shell, ack]) {
    assert.equal(normalizeAgentProfile(profile), null)
  }
})

test('rejects duplicate policy values, unbounded arrays, and secret-looking command arguments', () => {
  const duplicateSender = { ...validProfile(), allowed_senders: ['hadi-codex-cli', 'hadi-codex-cli'] }
  const tooManyArgs = { ...validProfile(), command: ['/bin/echo', ...Array.from({ length: 64 }, () => 'x')] }
  const bearer = { ...validProfile(), command: ['/bin/echo', 'Bearer abcdefghijklmnopqrstuvwxyz'] }
  const token = { ...validProfile(), command: ['/bin/echo', 'mupot_abcdefghijklmnopqrstuvwxyz'] }

  for (const profile of [duplicateSender, tooManyArgs, bearer, token]) {
    assert.equal(normalizeAgentProfile(profile), null)
  }
})

test('rejects wildcard senders and invalid timeout bounds', () => {
  assert.equal(normalizeAgentProfile({ ...validProfile(), allowed_senders: ['*'] }), null)
  assert.equal(normalizeAgentProfile({ ...validProfile(), timeout_ms: 999 }), null)
  assert.equal(normalizeAgentProfile({ ...validProfile(), timeout_ms: 600001 }), null)
})

test('requires an exact non-wildcard project allowlist', () => {
  assert.equal(normalizeAgentProfile({ ...validProfile(), allowed_project_ids: undefined }), null)
  assert.equal(normalizeAgentProfile({ ...validProfile(), allowed_project_ids: [] }), null)
  assert.equal(normalizeAgentProfile({ ...validProfile(), allowed_project_ids: ['*'] }), null)
  assert.equal(normalizeAgentProfile({ ...validProfile(), allowed_project_ids: ['project-a', 'project-a'] }), null)
})

test('allows Hermes to inherit only its declared operator credential environment', () => {
  const profile = {
    ...validProfile(),
    inherited_env: ['MUPOT_AGENT_TOKEN_FILE', 'MUPOT_PLUGIN_MODE'],
  }
  assert.deepEqual(normalizeAgentProfile(profile), profile)
  assert.equal(normalizeAgentProfile({ ...profile, inherited_env: ['MUPOT_AGENT_TOKEN_FILE', 'MUPOT_AGENT_TOKEN_FILE'] }), null)
  assert.equal(normalizeAgentProfile({ ...profile, inherited_env: ['MUPOT_AGENT_TOKEN'] }), null)
  assert.equal(normalizeAgentProfile({ ...profile, inherited_env: ['OPENAI_API_KEY'] }), null)
  assert.equal(normalizeAgentProfile({ ...profile, adapter: 'codex' }), null)
})
