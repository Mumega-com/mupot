import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  appendExecutionReceipt,
  type ExecutionReceiptDraft,
} from '../src/flight-spine/receipts'
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
const SECOND_PROJECT_ID = 'project-command-two'
const HIDDEN_PROJECT_ID = 'project-hidden'
const TOKEN_HASH = 'a'.repeat(64)
const OTHER_TOKEN_HASH = 'b'.repeat(64)

const PUBLIC_RECEIPT_KEYS = [
  'actorId',
  'actorKind',
  'assignmentEpoch',
  'flightId',
  'id',
  'objectiveId',
  'payloadDigest',
  'receiptHash',
  'serverTimestamp',
  'taskId',
  'type',
] as const

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

interface ObjectiveFixture {
  id: string
  squadId: string
  projectId: string | null
  acceptanceReceiptId: string
}

function dualSquadAuth(): AuthContext {
  return primaryAuth({
    capabilities: [
      {
        member_id: PRIMARY_MEMBER_ID,
        scope_type: 'squad',
        scope_id: PRIMARY_SQUAD_ID,
        capability: 'member',
      },
      {
        member_id: PRIMARY_MEMBER_ID,
        scope_type: 'squad',
        scope_id: OTHER_SQUAD_ID,
        capability: 'observer',
      },
    ],
  })
}

async function acceptObjectiveFixture(input: {
  idempotencyKey: string
  projectId?: string | null
  squadId?: string
  auth?: AuthContext
}): Promise<ObjectiveFixture> {
  const outcome = await invoke('objective_accept', objectiveArgs({
    idempotencyKey: input.idempotencyKey,
    projectId: input.projectId ?? null,
    squadId: input.squadId ?? PRIMARY_SQUAD_ID,
  }), input.auth ?? primaryAuth())
  if (!outcome.ok) throw new Error(`objective fixture failed: ${outcome.error}`)
  return (outcome.result as { objective: ObjectiveFixture }).objective
}

function flightMeta(input: {
  objectiveId: string
  squadIds: string[]
  taskIds?: string[]
  goalId?: string
}): string {
  return JSON.stringify({
    schema: 'mupot.flight.meta/v1',
    goal_id: input.goalId ?? `goal:${input.objectiveId}`,
    objective_id: input.objectiveId,
    squad_ids: input.squadIds,
    task_ids: input.taskIds ?? ['task-placeholder'],
    done_when: ['The receipt visibility contract passes.'],
    artifact_refs: [],
    receipt_refs: [],
    confidentiality: 'private',
    publication_target: 'none',
    parent_flight_id: null,
  })
}

function seedFlight(input: {
  id: string
  objectiveId: string
  squadIds?: string[]
  taskIds?: string[]
  projectId?: string | null
}): void {
  const squadIds = input.squadIds ?? [PRIMARY_SQUAD_ID]
  const projectId = input.projectId ?? null
  let taskIds = input.taskIds
  if (taskIds === undefined) {
    const placeholderTaskId = `task:${input.id}:placeholder`
    seedTask({
      id: placeholderTaskId,
      squadId: squadIds[0],
      projectId,
    })
    taskIds = [placeholderTaskId]
  }
  harness.sqlite.prepare(`
    INSERT INTO flights (
      id, tenant, project_id, agent, dispatched_by_agent_id,
      goal, status, meta, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)
  `).run(
    input.id,
    TENANT,
    projectId,
    PRIMARY_AGENT_ID,
    PRIMARY_AGENT_ID,
    `Flight ${input.id}`,
    flightMeta({
      objectiveId: input.objectiveId,
      squadIds,
      taskIds,
      goalId: `goal:${input.id}`,
    }),
    Date.now(),
  )
}

