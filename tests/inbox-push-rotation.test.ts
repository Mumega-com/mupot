import { afterEach, expect, it, vi } from 'vitest'
import { createInboxPushResponse } from '../src/agents/inbox-push-stream'
// @ts-expect-error vendored JavaScript client deliberately remains unmodified
import { seatlinkSseFixture } from './fixtures/seatlink-bridge/open-inbox-stream.mjs'

class Socket extends EventTarget { readyState = 1; close() { this.readyState = 3 } }
afterEach(() => vi.useRealTimers())
it('the actual seatlink SSE parser resumes after server rotation using its saved since cursor', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000)
  const urls: string[] = []; const handled: number[] = []; const cursors: Record<string, number> = {}
  const stop = new AbortController()
  const open = seatlinkSseFixture({
    readTokenPath: () => 'test-token', log: () => {}, seatMupotConfig: new Map(), CURSOR_FILE: 'memory-only',
    readJson: () => cursors, writeJson: (_p: string, data: Record<string, number>) => Object.assign(cursors, data),
    isPaperclipSeat: () => false, paperclipHandler: {},
    injectPotMail: async (_seat: string, m: { seq: number }) => { handled.push(m.seq) },
    routeMail: async (_entry: unknown, m: { seq: number }) => { handled.push(m.seq) },
    setTimeout,
    fetch: async (url: string) => {
      urls.push(url)
      if (urls.length > 2) return new Promise(() => {}) // fixture owns no host/network work
      const since = Number(new URL(url).searchParams.get('since') ?? 0)
      const newest = urls.length
      return createInboxPushResponse({
        socket: new Socket(), renewSocket: async () => new Socket(),
        authenticatedAt: Date.now(), since, signal: stop.signal, jitterMs: 0,
        validate: async () => 'valid',
        read: async cursor => ({ ok: true, messages: newest > cursor ? [{ seq: newest, id: `m${newest}`, body: 'work', from_agent: 'sender', kind: 'message', request_id: null, in_reply_to: null, created_at: 'now' }] : [] }),
      })
    },
  })
  await open({ herdr: 'dev', mupot_token_file: 'fixture' }, 'https://pot.test')
  await vi.advanceTimersByTimeAsync(20)
  expect(handled).toEqual([1]); expect(cursors.dev).toBe(1)
  await vi.advanceTimersByTimeAsync(30 * 60_000)
  expect(urls[1]).toContain('&since=1')
  expect(handled).toEqual([1, 2]); expect(cursors.dev).toBe(2)
  stop.abort(); await vi.advanceTimersByTimeAsync(1)
})
