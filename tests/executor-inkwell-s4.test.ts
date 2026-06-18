// tests/executor-inkwell-s4.test.ts — S4: the inkwell-content ACT executor.
//
// Two layers:
//  A. Unit — the pure helper (toPublishBody + inkwellContentWrite), fail-closed.
//  B. Integration — propose → approve (real verdict row) → execute dispatches to the
//     WIRED adapter when handle.executorEnv.inkwell is present, and stays
//     executor_not_wired when it is absent (every current call site → no behavior
//     change). Approval is still a real task_verdicts row; payload is content-bound.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { D1Database } from '@cloudflare/workers-types'

import {
  toPublishBody,
  inkwellContentWrite,
  InkwellExecutorError,
} from '../src/departments/executors/inkwell'
import { GrowthModule } from '../src/departments/modules/growth'
import { kernelMintCtx } from '../src/departments/kernel'
import type { DepartmentCtx, KernelHandle } from '../src/departments/ctx'

// ── A. Unit — the helper ──────────────────────────────────────────────────────

describe('toPublishBody', () => {
  it('maps a valid payload, defaulting status=draft and overwrite=false', () => {
    const b = toPublishBody({ title: 'Hello', content: '# hi', author: 'a', tags: ['x', 1, 'y'] })
    expect(b).toMatchObject({ title: 'Hello', content: '# hi', author: 'a', status: 'draft', overwrite: false })
    expect(b?.tags).toEqual(['x', 'y']) // non-strings dropped
  })
  it('returns null without title or content (fail-closed upstream)', () => {
    expect(toPublishBody({ content: 'x' })).toBeNull()
    expect(toPublishBody({ title: 'x' })).toBeNull()
    expect(toPublishBody(null)).toBeNull()
    expect(toPublishBody('nope')).toBeNull()
  })
  it('honours explicit published/archived status but nothing else', () => {
    expect(toPublishBody({ title: 't', content: 'c', status: 'published' })?.status).toBe('published')
    expect(toPublishBody({ title: 't', content: 'c', status: 'weird' })?.status).toBe('draft')
  })
})

function okFetch(slug = 'test-slug', url = '/blog/test-slug') {
  return vi.fn(async () =>
    new Response(JSON.stringify({ ok: true, slug, url }), { status: 200, headers: { 'content-type': 'application/json' } }),
  ) as unknown as typeof fetch
}

describe('inkwellContentWrite — fail-closed', () => {
  const cfg = { apiUrl: 'https://inkwell.test', token: 'tok' }
  const payload = { title: 't', content: 'c' }

  it('writes and returns the artifact on a good response', async () => {
    const f = okFetch('s1', '/blog/s1')
    const r = await inkwellContentWrite(cfg, payload, f)
    expect(r).toEqual({ ok: true, slug: 's1', url: '/blog/s1' })
    // posts to /api/content/publish with a Bearer token
    const call = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(String(call[0])).toBe('https://inkwell.test/api/content/publish')
    expect((call[1] as RequestInit).headers).toMatchObject({ authorization: 'Bearer tok' })
  })

  it('missing config → inkwell_not_configured', async () => {
    await expect(inkwellContentWrite({ apiUrl: '', token: '' }, payload, okFetch())).rejects.toMatchObject({ reason: 'inkwell_not_configured' })
  })
  it('unmappable payload → invalid_payload', async () => {
    await expect(inkwellContentWrite(cfg, { title: '' }, okFetch())).rejects.toMatchObject({ reason: 'invalid_payload' })
  })
  it('non-ok HTTP → inkwell_http_error', async () => {
    const f = vi.fn(async () => new Response('no', { status: 500 })) as unknown as typeof fetch
    await expect(inkwellContentWrite(cfg, payload, f)).rejects.toMatchObject({ reason: 'inkwell_http_error' })
  })
  it('ok:false / missing slug → inkwell_bad_response', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ ok: false }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    await expect(inkwellContentWrite(cfg, payload, f)).rejects.toMatchObject({ reason: 'inkwell_bad_response' })
  })
  it('the error is an InkwellExecutorError carrying a stable reason', async () => {
    const err = await inkwellContentWrite({ apiUrl: '', token: '' }, payload, okFetch()).catch((e) => e)
    expect(err).toBeInstanceOf(InkwellExecutorError)
  })
})

