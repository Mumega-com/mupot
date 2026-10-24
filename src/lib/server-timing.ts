// mupot — optional request-scoped `Server-Timing` instrumentation (latency diagnosis).
//
// Flag: SERVER_TIMING, strict '1', default off. Off = nothing here runs: no Proxy, no wrapper, no
// header. On, authenticated REST responses (/api/*) carry a Server-Timing header with PHASE NAMES AND
// DURATIONS ONLY. Never a key, id, token, cookie, header value or SQL text: the only strings that reach
// the header are the fixed literals in this file, plus a numeric count in `desc`.
//
// Phases (durations in ms, from performance.now()):
//   auth                bearer / session resolution (wall time; its own KV/D1 are ALSO counted below)
//   kv-get|list|put|delete  one entry per KV call (capped, remainder folded into kv-more)
//   d1                  all D1 statements: dur = summed wall ms, desc "n=<statements>"
//   handler             total minus auth (route + everything after auth resolved)
//   total               request start (inside the default handler) to response ready
// auth/kv/d1 overlap by design (auth includes its own D1/KV); handler + auth == total.

import type { Env } from '../types'

export const MAX_KV_ENTRIES = 16

export interface Timer {
  start: number
  kv: Array<{ op: 'get' | 'list' | 'put' | 'delete'; ms: number }>
  d1: { n: number; ms: number }
  authMs: number
}

const timers = new WeakMap<object, Timer>()

export function serverTimingEnabled(env: Pick<Env, 'SERVER_TIMING'>): boolean {
  return env.SERVER_TIMING === '1'
}

const now = (): number => performance.now()

async function timed<T>(fn: () => Promise<T>, add: (ms: number) => void): Promise<T> {
  const t0 = now()
  try {
    return await fn()
  } finally {
    add(now() - t0)
  }
}

/** Time bearer/session resolution. A no-op passthrough unless `env` is an instrumented request env. */
export function withAuthTiming<T>(env: object, fn: () => Promise<T>): Promise<T> {
  const t = timers.get(env)
  if (!t) return fn()
  return timed(fn, (ms) => {
    t.authMs += ms
  })
}

// Wrappers are cast to the binding types: they implement the surface mupot calls and delegate the rest
// unchanged, but cannot be structurally identical to the platform classes.
function wrapKv(kv: KVNamespace, t: Timer): KVNamespace {
  const rec = (op: 'get' | 'list' | 'put' | 'delete') => (ms: number): void => {
    t.kv.push({ op, ms })
  }
  const w = {
    get: (...a: unknown[]) => timed(() => (kv.get as (...x: unknown[]) => Promise<unknown>)(...a), rec('get')),
    getWithMetadata: (...a: unknown[]) => timed(() => (kv.getWithMetadata as (...x: unknown[]) => Promise<unknown>)(...a), rec('get')),
    list: (...a: unknown[]) => timed(() => (kv.list as (...x: unknown[]) => Promise<unknown>)(...a), rec('list')),
    put: (...a: unknown[]) => timed(() => (kv.put as (...x: unknown[]) => Promise<unknown>)(...a), rec('put')),
    delete: (...a: unknown[]) => timed(() => (kv.delete as (...x: unknown[]) => Promise<unknown>)(...a), rec('delete')),
  }
  return w as unknown as KVNamespace // see wrapper note above
}

function wrapD1(db: D1Database, t: Timer): D1Database {
  const raws = new WeakMap<object, D1PreparedStatement>()
  const add = (n: number) => (ms: number): void => {
    t.d1.n += n
    t.d1.ms += ms
  }
  const unwrap = (s: D1PreparedStatement): D1PreparedStatement => raws.get(s) ?? s
  const wrapStmt = (s: D1PreparedStatement): D1PreparedStatement => {
    const w = {
      bind: (...a: unknown[]) => wrapStmt(s.bind(...a)),
      first: (...a: unknown[]) => timed(() => (s.first as (...x: unknown[]) => Promise<unknown>)(...a), add(1)),
      all: () => timed(() => s.all(), add(1)),
      run: () => timed(() => s.run(), add(1)),
      raw: (...a: unknown[]) => timed(() => (s.raw as (...x: unknown[]) => Promise<unknown>)(...a), add(1)),
    }
    const out = w as unknown as D1PreparedStatement // see wrapper note above
    raws.set(out, s)
    return out
  }
  const wrapDb = (d: D1Database | D1DatabaseSession): D1Database => {
    const w = {
      prepare: (sql: string) => wrapStmt(d.prepare(sql)),
      batch: (stmts: D1PreparedStatement[]) => timed(() => d.batch(stmts.map(unwrap)), add(stmts.length)),
      exec: (sql: string) => timed(() => (d as D1Database).exec(sql), add(1)),
      dump: () => (d as D1Database).dump(),
      withSession: (...a: unknown[]) => wrapDb((db.withSession as (...x: unknown[]) => D1DatabaseSession)(...a)),
      getBookmark: () => (d as D1DatabaseSession).getBookmark?.(),
    }
    return w as unknown as D1Database // see wrapper note above
  }
  return wrapDb(db)
}

/** Request env whose DB / SESSIONS / OAUTH_KV are timed; everything else (incl. writes such as
 *  env.OAUTH_PROVIDER) passes straight through to the real env. Create ONE per request. */
export function instrumentEnv(env: Env): { env: Env; timer: Timer } {
  const timer: Timer = { start: now(), kv: [], d1: { n: 0, ms: 0 }, authMs: 0 }
  const wrapped: Partial<Record<string, unknown>> = {
    DB: env.DB ? wrapD1(env.DB, timer) : env.DB,
    SESSIONS: env.SESSIONS ? wrapKv(env.SESSIONS, timer) : env.SESSIONS,
    OAUTH_KV: env.OAUTH_KV ? wrapKv(env.OAUTH_KV, timer) : env.OAUTH_KV,
  }
  const proxy = new Proxy(env, {
    get: (target, prop, recv) => (typeof prop === 'string' && prop in wrapped ? wrapped[prop] : Reflect.get(target, prop, recv)),
  })
  timers.set(proxy, timer)
  return { env: proxy, timer }
}

const fmt = (ms: number): string => (Math.round(ms * 10) / 10).toFixed(1)

/** Render the header value. Only fixed literals and numbers are ever emitted. */
export function renderServerTiming(t: Timer): string {
  const total = now() - t.start
  const parts: string[] = [`auth;dur=${fmt(t.authMs)}`]
  const shown = t.kv.slice(0, MAX_KV_ENTRIES)
  for (const k of shown) parts.push(`kv-${k.op};dur=${fmt(k.ms)}`)
  const rest = t.kv.slice(MAX_KV_ENTRIES)
  if (rest.length > 0) parts.push(`kv-more;dur=${fmt(rest.reduce((a, k) => a + k.ms, 0))};desc="n=${rest.length}"`)
  parts.push(`d1;dur=${fmt(t.d1.ms)};desc="n=${t.d1.n}"`)
  parts.push(`handler;dur=${fmt(Math.max(0, total - t.authMs))}`)
  parts.push(`total;dur=${fmt(total)}`)
  return parts.join(', ')
}

/** Copy `res` with the Server-Timing header set (the original headers may be immutable). */
export function withServerTiming(res: Response, t: Timer): Response {
  const out = new Response(res.body, res)
  out.headers.set('Server-Timing', renderServerTiming(t))
  return out
}
