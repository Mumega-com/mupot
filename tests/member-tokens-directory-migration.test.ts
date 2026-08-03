import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSqliteD1 } from './helpers/sqlite-d1'

const MIGRATION = join(
  import.meta.dirname,
  '..',
  'migrations',
  '0076_restore_member_tokens_directory_channel.sql',
)

describe('member token directory channel recovery', () => {
  it('upgrades the production-shaped schema so OAuth can mint a directory token', () => {
    const { sqlite, close } = createSqliteD1()

    try {
      sqlite.exec(`
        CREATE TABLE members (
          id TEXT PRIMARY KEY,
          tenant TEXT
        );

        CREATE TABLE member_tokens (
          id TEXT PRIMARY KEY,
          member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          label TEXT NOT NULL DEFAULT '',
          channel TEXT NOT NULL DEFAULT 'workspace'
            CHECK (channel IN ('workspace','im','dashboard')),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          revoked_at TEXT,
          agent_id TEXT,
          tenant TEXT
        );

        CREATE TABLE agent_member_bindings (
          tenant TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          member_id TEXT NOT NULL
        );

        CREATE TABLE agent_connection_requests (
          tenant TEXT,
          actor_kind TEXT,
          actor_id TEXT,
          request_id TEXT,
          request_fingerprint TEXT,
          status TEXT,
          replace_token_id TEXT
        );

        CREATE TABLE agent_connection_receipts (
          credential_action TEXT,
          credential_issued_at TEXT,
          tenant TEXT,
          actor_kind TEXT,
          actor_id TEXT,
          request_id TEXT,
          request_fingerprint TEXT,
          member_id TEXT,
          agent_id TEXT
        );

        CREATE TRIGGER agent_member_bindings_delete_requires_no_tokens
        BEFORE DELETE ON agent_member_bindings
        WHEN EXISTS (
          SELECT 1 FROM member_tokens
           WHERE tenant = OLD.tenant
             AND agent_id = OLD.agent_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'agent_identity_conflict');
        END;

        INSERT INTO members (id, tenant) VALUES ('member-1', 'mumega');
        INSERT INTO agent_member_bindings (tenant, agent_id, member_id)
          VALUES ('mumega', 'agent-1', 'member-1');
        INSERT INTO member_tokens (
          id, member_id, token_hash, label, channel, agent_id, tenant
        ) VALUES (
          'workspace-token', 'member-1', 'workspace-hash', 'Agent',
          'workspace', 'agent-1', 'mumega'
        );
      `)

      expect(() => {
        if (existsSync(MIGRATION)) sqlite.exec(readFileSync(MIGRATION, 'utf8'))
      }).not.toThrow()

      expect(() => sqlite.exec(`
        INSERT INTO member_tokens (
          id, member_id, token_hash, label, channel, agent_id, tenant
        ) VALUES (
          'token-1', 'member-1', 'hash-1', 'ChatGPT OAuth', 'directory', NULL, 'mumega'
        );
      `)).not.toThrow()

      expect(() => sqlite.exec(`
        DELETE FROM agent_member_bindings
         WHERE tenant = 'mumega' AND agent_id = 'agent-1';
      `)).toThrow('agent_identity_conflict')
    } finally {
      close()
    }
  })
})
