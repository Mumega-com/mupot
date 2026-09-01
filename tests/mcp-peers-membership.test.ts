// peers must resolve squad membership from the `memberships` join table, not
// only from the `agents.squad_id` home column.
//
// The defect this pins was measured on the live pot before it was fixed: for
// squad hadi-mac (3674d955), `peers` returned 22 agents while
// `squad_member_list` returned 26 for the same squad. The four invisible ones
// were grokbot-ceo, Kasra, Loom and River — the gate agent, the flight
// coordinator and the lead. The tool whose whole purpose is "who is around me"
// was hiding the neighbours that matter, because the pot has two notions of
// "in a squad" and this code path picked the wrong one.
//
// Real schema via createSqliteD1 + applyAllMigrations (#684/#711 ratchet).
// tests/mcp-peers.test.ts still covers scoping/liveness against its own mock;
// this file exists because that mock cannot express the two-source question at
// all — it filters rows by `squad_id`, so it would report the bug as correct.

import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'test-tenant'
const MEMBER_ID = 'member-1'
const HOME_SQUAD = 'squad-home'
const OTHER_SQUAD = 'squad-other'

// born here, membership row too — the ordinary case
const AGENT_NATIVE = 'agent-native'
// born elsewhere, JOINED here — the case the old query could not see
const AGENT_JOINED = 'agent-joined'
// born here, membership row missing — legacy/hand-repaired rows
const AGENT_ORPHAN = 'agent-orphan'
// unrelated to this squad in either sense — must stay invisible
const AGENT_STRANGER = 'agent-stranger'

interface PeerOut {
  id: string
  slug: string
  via: string[]
  membership_capability: string | null
  squad_id: string
}

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept-1', 'Engineering');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('${HOME_SQUAD}', 'dept-1', 'home', 'Home Squad'),
      ('${OTHER_SQUAD}', 'dept-1', 'other', 'Other Squad');

    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('${AGENT_NATIVE}',   '${HOME_SQUAD}',  'a-native',   'Native',   'member', 'test', 'active'),
      ('${AGENT_ORPHAN}',   '${HOME_SQUAD}',  'b-orphan',   'Orphan',   'member', 'test', 'active'),
      ('${AGENT_JOINED}',   '${OTHER_SQUAD}', 'c-joined',   'Joined',   'lead',   'test', 'active'),
      ('${AGENT_STRANGER}', '${OTHER_SQUAD}', 'd-stranger', 'Stranger', 'member', 'test', 'active');

    INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES
      ('m-native', '${AGENT_NATIVE}', '${HOME_SQUAD}',  'member'),
      ('m-joined', '${AGENT_JOINED}', '${HOME_SQUAD}',  'lead'),
      ('m-strange','${AGENT_STRANGER}', '${OTHER_SQUAD}', 'member');
  `)
  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  return { DB: harness.db, TENANT_SLUG: TENANT } as unknown as Env
}

function auth(): AuthContext {
  return {
    userId: MEMBER_ID,
    memberId: MEMBER_ID,
    email: null,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: AGENT_NATIVE,
    capabilities: [
      { member_id: MEMBER_ID, scope_type: 'squad', scope_id: HOME_SQUAD, capability: 'member' },
    ],
  } as AuthContext
}

async function readPeers(env: Env): Promise<PeerOut[]> {
  const res = await invokeTool(auth(), env, 'peers', { squad_id: HOME_SQUAD }, 'https://pot.example')
  expect(res.ok).toBe(true)
  return (res.result as { peers: PeerOut[] }).peers
}

describe('peers resolves membership from the join table, not the home column', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  // THE KILL WITNESS. Against the old `WHERE a.squad_id = ?1` this agent is
  // absent, because its home squad is OTHER_SQUAD — exactly how Kasra, Loom and
  // River went missing from the live roster.
  it('SEES an agent that joined the squad but was born in another one', async () => {
    harness = makeHarness()
    const peers = await readPeers(envFor(harness))

    const joined = peers.find((p) => p.id === AGENT_JOINED)
    expect(joined).toBeDefined()
    expect(joined?.via).toEqual(['membership'])
    expect(joined?.membership_capability).toBe('lead')
    // The row still reports its real home squad; membership does not rewrite it.
    expect(joined?.squad_id).toBe(OTHER_SQUAD)
  })

  // The mirrored bug. Swapping the home column for the join table instead of
  // unioning them would drop this agent: createAgent writes a home-squad
  // membership row, but only for agents created through that path.
  it('still sees an agent whose home squad is here but has NO membership row', async () => {
    harness = makeHarness()
    const peers = await readPeers(envFor(harness))

    const orphan = peers.find((p) => p.id === AGENT_ORPHAN)
    expect(orphan).toBeDefined()
    expect(orphan?.via).toEqual(['home_squad'])
    expect(orphan?.membership_capability).toBeNull()
  })

  it('labels an agent present by both routes with both reasons', async () => {
    harness = makeHarness()
    const peers = await readPeers(envFor(harness))

    const native = peers.find((p) => p.id === AGENT_NATIVE)
    expect(native?.via).toEqual(['membership', 'home_squad'])
    expect(native?.membership_capability).toBe('member')
  })

  // Widening the read must not turn a squad roster into a directory.
  it('does NOT leak an agent unrelated to the squad by either route', async () => {
    harness = makeHarness()
    const peers = await readPeers(envFor(harness))

    expect(peers.map((p) => p.id)).not.toContain(AGENT_STRANGER)
    expect(peers.map((p) => p.id).sort()).toEqual(
      [AGENT_JOINED, AGENT_NATIVE, AGENT_ORPHAN].sort(),
    )
  })

  // The live discrepancy in miniature: peers and squad_member_list disagreed
  // because they read different tables. Every agent the membership table says
  // is in the squad must now appear in peers.
  it('is a superset of what the memberships table reports for the squad', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const peers = await readPeers(env)

    const byMembership = (
      harness.sqlite
        .prepare(`SELECT agent_id FROM memberships WHERE squad_id = ?`)
        .all(HOME_SQUAD) as Array<{ agent_id: string }>
    ).map((r) => r.agent_id)

    expect(byMembership.length).toBeGreaterThan(0)
    for (const agentId of byMembership) {
      expect(peers.map((p) => p.id)).toContain(agentId)
    }
  })

  // An agent in the squad twice over must not be listed twice. The LEFT JOIN is
  // on (agent_id, squad_id), which memberships makes unique, but a future join
  // added carelessly would fan rows out silently.
  it('returns each agent exactly once', async () => {
    harness = makeHarness()
    const peers = await readPeers(envFor(harness))
    const ids = peers.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
