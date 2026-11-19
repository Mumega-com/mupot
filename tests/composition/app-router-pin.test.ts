// mupot#2395 — the root Hono app must pin TrieRouter. SmartRouter used to fall
// back to TrieRouter only because RegExpRouter rejected
// POST /auth/link-signin/:id/unlink; that accidental choice is now explicit.
import { describe, expect, it } from 'vitest'
import { TrieRouter } from 'hono/router/trie-router'
import { app } from '../../src/index'

describe('mupot#2395 root app router pin', () => {
  it('uses TrieRouter (not SmartRouter fallback)', () => {
    expect(app.router).toBeInstanceOf(TrieRouter)
    expect(app.router.name).toBe('TrieRouter')
  })
})
