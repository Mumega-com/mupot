// seat_select / auto-seat grants the new agent its OWN lane gate (gate:<slug>) like mint does; migration 0245
// backfills the same row, own-slug only, idempotently. Real sqlite D1 over the full migration chain.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { seatSelect, type SeatSelectAuth } from '../src/members/seat-select'
import { upsertHarness } from '../src/members/harness'
import type { Env } from '../src/types'

const TENANT = 'mumega'
const HUMAN = 'member-human-1'
const BACKFILL = readFileSync(new URL('../migrations/0245_backfill_seat_agent_own_gate.sql', import.meta.url), 'utf8')

let h: SqliteD1Harness
function envFor(): Env {
  const store = new Map<string, string>()
  const kv = { async get(k: string) { return store.get(k) ?? null }, async put(k: string, v: string) { store.set(k, v) }, async delete(k: string) { store.delete(k) } }
  return { DB: h.db, TENANT_SLUG: TENANT, SESSIONS: kv, SEAT_AUTO_ENROLL: '1' } as unknown as Env
}
async function select(project: string) {
  const env = envFor()
  const row = await upsertHarness(env, HUMAN, 'client-x', 'X')
  if (!row) throw new Error('harness')
  const auth: SeatSelectAuth = { channel: 'directory', boundAgentId: null, memberId: HUMAN, harnessId: row.id }
  const out = await seatSelect(env, auth, { project })
  if (!out.ok) throw new Error(`seat_select failed ${out.error}`)
  return out
}
const grants = () => h.sqlite.prepare(`SELECT capability, principal_type, principal_id, granted_by FROM gate_grants ORDER BY capability`).all() as Array<{ capability: string; principal_type: string; principal_id: string; granted_by: string }>

beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  h.sqlite.exec(`INSERT INTO members (id, email, display_name, status, created_at, tenant) VALUES ('${HUMAN}', 'h@example.test', 'Human', 'active', '2026-10-09T00:00:00.000Z', '${TENANT}')`)
})
afterEach(() => { h.close() })

describe('seat_select own-lane gate', () => {
  it('creates exactly gate:<slug> for the new agent and nothing else', async () => {
    const out = await select('mupot')
    expect(grants()).toEqual([{ capability: `gate:${out.agent.slug}`, principal_type: 'agent', principal_id: out.agent.id, granted_by: 'system:seat_select' }])
  })
  it('re-select of the same key is idempotent (still one row)', async () => {
    const a = await select('mupot')
    const b = await select('mupot')
    expect(b.agent.id).toBe(a.agent.id)
    expect(grants()).toHaveLength(1)
  })
  it('a second seat gets its own gate and never the first seat\'s', async () => {
    const a = await select('one')
    const b = await select('two')
    const caps = grants().map((g) => `${g.capability}|${g.principal_id}`).sort()
    expect(caps).toEqual([`gate:${a.agent.slug}|${a.agent.id}`, `gate:${b.agent.slug}|${b.agent.id}`].sort())
  })
})

describe('migration 0245 backfill', () => {
  it('inserts the missing own-slug gate, is idempotent, and touches no other gate', async () => {
    const a = await select('one')
    const b = await select('two')
    h.sqlite.prepare(`DELETE FROM gate_grants WHERE principal_id = ?`).run(a.agent.id) // simulate pre-fix seat
    // unrelated rows that must survive untouched
    h.sqlite.exec(`INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES ('g-hadi', 'gate:hadi', 'member', '${HUMAN}', 'x', '2026-10-01T00:00:00Z')`)
    // a non-seat agent must not be granted
    h.sqlite.exec(`INSERT INTO agents (id, slug, name, squad_id, status, created_at) SELECT 'plain-agent', 'plain', 'plain', squad_id, 'active', '2026-10-01T00:00:00Z' FROM agents LIMIT 1`)
    h.sqlite.exec(BACKFILL)
    h.sqlite.exec(BACKFILL)
    const rows = grants()
    expect(rows.filter((g) => g.principal_id === a.agent.id)).toEqual([expect.objectContaining({ capability: `gate:${a.agent.slug}`, principal_type: 'agent' })])
    expect(rows.filter((g) => g.principal_id === b.agent.id)).toHaveLength(1)
    expect(rows.find((g) => g.capability === 'gate:hadi')?.granted_by).toBe('x')
    expect(rows.some((g) => g.principal_id === 'plain-agent')).toBe(false)
    expect(rows).toHaveLength(3)
  })
  it('skips inactive seat agents', async () => {
    const a = await select('one')
    h.sqlite.prepare(`DELETE FROM gate_grants`).run()
    h.sqlite.prepare(`UPDATE agents SET status = 'inactive' WHERE id = ?`).run(a.agent.id)
    h.sqlite.exec(BACKFILL)
    expect(grants()).toHaveLength(0)
  })
})
