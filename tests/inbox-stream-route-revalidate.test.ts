// Route-level: the REAL revalidate closure in GET /api/inbox/stream (not an injected stub) ends the stream
// when the token is revoked. Only resolveMemberByToken is mocked (the token store); the route + closure are real.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import type { Env } from '../src/types'

let tokenLive = true
vi.mock('../src/auth/member-bearer', () => ({
  bearerToken: (h?: string) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
  resolveMemberByToken: async (_env: unknown, token: string | null) =>
    token === 'tok' && tokenLive ? { tokenId: 'tid', memberId: 'm1', displayName: 'x', email: null, boundAgentId: 'ag-r' } : null,
}))
const { inboxApp } = await import('../src/agents/inbox-routes')

let harness: SqliteD1Harness
beforeEach(() => { harness = createSqliteD1(); applyAllMigrations(harness.sqlite); tokenLive = true; vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); harness.close() })

describe('stream route revalidate closure', () => {
  it('revoked token: the real closure ends the stream and the late message body is never sent', async () => {
    const env = { DB: harness.db, TENANT_SLUG: 'mumega' } as unknown as Env
    const res = await inboxApp.request('/stream?poll_ms=5000', { headers: { authorization: 'Bearer tok' } }, env)
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let text = ''
    let done = false
    const pump = (async () => { for (;;) { const r = await reader.read(); if (r.done) { done = true; return } text += dec.decode(r.value) } })()
    await vi.advanceTimersByTimeAsync(6000) // one idle tick
    tokenLive = false
    await harness.db.prepare(
      `INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, kind, body, created_at)
       VALUES ('m1', 'mumega', 'ag-r', 'ag-s', 'mem-s', 'message', 'secret body', datetime('now'))`,
    ).run()
    await vi.advanceTimersByTimeAsync(6000)
    await pump
    expect(done).toBe(true)
    expect(text).not.toContain('secret body')
  })
})
