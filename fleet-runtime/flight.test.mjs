// node --test flight.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateFlights } from './flight.mjs'

const ok = () => ({
  base_url: 'https://your-pot.example.com',
  tenant: 'acme',
  agents: [{ agent_id: 'a1', type: 'builder', runtime: 'claude-code', launch: 'tmux new-session -d -s a1 sleep 999', teardown: 'tmux kill-session -t a1' }],
})

test('validateFlights: normalizes a valid config', () => {
  const c = validateFlights(ok())
  assert.equal(c.tenant, 'acme')
  assert.equal(c.agents.get('a1').launch, 'tmux new-session -d -s a1 sleep 999')
  assert.equal(c.agents.get('a1').type, 'builder')
})

test('validateFlights: STERILE — tenant required', () => {
  const { tenant, ...noT } = ok()
  assert.throws(() => validateFlights(noT), /tenant is required/)
})

test('validateFlights: base_url must be http(s)', () => {
  assert.throws(() => validateFlights({ ...ok(), base_url: 'x' }), /base_url/)
})

test('validateFlights: launch command required', () => {
  assert.throws(() => validateFlights({ ...ok(), agents: [{ agent_id: 'a1', launch: '  ' }] }), /launch/)
})

test('validateFlights: bad agent_id rejected', () => {
  assert.throws(() => validateFlights({ ...ok(), agents: [{ agent_id: 'BAD', launch: 'true' }] }), /agent_id/)
})

test('validateFlights: teardown optional (defaults empty)', () => {
  const c = validateFlights({ ...ok(), agents: [{ agent_id: 'a1', launch: 'true' }] })
  assert.equal(c.agents.get('a1').teardown, '')
})

test('validateFlights: duplicate agent_id rejected (no silent last-win)', () => {
  assert.throws(() => validateFlights({ ...ok(), agents: [
    { agent_id: 'a1', launch: 'true' }, { agent_id: 'a1', launch: 'false' },
  ] }), /duplicate agent_id/)
})