function seedTask(input: {
  id: string
  squadId?: string
  projectId?: string | null
  assignmentEpoch?: number
}): void {
  harness.sqlite.prepare(`
    INSERT INTO tasks (
      id, squad_id, project_id, title, done_when, status, assignment_epoch
    ) VALUES (?, ?, ?, ?, ?, 'open', ?)
  `).run(
    input.id,
    input.squadId ?? PRIMARY_SQUAD_ID,
    input.projectId ?? null,
    `Task ${input.id}`,
    `Task ${input.id} remains correctly scoped.`,
    input.assignmentEpoch ?? 1,
  )
}

async function expectReceiptNotFound(receiptId: string, auth: AuthContext = primaryAuth()) {
  expect(await invoke('execution_receipt_get', { receiptId }, auth)).toMatchObject({
    ok: false,
    status: 404,
    error: 'receipt_not_found',
  })
}

async function expectDraftsNotFound(
  drafts: ExecutionReceiptDraft[],
  auth: AuthContext = primaryAuth(),
): Promise<void> {
  for (const draft of drafts) {
    const receipt = await appendExecutionReceipt(env, primaryAuth(), draft)
    await expectReceiptNotFound(receipt.id, auth)
  }
}

function seedDependency(
  id: string,
  objectiveId: string,
  parentFlightId: string,
  childFlightId: string,
): void {
  harness.sqlite.prepare(`
    INSERT INTO flight_dependencies (
      id, tenant, objective_id, parent_flight_id, child_flight_id,
      created_by_principal_kind, created_by_principal_id,
      created_by_member_id, created_at
    ) VALUES (?, ?, ?, ?, ?, 'agent', ?, ?, ?)
  `).run(
    id,
    TENANT,
    objectiveId,
    parentFlightId,
    childFlightId,
    PRIMARY_AGENT_ID,
    PRIMARY_MEMBER_ID,
    NOW,
  )
}

