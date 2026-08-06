// tests/wizard-seed-agent.test.ts — agent templates (#14) + wizard seed handler (#12).
//
// Covers:
//   - Every template passes isEffort / isAutonomy guards
//   - Every template kpi_target parses a leading int via parseLeadingInt
//   - getTemplate returns the right template for known key; undefined for unknown
//   - The /setup/seed-agent route creates an agent with the template's fields
//   - The skip path creates nothing (no agent INSERT)
//   - A UNIQUE conflict is treated as idempotent success (already_exists)
//   - Unknown template_key → 400 / unknown_template
//   - Missing template_key (non-skip) → 400 / invalid_template_key
//   - No squad in D1 → 422 / no_squad
//   - Non-owner → 403
//   - Onboarding complete → 409

import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { AGENT_TEMPLATES, getTemplate } from '../src/org/templates'
import { isEffort, isAutonomy } from '../src/types'
import { parseLeadingInt } from '../src/agents/loop'
import { wizardApp } from '../src/dashboard/wizard'
import type { Env, AuthContext } from '../src/types'

// ── D1 mock ────────────────────────────────────────────────────────────────────
// Drives the wizard route's three sequential D1 calls:
//   slot 0: SELECT value FROM org_settings WHERE key = 'onboarding_complete' (first())
//   slot 1: SELECT id FROM squads … LIMIT 1 (first())
//   slot 2: INSERT INTO agents … (run())

interface SlotConfig {
  firstRow?: unknown          // returned by .first()
  changes?: number            // returned by .run().meta.changes
  throws?: Error              // throw from .run() (UNIQUE violation simulation)
}

function makeD1(slots: SlotConfig[] = []) {
  const calls: { sql: string; binds: unknown[] }[] = []
  let slotIdx = 0

  const db = {
    prepare(sql: string) {
      const call = { sql, binds: [] as unknown[] }
      calls.push(call)
      const idx = slotIdx++
      const slot: SlotConfig = slots[idx] ?? {}
      const stmt = {
        bind(...args: unknown[]) {
          call.binds = args
          return stmt
        },
        async first<T>() {
          return (slot.firstRow ?? null) as T | null
        },
        async all<T>() {
          return { results: [] as T[] }
        },
        async run() {
          if (slot.throws) throw slot.throws
          return { meta: { changes: slot.changes ?? 1 } }
        },
      }
      return stmt
    },
    async batch(stmts: Array<{ run(): Promise<unknown> }>) {
      // createAgent (agents + memberships) and setSettings both use batch. Run each
      // statement so a slot's `throws` (UNIQUE-violation simulation) propagates the
      // same way a real D1 batch surfaces the first failing statement's error.
      const out = []
      for (const s of stmts) out.push(await s.run())
      return out
    },
  }
  return { db, calls }
}

// Build a minimal Env for the wizard. Only DB and identifying fields are needed.
function makeEnv(d1Slots: SlotConfig[] = []) {
  const { db, calls } = makeD1(d1Slots)
  const env = {
    TENANT_SLUG: 'test-tenant',
    BRAND: 'Test',
    DB: db,
    SESSIONS: {},
  } as unknown as Env
  return { env, calls }
}

// ── Hono test harness ─────────────────────────────────────────────────────────
// wizardApp reads c.get('auth') which is set by the parent dashboard's requireAuth
// middleware before mounting. In tests we pre-set it using a thin wrapper app.

type TestAppEnv = { Bindings: Env; Variables: { auth: AuthContext } }

function fakeAuth(role: 'owner' | 'admin' | 'member'): AuthContext {
  return {
    userId: 'user-1',
    email: 'owner@example.com',
    role,
    tenant: 'test-tenant',
    memberId: undefined,
    capabilities: undefined,
  }
}

function makeTestApp(auth: AuthContext) {
  const app = new Hono<TestAppEnv>()
  // Inject auth as a context variable before the wizard routes run.
  app.use('*', async (c, next) => {
    c.set('auth', auth)
    await next()
  })
  app.route('/', wizardApp)
  return app
}

