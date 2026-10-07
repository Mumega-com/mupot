// mupot#1730 — task_dispatch must refuse a task whose gate_owner has no eligible
// INDEPENDENT credentialed holder (the same hasIndependentRuntimeGate predicate the
// `completed` runtime receipt enforces), instead of accepting work that can never settle.
// Real-schema harness (applyAllMigrations) — no hand-written gate_grants/member_tokens DDL.
import { describe, expect, it } from 'vitest'

import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'tenant-1730'
const T0 = '2026-10-07T00:00:00.000Z'
const SQUAD = 'squad-d'
const OTHER_SQUAD = 'squad-other'
const WORKER = 'agent-worker'
const GATE_AGENT = 'agent-gate'
const WORKER_MEMBER = 'member-worker'
const GATE_MEMBER = 'member-gate'
const TASK = 'task-1730'

function fixture(opts: { gateOwner: string | null; gateStanding: 'squad' | 'other-squad' }) {
  const h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'd', 'D');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('${SQUAD}', 'dept-1', 'sq', 'Sq'), ('${OTHER_SQUAD}', 'dept-1', 'other', 'Other');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES
      ('${WORKER}', '${SQUAD}', 'worker', 'Worker', 'active'),
      ('${GATE_AGENT}', '${OTHER_SQUAD}', 'gater', 'Gater', 'active');
    INSERT INTO members (id, display_name, status, tenant) VALUES
      ('${WORKER_MEMBER}', 'W', 'active', '${TENANT}'), ('${GATE_MEMBER}', 'G', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('cap-w', '${WORKER_MEMBER}', 'squad', '${SQUAD}', 'member'),
      ('cap-g', '${GATE_MEMBER}', 'squad', '${opts.gateStanding === 'squad' ? SQUAD : OTHER_SQUAD}', 'member');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES
      ('${TENANT}', '${WORKER}', '${WORKER_MEMBER}', '${T0}'),
      ('${TENANT}', '${GATE_AGENT}', '${GATE_MEMBER}', '${T0}');
    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, revoked_at, agent_id, tenant, expires_at)
    VALUES ('tok-g', '${GATE_MEMBER}', 'hash-g', 'gate', 'workspace', '${T0}', NULL, '${GATE_AGENT}', '${TENANT}', '2099-01-01T00:00:00.000Z');
    INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
      VALUES ('gg-1', 'gate:gater', 'agent', '${GATE_AGENT}', '${WORKER_MEMBER}', '${T0}');
  `)
  h.sqlite.prepare(
    `INSERT INTO tasks (id, squad_id, title, body, done_when, status, assignee_agent_id, gate_owner, created_at, updated_at)
     VALUES (?, ?, 't', 'b', 'done', 'open', ?, ?, ?, ?)`,
  ).run(TASK, SQUAD, WORKER, opts.gateOwner, T0, T0)
  const auth: AuthContext = {
    userId: WORKER_MEMBER, tenant: TENANT, channel: 'workspace', role: 'member',
    memberId: WORKER_MEMBER, tokenId: 'tok-w', boundAgentId: null,
    capabilities: [{ member_id: WORKER_MEMBER, scope_type: 'squad', scope_id: SQUAD, capability: 'member' }],
  }
  const env = { TENANT_SLUG: TENANT, DB: h.db } as Env
  return { h, env, auth }
}

const dispatch = (f: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}) =>
  invokeTool(f.auth, f.env, 'task_dispatch', { task_id: TASK, ...extra }, 'https://pot.test')

/** Replace the agent holder with an independent HUMAN member holder of gate:hadi. */
function memberOnlyHolder(f: ReturnType<typeof fixture>, standing: boolean) {
  f.h.sqlite.exec(`
    DELETE FROM gate_grants;
    INSERT INTO members (id, display_name, status, tenant) VALUES ('member-human', 'Human', 'active', '${TENANT}');
    ${standing ? `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-h', 'member-human', 'squad', '${SQUAD}', 'member');` : ''}
    INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
      VALUES ('gg-h', 'gate:hadi', 'member', 'member-human', '${WORKER_MEMBER}', '${T0}');
    UPDATE tasks SET gate_owner = 'gate:hadi' WHERE id = '${TASK}';
  `)
}

describe('task_dispatch gate-holder preflight (#1730)', () => {
  it('refuses a cross-squad gate holder with no standing on the task squad', async () => {
    const f = fixture({ gateOwner: 'gate:gater', gateStanding: 'other-squad' })
    try {
      const out = await dispatch(f)
      expect(out).toMatchObject({
        ok: false, status: 409, error: 'no_eligible_gate_holder',
        detail: { gate_owner: 'gate:gater', squad_id: SQUAD, reason: 'no_squad_standing' },
      })
      expect(f.h.sqlite.prepare('SELECT COUNT(*) AS n FROM task_dispatch_receipts').get()).toEqual({ n: 0 })
    } finally { f.h.close() }
  })

  it('refuses a gate_owner nobody holds', async () => {
    const f = fixture({ gateOwner: 'gate:nobody', gateStanding: 'squad' })
    try {
      expect(await dispatch(f)).toMatchObject({
        ok: false, status: 409, error: 'no_eligible_gate_holder', detail: { reason: 'no_holder' },
      })
    } finally { f.h.close() }
  })

  it('dispatches when an eligible independent holder exists', async () => {
    const f = fixture({ gateOwner: 'gate:gater', gateStanding: 'squad' })
    try {
      const out = await dispatch(f)
      expect(out.ok).toBe(true)
      expect(f.h.sqlite.prepare('SELECT COUNT(*) AS n FROM task_dispatch_receipts').get()).toEqual({ n: 1 })
    } finally { f.h.close() }
  })

  it.each([null, 'gate:agent-self-completion'])('does not change behaviour for gate_owner=%s', async (gateOwner) => {
    const f = fixture({ gateOwner, gateStanding: 'other-squad' })
    try {
      const out = await dispatch(f)
      expect(out.ok).toBe(true)
    } finally { f.h.close() }
  })

  it('member-only holder: normal dispatch OK (in-worker route can settle via human verdict)', async () => {
    const f = fixture({ gateOwner: 'gate:gater', gateStanding: 'squad' })
    try {
      memberOnlyHolder(f, true)
      expect((await dispatch(f)).ok).toBe(true)
    } finally { f.h.close() }
  })

  it('member-only holder: forced delivery:inbox refused (inbox settles only via agent receipt)', async () => {
    const f = fixture({ gateOwner: 'gate:gater', gateStanding: 'squad' })
    try {
      memberOnlyHolder(f, true)
      expect(await dispatch(f, { delivery: 'inbox' })).toMatchObject({
        ok: false, status: 409, error: 'no_eligible_gate_holder',
      })
    } finally { f.h.close() }
  })

  it('member holder without standing: refused, and reason agrees with the boolean (not no_holder)', async () => {
    const f = fixture({ gateOwner: 'gate:gater', gateStanding: 'squad' })
    try {
      memberOnlyHolder(f, false)
      expect(await dispatch(f)).toMatchObject({
        ok: false, error: 'no_eligible_gate_holder', detail: { reason: 'no_squad_standing' },
      })
    } finally { f.h.close() }
  })

  it('paused and revoked-credential holders collapse to one holder_unavailable reason', async () => {
    for (const sql of [
      "UPDATE agents SET status = 'paused' WHERE id = 'agent-gate'",
      "UPDATE member_tokens SET revoked_at = '2026-10-07T00:00:00.000Z' WHERE id = 'tok-g'",
    ]) {
      const f = fixture({ gateOwner: 'gate:gater', gateStanding: 'squad' })
      try {
        f.h.sqlite.exec(sql)
        expect(await dispatch(f)).toMatchObject({ ok: false, detail: { reason: 'holder_unavailable' } })
      } finally { f.h.close() }
    }
  })
})