function dependencyDraft(
  key: string,
  objectiveId: string,
  parentFlightId: string,
  dependencyId: string,
  childFlightId: string,
  claims?: Record<string, unknown>,
): ExecutionReceiptDraft {
  return {
    type: 'flight.dependency_linked',
    idempotencyKey: key,
    objectiveId,
    flightId: parentFlightId,
    claims: claims ?? {
      dependencyId,
      parentFlightId,
      childFlightId,
    },
  }
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
    INSERT INTO projects (id, slug, name, status) VALUES
      ('${PROJECT_ID}', 'project-command', 'Project Command', 'active'),
      ('${SECOND_PROJECT_ID}', 'project-command-two', 'Project Command Two', 'active'),
      ('${HIDDEN_PROJECT_ID}', 'project-hidden', 'Project Hidden', 'active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES
      ('${PROJECT_ID}', '${PRIMARY_SQUAD_ID}', 'write'),
      ('${PROJECT_ID}', '${OTHER_SQUAD_ID}', 'write'),
      ('${SECOND_PROJECT_ID}', '${PRIMARY_SQUAD_ID}', 'write');
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
    expect(receiptRead.ok).toBe(true)
    const publicReceipt = (
      receiptRead.result as { receipt: Record<string, unknown> }
    ).receipt
    expect(Object.keys(publicReceipt).sort()).toEqual([...PUBLIC_RECEIPT_KEYS])
    expect(publicReceipt).toEqual({
      id: objective.acceptanceReceiptId,
      type: 'objective.accepted',
      actorKind: 'agent',
      actorId: PRIMARY_AGENT_ID,
      objectiveId: objective.id,
      flightId: null,
      taskId: null,
      assignmentEpoch: null,
      payloadDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      receiptHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      serverTimestamp: NOW,
    })
    expect(JSON.stringify(publicReceipt)).not.toContain('redacted')
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

  it.each([
    ['removed', "DELETE FROM memberships WHERE id = 'membership-command'"],
    ['downgraded', "UPDATE memberships SET capability = 'observer' WHERE id = 'membership-command'"],
  ])('consumes Task 4 current membership checks when an existing attestation agent is %s', async (_label, mutation) => {
    const attested = await invoke('token_binding_attest', {})
    expect(attested.ok).toBe(true)
    const attestation = (attested.result as { attestation: { id: string } }).attestation
    expect(count('token_binding_attestations')).toBe(1)
    expect(count('capabilities')).toBe(2)

    harness.sqlite.exec(mutation)

    expect(await invoke('token_binding_attest', {})).toMatchObject({
      ok: false,
      status: 403,
      error: 'workspace_token_required',
    })
    expect(await invoke('runtime_seat_register_pending', {
      seatName: `membership-${_label}-seat`,
      hostId: 'hadi-mac',
      adapterKind: 'codex-desktop',
      attestationId: attestation.id,
    })).toMatchObject({
      ok: false,
      status: 403,
      error: 'workspace_token_required',
    })
    expect(count('token_binding_attestations')).toBe(1)
    expect(count('runtime_seats')).toBe(0)
    expect(count('seat_attestations')).toBe(0)
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

  it('returns a claim-free task projection even when a sensitive receipt immediately precedes it', async () => {
    const objective = await acceptObjectiveFixture({
      idempotencyKey: 'objective-public-task-projection',
    })
    seedTask({ id: 'task-public-projection' })
    seedFlight({
      id: 'flight-public-projection',
      objectiveId: objective.id,
      taskIds: ['task-public-projection'],
    })
    const sensitivePredecessor = await appendExecutionReceipt(env, primaryAuth(), {
      type: 'host_control.requested',
      idempotencyKey: 'sensitive-predecessor',
      objectiveId: objective.id,
      claims: {
        runtimeSeatId: 'seat-never-public',
        childFlightId: 'child-never-public',
      },
    })
    const assigned = await appendExecutionReceipt(env, primaryAuth(), {
      type: 'task.assigned',
      idempotencyKey: 'public-task-assigned',
      objectiveId: objective.id,
      flightId: 'flight-public-projection',
      taskId: 'task-public-projection',
      assignmentEpoch: 1,
      claims: {
        laneKey: 'worker',
        role: 'worker',
        agentId: 'agent-private-claim',
        runtimeSeatId: 'runtime-seat-private-claim',
      },
    })

    const outcome = await invoke('execution_receipt_get', { receiptId: assigned.id })
    expect(outcome.ok).toBe(true)
    const receipt = (outcome.result as { receipt: Record<string, unknown> }).receipt
    expect(Object.keys(receipt).sort()).toEqual([...PUBLIC_RECEIPT_KEYS])
    expect(receipt).toEqual({
      id: assigned.id,
      type: 'task.assigned',
      actorKind: 'agent',
      actorId: PRIMARY_AGENT_ID,
      objectiveId: objective.id,
      flightId: 'flight-public-projection',
      taskId: 'task-public-projection',
      assignmentEpoch: 1,
      payloadDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      receiptHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      serverTimestamp: NOW,
    })
    const serialized = JSON.stringify(receipt)
    expect(serialized).not.toContain('claims')
    expect(serialized).not.toContain('agent-private-claim')
    expect(serialized).not.toContain('runtime-seat-private-claim')
    expect(serialized).not.toContain('seat-never-public')
    expect(serialized).not.toContain('child-never-public')
    expect(serialized).not.toContain(sensitivePredecessor.id)
    expect(serialized).not.toContain(TENANT)
  })

  it.each([
    ['non-Mupot issuer kind', "issuer_kind = 'runtime', issuer_id = 'runtime:test'"],
    ['noncanonical Mupot issuer id', "issuer_id = 'mupot:other-tenant'"],
  ])('hides a public-shaped receipt with %s before integrity verification', async (_label, mutation) => {
    const objective = await acceptObjectiveFixture({
      idempotencyKey: `objective-issuer-${_label}`,
    })
    harness.sqlite.exec('DROP TRIGGER execution_receipts_no_update')
    harness.sqlite.prepare(`
      UPDATE execution_receipts SET ${mutation} WHERE id = ?
    `).run(objective.acceptanceReceiptId)

    await expectReceiptNotFound(objective.acceptanceReceiptId)
  })

  it('returns integrity_failure only after a receipt passes public visibility checks', async () => {
    const objective = await acceptObjectiveFixture({
      idempotencyKey: 'objective-public-bad-chain',
    })
    harness.sqlite.exec('DROP TRIGGER execution_receipts_no_update')
    harness.sqlite.prepare(`
      UPDATE execution_receipts SET receipt_hash = ? WHERE id = ?
    `).run('f'.repeat(64), objective.acceptanceReceiptId)

    expect(await invoke('execution_receipt_get', {
      receiptId: objective.acceptanceReceiptId,
    })).toMatchObject({
      ok: false,
      status: 409,
      error: 'receipt_integrity_failure',
    })
  })

  it('rejects malformed or extra public correlations for every allowlisted receipt type', async () => {
    const objective = await acceptObjectiveFixture({
      idempotencyKey: 'objective-type-shapes',
    })
    seedTask({ id: 'task-type-shapes' })
    seedFlight({
      id: 'flight-type-shapes',
      objectiveId: objective.id,
      taskIds: ['task-type-shapes'],
    })
    const cases: ExecutionReceiptDraft[] = [
      {
        type: 'objective.authorized',
        idempotencyKey: 'shape-objective-authorized-extra-flight',
        objectiveId: objective.id,
        flightId: 'flight-type-shapes',
        claims: { authorized: true },
      },
      {
        type: 'objective.accepted',
        idempotencyKey: 'shape-objective-accepted-missing-objective',
        claims: { accepted: true },
      },
      {
        type: 'composition.proposed',
        idempotencyKey: 'shape-composition-proposed-extra-task',
        objectiveId: objective.id,
        flightId: 'flight-type-shapes',
        taskId: 'task-type-shapes',
        claims: { lanes: [] },
      },
      {
        type: 'flight.materialized',
        idempotencyKey: 'shape-flight-materialized-missing-flight',
        objectiveId: objective.id,
        claims: { laneCount: 1 },
      },
      {
        type: 'flight.dependency_linked',
        idempotencyKey: 'shape-dependency-linked-extra-epoch',
        objectiveId: objective.id,
        flightId: 'flight-type-shapes',
        assignmentEpoch: 1,
        claims: {
          dependencyId: 'dependency-shape',
          parentFlightId: 'flight-type-shapes',
          childFlightId: 'flight-shape-child',
        },
      },
      {
        type: 'task.assigned',
        idempotencyKey: 'shape-task-only',
        taskId: 'task-type-shapes',
        assignmentEpoch: 1,
        claims: { assigned: true },
      },
      {
        type: 'task.assigned',
        idempotencyKey: 'shape-task-zero-epoch',
        objectiveId: objective.id,
        flightId: 'flight-type-shapes',
        taskId: 'task-type-shapes',
        assignmentEpoch: 0,
        claims: { assigned: true },
      },
    ]

    await expectDraftsNotFound(cases)
  })

  it('hides otherwise public receipt types carrying runtime, message, fencing, or lease correlations', async () => {
    const objective = await acceptObjectiveFixture({
      idempotencyKey: 'objective-restricted-correlations',
    })
    harness.sqlite.exec(`
      INSERT INTO runtime_seats (
        id, tenant, agent_id, seat_name, host_id, adapter_kind, state,
        current_generation, current_fencing_epoch, capabilities_json,
        created_at, updated_at
      ) VALUES (
        'seat-restricted', '${TENANT}', '${PRIMARY_AGENT_ID}', 'restricted',
        'host-restricted', 'test', 'active', 1, 0, '[]', '${NOW}', '${NOW}'
      );
      INSERT INTO runtime_seat_generations (
        id, tenant, runtime_seat_id, generation, host_id, process_id,
        process_uid, sandbox_id, executable_digest, public_key,
        broker_attestation_digest, started_at, created_at
      ) VALUES (
        'generation-restricted', '${TENANT}', 'seat-restricted', 1,
        'host-restricted', 'pid-restricted', 'uid-restricted',
        'sandbox-restricted', '${'a'.repeat(64)}', 'public-restricted',
        '${'b'.repeat(64)}', '${NOW}', '${NOW}'
      );
    `)
    const drafts: ExecutionReceiptDraft[] = [
      {
        type: 'objective.accepted',
        idempotencyKey: 'restricted-seat-generation',
        objectiveId: objective.id,
        seatId: 'seat-restricted',
        seatGeneration: 1,
        claims: { accepted: true },
      },
      {
        type: 'objective.accepted',
        idempotencyKey: 'restricted-message',
        objectiveId: objective.id,
        messageId: 'message-private',
        claims: { accepted: true },
      },
      {
        type: 'objective.accepted',
        idempotencyKey: 'restricted-fencing',
        objectiveId: objective.id,
        fencingEpoch: 1,
        claims: { accepted: true },
      },
      {
        type: 'objective.accepted',
        idempotencyKey: 'restricted-lease',
        objectiveId: objective.id,
        leaseTokenHash: 'c'.repeat(64),
        claims: { accepted: true },
      },
    ]
    await expectDraftsNotFound(drafts)
  })

  it('requires objective, flight, and task pairs to agree on objective, project, and squad', async () => {
    const objective = await acceptObjectiveFixture({
      idempotencyKey: 'objective-pair-consistency',
      projectId: PROJECT_ID,
    })
    seedFlight({
      id: 'flight-project-mismatch',
      objectiveId: objective.id,
      projectId: SECOND_PROJECT_ID,
    })
    seedFlight({
      id: 'flight-squad-mismatch',
      objectiveId: objective.id,
      projectId: PROJECT_ID,
      squadIds: [OTHER_SQUAD_ID],
    })
    seedTask({
      id: 'task-cross-squad',
      squadId: OTHER_SQUAD_ID,
      projectId: PROJECT_ID,
    })
    seedFlight({
      id: 'flight-cross-squad-task',
      objectiveId: objective.id,
      projectId: PROJECT_ID,
      squadIds: [PRIMARY_SQUAD_ID, OTHER_SQUAD_ID],
      taskIds: ['task-cross-squad'],
    })
    const drafts: ExecutionReceiptDraft[] = [
      {
        type: 'flight.materialized',
        idempotencyKey: 'pair-project-mismatch',
        objectiveId: objective.id,
        flightId: 'flight-project-mismatch',
        claims: { laneCount: 1 },
      },
      {
        type: 'flight.materialized',
        idempotencyKey: 'pair-objective-squad-missing',
        objectiveId: objective.id,
        flightId: 'flight-squad-mismatch',
        claims: { laneCount: 1 },
      },
      {
        type: 'task.assigned',
        idempotencyKey: 'pair-cross-squad-task',
        objectiveId: objective.id,
        flightId: 'flight-cross-squad-task',
        taskId: 'task-cross-squad',
        assignmentEpoch: 1,
        claims: { assigned: true },
      },
    ]
    await expectDraftsNotFound(drafts, dualSquadAuth())
  })

  it('requires a dependency receipt child flight to be visible and returns no child claim', async () => {
    const objective = await acceptObjectiveFixture({
      idempotencyKey: 'objective-visible-dependency-child',
    })
    seedFlight({
      id: 'flight-dependency-parent',
      objectiveId: objective.id,
    })
    seedFlight({
      id: 'flight-dependency-child',
      objectiveId: objective.id,
      squadIds: [PRIMARY_SQUAD_ID, OTHER_SQUAD_ID],
    })
    seedDependency(
      'dependency-visible-child',
      objective.id,
      'flight-dependency-parent',
      'flight-dependency-child',
    )
    const dependency = await appendExecutionReceipt(env, primaryAuth(), dependencyDraft(
      'dependency-visible-child-receipt',
      objective.id,
      'flight-dependency-parent',
      'dependency-visible-child',
      'flight-dependency-child',
    ))

    await expectReceiptNotFound(dependency.id)
    const visible = await invoke(
      'execution_receipt_get',
      { receiptId: dependency.id },
      dualSquadAuth(),
    )
    expect(visible.ok).toBe(true)
    const receipt = (visible.result as { receipt: Record<string, unknown> }).receipt
    expect(Object.keys(receipt).sort()).toEqual([...PUBLIC_RECEIPT_KEYS])
    expect(receipt).toMatchObject({
      id: dependency.id,
      type: 'flight.dependency_linked',
      objectiveId: objective.id,
      flightId: 'flight-dependency-parent',
      taskId: null,
      assignmentEpoch: null,
    })
    expect(JSON.stringify(receipt)).not.toContain('flight-dependency-child')
    expect(JSON.stringify(receipt)).not.toContain('dependency-visible-child')
  })

  it('hides dependency receipts with malformed claims, parent mismatch, missing rows, or hidden child projects', async () => {
    const objective = await acceptObjectiveFixture({
      idempotencyKey: 'objective-invalid-dependencies',
      projectId: PROJECT_ID,
    })
    seedFlight({
      id: 'flight-invalid-dependency-parent',
      objectiveId: objective.id,
      projectId: PROJECT_ID,
    })
    seedFlight({
      id: 'flight-invalid-dependency-child',
      objectiveId: objective.id,
      projectId: PROJECT_ID,
    })
    harness.sqlite.exec(`
      INSERT INTO project_squad_access (project_id, squad_id, access_level)
        VALUES ('${HIDDEN_PROJECT_ID}', '${PRIMARY_SQUAD_ID}', 'write');
    `)
    seedFlight({
      id: 'flight-hidden-project-child',
      objectiveId: objective.id,
      projectId: HIDDEN_PROJECT_ID,
    })
    harness.sqlite.exec(`
      DELETE FROM project_squad_access
       WHERE project_id = '${HIDDEN_PROJECT_ID}'
         AND squad_id = '${PRIMARY_SQUAD_ID}';
    `)
    seedDependency(
      'dependency-valid-row',
      objective.id,
      'flight-invalid-dependency-parent',
      'flight-invalid-dependency-child',
    )
    seedDependency(
      'dependency-hidden-project',
      objective.id,
      'flight-invalid-dependency-parent',
      'flight-hidden-project-child',
    )
    const drafts: ExecutionReceiptDraft[] = [
      dependencyDraft(
        'dependency-malformed-claims',
        objective.id,
        'flight-invalid-dependency-parent',
        'dependency-valid-row',
        'flight-invalid-dependency-child',
        {
          dependencyId: 'dependency-valid-row',
          parentFlightId: 'flight-invalid-dependency-parent',
          childFlightId: 'flight-invalid-dependency-child',
          runtimeSeatId: 'must-not-be-accepted',
        },
      ),
      dependencyDraft(
        'dependency-parent-mismatch',
        objective.id,
        'flight-invalid-dependency-parent',
        'dependency-valid-row',
        'flight-invalid-dependency-child',
        {
          dependencyId: 'dependency-valid-row',
          parentFlightId: 'flight-other-parent',
          childFlightId: 'flight-invalid-dependency-child',
        },
      ),
      dependencyDraft(
        'dependency-missing-row', objective.id, 'flight-invalid-dependency-parent',
        'dependency-missing', 'flight-invalid-dependency-child',
      ),
      dependencyDraft(
        'dependency-hidden-project', objective.id, 'flight-invalid-dependency-parent',
        'dependency-hidden-project', 'flight-hidden-project-child',
      ),
    ]
    await expectDraftsNotFound(drafts)
  })
})
