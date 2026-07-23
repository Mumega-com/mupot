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

export function isPrivateHost(host: string): boolean {
  // URL.hostname keeps IPv6 brackets in Node ([::1]) — strip them + any trailing dot.
  const h = host.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '')
  if (h === 'localhost' || h.endsWith('.internal') || h.endsWith('.local') || h === 'metadata.google.internal') {
    return true
  }
  if (h.includes(':')) {
    // IPv6 (URL.hostname is bracket-stripped). Block loopback/unspecified, ULA
    // (fc00::/7), link-local (fe80::/10), and IPv4-mapped (::ffff:a.b.c.d / hex).
    if (h === '::1' || h === '::') return true
    if (h.startsWith('fc') || h.startsWith('fd')) return true // fc00::/7
    if (/^fe[89ab]/.test(h)) return true // fe80::/10
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

/** Soft variant for href rendering — returns null instead of throwing on bad/unsafe URLs. */
export function safePublicHttpsHref(raw: string | null | undefined): string | null {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  if (!trimmed) return null
  try {
    return assertPublicHttpsUrl(trimmed).toString()
  } catch {
    return null
  }
}
