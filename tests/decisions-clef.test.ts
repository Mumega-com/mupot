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

describe('registry', () => {
  it('selects clef', () => expect(selectAdapter({ DECISION_ADAPTER: 'clef' } as unknown as Env).id).toBe('clef'))
  it('default is human', () => {
    expect(selectAdapter({} as unknown as Env).id).toBe('human')
    expect(selectAdapter({ DECISION_ADAPTER: 'bogus' } as unknown as Env).id).toBe('human')
  })
})
