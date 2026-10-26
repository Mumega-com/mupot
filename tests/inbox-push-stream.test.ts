import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInboxPushResponse } from '../src/agents/inbox-push-stream'
import type { StreamAuthorization } from '../src/agents/inbox-stream-auth'

class Socket extends EventTarget {
  closed = false
  close() { this.closed = true; this.dispatchEvent(new Event('close')) }
  hint(seq = 1) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'hint', id: `m${seq}`, seq }) })) }
}
const message = (seq: number) => ({ id: `m${seq}`, seq, from_agent: 'sender', kind: 'message', body: `body${seq}`, request_id: null, in_reply_to: null, created_at: '2026-10-25' })
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000) })
afterEach(() => vi.useRealTimers())
function setup(options: { validate?: () => Promise<StreamAuthorization>; count?: number } = {}) {
  const socket = new Socket(); let reads = 0; let auths = 0; let count = options.count ?? 0
  const response = createInboxPushResponse({
    socket, authenticatedAt: Date.now(), since: 0, jitterMs: 0,
    validate: async () => { auths++; return options.validate ? options.validate() : 'valid' },
    read: async since => { reads++; return { ok: true, messages: Array.from({ length: count }, (_, i) => message(i + 1)).filter(m => m.seq > since).slice(0, 100) } },
  })
  const reader = response.body!.getReader(); let text = ''; let done = false
  const pump = (async () => { for (;;) { const r = await reader.read(); if (r.done) { done = true; return } text += new TextDecoder().decode(r.value) } })()
  return { socket, reader, pump, setCount: (n: number) => { count = n }, reads: () => reads, auths: () => auths, text: () => text, done: () => done }
}
describe('push stream lifecycle', () => {
  it.each(['timeout', 'cancel'] as const)('disposes a renewal socket returned after %s', async mode => {
    let resolve!: (s: Socket) => void
    const original = new Socket(); const late = new Socket()
    const r = createInboxPushResponse({ socket: original, authenticatedAt: Date.now(), since: 0,
      validate: async () => 'valid', read: async () => ({ ok: true, messages: [] }),
      renewSocket: () => new Promise(r => { resolve = r }) })
    const reader = r.body!.getReader(); await reader.read()
    await vi.advanceTimersByTimeAsync(840_001)
    if (mode === 'cancel') await reader.cancel()
    else await vi.advanceTimersByTimeAsync(5001)
    resolve(late); await vi.advanceTimersByTimeAsync(1)
    expect(original.closed).toBe(true); expect(late.closed).toBe(true)
  })
  it('observer renewal cannot insert an extra recovery read between 300s cycles', async () => {
    const times: number[] = []; const start = Date.now()
    const r = createInboxPushResponse({ socket: new Socket(), renewSocket: async () => new Socket(), authenticatedAt: start, since: 0, jitterMs: 0,
      validate: async () => 'valid', read: async () => { times.push(Date.now() - start); return { ok: true, messages: [] } } })
    await vi.advanceTimersByTimeAsync(910_000)
    expect(times).toHaveLength(4)
    expect(times[2]).toBeGreaterThanOrEqual(times[1] + 300_000)
    expect(times[3]).toBeGreaterThanOrEqual(times[2] + 300_000)
    await r.body!.cancel()
  })
  it('closes after a failed read instead of turning auth refresh into inbox polling', async () => {
    const socket = new Socket(); let reads = 0
    const r = createInboxPushResponse({ socket, authenticatedAt: Date.now(), since: 0, validate: async () => 'valid', read: async () => { reads++; return { ok: false } } })
    const reader = r.body!.getReader(); await reader.read()
    await vi.advanceTimersByTimeAsync(100)
    expect(socket.closed).toBe(true)
    await vi.advanceTimersByTimeAsync(90_000)
    expect(reads).toBe(1); expect((await reader.read()).done).toBe(true)
  })
  it('has one connect read, no fast idle polling, and one bounded 300s resync cycle', async () => {
    const s = setup(); await vi.advanceTimersByTimeAsync(299_999)
    expect(s.reads()).toBe(1); expect(s.auths()).toBe(6)
    await vi.advanceTimersByTimeAsync(21) // scheduled resync queues its async read on the next turn
    expect(s.reads()).toBe(2)
    await s.reader.cancel(); await s.pump
    expect(s.socket.closed).toBe(true)
    const reads = s.reads(); await vi.advanceTimersByTimeAsync(600_000); expect(s.reads()).toBe(reads)
  })
  it('delivers a coalesced burst through existing body frames and SSE cursors', async () => {
    const s = setup(); await vi.advanceTimersByTimeAsync(1)
    s.setCount(151); for (let i = 0; i < 151; i++) s.socket.hint(i + 1)
    await vi.advanceTimersByTimeAsync(100)
    expect(s.reads()).toBe(3)
    expect(s.text()).toContain('id: 151\n')
    expect(s.text()).toContain('"body":"body151"')
    expect(s.text()).not.toContain('"type":"hint"')
    expect(s.text().match(/"id":"m1"/g)).toHaveLength(1)
    await s.reader.cancel()
  })
  it.each(['invalid', 'error', 'hang'] as const)('closes within 60s when scheduled auth returns %s', async kind => {
    const s = setup({ validate: async () => kind === 'hang' ? new Promise(() => {}) : kind })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(s.done()).toBe(true); expect(s.socket.closed).toBe(true)
    expect(s.auths()).toBe(kind === 'invalid' ? 1 : 3)
  })
  it('does not let a timed-out result renew or deliver after the hard deadline', async () => {
    let resolve!: (r: StreamAuthorization) => void
    const s = setup({ validate: () => new Promise(r => { resolve = r }) })
    await vi.advanceTimersByTimeAsync(60_000)
    resolve('valid'); await vi.advanceTimersByTimeAsync(1)
    s.setCount(1); s.socket.hint(); await vi.advanceTimersByTimeAsync(100)
    expect(s.done()).toBe(true); expect(s.text()).not.toContain('body1')
  })
  it('checks auth before disclosing a new body when the cached proof is older than 10s', async () => {
    const s = setup({ validate: async () => 'invalid' })
    await vi.advanceTimersByTimeAsync(11_000); s.setCount(1); s.socket.hint()
    await vi.advanceTimersByTimeAsync(100)
    expect(s.text()).not.toContain('body1'); expect(s.done()).toBe(true)
  })
  it('bounds a recovery cycle to ten pages and closes with the last delivered cursor', async () => {
    const s = setup({ count: 1001 }); await vi.advanceTimersByTimeAsync(100)
    expect(s.reads()).toBe(10); expect(s.done()).toBe(true)
    expect(s.text()).toContain('id: 1000\n')
    expect(s.text()).not.toContain('body1001')
  })
  it('rejects already stale connect authorization without reading any mail', async () => {
    let reads = 0; const socket = new Socket()
    const r = createInboxPushResponse({ socket, authenticatedAt: Date.now() - 60_000, since: 0, validate: async () => 'valid', read: async () => { reads++; return { ok: true, messages: [] } } })
    expect((await r.body!.getReader().read()).done).toBe(true)
    expect(reads).toBe(0); expect(socket.closed).toBe(true)
  })
  it('coalesces hints arriving during a read and never reads concurrently', async () => {
    let finish!: (r: { ok: boolean; messages: ReturnType<typeof message>[] }) => void
    let reads = 0; const socket = new Socket()
    const r = createInboxPushResponse({ socket, authenticatedAt: Date.now(), since: 0, validate: async () => 'valid',
      read: async () => { reads++; return reads === 1 ? new Promise(resolve => { finish = resolve }) : { ok: true, messages: [message(1)] } } })
    const reader = r.body!.getReader(); await reader.read()
    await vi.advanceTimersByTimeAsync(1)
    for (let i = 0; i < 100; i++) socket.hint()
    await vi.advanceTimersByTimeAsync(30); expect(reads).toBe(1)
    finish({ ok: true, messages: [] }); await vi.advanceTimersByTimeAsync(30)
    expect(reads).toBe(2)
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('body1')
    await reader.cancel(); expect(vi.getTimerCount()).toBe(0)
  })
  it('cancels a pending read without allowing its later result to enqueue', async () => {
    let finish!: (r: { ok: boolean; messages: ReturnType<typeof message>[] }) => void
    const socket = new Socket()
    const r = createInboxPushResponse({ socket, authenticatedAt: Date.now(), since: 0, validate: async () => 'valid', read: () => new Promise(resolve => { finish = resolve }) })
    const reader = r.body!.getReader(); await reader.read(); await vi.advanceTimersByTimeAsync(1)
    await reader.cancel(); finish({ ok: true, messages: [message(1)] }); await vi.advanceTimersByTimeAsync(10)
    expect(socket.closed).toBe(true); expect(vi.getTimerCount()).toBe(0)
    expect((await reader.read()).done).toBe(true)
  })
  it('makes progress on a page whose aggregate initial payload exceeds the buffer cap', async () => {
    const socket = new Socket()
    const rows = Array.from({ length: 100 }, (_, i) => ({ ...message(i + 1), body: 'x'.repeat(8192) }))
    const r = createInboxPushResponse({ socket, authenticatedAt: Date.now(), since: 0, validate: async () => 'valid', read: async since => ({ ok: true, messages: rows.filter(m => m.seq > since) }) })
    const reader = r.body!.getReader(); let text = ''
    const pump = (async () => { for (;;) { const part = await reader.read(); if (part.done) return; text += new TextDecoder().decode(part.value) } })()
    await vi.advanceTimersByTimeAsync(100)
    expect(text).toContain('id: 100\n')
    await reader.cancel(); await pump
  })
})
