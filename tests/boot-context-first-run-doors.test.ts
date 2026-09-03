// tests/boot-context-first-run-doors.test.ts — mupot#1283.
//
// WHY THIS EXISTS. `bootstrap_self` (mupot#925) was built for exactly one caller: an
// unbound, verified DIRECTORY session with no agent yet. It creates the department,
// squad and agent, mints the credential and grants the calling human admin on the new
// squad — one atomic act, no second human.
//
// Nothing in boot_context named it. `next_step` and `channel_limits.to_get_write_access`
// both said "ask an org-admin", which for a brand-new tenant names a person who does not
// exist yet. The consent screen could not rescue that caller either: consent only offers
// agents holding an `agent_member_bindings` row, and the mint is what writes that row
// (src/mcp/oauth-authorize.ts, selection rule 2). So the one tool written to break that
// deadlock was reachable only by reading line 25 of a static instructions blob.
//
// These tests pin the DOORS, not the prose, because prose was already the problem.

import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { invokeTool } from '../src/mcp/index'
import type { AuthContext, Env } from '../src/types'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const ORIGIN = 'https://pot.test'

function applyAllMigrations(sqlite: SqliteD1Harness['sqlite']): void {
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
  }
}

let harness: SqliteD1Harness
let env: Env

const seat = (channel: string, boundAgentId: string | null = null): AuthContext => ({
  userId: 'mem-newcomer', email: 'new@e.test', role: 'member', tenant: 'mumega',
  memberId: 'mem-newcomer', channel, capabilities: [], boundAgentId,
}) as AuthContext

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  env = { DB: harness.db, TENANT_SLUG: 'mumega', BUS: { send: async () => {} } } as unknown as Env
})
afterEach(() => harness.close())

interface Door { tool: string | null; does: string; requires: string }
interface BootResult {
  onboarding_state?: string
  available_doors?: Door[]
  next_step?: string
  channel_limits?: { to_get_write_access?: string }
}

const boot = async (channel: string, bound: string | null = null): Promise<BootResult> => {
  const out = await invokeTool(seat(channel, bound), env, 'boot_context', {}, ORIGIN)
  return ((out as { result?: BootResult }).result ?? {}) as BootResult
}

/** Record the audit row that bootstrap_self writes, which is what makes a second
 *  attempt return `already_bootstrapped`. */
function markBootstrapped(memberId: string): void {
  harness.sqlite.exec(`
    INSERT INTO agent_audit (id, agent_id, actor_id, actor_type, action, fields_changed, before_state, after_state)
    VALUES ('aud-1', 'agent-1', '${memberId}', 'user', 'bootstrap_self', '[]', '{}', '{}');
  `)
}

describe('a newcomer is shown the self-serve door', () => {
  it('an unbound directory session with no agent is told to bootstrap_self FIRST', async () => {
    const r = await boot('directory')
    expect(r.onboarding_state).toBe('unbound_no_agent')
    expect(r.available_doors?.[0]?.tool).toBe('bootstrap_self')
  })

  it('the door says it needs no second human — that is the whole point', async () => {
    const r = await boot('directory')
    const door = r.available_doors?.find((d) => d.tool === 'bootstrap_self')
    expect(door).toBeDefined()
    // The defect was being told to "ask an org-admin" in an org with no admin yet.
    expect(door?.requires.toLowerCase()).toContain('no second human')
  })

  it('next_step names the tool, not a person to go find', async () => {
    const r = await boot('directory')
    expect(r.next_step).toContain('bootstrap_self')
  })

  it('the channel note leads with the self-serve door and still rules out the wrong action', async () => {
    const r = await boot('directory')
    const fix = r.channel_limits?.to_get_write_access ?? ''
    expect(fix).toContain('bootstrap_self')
    // Pre-existing contract from #712 must survive: the admin route and the misleading one.
    expect(fix).toContain('mint_agent_token')
    expect(fix.toLowerCase()).toContain('will not help')
    // Self-serve must come BEFORE the ask-a-human route, or the newcomer stops reading.
    expect(fix.indexOf('bootstrap_self')).toBeLessThan(fix.indexOf('mint_agent_token'))
  })
})

describe('a door that would refuse the caller is not offered', () => {
  it('a member who already bootstrapped is sent to consent, not back to bootstrap_self', async () => {
    markBootstrapped('mem-newcomer')
    const r = await boot('directory')
    expect(r.onboarding_state).toBe('unbound_agent_exists')
    expect(r.available_doors?.map((d) => d.tool)).not.toContain('bootstrap_self')
    expect(r.next_step).toMatch(/consent|connect/i)
  })

  it('a WORKSPACE seat is never offered bootstrap_self — the tool refuses that channel', async () => {
    // bootstrapSelf gates on `auth.channel === 'directory' && !auth.boundAgentId`.
    // Advertising it here would be a door that 403s the caller it was offered to.
    const r = await boot('workspace')
    expect(r.onboarding_state).toBe('unbound_workspace')
    expect(r.available_doors?.map((d) => d.tool)).not.toContain('bootstrap_self')
    expect(r.available_doors?.map((d) => d.tool)).toContain('mint_agent_token')
    expect(r.next_step).toContain('mint_agent_token')
  })

  it('a bound session is told to orient and offered no onboarding doors', async () => {
    const r = await boot('directory', 'agent-abc')
    expect(r.onboarding_state).toBe('bound')
    expect(r.available_doors?.[0]?.tool).toBe('orient')
    expect(r.available_doors?.map((d) => d.tool)).not.toContain('bootstrap_self')
  })
})

// THE ONE THAT MATTERS MOST. boot_context is documented as "the one response that always
// succeeds on this channel" (#712) and is the only reachable call for a zero-capability
// seat. Resolving the door list added a D1 read to it. If that read can take the whole
// map down, this change reintroduces the dead end it exists to remove — and it would do
// so precisely when the database is already unhappy.
describe('the advisory lookup can never cost the caller its map', () => {
  it('boot_context still answers, with doors, when the D1 read throws', async () => {
    const exploding = {
      DB: {
        prepare() {
          return { bind() { return { async first() { throw new Error('D1 unavailable') } } } }
        },
      },
      TENANT_SLUG: 'mumega',
      BUS: { send: async () => {} },
    } as unknown as Env

    const out = await invokeTool(seat('directory'), exploding, 'boot_context', {}, ORIGIN)
    const r = ((out as { result?: BootResult }).result ?? {}) as BootResult

    expect(r.onboarding_state).toBe('unbound_no_agent')
    // Fail toward MORE doors, never fewer: a caller wrongly shown bootstrap_self gets a
    // clear 409 that names the consent flow. A caller wrongly denied it gets nothing.
    expect(r.available_doors?.[0]?.tool).toBe('bootstrap_self')
  })
})
