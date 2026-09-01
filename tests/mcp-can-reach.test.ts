// can_reach — read-only "would a send be authorized?", and the one property
// that makes it safe: it must never be a WIDER oracle than `send` itself.
//
// Why this tool exists: reachability used to be observable only by attempting a
// write. When gate verdicts from Athena stopped arriving at this seat and had to
// be hand-carried by Loom, no agent could ask the pot why — the answer existed
// only as the error string of a message you had to send to find out.
//
// The oracle property is the reason most of this file is here. For a non-admin,
// sendToRef collapses every failure — ref absent, ambiguous, resolved-but-
// invisible, and (per the #401 existence-oracle closure) every project failure
// once squad visibility has failed — into the single string
// send_target_not_visible. A read-only diagnostic that returned the richer
// vocabulary would hand a non-admin a distinction `send` deliberately refuses
// them. So the tests below do not merely check that can_reach answers
// correctly; several of them check that it refuses to answer MORE than send.
//
// Real schema via createSqliteD1 + applyAllMigrations (#684/#711 ratchet).

import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'test-tenant'
const ORIGIN = 'https://pot.example'

const SQUAD_SENDER = 'squad-sender'
const SQUAD_GATE = 'squad-gate'

const SENDER = 'agent-sender'
const SENDER_MEMBER = 'member-sender'
// same squad as the sender — reachable by the squad arm
const NEIGHBOUR = 'agent-neighbour'
// other squad, shares a project — the Athena case
const GATE = 'agent-gate'
// other squad, shares nothing — unreachable by any arm
const STRANGER = 'agent-stranger'

const PROJECT_SHARED = 'project-shared'
const PROJECT_ARCHIVED = 'project-archived'
const PROJECT_UNSHARED = 'project-unshared'

