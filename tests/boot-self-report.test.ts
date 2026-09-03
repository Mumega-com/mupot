// tests/boot-self-report.test.ts — mupot#1284.
//
// WHY. fleet_agents.runtime/.model only ever moved via POST /api/fleet/attach, which a
// HOST daemon calls. An agent booting over MCP never touched it. On 2026-09-03 Athena's
// harness moved from Codex to grok and her row kept reading `pi` — while presence kept
// last_reported_at fresh, so the timestamp vouched for a field nothing had rechecked.
// `grok` was not even in the runtime vocabulary, so the registry's only offers were
// "claim something false" or "stay silent". She stayed silent and the row rotted.

import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { invokeTool } from '../src/mcp/index'
import { RUNTIME_VALUES } from '../src/fleet/runtimes'
import type { AuthContext, Env } from '../src/types'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const ORIGIN = 'https://pot.test'
const AGENT = 'agent-athena'

function applyAllMigrations(sqlite: SqliteD1Harness['sqlite']): void {
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
  }
}

let harness: SqliteD1Harness
let env: Env

const seat = (boundAgentId: string | null): AuthContext => ({
  userId: 'mem-1', email: 'a@e.test', role: 'member', tenant: 'mumega',
  memberId: 'mem-1', channel: 'workspace', capabilities: [], boundAgentId,
}) as AuthContext

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  env = { DB: harness.db, TENANT_SLUG: 'mumega', BUS: { send: async () => {} } } as unknown as Env
  // A row that is FRESH and WRONG — the shape that caused this.
  harness.sqlite.exec(`
    INSERT INTO fleet_agents (agent_id, tenant, runtime, status, reported_by, last_reported_at)
    VALUES ('${AGENT}', 'mumega', 'pi', 'running', 'some-daemon', datetime('now'));
  `)
})
afterEach(() => harness.close())

interface Registry { outcome: string; changed?: string[]; detail?: string; belief?: { runtime: string; model: string | null; reported_by: string } | null }
interface BootResult { registry?: Registry }

const boot = async (args: Record<string, unknown>, bound: string | null = AGENT): Promise<BootResult> => {
  const out = await invokeTool(seat(bound), env, 'boot_context', args, ORIGIN)
  return ((out as { result?: BootResult }).result ?? {}) as BootResult
}

const storedRuntime = () =>
  harness.sqlite.prepare(`SELECT runtime, model, reported_by FROM fleet_agents WHERE agent_id = ?`).get(AGENT) as
    { runtime: string; model: string | null; reported_by: string }

describe('boot records what the agent actually is', () => {
  it('a reported runtime replaces the stale one, and says which field moved', async () => {
    const r = await boot({ runtime: 'grok', model: 'grok-4.6' })
    expect(r.registry?.outcome).toBe('recorded')
    expect(r.registry?.changed).toEqual(expect.arrayContaining(['runtime', 'model']))
    expect(storedRuntime().runtime).toBe('grok')
    expect(storedRuntime().model).toBe('grok-4.6')
  })

  it('grok is a sayable runtime — the value whose absence caused this', async () => {
    // If this fails, an agent on grok is again forced to choose between lying and silence.
    expect(RUNTIME_VALUES).toContain('grok')
  })

  it('the report is attributed to the agent itself, not left as the old reporter', async () => {
    await boot({ runtime: 'grok' })
    expect(storedRuntime().reported_by).toBe(AGENT)
  })

  it('a PARTIAL report does not blank the field it did not mention', async () => {
    // The defect class this whole change is about: a partial answer written as a complete
    // one. Reporting a runtime must not erase a model that is still true.
    await boot({ runtime: 'grok', model: 'grok-4.6' })
    await boot({ runtime: 'grok' })
    expect(storedRuntime().model).toBe('grok-4.6')
  })

  it('reports the registry belief even when the caller claims NOTHING', async () => {
    // This is what makes it self-correcting rather than opt-in: an agent that never
    // thought to report still SEES what mupot believes it is.
    const r = await boot({})
    expect(r.registry?.outcome).toBe('nothing_reported')
    expect(r.registry?.belief?.runtime).toBe('pi')
  })
})

describe('it cannot become a way around signed attach', () => {
  it('an agent with a registered signing key is refused and pointed at attach-signed', async () => {
    harness.sqlite.exec(`
      INSERT INTO agent_keys (tenant, agent_id, pubkey, algo, member_id, created_at)
      VALUES ('mumega', '${AGENT}', 'k', 'Ed25519', 'mem-1', 0);
    `)
    const r = await boot({ runtime: 'grok' })
    expect(r.registry?.outcome).toBe('refused_signed_attach_required')
    expect(r.registry?.detail).toMatch(/attach-signed/)
    // And the row did NOT move.
    expect(storedRuntime().runtime).toBe('pi')
  })
})

describe('refusals teach instead of silencing', () => {
  it('an unknown runtime is refused WITH the vocabulary, and changes nothing', async () => {
    const r = await boot({ runtime: 'definitely-not-a-harness' })
    expect(r.registry?.outcome).toBe('refused_unknown_runtime')
    // Withholding the valid values is what made the agent give up and stay stale.
    expect(r.registry?.detail).toContain('grok')
    expect(storedRuntime().runtime).toBe('pi')
  })
})

describe('boot survives a registry it cannot write', () => {
  it('an unbound session reports no registry block at all', async () => {
    const r = await boot({ runtime: 'grok' }, null)
    expect(r.registry).toBeUndefined()
  })

  it('boot still answers when the registry read throws', async () => {
    const exploding = {
      DB: { prepare() { return { bind() { return { async first() { throw new Error('D1 down') }, async run() { throw new Error('D1 down') } } } } } },
      TENANT_SLUG: 'mumega', BUS: { send: async () => {} },
    } as unknown as Env
    const out = await invokeTool(seat(AGENT), exploding, 'boot_context', { runtime: 'grok' }, ORIGIN)
    const r = ((out as { result?: BootResult & { identity_status?: string } }).result ?? {}) as BootResult & { identity_status?: string }
    // A registry write is strictly less important than the caller learning who it is.
    expect(r.identity_status).toBe('minted')
    expect(r.registry?.outcome).toBe('unavailable')
  })
})
