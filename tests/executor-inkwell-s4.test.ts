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
  const cfg = { apiUrl: 'https://inkwell.test', token: 'tok', tenantSlug: 'mumega' }
  const payload = { title: 't', content: 'c' }

  it('routes through the service-binding fetcher when set and no explicit fetchImpl (same-zone 522 avoidance)', async () => {
    const bound = okFetch('sb', '/blog/sb')
    const fetcher = { fetch: bound } as unknown as Fetcher
    // No explicit fetchImpl → the binding is used (never global fetch, which would
    // hit the network and fail in the test runner).
    const r = await inkwellContentWrite({ ...cfg, fetcher }, payload)
    expect(r.slug).toBe('sb')
    expect((bound as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })

  it('an explicit fetchImpl still wins over the service-binding fetcher', async () => {
    const bound = okFetch('binding', '/blog/binding')
    const fetcher = { fetch: bound } as unknown as Fetcher
    const explicit = okFetch('explicit', '/blog/explicit')
    const r = await inkwellContentWrite({ ...cfg, fetcher }, payload, explicit)
    expect(r.slug).toBe('explicit')
    expect((bound as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
  })

  it('writes and returns the artifact on a good response', async () => {
    const f = okFetch('s1', '/blog/s1')
    const r = await inkwellContentWrite(cfg, payload, f)
    expect(r).toEqual({ ok: true, slug: 's1', url: '/blog/s1' })
    // posts to the internal pot-publish endpoint with a Bearer token + tenant_slug
    const call = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(String(call[0])).toBe('https://inkwell.test/api/internal/content/publish')
    expect((call[1] as RequestInit).headers).toMatchObject({ authorization: 'Bearer tok' })
    expect(JSON.parse((call[1] as RequestInit).body as string).tenant_slug).toBe('mumega')
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

  // ── SSRF defense-in-depth: refuse redirects, never follow (LOW-1, mupot#370 delta) ──
  it('301/302/307/308 from apiUrl → inkwell_redirect_blocked, and fetchImpl was called with redirect:"manual"', async () => {
    for (const status of [301, 302, 307, 308]) {
      const f = vi.fn(async () => new Response(null, { status, headers: { location: 'http://169.254.169.254/' } })) as unknown as typeof fetch
      await expect(inkwellContentWrite(cfg, payload, f)).rejects.toMatchObject({ reason: 'inkwell_redirect_blocked' })
      const call = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
      expect((call[1] as RequestInit).redirect).toBe('manual')
    }
  })
  it('browser-style opaqueredirect response → inkwell_redirect_blocked', async () => {
    const opaque = { type: 'opaqueredirect', status: 0, ok: false } as unknown as Response
    const f = vi.fn(async () => opaque) as unknown as typeof fetch
    await expect(inkwellContentWrite(cfg, payload, f)).rejects.toMatchObject({ reason: 'inkwell_redirect_blocked' })
  })
  it('a redirect response never reaches the .json() success path (no follow)', async () => {
    let jsonCalled = false
    const f = vi.fn(async () => {
      const r = new Response(null, { status: 302, headers: { location: 'https://internal.example/' } })
      const origJson = r.json.bind(r)
      r.json = async () => { jsonCalled = true; return origJson() }
      return r
    }) as unknown as typeof fetch
    await expect(inkwellContentWrite(cfg, payload, f)).rejects.toMatchObject({ reason: 'inkwell_redirect_blocked' })
    expect(jsonCalled).toBe(false)
    expect(f).toHaveBeenCalledOnce() // no second (followed) request was ever made
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
    const ctx = mintCtx({ db, executorEnv: { inkwell: { apiUrl: 'https://inkwell.test', token: 'tok', tenantSlug: 'mumega' } } })
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
    const ctx = mintCtx({ db, executorEnv: { inkwell: { apiUrl: 'https://inkwell.test', token: 'tok', tenantSlug: 'mumega' } } })
    const { gateId } = await ctx.gate.propose({ action: 'seo-meta-fix', payload: { executor: 'inkwell-content', title: 't', content: 'c' } })
    await approve(db, gateId)
    const outcome = await ctx.executor.execute(gateId)
    expect(outcome.executed).toBe(false)
    expect(outcome.reason).toBe('inkwell_http_error')
  })

  it('still fail-closed without approval even WITH executorEnv', async () => {
    vi.stubGlobal('fetch', okFetch())
    const db = makeStubDb()
    const ctx = mintCtx({ db, executorEnv: { inkwell: { apiUrl: 'https://inkwell.test', token: 'tok', tenantSlug: 'mumega' } } })
    const { gateId } = await ctx.gate.propose({ action: 'seo-meta-fix', payload: { executor: 'inkwell-content', title: 't', content: 'c' } })
    // NOT approved
    await expect(ctx.executor.execute(gateId)).rejects.toThrow(/not_approved/)
  })
})
