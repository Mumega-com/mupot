// tests/executor-mcpwp-s4.test.ts — #370: the WordPress (mcpwp) ACT executor.
//
// Structural twin of tests/executor-inkwell-s4.test.ts. Two layers:
//  A. Unit — the pure helpers (toWpPostBody, parseWpConnectorConfig, wpContentWrite),
//     fail-closed, no secret leak.
//  B. Integration — propose → approve (real verdict row) → execute dispatches to the
//     WIRED adapter when handle.executorEnv.mcpwp is present, and stays
//     executor_not_wired when it is absent (no behavior change for existing call sites).

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { D1Database } from '@cloudflare/workers-types'

import {
  toWpPostBody,
  parseWpConnectorConfig,
  wpContentWrite,
  WpExecutorError,
} from '../src/departments/executors/mcpwp'
import { GrowthModule } from '../src/departments/modules/growth'
import { kernelMintCtx } from '../src/departments/kernel'
import type { DepartmentCtx, KernelHandle } from '../src/departments/ctx'

// ── A. Unit — the helpers ─────────────────────────────────────────────────────

describe('toWpPostBody', () => {
  it('maps a valid payload, ALWAYS forcing status=draft', () => {
    const b = toWpPostBody({ title: 'Hello', content: '<p>hi</p>' })
    expect(b).toEqual({ title: 'Hello', content: '<p>hi</p>', status: 'draft' })
  })
  it('forces draft even when the payload requests published (never auto-publish live)', () => {
    const b = toWpPostBody({ title: 't', content: 'c', status: 'published' })
    expect(b?.status).toBe('draft')
  })
  it('returns null without title or content (fail-closed upstream)', () => {
    expect(toWpPostBody({ content: 'x' })).toBeNull()
    expect(toWpPostBody({ title: 'x' })).toBeNull()
    expect(toWpPostBody(null)).toBeNull()
    expect(toWpPostBody('nope')).toBeNull()
    expect(toWpPostBody({ title: '   ', content: 'c' })).toBeNull()
  })
})

describe('parseWpConnectorConfig', () => {
  it('builds a config from secret + valid meta JSON', () => {
    const cfg = parseWpConnectorConfig('app-pw-123', JSON.stringify({ siteUrl: 'https://example.com', username: 'agent' }))
    expect(cfg).toEqual({ siteUrl: 'https://example.com', username: 'agent', appPassword: 'app-pw-123' })
  })
  it('fails closed on missing secret, missing meta, unparsable meta, or missing fields', () => {
    expect(parseWpConnectorConfig('', JSON.stringify({ siteUrl: 'https://e.com', username: 'a' }))).toBeNull()
    expect(parseWpConnectorConfig('pw', null)).toBeNull()
    expect(parseWpConnectorConfig('pw', 'not json')).toBeNull()
    expect(parseWpConnectorConfig('pw', JSON.stringify({ siteUrl: 'https://e.com' }))).toBeNull()
    expect(parseWpConnectorConfig('pw', JSON.stringify({ username: 'a' }))).toBeNull()
    expect(parseWpConnectorConfig('pw', JSON.stringify([1, 2]))).toBeNull()
    expect(parseWpConnectorConfig('pw', JSON.stringify(null))).toBeNull()
  })
})

function okFetch(id = 1, link = 'https://example.com/?p=1') {
  return vi.fn(async () =>
    new Response(JSON.stringify({ id, link }), { status: 201, headers: { 'content-type': 'application/json' } }),
  ) as unknown as typeof fetch
}

