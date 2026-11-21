import { describe, expect, it } from 'vitest'
import { createClefAdapter, CLEF_FLASH_MODEL, CLEF_MODEL } from '../src/decisions/adapters/clef'
import { selectAdapter } from '../src/decisions/registry'
import type { DecisionRequest } from '../src/decisions/port'
import type { Env } from '../src/types'

const FLASH_BODY = {"model":"clef-flash","answers":{"stale":{"type":"choice","choice":"stale","probabilities":{"stale":0.9195,"active":0.0805},"confidence":0.7039}},"usage":{"input_tokens":157,"output_tokens":0}}
const CLEF_BODY = {"model":"clef","answers":{"stale":{"type":"choice","choice":"stale","probabilities":{"stale":0.9819,"active":0.0181},"confidence":0.929}},"usage":{"input_tokens":157,"output_tokens":0}}

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
const bodyFor = (m: string) => (m === CLEF_MODEL ? CLEF_BODY : FLASH_BODY)

describe('clef adapter (single call)', () => {
  it('default: one call to clef-flash with the clef-flash selector', async () => {
    const { env, calls } = envWith(bodyFor)
    const r = await createClefAdapter(env).decide(REQUEST, sig())
    expect(calls).toHaveLength(1)
    expect(calls[0].model).toBe(CLEF_FLASH_MODEL)
    expect(calls[0].input).toMatchObject({ model: 'clef-flash', state: 's' })
    expect(r).toMatchObject({ ok: true, model: CLEF_FLASH_MODEL, modelVersion: 'clef-flash', inputTokens: 157 })
  })

  it('CLEF_MODEL selects clef with the clef selector; never escalates', async () => {
    const { env, calls } = envWith(bodyFor, { CLEF_MODEL })
    const r = await createClefAdapter(env).decide(REQUEST, sig())
    expect(calls).toHaveLength(1)
    expect(calls[0].model).toBe(CLEF_MODEL)
    expect(calls[0].input).toMatchObject({ model: 'clef' })
    expect(r).toMatchObject({ ok: true, model: CLEF_MODEL })
  })

  it('CLEF_MODEL clef-flash selects clef-flash; low confidence does not escalate', async () => {
    const { env, calls } = envWith(bodyFor, { CLEF_MODEL: ` ${CLEF_FLASH_MODEL} ` })
    await createClefAdapter(env).decide(REQUEST, sig())
    expect(calls.map((c) => c.model)).toEqual([CLEF_FLASH_MODEL])
  })

  it('any other CLEF_MODEL fails closed with no call', async () => {
    for (const v of ['typesafe/jev', '@cf/cloudflare/clef-pro', 'clef', 'toString', '__proto__']) {
      const { env, calls } = envWith(bodyFor, { CLEF_MODEL: v })
      expect(await createClefAdapter(env).decide(REQUEST, sig())).toEqual({ ok: false, reason: 'adapter_unavailable' })
      expect(calls).toHaveLength(0)
    }
  })

  it('a throw returns adapter_error, no second call', async () => {
    const { env, calls } = envWith(() => new Error('boom'))
    expect(await createClefAdapter(env).decide(REQUEST, sig())).toEqual({ ok: false, reason: 'adapter_error' })
    expect(calls).toHaveLength(1)
  })

  it('malformed body returns malformed_output', async () => {
    const { env } = envWith(() => ({ nope: true }))
    expect(await createClefAdapter(env).decide(REQUEST, sig())).toEqual({ ok: false, reason: 'malformed_output' })
  })

  it('honours DECISION_GATEWAY_ID', async () => {
    const { env, calls } = envWith(bodyFor, { DECISION_GATEWAY_ID: ' gw1 ' })
    await createClefAdapter(env).decide(REQUEST, sig())
    expect(calls[0].options).toMatchObject({ gateway: { id: 'gw1' } })
  })

  it('no AI binding: adapter_unavailable', async () => {
    expect(await createClefAdapter({} as unknown as Env).decide(REQUEST, sig())).toEqual({ ok: false, reason: 'adapter_unavailable' })
  })

  it('bare selectors and @cf ids are aliases; policy is metadata-max', () => {
    const a = createClefAdapter({} as unknown as Env)
    for (const id of ['clef-flash', 'clef', CLEF_FLASH_MODEL, CLEF_MODEL]) expect(a.aliases).toContain(id)
    expect(a.dataPolicy.maxDataClass).toBe('metadata')
  })
})

describe('registry', () => {
  it('selects clef', () => expect(selectAdapter({ DECISION_ADAPTER: 'clef' } as unknown as Env).id).toBe('clef'))
  it('default is human', () => {
    expect(selectAdapter({} as unknown as Env).id).toBe('human')
    expect(selectAdapter({ DECISION_ADAPTER: 'bogus' } as unknown as Env).id).toBe('human')
  })
})
