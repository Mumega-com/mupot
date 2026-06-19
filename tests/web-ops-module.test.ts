// tests/web-ops-module.test.ts — the reusable Web-Operations department template (the wedge).
//
// Litmus: registers by import, declares the six web-team squads (operator/qa/content-seo/
// brand-assets/funnel-ghl/strategy), seeds them on a paid tier, and is refused on free by the
// S6 entitlement gate (6 squads > free's 1).

import { describe, it, expect } from 'vitest'
import type { D1Database } from '@cloudflare/workers-types'
import { WebOpsModule } from '../src/departments/modules/web-ops' // registers on import
import { activate, listRegistered, getRegistered } from '../src/departments/registry'

const NOW = '2026-06-19T00:00:00Z'
let idc = 0
const makeId = () => `wid-${++idc}`

interface DeptRow {
  id: string; slug: string; name: string; template_key: string | null; template_version: string | null
  activated_at: string | null; active: number; seed_receipt: string | null; created_at: string
}
interface SquadRow { id: string; department_id: string; slug: string; name: string; charter: string | null; created_at: string }

function makeDb(opts?: { tier?: string }): { db: D1Database; squads: () => SquadRow[] } {
  const depts: DeptRow[] = []
  const squads: SquadRow[] = []
  const tier = opts?.tier ?? 'scale'

  function runSql(sql: string, args: unknown[]) {
    const u = sql.trim().toUpperCase()
    if (u.startsWith('INSERT INTO DEPARTMENTS')) {
      const [id, slug, name, tk, tv, aa, ca] = args as string[]
      depts.push({ id, slug, name, template_key: tk, template_version: tv, activated_at: aa, active: 1, seed_receipt: null, created_at: ca })
      return { meta: { changes: 1 } }
    }
    if (u.startsWith('UPDATE DEPARTMENTS') && u.includes('SET ACTIVE = 1')) {
      const [id, tk, tv, aa, name] = args as string[]
      const r = depts.find((d) => d.id === id); if (!r) return { meta: { changes: 0 } }
      r.active = 1; r.template_key = tk; r.template_version = tv; if (!r.activated_at) r.activated_at = aa; r.name = name
      return { meta: { changes: 1 } }
    }
    if (u.startsWith('UPDATE DEPARTMENTS') && u.includes('SEED_RECEIPT')) {
      const [id, receipt] = args as string[]
      const r = depts.find((d) => d.id === id && d.seed_receipt === null); if (!r) return { meta: { changes: 0 } }
      r.seed_receipt = receipt; return { meta: { changes: 1 } }
    }
    if (u.startsWith('INSERT OR IGNORE INTO SQUADS')) {
      const [id, did, slug, name, charter, ca] = args as (string | null)[]
      if (squads.some((s) => s.department_id === did && s.slug === slug)) return { meta: { changes: 0 } }
      squads.push({ id: id as string, department_id: did as string, slug: slug as string, name: name as string, charter: charter ?? null, created_at: ca as string })
      return { meta: { changes: 1 } }
    }
    return { meta: { changes: 0 } }
  }
  function allSql(sql: string, args: unknown[]) {
    const u = sql.trim().toUpperCase()
    if (u.includes('FROM DEPARTMENTS') && u.includes('WHERE SLUG')) {
      const r = depts.find((d) => d.slug === args[0]) ?? null
      return { results: r ? [r] : [] }
    }
    if (u.includes('FROM ORG_SETTINGS')) return { results: [{ value: JSON.stringify({ tier }) }] }
    if (u.includes('COUNT(*)') && u.includes('FROM SQUADS')) return { results: [{ n: squads.length }] }
    return { results: [] }
  }
  function makeStmt(sql: string) {
    const binds: unknown[] = []
    const stmt = {
      bind(...a: unknown[]) { binds.push(...a); return stmt },
      async run() { return runSql(sql, binds) },
      async all() { return allSql(sql, binds) },
      async first() { return (allSql(sql, binds).results[0] as Record<string, unknown>) ?? null },
    }
    return stmt
  }
  const db = {
    prepare: (sql: string) => makeStmt(sql),
    async batch(stmts: Array<{ run: () => Promise<unknown> }>) { const out: unknown[] = []; for (const s of stmts) out.push(await s.run()); return out },
  } as unknown as D1Database
  return { db, squads: () => squads }
}

const EXPECTED = ['site-operator', 'qa', 'content-seo', 'brand-assets', 'funnel-ghl', 'strategy']

describe('WebOpsModule', () => {
  it('registers by import + declares the six web-team squads', () => {
    expect(getRegistered('web-ops')).toBeTruthy()
    expect(listRegistered().map((m) => m.key)).toContain('web-ops')
    expect(WebOpsModule.defaultSquads.map((s) => s.slug)).toEqual(EXPECTED)
    expect(WebOpsModule.consoleSection.id).toBe('web-ops')
    expect(WebOpsModule.key).toBe('web-ops')
  })

  it('activates on a paid tier → seeds all six squads (idempotent re-activation)', async () => {
    const store = makeDb({ tier: 'scale' })
    const r1 = await activate(store.db, 'web-ops', { now: () => NOW, idGen: makeId })
    expect(r1.ok).toBe(true)
    expect(store.squads().map((s) => s.slug).sort()).toEqual([...EXPECTED].sort())
    const r2 = await activate(store.db, 'web-ops', { now: () => NOW, idGen: makeId })
    expect(r2.ok).toBe(true)
    expect(store.squads()).toHaveLength(6) // no re-seed
  })

  it('S6: refused on free tier (6 squads > free maxSquads=1) — an ops pot is paid', async () => {
    const store = makeDb({ tier: 'free' })
    const r = await activate(store.db, 'web-ops', { now: () => NOW, idGen: makeId })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('squad_limit_reached')
    expect(store.squads()).toHaveLength(0) // atomic refusal
  })

  it('is a declarative manifest — the module file mints nothing (litmus)', async () => {
    const mod = await import('../src/departments/modules/web-ops')
    expect(Object.keys(mod)).toEqual(['WebOpsModule'])
  })
})
