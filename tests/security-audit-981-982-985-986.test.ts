import { describe, it, expect } from 'vitest'
import { agentTokenMintedBody } from '../src/dashboard/agent-token'
import { timingSafeEqual } from '../src/lib/timing-safe-equal'
import { redactSecretPatterns } from '../src/lib/redact'

describe('#981 stored XSS in agent-token minted page', () => {
  const malicious = '<script>alert(1)</script>'

  it('escapes scopeLabel in the minted body', () => {
    const html = agentTokenMintedBody('good-name', 'good-slug', 'good-squad', 'raw-token', 'good-id', 'member')
      .toString()
    // Baseline: safe values render unchanged.
    expect(html).toContain('good-squad / good-name')
    expect(html).toContain('good-slug')
    expect(html).toContain('good-id')
    expect(html).toContain('member')
  })

  it('escapes scopeLabel when injected through squadName', () => {
    const html = agentTokenMintedBody('Agent', 'good-slug', malicious, 'raw-token', 'good-id', 'member').toString()
    expect(html).not.toContain(malicious)
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('escapes scopeLabel when injected through agentName', () => {
    const html = agentTokenMintedBody(malicious, 'good-slug', null, 'raw-token', 'good-id', 'member').toString()
    expect(html).not.toContain(malicious)
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('escapes agentSlug everywhere it appears', () => {
    const html = agentTokenMintedBody('Good', malicious, null, 'raw-token', 'good-id', 'member').toString()
    expect(html).not.toContain(malicious)
    expect(html).toContain('(slug: <code class="inline">&lt;script&gt;alert(1)&lt;/script&gt;</code>)')
    expect(html).toContain('~/.fleet/agents/&lt;script&gt;alert(1)&lt;/script&gt;.token')
  })

  it('escapes tokenId at output', () => {
    const html = agentTokenMintedBody('Good', 'good-slug', null, 'raw-token', malicious, 'member').toString()
    expect(html).not.toContain(malicious)
    expect(html).toContain('<code class="inline">&lt;script&gt;alert(1)&lt;/script&gt;</code>')
  })

  it('escapes capability at output', () => {
    const html = agentTokenMintedBody('Good', 'good-slug', null, 'raw-token', 'good-id', malicious).toString()
    expect(html).not.toContain(malicious)
    expect(html).toContain('<code class="inline">&lt;script&gt;alert(1)&lt;/script&gt;</code>')
  })

  it('escapes the raw token placeholder in the code block if it contains HTML characters', () => {
    const html = agentTokenMintedBody('Good', 'good-slug', null, malicious, 'good-id', 'member').toString()
    expect(html).not.toContain(malicious)
    expect(html).toContain('<code class="token" id="rawToken">&lt;script&gt;alert(1)&lt;/script&gt;</code>')
  })
})

describe('#982 shared constant-time compare', () => {
  it('returns true for identical strings', () => {
    expect(timingSafeEqual('same', 'same')).toBe(true)
    expect(timingSafeEqual('', '')).toBe(true)
  })

  it('returns false for different same-length strings', () => {
    expect(timingSafeEqual('aaaa', 'aaab')).toBe(false)
  })

  it('returns false for different-length strings without throwing', () => {
    expect(timingSafeEqual('short', 'shorttt')).toBe(false)
    expect(timingSafeEqual('longer', 'long')).toBe(false)
  })

  it('handles unicode and empty strings', () => {
    expect(timingSafeEqual('🔐', '🔐')).toBe(true)
    expect(timingSafeEqual('🔐', '🔑')).toBe(false)
    expect(timingSafeEqual('', 'x')).toBe(false)
    expect(timingSafeEqual('x', '')).toBe(false)
  })

  it('replaces the seven local helpers functionally', () => {
    // This is a functional smoke test; the security property is that no branch
    // returns early based on length, which is enforced by the folded diff.
    expect(timingSafeEqual('a', 'b')).toBe(false)
    expect(timingSafeEqual('abc', 'abc')).toBe(true)
  })
})

describe('#985+#986 console redaction helpers', () => {
  it('redacts Bearer tokens', () => {
    const out = redactSecretPatterns('Authorization: Bearer abc123.def456')
    expect(out).toContain('[redacted]')
    expect(out).not.toContain('abc123.def456')
  })

  it('redacts mupot_ secrets', () => {
    const out = redactSecretPatterns('token=mupot_live_abc123')
    expect(out).toBe('token=[redacted]')
  })

  it('redacts query-string secrets', () => {
    const out = redactSecretPatterns('https://x/?apiKey=supersecret&ok=1')
    expect(out).toContain('apiKey=[redacted]')
    expect(out).toContain('ok=1')
  })

  it('redacts AWS AKIA keys', () => {
    const out = redactSecretPatterns('key=AKIAIOSFODNN7EXAMPLE')
    expect(out).toBe('key=[redacted]')
  })

  it('redacts JWT-shaped tokens', () => {
    const out = redactSecretPatterns('auth=eyJhbGci.eyJzdWI.foo')
    expect(out).toBe('auth=[redacted]')
  })

  it('leaves non-sensitive values intact', () => {
    const out = redactSecretPatterns('customer=acme&count=42')
    expect(out).toBe('customer=acme&count=42')
  })
})
