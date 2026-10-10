// tests/seat-name.test.ts — mupot#1794 W4: seat display naming is ONE pure function, and a name is a
// LABEL, never authority: identity stays keyed on (tenant, member, harness, key_hash).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deriveSeatName, type SeatSignals } from '../src/members/seat-name'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { seatSelect } from '../src/members/seat-select'
import { upsertHarness } from '../src/members/harness'
import type { Env } from '../src/types'

const base: SeatSignals = {
  harnessKind: 'cursor', harnessLabel: 'Cursor', memberLabel: 'Ada', tenant: 'mumega',
  project: 'mupot', workspaceLabel: 'wt-a', thread: '',
}

describe('deriveSeatName (pure)', () => {
  it('keeps the W1 format: member · client · project · workspace', () => {
    expect(deriveSeatName(base)).toBe('Ada · Cursor · mupot · wt-a')
  })
  it('drops the workspace segment when it equals the project; falls back to the kind for an unusable label', () => {
    expect(deriveSeatName({ ...base, workspaceLabel: 'mupot', harnessLabel: '!!!' })).toBe('Ada · cursor · mupot')
  })
  it('is deterministic, side-effect free, and ignores reserved signals today', () => {
    expect(deriveSeatName({ ...base, clientRoots: ['/x'], tenant: 'other', thread: 't' })).toBe(deriveSeatName(base))
  })
  it('strips control chars and caps length', () => {
    const out = deriveSeatName({ ...base, project: `a\nb${'x'.repeat(400)}` })
    expect(out).not.toMatch(/[\n\u0000-\u001f]/)
    expect(out.length).toBeLessThanOrEqual(120)
  })
})

describe('a name is a label, never authority', () => {
  let h: SqliteD1Harness
  beforeEach(() => { h = createSqliteD1(); applyAllMigrations(h.sqlite) })
  afterEach(() => h.close())

  it('a seat whose derived name collides with an existing agent\'s name adopts NOTHING: new agent, distinct slug', async () => {
    h.sqlite.exec(`INSERT INTO members (id, email, display_name, status, created_at, tenant) VALUES ('m1', 'm1@x.test', 'Ada', 'active', '2026-10-09', 'mumega')`)
    const env = { DB: h.db, TENANT_SLUG: 'mumega', SESSIONS: { get: async () => null, put: async () => undefined }, SEAT_AUTO_ENROLL: '1', SEAT_MAX_PER_MEMBER: '50' } as unknown as Env
    const harness = await upsertHarness(env, 'm1', 'client-1', 'Cursor')
    const auth = { channel: 'directory' as const, boundAgentId: null, memberId: 'm1', harnessId: harness!.id, tokenId: null }
    const first = await seatSelect(env, auth, { project: 'mupot', folder: '/x/wt-a' })
    expect(first.ok && first.agent.name).toBe('Ada · Cursor · mupot · wt-a')
    // A pre-existing, unrelated agent that already carries the exact name a new seat would derive.
    const squad = h.sqlite.prepare(`SELECT squad_id FROM agents LIMIT 1`).get()!.squad_id as string
    h.sqlite.exec(`INSERT INTO agents (id, squad_id, slug, name, role, status, kind) VALUES ('victim', '${squad}', 'victim-agent', 'Ada · Cursor · mupot · wt-b', 'member', 'active', 'work')`)
    const second = await seatSelect(env, auth, { project: 'mupot', folder: '/x/wt-b' })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.agent.id).not.toBe('victim')
    expect(second.agent.slug).toMatch(/^seat-[0-9a-f]{12}$/)
    expect(second.disposition).toBe('created')
  })
})
