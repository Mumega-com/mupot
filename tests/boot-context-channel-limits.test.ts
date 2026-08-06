// tests/boot-context-channel-limits.test.ts — mupot#712.
//
// boot_context reported `channel: "directory"` and `capabilities: []` and then advised a
// next_step as if it were an ordinary session. It is not: the directory channel is the
// public OAuth door every agentic harness arrives at, and it carries zero ambient
// authority by design. Nothing in the response said so.
//
// The owner spent SEVEN calls discovering it: `status` worked, everything else 403'd, and
// the connector wrapper replaced mupot's actionable refusal with "may have been blocked by
// a firewall or security service". mupot said the right thing in a body nobody could see.
//
// So it is said HERE, in the one response that always succeeds on this channel.

import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { invokeTool } from '../src/mcp/index'
import type { AuthContext, Env } from '../src/types'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const ORIGIN = 'https://pot.test'

function applyAllMigrations(sqlite: SqliteD1Harness['sqlite']): void {
  const failures: string[] = []
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith('.sql')).sort()) {
    try { sqlite.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8')) }
    catch (e) { failures.push(`${f}: ${String(e)}`) }
  }
  if (failures.length) throw new Error(`migrations did not apply cleanly:\n${failures.join('\n')}`)
}

let harness: SqliteD1Harness
let env: Env

const seat = (channel: string): AuthContext => ({
  userId: 'mem-hadi', email: 'o@e.test', role: 'member', tenant: 'mumega',
  memberId: 'mem-hadi', channel, capabilities: [], boundAgentId: null,
}) as AuthContext

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  env = { DB: harness.db, TENANT_SLUG: 'mumega', BUS: { send: async () => {} } } as unknown as Env
})
afterEach(() => harness.close())

interface BootResult {
  channel?: string
  channel_limits?: {
    ambient_authority?: string
    why?: string
    you_can?: string[]
    you_cannot?: string[]
    to_get_write_access?: string
  }
}

const boot = async (channel: string): Promise<BootResult> => {
  const out = await invokeTool(seat(channel), env, 'boot_context', {}, ORIGIN)
  return ((out as { result?: BootResult }).result ?? {}) as BootResult
}

describe('boot_context explains the directory channel (mupot#712)', () => {
  it('a directory seat is told its ambient authority is none', async () => {
    const r = await boot('directory')
    expect(r.channel).toBe('directory')
    expect(r.channel_limits?.ambient_authority).toBe('none')
  })

  it('it names what WORKS, not only what fails', async () => {
    // A refusal that lists only prohibitions is a wall. The seven wasted calls were spent
    // finding the two tools that DO work.
    const r = await boot('directory')
    const can = (r.channel_limits?.you_can ?? []).join(' ')
    expect(can).toContain('connect')
    expect(can).toContain('orient')
    expect(can).toContain('status')
  })

  it('it names the ACTION that gets write access, and rules out the wrong one', async () => {
    const r = await boot('directory')
    const fix = r.channel_limits?.to_get_write_access ?? ''
    expect(fix).toContain('mint_agent_token')
    // The misleading action: "ask for a squad grant". It changes nothing here, and it
    // nearly produced a redundant grant for a member who already held org:owner.
    expect(fix.toLowerCase()).toContain('will not help')
  })

  it('it explains WHY, so the limit reads as design rather than breakage', async () => {
    const r = await boot('directory')
    expect(r.channel_limits?.why ?? '').toMatch(/public OAuth door|verified Google account/i)
  })

  it('a WORKSPACE seat gets no such note — absence is information', async () => {
    const r = await boot('workspace')
    expect(r.channel_limits).toBeUndefined()
  })
})
