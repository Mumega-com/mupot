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
