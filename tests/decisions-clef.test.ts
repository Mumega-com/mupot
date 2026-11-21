import { describe, expect, it } from 'vitest'
import { createClefAdapter, CLEF_FLASH_MODEL, CLEF_MODEL, CLEF_ESCALATION_THRESHOLD } from '../src/decisions/adapters/clef'
import { selectAdapter } from '../src/decisions/registry'
import type { DecisionRequest } from '../src/decisions/port'
import type { Env } from '../src/types'

const FLASH_BODY = {"model":"clef-flash","answers":{"stale":{"type":"choice","choice":"stale","probabilities":{"stale":0.9195,"active":0.0805},"confidence":0.7039}},"usage":{"input_tokens":157,"output_tokens":0}}
const CLEF_BODY = {"model":"clef","answers":{"stale":{"type":"choice","choice":"stale","probabilities":{"stale":0.9819,"active":0.0181},"confidence":0.929}},"usage":{"input_tokens":157,"output_tokens":0}}
const HIGH_FLASH = { ...FLASH_BODY, answers: { stale: { ...FLASH_BODY.answers.stale, confidence: 0.9 } } }

const REQUEST: DecisionRequest = {
  useCase: 't', criteriaVersion: 'v1', state: 's', dataClass: 'metadata',
  questions: { stale: { type: 'choice', instructions: 'i', criteria: { stale: 'a', active: 'b' } } },
}

interface Call { model: string; input: Record<string, unknown>; options: Record<string, unknown> }
function envWith(handler: (model: string) => unknown, extra: Partial<Env> = {}) {
  const calls: Call[] = []
  const AI = {
    async run(model: string, input: Record<string, unknown>, options: Record<string, unknown>) {
      calls.push({ model, input, options })
      const r = handler(model)
      if (r instanceof Error) throw r
      return r
    },
  }
  return { env: { AI, ...extra } as unknown as Env, calls }
}
const sig = () => new AbortController().signal

describe('clef adapter', () => {
  it('threshold is 0.75', () => expect(CLEF_ESCALATION_THRESHOLD).toBe(0.75))

  it('high confidence: clef-flash only', async () => {
    const { env, calls } = envWith(() => HIGH_FLASH)
    const r = await createClefAdapter(env).decide(REQUEST, sig())
    expect(calls.map((c) => c.model)).toEqual([CLEF_FLASH_MODEL])
    expect(r).toMatchObject({ ok: true, model: CLEF_FLASH_MODEL, modelVersion: 'clef-flash', inputTokens: 157 })
  })

  it('low confidence (0.7039) escalates to clef and names clef', async () => {
    const { env, calls } = envWith((m) => (m === CLEF_FLASH_MODEL ? FLASH_BODY : CLEF_BODY))
    const r = await createClefAdapter(env).decide(REQUEST, sig())
    expect(calls.map((c) => c.model)).toEqual([CLEF_FLASH_MODEL, CLEF_MODEL])
    expect(r).toMatchObject({ ok: true, model: CLEF_MODEL, modelVersion: 'clef' })
  })

  it('confidence exactly at threshold does not escalate', async () => {
    const body = { ...FLASH_BODY, answers: { stale: { ...FLASH_BODY.answers.stale, confidence: CLEF_ESCALATION_THRESHOLD } } }
    const { env, calls } = envWith(() => body)
    await createClefAdapter(env).decide(REQUEST, sig())
    expect(calls).toHaveLength(1)
  })

  it('missing confidence escalates', async () => {
    const body = { model: 'clef-flash', answers: { stale: { type: 'choice', probabilities: { stale: 0.9, active: 0.1 } } } }
    const { env, calls } = envWith((m) => (m === CLEF_FLASH_MODEL ? body : CLEF_BODY))
    await createClefAdapter(env).decide(REQUEST, sig())
    expect(calls).toHaveLength(2)
  })

  it('clef-flash throws: falls back to clef', async () => {
    const { env, calls } = envWith((m) => (m === CLEF_FLASH_MODEL ? new Error('boom') : CLEF_BODY))
    const r = await createClefAdapter(env).decide(REQUEST, sig())
    expect(calls.map((c) => c.model)).toEqual([CLEF_FLASH_MODEL, CLEF_MODEL])
    expect(r).toMatchObject({ ok: true, model: CLEF_MODEL })
  })

  it('both throw: ok:false, no throw', async () => {
    const { env, calls } = envWith(() => new Error('down'))
    const r = await createClefAdapter(env).decide(REQUEST, sig())
    expect(r).toEqual({ ok: false, reason: 'adapter_error' })
    expect(calls).toHaveLength(2)
  })

  it('low-confidence flash, clef throws: keeps the flash answer', async () => {
    const { env } = envWith((m) => (m === CLEF_FLASH_MODEL ? FLASH_BODY : new Error('x')))
    const r = await createClefAdapter(env).decide(REQUEST, sig())
    expect(r).toMatchObject({ ok: true, model: CLEF_FLASH_MODEL })
  })

  it('sends the model selector for each tier', async () => {
    const { env, calls } = envWith((m) => (m === CLEF_FLASH_MODEL ? FLASH_BODY : CLEF_BODY))
    await createClefAdapter(env).decide(REQUEST, sig())
    expect(calls[0].input).toMatchObject({ model: 'clef-flash', state: 's' })
    expect(calls[1].input).toMatchObject({ model: 'clef' })
  })

  it('honours DECISION_GATEWAY_ID', async () => {
    const { env, calls } = envWith(() => HIGH_FLASH, { DECISION_GATEWAY_ID: ' gw1 ' })
    await createClefAdapter(env).decide(REQUEST, sig())
    expect(calls[0].options).toMatchObject({ gateway: { id: 'gw1' } })
  })

  it('malformed output returns malformed_output', async () => {
    const { env } = envWith(() => ({ nope: true }))
    expect(await createClefAdapter(env).decide(REQUEST, sig())).toEqual({ ok: false, reason: 'malformed_output' })
  })

  it('no AI binding: adapter_unavailable', async () => {
    expect(await createClefAdapter({} as unknown as Env).decide(REQUEST, sig())).toEqual({ ok: false, reason: 'adapter_unavailable' })
  })

  it('policy is metadata-max', () => {
    expect(createClefAdapter({} as unknown as Env).dataPolicy.maxDataClass).toBe('metadata')
  })
})

