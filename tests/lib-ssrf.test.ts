// tests/lib-ssrf.test.ts — unit coverage for the shared SSRF guard (src/lib/ssrf.ts),
// which had none of its own before this file (only indirect coverage via callers like
// tests/cro-posthog.test.ts, tests/s4-live-wiring.test.ts, tests/mcpwp-office-*.test.ts).
//
// Added alongside the NAT64 fix (GHSA-2vr4-cq9g-pvrc / advisories on `ip-address`): the guard
// hand-rolls IPv6 classification and correctly blocked fe80::/10, but let NAT64-embedded
// addresses (64:ff9b::/96, RFC 6052; 64:ff9b:1::/48, RFC 8215) fall through to "other global
// IPv6 → allow" — even though 64:ff9b::a9fe:a9fe carries the exact same cloud-metadata payload
// (169.254.169.254) as the bare IPv4 literal. Fixed by expanding the address into 8 zero-padded
// hex groups (resolving `::` compression and a trailing dotted-decimal tail) and comparing
// against both prefixes structurally, not with a `startsWith` a differently-compressed or
// differently-cased spelling of the same address could dodge.

import { describe, expect, it } from 'vitest'
import { assertPublicHttpsUrl, isPrivateHost, isPrivateV4 } from '../src/lib/ssrf'

describe('isPrivateV4', () => {
  it('blocks the well-known private/reserved ranges', () => {
    expect(isPrivateV4('10.0.0.5')).toBe(true)
    expect(isPrivateV4('172.16.0.1')).toBe(true)
    expect(isPrivateV4('172.31.255.254')).toBe(true)
    expect(isPrivateV4('192.168.1.1')).toBe(true)
    expect(isPrivateV4('127.0.0.1')).toBe(true)
    expect(isPrivateV4('0.0.0.0')).toBe(true)
    expect(isPrivateV4('169.254.169.254')).toBe(true) // cloud metadata
    expect(isPrivateV4('100.64.0.1')).toBe(true) // CGNAT low bound
    expect(isPrivateV4('100.127.255.255')).toBe(true) // CGNAT high bound
  })

  it('allows an ordinary public v4 address', () => {
    expect(isPrivateV4('8.8.8.8')).toBe(false)
    expect(isPrivateV4('172.32.0.1')).toBe(false) // just outside 172.16/12
    expect(isPrivateV4('100.63.255.255')).toBe(false) // just below CGNAT
    expect(isPrivateV4('100.128.0.0')).toBe(false) // just above CGNAT
  })

  it('blocks malformed input (fail-closed)', () => {
    expect(isPrivateV4('1.2.3')).toBe(true)
    expect(isPrivateV4('1.2.3.4.5')).toBe(true)
    expect(isPrivateV4('1.2.3.256')).toBe(true)
    expect(isPrivateV4('not-an-ip')).toBe(true)
  })
})