/** POST /seed-agent through a wrapper app with the given auth. */
async function postSeedAgent(
  body: unknown,
  d1Slots: SlotConfig[],
  role: 'owner' | 'admin' | 'member' = 'owner',
): Promise<{ res: Response; calls: { sql: string; binds: unknown[] }[] }> {
  const { env, calls } = makeEnv(d1Slots)
  const app = makeTestApp(fakeAuth(role))
  const res = await app.request(
    '/seed-agent',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  )
  return { res, calls }
}

// ── template catalogue ─────────────────────────────────────────────────────────

describe('AGENT_TEMPLATES catalogue', () => {
  it('has at least 4 templates', () => {
    expect(AGENT_TEMPLATES.length).toBeGreaterThanOrEqual(4)
  })

  it('every template has a unique key', () => {
    const keys = AGENT_TEMPLATES.map((t) => t.key)
    const unique = new Set(keys)
    expect(unique.size).toBe(keys.length)
  })

  it.each(AGENT_TEMPLATES)('template $key: effort passes isEffort', (t) => {
    expect(isEffort(t.effort)).toBe(true)
  })

  it.each(AGENT_TEMPLATES)('template $key: autonomy passes isAutonomy', (t) => {
    expect(isAutonomy(t.autonomy)).toBe(true)
  })

  it.each(AGENT_TEMPLATES)('template $key: kpi_target has a parseable leading int', (t) => {
    const n = parseLeadingInt(t.kpi_target)
    expect(typeof n).toBe('number')
    expect(n).toBeGreaterThan(0)
  })

  it.each(AGENT_TEMPLATES)('template $key: name, role, okr, description are non-empty', (t) => {
    expect(t.name.trim().length).toBeGreaterThan(0)
    expect(t.role.trim().length).toBeGreaterThan(0)
    expect(t.okr.trim().length).toBeGreaterThan(0)
    expect(t.description.trim().length).toBeGreaterThan(0)
  })
})

// ── getTemplate ───────────────────────────────────────────────────────────────

describe('getTemplate', () => {
  it('returns the correct template for each known key', () => {
    for (const t of AGENT_TEMPLATES) {
      const found = getTemplate(t.key)
      expect(found).toBeDefined()
      expect(found?.key).toBe(t.key)
      expect(found?.name).toBe(t.name)
    }
  })

  it('returns undefined for an unknown key', () => {
    expect(getTemplate('not-a-real-template')).toBeUndefined()
  })

  it('returns undefined for an empty string', () => {
    expect(getTemplate('')).toBeUndefined()
  })
})

// ── /setup/seed-agent — success path ─────────────────────────────────────────
//
// D1 slot order for a successful non-skip create:
//   slot 0: onboarding_complete check (getSetting → first()) → null  (not done)
//   slot 1: first squad (SELECT id FROM squads … LIMIT 1) → { id: 'squad-1' }
//   slot 2: INSERT INTO agents … → changes=1

const SLOTS_OK: SlotConfig[] = [
  { firstRow: null },              // onboarding_complete = not set
  { firstRow: { id: 'squad-1' } },// first squad
  { changes: 1 },                 // INSERT agents
]

describe('/setup/seed-agent — success path', () => {
  it('returns 201 and the agent body with the correct template fields', async () => {
    const { res, calls } = await postSeedAgent(
      { template_key: 'outreach-researcher' },
      SLOTS_OK,
    )
    expect(res.status).toBe(201)
    const body = await res.json() as {
      ok: boolean
      agent: { name: string; role: string; autonomy: string; effort: string }
    }
    expect(body.ok).toBe(true)
    expect(body.agent.name).toBe('Outreach Researcher')
    expect(body.agent.role).toBe('Researcher')
    expect(body.agent.autonomy).toBe('draft')
    expect(body.agent.effort).toBe('standard')

    // The INSERT must bind the template's kpi_target and okr.
    const insertCall = calls.find((c) => c.sql.includes('INSERT INTO agents'))
    expect(insertCall).toBeDefined()
    expect(insertCall!.binds).toContain('Outreach Researcher')
    expect(insertCall!.binds).toContain('Researcher')
    expect(insertCall!.binds).toContain('draft')
    expect(insertCall!.binds).toContain('standard')
    expect(insertCall!.binds).toContain('20 qualified leads / week')
  })

  it('accepts every template key without error', async () => {
    for (const t of AGENT_TEMPLATES) {
      const slots: SlotConfig[] = [
        { firstRow: null },
        { firstRow: { id: 'squad-x' } },
        { changes: 1 },
      ]
      const { res } = await postSeedAgent({ template_key: t.key }, slots)
      expect(res.status).toBe(201)
    }
  })

  it('inserts into the first squad by created_at ASC', async () => {
    const { res, calls } = await postSeedAgent(
      { template_key: 'content-writer' },
      SLOTS_OK,
    )
    expect(res.status).toBe(201)
    const squadSelect = calls.find(
      (c) => c.sql.includes('FROM squads') && c.sql.includes('ORDER BY created_at'),
    )
    expect(squadSelect).toBeDefined()
    // The INSERT must bind the squad-1 id as squad_id.
    const insertCall = calls.find((c) => c.sql.includes('INSERT INTO agents'))
    expect(insertCall!.binds).toContain('squad-1')
  })
})