describe('clef adapter: validity, aliases, provenance (round 2)', () => {
  const nanFlash = { ...FLASH_BODY, answers: { stale: { ...FLASH_BODY.answers.stale, confidence: 0.9, probabilities: { stale: 'x', active: 0.1 } } } }
  const badChoice = { ...HIGH_FLASH, answers: { stale: { ...HIGH_FLASH.answers.stale, choice: 'bogus' } } }
  const badSum = { ...HIGH_FLASH, answers: { stale: { ...HIGH_FLASH.answers.stale, probabilities: { stale: 0.3, active: 0.1 } } } }

  for (const [label, bad] of [['non-numeric probability', nanFlash], ['choice outside options', badChoice], ['probabilities do not sum to 1', badSum]] as const) {
    it(`invalid flash (${label}) at confidence 0.9 escalates to clef as fallback`, async () => {
      const { env, calls } = envWith((m) => (m === CLEF_FLASH_MODEL ? bad : CLEF_BODY))
      const r = await createClefAdapter(env).decide(REQUEST, sig())
      expect(calls.map((c) => c.model)).toEqual([CLEF_FLASH_MODEL, CLEF_MODEL])
      expect(r).toMatchObject({ ok: true, model: CLEF_MODEL, provenance: { tier: CLEF_MODEL, path: 'fallback', providerConfidence: 0.929 } })
    })
  }

  it('out-of-range or non-finite confidence fails closed and escalates', async () => {
    for (const c of [1.5, -0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const body = { ...HIGH_FLASH, answers: { stale: { ...HIGH_FLASH.answers.stale, confidence: c } } }
      const { env, calls } = envWith((m) => (m === CLEF_FLASH_MODEL ? body : CLEF_BODY))
      await createClefAdapter(env).decide(REQUEST, sig())
      expect(calls).toHaveLength(2)
    }
  })

  it('bare selectors and @cf ids are aliases', () => {
    const a = createClefAdapter({} as unknown as Env).aliases ?? []
    for (const id of ['clef-flash', 'clef', CLEF_FLASH_MODEL, CLEF_MODEL]) expect(a).toContain(id)
  })

  it('aborted + malformed flash reports malformed_output, not timeout', async () => {
    const ac = new AbortController()
    const { env, calls } = envWith(() => { ac.abort(); return { nope: true } })
    expect(await createClefAdapter(env).decide(REQUEST, ac.signal)).toEqual({ ok: false, reason: 'malformed_output' })
    expect(calls).toHaveLength(1)
  })

  it('aborted + parsed-but-invalid flash reports malformed_output, not timeout', async () => {
    const ac = new AbortController()
    const { env, calls } = envWith(() => { ac.abort(); return nanFlash })
    expect(await createClefAdapter(env).decide(REQUEST, ac.signal)).toEqual({ ok: false, reason: 'malformed_output' })
    expect(calls).toHaveLength(1)
  })

  it('aborted + flash throws reports adapter_error', async () => {
    const ac = new AbortController()
    const { env } = envWith(() => { ac.abort(); return new Error('x') })
    expect(await createClefAdapter(env).decide(REQUEST, ac.signal)).toEqual({ ok: false, reason: 'adapter_error' })
  })

  it('direct and degraded provenance', async () => {
    const a = envWith(() => HIGH_FLASH)
    expect(await createClefAdapter(a.env).decide(REQUEST, sig())).toMatchObject({ provenance: { tier: CLEF_FLASH_MODEL, path: 'direct', providerConfidence: 0.9 } })
    const b = envWith((m) => (m === CLEF_FLASH_MODEL ? FLASH_BODY : new Error('x')))
    expect(await createClefAdapter(b.env).decide(REQUEST, sig())).toMatchObject({ provenance: { tier: CLEF_FLASH_MODEL, path: 'degraded', providerConfidence: 0.7039 } })
  })
})

describe('registry', () => {
  it('selects clef', () => expect(selectAdapter({ DECISION_ADAPTER: 'clef' } as unknown as Env).id).toBe('clef'))
  it('default is human', () => {
    expect(selectAdapter({} as unknown as Env).id).toBe('human')
    expect(selectAdapter({ DECISION_ADAPTER: 'bogus' } as unknown as Env).id).toBe('human')
  })
})
