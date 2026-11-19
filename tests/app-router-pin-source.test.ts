// mupot#2395 — Node-pool companion to tests/composition/app-router-pin.test.ts.
// Composition proves the live `app` instance; this file proves the pin is in
// source so a SmartRouter regression cannot slip past a composition skip.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { TrieRouter } from 'hono/router/trie-router'

describe('mupot#2395 TrieRouter pin (source + runtime shape)', () => {
  it('src/index.ts constructs the root app with an explicit TrieRouter', () => {
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/import\s+\{\s*TrieRouter\s*\}\s+from\s+['"]hono\/router\/trie-router['"]/)
    expect(src).toMatch(/new Hono<[^>]*>\(\s*\{\s*router:\s*new TrieRouter\(\)\s*\}\s*\)/)
  })

  it('new Hono({ router: new TrieRouter() }) reports TrieRouter at runtime', () => {
    const pinned = new Hono({ router: new TrieRouter() })
    expect(pinned.router).toBeInstanceOf(TrieRouter)
    expect(pinned.router.name).toBe('TrieRouter')
  })
})
