// mupot — shared SSRF guard for env/config-sourced outbound URLs.
//
// Extracted from src/departments/executors/inkwell.ts (WARN-1 Sonnet/#209 + IPv6/CGNAT
// hardening Opus/#211) so every connector that fetches an operator-configured URL uses the
// SAME hardened private-host blocker instead of re-rolling a weaker `https`-only check.
// First reuse: the S4 Inkwell executor and the PostHog CRO connector (#219 BLOCK-1, Codex).
//
// We range-check the PARSED IP (not a string regex) so IPv4-mapped IPv6, ULA, link-local,
// CGNAT, and the IPv4 evasions are all caught. (DNS-rebind — a public name re-resolving to
// an internal IP at fetch time — is out of scope for a parse-time check; mitigate with an
// origin allowlist if the URL ever becomes connector/payload-driven rather than env-set.)

export function isPrivateV4(ip: string): boolean {
  const o = ip.split('.').map((n) => Number(n))
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true // malformed → block
  const [a, b] = o
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64.0.0/10
  return false
}

// RFC 6052 well-known NAT64 prefix (64:ff9b::/96 — embeds an IPv4 address in the low 32
// bits) and RFC 8215 local-use NAT64 prefix (64:ff9b:1::/48 — same embedding, shorter
// prefix). Both translate IPv6 traffic onto the IPv4 internet, so an address in either
// range is effectively an IPv4-address-in-disguise: 64:ff9b::a9fe:a9fe carries the exact
// same cloud-metadata payload (169.254.169.254) as the bare IPv4 literal, and would sail
// past a check that only inspects "is this IPv4" or "is this a recognised v4-mapped form".
// GHSA-2vr4-cq9g-pvrc: the `ip-address` package left these two prefixes unclassified.
//
// We BLOCK both prefixes outright rather than extracting the embedded IPv4 and deferring
// to isPrivateV4: the /96 well-known form embeds cleanly in the low 32 bits, but the /48
// local-use form's embedding (RFC 6052 §2.2) reserves a "u" byte and shifts the payload
// across a byte boundary that isn't purely the low 32 bits — correctly decoding it adds
// real parsing surface for an address family that has no legitimate reason to appear in
// an operator-configured connector URL in the first place (these are transition-mechanism
// addresses for IPv6-only hosts reaching the IPv4 internet, not endpoint identities a human
// would type into a config field). Blocking the whole range is simpler, fail-closed, and
// can't be defeated by choosing a NAT64-embedded address whose IPv4 payload happens to look
// public.
const NAT64_WELL_KNOWN_PREFIX = ['0064', 'ff9b', '0000', '0000', '0000', '0000'] // 64:ff9b::/96
const NAT64_LOCAL_USE_PREFIX = ['0064', 'ff9b', '0001'] // 64:ff9b:1::/48

function isHexGroup(g: string): boolean {
  return /^[0-9a-f]{1,4}$/.test(g)
}

// Expand a lowercased, bracket-stripped IPv6 address into 8 zero-padded 4-hex-digit
// groups, resolving `::` zero-compression and a trailing embedded-IPv4 dotted-decimal
// tail (e.g. "64:ff9b::169.254.169.254" or "::ffff:10.0.0.1"). Returns null if the
// address doesn't parse as valid IPv6 — callers must treat null as "not classified",
// never as "safe".
function expandIPv6(host: string): string[] | null {
  let h = host
  const lastColon = h.lastIndexOf(':')
  if (lastColon !== -1 && h.slice(lastColon + 1).includes('.')) {
    const octets = h.slice(lastColon + 1).split('.')
    if (octets.length !== 4) return null
    const nums = octets.map((n) => (/^\d{1,3}$/.test(n) ? Number(n) : NaN))
    if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null
    const hi = ((nums[0] << 8) | nums[1]).toString(16).padStart(4, '0')
    const lo = ((nums[2] << 8) | nums[3]).toString(16).padStart(4, '0')
    h = `${h.slice(0, lastColon + 1)}${hi}:${lo}`
  }

  if (h === '::') return ['0000', '0000', '0000', '0000', '0000', '0000', '0000', '0000']

  const segments = h.split('::')
  if (segments.length > 2) return null // more than one '::' is not valid IPv6

  if (segments.length === 1) {
    const groups = h.split(':')
    if (groups.length !== 8 || !groups.every(isHexGroup)) return null
    return groups.map((g) => g.padStart(4, '0'))
  }

  const head = segments[0] ? segments[0].split(':') : []
  const tail = segments[1] ? segments[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if (missing < 0 || !head.every(isHexGroup) || !tail.every(isHexGroup)) return null
  return [...head, ...Array(missing).fill('0000'), ...tail].map((g) => g.padStart(4, '0'))
}

function isNat64(groups: string[]): boolean {
  if (NAT64_WELL_KNOWN_PREFIX.every((g, i) => groups[i] === g)) return true
  if (NAT64_LOCAL_USE_PREFIX.every((g, i) => groups[i] === g)) return true
  return false
}

export function isPrivateHost(host: string): boolean {
  // URL.hostname keeps IPv6 brackets in Node ([::1]) — strip them + any trailing dot.
  const h = host.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '')
  if (h === 'localhost' || h.endsWith('.internal') || h.endsWith('.local') || h === 'metadata.google.internal') {
    return true
  }
  if (h.includes(':')) {
    // IPv6 (URL.hostname is bracket-stripped). Block loopback/unspecified, ULA
    // (fc00::/7), link-local (fe80::/10), NAT64 (64:ff9b::/96, 64:ff9b:1::/48), and
    // IPv4-mapped (::ffff:a.b.c.d / hex).
    if (h === '::1' || h === '::') return true
    if (h.startsWith('fc') || h.startsWith('fd')) return true // fc00::/7
    if (/^fe[89ab]/.test(h)) return true // fe80::/10
    const groups = expandIPv6(h)
    if (groups && isNat64(groups)) return true
    const mapped = h.match(/^::ffff:(.+)$/)
    if (mapped) {
      if (mapped[1].includes('.')) return isPrivateV4(mapped[1])
      const parts = mapped[1].split(':')
      if (parts.length === 2) {
        const hi = parseInt(parts[0], 16)
        const lo = parseInt(parts[1], 16)
        if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
          return isPrivateV4(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`)
        }
      }
      return true // unrecognised mapped form → block
    }
    return false // other global IPv6 → allow
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return isPrivateV4(h)
  return false // a public hostname
}

/**
 * Parse an env/config-sourced URL and assert it is https + a PUBLIC host.
 * Throws (fail-closed) with a stable code-string message on any violation. Callers
 * translate to their own error type / 503 and must NEVER fall through to fetching.
 *   - 'url_unparseable'  — not a valid URL
 *   - 'url_not_https'    — non-https protocol
 *   - 'url_private_host' — loopback / RFC1918 / link-local / metadata / ULA / mapped-v6
 */
export function assertPublicHttpsUrl(raw: string): URL {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new Error('url_unparseable')
  }
  if (u.protocol !== 'https:') throw new Error('url_not_https')
  if (isPrivateHost(u.hostname)) throw new Error('url_private_host')
  return u
}
