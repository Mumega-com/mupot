import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { readAgentInbox, readVerifiedSignedAgentInbox } from '../src/agents/messages'
import type { Env } from '../src/types'
import { createSqliteD1 } from './helpers/sqlite-d1'

function fixture() {
  const harness = createSqliteD1()
  harness.sqlite.exec(`
    CREATE TABLE members (id TEXT PRIMARY KEY);
    CREATE TABLE agents (id TEXT PRIMARY KEY);
    CREATE TABLE agent_messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      tenant TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      from_agent TEXT NOT NULL,
      from_member TEXT NOT NULL,
      kind TEXT NOT NULL,
      body TEXT NOT NULL,
      request_id TEXT,
      in_reply_to TEXT,
      created_at TEXT NOT NULL,
      read_at TEXT,
      project_id TEXT
    );
    INSERT INTO members(id) VALUES ('owner');
    INSERT INTO agents(id) VALUES ('agent-a');
  `)
  harness.sqlite.exec(readFileSync(new URL('../migrations/0058_agent_inbox_fences.sql', import.meta.url), 'utf8'))
  const env = { TENANT_SLUG: 'tenant-a', DB: harness.db } as unknown as Env
  const seed = (id: string) => harness.sqlite.exec(`
    INSERT INTO agent_messages
      (id, tenant, to_agent, from_agent, from_member, kind, body, created_at)
    VALUES ('${id}', 'tenant-a', 'agent-a', 'sender', 'owner', 'request', 'work', '2026-07-19T02:00:00Z');
  `)
  const setMode = (mode: 'bearer_only' | 'signed_only', generation: number) => harness.sqlite.exec(`
    INSERT INTO agent_inbox_fences
      (tenant, agent_id, mode, generation, key_fingerprint, updated_by_member_id, updated_at, reason)
    VALUES (
      'tenant-a', 'agent-a', '${mode}', ${generation},
      ${mode === 'signed_only' ? `'${'a'.repeat(64)}'` : 'NULL'},
      'owner', '2026-07-19T02:00:01Z', 'test transition'
    )
    ON CONFLICT(tenant, agent_id) DO UPDATE SET
      mode=excluded.mode, generation=excluded.generation,
      key_fingerprint=excluded.key_fingerprint, updated_at=excluded.updated_at,
      reason=excluded.reason;
  `)
  return { harness, env, seed, setMode }
}

function flipBeforeMessageClaim(
  env: Env,
  flip: () => void,
): Env {
  let flipped = false
  const wrap = (statement: any, sql: string): any => ({
    bind: (...values: unknown[]) => wrap(statement.bind(...values), sql),
    first: (...args: unknown[]) => statement.first(...args),
    run: (...args: unknown[]) => statement.run(...args),
    raw: (...args: unknown[]) => statement.raw(...args),
    all: (...args: unknown[]) => {
      if (!flipped && sql.includes('UPDATE agent_messages SET read_at')) {
        flipped = true
        flip()
      }
      return statement.all(...args)
    },
  })
  return {
    ...env,
    DB: { ...env.DB, prepare: (sql: string) => wrap(env.DB.prepare(sql), sql) },
  } as Env
}

describe('agent inbox consumer fence SQL', () => {
  it('enforces both directions for signed and bearer peek or consume', async () => {
    const value = fixture()
    try {
      value.seed('message-1')
      value.setMode('signed_only', 1)
      expect(await readAgentInbox(value.env, { agent: 'agent-a' })).toMatchObject({
        ok: false, reason: 'consumer_fenced',
      })
      expect(value.harness.sqlite.prepare("SELECT read_at FROM agent_messages WHERE id='message-1'").get()?.read_at).toBeNull()

      const signed = await readVerifiedSignedAgentInbox(value.env, {
        agent: 'agent-a', keyFingerprint: 'a'.repeat(64),
      })
      expect(signed).toMatchObject({ ok: true, messages: [{ id: 'message-1' }] })

      value.harness.sqlite.exec("UPDATE agent_messages SET read_at=NULL WHERE id='message-1'")
      value.setMode('bearer_only', 2)
      expect(await readVerifiedSignedAgentInbox(value.env, {
        agent: 'agent-a', peek: true, keyFingerprint: 'a'.repeat(64),
      })).toMatchObject({
        ok: false, reason: 'consumer_fenced',
      })
      expect(await readVerifiedSignedAgentInbox(value.env, {
        agent: 'agent-a', keyFingerprint: 'a'.repeat(64),
      })).toMatchObject({
        ok: false, reason: 'consumer_fenced',
      })
    } finally {
      value.harness.close()
    }
  })

  it('linearizes a bearer-to-signed transition inside the consume statement', async () => {
    const value = fixture()
    try {
      value.seed('message-1')
      const raced = flipBeforeMessageClaim(value.env, () => value.setMode('signed_only', 1))
      expect(await readAgentInbox(raced, { agent: 'agent-a' })).toMatchObject({
        ok: false, reason: 'consumer_fenced',
      })
      expect(value.harness.sqlite.prepare("SELECT read_at FROM agent_messages WHERE id='message-1'").get()?.read_at).toBeNull()
    } finally {
      value.harness.close()
    }
  })

  it('linearizes a signed-to-bearer rollback inside the consume statement', async () => {
    const value = fixture()
    try {
      value.seed('message-1')
      value.setMode('signed_only', 1)
      const raced = flipBeforeMessageClaim(value.env, () => value.setMode('bearer_only', 2))
      expect(await readVerifiedSignedAgentInbox(raced, {
        agent: 'agent-a', keyFingerprint: 'a'.repeat(64),
      })).toMatchObject({
        ok: false, reason: 'consumer_fenced',
      })
      expect(value.harness.sqlite.prepare("SELECT read_at FROM agent_messages WHERE id='message-1'").get()?.read_at).toBeNull()
    } finally {
      value.harness.close()
    }
  })

  it('rejects a signed consumer whose verified key does not match the fenced key', async () => {
    const value = fixture()
    try {
      value.seed('message-1')
      value.setMode('signed_only', 1)
      expect(await readVerifiedSignedAgentInbox(value.env, {
        agent: 'agent-a',
        keyFingerprint: 'b'.repeat(64),
      })).toMatchObject({ ok: false, reason: 'consumer_fenced' })
      expect(value.harness.sqlite.prepare("SELECT read_at FROM agent_messages WHERE id='message-1'").get()?.read_at).toBeNull()
    } finally {
      value.harness.close()
    }
  })
})
