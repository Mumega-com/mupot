// tests/runner-receipts.test.ts — Flight-004 TENTACLES: Runner Receipts (Real SQL)
//
// Tests D1 runner_receipts table, recordRunner / listRunners service functions,
// and MCP tools (runner_record, runner_list) with squad and seat scoping.

import { describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { recordRunner, listRunners } from '../src/runners/service'
import { mcpApp } from '../src/mcp/index'
import { AUTH_CONTEXT_HEADER } from '../src/mcp/auth-header'
import type { Env, AuthContext } from '../src/types'

async function makeHarness(): Promise<SqliteD1Harness> {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)

  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES
      ('dept-a', 'dept-a', 'Department A'),
      ('dept-b', 'dept-b', 'Department B');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('squad-a', 'dept-a', 'squad-a', 'Squad Alpha'),
      ('squad-b', 'dept-b', 'squad-b', 'Squad Beta');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('agent-a', 'squad-a', 'agent-a', 'Agent Alpha', 'operator', 'test', 'active'),
      ('agent-b', 'squad-b', 'agent-b', 'Agent Beta', 'operator', 'test', 'active');

    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('member-zero', 'zero@test.com', 'Zero Cap', 'active', 'mumega'),
      ('member-squad-a', 'squad-a@test.com', 'Squad A Member', 'active', 'mumega'),
      ('member-squad-b', 'squad-b@test.com', 'Squad B Member', 'active', 'mumega'),
      ('member-org', 'org@test.com', 'Org Admin', 'active', 'mumega');

    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('cap-squad-a', 'member-squad-a', 'squad', 'squad-a', 'member'),
      ('cap-squad-b', 'member-squad-b', 'squad', 'squad-b', 'member'),
      ('cap-org', 'member-org', 'org', NULL, 'admin');
  `)

  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  return {
    DB: harness.db,
    TENANT_SLUG: 'mumega',
  } as unknown as Env
}

function mcpRequest(tool: string, args: Record<string, unknown>, auth: AuthContext): Request {
  return new Request('http://localhost/', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [AUTH_CONTEXT_HEADER]: JSON.stringify(auth),
    },
    body: JSON.stringify({ tool, args }),
  })
}

describe('Flight-004 Tentacles: Runner Receipts', () => {
  it('recordRunner creates and updates a runner lifecycle record', async () => {
    const harness = await makeHarness()
    const env = envFor(harness)

    const runnerId = 'run-gate-1054'
    const spawned = await recordRunner(env, {
      id: runnerId,
      seat_agent_id: 'agent-a',
      name: 'gate1054x-final',
      task: 'Adversarial gate review for PR 1054',
      status: 'running',
      started_at: 1000,
    })

    expect(spawned.id).toBe(runnerId)
    expect(spawned.seat_agent_id).toBe('agent-a')
    expect(spawned.squad_id).toBe('squad-a') // auto-derived from agent
    expect(spawned.status).toBe('running')
    expect(spawned.ended_at).toBeNull()

    const landed = await recordRunner(env, {
      id: runnerId,
      seat_agent_id: 'agent-a',
      name: 'gate1054x-final',
      task: 'Adversarial gate review for PR 1054',
      status: 'landed',
      evidence_summary: '39/39 tests green, 0 leaks',
      verdict_line: 'APPROVED',
      ended_at: 2000,
    })

    expect(landed.id).toBe(runnerId)
    expect(landed.status).toBe('landed')
    expect(landed.ended_at).toBe(2000)
    expect(landed.evidence_summary).toBe('39/39 tests green, 0 leaks')
    expect(landed.verdict_line).toBe('APPROVED')
  })

  it('listRunners filters by status and squad', async () => {
    const harness = await makeHarness()
    const env = envFor(harness)

    await recordRunner(env, {
      id: 'run-a1',
      seat_agent_id: 'agent-a',
      name: 'cleanup-a',
      task: 'cleanup old dirs',
      status: 'landed',
    })
    await recordRunner(env, {
      id: 'run-a2',
      seat_agent_id: 'agent-a',
      name: 'verify-a',
      task: 'verify build',
      status: 'running',
    })
    await recordRunner(env, {
      id: 'run-b1',
      seat_agent_id: 'agent-b',
      name: 'gate-b',
      task: 'gate review b',
      status: 'failed',
    })

    const allSquadA = await listRunners(env, { squad_ids: ['squad-a'] })
    expect(allSquadA.map((r) => r.id)).toEqual(['run-a2', 'run-a1'])

    const runningSquadA = await listRunners(env, { squad_ids: ['squad-a'], status: 'running' })
    expect(runningSquadA.map((r) => r.id)).toEqual(['run-a2'])

    const failedAll = await listRunners(env, { status: 'failed' })
    expect(failedAll.map((r) => r.id)).toEqual(['run-b1'])

    const emptyScope = await listRunners(env, { squad_ids: [] })
    expect(emptyScope).toEqual([])
  })

  it('MCP tool runner_record & runner_list end-to-end with authz scoping', async () => {
    const harness = await makeHarness()
    const env = envFor(harness)

    const authSquadA: AuthContext = {
      userId: 'member-squad-a',
      tenant: 'mumega',
      channel: 'workspace',
      memberId: 'member-squad-a',
      role: 'member',
      boundAgentId: 'agent-a',
      capabilities: [{ scope_type: 'squad', scope_id: 'squad-a', capability: 'member' }],
    }

    const authSquadB: AuthContext = {
      userId: 'member-squad-b',
      tenant: 'mumega',
      channel: 'workspace',
      memberId: 'member-squad-b',
      role: 'member',
      boundAgentId: 'agent-b',
      capabilities: [{ scope_type: 'squad', scope_id: 'squad-b', capability: 'member' }],
    }

    const authOrg: AuthContext = {
      userId: 'member-org',
      tenant: 'mumega',
      channel: 'workspace',
      memberId: 'member-org',
      role: 'admin',
      capabilities: [{ scope_type: 'org', scope_id: null, capability: 'admin' }],
    }

    // Squad A creates runner
    const recRes = await mcpApp.fetch(
      mcpRequest(
        'runner_record',
        {
          id: 'run-secret-rotate',
          name: 'secret-rotate',
          task: 'rotate webhook secret',
          status: 'running',
          log_url: 'file:///tmp/logs/secret-rotate.log',
        },
        authSquadA,
      ),
      env,
    )
    expect(recRes.status).toBe(200)
    const recBody = (await recRes.json()) as { ok: boolean; result: { receipt: { id: string; squad_id: string } } }
    expect(recBody.ok).toBe(true)
    expect(recBody.result.receipt.id).toBe('run-secret-rotate')
    expect(recBody.result.receipt.squad_id).toBe('squad-a')

    // Squad B creates runner
    await mcpApp.fetch(
      mcpRequest(
        'runner_record',
        {
          id: 'run-gate-b',
          name: 'gate-review-b',
          task: 'gate review for squad b',
          status: 'failed',
          verdict_line: 'REJECTED: missing evidence',
        },
        authSquadB,
      ),
      env,
    )

    // Squad A caller lists runners -> sees ONLY squad-a runner
    const listResA = await mcpApp.fetch(mcpRequest('runner_list', {}, authSquadA), env)
    expect(listResA.status).toBe(200)
    const listBodyA = (await listResA.json()) as { ok: boolean; result: { runners: Array<{ id: string }> } }
    expect(listBodyA.result.runners.map((r) => r.id)).toEqual(['run-secret-rotate'])

    // Squad B caller lists runners -> sees ONLY squad-b runner
    const listResB = await mcpApp.fetch(mcpRequest('runner_list', {}, authSquadB), env)
    expect(listResB.status).toBe(200)
    const listBodyB = (await listResB.json()) as { ok: boolean; result: { runners: Array<{ id: string }> } }
    expect(listBodyB.result.runners.map((r) => r.id)).toEqual(['run-gate-b'])

    // Zero-capability caller -> 403 (fail closed at F2 capability floor)
    const authZero: AuthContext = {
      userId: 'member-zero',
      tenant: 'mumega',
      channel: 'workspace',
      memberId: 'member-zero',
      role: 'member',
      capabilities: [],
    }
    const listResZero = await mcpApp.fetch(mcpRequest('runner_list', {}, authZero), env)
    expect(listResZero.status).toBe(403)

    // Squad A caller requesting foreign squad-b explicitly -> 403
    const listResForeign = await mcpApp.fetch(mcpRequest('runner_list', { squad_id: 'squad-b' }, authSquadA), env)
    expect(listResForeign.status).toBe(403)
  })

  it('validation and constraint fail-closed tests', async () => {
    const harness = await makeHarness()
    const env = envFor(harness)

    // Missing seat_agent_id and callerAgentId -> error
    await expect(recordRunner(env, { name: 'test', task: 'test', status: 'running' })).rejects.toThrow('seat_agent_id_required')

    // Invalid status -> error
    await expect(recordRunner(env, { seat_agent_id: 'agent-a', name: 'test', task: 'test', status: 'invalid' as any })).rejects.toThrow('invalid_status')

    // Missing name -> error
    await expect(recordRunner(env, { seat_agent_id: 'agent-a', name: '', task: 'test', status: 'running' })).rejects.toThrow('name_required')

    // Missing task -> error
    await expect(recordRunner(env, { seat_agent_id: 'agent-a', name: 'test', task: '', status: 'running' })).rejects.toThrow('task_required')

    // Seat spoofing rejected
    await expect(recordRunner(env, { seat_agent_id: 'agent-b', name: 'test', task: 'test', status: 'running' }, 'agent-a')).rejects.toThrow('forbidden_seat_spoofing')

    // Record a landed runner
    await recordRunner(env, { id: 'run-locked', seat_agent_id: 'agent-a', name: 'test', task: 'test', status: 'landed' }, 'agent-a')

    // Cross-seat mutation rejected
    await expect(recordRunner(env, { id: 'run-locked', seat_agent_id: 'agent-b', name: 'test', task: 'test', status: 'landed' }, 'agent-b')).rejects.toThrow('forbidden_cross_seat_mutation')

    // Terminal status reversal rejected
    await expect(recordRunner(env, { id: 'run-locked', seat_agent_id: 'agent-a', name: 'test', task: 'test', status: 'running' }, 'agent-a')).rejects.toThrow('invalid_status_transition')

    // Unsafe log_url schemes rejected (e.g. javascript:, data:, vbscript:)
    await expect(recordRunner(env, { seat_agent_id: 'agent-a', name: 'test', task: 'test', status: 'running', log_url: 'javascript:alert(1)' })).rejects.toThrow('invalid_log_url')
    await expect(recordRunner(env, { seat_agent_id: 'agent-a', name: 'test', task: 'test', status: 'running', log_url: 'data:text/html,<script>alert(1)</script>' })).rejects.toThrow('invalid_log_url')

    // Safe log_url schemes allowed
    const safeRun = await recordRunner(env, { seat_agent_id: 'agent-a', name: 'test', task: 'test', status: 'running', log_url: 'https://logs.mumega.com/run-1' })
    expect(safeRun.log_url).toBe('https://logs.mumega.com/run-1')

    // Cross-squad mismatch rejected
    await expect(recordRunner(env, { seat_agent_id: 'agent-a', squad_id: 'squad-b', name: 'test', task: 'test', status: 'running' })).rejects.toThrow('forbidden_cross_squad_mutation')
  })

  it('kill-witness: unbound member token cannot record for foreign seat agent (403)', async () => {
    const harness = await makeHarness()
    const env = envFor(harness)

    const authSquadA: AuthContext = {
      userId: 'member-a',
      tenant: 'mumega',
      channel: 'workspace',
      memberId: 'member-a',
      role: 'member',
      capabilities: [{ type: 'squad', id: 'squad-a', capability: 'member' }],
    }

    // Unbound member on squad-a tries to record for agent-b (squad-b) -> 403
    const res = await mcpApp.fetch(
      mcpRequest('runner_record', {
        seat_agent_id: 'agent-b',
        name: 'test-unbound',
        task: 'fabricated evidence',
        status: 'landed',
      }, authSquadA),
      env,
    )
    expect(res.status).toBe(403)
  })
})