describe('isPrivateHost — NAT64 (GHSA-2vr4-cq9g-pvrc)', () => {
  // 64:ff9b::/96 — RFC 6052 well-known prefix. Multiple spellings of the SAME address must
  // all be caught: hex tail, dotted-decimal tail, uppercase, and the fully expanded form
  // with no `::` compression at all.
  it.each([
    ['hex tail, lowercase, compressed', '64:ff9b::a9fe:a9fe'],
    ['dotted-decimal embedded v4 (matches the prompt example exactly)', '64:ff9b::169.254.169.254'],
    ['uppercase spelling of the hex form', '64:FF9B::A9FE:A9FE'],
    ['mixed-case spelling', '64:Ff9B::a9FE:A9fe'],
    ['fully expanded, zero-padded, no compression', '0064:ff9b:0000:0000:0000:0000:a9fe:a9fe'],
    ['fully expanded, unpadded groups', '64:ff9b:0:0:0:0:a9fe:a9fe'],
  ])('blocks NAT64-embedded cloud metadata: %s (%s)', (_label, host) => {
    expect(isPrivateHost(host)).toBe(true)
  })

  it('blocks the well-known prefix even when the embedded v4 payload looks public — the whole prefix is blocked, not just private embedded addresses (see justification in ssrf.ts)', () => {
    expect(isPrivateHost('64:ff9b::8.8.8.8')).toBe(true)
    expect(isPrivateHost('64:ff9b::808:808')).toBe(true) // same address, hex tail
  })

  // 64:ff9b:1::/48 — RFC 8215 local-use prefix. Same spelling variety.
  it.each([
    ['hex tail, compressed', '64:ff9b:1::a9fe:a9fe'],
    ['dotted-decimal embedded v4', '64:ff9b:1::169.254.169.254'],
    ['uppercase', '64:FF9B:1::A9FE:A9FE'],
    ['fully expanded, no compression', '0064:ff9b:0001:0000:0000:0000:a9fe:a9fe'],
  ])('blocks the local-use NAT64 prefix: %s (%s)', (_label, host) => {
    expect(isPrivateHost(host)).toBe(true)
  })

  it('does not block addresses that merely LOOK similar to the NAT64 prefixes (structural compare, not startsWith)', () => {
    expect(isPrivateHost('64:ff9c::1')).toBe(false) // one hex digit off from ff9b
    expect(isPrivateHost('65:ff9b::1')).toBe(false) // first group off by one
    expect(isPrivateHost('164:ff9b::1')).toBe(false) // first group is '0164', not '0064'
    expect(isPrivateHost('64:ff9b:2::1')).toBe(false) // /48 local-use prefix requires group 2 === 0001, not 0002
    expect(isPrivateHost('64:ff9ba::1')).toBe(false) // 'ff9ba' is not a valid hex group (>4 digits) — unparseable, not a false negative on a real match
  })

  it('a real public IPv6 literal outside any NAT64 prefix is still allowed', () => {
    expect(isPrivateHost('2606:4700:4700::1111')).toBe(false) // Cloudflare public resolver
    expect(isPrivateHost('2001:4860:4860::8888')).toBe(false) // Google public resolver
  })
})

describe('isPrivateHost — existing IPv6 classes (regression, unchanged by the NAT64 fix)', () => {
  it('still blocks loopback, unspecified, ULA, and link-local', () => {
    expect(isPrivateHost('::1')).toBe(true)
    expect(isPrivateHost('::')).toBe(true)
    expect(isPrivateHost('fc00::1')).toBe(true)
    expect(isPrivateHost('fd12:3456::1')).toBe(true)
    expect(isPrivateHost('fe80::1')).toBe(true)
  })

  it('still blocks IPv4-mapped IPv6 (hex and dotted forms)', () => {
    expect(isPrivateHost('::ffff:127.0.0.1')).toBe(true)
    expect(isPrivateHost('::ffff:a9fe:a9fe')).toBe(true) // 169.254.169.254 in hex-mapped form
  })

  it('still allows a real public v4-mapped address', () => {
    expect(isPrivateHost('::ffff:8.8.8.8')).toBe(false)
  })
})

describe('assertPublicHttpsUrl — full URL parsing through to the NAT64 guard', () => {
  it('throws url_private_host for a NAT64-embedded metadata address, bracketed as a real URL host would present it', () => {
    expect(() => assertPublicHttpsUrl('https://[64:ff9b::a9fe:a9fe]/')).toThrow('url_private_host')
    expect(() => assertPublicHttpsUrl('https://[64:ff9b::169.254.169.254]/')).toThrow('url_private_host')
    expect(() => assertPublicHttpsUrl('https://[64:ff9b:1::a9fe:a9fe]/')).toThrow('url_private_host')
  })

  it('a normal public https origin is accepted', () => {
    expect(assertPublicHttpsUrl('https://example.com/').hostname).toBe('example.com')
  })

  it('rejects non-https and unparseable input', () => {
    expect(() => assertPublicHttpsUrl('http://example.com/')).toThrow('url_not_https')
    expect(() => assertPublicHttpsUrl('not-a-url')).toThrow('url_unparseable')
  })
})
