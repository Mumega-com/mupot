// Port-level (decide()) behaviour of the Clef adapter: the port owns the version rule.
import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { decide, type DecideConfig } from '../src/decisions/decide'
import { createClefAdapter, CLEF_FLASH_MODEL } from '../src/decisions/adapters/clef'
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
  it('NaN probability is rejected by the port, not the adapter', async () => {
    const bad = { model: 'clef-flash-v1', answers: { stale: { type: 'choice', probabilities: { stale: 'x', active: 0.1 } } } }
    expect(await run(envWith(() => bad))).toMatchObject({ outcome: 'failed', reason: 'malformed_output' })
  })
  it('a real provider version is proposed with provenance', async () => {
    const r = await run(envWith(() => body('clef-flash-2026-11-01', 0.9)))
    expect(r).toMatchObject({ outcome: 'proposed', modelVersion: 'clef-flash-2026-11-01', model: CLEF_FLASH_MODEL })
  })
  it('selector-only echo (the recorded shape) has no version: malformed_output, nothing fabricated', async () => {
    expect(await run(envWith(() => body('clef-flash', 0.9)))).toMatchObject({ outcome: 'failed', reason: 'malformed_output' })
    expect(await run(envWith(() => body('clef', 0.9)))).toMatchObject({ outcome: 'failed', reason: 'malformed_output' })
    expect(await run(envWith(() => body('@cf/cloudflare/clef', 0.9)))).toMatchObject({ outcome: 'failed', reason: 'malformed_output' })
  })
})
