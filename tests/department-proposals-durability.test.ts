// tests/department-proposals-durability.test.ts — S4 durability slice.
//
// Proves the CROSS-ISOLATE flow the in-memory _pendingStore could not survive:
// propose on ctx-A → approve (real task_verdicts row) → execute on ctx-B, which has
// a DIFFERENT closure-private _pendingStore (models a fresh Worker isolate) but the
// SAME D1 — and still finds the proposal content via the durable fallback.

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { D1Database } from '@cloudflare/workers-types'

import { GrowthModule } from '../src/departments/modules/growth'
import { kernelMintCtx } from '../src/departments/kernel'
import type { DepartmentCtx, KernelHandle } from '../src/departments/ctx'

let _idCtr = 0
const makeId = () => `dur-${++_idCtr}`
const NOW = '2026-06-18T12:00:00.000Z'

// Stub D1 modelling BOTH task_verdicts (approval) and department_proposals (content).
function makeStubDb() {
  const verdicts = new Map<string, { verdict: string; decided_at: string }[]>()
  const proposals = new Map<string, { gate_id: string; tenant_id: string; department_key: string; action: string; payload_json: string | null }>()
  let proposalInsertThrows = false
  const db = {
    prepare(sql: string) {
      const upper = sql.trim().toUpperCase()
      const args: unknown[] = []
      const stmt = {
        bind(...a: unknown[]) { args.push(...a); return stmt },
        async run() {
          if (upper.includes('INSERT INTO TASK_VERDICTS')) {
            const id = String(args[1])
            const log = verdicts.get(id) ?? []
            log.push({ verdict: String(args[2]), decided_at: String(args[5]) })
            verdicts.set(id, log)
          } else if (upper.includes('INTO DEPARTMENT_PROPOSALS')) {
            if (proposalInsertThrows) throw new Error('stub: department_proposals insert failed')
            proposals.set(String(args[0]), {
              gate_id: String(args[0]),
              tenant_id: String(args[1]),
              department_key: String(args[2]),
              action: String(args[3]),
              payload_json: args[4] === null || args[4] === undefined ? null : String(args[4]),
            })
          }
          return { success: true, meta: { changes: 1 } }
        },
        async all() { return { results: [], success: true } },
        async first() {
          if (upper.includes('FROM TASK_VERDICTS')) {
            const log = verdicts.get(String(args[0]))
            return log && log.length ? { verdict: log[log.length - 1].verdict } : null
          }
          if (upper.includes('FROM DEPARTMENT_PROPOSALS')) {
            return proposals.get(String(args[0])) ?? null
          }
          return null
        },
      }
      return stmt
    },
    async batch() { return [] },
    // test handles:
    _proposals: proposals,
    _failProposalInsert() { proposalInsertThrows = true },
  } as unknown as D1Database & { _proposals: Map<string, unknown>; _failProposalInsert(): void }
  return db
}

function mintCtx(handle: KernelHandle, tenantId = 'mumega'): DepartmentCtx {
  return kernelMintCtx(handle, {
    tenantId,
    departmentKey: 'growth',
    module: GrowthModule,
    capabilities: ['lead'],
    now: () => NOW,
    idGen: makeId,
  })
}

async function approve(db: D1Database, gateId: string) {
  await db
    .prepare(`INSERT INTO task_verdicts (id, task_id, verdict, note, decided_by, decided_at) VALUES (?1,?2,?3,?4,?5,?6)`)
    .bind(`v-${gateId}`, gateId, 'approved', null, 'tester', NOW)
    .run()
}

function okFetch(url = '/blog/durable') {
  return vi.fn(async () => new Response(JSON.stringify({ ok: true, slug: 'durable', url }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
}

describe('department_proposals durability — cross-isolate propose→approve→execute', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('propose write-throughs a durable row', async () => {
    const db = makeStubDb() as ReturnType<typeof makeStubDb>
    const ctx = mintCtx({ db })
    const { gateId } = await ctx.gate.propose({ action: 'seo-meta-fix', payload: { executor: 'inkwell-content', title: 't', content: 'c' } })
    expect((db as unknown as { _proposals: Map<string, unknown> })._proposals.has(gateId)).toBe(true)
  })

  it('execute on a DIFFERENT ctx (fresh isolate, same DB) finds the proposal via the durable fallback', async () => {
    vi.stubGlobal('fetch', okFetch('/blog/durable'))
    const db = makeStubDb()
    const ctxA = mintCtx({ db }) // proposer isolate
    const { gateId } = await ctxA.gate.propose({
      action: 'seo-meta-fix',
      payload: { executor: 'inkwell-content', title: 'Durable', content: '# body' },
    })
    await approve(db, gateId)

    // ctxB = a fresh isolate: different closure-private _pendingStore, SAME db.
    const ctxB = mintCtx({ db, executorEnv: { inkwell: { apiUrl: 'https://inkwell.test', token: 'tok', tenantSlug: 'mumega' } } })
    const outcome = await ctxB.executor.execute(gateId)
    expect(outcome.executed).toBe(true) // found via DB, approval verified, adapter ran
    expect(outcome.artifactUrl).toBe('/blog/durable')
  })

  it('cross-tenant binding still rejects even via the durable row', async () => {
    const db = makeStubDb()
    const ctxA = mintCtx({ db }, 'mumega')
    const { gateId } = await ctxA.gate.propose({ action: 'seo-meta-fix', payload: { executor: 'inkwell-content', title: 't', content: 'c' } })
    await approve(db, gateId)
    // ctxB is a DIFFERENT tenant — the durable row's tenant_id won't match → reject.
    const ctxB = mintCtx({ db }, 'other-tenant')
    await expect(ctxB.executor.execute(gateId)).rejects.toThrow(/not_approved|cross-tenant/i)
  })

  it('unknown gateId (no durable row, empty map) → not_approved', async () => {
    const db = makeStubDb()
    const ctx = mintCtx({ db })
    await expect(ctx.executor.execute('never-proposed')).rejects.toThrow(/not_approved/)
  })

  it('propose is FAIL-CLOSED: a durable-write error propagates (no silent non-durable gate)', async () => {
    const db = makeStubDb()
    ;(db as unknown as { _failProposalInsert(): void })._failProposalInsert()
    const ctx = mintCtx({ db })
    await expect(ctx.gate.propose({ action: 'seo-meta-fix', payload: { executor: 'inkwell-content', title: 't', content: 'c' } })).rejects.toThrow(/insert failed/)
  })
})
