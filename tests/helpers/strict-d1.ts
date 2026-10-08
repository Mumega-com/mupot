import type { D1Database } from '@cloudflare/workers-types'
import { D1_MAX_BOUND_PARAMETERS } from '../../src/lib/d1-in-list'

/**
 * Wrap a D1 double so it refuses a statement with more than 100 bound parameters, as
 * production D1 does (mupot#1676, #1774). The sqlite double has no such ceiling, so without
 * this a query that production rejects passes in tests. Records the widest bind it saw.
 * Statements reach batch() already wrapped, so batched binds are counted too.
 */
export function strictD1(db: D1Database): { db: D1Database; maxBound: () => number } {
  let widest = 0
  const wrapStatement = (statement: object): object => new Proxy(statement, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (prop !== 'bind' || typeof value !== 'function') return value
      return (...values: unknown[]) => {
        widest = Math.max(widest, values.length)
        if (values.length > D1_MAX_BOUND_PARAMETERS) {
          throw new Error(`D1_ERROR: too many SQL variables (${values.length} > ${D1_MAX_BOUND_PARAMETERS})`)
        }
        return wrapStatement(value.apply(target, values) as object)
      }
    },
  })
  const wrapped = new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (prop !== 'prepare' || typeof value !== 'function') return value
      return (sql: string) => wrapStatement(value.call(target, sql) as object)
    },
  })
  return { db: wrapped, maxBound: () => widest }
}
