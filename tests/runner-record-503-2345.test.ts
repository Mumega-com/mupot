// mupot#2345: runner_record maps the signer-liveness "unavailable" error to a retryable 503, not a 400 about the request.
import { describe, expect, it, vi } from 'vitest'
import type { AuthContext, Env } from '../src/types'
import { BoundAgentCheckUnavailableError } from '../src/auth/bound-agent-live'

vi.mock('../src/runners/service', () => ({
  recordRunner: vi.fn(async () => { throw new BoundAgentCheckUnavailableError() }),
  listRunners: vi.fn(),
}))
import { invokeTool } from '../src/mcp/index'

describe('runner_record', () => {
  it('check-unavailable -> 503 agent_check_unavailable', async () => {
    const auth = { boundAgentId: 'agent-a', memberId: 'm', userId: 'm', role: 'member', tenant: 't', channel: 'workspace', capabilities: [{ member_id: 'm', scope_type: 'org', scope_id: null, capability: 'admin' }] } as unknown as AuthContext
    const out = await invokeTool(auth, { TENANT_SLUG: 't' } as unknown as Env, 'runner_record', { name: 'n', task: 't', status: 'running' }, {} as never)
    expect(out).toMatchObject({ ok: false, status: 503, error: 'agent_check_unavailable' })
  })
  it('any other failure stays a 400 with its message', async () => {
    const svc = await import('../src/runners/service')
    vi.mocked(svc.recordRunner).mockRejectedValueOnce(new Error('invalid_signature: x'))
    const auth = { boundAgentId: 'agent-a', memberId: 'm', userId: 'm', role: 'member', tenant: 't', channel: 'workspace', capabilities: [{ member_id: 'm', scope_type: 'org', scope_id: null, capability: 'admin' }] } as unknown as AuthContext
    expect(await invokeTool(auth, { TENANT_SLUG: 't' } as unknown as Env, 'runner_record', { name: 'n', task: 't', status: 'running' }, {} as never)).toMatchObject({ ok: false, status: 400 })
  })
})
