// tests/directory-channel-can-boot.test.ts — mupot#712.
//
// THE DEFECT: the operator's only door could not boot.
//
// Reproduced live on the owner's own claude.ai connector seat, 2026-08-05:
//
//   boot_context -> {"member_id":"mem-hadi","channel":"directory","capabilities":[],
//                    "next_step":"call connect { agent_name } to claim your identity now"}
//   connect      -> 403 directory_channel_zero_capability
//   orient       -> 403 forbidden
//   project_list -> 403 forbidden
//
// boot_context advised an action that was STRUCTURALLY IMPOSSIBLE on the channel it was
// advising from — the code even said so: "A directory-channel seat can NEVER pass this
// check, by design." Only `status` worked. Seven calls to discover a closed loop.
//
// The B1 ceiling assumed a blocked operator has another door ("use the workspace door
// instead"). The operator has no internal API path and reaches mupot only through agentic
// harnesses, all of which arrive at the directory door. So the advice was a dead end, and
// the workaround it produced was worse than the risk it prevented: work routed through a
// shared shell holding every credential on the host.
//
// THE FIX: connect and orient — both READ-ONLY, both redacted by viewSensitive —
// authorize the NAMED claim against LATENT capabilities (what the member truly holds)
// instead of the zeroed ambient view.
//
// WHAT MUST NOT CHANGE, and is pinned below: ambient authority stays ZERO. A directory
// seat still cannot write. If these tests ever go green while task_create succeeds on a
// directory channel, the ceiling has been dismantled and #712's whole argument was wrong.

import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { invokeTool } from '../src/mcp/index'
import { buildAuthContextFromProps } from '../src/mcp/oauth-authorize'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TENANT = 'mumega'
const ORIGIN = 'https://pot.test'

function applyAllMigrations(sqlite: SqliteD1Harness['sqlite']): void {
  const failures: string[] = []
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    try {
      sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
    } catch (error) {
      failures.push(`${file}: ${String(error)}`)
    }
  }
  if (failures.length > 0) throw new Error(`migrations did not apply cleanly:\n${failures.join('\n')}`)
}

let harness: SqliteD1Harness
let env: Env

const grant = (capability: string, scope_type = 'squad', scope_id: string | null = 'squad-core'): CapabilityGrant =>
  ({ member_id: 'mem-hadi', scope_type, scope_id, capability }) as CapabilityGrant

