import { describe, it, expect } from 'vitest'
import { createModel } from '../src/model'
import type { Env } from '../src/types'

// getSetting() needs a DB.prepare().bind().first() chain that resolves to null
// (no org_settings → no provider → Workers AI fallback).
const makeEnv = (run: (...args: any[]) => unknown) =>
  ({
    DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) },
    AI: { run },
  }) as unknown as Env

const msgs = [{ role: 'user' as const, content: 'hi' }]

describe('createModel Workers AI fallback — stream/response shape normalization', () => {
  it('returns a plain string response', async () => {
    const env = makeEnv(async () => 'hello')
    expect(await createModel(env).chat(msgs)).toBe('hello')
  })

  it('returns the string from { response: string }', async () => {
    const env = makeEnv(async () => ({ response: 'hello' }))
    expect(await createModel(env).chat(msgs)).toBe('hello')
  })

  it('joins { response: [chunk objects] } (the raw2.indexOf array drift)', async () => {
    const env = makeEnv(async () => ({
      response: [{ response: '{"a":' }, { response: '1}' }],
    }))
    expect(await createModel(env).chat(msgs)).toBe('{"a":1}')
  })

  it('joins { response: [strings] }', async () => {
    const env = makeEnv(async () => ({ response: ['a', 'b', 'c'] }))
    expect(await createModel(env).chat(msgs)).toBe('abc')
  })

  it('reads a ReadableStream of chunks', async () => {
    const env = makeEnv(async () =>
      new ReadableStream<{ response: string }>({
        start(c) {
          c.enqueue({ response: 'x' })
          c.enqueue({ response: 'y' })
          c.close()
        },
      }),
    )
    expect(await createModel(env).chat(msgs)).toBe('xy')
  })

  it('returns empty for a non-string scalar response (never leaks/crashes)', async () => {
    const env = makeEnv(async () => ({ response: 42 }))
    expect(await createModel(env).chat(msgs)).toBe('')
  })

  it('passes stream:false + max_tokens to ai.run and reports usage', async () => {
    let seen: any = null
    const env = makeEnv(async (_model: unknown, input: any) => {
      seen = input
      return { response: 'ok', usage: { prompt_tokens: 10, completion_tokens: 5 } }
    })
    const res = await createModel(env).chatWithUsage!(msgs, { maxTokens: 256 })
    expect(seen.stream).toBe(false)
    expect(seen.max_tokens).toBe(256)
    expect(res.text).toBe('ok')
    expect(res.usage).toEqual({ input: 10, output: 5 })
  })
})