// ── B. Integration — execute() dispatch ───────────────────────────────────────

let _idCtr = 0
const makeId = () => `inkw-${++_idCtr}`
const NOW = '2026-06-18T12:00:00.000Z'
const TENANT = 'mumega'

// Minimal SQL-aware stub: stores task_verdicts rows + answers _hasApprovedVerdict.
function makeStubDb(): D1Database {
  const verdicts = new Map<string, { verdict: string; decided_at: string }[]>()
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
          }
          return { success: true, meta: { changes: 1 } }
        },
        async all() { return { results: [], success: true } },
        async first() {
          if (upper.includes('FROM TASK_VERDICTS')) {
            const log = verdicts.get(String(args[0]))
            return log && log.length ? { verdict: log[log.length - 1].verdict } : null
          }
          return null
        },
      }
      return stmt
    },
    async batch() { return [] },
  } as unknown as D1Database
  return db
}

function mintCtx(handle: KernelHandle): DepartmentCtx {
  return kernelMintCtx(handle, {
    tenantId: TENANT,
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

describe('execute() — inkwell-content adapter dispatch', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('with executorEnv + approval → executed:true, artifactUrl (real write)', async () => {
    vi.stubGlobal('fetch', okFetch('hello-world', '/blog/hello-world'))
    const db = makeStubDb()
    const ctx = mintCtx({ db, executorEnv: { inkwell: { apiUrl: 'https://inkwell.test', token: 'tok' } } })
    const { gateId } = await ctx.gate.propose({
      action: 'seo-meta-fix',
      payload: { executor: 'inkwell-content', title: 'Hello World', content: '# body' },
    })
    await approve(db, gateId)

    const outcome = await ctx.executor.execute(gateId)
    expect(outcome.executed).toBe(true)
    expect(outcome.adapter).toBe('inkwell-content')
    expect(outcome.artifactUrl).toBe('/blog/hello-world')
  })

  it('NO executorEnv (every current call site) → executor_not_wired, no fetch', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    const db = makeStubDb()
    const ctx = mintCtx({ db }) // no executorEnv
    const { gateId } = await ctx.gate.propose({ action: 'seo-meta-fix', payload: { executor: 'inkwell-content', title: 't', content: 'c' } })
    await approve(db, gateId)
    const outcome = await ctx.executor.execute(gateId)
    expect(outcome.executed).toBe(false)
    expect(outcome.reason).toBe('executor_not_wired')
    expect(spy).not.toHaveBeenCalled()
  })

  it('adapter HTTP error → fail-closed (executed:false), never throws out of execute()', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 502 })))
    const db = makeStubDb()
    const ctx = mintCtx({ db, executorEnv: { inkwell: { apiUrl: 'https://inkwell.test', token: 'tok' } } })
    const { gateId } = await ctx.gate.propose({ action: 'seo-meta-fix', payload: { executor: 'inkwell-content', title: 't', content: 'c' } })
    await approve(db, gateId)
    const outcome = await ctx.executor.execute(gateId)
    expect(outcome.executed).toBe(false)
    expect(outcome.reason).toBe('inkwell_http_error')
  })

  it('still fail-closed without approval even WITH executorEnv', async () => {
    vi.stubGlobal('fetch', okFetch())
    const db = makeStubDb()
    const ctx = mintCtx({ db, executorEnv: { inkwell: { apiUrl: 'https://inkwell.test', token: 'tok' } } })
    const { gateId } = await ctx.gate.propose({ action: 'seo-meta-fix', payload: { executor: 'inkwell-content', title: 't', content: 'c' } })
    // NOT approved
    await expect(ctx.executor.execute(gateId)).rejects.toThrow(/not_approved/)
  })
})