// ── /setup/seed-agent — skip path ────────────────────────────────────────────

describe('/setup/seed-agent — skip path', () => {
  it('returns 200 ok + skipped:true and issues no agent INSERT', async () => {
    // Only slot 0 (onboarding_complete check) is consumed; no squad lookup or INSERT.
    const { res, calls } = await postSeedAgent(
      { skip: true },
      [{ firstRow: null }],
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; skipped: boolean }
    expect(body.ok).toBe(true)
    expect(body.skipped).toBe(true)
    expect(calls.find((c) => c.sql.includes('INSERT INTO agents'))).toBeUndefined()
  })
})

// ── /setup/seed-agent — idempotency ──────────────────────────────────────────

describe('/setup/seed-agent — idempotency (slug_taken)', () => {
  it('returns 200 ok + already_exists:true on a UNIQUE violation', async () => {
    const uniqueErr = new Error('UNIQUE constraint failed: agents.slug')
    const { res } = await postSeedAgent(
      { template_key: 'outreach-researcher' },
      [
        { firstRow: null },             // onboarding_complete
        { firstRow: { id: 'squad-1' } },// squad
        { firstRow: null },             // S6 entitlement gate: COUNT agents → 0 (under free limit)
        { firstRow: null },             // S6 entitlement gate: billing_state → unconfigured → free
        { throws: uniqueErr },           // INSERT → UNIQUE violation
      ],
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; already_exists: boolean }
    expect(body.ok).toBe(true)
    expect(body.already_exists).toBe(true)
  })
})

// ── /setup/seed-agent — error paths ──────────────────────────────────────────

describe('/setup/seed-agent — error paths', () => {
  it('returns 400 / unknown_template for an unrecognised template key', async () => {
    const { res } = await postSeedAgent(
      { template_key: 'does-not-exist' },
      [{ firstRow: null }],
    )
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('unknown_template')
  })

  it('returns 400 / invalid_template_key when template_key is absent and skip is false', async () => {
    const { res } = await postSeedAgent(
      {},
      [{ firstRow: null }],
    )
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('invalid_template_key')
  })

  it('returns 422 / no_squad when no squads exist', async () => {
    const { res } = await postSeedAgent(
      { template_key: 'outreach-researcher' },
      [
        { firstRow: null }, // onboarding_complete
        { firstRow: null }, // no squad
      ],
    )
    expect(res.status).toBe(422)
    const body = await res.json() as { error: string; hint: string }
    expect(body.error).toBe('no_squad')
    expect(typeof body.hint).toBe('string')
  })

  it('returns 403 when the caller is not owner', async () => {
    const { res } = await postSeedAgent(
      { template_key: 'outreach-researcher' },
      [],
      'member',
    )
    expect(res.status).toBe(403)
  })

  it('returns 409 when onboarding is already complete (blockIfComplete)', async () => {
    // blockIfComplete reads onboarding_complete = 'true' from org_settings.
    // The wizard uses getSetting which calls .first() — return the value directly.
    const { res } = await postSeedAgent(
      { template_key: 'outreach-researcher' },
      [{ firstRow: { value: 'true' } }],
    )
    expect(res.status).toBe(409)
  })
})
