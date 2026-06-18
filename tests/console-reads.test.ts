// tests/console-reads.test.ts — focused coverage for the new console read surfaces
// (Codex WARN-2 on PR #207). Pins the security-relevant behavior of the three wired
// reads: non-admin visibility, latest-verdict semantics, audit secret-exclusion +
// admin-gating + tenant-scope, and billing not-configured honesty.

import { describe, it, expect } from 'vitest'
import type { Env, AuthContext } from '../src/types'
import { loadVerifications, verificationsBody } from '../src/dashboard/verifications'
import { loadAudit, auditBody } from '../src/dashboard/audit'
import { loadBilling, billingBody } from '../src/dashboard/billing'
import { BILLING_STATE_KEY } from '../src/billing/entitlement'

// ── SQL-capturing stub DB ─────────────────────────────────────────────────────
interface Call { sql: string; args: unknown[] }
function makeDb(opts: {
  allRows?: unknown[]
  // first(): keyed by the first bound arg (the org_settings key) → value string|null
  firstByKey?: Record<string, string | null>
}) {
  const calls: Call[] = []
  const db = {
    prepare(sql: string) {
      const args: unknown[] = []
      const stmt = {
        bind(...a: unknown[]) { args.push(...a); return stmt },
        async all() { calls.push({ sql, args }); return { results: opts.allRows ?? [], success: true } },
        async first() {
          calls.push({ sql, args })
          const key = String(args[0])
          const v = opts.firstByKey?.[key]
          return v === undefined || v === null ? null : { value: v }
        },
        async run() { calls.push({ sql, args }); return { success: true, meta: { changes: 0 } } },
      }
      return stmt
    },
  }
  return { db: db as unknown as Env['DB'], calls }
}

function env(db: Env['DB'], tenant = 'test-pot'): Env {
  return { DB: db, TENANT_SLUG: tenant } as unknown as Env
}

const owner = { role: 'owner', tenant: 'test-pot' } as unknown as AuthContext
const member = { role: 'member', tenant: 'test-pot', memberId: 'm1' } as unknown as AuthContext
const agentPrincipal = { role: 'member', tenant: 'test-pot', userId: 'a1' } as unknown as AuthContext
const noPrincipal = { role: 'member', tenant: 'test-pot' } as unknown as AuthContext

async function render(h: unknown): Promise<string> {
  return String(await h)
}

// ── Verifications ─────────────────────────────────────────────────────────────
describe('loadVerifications — visibility + latest-verdict', () => {
  it('owner: no gate_grants filter, sees all; uses latest-verdict (MAX decided_at)', async () => {
    const { db, calls } = makeDb({ allRows: [{ verdict_id: 'v1' }] })
    const rows = await loadVerifications(env(db), owner)
    expect(rows.length).toBe(1)
    expect(calls).toHaveLength(1)
    expect(calls[0].sql).not.toMatch(/gate_grants/)
    expect(calls[0].sql).toMatch(/MAX\(v2\.decided_at\)/) // latest-verdict
  })

  it('member: gate_grants-scoped, binds [memberId, "member"]', async () => {
    const { db, calls } = makeDb({ allRows: [] })
    await loadVerifications(env(db), member)
    expect(calls[0].sql).toMatch(/gate_grants/)
    expect(calls[0].sql).toMatch(/assignee_agent_id = \?1/)
    expect(calls[0].args).toEqual(['m1', 'member'])
  })

  it('agent principal: binds [userId, "agent"]', async () => {
    const { db, calls } = makeDb({ allRows: [] })
    await loadVerifications(env(db), agentPrincipal)
    expect(calls[0].args).toEqual(['a1', 'agent'])
  })

  it('no principal id → returns [] without querying', async () => {
    const { db, calls } = makeDb({ allRows: [{ verdict_id: 'x' }] })
    const rows = await loadVerifications(env(db), noPrincipal)
    expect(rows).toEqual([])
    expect(calls).toHaveLength(0)
  })
})

describe('verificationsBody — render', () => {
  it('empty → honest empty state, no fabricated rows', async () => {
    const out = await render(verificationsBody([]))
    expect(out).toMatch(/No verdicts yet/i)
  })
  it('a rejected verdict renders as rejected (latest-verdict display)', async () => {
    const out = await render(
      verificationsBody([
        { verdict_id: 'v1', task_id: 't1', task_title: 'Ship X', squad_name: null, verdict: 'rejected', decided_by: 'm1', decided_at: '2026-06-18T10:00:00Z', note: null },
      ]),
    )
    expect(out).toMatch(/rejected/)
    expect(out).toContain('Ship X')
  })
})

// ── Audit ─────────────────────────────────────────────────────────────────────
describe('loadAudit — admin-gate, tenant-scope, secret-exclusion', () => {
  it('non-admin → {forbidden:true} WITHOUT touching the DB', async () => {
    const { db, calls } = makeDb({ allRows: [] })
    const res = await loadAudit(env(db), member)
    expect(res).toEqual({ forbidden: true })
    expect(calls).toHaveLength(0)
  })

  it('admin → queries; NEVER selects encrypted_secret; tenant-scoped + limit bound', async () => {
    const { db, calls } = makeDb({ allRows: [{ recorded_at: '2026-06-18T10:00:00Z', action: 'gate.approved', actor_id: 'm1', artifact: 'Ship X', detail: null }] })
    const res = await loadAudit(env(db), owner)
    expect(res.forbidden).toBe(false)
    expect(calls).toHaveLength(1)
    expect(calls[0].sql).not.toMatch(/encrypted_secret/i)
    expect(calls[0].sql).toMatch(/connector_audit/)
    expect(calls[0].sql).toMatch(/task_verdicts/)
    expect(calls[0].sql).toMatch(/UNION ALL/)
    expect(calls[0].args).toEqual(['test-pot', 100]) // TENANT_SLUG + default limit
  })
})

describe('auditBody — render', () => {
  it('forbidden → restricted empty state', async () => {
    const out = await render(auditBody({ forbidden: true }))
    expect(out).toMatch(/owner|admin|restricted/i)
  })
  it('empty rows → honest empty', async () => {
    const out = await render(auditBody({ forbidden: false, rows: [] }))
    expect(out.length).toBeGreaterThan(0)
  })
})

// ── Billing ───────────────────────────────────────────────────────────────────
describe('loadBilling — honesty', () => {
  it('nothing configured → not_configured / free (no fabricated plan)', async () => {
    const { db } = makeDb({ firstByKey: {} })
    const m = await loadBilling(env(db), member)
    expect(m.status).toBe('not_configured')
    expect(m.plan).toBe('free')
    expect(m.since).toBeNull()
  })

  it('billing_state present → active with the stored tier', async () => {
    const { db } = makeDb({
      firstByKey: { [BILLING_STATE_KEY]: JSON.stringify({ tier: 'pro', effective_at: '2026-06-01T00:00:00Z' }) },
    })
    const m = await loadBilling(env(db), member)
    expect(m.status).toBe('active')
    expect(m.plan).toBe('pro')
    expect(m.since).toBe('2026-06-01T00:00:00Z')
  })
})

describe('billingBody — render', () => {
  it('not_configured → honest empty, no card/amount fabrication', async () => {
    const out = await render(billingBody({ plan: 'free', status: 'not_configured', since: null }))
    expect(out.length).toBeGreaterThan(0)
    expect(out).not.toMatch(/\$\d|VISA|ending in|invoice/i)
  })
})
