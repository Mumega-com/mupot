import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readAgentInbox, sendAgentMessage } from '../src/agents/messages'
import { deliverDispatchToInbox } from '../src/bus/fleet-bridge'
import type { Env } from '../src/types'
import { createSqliteD1 } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

// sendAgentMessage's authz param is a compile-time forcing function only (#401 WARN
// follow-up) — this file exercises the raw primitive directly, not through sendToRef's
// confinement.
const TEST_AUTHZ = { system: true, reason: 'test: exercises sendAgentMessage primitive directly' } as const

function migratedProjectDb() {
  const fixture = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    fixture.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  fixture.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept', 'dept', 'Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('squad-a', 'dept', 'a', 'A'),
      ('squad-b', 'dept', 'b', 'B'),
      ('squad-c', 'dept', 'c', 'C');
    INSERT INTO agents (id, squad_id, slug, name) VALUES
      ('agent-a', 'squad-a', 'agent-a', 'Agent A'),
      ('agent-b', 'squad-b', 'agent-b', 'Agent B'),
      ('agent-outside', 'squad-c', 'agent-outside', 'Outside');
    INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES
      ('membership-a', 'agent-a', 'squad-a', 'member'),
      ('membership-b', 'agent-b', 'squad-b', 'member'),
      ('membership-outside', 'agent-outside', 'squad-c', 'member');
    INSERT INTO projects (id, slug, name, status) VALUES
      ('project-a', 'project-a', 'Project A', 'active'),
      ('project-b', 'project-b', 'Project B', 'active'),
      ('project-archived', 'project-archived', 'Archived', 'archived');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES
      ('project-a', 'squad-a', 'write'),
      ('project-a', 'squad-b', 'write'),
      ('project-b', 'squad-a', 'write'),
      ('project-b', 'squad-b', 'write');
  `)
  return fixture
}

function envWith(DB: Env['DB']): Env {
  return { DB, TENANT_SLUG: 'tenant' } as Env
}

describe('project-attributed agent messages', () => {
  it('migrates existing messages without attribution and rejects unknown, archived, or rewritten projects', () => {
    const { sqlite, close } = migratedProjectDb()
    try {
      const columns = sqlite.prepare("SELECT name FROM pragma_table_info('agent_messages')").all()
      expect(columns.map((row) => row.name)).toContain('project_id')
      expect(sqlite.prepare("SELECT name FROM pragma_index_list('agent_messages')").all().map((row) => row.name))
        .toContain('idx_agent_messages_project_created')

      sqlite.exec(`
        INSERT INTO agent_messages
          (id, tenant, to_agent, from_agent, from_member, kind, body)
        VALUES ('legacy', 'tenant', 'agent-b', 'agent-a', 'member-a', 'message', 'legacy');
      `)
      expect(sqlite.prepare("SELECT project_id FROM agent_messages WHERE id = 'legacy'").get())
        .toEqual({ project_id: null })
      expect(() => sqlite.exec(`
        INSERT INTO agent_messages
          (id, tenant, to_agent, from_agent, from_member, kind, body, project_id)
        VALUES ('missing', 'tenant', 'agent-b', 'agent-a', 'member-a', 'message', 'missing', 'missing');
      `)).toThrow(/message project not found/)
      expect(() => sqlite.exec(`
        INSERT INTO agent_messages
          (id, tenant, to_agent, from_agent, from_member, kind, body, project_id)
        VALUES ('archived', 'tenant', 'agent-b', 'agent-a', 'member-a', 'message', 'archived', 'project-archived');
      `)).toThrow(/message project archived/)
      sqlite.exec(`
        INSERT INTO agent_messages
          (id, tenant, to_agent, from_agent, from_member, kind, body, project_id)
        VALUES ('attributed', 'tenant', 'agent-b', 'agent-a', 'member-a', 'message', 'ok', 'project-a');
      `)
      expect(() => sqlite.exec("UPDATE agent_messages SET project_id = 'project-b' WHERE id = 'attributed'"))
        .toThrow(/message project immutable/)
    } finally {
      close()
    }
  })

  it('allows project participants and returns attribution through the durable inbox', async () => {
    const { db, close } = migratedProjectDb()
    try {
      const env = envWith(db)
      const sent = await sendAgentMessage(env, {
        fromAgent: 'agent-a',
        fromMember: 'member-a',
        toAgent: 'agent-b',
        body: 'project work',
        kind: 'request',
        requestId: 'project-request-1',
        projectId: 'project-a',
      }, TEST_AUTHZ, { idGen: () => 'message-a', now: () => '2026-07-18T20:00:00.000Z' })
      expect(sent).toMatchObject({ ok: true, duplicate: false })

      const inbox = await readAgentInbox(env, { agent: 'agent-b', peek: true })
      expect(inbox).toMatchObject({
        ok: true,
        messages: [{ id: 'message-a', project_id: 'project-a', body: 'project work' }],
      })
    } finally {
      close()
    }
  })

  it('fails closed when either direct-message participant lacks project access', async () => {
    const { db, close } = migratedProjectDb()
    try {
      const result = await sendAgentMessage(envWith(db), {
        fromAgent: 'agent-a',
        fromMember: 'member-a',
        toAgent: 'agent-outside',
        body: 'not shared',
        projectId: 'project-b',
      }, TEST_AUTHZ)
      expect(result).toEqual({ ok: false, reason: 'project_access_denied' })
    } finally {
      close()
    }
  })

  it('treats project attribution as immutable request-id content', async () => {
    const { db, close } = migratedProjectDb()
    try {
      const env = envWith(db)
      const first = await sendAgentMessage(env, {
        fromAgent: 'agent-a', fromMember: 'member-a', toAgent: 'agent-b', body: 'same',
        requestId: 'project-request-2', projectId: 'project-a',
      }, TEST_AUTHZ, { idGen: () => 'message-b' })
      expect(first).toMatchObject({ ok: true, duplicate: false })

      const conflict = await sendAgentMessage(env, {
        fromAgent: 'agent-a', fromMember: 'member-a', toAgent: 'agent-b', body: 'same',
        requestId: 'project-request-2', projectId: 'project-b',
      }, TEST_AUTHZ)
      expect(conflict).toMatchObject({ ok: false, reason: 'request_id_conflict' })
    } finally {
      close()
    }
  })

  it('lets the internal task-dispatch bridge inherit authoritative project context', async () => {
    const { db, sqlite, close } = migratedProjectDb()
    try {
      await deliverDispatchToInbox(envWith(db), {
        agentId: 'agent-b',
        squadId: 'squad-b',
        taskId: 'task-a',
        receiptId: 'receipt-a',
        dispatchedByMemberId: 'member-a',
        projectId: 'project-a',
      })
      expect(sqlite.prepare("SELECT project_id FROM agent_messages WHERE request_id = 'dispatch-inbox:receipt-a'").get())
        .toEqual({ project_id: 'project-a' })
    } finally {
      close()
    }
  })
})