interface ReachOut {
  reachable: boolean
  via: string | null
  reason: string | null
  target: { id: string; slug: string } | null
  hint?: string
}

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept-1', 'Engineering');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('${SQUAD_SENDER}', 'dept-1', 'sender-squad', 'Sender Squad'),
      ('${SQUAD_GATE}',   'dept-1', 'gate-squad',   'Gate Squad');

    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('${SENDER}',    '${SQUAD_SENDER}', 'sender',    'Sender',    'member', 'test', 'active'),
      ('${NEIGHBOUR}', '${SQUAD_SENDER}', 'neighbour', 'Neighbour', 'member', 'test', 'active'),
      ('${GATE}',      '${SQUAD_GATE}',   'gate',      'Gate',      'member', 'test', 'active'),
      ('${STRANGER}',  '${SQUAD_GATE}',   'stranger',  'Stranger',  'member', 'test', 'active');

    INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES
      ('mm-sender',    '${SENDER}',    '${SQUAD_SENDER}', 'member'),
      ('mm-neighbour', '${NEIGHBOUR}', '${SQUAD_SENDER}', 'member'),
      ('mm-gate',      '${GATE}',      '${SQUAD_GATE}',   'member'),
      ('mm-stranger',  '${STRANGER}',  '${SQUAD_GATE}',   'member');

    INSERT INTO projects (id, slug, name, status) VALUES
      ('${PROJECT_SHARED}',   'shared',   'Shared Project',   'active'),
      ('${PROJECT_ARCHIVED}', 'archived', 'Archived Project', 'active'),
      ('${PROJECT_UNSHARED}', 'unshared', 'Unshared Project', 'active');

    -- both sides on the shared project: the arm that lets a gate reach a builder
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES
      ('${PROJECT_SHARED}',   '${SQUAD_SENDER}', 'write'),
      ('${PROJECT_SHARED}',   '${SQUAD_GATE}',   'write'),
      ('${PROJECT_ARCHIVED}', '${SQUAD_SENDER}', 'write'),
      ('${PROJECT_ARCHIVED}', '${SQUAD_GATE}',   'write'),
      -- sender only: the recipient is NOT on this one
      ('${PROJECT_UNSHARED}', '${SQUAD_SENDER}', 'write');

    -- Archive AFTER granting: a trigger refuses to grant squad access to an
    -- already-archived project. The state under test is a project that was
    -- shared and then archived, which is the realistic one anyway.
    UPDATE projects SET status = 'archived' WHERE id = '${PROJECT_ARCHIVED}';
  `)
  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  return { DB: harness.db, TENANT_SLUG: TENANT } as unknown as Env
}

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: SENDER_MEMBER,
    memberId: SENDER_MEMBER,
    email: null,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: SENDER,
    capabilities: [
      {
        member_id: SENDER_MEMBER,
        scope_type: 'squad',
        scope_id: SQUAD_SENDER,
        capability: 'member',
      },
    ],
    ...overrides,
  } as AuthContext
}

function adminAuth(): AuthContext {
  return auth({
    role: 'owner',
    capabilities: [
      { member_id: SENDER_MEMBER, scope_type: 'org', scope_id: null, capability: 'admin' },
    ],
  } as Partial<AuthContext>)
}

async function reach(
  env: Env,
  to: string,
  projectId?: string,
  who: AuthContext = auth(),
): Promise<ReachOut> {
  const args: Record<string, unknown> = { to }
  if (projectId !== undefined) args.project_id = projectId
  const res = await invokeTool(who, env, 'can_reach', args, ORIGIN)
  expect(res.ok).toBe(true)
  return res.result as ReachOut
}

describe('can_reach', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('is advertised on the MCP surface', async () => {
    const { TOOLS } = await import('../src/mcp')
    expect(TOOLS.map((t) => t.name)).toContain('can_reach')
  })

  it('says yes via the squad arm for an agent on the caller\u2019s own squad', async () => {
    harness = makeHarness()
    const out = await reach(envFor(harness), NEIGHBOUR)
    expect(out.reachable).toBe(true)
    expect(out.via).toBe('squad')
    expect(out.reason).toBeNull()
    expect(out.target?.id).toBe(NEIGHBOUR)
  })

  it('says no for an agent sharing neither squad nor project', async () => {
    harness = makeHarness()
    const out = await reach(envFor(harness), STRANGER)
    expect(out.reachable).toBe(false)
    expect(out.via).toBeNull()
    expect(out.reason).toBe('send_target_not_visible')
  })

  // THE ATHENA CASE. Wrapping resolveVisibleSendTarget alone would answer "no"
  // here — and it would be answering "no" about the exact path that is carrying
  // gate verdicts to this seat right now, certifying the human relay as
  // permanent.
  it('says YES via the project arm when the squad arm fails but both share a live project', async () => {
    harness = makeHarness()
    const env = envFor(harness)

    const withoutProject = await reach(env, GATE)
    expect(withoutProject.reachable).toBe(false)

    const withProject = await reach(env, GATE, PROJECT_SHARED)
    expect(withProject.reachable).toBe(true)
    expect(withProject.via).toBe('project')
    expect(withProject.target?.id).toBe(GATE)
  })

  it('names the project lever when the squad arm failed and no project was offered', async () => {
    harness = makeHarness()
    const out = await reach(envFor(harness), GATE)
    expect(out.hint).toContain('project_id')
    // ...and does not nag once a project was actually supplied.
    const supplied = await reach(envFor(harness), GATE, PROJECT_SHARED)
    expect(supplied.hint).toBeUndefined()
  })

  // ── the oracle property ────────────────────────────────────────────────────

  it('does NOT tell a non-admin that a named agent is absent \u2014 same string as invisible', async () => {
    harness = makeHarness()
    const env = envFor(harness)

    const missing = await reach(env, 'no-such-agent-anywhere')
    const invisible = await reach(env, STRANGER)

    expect(missing.reachable).toBe(false)
    // Indistinguishable by construction: this is the whole non-leak guarantee.
    expect(missing.reason).toBe('send_target_not_visible')
    expect(missing.reason).toBe(invisible.reason)
    expect(missing.target).toBeNull()
    expect(invisible.target).toBeNull()
  })

  it('never returns a resolved target the caller cannot reach', async () => {
    harness = makeHarness()
    const out = await reach(envFor(harness), STRANGER)
    // Echoing slug/name/squad of an unreachable agent would leak its existence
    // through the payload even while the reason string stayed collapsed.
    expect(out.target).toBeNull()
    expect(JSON.stringify(out)).not.toContain(SQUAD_GATE)
  })

  // #401 collapse: once squad visibility has failed, a SPECIFIC project reason
  // would distinguish a real-but-unreachable agent from a nonexistent one,
  // because a nonexistent ref can never produce a project error at all.
  it('collapses project failures to the same string once the squad arm has failed', async () => {
    harness = makeHarness()
    const env = envFor(harness)

    const archived = await reach(env, GATE, PROJECT_ARCHIVED)
    const notShared = await reach(env, GATE, PROJECT_UNSHARED)
    const noProject = await reach(env, GATE, 'project-does-not-exist')
    const absentAgent = await reach(env, 'no-such-agent-anywhere', PROJECT_SHARED)

    for (const out of [archived, notShared, noProject, absentAgent]) {
      expect(out.reachable).toBe(false)
      expect(out.reason).toBe('send_target_not_visible')
      expect(out.target).toBeNull()
    }
    // Explicitly: none of the specific project reasons may surface here.
    const reasons = [archived, notShared, noProject].map((o) => o.reason)
    expect(reasons).not.toContain('project_archived')
    expect(reasons).not.toContain('project_access_denied')
    expect(reasons).not.toContain('project_not_found')
  })

  it('gives an admin the richer vocabulary send already gives admins, and no more', async () => {
    harness = makeHarness()
    const env = envFor(harness)

    const missing = await reach(env, 'no-such-agent-anywhere', undefined, adminAuth())
    expect(missing.reachable).toBe(false)
    expect(missing.reason).toBe('recipient_not_found')

    // Admins already send tenant-wide, so reachability is not a new power.
    const anyone = await reach(env, STRANGER, undefined, adminAuth())
    expect(anyone.reachable).toBe(true)
    expect(anyone.via).toBe('admin')
  })

  // ── shape ──────────────────────────────────────────────────────────────────

  it('answers "no" with 200, not a refusal status', async () => {
    harness = makeHarness()
    const res = await invokeTool(auth(), envFor(harness), 'can_reach', { to: STRANGER }, ORIGIN)
    // A 403 would make the honest negative indistinguishable from "you may not
    // ask", which is the failure mode this tool exists to remove.
    expect(res.ok).toBe(true)
  })

  it('refuses an unbound caller and points at enrollment', async () => {
    harness = makeHarness()
    const res = await invokeTool(
      auth({ boundAgentId: null }),
      envFor(harness),
      'can_reach',
      { to: NEIGHBOUR },
      ORIGIN,
    )
    expect(res.ok).toBe(false)
    expect(res.error).toBe('not_agent_bound')
  })

  it('requires a named target \u2014 it is not a scan surface', async () => {
    harness = makeHarness()
    const env = envFor(harness)

    const noTarget = await invokeTool(auth(), env, 'can_reach', {}, ORIGIN)
    expect(noTarget.ok).toBe(false)

    // No list/array input may be smuggled through the named-target field.
    const listy = await invokeTool(
      auth(),
      env,
      'can_reach',
      { to: [NEIGHBOUR, STRANGER] } as unknown as Record<string, unknown>,
      ORIGIN,
    )
    expect(listy.ok).toBe(false)
  })

  it('writes no message \u2014 it is a read', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    await reach(env, NEIGHBOUR)
    await reach(env, GATE, PROJECT_SHARED)
    await reach(env, STRANGER)

    const rows = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM agent_messages`)
      .get() as { n: number }
    expect(rows.n).toBe(0)
  })
})
