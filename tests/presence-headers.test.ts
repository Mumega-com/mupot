// presence-headers.test.ts — /auth/presence must protect its token-in-query like
// /auth/handoff does (#162 B2, Codex auth-gate blocker): no-referrer + no-store.
// The no-token path returns 401 BEFORE touching env, so we can assert headers
// without binding KV/keys.

import { describe, expect, it } from 'vitest'
import { authApp } from '../src/auth/index'

describe('/auth/presence security headers', () => {
  it('sets Referrer-Policy: no-referrer and Cache-Control: no-store on the 401 path', async () => {
    const res = await authApp.request('/presence')
    expect(res.status).toBe(401)
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })
})
