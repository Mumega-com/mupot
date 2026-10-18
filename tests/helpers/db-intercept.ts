// tests/helpers/db-intercept.ts — wrap a REAL D1 handle (the sqlite-backed one) and intercept statements whose SQL matches.
// Not a fake engine: unmatched SQL runs against the real database untouched. Used to break or observe one table's traffic.
// (Imports nothing from src/, so the test-schema-source ratchet does not treat it as a D1 stand-in.)

export type InterceptMode = 'observe' | 'throw-sync' | 'reject' | 'hang'

interface Bindable { bind: (...v: unknown[]) => unknown }
interface Preparer { prepare: (sql: string) => Bindable }

export function interceptDb<T extends object>(db: T, match: RegExp, mode: InterceptMode, seen: string[] = []): T {
  return new Proxy(db, {
    get(target, key, receiver) {
      if (key !== 'prepare') return Reflect.get(target, key, receiver)
      return (sql: string) => {
        const real = (target as unknown as Preparer).prepare(sql) // target is the real D1 handle
        if (!match.test(sql)) return real
        seen.push(sql)
        if (mode === 'observe') return real
        if (mode === 'throw-sync') throw new Error('intercepted: prepare failed')
        const fail = (): Promise<never> => (mode === 'hang' ? new Promise<never>(() => {}) : Promise.reject(new Error('intercepted: statement failed')))
        return { bind: () => ({ first: fail, run: fail, all: fail }) }
      }
    },
  })
}

interface RawSqlite { prepare: (sql: string) => { all: (...v: unknown[]) => Record<string, unknown>[]; get: (...v: unknown[]) => Record<string, unknown> | undefined; run: (...v: unknown[]) => unknown } }

/** Direct reads/writes on the real sqlite behind a test world (what a test uses to seed and to look at rows). */
export const sqlAll = (h: { sqlite: unknown }, sql: string, ...v: unknown[]): Record<string, unknown>[] => (h.sqlite as RawSqlite).prepare(sql).all(...v)
export const sqlGet = (h: { sqlite: unknown }, sql: string, ...v: unknown[]): Record<string, unknown> | undefined => (h.sqlite as RawSqlite).prepare(sql).get(...v)
export const sqlRun = (h: { sqlite: unknown }, sql: string, ...v: unknown[]): unknown => (h.sqlite as RawSqlite).prepare(sql).run(...v)
