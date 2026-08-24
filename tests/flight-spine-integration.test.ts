import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendExecutionReceipt } from '../src/flight-spine/receipts'
import { invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'tenant-mcp-flight-spine'
const NOW = '2030-08-23T16:00:00.000Z'
const PRIMARY_MEMBER_ID = 'member-command'
const PRIMARY_AGENT_ID = 'agent-command'
const PRIMARY_TOKEN_ID = 'token-command'
const PRIMARY_SQUAD_ID = 'squad-command'
const OTHER_MEMBER_ID = 'member-other'
const OTHER_AGENT_ID = 'agent-other'
const OTHER_TOKEN_ID = 'token-other'
const OTHER_SQUAD_ID = 'squad-other'
const PROJECT_ID = 'project-command'
const TOKEN_HASH = 'a'.repeat(64)
const OTHER_TOKEN_HASH = 'b'.repeat(64)

type TestEnv = Env & { MEMBER_TOKEN_FINGERPRINT_SECRET: string }

let harness: SqliteD1Harness
let env: TestEnv

function primaryAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: PRIMARY_MEMBER_ID,
    memberId: PRIMARY_MEMBER_ID,
    email: 'command@example.test',
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    tokenId: PRIMARY_TOKEN_ID,
    boundAgentId: PRIMARY_AGENT_ID,
    capabilities: [{
      member_id: PRIMARY_MEMBER_ID,
      scope_type: 'squad',
      scope_id: PRIMARY_SQUAD_ID,
      capability: 'member',
    }],
    ...overrides,
  }
}

function otherAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: OTHER_MEMBER_ID,
    memberId: OTHER_MEMBER_ID,
    email: 'other@example.test',
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    tokenId: OTHER_TOKEN_ID,
    boundAgentId: OTHER_AGENT_ID,
    capabilities: [{
      member_id: OTHER_MEMBER_ID,
      scope_type: 'squad',
      scope_id: OTHER_SQUAD_ID,
      capability: 'member',
    }],
    ...overrides,
  }
}

function objectiveArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    squadId: PRIMARY_SQUAD_ID,
    projectId: null,
    title: 'Accept the bounded Flight Spine objective',
    successContract: 'The Task 7 integration tests pass.',
    authorityEnvelope: { mode: 'supervised', deploy: false },
    policy: { allowRuntimeActivation: false },
    budgetMicroUsd: 0,
    payload: { flight: 2, task: 7 },
    idempotencyKey: 'mcp-objective-primary',
    ...overrides,
  }
}

async function invoke(
  tool: string,
  args: Record<string, unknown>,
  auth: AuthContext = primaryAuth(),
) {
  const pending: Promise<unknown>[] = []
  const outcome = await invokeTool(auth, env, tool, args, {
    origin: 'https://mupot.example.test',
    waitUntil(promise) {
      pending.push(promise)
    },
  })
  await Promise.all(pending)
  return outcome
}

