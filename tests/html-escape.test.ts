import { describe, expect, it } from 'vitest'
import { escapeHtml } from '../src/lib/html-escape'

// mupot#981: one shared HTML escaper. The per-file copies omitted the single quote, which
// is the attribute-breakout character for any single-quoted attribute.
describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;')
  })

  it('escapes ampersand first so entities are not double-decoded into markup', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;')
  })

  it('neutralises script, attribute-breakout and URL payloads', () => {
    const payloads = [
      '<script>alert(1)</script>',
      `" onmouseover="alert(1)`,
      `' onmouseover='alert(1)`,
      'javascript:alert(1)',
      '</code><img src=x onerror=alert(1)>',
    ]
    for (const p of payloads) {
      const out = escapeHtml(p)
      expect(out).not.toMatch(/[<>"']/)
    }
  })

  it('leaves safe text unchanged', () => {
    expect(escapeHtml('growth-lead 42')).toBe('growth-lead 42')
  })
})
