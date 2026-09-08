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

  it('display name unique among the sender\'s visible agents resolves the same as id or slug', async () => {
    const { db, close } = migratedDb()
    try {
      const byId = await sendToRef(envWith(db), { ...baseInput, toRef: 'agent-target' }, NON_ADMIN(grant('squad-target')))
      const bySlug = await sendToRef(envWith(db), { ...baseInput, toRef: 'target' }, NON_ADMIN(grant('squad-target')))
      const byName = await sendToRef(envWith(db), { ...baseInput, toRef: 'Target' }, NON_ADMIN(grant('squad-target')))
      const byNameCase = await sendToRef(envWith(db), { ...baseInput, toRef: 'target' }, NON_ADMIN(grant('squad-target')))
      expect(byId).toMatchObject({ ok: true, toAgent: 'agent-target' })
      expect(bySlug).toMatchObject({ ok: true, toAgent: 'agent-target' })
      expect(byName).toMatchObject({ ok: true, toAgent: 'agent-target' })
      // slug 'target' already works; mixed-case display name is the agent copy-paste case
      expect(byNameCase).toMatchObject({ ok: true, toAgent: 'agent-target' })
    } finally {
      close()
    }
  })

  it('mixed-case display name of a visible agent is addressable (Kasra / Athena copy-paste)', async () => {
    const { db, close } = migratedDb()
    try {
      const res = await sendToRef(envWith(db), { ...baseInput, toRef: 'TARGET' }, NON_ADMIN(grant('squad-target')))
      expect(res).toMatchObject({ ok: true, toAgent: 'agent-target' })
    } finally {
      close()
    }
  })

  it('a visible-name send and a missing-name send are distinguishable ONLY by success — failures collapse', async () => {
    const { db, close } = migratedDb()
    try {
      const missing = await sendToRef(envWith(db), { ...baseInput, toRef: 'No Such Person' }, NON_ADMIN(grant('squad-target')))
      const invisible = await sendToRef(envWith(db), { ...baseInput, toRef: 'Outside' }, NON_ADMIN(grant('squad-target')))
      expect(missing).toEqual({ ok: false, reason: 'send_target_not_visible' })
      expect(invisible).toEqual({ ok: false, reason: 'send_target_not_visible' })
      expect(missing).toEqual(invisible)
    } finally {
      close()
    }
  })

  it('two visible agents sharing a display name collapse to send_target_not_visible (no arbitrary pick)', async () => {
    const { db, close, sqlite } = migratedDb()
    try {
      sqlite.exec(`
        INSERT INTO agents (id, squad_id, slug, name) VALUES
          ('agent-twin-a', 'squad-target', 'twin-a', 'Twin'),
          ('agent-twin-b', 'squad-target', 'twin-b', 'Twin');
        INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES
          ('membership-twin-a', 'agent-twin-a', 'squad-target', 'member'),
          ('membership-twin-b', 'agent-twin-b', 'squad-target', 'member');
      `)
      const res = await sendToRef(envWith(db), { ...baseInput, toRef: 'Twin' }, NON_ADMIN(grant('squad-target')))
      expect(res).toEqual({ ok: false, reason: 'send_target_not_visible' })
    } finally {
      close()
    }
  })

  it('one visible and one invisible agent sharing a display name addresses the visible one only', async () => {
    const { db, close, sqlite } = migratedDb()
    try {
      sqlite.exec(`
        INSERT INTO agents (id, squad_id, slug, name) VALUES
          ('agent-twin-visible', 'squad-target', 'twin-visible', 'Twin'),
          ('agent-twin-hidden', 'squad-other', 'twin-hidden', 'Twin');
        INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES
          ('membership-twin-visible', 'agent-twin-visible', 'squad-target', 'member'),
          ('membership-twin-hidden', 'agent-twin-hidden', 'squad-other', 'member');
      `)
      const res = await sendToRef(envWith(db), { ...baseInput, toRef: 'Twin' }, NON_ADMIN(grant('squad-target')))
      expect(res).toMatchObject({ ok: true, toAgent: 'agent-twin-visible' })
    } finally {
      close()
    }
  })

  it('a hidden-namespace slug can never flip a visible display-name send (#1321)', async () => {
    const { db, close, sqlite } = migratedDb()
    try {
      sqlite.exec(`
        INSERT INTO agents (id, squad_id, slug, name) VALUES ('agent-atlas', 'squad-target', 'atlas', 'Atlas');
        INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES
          ('membership-atlas', 'agent-atlas', 'squad-target', 'member');
      `)
      const expected = { ok: true, toAgent: 'agent-atlas' }
      const baseline = await sendToRef(envWith(db), { ...baseInput, toRef: 'Atlas' }, NON_ADMIN(grant('squad-target')))
      expect(baseline).toMatchObject(expected)

      // Insert a HIDDEN agent (different, invisible squad) whose SLUG is the visible name.
      // Being not visible AND not matched by name, it must not change the result at all.
      sqlite.exec(`
        INSERT INTO agents (id, squad_id, slug, name) VALUES ('agent-hidden-1', 'squad-other', 'Atlas', 'Hidden One');
        INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES
          ('membership-hidden-1', 'agent-hidden-1', 'squad-other', 'member');
      `)
      const withOneHidden = await sendToRef(envWith(db), { ...baseInput, toRef: 'Atlas' }, NON_ADMIN(grant('squad-target')))
      expect(withOneHidden).toMatchObject(expected)

      // A second hidden agent (a different squad, a different slug so id/slug resolution
      // for 'Atlas' still hits exactly the first hidden row, not an ambiguous pair — the
      // ambiguous-slug case is covered on its own below) must not change it either: general
      // hidden-namespace noise must never leak through a visible name send.
      sqlite.exec(`
        INSERT INTO agents (id, squad_id, slug, name) VALUES ('agent-hidden-2', 'squad-sender', 'hidden-two', 'Hidden Two');
        INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES
          ('membership-hidden-2', 'agent-hidden-2', 'squad-sender', 'member');
      `)
      const withTwoHidden = await sendToRef(envWith(db), { ...baseInput, toRef: 'Atlas' }, NON_ADMIN(grant('squad-target')))
      expect(withTwoHidden).toMatchObject(expected)

      const rowCount = sqlite
        .prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent = 'agent-atlas'")
        .get() as { n: number }
      expect(rowCount.n).toBe(3)
    } finally {
      close()
    }
  })

  it('two INVISIBLE agents sharing an ambiguous slug do not block a visible same-named decoy — an ambiguity purely among hidden rows is worth no more than zero matches (#1321 Pattern 8 closure)', async () => {
    const { db, close, sqlite } = migratedDb()
    try {
      // Two DIFFERENT squads (both invisible to a sender whose only grant is squad-target)
      // so both rows can legitimately share slug 'kasra' — agents.slug is
      // UNIQUE(squad_id, slug), not globally unique. Before the Pattern 8 fix,
      // resolveAgentRef collapsed these two into an opaque 'ambiguous' BEFORE visibility
      // was ever consulted, so this send refused even though neither ambiguous match is
      // reachable by this sender and a uniquely-named, squad-visible decoy exists. That
      // made "does a display-name send survive" depend on hidden-row COUNT (>=1 vs >=2),
      // an oracle over a namespace the sender cannot see. It must not.
      sqlite.exec(`
        INSERT INTO agents (id, squad_id, slug, name) VALUES
          ('agent-hidden-kasra-1', 'squad-other', 'kasra', 'Hidden Kasra One'),
          ('agent-hidden-kasra-2', 'squad-sender', 'kasra', 'Hidden Kasra Two'),
          ('agent-decoy-kasra', 'squad-target', 'decoy-kasra', 'kasra');
        INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES
          ('membership-hidden-kasra-1', 'agent-hidden-kasra-1', 'squad-other', 'member'),
          ('membership-hidden-kasra-2', 'agent-hidden-kasra-2', 'squad-sender', 'member'),
          ('membership-decoy-kasra', 'agent-decoy-kasra', 'squad-target', 'member');
      `)
      const res = await sendToRef(envWith(db), { ...baseInput, toRef: 'kasra' }, NON_ADMIN(grant('squad-target')))
      expect(res).toMatchObject({ ok: true, toAgent: 'agent-decoy-kasra' })

      const decoyRows = sqlite
        .prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent = 'agent-decoy-kasra'")
        .get() as { n: number }
      expect(decoyRows.n).toBe(1)
      const hiddenRows = sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent IN ('agent-hidden-kasra-1', 'agent-hidden-kasra-2')",
        )
        .get() as { n: number }
      expect(hiddenRows.n).toBe(0)
    } finally {
      close()
    }
  })

  it('an ambiguous slug with TWO squad-visible matches still refuses — ambiguity to the sender is real, unlike ambiguity among hidden rows (#1321 Pattern 8, positive control)', async () => {
    const { db, close, sqlite } = migratedDb()
    try {
      // Both slug-holders sit in squads the sender CAN see (squad-target, granted below,
      // and squad-sender, the sender's own squad — no observer grant is needed there since
      // recipientVisibilityOnSenderSquads treats squad_id === sender's own squad_id, via
      // membership, the same as an explicit grant would for a squadmate... to keep this a
      // clean positive control, grant BOTH squads explicitly.
      sqlite.exec(`
        INSERT INTO agents (id, squad_id, slug, name) VALUES
          ('agent-visible-kasra-1', 'squad-target', 'kasra', 'Visible Kasra One'),
          ('agent-visible-kasra-2', 'squad-other', 'kasra', 'Visible Kasra Two');
        INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES
          ('membership-visible-kasra-1', 'agent-visible-kasra-1', 'squad-target', 'member'),
          ('membership-visible-kasra-2', 'agent-visible-kasra-2', 'squad-other', 'member');
      `)
      const res = await sendToRef(
        envWith(db),
        { ...baseInput, toRef: 'kasra' },
        NON_ADMIN([...grant('squad-target'), ...grant('squad-other')]),
      )
      expect(res).toEqual({ ok: false, reason: 'send_target_not_visible' })
      const rows = sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent IN ('agent-visible-kasra-1', 'agent-visible-kasra-2')",
        )
        .get() as { n: number }
      expect(rows.n).toBe(0)
    } finally {
      close()
    }
  })

  it('a projectId must not let a hidden slug steal a unique visible display-name send (#1321)', async () => {
    const { db, close, sqlite } = migratedDb()
    try {
      sqlite.exec(`
        INSERT INTO agents (id, squad_id, slug, name) VALUES
          ('agent-atlas', 'squad-target', 'atlas', 'Atlas'),
          ('agent-hidden-atlas', 'squad-other', 'Atlas', 'Hidden Atlas');
        INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES
          ('membership-atlas', 'agent-atlas', 'squad-target', 'member'),
          ('membership-hidden-atlas', 'agent-hidden-atlas', 'squad-other', 'member');
        INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES
          ('project-shared', 'squad-other', 'write');
      `)
      const covered = await sendToRef(
        envWith(db),
        { ...baseInput, toRef: 'Atlas', projectId: 'project-shared' },
        NON_ADMIN(grant('squad-target')),
      )
      expect(covered).toMatchObject({ ok: true, toAgent: 'agent-atlas' })
      expect(sqlite.prepare(
        "SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent = 'agent-hidden-atlas'",
      ).get()).toEqual({ n: 0 })
    } finally {
      close()
    }
  })

  it('a projectId that does not cover the hidden slug still delivers the unique visible name (#1321)', async () => {
    const { db, close, sqlite } = migratedDb()
    try {
      sqlite.exec(`
        INSERT INTO agents (id, squad_id, slug, name) VALUES
          ('agent-atlas', 'squad-target', 'atlas', 'Atlas'),
          ('agent-hidden-atlas', 'squad-other', 'Atlas', 'Hidden Atlas');
        INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES
          ('membership-atlas', 'agent-atlas', 'squad-target', 'member'),
          ('membership-hidden-atlas', 'agent-hidden-atlas', 'squad-other', 'member');
      `)
      const uncovered = await sendToRef(
        envWith(db),
        { ...baseInput, toRef: 'Atlas', projectId: 'project-shared' },
        NON_ADMIN(grant('squad-target')),
      )
      expect(uncovered).toMatchObject({ ok: true, toAgent: 'agent-atlas' })
      expect(sqlite.prepare(
        "SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent = 'agent-hidden-atlas'",
      ).get()).toEqual({ n: 0 })
    } finally {
      close()
    }
  })

  it('a projectId still authorizes an invisible slug when no unique visible name matches', async () => {
    const { db, close } = migratedDb()
    try {
      const res = await sendToRef(
        envWith(db),
        { ...baseInput, toRef: 'target', projectId: 'project-shared' },
        NO_GRANTS,
      )
      expect(res).toMatchObject({ ok: true, toAgent: 'agent-target' })
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

// ── PR #1321 re-gate: resolution must be a pure function of the visible set ──────────────
// The old design decided a resolution PATH (id/slug vs. name) before deciding hidden/visible,
// and exempted the projectId branch via a caller-supplied flag — so a hidden agent's id/slug
// could capture or refuse a project-scoped send addressed by a visible agent's display name,
// and whether it did so depended on hidden-row COUNT. Every cell below must produce the
// IDENTICAL response (ok, reason, toAgent, and the resulting agent_messages row) to the
// 0-hidden cell for the same projectId — hidden-row count and projectId together must never
// change the outcome of a send addressed to a genuinely visible target.
describe('sendToRef — #1321 re-gate: response is a pure function of the visible agent set', () => {
  function envoyFixture() {
    const fixture = migratedDb()
    fixture.sqlite.exec(`
      INSERT INTO agents (id, squad_id, slug, name) VALUES ('agent-envoy', 'squad-target', 'envoy', 'Envoy');
      INSERT INTO memberships (id, agent_id, squad_id, capability)
      VALUES ('membership-envoy', 'agent-envoy', 'squad-target', 'member');
      INSERT INTO squads (id, department_id, slug, name) VALUES
        ('squad-hidden-a', 'dept', 'hidden-a', 'Hidden Squad A'),
        ('squad-hidden-b', 'dept', 'hidden-b', 'Hidden Squad B'),
        ('squad-hidden-shared', 'dept', 'hidden-shared', 'Hidden Squad Shared');
      INSERT INTO projects (id, slug, name, status) VALUES
        ('project-accessible', 'project-accessible', 'Accessible Project', 'active'),
        ('project-inaccessible', 'project-inaccessible', 'Inaccessible Project', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES
        ('project-accessible', 'squad-sender', 'write'),
        ('project-accessible', 'squad-target', 'write');
    `)
    return fixture
  }

  const PROJECT_STATES: Array<{ label: string; projectId: string | undefined }> = [
    { label: 'unset', projectId: undefined },
    { label: 'accessible', projectId: 'project-accessible' },
    { label: 'inaccessible', projectId: 'project-inaccessible' },
  ]

  const HIDDEN_STATES: Array<{ label: string; setup: (sqlite: ReturnType<typeof migratedDb>['sqlite']) => void }> = [
    { label: '0 hidden', setup: () => {} },
    {
      label: '1 hidden (no project access)',
      setup: (sqlite) => {
        sqlite.exec(`
          INSERT INTO agents (id, squad_id, slug, name) VALUES ('agent-hidden-envoy-1', 'squad-hidden-a', 'Envoy', 'Hidden Envoy One');
          INSERT INTO memberships (id, agent_id, squad_id, capability)
          VALUES ('membership-hidden-envoy-1', 'agent-hidden-envoy-1', 'squad-hidden-a', 'member');
        `)
      },
    },
    {
      label: '2 hidden (no project access, different squads)',
      setup: (sqlite) => {
        sqlite.exec(`
          INSERT INTO agents (id, squad_id, slug, name) VALUES
            ('agent-hidden-envoy-1', 'squad-hidden-a', 'Envoy', 'Hidden Envoy One'),
            ('agent-hidden-envoy-2', 'squad-hidden-b', 'Envoy', 'Hidden Envoy Two');
          INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES
            ('membership-hidden-envoy-1', 'agent-hidden-envoy-1', 'squad-hidden-a', 'member'),
            ('membership-hidden-envoy-2', 'agent-hidden-envoy-2', 'squad-hidden-b', 'member');
        `)
      },
    },
    {
      label: '1 hidden whose squad shares the (accessible) project',
      setup: (sqlite) => {
        sqlite.exec(`
          INSERT INTO agents (id, squad_id, slug, name) VALUES ('agent-hidden-envoy-shared', 'squad-hidden-shared', 'Envoy', 'Hidden Envoy Shared');
          INSERT INTO memberships (id, agent_id, squad_id, capability)
          VALUES ('membership-hidden-envoy-shared', 'agent-hidden-envoy-shared', 'squad-hidden-shared', 'member');
          INSERT INTO project_squad_access (project_id, squad_id, access_level)
          VALUES ('project-accessible', 'squad-hidden-shared', 'write');
        `)
      },
    },
  ]

  const HIDDEN_AGENT_IDS = ['agent-hidden-envoy-1', 'agent-hidden-envoy-2', 'agent-hidden-envoy-shared']

  for (const { projectId, label: projectLabel } of PROJECT_STATES) {
    it(`display-name send to a visible target is identical across hidden-slug-holder counts — projectId ${projectLabel}`, async () => {
      const results: Array<{ label: string; res: unknown; envoyRows: number; hiddenRows: number }> = []
      for (const { label, setup } of HIDDEN_STATES) {
        const { db, close, sqlite } = envoyFixture()
        try {
          setup(sqlite)
          const res = await sendToRef(
            envWith(db),
            { ...baseInput, toRef: 'Envoy', projectId },
            NON_ADMIN(grant('squad-target')),
          )
          const envoyRows = (
            sqlite.prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent = 'agent-envoy'").get() as {
              n: number
            }
          ).n
          const hiddenRows = (
            sqlite
              .prepare(
                `SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent IN (${HIDDEN_AGENT_IDS.map((id) => `'${id}'`).join(',')})`,
              )
              .get() as { n: number }
          ).n
          // Strip the message row's own generated uuid — nondeterministic per insert, not
          // part of the decision under test. Everything else (ok, reason, toAgent, seq,
          // duplicate) must be byte-identical across hidden-row counts.
          const normalized =
            res && typeof res === 'object' && 'id' in res ? { ...(res as Record<string, unknown>), id: '<uuid>' } : res
          results.push({ label, res: normalized, envoyRows, hiddenRows })
        } finally {
          close()
        }
      }

      const baseline = results[0]
      expect(baseline.label).toBe('0 hidden')
      for (const cell of results) {
        expect(cell.res, `${cell.label} vs 0-hidden, projectId ${projectLabel}`).toEqual(baseline.res)
        expect(cell.hiddenRows, `${cell.label}: no hidden agent ever received the message`).toBe(0)
        // Whatever the visible target's own message outcome was (delivered, or refused for
        // an orthogonal reason such as an inaccessible projectId), it is IDENTICAL across
        // every hidden-row count — the hidden agent never siphons off, and never blocks, a
        // message addressed to the genuinely visible target.
        expect(cell.envoyRows, cell.label).toBe(baseline.envoyRows)
      }
    })
  }

  // ── addressing a hidden agent DIRECTLY by its own id or slug — no display-name collision.
  // Must collapse to the SAME shape a genuinely nonexistent ref gets when no authorization
  // surface applies, and may only succeed when project-scoped access (case b) genuinely
  // covers that exact agent — never merely because OTHER hidden rows exist elsewhere.
  for (const { projectId, label: projectLabel } of PROJECT_STATES) {
    it(`addressing a hidden agent by its own ID collapses to not_found-shape unless project-authorized — projectId ${projectLabel}`, async () => {
      const { db, close, sqlite } = envoyFixture()
      try {
        sqlite.exec(`
          INSERT INTO agents (id, squad_id, slug, name) VALUES ('agent-lone-hidden', 'squad-hidden-a', 'lone-hidden', 'Lone Hidden');
          INSERT INTO memberships (id, agent_id, squad_id, capability)
          VALUES ('membership-lone-hidden', 'agent-lone-hidden', 'squad-hidden-a', 'member');
        `)
        const byId = await sendToRef(
          envWith(db),
          { ...baseInput, toRef: 'agent-lone-hidden', projectId },
          NON_ADMIN(grant('squad-target')),
        )
        const missing = await sendToRef(
          envWith(db),
          { ...baseInput, toRef: 'agent-does-not-exist-either', projectId },
          NON_ADMIN(grant('squad-target')),
        )
        if (projectId === 'project-accessible') {
          // squad-hidden-a has no project_squad_access row in this fixture — project does
          // NOT cover it, so it must refuse exactly like the nonexistent ref.
          expect(byId).toEqual(missing)
          expect(byId).toEqual({ ok: false, reason: 'send_target_not_visible' })
        } else {
          expect(byId).toEqual(missing)
          expect(byId).toEqual({ ok: false, reason: 'send_target_not_visible' })
        }
      } finally {
        close()
      }
    })

    it(`addressing a hidden agent by its own SLUG collapses the same way, and project-authorized access reaches it explicitly (not via display-name leakage) — projectId ${projectLabel}`, async () => {
      const { db, close, sqlite } = envoyFixture()
      try {
        sqlite.exec(`
          INSERT INTO agents (id, squad_id, slug, name) VALUES ('agent-project-hidden', 'squad-hidden-shared', 'project-hidden-slug', 'Project Hidden');
          INSERT INTO memberships (id, agent_id, squad_id, capability)
          VALUES ('membership-project-hidden', 'agent-project-hidden', 'squad-hidden-shared', 'member');
          INSERT INTO project_squad_access (project_id, squad_id, access_level)
          VALUES ('project-accessible', 'squad-hidden-shared', 'write');
        `)
        const bySlug = await sendToRef(
          envWith(db),
          { ...baseInput, toRef: 'project-hidden-slug', projectId },
          NON_ADMIN(grant('squad-target')),
        )
        if (projectId === 'project-accessible') {
          // Explicitly addressed by its OWN slug, and its squad genuinely shares the
          // project — case (b) legitimately authorizes this exact, explicitly-named agent.
          expect(bySlug).toMatchObject({ ok: true, toAgent: 'agent-project-hidden' })
        } else {
          expect(bySlug).toEqual({ ok: false, reason: 'send_target_not_visible' })
        }
      } finally {
        close()
      }
    })
  }
})

describe('sendToRef — PR #1321 follow-up mutation gaps (2026-09-05 third gate)', () => {
  it('two hidden agents sharing one slug, both project-authorized, no visible name match -> refuses (mutant projectVisible.length >= 1 take-first must go red)', async () => {
    const { db, close, sqlite } = migratedDb()
    try {
      sqlite.exec(`
        INSERT INTO departments (id, slug, name) VALUES ('dept-hidden', 'dept-hidden', 'Dept Hidden');
        INSERT INTO squads (id, department_id, slug, name) VALUES
          ('squad-hidden-a', 'dept-hidden', 'hidden-a', 'Hidden A'),
          ('squad-hidden-b', 'dept-hidden', 'hidden-b', 'Hidden B');
        INSERT INTO agents (id, squad_id, slug, name) VALUES
          ('agent-hidden-analyst-a', 'squad-hidden-a', 'analyst', 'Not Named Analyst A'),
          ('agent-hidden-analyst-b', 'squad-hidden-b', 'analyst', 'Not Named Analyst B');
        INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES
          ('membership-hidden-analyst-a', 'agent-hidden-analyst-a', 'squad-hidden-a', 'member'),
          ('membership-hidden-analyst-b', 'agent-hidden-analyst-b', 'squad-hidden-b', 'member');
        INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES
          ('project-shared', 'squad-hidden-a', 'write'),
          ('project-shared', 'squad-hidden-b', 'write');
      `)
      // Sender has NO grant on squad-hidden-a/b, so neither candidate is squad/guest
      // visible (stage 1), and neither agent's display NAME is 'analyst' (stage 2), so
      // resolution falls to stage 3: both candidates are project-authorized via
      // project-shared. That is genuine ambiguity at stage 3 and must refuse — the
      // mutant `>= 1` would instead take projectVisible[0] and dispatch silently to
      // whichever row the query happened to return first.
      const res = await sendToRef(
        envWith(db),
        { ...baseInput, toRef: 'analyst', projectId: 'project-shared' },
        NO_GRANTS,
      )
      expect(res).toEqual({ ok: false, reason: 'send_target_not_visible' })
      expect(sqlite.prepare(
        "SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent IN ('agent-hidden-analyst-a', 'agent-hidden-analyst-b')",
      ).get()).toEqual({ n: 0 })
    } finally {
      close()
    }
  })

  it('project-only-visible target: a sendAgentMessage failure after the visibility check collapses to send_target_not_visible, never the underlying reason (mutant `if (false)` must go red)', async () => {
    const { db, close, sqlite } = migratedDb()
    try {
      // Sender has NO squad/guest grant reaching agent-target — the ONLY route in is
      // stage 3's project_squad_access authorization via 'project-shared' (both
      // squad-sender and squad-target sit on it per migratedDb's fixture). Force
      // sendAgentMessage itself to fail post-visibility-check (archive the project
      // between the visibility check and the write) so squadViaProjectOnly is true and
      // the collapse branch actually fires.
      const raced = withDbHooks(envWith(db), {
        beforeMessageInsert: () => {
          sqlite.prepare("UPDATE projects SET status = 'archived' WHERE id = 'project-shared'").run()
        },
      })

      const res = await sendToRef(
        raced,
        { ...baseInput, toRef: 'agent-target', projectId: 'project-shared' },
        NO_GRANTS,
      )
      expect(res).toEqual({ ok: false, reason: 'send_target_not_visible' })
      expect(sqlite.prepare(
        "SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent = 'agent-target'",
      ).get()).toEqual({ n: 0 })
    } finally {
      close()
    }
  })

  it('admin: two active agents sharing slug "kasra", no agent named kasra -> recipient_ambiguous survives an empty name fallback', async () => {
    const { db, close, sqlite } = migratedDb()
    try {
      sqlite.exec(`
        INSERT INTO departments (id, slug, name) VALUES ('dept-kasra', 'dept-kasra', 'Dept Kasra');
        INSERT INTO squads (id, department_id, slug, name) VALUES
          ('squad-kasra-a', 'dept-kasra', 'kasra-a', 'Kasra A'),
          ('squad-kasra-b', 'dept-kasra', 'kasra-b', 'Kasra B');
        INSERT INTO agents (id, squad_id, slug, name) VALUES
          ('agent-kasra-1', 'squad-kasra-a', 'kasra', 'Not Named Kasra One'),
          ('agent-kasra-2', 'squad-kasra-b', 'kasra', 'Not Named Kasra Two');
      `)
      const res = await sendToRef(envWith(db), { ...baseInput, toRef: 'kasra' }, ADMIN)
      expect(res).toEqual({ ok: false, reason: 'recipient_ambiguous' })
      expect(sqlite.prepare(
        "SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent IN ('agent-kasra-1', 'agent-kasra-2')",
      ).get()).toEqual({ n: 0 })
    } finally {
      close()
    }
  })
})

describe('sendToRef — 4th-gate fixes (Codex re-review, 2026-09-05)', () => {
  it('F1: admin ambiguous slug never launders into a name send, even with exactly one name match', async () => {
    const { db, close, sqlite } = migratedDb()
    try {
      sqlite.exec(`
        INSERT INTO departments (id, slug, name) VALUES ('dept-f1', 'dept-f1', 'Dept F1');
        INSERT INTO squads (id, department_id, slug, name) VALUES
          ('squad-f1-a', 'dept-f1', 'f1-a', 'F1 A'),
          ('squad-f1-b', 'dept-f1', 'f1-b', 'F1 B'),
          ('squad-f1-c', 'dept-f1', 'f1-c', 'F1 C');
        INSERT INTO agents (id, squad_id, slug, name) VALUES
          ('agent-f1-slug-1', 'squad-f1-a', 'kasra', 'Not Named Kasra One'),
          ('agent-f1-slug-2', 'squad-f1-b', 'kasra', 'Not Named Kasra Two'),
          ('agent-f1-named', 'squad-f1-c', 'ops-bot', 'kasra');
      `)
      const res = await sendToRef(envWith(db), { ...baseInput, toRef: 'kasra' }, ADMIN)
      expect(res).toEqual({ ok: false, reason: 'recipient_ambiguous' })
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM agent_messages').get()).toEqual({ n: 0 })
      expect(sqlite.prepare(
        "SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent = 'agent-f1-named'",
      ).get()).toEqual({ n: 0 })
    } finally {
      close()
    }
  })

  it('F2: send.to strips exactly one leading @ so a roster-copied "@slug" handle resolves', async () => {
    const { db, close } = migratedDb()
    try {
      const res = await sendToRef(envWith(db), { ...baseInput, toRef: '@target' }, NON_ADMIN(grant('squad-target')))
      expect(res.ok).toBe(true)
      if (res.ok) expect(res.toAgent).toBe('agent-target')
    } finally {
      close()
    }
  })

  it('F2: a literal leading-@ slug is still reachable by its raw value (no double-strip, no false fallback)', async () => {
    const { db, close, sqlite } = migratedDb()
    try {
      sqlite.exec(`
        INSERT INTO agents (id, squad_id, slug, name) VALUES ('agent-at-literal', 'squad-target', '@literal', 'At Literal');
        INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES
          ('membership-at-literal', 'agent-at-literal', 'squad-target', 'member');
      `)
      const res = await sendToRef(envWith(db), { ...baseInput, toRef: '@literal' }, NON_ADMIN(grant('squad-target')))
      expect(res.ok).toBe(true)
      if (res.ok) expect(res.toAgent).toBe('agent-at-literal')
    } finally {
      close()
    }
  })

  it('F3: a visible slug and a DIFFERENT visible agent\'s display name sharing the same ref refuse rather than pick by precedence', async () => {
    const { db, close, sqlite } = migratedDb()
    try {
      sqlite.exec(`
        INSERT INTO departments (id, slug, name) VALUES ('dept-f3', 'dept-f3', 'Dept F3');
        INSERT INTO squads (id, department_id, slug, name) VALUES
          ('squad-f3-a', 'dept-f3', 'f3-a', 'F3 A'),
          ('squad-f3-b', 'dept-f3', 'f3-b', 'F3 B');
        INSERT INTO agents (id, squad_id, slug, name) VALUES
          ('agent-f3-atlas-slug', 'squad-f3-a', 'atlas', 'Slug Holder'),
          ('agent-f3-atlas-name', 'squad-f3-b', 'atlas-bot', 'Atlas');
        INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES
          ('membership-f3-slug', 'agent-f3-atlas-slug', 'squad-f3-a', 'member'),
          ('membership-f3-name', 'agent-f3-atlas-name', 'squad-f3-b', 'member');
      `)
      const grants: CapabilityGrant[] = [
        { member_id: 'member-sender', scope_type: 'squad', scope_id: 'squad-f3-a', capability: 'observer' },
        { member_id: 'member-sender', scope_type: 'squad', scope_id: 'squad-f3-b', capability: 'observer' },
      ]
      const res = await sendToRef(envWith(db), { ...baseInput, toRef: 'atlas' }, NON_ADMIN(grants))
      expect(res).toEqual({ ok: false, reason: 'send_target_not_visible' })
      expect(sqlite.prepare(
        "SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent IN ('agent-f3-atlas-slug', 'agent-f3-atlas-name')",
      ).get()).toEqual({ n: 0 })
    } finally {
      close()
    }
  })

  it('F3: an agent whose own slug and name both match itself still resolves (same-agent collision is not ambiguity)', async () => {
    const { db, close, sqlite } = migratedDb()
    try {
      sqlite.exec(`
        INSERT INTO departments (id, slug, name) VALUES ('dept-f3s', 'dept-f3s', 'Dept F3 Self');
        INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-f3s', 'dept-f3s', 'f3s', 'F3 Self');
        INSERT INTO agents (id, squad_id, slug, name) VALUES ('agent-f3-self', 'squad-f3s', 'atlas', 'atlas');
        INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES
          ('membership-f3-self', 'agent-f3-self', 'squad-f3s', 'member');
      `)
      const grants: CapabilityGrant[] = [
        { member_id: 'member-sender', scope_type: 'squad', scope_id: 'squad-f3s', capability: 'observer' },
      ]
      const res = await sendToRef(envWith(db), { ...baseInput, toRef: 'atlas' }, NON_ADMIN(grants))
      expect(res.ok).toBe(true)
      if (res.ok) expect(res.toAgent).toBe('agent-f3-self')
    } finally {
      close()
    }
  })

  it('F4: real migrated D1 lower(name)=lower(?1) is ASCII-only — a non-ASCII-case-folded name does NOT match', async () => {
    const { db, close, sqlite } = migratedDb()
    try {
      sqlite.exec(`
        INSERT INTO departments (id, slug, name) VALUES ('dept-f4', 'dept-f4', 'Dept F4');
        INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-f4', 'dept-f4', 'f4', 'F4');
        INSERT INTO agents (id, squad_id, slug, name) VALUES ('agent-f4-elodie', 'squad-f4', 'elodie-bot', 'Élodie');
      `)
      // Pin actual production D1 behaviour, not a wished-for one: SQLite's lower() leaves
      // non-ASCII code points untouched instead of case-folding them the way JS
      // .toLowerCase() does. Name is stored as 'Élodie' (accented E uppercase). Querying
      // with the accented E in LOWERCASE ('élodie') does NOT match in real D1, even though
      // every ASCII letter in the rest of the name is a case-insensitive match and JS's
      // .toLowerCase()-based mock (the bug this fix closes) would have matched it.
      const lowerAccentMisses = sqlite.prepare(
        "SELECT id FROM agents WHERE lower(name) = lower(?1) AND status != 'inactive'",
      ).all('élodie') as Array<{ id: string }>
      expect(lowerAccentMisses).toEqual([])

      // The exact stored case (including the accented letter) still matches, as does an
      // all-uppercase query — ASCII-only lower() happens to fold 'ÉLODIE' back down to
      // 'Élodie' because it leaves the leading É exactly as typed and lowers only the
      // trailing ASCII letters, which coincides with the stored value here.
      const exactCaseMatches = sqlite.prepare(
        "SELECT id FROM agents WHERE lower(name) = lower(?1) AND status != 'inactive'",
      ).all('Élodie') as Array<{ id: string }>
      expect(exactCaseMatches).toEqual([{ id: 'agent-f4-elodie' }])
    } finally {
      close()
    }
  })
})
