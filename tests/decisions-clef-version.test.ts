// CLEF_MODEL_VERSION: operator-pinned date as the model version (stacked on the clef adapter).
import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { decide, type DecideConfig } from '../src/decisions/decide'
import { createClefAdapter, CLEF_FLASH_MODEL, CLEF_MODEL, isValidPinDate } from '../src/decisions/adapters/clef'
import type { DecisionRequest } from '../src/decisions/port'
import type { Env } from '../src/types'

const harnesses: SqliteD1Harness[] = []
afterEach(() => { while (harnesses.length) harnesses.pop()?.close() })

const REQUEST: DecisionRequest = {
  useCase: 't', criteriaVersion: 'v1', state: 's', dataClass: 'metadata',
  questions: { stale: { type: 'choice', instructions: 'i', criteria: { stale: 'a', active: 'b' } } },
}
const CONFIG = { thresholds: { stale: { minTopProbability: 0.6, minMargin: 0.2 } }, timeoutMs: 500 } satisfies DecideConfig
const body = (model: string) => ({ model, answers: { stale: { type: 'choice', choice: 'stale', probabilities: { stale: 0.9, active: 0.1 }, confidence: 0.9 } }, usage: { input_tokens: 1 } })

async function run(vars: Record<string, string>, reply: unknown) {
  const harness = createSqliteD1(); applyAllMigrations(harness.sqlite); harnesses.push(harness)
  const AI = { async run() { return reply } }
  const env = { DB: harness.db, AI, ...vars } as unknown as Env
  const result = await decide(env, REQUEST, { ...CONFIG, adapter: createClefAdapter(env) })
  const rows = harness.sqlite.prepare('SELECT model_version FROM decision_receipts').all() as { model_version: string }[]
  return { result, rows }
}

const MODELS = [
  { id: CLEF_FLASH_MODEL, selector: 'clef-flash' },
  { id: CLEF_MODEL, selector: 'clef' },
]

describe.each(MODELS)('clef version pin: $selector', ({ id, selector }) => {
  const vars = { CLEF_MODEL: id }
  it('valid pin + echo-only body is accepted; receipt records model@date', async () => {
    const { result, rows } = await run({ ...vars, CLEF_MODEL_VERSION: '2026-11-21' }, body(selector))
    expect(result).toMatchObject({ outcome: 'proposed', model: id, modelVersion: `${id}@2026-11-21` })
    expect(rows.map((r) => r.model_version)).toEqual([`${id}@2026-11-21`])
  })
  it('pin also applies when the body echoes the full @cf id or omits model', async () => {
    expect((await run({ ...vars, CLEF_MODEL_VERSION: '2026-11-21' }, body(id))).result).toMatchObject({ outcome: 'proposed' })
    const { model: _omit, ...noModel } = body(selector)
    expect((await run({ ...vars, CLEF_MODEL_VERSION: '2026-11-21' }, noModel)).result).toMatchObject({ outcome: 'proposed' })
  })
  it('no pin: rejected as malformed_output, nothing fabricated', async () => {
    expect((await run(vars, body(selector))).result).toMatchObject({ outcome: 'failed', reason: 'malformed_output' })
  })
  it.each(['', '2026-13-40', '2026-02-30', '2025-02-29', '2026-11-21 ', ' 2026-11-21', '2026-11-21\n', '2026-11-21T00:00:00Z', '2026-11-21x', '20261121', '2026-1-1', '02026-11-21', '２０２６-11-21'])(
    'invalid pin %j is rejected',
    async (pin) => {
      const { result, rows } = await run({ ...vars, CLEF_MODEL_VERSION: pin }, body(selector))
      expect(result).toMatchObject({ outcome: 'failed', reason: 'malformed_output' })
      expect(rows.every((r) => !String(r.model_version).includes('@'))).toBe(true)
    },
  )
  it('a real provider version wins over the pin', async () => {
    const { result } = await run({ ...vars, CLEF_MODEL_VERSION: '2026-11-21' }, body('clef-2026-10-01'))
    expect(result).toMatchObject({ outcome: 'proposed', modelVersion: 'clef-2026-10-01' })
  })
  it('a leap-day pin is a real date and is accepted', async () => {
    expect((await run({ ...vars, CLEF_MODEL_VERSION: '2028-02-29' }, body(selector))).result).toMatchObject({ modelVersion: `${id}@2028-02-29` })
  })
})

describe('isValidPinDate', () => {
  it('rejects non-strings', () => {
    for (const v of [undefined, null, 20261121, {}]) expect(isValidPinDate(v)).toBe(false)
  })
})
