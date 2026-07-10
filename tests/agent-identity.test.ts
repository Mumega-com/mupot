import { describe, expect, it } from 'vitest'
import { resolveAgentIdentity } from '../src/agents/identity'

describe('resolveAgentIdentity', () => {
  it('binds the first supplied logical agent id', () => {
    expect(resolveAgentIdentity(null, 'agent-hermes')).toEqual({
      ok: true,
      agentId: 'agent-hermes',
      bind: true,
    })
  })

  it('uses an existing binding when alarms wake without a supplied id', () => {
    expect(resolveAgentIdentity('agent-hermes', undefined)).toEqual({
      ok: true,
      agentId: 'agent-hermes',
      bind: false,
    })
  })

  it('fails closed when an unbound or mismatched identity is supplied', () => {
    expect(resolveAgentIdentity(null, undefined)).toEqual({ ok: false, error: 'agent_identity_required' })
    expect(resolveAgentIdentity('agent-hermes', 'agent-other')).toEqual({ ok: false, error: 'agent_identity_mismatch' })
  })
})
