import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'tenant-flight-spine'
const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)

let harness: SqliteD1Harness

function seedLegacyRows(): void {
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('department-spine', 'spine', 'Flight Spine');
    INSERT INTO squads (id, department_id, slug, name)
      VALUES ('squad-spine', 'department-spine', 'spine', 'Flight Spine');
    INSERT INTO agents (id, squad_id, slug, name)
      VALUES
        ('agent-worker', 'squad-spine', 'worker', 'Worker'),
        ('agent-gate', 'squad-spine', 'gate', 'Gate');
    INSERT INTO members (id, display_name, status, tenant)
      VALUES
        ('member-worker', 'Worker Member', 'active', '${TENANT}'),
        ('member-gate', 'Gate Member', 'active', '${TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES
        ('${TENANT}', 'agent-worker', 'member-worker', '2026-08-23T12:00:00.000Z'),
        ('${TENANT}', 'agent-gate', 'member-gate', '2026-08-23T12:00:00.000Z');
    INSERT INTO member_tokens (
      id, member_id, token_hash, label, channel, created_at, revoked_at,
      agent_id, tenant, expires_at
    ) VALUES
      ('token-worker', 'member-worker', 'hash-worker', 'worker', 'workspace',
       '2026-08-23T12:00:00.000Z', NULL, 'agent-worker', '${TENANT}',
       '2026-08-24T12:00:00.000Z'),
      ('token-gate', 'member-gate', 'hash-gate', 'gate', 'workspace',
       '2026-08-23T12:00:00.000Z', NULL, 'agent-gate', '${TENANT}',
       '2026-08-24T12:00:00.000Z'),
      ('token-directory', 'member-worker', 'hash-directory', 'directory', 'directory',
       '2026-08-23T12:00:00.000Z', NULL, 'agent-worker', '${TENANT}',
       '2026-08-24T12:00:00.000Z'),
      ('token-revoked', 'member-worker', 'hash-revoked', 'revoked', 'workspace',
       '2026-08-23T12:00:00.000Z', '2026-08-23T12:30:00.000Z',
       'agent-worker', '${TENANT}', '2026-08-24T12:00:00.000Z');
    INSERT INTO flights (id, tenant, agent, goal, status)
      VALUES
        ('flight-parent', '${TENANT}', 'agent-worker', 'Parent', 'running'),
        ('flight-child', '${TENANT}', 'agent-worker', 'Child', 'running');
    INSERT INTO tasks (id, squad_id, title, status, assignee_agent_id)
      VALUES
        ('task-worker', 'squad-spine', 'Worker lane', 'open', 'agent-worker'),
        ('task-gate', 'squad-spine', 'Gate lane', 'open', 'agent-gate');
  `)
}

function insertObjective(id = 'objective-1'): void {
  harness.sqlite.prepare(`
    INSERT INTO objectives (
      id, tenant, created_by_principal_kind, created_by_principal_id,
      created_by_member_id, squad_id, project_id, title, success_contract,
      authority_envelope, policy_json, budget_micro_usd, payload_json,
      payload_digest, accepted_at, created_at
    ) VALUES (?, ?, 'member', 'principal-1', 'member-1', 'squad-spine', NULL,
      'Schema objective', 'All schema guards pass', '{}', '{}', 0, '{}', ?,
      '2026-08-23T12:00:00.000Z', '2026-08-23T12:00:00.000Z')
  `).run(id, TENANT, SHA_A)
}

function insertRuntimeSeat(): void {
  harness.sqlite.prepare(`
    INSERT INTO runtime_seats (
      id, tenant, agent_id, seat_name, host_id, adapter_kind, state,
      current_generation, current_fencing_epoch, capabilities_json,
      created_at, updated_at
    ) VALUES (
      'seat-1', ?, 'agent-worker', 'codex-desktop-command', 'host-1',
      'codex-desktop', 'active', 1, 0, '[]',
      '2026-08-23T12:00:00.000Z', '2026-08-23T12:00:00.000Z'
    )
  `).run(TENANT)
  harness.sqlite.prepare(`
    INSERT INTO runtime_seat_generations (
      id, tenant, runtime_seat_id, generation, host_id, process_id,
      process_uid, sandbox_id, executable_digest, public_key,
      broker_attestation_digest, started_at, created_at
    ) VALUES (
      'seat-generation-1', ?, 'seat-1', 1, 'host-1', 'pid-1', 'uid-1',
      'sandbox-1', ?, 'public-key-1', ?,
      '2026-08-23T12:00:00.000Z', '2026-08-23T12:00:00.000Z'
    )
  `).run(TENANT, SHA_A, SHA_B)
}

function insertPendingRuntimeSeat(
  id: string,
  agentId: string,
  seatName: string,
): void {
  harness.sqlite.prepare(`
    INSERT INTO runtime_seats (
      id, tenant, agent_id, seat_name, host_id, adapter_kind, state,
      current_generation, current_fencing_epoch, capabilities_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'host-1', 'codex-desktop', 'pending', 0, 0, '[]',
      '2026-08-23T12:00:00.000Z', '2026-08-23T12:00:00.000Z')
  `).run(id, TENANT, agentId, seatName)
}

function insertTokenBindingAttestation(
  id: string,
  tokenId = 'token-worker',
  memberId = 'member-worker',
  agentId = 'agent-worker',
): void {
  harness.sqlite.prepare(`
    INSERT INTO token_binding_attestations (
      id, tenant, token_id, member_id, agent_id, channel,
      credential_fingerprint, issued_at, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, 'workspace', ?, '2026-08-23T13:00:00.000Z',
      '2026-08-24T12:00:00.000Z', '2026-08-23T13:00:00.000Z')
  `).run(id, TENANT, tokenId, memberId, agentId, `v1:${SHA_A}`)
}

function insertAssignment(): void {
  harness.sqlite.prepare(`
    INSERT INTO flight_lanes (
      id, tenant, flight_id, lane_key, role, task_id, assignment_epoch,
      agent_id, runtime_seat_id, done_when, dependency_lane_keys_json, created_at
    ) VALUES (
      'lane-worker', ?, 'flight-parent', 'worker', 'worker', 'task-worker', 1,
      'agent-worker', 'seat-1', 'Schema exists', '[]',
      '2026-08-23T12:00:00.000Z'
    )
  `).run(TENANT)
  harness.sqlite.prepare(`
    INSERT INTO flight_task_assignments (
      id, tenant, flight_id, lane_id, task_id, assignment_epoch, agent_id,
      runtime_seat_id, assigned_by_principal_kind, assigned_by_principal_id,
      assigned_by_member_id, assignment_receipt_id, assigned_at
    ) VALUES (
      'assignment-1', ?, 'flight-parent', 'lane-worker', 'task-worker', 1,
      'agent-worker', 'seat-1', 'member', 'principal-1', 'member-1', NULL,
      '2026-08-23T12:00:00.000Z'
    )
  `).run(TENANT)
}

function insertExecutionReceipt(): void {
  harness.sqlite.prepare(`
    INSERT INTO execution_receipts (
      id, tenant, type, issuer_kind, issuer_id, actor_kind, actor_id,
      objective_id, flight_id, task_id, message_id, assignment_epoch,
      fencing_epoch, lease_token_hash, idempotency_key, claims_json,
      canonical_payload, payload_digest, predecessor_receipt_id,
      predecessor_hash, receipt_hash, server_timestamp
    ) VALUES (
      'receipt-1', ?, 'objective.accepted', 'mupot', 'mupot-server',
      'member', 'principal-1', 'objective-1', NULL, NULL, NULL, NULL,
      NULL, NULL, 'receipt-key-1', '{}', '{}', ?, NULL, NULL, ?,
      '2026-08-23T12:00:00.000Z'
    )
  `).run(TENANT, SHA_A, SHA_B)
}

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  seedLegacyRows()
})

afterEach(() => harness.close())

describe('Flight Spine schema migrations', () => {
  it('creates every Flight Spine table and defaults legacy task assignment epochs to zero', () => {
    const tableNames = harness.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String(row.name))

    expect(tableNames).toEqual(expect.arrayContaining([
      'objectives', 'objective_acceptance_keys', 'flight_objectives', 'flight_lanes',
      'flight_task_assignments', 'flight_dependencies', 'runtime_seats',
      'runtime_seat_generations', 'runtime_seat_leases', 'token_binding_attestations',
      'seat_attestations', 'execution_receipt_heads', 'execution_receipts',
      'execution_receipt_edges', 'artifacts', 'artifact_retrieval_receipts',
      'flight_dependency_artifacts', 'mutation_audit_entries', 'host_control_receipts',
      'decision_requests', 'decision_request_resolutions',
    ]))

    const assignmentEpoch = harness.sqlite
      .prepare('PRAGMA table_info(tasks)')
      .all()
      .find((row) => row.name === 'assignment_epoch')
    expect(assignmentEpoch).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '0' })

    expect(
      harness.sqlite.prepare("SELECT assignment_epoch FROM tasks WHERE id = 'task-worker'").get(),
    ).toEqual({ assignment_epoch: 0 })
  })

  it('rejects UPDATE and DELETE on immutable objectives and evidence receipts', () => {
    insertObjective()
    insertRuntimeSeat()
    insertAssignment()
    insertExecutionReceipt()

    harness.sqlite.prepare(`
      INSERT INTO artifacts (
        id, tenant, flight_id, producing_assignment_id, producing_task_id,
        producing_agent_id, producing_runtime_seat_id, assignment_epoch,
        object_key, digest, size_bytes, visibility, retention_until,
        storage_receipt_id, created_at
      ) VALUES (
        'artifact-1', ?, 'flight-parent', 'assignment-1', 'task-worker',
        'agent-worker', 'seat-1', 1, 'sha256/aa/artifact-1', ?, 10,
        'tenant', '2026-09-23T12:00:00.000Z', 'receipt-1',
        '2026-08-23T12:00:00.000Z'
      )
    `).run(TENANT, SHA_A)

    for (const [table, id] of [
      ['objectives', 'objective-1'],
      ['runtime_seat_generations', 'seat-generation-1'],
      ['execution_receipts', 'receipt-1'],
      ['artifacts', 'artifact-1'],
    ] as const) {
      expect(() => harness.sqlite.prepare(`UPDATE ${table} SET id = id WHERE id = ?`).run(id))
        .toThrow(/append-only|immutable/i)
      expect(() => harness.sqlite.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id))
        .toThrow(/append-only|immutable/i)
    }
  })

  it('allows at most one gate lane per flight', () => {
    harness.sqlite.prepare(`
      INSERT INTO flight_lanes (
        id, tenant, flight_id, lane_key, role, task_id, assignment_epoch,
        agent_id, runtime_seat_id, done_when, dependency_lane_keys_json, created_at
      ) VALUES (
        'lane-gate-1', ?, 'flight-parent', 'gate-1', 'gate', 'task-gate', 1,
        'agent-gate', NULL, 'Review the candidate', '[]',
        '2026-08-23T12:00:00.000Z'
      )
    `).run(TENANT)

    expect(() => harness.sqlite.prepare(`
      INSERT INTO flight_lanes (
        id, tenant, flight_id, lane_key, role, task_id, assignment_epoch,
        agent_id, runtime_seat_id, done_when, dependency_lane_keys_json, created_at
      ) VALUES (
        'lane-gate-2', ?, 'flight-parent', 'gate-2', 'gate', 'task-worker', 1,
        'agent-worker', NULL, 'Second gate', '[]',
        '2026-08-23T12:00:01.000Z'
      )
    `).run(TENANT)).toThrow(/unique/i)
  })

  it('enforces positive monotonic seat fencing and one active lease', () => {
    insertRuntimeSeat()

    expect(() => harness.sqlite.prepare(`
      INSERT INTO runtime_seat_leases (
        id, tenant, runtime_seat_id, generation, fencing_epoch, consumer_id,
        lease_token_hash, state, leased_at, expires_at
      ) VALUES (
        'lease-zero', ?, 'seat-1', 1, 0, 'consumer-1', ?, 'expired',
        '2026-08-23T12:00:00.000Z', '2026-08-23T12:01:00.000Z'
      )
    `).run(TENANT, SHA_A)).toThrow(/check constraint/i)

    harness.sqlite.prepare(`
      INSERT INTO runtime_seat_leases (
        id, tenant, runtime_seat_id, generation, fencing_epoch, consumer_id,
        lease_token_hash, state, leased_at, expires_at
      ) VALUES (
        'lease-1', ?, 'seat-1', 1, 1, 'consumer-1', ?, 'active',
        '2026-08-23T12:00:00.000Z', '2026-08-23T12:01:00.000Z'
      )
    `).run(TENANT, SHA_A)

    expect(() => harness.sqlite.prepare(`
      INSERT INTO runtime_seat_leases (
        id, tenant, runtime_seat_id, generation, fencing_epoch, consumer_id,
        lease_token_hash, state, leased_at, expires_at
      ) VALUES (
        'lease-2', ?, 'seat-1', 1, 2, 'consumer-2', ?, 'active',
        '2026-08-23T12:00:01.000Z', '2026-08-23T12:01:01.000Z'
      )
    `).run(TENANT, SHA_B)).toThrow(/unique/i)

    harness.sqlite.prepare("UPDATE runtime_seat_leases SET state = 'released' WHERE id = 'lease-1'").run()
    expect(() => harness.sqlite.prepare(`
      INSERT INTO runtime_seat_leases (
        id, tenant, runtime_seat_id, generation, fencing_epoch, consumer_id,
        lease_token_hash, state, leased_at, expires_at
      ) VALUES (
        'lease-stale', ?, 'seat-1', 1, 1, 'consumer-2', ?, 'expired',
        '2026-08-23T12:00:02.000Z', '2026-08-23T12:01:02.000Z'
      )
    `).run(TENANT, SHA_B)).toThrow(/monotonic|fencing/i)
  })

  it('requires an active lease to end before advancing seat generation or fencing', () => {
    insertRuntimeSeat()
    harness.sqlite.prepare(`
      INSERT INTO runtime_seat_leases (
        id, tenant, runtime_seat_id, generation, fencing_epoch, consumer_id,
        lease_token_hash, state, leased_at, expires_at
      ) VALUES (
        'lease-generation-1', ?, 'seat-1', 1, 1, 'consumer-1', ?, 'active',
        '2026-08-23T12:00:00.000Z', '2026-08-23T12:01:00.000Z'
      )
    `).run(TENANT, SHA_A)
    harness.sqlite.prepare(`
      INSERT INTO runtime_seat_generations (
        id, tenant, runtime_seat_id, generation, host_id, process_id,
        process_uid, sandbox_id, executable_digest, public_key,
        broker_attestation_digest, started_at, created_at
      ) VALUES (
        'seat-generation-2', ?, 'seat-1', 2, 'host-1', 'pid-2', 'uid-1',
        'sandbox-2', ?, 'public-key-2', ?,
        '2026-08-23T12:02:00.000Z', '2026-08-23T12:02:00.000Z'
      )
    `).run(TENANT, SHA_A, SHA_B)

    expect(() => harness.sqlite.prepare(`
      UPDATE runtime_seats
      SET current_generation = 2, current_fencing_epoch = 1,
          updated_at = '2026-08-23T12:02:00.000Z'
      WHERE id = 'seat-1'
    `).run()).toThrow(/active runtime seat lease must end before advancing/i)

    harness.sqlite.prepare(`
      UPDATE runtime_seat_leases
      SET state = 'released', released_at = '2026-08-23T12:02:01.000Z'
      WHERE id = 'lease-generation-1'
    `).run()
    expect(() => harness.sqlite.prepare(`
      UPDATE runtime_seats
      SET current_generation = 2, current_fencing_epoch = 1,
          updated_at = '2026-08-23T12:02:02.000Z'
      WHERE id = 'seat-1'
    `).run()).not.toThrow()
    expect(harness.sqlite.prepare(`
      SELECT current_generation, current_fencing_epoch
      FROM runtime_seats
      WHERE id = 'seat-1'
    `).get()).toEqual({ current_generation: 2, current_fencing_epoch: 1 })
  })

  it('rejects token binding attestations whose member or agent differs from the token', () => {
    expect(() => insertTokenBindingAttestation(
      'attestation-wrong-member',
      'token-worker',
      'member-gate',
      'agent-worker',
    )).toThrow(/token binding identity mismatch/i)

    expect(() => insertTokenBindingAttestation(
      'attestation-wrong-agent',
      'token-worker',
      'member-worker',
      'agent-gate',
    )).toThrow(/token binding identity mismatch/i)
  })

  it('rejects token binding attestations for a non-workspace or revoked token', () => {
    expect(() => insertTokenBindingAttestation(
      'attestation-wrong-channel',
      'token-directory',
    )).toThrow(/token binding identity mismatch/i)

    expect(() => insertTokenBindingAttestation(
      'attestation-revoked',
      'token-revoked',
    )).toThrow(/token binding identity mismatch/i)
  })

  it('rejects a pending-seat attestation that contradicts token or seat ownership', () => {
    insertTokenBindingAttestation('attestation-worker')
    insertPendingRuntimeSeat('seat-gate-pending', 'agent-gate', 'gate-command')

    expect(() => harness.sqlite.prepare(`
      INSERT INTO seat_attestations (
        id, tenant, runtime_seat_id, token_binding_attestation_id,
        member_id, agent_id, seat_state, seat_claim_digest,
        issued_at, expires_at, created_at
      ) VALUES (
        'seat-attestation-mismatch', ?, 'seat-gate-pending', 'attestation-worker',
        'member-worker', 'agent-worker', 'pending', ?,
        '2026-08-23T13:01:00.000Z', '2026-08-24T12:00:00.000Z',
        '2026-08-23T13:01:00.000Z'
      )
    `).run(TENANT, SHA_A)).toThrow(/seat attestation identity mismatch/i)
  })

  it('rejects nonexistent, stale, or already-fenced seat generations when leasing', () => {
    insertRuntimeSeat()

    expect(() => harness.sqlite.prepare(`
      INSERT INTO runtime_seat_leases (
        id, tenant, runtime_seat_id, generation, fencing_epoch, consumer_id,
        lease_token_hash, state, leased_at, expires_at
      ) VALUES (
        'lease-nonexistent-generation', ?, 'seat-1', 999, 1, 'consumer-1', ?,
        'active', '2026-08-23T12:00:00.000Z', '2026-08-23T12:01:00.000Z'
      )
    `).run(TENANT, SHA_A)).toThrow(/runtime seat generation is not current and active/i)

    harness.sqlite.prepare(`
      INSERT INTO runtime_seat_generations (
        id, tenant, runtime_seat_id, generation, host_id, process_id,
        process_uid, sandbox_id, executable_digest, public_key,
        broker_attestation_digest, started_at, created_at
      ) VALUES (
        'seat-generation-2', ?, 'seat-1', 2, 'host-1', 'pid-2', 'uid-1',
        'sandbox-2', ?, 'public-key-2', ?,
        '2026-08-23T12:02:00.000Z', '2026-08-23T12:02:00.000Z'
      )
    `).run(TENANT, SHA_A, SHA_B)
    harness.sqlite.prepare(`
      UPDATE runtime_seats
      SET current_generation = 2, current_fencing_epoch = 2,
          updated_at = '2026-08-23T12:02:00.000Z'
      WHERE id = 'seat-1'
    `).run()

    expect(() => harness.sqlite.prepare(`
      INSERT INTO runtime_seat_leases (
        id, tenant, runtime_seat_id, generation, fencing_epoch, consumer_id,
        lease_token_hash, state, leased_at, expires_at
      ) VALUES (
        'lease-stale-generation', ?, 'seat-1', 1, 3, 'consumer-1', ?, 'active',
        '2026-08-23T12:02:01.000Z', '2026-08-23T12:03:01.000Z'
      )
    `).run(TENANT, SHA_A)).toThrow(/runtime seat generation is not current and active/i)

    expect(() => harness.sqlite.prepare(`
      INSERT INTO runtime_seat_leases (
        id, tenant, runtime_seat_id, generation, fencing_epoch, consumer_id,
        lease_token_hash, state, leased_at, expires_at
      ) VALUES (
        'lease-stale-fence', ?, 'seat-1', 2, 2, 'consumer-1', ?, 'active',
        '2026-08-23T12:02:01.000Z', '2026-08-23T12:03:01.000Z'
      )
    `).run(TENANT, SHA_A)).toThrow(/runtime seat generation is not current and active/i)
  })

  it('requires execution receipt seat IDs and generations together and valid', () => {
    insertRuntimeSeat()

    for (const [id, seatId, seatGeneration] of [
      ['receipt-seat-only', 'seat-1', null],
      ['receipt-generation-only', null, 1],
      ['receipt-zero-generation', 'seat-1', 0],
      ['receipt-unknown-generation', 'seat-1', 999],
    ] as const) {
      expect(() => harness.sqlite.prepare(`
        INSERT INTO execution_receipts (
          id, tenant, type, issuer_kind, issuer_id, actor_kind, actor_id,
          seat_id, seat_generation, idempotency_key, claims_json,
          canonical_payload, payload_digest, receipt_hash, server_timestamp
        ) VALUES (?, ?, 'runtime.consumed', 'mupot', 'mupot-server', 'agent',
          'agent-worker', ?, ?, ?, '{}', '{}', ?, ?, '2026-08-23T12:00:00.000Z')
      `).run(id, TENANT, seatId, seatGeneration, id, SHA_A, SHA_B))
        .toThrow(/check constraint|foreign key constraint/i)
    }

    expect(() => harness.sqlite.prepare(`
      INSERT INTO execution_receipts (
        id, tenant, type, issuer_kind, issuer_id, actor_kind, actor_id,
        seat_id, seat_generation, idempotency_key, claims_json,
        canonical_payload, payload_digest, receipt_hash, server_timestamp
      ) VALUES (
        'receipt-valid-seat', ?, 'runtime.consumed', 'mupot', 'mupot-server',
        'agent', 'agent-worker', 'seat-1', 1, 'receipt-valid-seat', '{}', '{}',
        ?, ?, '2026-08-23T12:00:00.000Z'
      )
    `).run(TENANT, SHA_A, SHA_B)).not.toThrow()
  })

  it('accepts dependency-linked and artifact-consumed receipt types but rejects a near-miss', () => {
    for (const [id, type, taskId] of [
      ['receipt-dependency-linked', 'flight.dependency_linked', null],
      ['receipt-artifact-consumed', 'artifact.consumed', 'task-worker'],
    ] as const) {
      harness.sqlite.prepare(`
        INSERT INTO execution_receipts (
          id, tenant, type, issuer_kind, issuer_id, actor_kind, actor_id,
          flight_id, task_id, idempotency_key, claims_json, canonical_payload,
          payload_digest, receipt_hash, server_timestamp
        ) VALUES (?, ?, ?, 'mupot', 'mupot-server', 'controller', 'controller-1',
          'flight-parent', ?, ?, '{}', '{}', ?, ?, '2026-08-23T12:00:00.000Z')
      `).run(id, TENANT, type, taskId, id, SHA_A, SHA_B)
    }

    expect(harness.sqlite.prepare(`
      SELECT type
      FROM execution_receipts
      WHERE id IN ('receipt-dependency-linked', 'receipt-artifact-consumed')
      ORDER BY type
    `).all()).toEqual([
      { type: 'artifact.consumed' },
      { type: 'flight.dependency_linked' },
    ])

    expect(() => harness.sqlite.prepare(`
      INSERT INTO execution_receipts (
        id, tenant, type, issuer_kind, issuer_id, actor_kind, actor_id,
        flight_id, idempotency_key, claims_json, canonical_payload,
        payload_digest, receipt_hash, server_timestamp
      ) VALUES (
        'receipt-artifact-consume-near-miss', ?, 'artifact.consume', 'mupot',
        'mupot-server', 'controller', 'controller-1', 'flight-parent',
        'receipt-artifact-consume-near-miss', '{}', '{}', ?, ?,
        '2026-08-23T12:00:00.000Z'
      )
    `).run(TENANT, SHA_A, SHA_B)).toThrow(/check constraint/i)
  })

  it('rejects invalid SHA-256 values', () => {
    expect(() => insertObjective('objective-invalid-digest')).not.toThrow()
    expect(() => harness.sqlite.prepare(`
      INSERT INTO objectives (
        id, tenant, created_by_principal_kind, created_by_principal_id,
        created_by_member_id, squad_id, title, success_contract,
        authority_envelope, policy_json, budget_micro_usd, payload_json,
        payload_digest, accepted_at, created_at
      ) VALUES (
        'objective-bad-digest', ?, 'member', 'principal-1', 'member-1',
        'squad-spine', 'Bad digest', 'Reject it', '{}', '{}', 0, '{}',
        'ABC123', '2026-08-23T12:00:00.000Z', '2026-08-23T12:00:00.000Z'
      )
    `).run(TENANT)).toThrow(/check constraint/i)
  })

  it('rejects a flight depending on itself', () => {
    insertObjective()
    expect(() => harness.sqlite.prepare(`
      INSERT INTO flight_dependencies (
        id, tenant, objective_id, parent_flight_id, child_flight_id,
        created_by_principal_kind, created_by_principal_id,
        created_by_member_id, created_at
      ) VALUES (
        'dependency-self', ?, 'objective-1', 'flight-parent', 'flight-parent',
        'member', 'principal-1', 'member-1', '2026-08-23T12:00:00.000Z'
      )
    `).run(TENANT)).toThrow(/check constraint/i)
  })

  it('permits only the six approved decision classes and one open dedupe key', () => {
    const classes = [
      'credential', 'deployment_or_migration', 'destructive',
      'spend', 'cross_tenant', 'business_choice',
    ]
    for (const [index, decisionClass] of classes.entries()) {
      harness.sqlite.prepare(`
        INSERT INTO decision_requests (
          id, tenant, decision_class, dedupe_key, status,
          exact_authority_required, question, options_json, consequences_json,
          evidence_json, requested_by_principal_kind, requested_by_principal_id,
          requested_by_member_id, expires_at, created_receipt_id, created_at
        ) VALUES (?, ?, ?, ?, 'open', 'Hadi approval', 'Approve?', '[]', '[]', '{}',
          'agent', 'agent-worker', 'member-1', '2026-08-24T12:00:00.000Z', NULL,
          '2026-08-23T12:00:00.000Z')
      `).run(`decision-${index}`, TENANT, decisionClass, `dedupe-${index}`)
    }

    expect(() => harness.sqlite.prepare(`
      INSERT INTO decision_requests (
        id, tenant, decision_class, dedupe_key, status,
        exact_authority_required, question, options_json, consequences_json,
        evidence_json, requested_by_principal_kind, requested_by_principal_id,
        requested_by_member_id, expires_at, created_at
      ) VALUES (
        'decision-retry', ?, 'retry_exhaustion', 'retry', 'open',
        'None', 'Retry?', '[]', '[]', '{}', 'agent', 'agent-worker', 'member-1',
        '2026-08-24T12:00:00.000Z', '2026-08-23T12:00:00.000Z'
      )
    `).run(TENANT)).toThrow(/check constraint/i)

    expect(() => harness.sqlite.prepare(`
      INSERT INTO decision_requests (
        id, tenant, decision_class, dedupe_key, status,
        exact_authority_required, question, options_json, consequences_json,
        evidence_json, requested_by_principal_kind, requested_by_principal_id,
        requested_by_member_id, expires_at, created_at
      ) VALUES (
        'decision-duplicate', ?, 'credential', 'dedupe-0', 'open',
        'Hadi approval', 'Again?', '[]', '[]', '{}', 'agent', 'agent-worker',
        'member-1', '2026-08-24T12:00:00.000Z', '2026-08-23T12:00:00.000Z'
      )
    `).run(TENANT)).toThrow(/unique/i)
  })

  it('rejects shell and PTY origins from proof records', () => {
    for (const origin of ['shell', 'pty']) {
      expect(() => harness.sqlite.prepare(`
        INSERT INTO mutation_audit_entries (
          id, tenant, principal_kind, principal_id, origin, handler, operation,
          target_kind, target_id, request_id, evidence_json, recorded_at
        ) VALUES (?, ?, 'agent', 'agent-worker', ?, 'task_update', 'update',
          'task', 'task-worker', ?, '{}', '2026-08-23T12:00:00.000Z')
      `).run(`audit-${origin}`, TENANT, origin, `request-${origin}`))
        .toThrow(/check constraint/i)

      expect(() => harness.sqlite.prepare(`
        INSERT INTO host_control_receipts (
          id, tenant, principal_kind, principal_id, origin, host_id, unit_name,
          process_generation, action, reason, request_id,
          request_signature_digest, observation_signature_digest,
          observed_result, observed_at
        ) VALUES (?, ?, 'agent', 'agent-worker', ?, 'host-1', 'runtime-1', 1,
          'restart', 'test', ?, ?, ?, 'succeeded', '2026-08-23T12:00:00.000Z')
      `).run(`control-${origin}`, TENANT, origin, `control-request-${origin}`, SHA_A, SHA_B))
        .toThrow(/check constraint/i)
    }
  })
})