describe('wpContentWrite — fail-closed', () => {
  const cfg = { siteUrl: 'https://example.com', username: 'agent', appPassword: 'app-pw-123' }
  const payload = { title: 't', content: 'c' }

  it('writes and returns the artifact on a good response, with Basic auth + forced draft', async () => {
    const f = okFetch(42, 'https://example.com/?p=42')
    const r = await wpContentWrite(cfg, payload, f)
    expect(r).toEqual({ ok: true, postId: 42, artifactUrl: 'https://example.com/?p=42' })
    const call = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(String(call[0])).toBe('https://example.com/wp-json/wp/v2/posts')
    const init = call[1] as RequestInit
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Basic ${btoa('agent:app-pw-123')}`,
    )
    expect(JSON.parse(init.body as string)).toEqual({ title: 't', content: 'c', status: 'draft' })
  })

  it('missing config → mcpwp_not_configured', async () => {
    await expect(
      wpContentWrite({ siteUrl: '', username: '', appPassword: '' }, payload, okFetch()),
    ).rejects.toMatchObject({ reason: 'mcpwp_not_configured' })
  })
  it('unmappable payload → invalid_payload', async () => {
    await expect(wpContentWrite(cfg, { title: '' }, okFetch())).rejects.toMatchObject({ reason: 'invalid_payload' })
  })
  it('non-ok HTTP → mcpwp_http_error', async () => {
    const f = vi.fn(async () => new Response('no', { status: 500 })) as unknown as typeof fetch
    await expect(wpContentWrite(cfg, payload, f)).rejects.toMatchObject({ reason: 'mcpwp_http_error' })
  })
  it('missing id/link in response → mcpwp_bad_response', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({}), { status: 201, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    await expect(wpContentWrite(cfg, payload, f)).rejects.toMatchObject({ reason: 'mcpwp_bad_response' })
  })
  it('the error is a WpExecutorError carrying a stable reason', async () => {
    const err = await wpContentWrite({ siteUrl: '', username: '', appPassword: '' }, payload, okFetch()).catch((e) => e)
    expect(err).toBeInstanceOf(WpExecutorError)
  })

  // ── SSRF defense-in-depth: refuse redirects, never follow (LOW-1) ──────────
  it('301/302/307/308 from siteUrl → mcpwp_redirect_blocked, and fetchImpl was called with redirect:"manual"', async () => {
    for (const status of [301, 302, 307, 308]) {
      const f = vi.fn(async () => new Response(null, { status, headers: { location: 'http://169.254.169.254/' } })) as unknown as typeof fetch
      await expect(wpContentWrite(cfg, payload, f)).rejects.toMatchObject({ reason: 'mcpwp_redirect_blocked' })
      const call = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
      expect((call[1] as RequestInit).redirect).toBe('manual')
    }
  })
  it('browser-style opaqueredirect response → mcpwp_redirect_blocked', async () => {
    const opaque = { type: 'opaqueredirect', status: 0, ok: false } as unknown as Response
    const f = vi.fn(async () => opaque) as unknown as typeof fetch
    await expect(wpContentWrite(cfg, payload, f)).rejects.toMatchObject({ reason: 'mcpwp_redirect_blocked' })
  })
  it('a redirect response never reaches the .json() success path (no follow)', async () => {
    let jsonCalled = false
    const f = vi.fn(async () => {
      const r = new Response(null, { status: 302, headers: { location: 'https://internal.example/' } })
      const origJson = r.json.bind(r)
      r.json = async () => { jsonCalled = true; return origJson() }
      return r
    }) as unknown as typeof fetch
    await expect(wpContentWrite(cfg, payload, f)).rejects.toMatchObject({ reason: 'mcpwp_redirect_blocked' })
    expect(jsonCalled).toBe(false)
    expect(f).toHaveBeenCalledOnce() // no second (followed) request was ever made
  })

  // ── SSRF guard ────────────────────────────────────────────────────────────
  it.each([
    ['http://example.com', 'non-https'],
    ['https://127.0.0.1', 'loopback'],
    ['https://169.254.169.254', 'metadata'],
    ['https://localhost', 'localhost'],
    ['https://10.0.0.5', 'rfc1918-10'],
    ['https://192.168.1.1', 'rfc1918-192'],
    ['not-a-url', 'unparseable'],
  ])('rejects %s (%s) with mcpwp_bad_siteurl, no fetch', async (siteUrl) => {
    const neverFetch = vi.fn(async () => new Response('{}')) as unknown as typeof fetch
    await expect(wpContentWrite({ ...cfg, siteUrl }, payload, neverFetch)).rejects.toMatchObject({
      reason: 'mcpwp_bad_siteurl',
    })
    expect(neverFetch).not.toHaveBeenCalled()
  })

  // ── no secret leak ────────────────────────────────────────────────────────
  it('appPassword never appears in a thrown error message (missing config)', async () => {
    const err = await wpContentWrite({ siteUrl: '', username: '', appPassword: 'super-secret-pw' }, payload, okFetch()).catch(
      (e) => e,
    )
    expect(String(err)).not.toContain('super-secret-pw')
  })
  it('appPassword never appears in a thrown error message (unreachable fetch)', async () => {
    const throwingFetch = vi.fn(async () => {
      throw new Error('network fail while calling https://x/?auth=Basic YWdlbnQ6c3VwZXItc2VjcmV0LXB3')
    }) as unknown as typeof fetch
    const err = await wpContentWrite(cfg, payload, throwingFetch).catch((e) => e)
    expect(String(err)).not.toContain('super-secret-pw')
    expect(String(err)).not.toContain(btoa('agent:app-pw-123'))
  })
  it('appPassword never appears in a thrown error message (http error)', async () => {
    const f = vi.fn(async () => new Response('server says: app-pw-123 invalid', { status: 500 })) as unknown as typeof fetch
    const err = await wpContentWrite(cfg, payload, f).catch((e) => e)
    expect(String(err)).not.toContain('app-pw-123')
  })
})

// ── B. Integration — execute() dispatch ───────────────────────────────────────

let _idCtr = 0
const makeId = () => `mcpwp-${++_idCtr}`
const NOW = '2026-07-14T12:00:00.000Z'
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

describe('execute() — mcpwp adapter dispatch', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('with executorEnv + approval → executed:true, artifactUrl (real write)', async () => {
    vi.stubGlobal('fetch', okFetch(7, 'https://example.com/?p=7'))
    const db = makeStubDb()
    const ctx = mintCtx({
      db,
      executorEnv: { mcpwp: { siteUrl: 'https://example.com', username: 'agent', appPassword: 'pw' } },
    })
    const { gateId } = await ctx.gate.propose({
      action: 'seo-meta-fix',
      payload: { executor: 'mcpwp', title: 'Hello World', content: '<p>body</p>' },
    })
    await approve(db, gateId)

    const outcome = await ctx.executor.execute(gateId)
    expect(outcome.executed).toBe(true)
    expect(outcome.adapter).toBe('mcpwp')
    expect(outcome.artifactUrl).toBe('https://example.com/?p=7')
  })

  it('NO executorEnv (every current call site) → executor_not_wired, no fetch', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    const db = makeStubDb()
    const ctx = mintCtx({ db }) // no executorEnv
    const { gateId } = await ctx.gate.propose({ action: 'seo-meta-fix', payload: { executor: 'mcpwp', title: 't', content: 'c' } })
    await approve(db, gateId)
    const outcome = await ctx.executor.execute(gateId)
    expect(outcome.executed).toBe(false)
    expect(outcome.reason).toBe('executor_not_wired')
    expect(outcome.adapter).toBe('mcpwp')
    expect(spy).not.toHaveBeenCalled()
  })

  it('adapter HTTP error → fail-closed (executed:false), never throws out of execute()', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 502 })))
    const db = makeStubDb()
    const ctx = mintCtx({
      db,
      executorEnv: { mcpwp: { siteUrl: 'https://example.com', username: 'agent', appPassword: 'pw' } },
    })
    const { gateId } = await ctx.gate.propose({ action: 'seo-meta-fix', payload: { executor: 'mcpwp', title: 't', content: 'c' } })
    await approve(db, gateId)
    const outcome = await ctx.executor.execute(gateId)
    expect(outcome.executed).toBe(false)
    expect(outcome.reason).toBe('mcpwp_http_error')
  })

  it('still fail-closed without approval even WITH executorEnv', async () => {
    vi.stubGlobal('fetch', okFetch())
    const db = makeStubDb()
    const ctx = mintCtx({
      db,
      executorEnv: { mcpwp: { siteUrl: 'https://example.com', username: 'agent', appPassword: 'pw' } },
    })
    const { gateId } = await ctx.gate.propose({ action: 'seo-meta-fix', payload: { executor: 'mcpwp', title: 't', content: 'c' } })
    // NOT approved
    await expect(ctx.executor.execute(gateId)).rejects.toThrow(/not_approved/)
  })

  it('inkwell config present but NOT mcpwp → mcpwp record still executor_not_wired (adapters are independent)', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    const db = makeStubDb()
    const ctx = mintCtx({
      db,
      executorEnv: { inkwell: { apiUrl: 'https://inkwell.test', token: 'tok', tenantSlug: TENANT } },
    })
    const { gateId } = await ctx.gate.propose({ action: 'seo-meta-fix', payload: { executor: 'mcpwp', title: 't', content: 'c' } })
    await approve(db, gateId)
    const outcome = await ctx.executor.execute(gateId)
    expect(outcome.executed).toBe(false)
    expect(outcome.reason).toBe('executor_not_wired')
    expect(outcome.adapter).toBe('mcpwp')
    expect(spy).not.toHaveBeenCalled()
  })
})

// ── C. WordpressChannel registration (#370 LOW-2) ──────────────────────────────
//
// Prior to this fix, WordpressChannel existed but was never attached to any
// DepartmentModule.channels — 'content-publish' was NOT a declared work-type
// anywhere, so every test above had to route through SeoChannel's 'seo-meta-fix'
// as a workaround action. These tests prove the REAL 'content-publish' work-type
// (WordpressChannel, now composed into GrowthModule.channels) is reachable
// end-to-end through gate.propose → approve → execute, with no workaround.

describe('WordpressChannel is registered on GrowthModule and reachable via its own work-type', () => {
  it('GrowthModule.channels includes WordpressChannel', () => {
    const keys = (GrowthModule.channels ?? []).map((c) => c.key)
    expect(keys).toContain('wordpress')
  })

  it("gate.propose({action:'content-publish'}) succeeds (no longer work_type_not_declared)", async () => {
    const db = makeStubDb()
    const ctx = mintCtx({ db })
    const { gateId } = await ctx.gate.propose({
      action: 'content-publish',
      payload: { executor: 'mcpwp', title: 'Real Work-Type', content: '<p>no workaround needed</p>' },
    })
    expect(gateId).toBeTruthy()
  })

  it('full propose → approve → execute via the REAL content-publish work-type, executed:true', async () => {
    vi.stubGlobal('fetch', okFetch(99, 'https://example.com/?p=99'))
    const db = makeStubDb()
    const ctx = mintCtx({
      db,
      executorEnv: { mcpwp: { siteUrl: 'https://example.com', username: 'agent', appPassword: 'pw' } },
    })
    const { gateId } = await ctx.gate.propose({
      action: 'content-publish',
      payload: { executor: 'mcpwp', title: 'Real Work-Type', content: '<p>no workaround needed</p>' },
    })
    await approve(db, gateId)
    const outcome = await ctx.executor.execute(gateId)
    expect(outcome.executed).toBe(true)
    expect(outcome.adapter).toBe('mcpwp')
    expect(outcome.artifactUrl).toBe('https://example.com/?p=99')
    vi.unstubAllGlobals()
  })
})
