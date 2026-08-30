// tests/send-target-confinement.test.ts — Gate 1 (#392, DME-activation security gate 1):
// confine the welded-token `send` surface. Uses a REAL sqlite-backed D1 (migrations applied),
// not a mock re-implementation of the SQL — the same pattern as
// tests/project-message-attribution.test.ts — so this exercises the actual capabilities /
// channel_capability_grants UNION query, the real squads.department_id inheritance lookup, and
// the real project_squad_access join, not a hand-rolled stand-in for them.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sendToRef, type SendTargetAuthz } from '../src/agents/messages'
import type { Env, CapabilityGrant } from '../src/types'
import { createSqliteD1 } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function migratedDb() {
  const fixture = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    fixture.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  fixture.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept', 'dept', 'Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('squad-sender', 'dept', 'sender-squad', 'Sender Squad'),
      ('squad-target', 'dept', 'target-squad', 'Target Squad'),
      ('squad-other', 'dept', 'other-squad', 'Other Squad');
    INSERT INTO agents (id, squad_id, slug, name) VALUES
      ('agent-sender', 'squad-sender', 'sender', 'Sender'),
      ('agent-target', 'squad-target', 'target', 'Target'),
      ('agent-outside', 'squad-other', 'outside', 'Outside');
    INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES
      ('membership-sender', 'agent-sender', 'squad-sender', 'member'),
      ('membership-target', 'agent-target', 'squad-target', 'member'),
      ('membership-outside', 'agent-outside', 'squad-other', 'member');
    INSERT INTO members (id, email, display_name) VALUES
      ('member-sender', 'sender@example.test', 'Sender Member');
    INSERT INTO projects (id, slug, name, status) VALUES
      ('project-shared', 'project-shared', 'Shared Project', 'active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES
      ('project-shared', 'squad-sender', 'write'),
      ('project-shared', 'squad-target', 'write');
  `)
  return fixture
}

function envWith(DB: Env['DB']): Env {
  return { DB, TENANT_SLUG: 'tenant' } as Env
}

function withDbHooks(
  env: Env,
  hooks: {
    beforeMessageInsert?: () => void
    onPrepare?: (sql: string) => void
    maxBindValues?: number
  },
): Env {
  let insertHookFired = false
  const wrap = (statement: any, sql: string): any => ({
    bind: (...values: unknown[]) => {
      if (hooks.maxBindValues !== undefined && values.length > hooks.maxBindValues) {
        throw new Error(`D1 bind limit exceeded: ${values.length} > ${hooks.maxBindValues}`)
      }
      return wrap(statement.bind(...values), sql)
    },
    first: (...args: unknown[]) => statement.first(...args),
    all: (...args: unknown[]) => statement.all(...args),
    raw: (...args: unknown[]) => statement.raw(...args),
    run: async (...args: unknown[]) => {
      if (!insertHookFired && sql.includes('INSERT INTO agent_messages')) {
        insertHookFired = true
        hooks.beforeMessageInsert?.()
      }
      return statement.run(...args)
    },
  })
  return {
    ...env,
    DB: {
      ...env.DB,
      prepare: (sql: string) => {
        hooks.onPrepare?.(sql)
        return wrap(env.DB.prepare(sql), sql)
      },
    },
  } as Env
}

function grant(scopeId: string, capability: CapabilityGrant['capability'] = 'observer'): CapabilityGrant[] {
  return [{ member_id: 'member-sender', scope_type: 'squad', scope_id: scopeId, capability }]
}

const NO_GRANTS: SendTargetAuthz = { isAdmin: false, grants: [] }
const NON_ADMIN = (grants: CapabilityGrant[]): SendTargetAuthz => ({ isAdmin: false, grants })
const ADMIN: SendTargetAuthz = { isAdmin: true, grants: [] }

const baseInput = {
  fromAgent: 'agent-sender',
  fromMember: 'member-sender',
  body: 'hello',
}

describe('sendToRef — gate 1 send-target confinement (#392)', () => {
  it('case (a): a non-admin sender with NO squad grant cannot reach an agent outside its readable squads', async () => {
    const { db, close } = migratedDb()
    try {
      const res = await sendToRef(envWith(db), { ...baseInput, toRef: 'agent-target' }, NO_GRANTS)
      expect(res).toEqual({ ok: false, reason: 'send_target_not_visible' })
    } finally {
      close()
    }
  })

  it('case (a): a non-admin sender WITH an observer grant on the target squad CAN reach it', async () => {
    const { db, close } = migratedDb()
    try {
      const res = await sendToRef(
        envWith(db),
        { ...baseInput, toRef: 'agent-target' },
        NON_ADMIN(grant('squad-target')),
      )
      expect(res).toMatchObject({ ok: true, toAgent: 'agent-target' })
    } finally {
      close()
    }
  })

  it('a department-level grant covering the target squad also confers visibility (inheritance)', async () => {
    const { db, close } = migratedDb()
    try {
      const deptGrant: CapabilityGrant[] = [
        { member_id: 'member-sender', scope_type: 'department', scope_id: 'dept', capability: 'observer' },
      ]
      const res = await sendToRef(envWith(db), { ...baseInput, toRef: 'agent-target' }, NON_ADMIN(deptGrant))
      expect(res).toMatchObject({ ok: true, toAgent: 'agent-target' })
    } finally {
      close()
    }
  })

  it('a grant on a DIFFERENT squad does not leak visibility into the target squad', async () => {
    const { db, close } = migratedDb()
    try {
      const res = await sendToRef(
        envWith(db),
        { ...baseInput, toRef: 'agent-target' },
        NON_ADMIN(grant('squad-other')),
      )
      expect(res).toEqual({ ok: false, reason: 'send_target_not_visible' })
    } finally {
      close()
    }
  })

  it('case (a): guest membership on a squad the sender can observe is visible (shared flight squad)', async () => {
    const { db, close, sqlite } = migratedDb()
    try {
      sqlite.exec(`
        INSERT INTO memberships (id, agent_id, squad_id, capability)
        VALUES ('membership-target-guest', 'agent-target', 'squad-sender', 'member');
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-target-guest', 'member-sender', 'squad', 'squad-sender', 'observer');
      `)
      const res = await sendToRef(
        envWith(db),
        { ...baseInput, toRef: 'agent-target' },
        NON_ADMIN(grant('squad-sender')),
      )
      expect(res).toMatchObject({ ok: true, toAgent: 'agent-target' })
    } finally {
      close()
    }
  })

  it('guest membership removal before the message insert revokes visibility atomically', async () => {
    const { db, close, sqlite } = migratedDb()
    try {
      sqlite.exec(`
        INSERT INTO memberships (id, agent_id, squad_id, capability)
        VALUES ('membership-target-race', 'agent-target', 'squad-sender', 'member');
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-target-race', 'member-sender', 'squad', 'squad-sender', 'observer');
      `)
      const raced = withDbHooks(envWith(db), {
        beforeMessageInsert: () => {
          sqlite.prepare("DELETE FROM memberships WHERE id = 'membership-target-race'").run()
        },
      })

      await expect(sendToRef(
        raced,
        { ...baseInput, toRef: 'agent-target' },
        NON_ADMIN(grant('squad-sender')),
      )).resolves.toEqual({ ok: false, reason: 'send_target_not_visible' })
      expect(sqlite.prepare(
        "SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent = 'agent-target'",
      ).get()).toEqual({ n: 0 })
    } finally {
      close()
    }
  })

  it('sender grant removal before the message insert revokes guest visibility atomically', async () => {
    const { db, close, sqlite } = migratedDb()
    try {
      sqlite.exec(`
        INSERT INTO memberships (id, agent_id, squad_id, capability)
        VALUES ('membership-target-grant-race', 'agent-target', 'squad-sender', 'member');
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-target-grant-race', 'member-sender', 'squad', 'squad-sender', 'observer');
      `)
      const raced = withDbHooks(envWith(db), {
        beforeMessageInsert: () => {
          sqlite.prepare("DELETE FROM capabilities WHERE id = 'cap-target-grant-race'").run()
        },
      })

      await expect(sendToRef(
        raced,
        { ...baseInput, toRef: 'agent-target' },
        NON_ADMIN(grant('squad-sender')),
      )).resolves.toEqual({ ok: false, reason: 'send_target_not_visible' })
      expect(sqlite.prepare(
        "SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent = 'agent-target'",
      ).get()).toEqual({ n: 0 })
    } finally {
      close()
    }
  })

  it('guest visibility uses one bounded query regardless of recipient membership count', async () => {
    const { db, close, sqlite } = migratedDb()
    try {
      for (let index = 0; index < 6; index += 1) {
        sqlite.prepare(
          'INSERT INTO squads (id, department_id, slug, name) VALUES (?, ?, ?, ?)',
        ).run(`squad-guest-${index}`, 'dept', `guest-${index}`, `Guest ${index}`)
        sqlite.prepare(
          'INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES (?, ?, ?, ?)',
        ).run(`membership-guest-${index}`, 'agent-target', `squad-guest-${index}`, 'observer')
      }
      sqlite.exec(`
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-query-shape', 'member-sender', 'squad', 'squad-sender', 'observer');
      `)
      let legacyMembershipReads = 0
      let departmentReads = 0
      const observed = withDbHooks(envWith(db), {
        onPrepare: (sql) => {
          if (sql.includes('SELECT squad_id FROM memberships WHERE agent_id = ?1')) {
            legacyMembershipReads += 1
          }
          if (sql.includes('SELECT department_id FROM squads WHERE id = ?1')) {
            departmentReads += 1
          }
        },
      })

      await expect(sendToRef(
        observed,
        { ...baseInput, toRef: 'agent-target' },
        NON_ADMIN(grant('squad-sender')),
      )).resolves.toEqual({ ok: false, reason: 'send_target_not_visible' })
      expect(legacyMembershipReads).toBe(0)
      expect(departmentReads).toBeLessThanOrEqual(1)
    } finally {
      close()
    }
  })

  it('guest membership does not leak: a grant on an unrelated squad still cannot reach a guest of a different squad', async () => {
    const { db, close, sqlite } = migratedDb()
    try {
      sqlite.exec(`
        INSERT INTO memberships (id, agent_id, squad_id, capability)
        VALUES ('membership-target-guest-2', 'agent-target', 'squad-sender', 'member');
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-target-guest-other', 'member-sender', 'squad', 'squad-other', 'observer');
      `)
      const res = await sendToRef(
        envWith(db),
        { ...baseInput, toRef: 'agent-target' },
        NON_ADMIN(grant('squad-other')),
      )
      expect(res).toEqual({ ok: false, reason: 'send_target_not_visible' })
    } finally {
      close()
    }
  })

  it('supports more than 33 ambient grants without exceeding the D1 bind ceiling', async () => {
    const { db, close, sqlite } = migratedDb()
    try {
      sqlite.exec(`
        INSERT INTO memberships (id, agent_id, squad_id, capability)
        VALUES ('membership-target-many-grants', 'agent-target', 'squad-sender', 'member');
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-target-many-grants', 'member-sender', 'squad', 'squad-sender', 'observer');
      `)
      const ambient: CapabilityGrant[] = Array.from({ length: 40 }, (_, index) => ({
        member_id: 'member-sender',
        scope_type: 'squad',
        scope_id: `decoy-squad-${index}`,
        capability: 'observer',
      }))
      ambient.push(...grant('squad-sender'))

      const d1Bounded = withDbHooks(envWith(db), { maxBindValues: 100 })
      await expect(sendToRef(
        d1Bounded,
        { ...baseInput, toRef: 'agent-target' },
        NON_ADMIN(ambient),
      )).resolves.toMatchObject({ ok: true, toAgent: 'agent-target' })
    } finally {
      close()
    }
  })

  it('accepts an ambient observer ceiling backed by a durable manual lead grant', async () => {
    const { db, close, sqlite } = migratedDb()
    try {
      sqlite.exec(`
        INSERT INTO memberships (id, agent_id, squad_id, capability)
        VALUES ('membership-target-manual-clamp', 'agent-target', 'squad-sender', 'member');
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-target-manual-clamp', 'member-sender', 'squad', 'squad-sender', 'lead');
      `)

      await expect(sendToRef(
        envWith(db),
        { ...baseInput, toRef: 'agent-target' },
        NON_ADMIN(grant('squad-sender', 'observer')),
      )).resolves.toMatchObject({ ok: true, toAgent: 'agent-target' })
    } finally {
      close()
    }
  })

  it('accepts an ambient observer ceiling backed by a durable channel lead grant', async () => {
    const { db, close, sqlite } = migratedDb()
    try {
      sqlite.exec(`
        INSERT INTO memberships (id, agent_id, squad_id, capability)
        VALUES ('membership-target-channel-clamp', 'agent-target', 'squad-sender', 'member');
        INSERT INTO channel_bindings (
          id, platform, external_channel_id, squad_id, max_capability
        ) VALUES (
          'binding-channel-clamp', 'test', 'channel-clamp', 'squad-sender', 'lead'
        );
        INSERT INTO channel_capability_grants (
          id, binding_id, member_id, squad_id, capability
        ) VALUES (
          'cap-target-channel-clamp', 'binding-channel-clamp',
          'member-sender', 'squad-sender', 'lead'
        );
      `)

      await expect(sendToRef(
        envWith(db),
        { ...baseInput, toRef: 'agent-target' },
        NON_ADMIN(grant('squad-sender', 'observer')),
      )).resolves.toMatchObject({ ok: true, toAgent: 'agent-target' })
    } finally {
      close()
    }
  })

  it('keeps project-authorized OR semantics when guest membership disappears before insert', async () => {
    const { db, close, sqlite } = migratedDb()
    try {
      sqlite.exec(`
        INSERT INTO memberships (id, agent_id, squad_id, capability)
        VALUES ('membership-target-project-race', 'agent-target', 'squad-sender', 'member');
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-target-project-race', 'member-sender', 'squad', 'squad-sender', 'observer');
      `)
      const raced = withDbHooks(envWith(db), {
        beforeMessageInsert: () => {
          sqlite.prepare("DELETE FROM memberships WHERE id = 'membership-target-project-race'").run()
        },
      })

      await expect(sendToRef(
        raced,
        { ...baseInput, toRef: 'agent-target', projectId: 'project-shared' },
        NON_ADMIN(grant('squad-sender')),
      )).resolves.toMatchObject({ ok: true, toAgent: 'agent-target' })
      expect(sqlite.prepare(
        "SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent = 'agent-target' AND project_id = 'project-shared'",
      ).get()).toEqual({ n: 1 })
    } finally {
      close()
    }
  })

  it('non-leaking: a non-existent ref returns the SAME reason as a real-but-invisible agent', async () => {
    const { db, close } = migratedDb()
    try {
      const missing = await sendToRef(envWith(db), { ...baseInput, toRef: 'no-such-agent' }, NO_GRANTS)
      const invisible = await sendToRef(envWith(db), { ...baseInput, toRef: 'agent-target' }, NO_GRANTS)
      expect(missing).toEqual({ ok: false, reason: 'send_target_not_visible' })
      expect(invisible).toEqual({ ok: false, reason: 'send_target_not_visible' })
      // same shape — an attacker probing refs learns nothing that distinguishes the two cases.
      expect(missing).toEqual(invisible)
    } finally {
      close()
    }
  })

  it('case (b): a project-scoped send reaches a target outside the sender\'s readable squads when both sit on a shared project_squad_access mapping', async () => {
    const { db, close } = migratedDb()
    try {
      // No squad grant at all — visibility must come ENTIRELY from the project mapping.
      const res = await sendToRef(
        envWith(db),
        { ...baseInput, toRef: 'agent-target', projectId: 'project-shared' },
        NO_GRANTS,
      )
      expect(res).toMatchObject({ ok: true, toAgent: 'agent-target' })
    } finally {
      close()
    }
  })

  it('case (b) fails closed AND non-leaking: a projectId that does not cover the target squad collapses to send_target_not_visible, not the specific project_access_denied (re-gate fix, #401 — the specific reason was an existence oracle)', async () => {
    const { db, close } = migratedDb()
    try {
      // agent-outside sits on squad-other, which project-shared does NOT grant access to.
      // Squad-visibility (case a) fails first, so case (b) is the only remaining authority —
      // but its failure must be indistinguishable from resolveAgentRef never finding
      // agent-outside at all (see the `resolveAgentRef` !ok branch in sendToRef): both must
      // return send_target_not_visible. Returning the specific project_access_denied here
      // (the pre-fix behavior) would let a non-admin distinguish "exists, wrong project" from
      // "doesn't exist" by probing any ref with a projectId attached — an existence oracle
      // through the one field (projectId) meant to be an alternate authorization path, not a
      // side-channel.
      const res = await sendToRef(
        envWith(db),
        { ...baseInput, toRef: 'agent-outside', projectId: 'project-shared' },
        NO_GRANTS,
      )
      expect(res).toEqual({ ok: false, reason: 'send_target_not_visible' })
    } finally {
      close()
    }
  })

  it('case (b) leak-check: a NONEXISTENT ref with the SAME projectId is indistinguishable from the real-but-unauthorized agent-outside above — both return send_target_not_visible (re-gate fix, #401)', async () => {
    const { db, close } = migratedDb()
    try {
      const res = await sendToRef(
        envWith(db),
        { ...baseInput, toRef: 'agent-does-not-exist', projectId: 'project-shared' },
        NO_GRANTS,
      )
      expect(res).toEqual({ ok: false, reason: 'send_target_not_visible' })
    } finally {
      close()
    }
  })

  it('admin/owner capability keeps the pre-gate tenant-wide behavior — no squad grant required', async () => {
    const { db, close } = migratedDb()
    try {
      const res = await sendToRef(envWith(db), { ...baseInput, toRef: 'agent-outside' }, ADMIN)
      expect(res).toMatchObject({ ok: true, toAgent: 'agent-outside' })
    } finally {
      close()
    }
  })

  it('admin/owner still gets the specific recipient_not_found error (unchanged pre-gate behavior)', async () => {
    const { db, close } = migratedDb()
    try {
      const res = await sendToRef(envWith(db), { ...baseInput, toRef: 'no-such-agent' }, ADMIN)
      expect(res).toEqual({ ok: false, reason: 'recipient_not_found' })
    } finally {
      close()
    }
  })

  it('a real capabilities-table row (not a hand-built grant array) is honored end-to-end', async () => {
    const { db, sqlite, close } = migratedDb()
    try {
      sqlite.exec(`
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-1', 'member-sender', 'squad', 'squad-target', 'observer');
      `)
      const rows = await db.prepare(
        `SELECT member_id, scope_type, scope_id, capability
           FROM capabilities
          WHERE member_id = ?1
         UNION ALL
         SELECT member_id, 'squad' AS scope_type, squad_id AS scope_id, capability
           FROM channel_capability_grants
          WHERE member_id = ?1`,
      ).bind('member-sender').all<CapabilityGrant>()
      const res = await sendToRef(
        envWith(db),
        { ...baseInput, toRef: 'agent-target' },
        { isAdmin: false, grants: rows.results ?? [] },
      )
      expect(res).toMatchObject({ ok: true, toAgent: 'agent-target' })
    } finally {
      close()
    }
  })
})
