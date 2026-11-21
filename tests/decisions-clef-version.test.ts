// CLEF_MODEL_VERSION: operator-pinned date as the model version (stacked on the clef adapter).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { decide, type DecideConfig } from '../src/decisions/decide'
import { createClefAdapter, CLEF_FLASH_MODEL, CLEF_MODEL, CLEF_ALIASES, isValidPinDate } from '../src/decisions/adapters/clef'
import type { DecisionRequest } from '../src/decisions/port'
import type { Env } from '../src/types'

const harnesses: SqliteD1Harness[] = []
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-21T12:00:00Z')) })
afterEach(() => { vi.useRealTimers(); while (harnesses.length) harnesses.pop()?.close() })

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
    expect(result).toMatchObject({ outcome: 'proposed', model: id, modelVersion: `${id}@pin:2026-11-21` })
    expect(rows.map((r) => r.model_version)).toEqual([`${id}@pin:2026-11-21`])
  })
  it('pin also applies when the body echoes the full @cf id or omits model', async () => {
    expect((await run({ ...vars, CLEF_MODEL_VERSION: '2026-11-21' }, body(id))).result).toMatchObject({ outcome: 'proposed' })
    const { model: _omit, ...noModel } = body(selector)
    expect((await run({ ...vars, CLEF_MODEL_VERSION: '2026-11-21' }, noModel)).result).toMatchObject({ outcome: 'proposed' })
  })
  it('no pin: rejected as malformed_output, nothing fabricated', async () => {
    expect((await run(vars, body(selector))).result).toMatchObject({ outcome: 'failed', reason: 'malformed_output' })
  })
  it.each(['', '2026-13-40', '2026-02-30', '2025-02-29', '2026-11-21 ', ' 2026-11-21', '2026-11-21\n', '2026-11-21T00:00:00Z', '2026-11-21x', '20261121', '2026-1-1', '02026-11-21', '２０２６-11-21', '2026-11-22', '9999-12-31', '0100-01-01', '0050-01-01', '2025-12-31'])(
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
  it('an in-range pin on a month end is accepted', async () => {
    expect((await run({ ...vars, CLEF_MODEL_VERSION: '2026-02-28' }, body(selector))).result).toMatchObject({ modelVersion: `${id}@pin:2026-02-28` })
  })
})

describe('isValidPinDate', () => {
  it('rejects non-strings', () => {
    for (const v of [undefined, null, 20261121, {}]) expect(isValidPinDate(v)).toBe(false)
  })
})

describe('pin rules', () => {
  const PIN = { CLEF_MODEL_VERSION: '2026-11-21' }
  it('today (UTC) is accepted, tomorrow is not', () => {
    expect(isValidPinDate('2026-11-21')).toBe(true)
    expect(isValidPinDate('2026-11-22')).toBe(false)
    expect(isValidPinDate('2026-01-01')).toBe(true)
    expect(isValidPinDate('2025-12-31')).toBe(false)
  })
  it('the date bound is evaluated at call time', async () => {
    vi.setSystemTime(new Date('2026-11-20T23:59:59Z'))
    expect((await run({ ...PIN }, body('clef-flash'))).result).toMatchObject({ outcome: 'failed' })
    vi.setSystemTime(new Date('2026-11-21T00:00:00Z'))
    expect((await run({ ...PIN }, body('clef-flash'))).result).toMatchObject({ outcome: 'proposed' })
  })
  it('unset CLEF_MODEL (default flash) takes the pin', async () => {
    const { result } = await run(PIN, body('clef-flash'))
    expect(result).toMatchObject({ outcome: 'proposed', model: CLEF_FLASH_MODEL, modelVersion: `${CLEF_FLASH_MODEL}@pin:2026-11-21` })
  })
  it('padded CLEF_MODEL takes the pin', async () => {
    const { result } = await run({ ...PIN, CLEF_MODEL: ` ${CLEF_MODEL} ` }, body('clef'))
    expect(result).toMatchObject({ outcome: 'proposed', modelVersion: `${CLEF_MODEL}@pin:2026-11-21` })
  })
  it('a padded own-selector echo gets the pin', async () => {
    const { result } = await run({ ...PIN }, body(' clef-flash '))
    expect(result).toMatchObject({ outcome: 'proposed', modelVersion: `${CLEF_FLASH_MODEL}@pin:2026-11-21` })
  })
  it('the other tier alias does not get the pin (both directions)', async () => {
    expect((await run({ ...PIN, CLEF_MODEL: CLEF_FLASH_MODEL }, body('clef'))).result).toMatchObject({ outcome: 'failed', reason: 'malformed_output' })
    expect((await run({ ...PIN, CLEF_MODEL: CLEF_MODEL }, body('clef-flash'))).result).toMatchObject({ outcome: 'failed', reason: 'malformed_output' })
    expect((await run({ ...PIN, CLEF_MODEL: CLEF_FLASH_MODEL }, body(CLEF_MODEL))).result).toMatchObject({ outcome: 'failed', reason: 'malformed_output' })
  })
  it('the pinned version carries the @pin: marker', async () => {
    const { rows } = await run(PIN, body('clef-flash'))
    expect(rows[0].model_version).toContain('@pin:')
  })
  it('the shared aliases array is frozen', () => {
    expect(Object.isFrozen(CLEF_ALIASES)).toBe(true)
    expect(Object.isFrozen(createClefAdapter({} as Env).aliases)).toBe(true)
  })
})
