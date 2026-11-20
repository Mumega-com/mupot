import { describe, it, expect } from 'vitest'
import { createModel } from '../src/model'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import type { Env } from '../src/types'

// Real D1 (migration chain) so getSetting() actually executes SQL; only the
// Workers AI runtime binding is mocked (it is not SQL).
const makeEnv = (run: (...args: any[]) => unknown) => {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  const env = {
    DB: harness.db,
    TENANT_SLUG: 'mumega',
    AI: { run },
  } as unknown as Env
  return { harness, env }
}

const msgs = [{ role: 'user' as const, content: 'hi' }]

describe('createModel Workers AI fallback — stream/response shape normalization', () => {
  it('returns a plain string response', async () => {
    const { harness, env } = makeEnv(async () => 'hello')
    try {
      expect(await createModel(env).chat(msgs)).toBe('hello')
    } finally {
      harness.close()
    }
  })

  it('returns the string from { response: string }', async () => {
    const { harness, env } = makeEnv(async () => ({ response: 'hello' }))
    try {
      expect(await createModel(env).chat(msgs)).toBe('hello')
    } finally {
      harness.close()
    }
  })

  it('joins { response: [chunk objects] } (the raw2.indexOf array drift)', async () => {
    const { harness, env } = makeEnv(async () => ({
      response: [{ response: '{"a":' }, { response: '1}' }],
    }))
    try {
      expect(await createModel(env).chat(msgs)).toBe('{"a":1}')
    } finally {
      harness.close()
    }
  })

  it('joins { response: [strings] }', async () => {
    const { harness, env } = makeEnv(async () => ({ response: ['a', 'b', 'c'] }))
    try {
      expect(await createModel(env).chat(msgs)).toBe('abc')
    } finally {
      harness.close()
    }
  })

  it('reads a ReadableStream of chunks', async () => {
    const { harness, env } = makeEnv(async () =>
      new ReadableStream<{ response: string }>({
        start(c) {
          c.enqueue({ response: 'x' })
          c.enqueue({ response: 'y' })
          c.close()
        },
      }),
    )
    try {
      expect(await createModel(env).chat(msgs)).toBe('xy')
    } finally {
      harness.close()
    }
  })

  it('returns empty for a non-string scalar response (never leaks/crashes)', async () => {
    const { harness, env } = makeEnv(async () => ({ response: 42 }))
    try {
      expect(await createModel(env).chat(msgs)).toBe('')
    } finally {
      harness.close()
    }
  })

  it('passes stream:false + max_tokens to ai.run and reports usage', async () => {
    let seen: any = null
    const { harness, env } = makeEnv(async (_model: unknown, input: any) => {
      seen = input
      return { response: 'ok', usage: { prompt_tokens: 10, completion_tokens: 5 } }
    })
    try {
      const res = await createModel(env).chatWithUsage!(msgs, { maxTokens: 256 })
      expect(seen.stream).toBe(false)
      expect(seen.max_tokens).toBe(256)
      expect(res.text).toBe('ok')
      expect(res.usage).toEqual({ input: 10, output: 5 })
    } finally {
      harness.close()
    }
  })
})

describe('Workers AI default model, OpenAI-shape parsing, env override', () => {
  const capture = (resp: unknown) => {
    const calls: Array<{ model: string; input: { max_tokens?: number } }> = []
    const run = async (model: string, input: { max_tokens?: number }) => {
      calls.push({ model, input })
      return resp
    }
    return { run, calls }
  }
  const chatOnce = async (resp: unknown, extra: Partial<Env> = {}) => {
    const { run, calls } = capture(resp)
    const { harness, env } = makeEnv(run)
    try {
      const text = await createModel({ ...env, ...extra } as Env).chat(msgs)
      return { text, calls }
    } finally {
      harness.close()
    }
  }

  it('parses choices[0].message.content', async () => {
    const r = await chatOnce({ choices: [{ message: { role: 'assistant', content: 'answer' } }], usage: { prompt_tokens: 3, completion_tokens: 4 } })
    expect(r.text).toBe('answer')
  })

  it('excludes reasoning_content / reasoning from the returned text', async () => {
    const r = await chatOnce({ choices: [{ message: { content: 'final', reasoning_content: 'SECRET-COT', reasoning: 'SECRET-COT2' } }] })
    expect(r.text).toBe('final')
    expect(r.text).not.toContain('SECRET-COT')
  })

  it('returns "" when only reasoning is present (no content)', async () => {
    expect((await chatOnce({ choices: [{ message: { content: null, reasoning_content: 'thinking' } }] })).text).toBe('')
  })

  it('returns "" for empty / garbage responses', async () => {
    expect((await chatOnce({ choices: [] })).text).toBe('')
    expect((await chatOnce({ choices: [{ message: { content: 42 } }] })).text).toBe('')
    expect((await chatOnce({ choices: 'x', response: 7 })).text).toBe('')
    expect((await chatOnce(null)).text).toBe('')
  })

  it('legacy { response } still wins when no choices', async () => {
    expect((await chatOnce({ response: 'legacy' })).text).toBe('legacy')
  })

  it('reports usage from the choices shape', async () => {
    const { run } = capture({ choices: [{ message: { content: 'a' } }], usage: { prompt_tokens: 3, completion_tokens: 4 } })
    const { harness, env } = makeEnv(run)
    try {
      const r = await createModel(env).chatWithUsage!(msgs)
      expect(r.usage).toEqual({ input: 3, output: 4 })
    } finally {
      harness.close()
    }
  })

  it('defaults to DeepSeek V4.1 Flash with a 2048 token budget', async () => {
    const r = await chatOnce({ response: 'x' })
    expect(r.calls[0].model).toBe('@cf/deepseek-ai/deepseek-v4.1-flash-1017')
    expect(r.calls[0].input.max_tokens).toBe(2048)
  })

  it('honours WORKERS_AI_CHAT_MODEL only when it starts with @cf/', async () => {
    const ok = await chatOnce({ response: 'x' }, { WORKERS_AI_CHAT_MODEL: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' })
    expect(ok.calls[0].model).toBe('@cf/meta/llama-3.3-70b-instruct-fp8-fast')
    const bad = await chatOnce({ response: 'x' }, { WORKERS_AI_CHAT_MODEL: 'gpt-4o' })
    expect(bad.calls[0].model).toBe('@cf/deepseek-ai/deepseek-v4.1-flash-1017')
  })
})