function count(table: string): number {
  return Number(harness.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(NOW))
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES
      ('department-command', 'command', 'Command'),
      ('department-other', 'other', 'Other');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('${PRIMARY_SQUAD_ID}', 'department-command', 'command', 'Command'),
      ('${OTHER_SQUAD_ID}', 'department-other', 'other', 'Other');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('${PRIMARY_AGENT_ID}', '${PRIMARY_SQUAD_ID}', 'command', 'Command Agent', 'member', 'test', 'active'),
      ('${OTHER_AGENT_ID}', '${OTHER_SQUAD_ID}', 'other', 'Other Agent', 'member', 'test', 'active');
    INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES
      ('membership-command', '${PRIMARY_AGENT_ID}', '${PRIMARY_SQUAD_ID}', 'member'),
      ('membership-other', '${OTHER_AGENT_ID}', '${OTHER_SQUAD_ID}', 'member');
    INSERT INTO members (id, display_name, status, tenant) VALUES
      ('${PRIMARY_MEMBER_ID}', 'Command Member', 'active', '${TENANT}'),
      ('${OTHER_MEMBER_ID}', 'Other Member', 'active', '${TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES
      ('${TENANT}', '${PRIMARY_AGENT_ID}', '${PRIMARY_MEMBER_ID}', '2026-08-23T15:00:00.000Z'),
      ('${TENANT}', '${OTHER_AGENT_ID}', '${OTHER_MEMBER_ID}', '2026-08-23T15:00:00.000Z');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('capability-command', '${PRIMARY_MEMBER_ID}', 'squad', '${PRIMARY_SQUAD_ID}', 'member'),
      ('capability-other', '${OTHER_MEMBER_ID}', 'squad', '${OTHER_SQUAD_ID}', 'member');
    INSERT INTO member_tokens (
      id, member_id, token_hash, label, channel, created_at, revoked_at,
      agent_id, tenant, expires_at
    ) VALUES
      (
        '${PRIMARY_TOKEN_ID}', '${PRIMARY_MEMBER_ID}', '${TOKEN_HASH}',
        'codex-desktop-command', 'workspace', '2026-08-23T15:00:00.000Z',
        NULL, '${PRIMARY_AGENT_ID}', '${TENANT}', '2031-08-23T16:00:00.000Z'
      ),
      (
        '${OTHER_TOKEN_ID}', '${OTHER_MEMBER_ID}', '${OTHER_TOKEN_HASH}',
        'other-command', 'workspace', '2026-08-23T15:00:00.000Z',
        NULL, '${OTHER_AGENT_ID}', '${TENANT}', '2031-08-23T16:00:00.000Z'
      );
    INSERT INTO projects (id, slug, name, status)
      VALUES ('${PROJECT_ID}', 'project-command', 'Project Command', 'active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level)
      VALUES ('${PROJECT_ID}', '${PRIMARY_SQUAD_ID}', 'write');
  `)
  env = {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    MEMBER_TOKEN_FINGERPRINT_SECRET: 'dedicated-flight-spine-test-secret',
  } as TestEnv
})

afterEach(() => {
  vi.useRealTimers()
  harness.close()
})

describe('Flight Spine MCP integration', () => {
  it('attests the current token, registers only a pending command seat, and replays an objective', async () => {
    const attested = await invoke('token_binding_attest', {})
    expect(attested.ok).toBe(true)
    const attestation = (attested.result as { attestation: Record<string, unknown> }).attestation
    expect(attestation).toMatchObject({
      tokenId: PRIMARY_TOKEN_ID,
      memberId: PRIMARY_MEMBER_ID,
      agentId: PRIMARY_AGENT_ID,
      channel: 'workspace',
      credentialFingerprint: expect.stringMatching(/^v1:[0-9a-f]{64}$/),
      issuedAt: NOW,
    })
    expect(JSON.stringify(attestation)).not.toContain(TOKEN_HASH)

    const otherAttested = await invoke('token_binding_attest', {}, otherAuth())
    expect(otherAttested.ok).toBe(true)
    const otherAttestation = (
      otherAttested.result as { attestation: { id: string } }
    ).attestation
    const mismatchedAttestation = await invoke('runtime_seat_register_pending', {
      seatName: 'forged-command-seat',
      hostId: 'hadi-mac',
      adapterKind: 'codex-desktop',
      attestationId: otherAttestation.id,
    })
    expect(mismatchedAttestation).toMatchObject({
      ok: false,
      status: 404,
      error: 'attestation_not_found',
    })
    expect(count('runtime_seats')).toBe(0)

    const registered = await invoke('runtime_seat_register_pending', {
      seatName: 'codex-desktop-command',
      hostId: 'hadi-mac',
      adapterKind: 'codex-desktop',
      attestationId: attestation.id,
    })
    expect(registered.ok).toBe(true)
    const seat = (registered.result as { seat: Record<string, unknown> }).seat
    expect(seat).toMatchObject({
      agentId: PRIMARY_AGENT_ID,
      seatName: 'codex-desktop-command',
      hostId: 'hadi-mac',
      adapterKind: 'codex-desktop',
      state: 'pending',
      currentGeneration: 0,
      currentFencingEpoch: 0,
      processPublicKey: null,
      capabilities: [],
      lastHeartbeatAt: null,
    })
    expect(count('runtime_seat_generations')).toBe(0)
    expect(count('runtime_seat_leases')).toBe(0)

    const first = await invoke('objective_accept', objectiveArgs())
    const replay = await invoke('objective_accept', objectiveArgs())
    expect(first.ok).toBe(true)
    expect(replay).toEqual(first)
    const objective = (first.result as { objective: Record<string, unknown> }).objective
    expect(objective).toMatchObject({
      tenant: TENANT,
      squadId: PRIMARY_SQUAD_ID,
      projectId: null,
      title: 'Accept the bounded Flight Spine objective',
      acceptedAt: NOW,
    })
    expect(count('objectives')).toBe(1)
    expect(count('execution_receipts')).toBe(2)

    const reread = await invoke('objective_get', { objectiveId: objective.id })
    expect(reread).toEqual({ ok: true, result: { objective }, tool: 'objective_get' })

    const receiptRead = await invoke('execution_receipt_get', {
      receiptId: objective.acceptanceReceiptId,
    })
    expect(receiptRead).toMatchObject({
      ok: true,
      result: {
        receipt: {
          id: objective.acceptanceReceiptId,
          type: 'objective.accepted',
          actorKind: 'agent',
          actorId: PRIMARY_AGENT_ID,
          objectiveId: objective.id,
        },
      },
    })
  })

  it('rechecks live token and squad authority instead of trusting stale auth facts', async () => {
    const attested = await invoke('token_binding_attest', {})
    expect(attested.ok).toBe(true)
    const attestation = (attested.result as { attestation: { id: string } }).attestation

    harness.sqlite.prepare(
      "UPDATE memberships SET capability = 'observer' WHERE id = 'membership-command'",
    ).run()
    const refusedObjective = await invoke('objective_accept', objectiveArgs({
      idempotencyKey: 'objective-after-membership-downgrade',
    }))
    expect(refusedObjective).toMatchObject({
      ok: false,
      status: 403,
      error: 'objective_forbidden',
    })
    expect(count('objectives')).toBe(0)

    harness.sqlite.prepare(
      "DELETE FROM capabilities WHERE id = 'capability-command'",
    ).run()
    const staleCapabilityAttestation = await invoke('token_binding_attest', {})
    expect(staleCapabilityAttestation).toMatchObject({
      ok: false,
      status: 403,
      error: 'forbidden',
    })
    const staleCapabilitySeat = await invoke('runtime_seat_register_pending', {
      seatName: 'stale-capability-seat',
      hostId: 'hadi-mac',
      adapterKind: 'codex-desktop',
      attestationId: attestation.id,
    })
    expect(staleCapabilitySeat).toMatchObject({
      ok: false,
      status: 403,
      error: 'forbidden',
    })
    expect(count('runtime_seats')).toBe(0)

    harness.sqlite.exec(`
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES (
          'capability-command-restored', '${PRIMARY_MEMBER_ID}',
          'squad', '${PRIMARY_SQUAD_ID}', 'member'
        );
    `)
    harness.sqlite.prepare(
      "UPDATE member_tokens SET revoked_at = ? WHERE id = ?",
    ).run(NOW, PRIMARY_TOKEN_ID)
    const refusedAttestation = await invoke('token_binding_attest', {})
    expect(refusedAttestation).toMatchObject({
      ok: false,
      status: 403,
      error: 'workspace_token_required',
    })
    expect(count('token_binding_attestations')).toBe(1)
  })

  it('returns not_found for non-visible or unresolvable objective and receipt correlations', async () => {
    const projectObjective = await invoke('objective_accept', objectiveArgs({
      projectId: PROJECT_ID,
      idempotencyKey: 'objective-project-visible',
    }))
    expect(projectObjective.ok).toBe(true)
    const projectValue = (projectObjective.result as { objective: Record<string, unknown> }).objective

    harness.sqlite.prepare(
      'DELETE FROM project_squad_access WHERE project_id = ? AND squad_id = ?',
    ).run(PROJECT_ID, PRIMARY_SQUAD_ID)
    expect(await invoke('objective_get', { objectiveId: projectValue.id })).toMatchObject({
      ok: false,
      status: 404,
      error: 'objective_not_found',
    })
    expect(await invoke('execution_receipt_get', {
      receiptId: projectValue.acceptanceReceiptId,
    })).toMatchObject({
      ok: false,
      status: 404,
      error: 'receipt_not_found',
    })

    const otherObjective = await invoke('objective_accept', objectiveArgs({
      squadId: OTHER_SQUAD_ID,
      projectId: null,
      idempotencyKey: 'objective-other-squad',
    }), otherAuth())
    expect(otherObjective.ok).toBe(true)
    const otherValue = (otherObjective.result as { objective: Record<string, unknown> }).objective
    expect(await invoke('objective_get', { objectiveId: otherValue.id })).toMatchObject({
      ok: false,
      status: 404,
      error: 'objective_not_found',
    })
    expect(await invoke('execution_receipt_get', {
      receiptId: otherValue.acceptanceReceiptId,
    })).toMatchObject({
      ok: false,
      status: 404,
      error: 'receipt_not_found',
    })

    const visibleObjective = await invoke('objective_accept', objectiveArgs({
      projectId: null,
      idempotencyKey: 'objective-visible-no-project',
    }))
    expect(visibleObjective.ok).toBe(true)
    const visibleValue = (visibleObjective.result as { objective: Record<string, unknown> }).objective
    harness.sqlite.exec(`
      INSERT INTO tasks (
        id, squad_id, title, done_when, status, assignment_epoch
      ) VALUES (
        'task-visible-no-project', '${PRIMARY_SQUAD_ID}', 'Visible task',
        'Receipt remains tenant scoped', 'open', 1
      );
    `)
    const taskReceipt = await appendExecutionReceipt(env, primaryAuth(), {
      type: 'task.assigned',
      idempotencyKey: 'visible-task-assigned-receipt',
      taskId: 'task-visible-no-project',
      assignmentEpoch: 1,
      claims: { assigned: true },
    })
    expect(await invoke(
      'execution_receipt_get',
      { receiptId: taskReceipt.id },
      primaryAuth({ tenant: 'tenant-other-environment' }),
    )).toMatchObject({
      ok: false,
      status: 404,
      error: 'receipt_not_found',
    })

    const uncorrelated = await appendExecutionReceipt(env, primaryAuth(), {
      type: 'objective.accepted',
      idempotencyKey: 'uncorrelated-objective-receipt',
      claims: { accepted: true },
    })
    expect(await invoke('execution_receipt_get', { receiptId: uncorrelated.id })).toMatchObject({
      ok: false,
      status: 404,
      error: 'receipt_not_found',
    })

    const hostControl = await appendExecutionReceipt(env, primaryAuth(), {
      type: 'host_control.requested',
      idempotencyKey: 'restricted-host-control-receipt',
      objectiveId: visibleValue.id,
      claims: { requested: true },
    })
    expect(await invoke('execution_receipt_get', { receiptId: hostControl.id })).toMatchObject({
      ok: false,
      status: 404,
      error: 'receipt_not_found',
    })
  })
})
