import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const DIR = join(__dirname, '..', 'migrations')
const TARGET = '0071_agent_connections.sql'
const NOW = '2026-07-24T00:00:00.000Z'
const LATER = '2026-07-24T00:15:00.000Z'
const EXPIRES = '2026-07-25T00:00:00.000Z'
const FINGERPRINT_A = 'a'.repeat(64)
const FINGERPRINT_B = 'b'.repeat(64)

type Sqlite = SqliteD1Harness['sqlite']

function applyBeforeTarget(sqlite: Sqlite): void {
  for (const file of readdirSync(DIR)
    .filter((name) => name.endsWith('.sql') && name < TARGET)
    .sort()) {
    sqlite.exec(readFileSync(join(DIR, file), 'utf8'))
  }
}

function applyTarget(sqlite: Sqlite): void {
  sqlite.exec(readFileSync(join(DIR, TARGET), 'utf8'))
}

function seedOrg(sqlite: Sqlite): void {
  sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Dept');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('squad-home', 'dept-1', 'home', 'Home'),
      ('squad-other', 'dept-1', 'other', 'Other');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status)
      VALUES ('agent-1', 'squad-home', 'agent', 'Agent', 'member', 'test', 'active');
    INSERT INTO members (id, display_name, status, tenant)
      VALUES ('member-1', 'Agent Member', 'active', 'tenant-a');
  `)
}

function createBeforeTargetHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  applyBeforeTarget(harness.sqlite)
  seedOrg(harness.sqlite)
  return harness
}

function addSecondAgentAndMember(sqlite: Sqlite): void {
  sqlite.exec(`
    INSERT INTO agents (id, squad_id, slug, name, role, model, status)
      VALUES ('agent-2', 'squad-other', 'agent-two', 'Agent Two', 'member', 'test', 'active');
    INSERT INTO members (id, display_name, status, tenant)
      VALUES ('member-2', 'Second Member', 'active', 'tenant-a');
  `)
}

function insertRequest(
  sqlite: Sqlite,
  overrides: Partial<{
    tenant: string
    actorKind: 'user' | 'member'
    actorId: string
    requestId: string
    fingerprint: string
    targetKey: string
    status: 'pending' | 'credential_issued' | 'client_connected' | 'messaging_verified' | 'failed' | 'expired'
  }> = {},
): void {
  const input = {
    tenant: 'tenant-a',
    actorKind: 'user' as const,
    actorId: 'actor-1',
    requestId: 'request-1',
    fingerprint: FINGERPRINT_A,
    targetKey: 'agent:agent-1',
    status: 'pending' as const,
    ...overrides,
  }
  sqlite.prepare(`
    INSERT INTO agent_connection_requests (
      tenant, actor_kind, actor_id, request_id, request_fingerprint,
      target_key, agent_mode, credential_action, status,
      created_at, updated_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'existing', 'issue_if_missing', ?, ?, ?, ?)
  `).run(
    input.tenant,
    input.actorKind,
    input.actorId,
    input.requestId,
    input.fingerprint,
    input.targetKey,
    input.status,
    NOW,
    NOW,
    EXPIRES,
  )
}

function insertReceipt(
  sqlite: Sqlite,
  overrides: Partial<{
    id: string
    actorKind: 'user' | 'member'
    actorId: string
    requestId: string
    fingerprint: string
  }> = {},
): void {
  const input = {
    id: 'receipt-1',
    actorKind: 'user' as const,
    actorId: 'actor-1',
    requestId: 'request-1',
    fingerprint: FINGERPRINT_A,
    ...overrides,
  }
  sqlite.prepare(`
    INSERT INTO agent_connection_receipts (
      id, tenant, actor_kind, actor_id, request_id, request_fingerprint,
      agent_id, agent_slug, agent_status_at_issue, member_id, token_id,
      agent_disposition, credential_action, home_squad_id, home_capability,
      additional_access_json, token_label, endpoint, transport,
      verification_status, verification_challenge_hash,
      verification_expires_at, checks_json, credential_issued_at,
      created_at, updated_at
    ) VALUES (
      ?, 'tenant-a', ?, ?, ?, ?,
      'agent-1', 'agent', 'active', 'member-1', 'token-1',
      'reused', 'issue_if_missing', 'squad-home', 'member',
      '[]', 'primary', 'https://pot.example/mcp', 'streamable_http',
      'pending', 'challenge-hash', ?, ?, ?, ?, ?
    )
  `).run(
    input.id,
    input.actorKind,
    input.actorId,
    input.requestId,
    input.fingerprint,
    LATER,
    JSON.stringify({
      boot_context: 'not_run',
      orient: 'not_run',
      send: 'not_run',
      inbox_peek: 'not_run',
      cleanup: 'not_run',
    }),
    NOW,
    NOW,
    NOW,
  )
}

describe('0071 agent connection contract migration', () => {
  it('backfills one binding from all historical tokens for one member', () => {
    const h = createBeforeTargetHarness()
    try {
      h.sqlite.exec(`
        INSERT INTO member_tokens
          (id, member_id, token_hash, label, channel, created_at, revoked_at, agent_id, tenant)
        VALUES
          ('token-live', 'member-1', 'hash-live', '', 'workspace', '${NOW}', NULL, 'agent-1', 'tenant-a'),
          ('token-old', 'member-1', 'hash-old', '', 'workspace', '${NOW}', '${LATER}', 'agent-1', 'tenant-a');
      `)

      applyTarget(h.sqlite)

      expect(h.sqlite.prepare(
        'SELECT tenant, agent_id, member_id FROM agent_member_bindings',
      ).all()).toEqual([{ tenant: 'tenant-a', agent_id: 'agent-1', member_id: 'member-1' }])
    } finally {
      h.close()
    }
  })

  it('blocks migration when one agent has two historical members', () => {
    const h = createBeforeTargetHarness()
    try {
      addSecondAgentAndMember(h.sqlite)
      h.sqlite.exec(`
        INSERT INTO member_tokens
          (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
        VALUES
          ('token-1', 'member-1', 'hash-1', '', 'workspace', '${NOW}', 'agent-1', 'tenant-a'),
          ('token-2', 'member-2', 'hash-2', '', 'workspace', '${NOW}', 'agent-1', 'tenant-a');
      `)

      expect(() => applyTarget(h.sqlite)).toThrow(/CHECK constraint failed.*ok/)
    } finally {
      h.close()
    }
  })

  it('blocks migration when a historical welded token has no tenant', () => {
    const h = createBeforeTargetHarness()
    try {
      h.sqlite.exec(`
        INSERT INTO member_tokens
          (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
        VALUES ('token-null-tenant', 'member-1', 'hash-null', '', 'workspace', '${NOW}', 'agent-1', NULL);
      `)

      expect(() => applyTarget(h.sqlite)).toThrow(/CHECK constraint failed.*ok/)
    } finally {
      h.close()
    }
  })

  it('blocks migration when a historical canonical home grant exceeds member', () => {
    const h = createBeforeTargetHarness()
    try {
      h.sqlite.exec(`
        INSERT INTO member_tokens
          (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
        VALUES ('token-1', 'member-1', 'hash-1', '', 'workspace', '${NOW}', 'agent-1', 'tenant-a');
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('grant-home-high', 'member-1', 'squad', 'squad-home', 'admin');
      `)

      expect(() => applyTarget(h.sqlite)).toThrow(/CHECK constraint failed.*ok/)
    } finally {
      h.close()
    }
  })

  it.each([
    ['org', 'NULL'],
    ['department', "'dept-1'"],
  ])('blocks migration when a historical canonical member inherits a high %s grant', (
    scopeType,
    scopeId,
  ) => {
    const h = createBeforeTargetHarness()
    try {
      h.sqlite.exec(`
        INSERT INTO member_tokens
          (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
        VALUES ('token-1', 'member-1', 'hash-1', '', 'workspace', '${NOW}', 'agent-1', 'tenant-a');
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('grant-inherited-high', 'member-1', '${scopeType}', ${scopeId}, 'admin');
      `)

      expect(() => applyTarget(h.sqlite)).toThrow(/CHECK constraint failed.*ok/)
    } finally {
      h.close()
    }
  })

  it('enforces the home capability ceiling on every insert and update path', () => {
    const h = createBeforeTargetHarness()
    try {
      applyTarget(h.sqlite)
      h.sqlite.exec(`
        INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
        VALUES ('tenant-a', 'agent-1', 'member-1', '${NOW}');
      `)

      expect(() => h.sqlite.exec(`
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('grant-home-high', 'member-1', 'squad', 'squad-home', 'lead');
      `)).toThrow(/home_capability_ceiling/)
      expect(() => h.sqlite.exec(`
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('grant-org-high', 'member-1', 'org', NULL, 'admin');
      `)).toThrow(/home_capability_ceiling/)
      expect(() => h.sqlite.exec(`
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('grant-dept-high', 'member-1', 'department', 'dept-1', 'lead');
      `)).toThrow(/home_capability_ceiling/)

      h.sqlite.exec(`
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES
          ('grant-home', 'member-1', 'squad', 'squad-home', 'member'),
          ('grant-org-low', 'member-1', 'org', NULL, 'member'),
          ('grant-cross', 'member-1', 'squad', 'squad-other', 'admin');
      `)
      expect(() => h.sqlite.exec(`
        UPDATE capabilities
           SET capability = 'admin'
         WHERE id = 'grant-home';
      `)).toThrow(/home_capability_ceiling/)
      expect(h.sqlite.prepare(
        "SELECT capability FROM capabilities WHERE id = 'grant-cross'",
      ).get()).toEqual({ capability: 'admin' })
      expect(() => h.sqlite.exec(`
        UPDATE capabilities
           SET capability = 'owner'
         WHERE id = 'grant-org-low';
      `)).toThrow(/home_capability_ceiling/)

      expect(() => h.sqlite.exec(`
        UPDATE agents SET squad_id = 'squad-other' WHERE id = 'agent-1';
      `)).toThrow(/home_capability_ceiling/)

      h.sqlite.exec(`
        INSERT INTO departments (id, slug, name) VALUES ('dept-2', 'other-dept', 'Other Dept');
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('grant-future-dept', 'member-1', 'department', 'dept-2', 'admin');
      `)
      expect(() => h.sqlite.exec(`
        UPDATE squads SET department_id = 'dept-2' WHERE id = 'squad-home';
      `)).toThrow(/home_capability_ceiling/)

      addSecondAgentAndMember(h.sqlite)
      h.sqlite.exec(`
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('grant-second-high', 'member-2', 'org', NULL, 'admin');
      `)
      expect(() => h.sqlite.exec(`
        INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
        VALUES ('tenant-a', 'agent-2', 'member-2', '${NOW}');
      `)).toThrow(/home_capability_ceiling/)
    } finally {
      h.close()
    }
  })

  it('allows multiple historical and future tokens only for the canonical member', () => {
    const h = createBeforeTargetHarness()
    try {
      addSecondAgentAndMember(h.sqlite)
      h.sqlite.exec(`
        INSERT INTO member_tokens
          (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
        VALUES
          ('token-1', 'member-1', 'hash-1', '', 'workspace', '${NOW}', 'agent-1', 'tenant-a'),
          ('token-2', 'member-1', 'hash-2', '', 'workspace', '${NOW}', 'agent-1', 'tenant-a');
      `)
      applyTarget(h.sqlite)

      h.sqlite.exec(`
        INSERT INTO member_tokens
          (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
        VALUES ('token-3', 'member-1', 'hash-3', '', 'workspace', '${NOW}', 'agent-1', 'tenant-a');
      `)
      expect(h.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM member_tokens WHERE agent_id = 'agent-1'",
      ).get()).toEqual({ count: 3 })
      expect(() => h.sqlite.exec(`
        INSERT INTO member_tokens
          (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
        VALUES ('token-bad', 'member-2', 'hash-bad', '', 'workspace', '${NOW}', 'agent-1', 'tenant-a');
      `)).toThrow(/agent_identity_conflict/)
    } finally {
      h.close()
    }
  })

  it('rejects welded token insert and identity updates that do not match the binding', () => {
    const h = createBeforeTargetHarness()
    try {
      addSecondAgentAndMember(h.sqlite)
      applyTarget(h.sqlite)
      h.sqlite.exec(`
        INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
        VALUES ('tenant-a', 'agent-1', 'member-1', '${NOW}');
        INSERT INTO member_tokens
          (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
        VALUES ('token-1', 'member-1', 'hash-1', '', 'workspace', '${NOW}', 'agent-1', 'tenant-a');
      `)

      expect(() => h.sqlite.exec(`
        INSERT INTO member_tokens
          (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
        VALUES ('token-bad', 'member-2', 'hash-bad', '', 'workspace', '${NOW}', 'agent-1', 'tenant-a');
      `)).toThrow(/agent_identity_conflict/)
      expect(() => h.sqlite.exec(
        "UPDATE member_tokens SET member_id = 'member-2' WHERE id = 'token-1'",
      )).toThrow(/agent_identity_conflict/)
      expect(() => h.sqlite.exec(
        "UPDATE member_tokens SET agent_id = 'agent-2' WHERE id = 'token-1'",
      )).toThrow(/agent_identity_conflict/)

      h.sqlite.exec(`
        INSERT INTO member_tokens
          (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
        VALUES ('human-token', 'member-2', 'hash-human', '', 'workspace', '${NOW}', NULL, 'tenant-a');
      `)
    } finally {
      h.close()
    }
  })

  it('makes bindings immutable and retains them while any welded token exists', () => {
    const h = createBeforeTargetHarness()
    try {
      addSecondAgentAndMember(h.sqlite)
      applyTarget(h.sqlite)
      h.sqlite.exec(`
        INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
        VALUES ('tenant-a', 'agent-1', 'member-1', '${NOW}');
        INSERT INTO member_tokens
          (id, member_id, token_hash, label, channel, created_at, revoked_at, agent_id, tenant)
        VALUES ('token-old', 'member-1', 'hash-old', '', 'workspace', '${NOW}', '${LATER}', 'agent-1', 'tenant-a');
      `)

      expect(() => h.sqlite.exec(`
        UPDATE agent_member_bindings
           SET member_id = 'member-2'
         WHERE tenant = 'tenant-a' AND agent_id = 'agent-1'
      `)).toThrow(/agent_identity_conflict/)
      expect(() => h.sqlite.exec(`
        DELETE FROM agent_member_bindings
         WHERE tenant = 'tenant-a' AND agent_id = 'agent-1'
      `)).toThrow(/agent_identity_conflict/)

      h.sqlite.exec(`
        DELETE FROM member_tokens WHERE id = 'token-old';
        DELETE FROM agent_member_bindings
         WHERE tenant = 'tenant-a' AND agent_id = 'agent-1';
      `)
      expect(h.sqlite.prepare('SELECT COUNT(*) AS count FROM agent_member_bindings').get())
        .toEqual({ count: 0 })
    } finally {
      h.close()
    }
  })

  it('prevents one canonical member from binding to two agents in one tenant', () => {
    const h = createBeforeTargetHarness()
    try {
      addSecondAgentAndMember(h.sqlite)
      applyTarget(h.sqlite)
      h.sqlite.exec(`
        INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
        VALUES ('tenant-a', 'agent-1', 'member-1', '${NOW}');
      `)

      expect(() => h.sqlite.exec(`
        INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
        VALUES ('tenant-a', 'agent-2', 'member-1', '${NOW}');
      `)).toThrow()
    } finally {
      h.close()
    }
  })

  it('scopes request identity to tenant, actor kind, and actor id', () => {
    const h = createBeforeTargetHarness()
    try {
      applyTarget(h.sqlite)

      insertRequest(h.sqlite, { actorId: 'actor-1', targetKey: 'agent:agent-1' })
      insertRequest(h.sqlite, {
        actorId: 'actor-2',
        targetKey: 'new:squad-home:agent-two',
      })
      insertRequest(h.sqlite, {
        actorKind: 'member',
        actorId: 'actor-1',
        targetKey: 'new:squad-home:agent-three',
      })

      expect(h.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM agent_connection_requests WHERE request_id = 'request-1'",
      ).get()).toEqual({ count: 3 })
      expect(() => insertRequest(h.sqlite, {
        actorId: 'actor-1',
        targetKey: 'new:squad-home:duplicate-request',
      })).toThrow()
    } finally {
      h.close()
    }
  })

  it('permits only one pending request for a tenant target across actors', () => {
    const h = createBeforeTargetHarness()
    try {
      applyTarget(h.sqlite)
      insertRequest(h.sqlite, { actorId: 'actor-1' })

      expect(() => insertRequest(h.sqlite, {
        actorId: 'actor-2',
        requestId: 'request-2',
      })).toThrow()

      h.sqlite.exec(`
        UPDATE agent_connection_requests
           SET status = 'credential_issued', updated_at = '${LATER}'
         WHERE tenant = 'tenant-a'
           AND actor_kind = 'user'
           AND actor_id = 'actor-1'
           AND request_id = 'request-1';
      `)
      insertRequest(h.sqlite, {
        actorId: 'actor-2',
        requestId: 'request-2',
      })
    } finally {
      h.close()
    }
  })

  it('requires an actor-scoped matching pending request before receipt insert', () => {
    const h = createBeforeTargetHarness()
    try {
      applyTarget(h.sqlite)

      expect(() => insertReceipt(h.sqlite)).toThrow(/agent_connection_request_not_pending/)
      insertRequest(h.sqlite)
      expect(() => insertReceipt(h.sqlite, {
        id: 'receipt-wrong-fingerprint',
        fingerprint: FINGERPRINT_B,
      })).toThrow(/agent_connection_request_not_pending/)
      expect(() => insertReceipt(h.sqlite, {
        id: 'receipt-wrong-actor',
        actorId: 'actor-2',
      })).toThrow(/agent_connection_request_not_pending/)

      h.sqlite.exec(`
        UPDATE agent_connection_requests
           SET status = 'credential_issued'
         WHERE tenant = 'tenant-a'
           AND actor_kind = 'user'
           AND actor_id = 'actor-1'
           AND request_id = 'request-1';
      `)
      expect(() => insertReceipt(h.sqlite, {
        id: 'receipt-finalized-request',
      })).toThrow(/agent_connection_request_not_pending/)

      h.sqlite.exec(`
        UPDATE agent_connection_requests
           SET status = 'pending'
         WHERE tenant = 'tenant-a'
           AND actor_kind = 'user'
           AND actor_id = 'actor-1'
           AND request_id = 'request-1';
      `)
      insertReceipt(h.sqlite)
    } finally {
      h.close()
    }
  })

  it('keeps issuance snapshot columns immutable while allowing verification updates', () => {
    const h = createBeforeTargetHarness()
    try {
      applyTarget(h.sqlite)
      insertRequest(h.sqlite)
      insertReceipt(h.sqlite)

      const triggerSql = h.sqlite.prepare(`
        SELECT sql
          FROM sqlite_master
         WHERE type = 'trigger'
           AND name = 'agent_connection_receipts_immutable_snapshot'
      `).get()?.sql
      expect(typeof triggerSql).toBe('string')
      for (const column of [
        'id',
        'tenant',
        'actor_kind',
        'actor_id',
        'request_id',
        'request_fingerprint',
        'agent_id',
        'agent_slug',
        'agent_status_at_issue',
        'member_id',
        'token_id',
        'agent_disposition',
        'credential_action',
        'home_squad_id',
        'home_capability',
        'additional_access_json',
        'token_label',
        'endpoint',
        'transport',
        'credential_issued_at',
        'created_at',
      ]) {
        expect(triggerSql).toContain(`NEW.${column} IS NOT OLD.${column}`)
      }

      expect(() => h.sqlite.exec(`
        UPDATE agent_connection_receipts
           SET endpoint = 'https://attacker.example/mcp'
         WHERE id = 'receipt-1'
      `)).toThrow(/agent_connection_receipt_immutable/)

      const passedChecks = JSON.stringify({
        boot_context: 'pass',
        orient: 'pass',
        send: 'pass',
        inbox_peek: 'pass',
        cleanup: 'pass',
      })
      h.sqlite.prepare(`
        UPDATE agent_connection_receipts
           SET verification_status = 'pass',
               verification_challenge_hash = NULL,
               verification_expires_at = NULL,
               client_connected_at = ?,
               verification_message_id = 'message-1',
               verification_request_id = 'verify-request-1',
               messaging_verified_at = ?,
               verification_error_code = NULL,
               checks_json = ?,
               updated_at = ?
         WHERE id = 'receipt-1'
      `).run(LATER, LATER, passedChecks, LATER)

      expect(h.sqlite.prepare(`
        SELECT verification_status, verification_challenge_hash,
               client_connected_at, verification_message_id,
               verification_request_id, messaging_verified_at,
               verification_error_code, checks_json, updated_at
          FROM agent_connection_receipts
         WHERE id = 'receipt-1'
      `).get()).toEqual({
        verification_status: 'pass',
        verification_challenge_hash: null,
        client_connected_at: LATER,
        verification_message_id: 'message-1',
        verification_request_id: 'verify-request-1',
        messaging_verified_at: LATER,
        verification_error_code: null,
        checks_json: passedChecks,
        updated_at: LATER,
      })
    } finally {
      h.close()
    }
  })

  it('enforces fingerprint, replace-action, and JSON shape constraints', () => {
    const h = createBeforeTargetHarness()
    try {
      applyTarget(h.sqlite)

      expect(() => insertRequest(h.sqlite, {
        fingerprint: 'not-a-sha256',
      })).toThrow()
      expect(() => h.sqlite.exec(`
        INSERT INTO agent_connection_requests (
          tenant, actor_kind, actor_id, request_id, request_fingerprint,
          target_key, agent_mode, credential_action, replace_token_id, status,
          created_at, updated_at, expires_at
        ) VALUES (
          'tenant-a', 'user', 'actor-1', 'replace-without-token', '${FINGERPRINT_A}',
          'agent:agent-1', 'existing', 'replace', NULL, 'pending',
          '${NOW}', '${NOW}', '${EXPIRES}'
        )
      `)).toThrow()

      insertRequest(h.sqlite)
      expect(() => h.sqlite.prepare(`
        INSERT INTO agent_connection_receipts (
          id, tenant, actor_kind, actor_id, request_id, request_fingerprint,
          agent_id, agent_slug, agent_status_at_issue, member_id, token_id,
          agent_disposition, credential_action, home_squad_id, home_capability,
          additional_access_json, token_label, endpoint, transport,
          verification_status, checks_json, credential_issued_at, created_at, updated_at
        ) VALUES (
          'receipt-invalid-json', 'tenant-a', 'user', 'actor-1', 'request-1', ?,
          'agent-1', 'agent', 'active', 'member-1', 'token-1',
          'reused', 'issue_if_missing', 'squad-home', 'member',
          '{}', 'primary', 'https://pot.example/mcp', 'streamable_http',
          'pending', '[]', ?, ?, ?
        )
      `).run(FINGERPRINT_A, NOW, NOW, NOW)).toThrow()

      const requestColumns = h.sqlite.prepare(
        "SELECT name FROM pragma_table_info('agent_connection_requests')",
      ).all().map((row) => row.name)
      const receiptColumns = h.sqlite.prepare(
        "SELECT name FROM pragma_table_info('agent_connection_receipts')",
      ).all().map((row) => row.name)
      for (const forbidden of [
        'raw_token',
        'token_hash',
        'configuration',
        'verification_challenge',
        'message_body',
      ]) {
        expect(requestColumns).not.toContain(forbidden)
        expect(receiptColumns).not.toContain(forbidden)
      }
    } finally {
      h.close()
    }
  })
})