/** A directory seat exactly as buildAuthContextFromProps produces one: ambient ZERO, latent real. */
function directorySeat(latent: CapabilityGrant[]): AuthContext {
  return {
    userId: 'mem-hadi', email: 'owner@example.test', role: 'member', tenant: TENANT,
    memberId: 'mem-hadi', channel: 'directory',
    capabilities: [],          // the B1 ceiling — ambient authority is zero
    latentCapabilities: latent, // what the member actually holds
    boundAgentId: null,
  } as AuthContext
}

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  env = { DB: harness.db, TENANT_SLUG: TENANT, BUS: { send: async () => {} } } as unknown as Env
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept', 'dept', 'dept');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-core', 'dept', 'squad-core', 'squad-core');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-other', 'dept', 'squad-other', 'squad-other');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-mine', 'squad-core', 'mine', 'mine', 'active');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-theirs', 'squad-other', 'theirs', 'theirs', 'active');
  `)
})

afterEach(() => harness.close())

describe('a directory seat can BOOT (mupot#712)', () => {
  it('connect succeeds for an agent the member actually has capability on', async () => {
    const out = await invokeTool(directorySeat([grant('member')]), env, 'connect', { agent_name: 'mine' }, ORIGIN)

    // The exact defect: this returned 403 directory_channel_zero_capability.
    expect((out as { error?: string }).error).toBeUndefined()
    expect((out as { result?: { connection_status?: string } }).result?.connection_status).toBe('hot')
  })

  it('orient succeeds for an agent the member actually has capability on', async () => {
    const out = await invokeTool(directorySeat([grant('member')]), env, 'orient', { agent: 'mine' }, ORIGIN)
    expect((out as { error?: string }).error).toBeUndefined()
  })

  it('LATENT IS STILL CHECKED: connect is refused for a squad the member has NO capability on', async () => {
    // Latent authorization is not a bypass. A member who holds nothing on squad-other must
    // still be refused there — otherwise "authorize against the truth" would have become
    // "authorize against nothing".
    const out = await invokeTool(directorySeat([grant('member')]), env, 'connect', { agent_name: 'theirs' }, ORIGIN)
    expect((out as { error?: string }).error).toBe('forbidden')
  })

  it('a member holding NOTHING cannot connect anywhere', async () => {
    const out = await invokeTool(directorySeat([]), env, 'connect', { agent_name: 'mine' }, ORIGIN)
    expect((out as { error?: string }).error).toBe('forbidden')
  })
})

describe('THE CEILING SURVIVES — ambient authority stays zero', () => {
  it('a directory seat still CANNOT write, even holding org:owner latently', async () => {
    // The invariant the whole change rests on. connect/orient are read-only and named;
    // task_create is an ambient write. If this ever passes, B1 has been dismantled and the
    // OAuth door silently carries an owner's grants again — exactly what it exists to stop.
    const seat = directorySeat([grant('owner', 'org', null), grant('member')])

    const out = await invokeTool(seat, env, 'task_create', {
      squad_id: 'squad-core', title: 't', done_when: 'check done',
    }, ORIGIN)

    expect((out as { error?: string }).error).toBe('forbidden')
  })

  it('a directory seat holding org:owner latently still cannot create an agent', async () => {
    const seat = directorySeat([grant('owner', 'org', null)])
    const out = await invokeTool(seat, env, 'create_agent', {
      squad_id: 'squad-core', slug: 'sneaky', name: 'sneaky',
    }, ORIGIN)
    expect((out as { error?: string }).error).toBeDefined()
  })
})

describe('THE CEILING SURVIVES — asserted against the REAL builder, not a hand-built object', () => {
  // Added after a mutation exposed the hole. Every test above constructs an AuthContext by
  // hand with `capabilities: []`, so mutating buildAuthContextFromProps to hand a directory
  // seat its FULL resolved grants — dismantling B1 outright — left all 8 green. They were
  // asserting against my object literal, not the system that builds it. That is #684's
  // shape, produced while writing the guard against #684's shape.
  //
  // These call the real builder. If B1 is ever removed, they go red.

  async function build(channel: 'directory' | 'workspace') {
    harness.sqlite.exec(
      `INSERT OR IGNORE INTO members (id, tenant, display_name, status) VALUES ('mem-hadi', '${TENANT}', 'Owner', 'active');
       INSERT OR IGNORE INTO capabilities (id, member_id, scope_type, scope_id, capability)
         VALUES ('c1', 'mem-hadi', 'org', NULL, 'owner');
       INSERT OR IGNORE INTO member_tokens (id, member_id, tenant, token_hash, channel)
         VALUES ('tok-${channel}', 'mem-hadi', '${TENANT}', 'hash-${channel}', '${channel}');`,
    )
    return buildAuthContextFromProps(env, {
      memberId: 'mem-hadi', tokenId: `tok-${channel}`, email: 'owner@example.test',
    } as never)
  }

  it('a directory seat is built with ZERO ambient capabilities, holding org:owner', async () => {
    const ctx = await build('directory')
    expect(ctx).not.toBeNull()
    expect(ctx?.channel).toBe('directory')
    // THE invariant. Not "I set it to [] in my fixture" — "the builder produces []".
    expect(ctx?.capabilities).toEqual([])
    expect(ctx?.boundAgentId).toBeNull()
  })

  it('the same directory seat carries the real grants LATENTLY', async () => {
    const ctx = await build('directory')
    expect(ctx?.latentCapabilities?.some((c) => c.capability === 'owner')).toBe(true)
  })

  it('a workspace seat gets its real grants as AMBIENT authority', async () => {
    const ctx = await build('workspace')
    expect(ctx?.capabilities?.some((c) => c.capability === 'owner')).toBe(true)
  })
})

describe('non-directory channels are unaffected', () => {
  it('a workspace seat behaves exactly as before (latent === ambient)', async () => {
    const workspace = {
      userId: 'mem-hadi', email: 'owner@example.test', role: 'member', tenant: TENANT,
      memberId: 'mem-hadi', channel: 'workspace',
      capabilities: [grant('member')],
      latentCapabilities: [grant('member')],
      boundAgentId: null,
    } as AuthContext

    const out = await invokeTool(workspace, env, 'connect', { agent_name: 'mine' }, ORIGIN)
    expect((out as { result?: { connection_status?: string } }).result?.connection_status).toBe('hot')
  })

  it('an auth context with NO latentCapabilities falls back to ambient — no accidental widening', async () => {
    // Any caller constructing an AuthContext without the new field (older code paths, other
    // tests) must not gain authority it did not have.
    const legacy = {
      userId: 'm', email: null, role: 'member', tenant: TENANT, memberId: 'm',
      channel: 'workspace', capabilities: [], boundAgentId: null,
    } as AuthContext

    const out = await invokeTool(legacy, env, 'connect', { agent_name: 'mine' }, ORIGIN)
    expect((out as { error?: string }).error).toBe('forbidden')
  })
})
