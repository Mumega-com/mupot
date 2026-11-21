// Port-level (decide()) behaviour of the Clef adapter: version rule and degraded outcome.
import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { decide, type DecideConfig } from '../src/decisions/decide'
import { createClefAdapter, CLEF_FLASH_MODEL, CLEF_MODEL } from '../src/decisions/adapters/clef'
import type { DecisionRequest } from '../src/decisions/port'
import type { Env } from '../src/types'

const harnesses: SqliteD1Harness[] = []
afterEach(() => { while (harnesses.length) harnesses.pop()?.close() })

const REQUEST: DecisionRequest = {
  useCase: 't', criteriaVersion: 'v1', state: 's', dataClass: 'metadata',
  questions: { stale: { type: 'choice', instructions: 'i', criteria: { stale: 'a', active: 'b' } } },
}
const CONFIG = { thresholds: { stale: { minTopProbability: 0.6, minMargin: 0.2 } }, timeoutMs: 500 } satisfies DecideConfig

function body(model: string, conf: number, extra: Record<string, unknown> = {}) {
  return { model, answers: { stale: { type: 'choice', choice: 'stale', probabilities: { stale: 0.9, active: 0.1 }, confidence: conf } }, usage: { input_tokens: 1 }, ...extra }
}
function envWith(handler: (m: string) => unknown): Env {
  const harness = createSqliteD1(); applyAllMigrations(harness.sqlite); harnesses.push(harness)
  const AI = { async run(m: string) { const r = handler(m); if (r instanceof Error) throw r; return r } }
  return { DB: harness.db, AI } as unknown as Env
}
const run = (env: Env) => decide(env, REQUEST, { ...CONFIG, adapter: createClefAdapter(env) })

describe('clef through decide()', () => {
  it('a real provider version is proposed with provenance', async () => {
    const r = await run(envWith(() => body('clef-flash-2026-11-01', 0.9)))
    expect(r).toMatchObject({ outcome: 'proposed', modelVersion: 'clef-flash-2026-11-01', model: CLEF_FLASH_MODEL, provenance: { path: 'direct' } })
  })
  it('selector-only echo (the recorded shape) has no version: malformed_output, nothing fabricated', async () => {
    expect(await run(envWith(() => body('clef-flash', 0.9)))).toMatchObject({ outcome: 'failed', reason: 'malformed_output' })
    expect(await run(envWith(() => body('clef', 0.9)))).toMatchObject({ outcome: 'failed', reason: 'malformed_output' })
    expect(await run(envWith(() => body(CLEF_MODEL, 0.9)))).toMatchObject({ outcome: 'failed', reason: 'malformed_output' })
  })
  it('low-confidence flash then clef fails: explicit degraded outcome with provenance', async () => {
    const r = await run(envWith((m) => (m === CLEF_FLASH_MODEL ? body('clef-flash-v1', 0.7) : new Error('down'))))
    expect(r).toMatchObject({ outcome: 'proposed', model: CLEF_FLASH_MODEL, provenance: { tier: CLEF_FLASH_MODEL, path: 'degraded', providerConfidence: 0.7 } })
  })
  it('degraded flash whose probabilities are under the port threshold is declined', async () => {
    const weak = { model: 'clef-flash-v1', answers: { stale: { type: 'choice', probabilities: { stale: 0.55, active: 0.45 }, confidence: 0.5 } } }
    const r = await run(envWith((m) => (m === CLEF_FLASH_MODEL ? weak : new Error('down'))))
    expect(r).toMatchObject({ outcome: 'declined_low_confidence', provenance: { path: 'degraded' } })
  })
  it('invalid flash (NaN) at confidence 0.9 still lets clef answer', async () => {
    const bad = body('clef-flash-v1', 0.9); bad.answers.stale.probabilities = { stale: Number.NaN as number, active: 0.1 }
    const r = await run(envWith((m) => (m === CLEF_FLASH_MODEL ? { ...bad, answers: { stale: { ...bad.answers.stale, probabilities: { stale: 'x', active: 0.1 } } } } : body('clef-2026-11-01', 0.93))))
    expect(r).toMatchObject({ outcome: 'proposed', model: CLEF_MODEL, modelVersion: 'clef-2026-11-01', provenance: { path: 'fallback' } })
  })
  it('both tiers invalid: failed malformed_output', async () => {
    const bad = (m: string) => ({ ...body(m, 0.9), answers: { stale: { type: 'choice', choice: 'stale', probabilities: { stale: 'x', active: 0.1 }, confidence: 0.9 } } })
    expect(await run(envWith((m) => bad(m + '-v1')))).toMatchObject({ outcome: 'failed', reason: 'malformed_output' })
  })
})
