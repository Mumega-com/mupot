// tests/project-link-ssrf.test.ts — Gate 2 (#392, DME-activation security gate 2): reject
// project-link remote_base_url values that target private/reserved network ranges, both at
// link-create time and (defense in depth) immediately before the outbound delivery fetch.
//
// Part 1 is a pure unit sweep over validHttpsBaseUrl (fast, no DB — the threat-case matrix from
// the brief). Part 2 is a REAL sqlite-backed D1 integration test (migrations applied, same
// harness as tests/project-link-addon.test.ts) proving createProjectLink refuses these values
// end-to-end, and that deliverProjectLinkEnvelope refuses a link whose stored remote_base_url
// is unsafe WITHOUT ever calling fetch — i.e. the defense-in-depth check actually runs before
// dispatch, not just at write time.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createSignedProjectEnvelope,
  exportProjectLinkPublicKey,
  generateProjectLinkKeyPair,
} from '../src/addons/project-link/envelope'
import { createProjectLink, deliverProjectLinkEnvelope, validHttpsBaseUrl } from '../src/addons/project-link/service'
import { activateAddon, configureAddon, installAddon } from '../src/addons/service'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const NOW = '2026-07-19T12:00:00.000Z'

describe('validHttpsBaseUrl — SSRF range check (pure, #392 gate 2)', () => {
  it('accepts an ordinary public https origin', () => {
    expect(validHttpsBaseUrl('https://peer.mupot.example/')).toBe(true)
  })

  it.each([
    ['non-https scheme', 'http://peer.mupot.example/'],
    ['ftp scheme', 'ftp://peer.mupot.example/'],
    ['userinfo trick (user@host)', 'https://peer.mupot.example@evil.test/'],
    ['password in url', 'https://user:pw@peer.mupot.example/'],
    ['non-root path', 'https://peer.mupot.example/api'],
    ['query string', 'https://peer.mupot.example/?x=1'],
    ['hash fragment', 'https://peer.mupot.example/#frag'],
    ['non-standard port', 'https://peer.mupot.example:8443/'],
    ['not a URL at all', 'not-a-url'],
  ])('rejects %s', (_label, value) => {
    expect(validHttpsBaseUrl(value)).toBe(false)
  })

  it.each([
    ['localhost', 'https://localhost/'],
    ['localhost with trailing dot', 'https://localhost./'],
    ['loopback 127.0.0.1', 'https://127.0.0.1/'],
    ['loopback range 127.x', 'https://127.255.0.1/'],
    ['10/8 private', 'https://10.0.0.5/'],
    ['172.16/12 private (low bound)', 'https://172.16.0.1/'],
    ['172.16/12 private (high bound)', 'https://172.31.255.254/'],
    ['192.168/16 private', 'https://192.168.1.1/'],
    ['169.254/16 link-local', 'https://169.254.169.254/'], // the classic cloud metadata address
    ['0.0.0.0/8', 'https://0.0.0.0/'],
    ['100.64/10 CGNAT', 'https://100.64.0.1/'],
    ['100.64/10 CGNAT high bound', 'https://100.127.255.255/'],
    ['ipv6 loopback ::1', 'https://[::1]/'],
    ['ipv6 loopback ::1 uppercase', 'https://[::1]/'],
    ['ipv6 unspecified ::', 'https://[::]/'],
    ['ipv6 unique-local fc00::/7 (fc)', 'https://[fc00::1]/'],
    ['ipv6 unique-local fc00::/7 (fd)', 'https://[fd12:3456::1]/'],
    ['ipv6 link-local fe80::/10', 'https://[fe80::1]/'],
    ['ipv6 v4-mapped loopback', 'https://[::ffff:127.0.0.1]/'],
    ['ipv6 v4-mapped private', 'https://[::ffff:10.0.0.1]/'],
    // Deprecated IPv4-COMPATIBLE form (no 0xffff marker — RFC 4291 historic). Re-gate on #401
    // found this form uncaught: only the ::ffff:-marked mapped form above was checked.
    ['ipv6 v4-compatible loopback, dotted form', 'https://[::127.0.0.1]/'],
    ['ipv6 v4-compatible loopback, hex form (== ::127.0.0.1)', 'https://[::7f00:1]/'],
    ['ipv6 v4-compatible private 10.x, dotted form', 'https://[::10.0.0.5]/'],
    ['ipv6 v4-compatible link-local metadata, dotted form', 'https://[::169.254.169.254]/'],
    ['single-label hostname', 'https://internal/'],
    ['single-label hostname, trailing dot bypass attempt', 'https://internal./'],
    ['metadata single-label', 'https://metadata/'],
  ])('rejects %s', (_label, value) => {
    expect(validHttpsBaseUrl(value)).toBe(false)
  })

  // #403 gap 1: special-use domain names (RFC 6761 localhost / RFC 6762 §3 .local / RFC 8375
  // home.arpa / RFC 9476 .internal) as a DOTTED subdomain — these have a '.' in them, so the
  // old "bare single-label hostname" fallback never saw them.
  it.each([
    ['*.localhost subdomain', 'https://foo.localhost/'],
    ['*.localhost, deeper subdomain', 'https://a.b.localhost/'],
    ['*.internal subdomain', 'https://x.internal/'],
    ['bare home.arpa (RFC 8375)', 'https://home.arpa/'],
    ['*.home.arpa subdomain', 'https://y.home.arpa/'],
    ['*.local subdomain (mDNS, RFC 6762)', 'https://printer.local/'],
    ['*.localhost, trailing-dot bypass attempt', 'https://foo.localhost./'],
    ['*.internal, uppercase bypass attempt', 'https://X.INTERNAL/'],
  ])('rejects %s', (_label, value) => {
    expect(validHttpsBaseUrl(value)).toBe(false)
  })

  // Deliberately NOT blocked — see the SPECIAL_USE_DOMAINS comment in service.ts for the full
  // reasoning: `.test`/`.invalid` are unregistered ICANN root zones (never resolve, anywhere,
  // to anything — Cloudflare's resolver fails closed with NXDOMAIN, no SSRF surface); `.example`
  // domains that resolve point at fixed ICANN-operated public addresses, not a private network.
  // This is also the codebase's own established fake-public-peer convention for tests
  // (`*.mupot.test`, used throughout tests/project-link-{addon,routes}.test.ts).
  it.each([
    ['*.test (RFC 6761, unregistered root — cannot resolve)', 'https://foo.test/'],
    ['*.invalid (RFC 6761, unregistered root — cannot resolve)', 'https://foo.invalid/'],
    ['*.example (RFC 6761, resolves to a fixed ICANN-public address)', 'https://foo.example/'],
    ["the codebase's own test-peer convention", 'https://dme.mupot.test/'],
  ])('allows %s (considered + excluded, not an oversight)', (_label, value) => {
    expect(validHttpsBaseUrl(value)).toBe(true)
  })

  it('a normal public multi-label host with an unrelated TLD is still allowed (sanity: suffix match is exact, not substring)', () => {
    expect(validHttpsBaseUrl('https://api.linear.app/')).toBe(true)
    // "notinternal.example.com" contains "internal" as a substring of its first label but is
    // not dot-bounded to the special-use ".internal" suffix, and ".com" is an ordinary public
    // TLD — must not be caught by a naive `.includes('internal')`/`.includes('example')` check.
    expect(validHttpsBaseUrl('https://notinternal.example.com/')).toBe(true)
  })

  it('"localhost" as a leading label of an otherwise-public domain is NOT caught by name-based blocking (documented residual limitation, not this gate\'s job)', () => {
    // isBlockedHost only vets the literal hostname string against exact/suffix special-use
    // names — it has no DNS resolution step. "localhost.attacker.example.com" is neither
    // exactly "localhost" nor does it END in ".localhost", so the suffix rule correctly does
    // not fire here (that would be a substring match, which the file's own comment calls out
    // as the wrong tool). Whether *this* particular host is safe to dial is a DNS-rebinding /
    // attacker-controlled-domain question, out of scope for a literal-name gate (see the
    // "Residual limitation" comment above isBlockedHost).
    expect(validHttpsBaseUrl('https://localhost.attacker.example.com/')).toBe(true)
  })

  it('ipv6 v4-compatible form with a real PUBLIC embedded v4 address is not blocked (boundary is exact, same as the v4-mapped case)', () => {
    expect(validHttpsBaseUrl('https://[::8.8.8.8]/')).toBe(true)
  })

  it('172.32.x.x (just outside 172.16/12) is NOT blocked by the private-range rule (sanity: range boundary is exact)', () => {
    // Still a real public-looking IP literal — not blocked by isPrivateOrReservedIpv4, and not
    // a single-label host (an IP literal has dots) — this proves the /12 boundary math is
    // exact, not an accidental over-block. (It's still a bare IP, which is fine — arbitrary
    // public IPs are legitimate fetch targets; the gate is about PRIVATE/RESERVED ranges.)
    expect(validHttpsBaseUrl('https://172.32.0.1/')).toBe(true)
  })

  it('a real public IPv6 literal is not blocked', () => {
    expect(validHttpsBaseUrl('https://[2606:4700:4700::1111]/')).toBe(true) // Cloudflare public resolver
  })

  it('a multi-label public hostname with mixed case normalizes fine', () => {
    expect(validHttpsBaseUrl('https://PEER.Mupot.Example/')).toBe(true)
  })
})

// ── integration: real D1 + real migrations, mirroring tests/project-link-addon.test.ts ────
function migrate(harness: SqliteD1Harness) {
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
}

function seed(harness: SqliteD1Harness) {
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept', 'dept', 'Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad', 'dept', 'squad', 'Squad');
    INSERT INTO projects (id, slug, name, status) VALUES ('project', 'project', 'Project', 'active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('project', 'squad', 'write');
  `)
}

function env(harness: SqliteD1Harness, signingKey?: string): Env {
  return {
    DB: harness.db,
    TENANT_SLUG: 'mumega',
    BUS: { send: async () => undefined },
    PROJECT_LINK_SIGNING_KEY: signingKey,
  } as unknown as Env
}

async function enableProjectLinkAddon(target: Env) {
  const actor = { id: 'owner', role: 'owner' as const }
  const installed = await installAddon(target, actor, 'project-link')
  const configured = await configureAddon(target, actor, 'project-link')
  const activated = await activateAddon(target, actor, 'project-link')
  if (!installed.ok || !configured.ok || !activated.ok) throw new Error('fixture addon activation failed')
}

function linkInput(remoteBaseUrl: string, remotePublicKey: string) {
  return {
    id: 'link-1',
    local_project_id: 'project',
    local_squad_id: 'squad',
    local_agent_id: 'agent-a',
    local_key_id: 'local-key',
    remote_pot: 'dme',
    remote_project_id: 'dme-project',
    remote_link_id: 'dme-link',
    remote_agent_id: 'agent-b',
    remote_key_id: 'remote-key',
    remote_public_key: remotePublicKey,
    remote_base_url: remoteBaseUrl,
    capabilities: ['project.task.write'] as const,
    approved_evidence_origins: [],
    stale_after_seconds: 300,
  }
}

describe('project-link SSRF gate — integration (real D1, real migrations)', () => {
  it('createProjectLink refuses an SSRF-shaped remote_base_url (invalid_link)', async () => {
    const harness = createSqliteD1()
    try {
      migrate(harness)
      seed(harness)
      const e = env(harness)
      await enableProjectLinkAddon(e)
      const remoteKeys = await generateProjectLinkKeyPair()
      const result = await createProjectLink(
        e,
        linkInput('https://169.254.169.254/', await exportProjectLinkPublicKey(remoteKeys.publicKey)),
        { id: 'owner', role: 'owner' },
        NOW,
      )
      expect(result).toEqual({ ok: false, reason: 'invalid_link' })
      expect(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM project_links').get()).toEqual({ n: 0 })
    } finally {
      harness.close()
    }
  })

  it('createProjectLink accepts a normal public https origin', async () => {
    const harness = createSqliteD1()
    try {
      migrate(harness)
      seed(harness)
      const e = env(harness)
      await enableProjectLinkAddon(e)
      const remoteKeys = await generateProjectLinkKeyPair()
      const result = await createProjectLink(
        e,
        linkInput('https://dme.mupot.test/', await exportProjectLinkPublicKey(remoteKeys.publicKey)),
        { id: 'owner', role: 'owner' },
        NOW,
      )
      expect(result.ok).toBe(true)
    } finally {
      harness.close()
    }
  })

  it('deliverProjectLinkEnvelope refuses a link whose stored remote_base_url is unsafe — WITHOUT ever calling fetch', async () => {
    const harness = createSqliteD1()
    try {
      migrate(harness)
      seed(harness)
      const e = env(harness)
      await enableProjectLinkAddon(e)
      const localKeys = await generateProjectLinkKeyPair()
      const remoteKeys = await generateProjectLinkKeyPair()
      const created = await createProjectLink(
        e,
        linkInput('https://dme.mupot.test/', await exportProjectLinkPublicKey(remoteKeys.publicKey)),
        { id: 'owner', role: 'owner' },
        NOW,
      )
      if (!created.ok) throw new Error('fixture link creation failed')

      // Simulate a row that bypassed createProjectLink's write-time check (e.g. a pre-gate
      // row, or a future write path) — defense in depth must catch THIS at delivery time.
      harness.sqlite.exec(
        `UPDATE project_links SET remote_base_url = 'https://169.254.169.254/' WHERE id = '${created.link.id}'`,
      )

      let fetchCalled = false
      const fetcher: typeof fetch = async () => {
        fetchCalled = true
        throw new Error('fetch must never be reached for an SSRF-shaped remote_base_url')
      }

      const signed = await createSignedProjectEnvelope(
        {
          source: { pot: 'mumega', project_id: 'project', agent_id: 'agent-a', key_id: 'local-key' },
          destination: { pot: 'dme', project_id: 'dme-project' },
          correlation_id: 'corr-1',
          idempotency_key: 'idem-1',
          requested_capability: 'project.task.write',
          expires_at: '2026-07-19T12:05:00.000Z',
          task: {
            source_task_id: 'task-1',
            flight_id: 'flight-1',
            request_id: 'req-1',
            title: 'Test delivery',
            state: 'in_progress',
            priority: 'high',
            blocker_summary: null,
            success_predicate: 'n/a',
            progress_summary: 'n/a',
          },
          evidence: null,
        },
        localKeys.privateKey,
      )

      const delivered = await deliverProjectLinkEnvelope(e, created.link.id, signed, { fetcher, now: NOW })
      expect(delivered).toEqual({ ok: false, reason: 'invalid_link' })
      expect(fetchCalled).toBe(false)
    } finally {
      harness.close()
    }
  })

  // ── redirect-following bypass (BLOCK-1, #401 re-gate) ──────────────────────────────────
  // validHttpsBaseUrl only ever vets the LITERAL remote_base_url host — a public, gate-passing
  // host can still answer the delivery request with a 307/308 pointing at a private/loopback
  // address, and the default fetch() redirect mode ('follow') would chase it transparently.
  // These prove the fix: `redirect: 'manual'` + outright refusal of every 3xx, never a second
  // dial to the Location target.
  async function deliveryFixture(harness: SqliteD1Harness, fetcher: typeof fetch) {
    migrate(harness)
    seed(harness)
    const e = env(harness)
    await enableProjectLinkAddon(e)
    const localKeys = await generateProjectLinkKeyPair()
    const remoteKeys = await generateProjectLinkKeyPair()
    const created = await createProjectLink(
      e,
      linkInput('https://dme.mupot.test/', await exportProjectLinkPublicKey(remoteKeys.publicKey)),
      { id: 'owner', role: 'owner' },
      NOW,
    )
    if (!created.ok) throw new Error('fixture link creation failed')
    const signed = await createSignedProjectEnvelope(
      {
        source: { pot: 'mumega', project_id: 'project', agent_id: 'agent-a', key_id: 'local-key' },
        destination: { pot: 'dme', project_id: 'dme-project' },
        correlation_id: 'corr-1',
        idempotency_key: 'idem-redirect-1',
        requested_capability: 'project.task.write',
        expires_at: '2026-07-19T12:05:00.000Z',
        task: {
          source_task_id: 'task-1', flight_id: 'flight-1', request_id: 'req-1',
          title: 'Test delivery', state: 'in_progress', priority: 'high',
          blocker_summary: null, success_predicate: 'n/a', progress_summary: 'n/a',
        },
        evidence: null,
      },
      localKeys.privateKey,
    )
    const delivered = await deliverProjectLinkEnvelope(e, created.link.id, signed, { fetcher, now: NOW, maxAttempts: 1 })
    return { e, linkId: created.link.id, delivered }
  }

  it('deliverProjectLinkEnvelope refuses a 307 redirect to a private-IP Location — real workerd shape (explicit 3xx status), never dials the Location target', async () => {
    const harness = createSqliteD1()
    try {
      const dialedUrls: string[] = []
      const fetcher: typeof fetch = async (input) => {
        dialedUrls.push(String(input))
        return new Response(null, { status: 307, headers: { location: 'http://127.0.0.1/admin' } })
      }
      const { delivered } = await deliveryFixture(harness, fetcher)
      expect(delivered.ok).toBe(false)
      // exactly one dial — the original (validated) origin, never the redirect target
      expect(dialedUrls).toHaveLength(1)
      expect(dialedUrls[0]).toMatch(/^https:\/\/dme\.mupot\.test\/api\/project-links\//)
      expect(dialedUrls.some((u) => u.includes('127.0.0.1'))).toBe(false)
    } finally {
      harness.close()
    }
  })

  it('deliverProjectLinkEnvelope refuses a 308 redirect to the cloud-metadata address', async () => {
    const harness = createSqliteD1()
    try {
      const dialedUrls: string[] = []
      const fetcher: typeof fetch = async (input) => {
        dialedUrls.push(String(input))
        return new Response(null, { status: 308, headers: { location: 'http://169.254.169.254/latest/meta-data/' } })
      }
      const { delivered } = await deliveryFixture(harness, fetcher)
      expect(delivered.ok).toBe(false)
      expect(dialedUrls).toHaveLength(1)
    } finally {
      harness.close()
    }
  })

  it('deliverProjectLinkEnvelope also refuses the browser-style opaqueredirect response shape (vitest/undici mock parity, mirrors src/departments/executors/shared/cms-adapter.ts)', async () => {
    const harness = createSqliteD1()
    try {
      let calls = 0
      const opaque = { type: 'opaqueredirect', status: 0, ok: false } as unknown as Response
      const fetcher: typeof fetch = async () => {
        calls += 1
        return opaque
      }
      const { delivered } = await deliveryFixture(harness, fetcher)
      expect(delivered.ok).toBe(false)
      expect(calls).toBe(1)
    } finally {
      harness.close()
    }
  })

  it('a normal 2xx response from the (validated) origin is NOT refused by the redirect guard — sanity check the fix does not over-block honest peers', async () => {
    const harness = createSqliteD1()
    try {
      // Not asserting full success (that needs a matching receipt signature, covered
      // elsewhere) — just that a 2xx response reaches past the redirect-refusal branch
      // instead of being misclassified as a redirect. A malformed-body 200 hits
      // 'invalid_remote_receipt' internally, surfacing as the generic 'remote_failure'
      // terminal reason (not a redirect refusal) — proving the redirect guard let it through.
      const fetcher: typeof fetch = async () => new Response(JSON.stringify({ ok: false }), { status: 200 })
      const { delivered } = await deliveryFixture(harness, fetcher)
      expect(delivered).toMatchObject({ ok: false, reason: 'remote_failure' })
    } finally {
      harness.close()
    }
  })

  // ── trailing-slash normalization (Minor guard, #401 re-gate) ───────────────────────────
  it('deliverProjectLinkEnvelope normalizes a stored remote_base_url that lacks a trailing slash before building the delivery URL — an out-of-band row cannot shift the fetched host/path', async () => {
    const harness = createSqliteD1()
    try {
      migrate(harness)
      seed(harness)
      const e = env(harness)
      await enableProjectLinkAddon(e)
      const localKeys = await generateProjectLinkKeyPair()
      const remoteKeys = await generateProjectLinkKeyPair()
      const created = await createProjectLink(
        e,
        linkInput('https://dme.mupot.test/', await exportProjectLinkPublicKey(remoteKeys.publicKey)),
        { id: 'owner', role: 'owner' },
        NOW,
      )
      if (!created.ok) throw new Error('fixture link creation failed')
      // Simulate a row written outside createProjectLink's `new URL().toString()` normalization
      // (e.g. a migration or a future write path) — stored WITHOUT the trailing slash.
      harness.sqlite.exec(
        `UPDATE project_links SET remote_base_url = 'https://dme.mupot.test' WHERE id = '${created.link.id}'`,
      )
      const dialedUrls: string[] = []
      const fetcher: typeof fetch = async (input) => {
        dialedUrls.push(String(input))
        return new Response(null, { status: 500 })
      }
      const signed = await createSignedProjectEnvelope(
        {
          source: { pot: 'mumega', project_id: 'project', agent_id: 'agent-a', key_id: 'local-key' },
          destination: { pot: 'dme', project_id: 'dme-project' },
          correlation_id: 'corr-2',
          idempotency_key: 'idem-slash-1',
          requested_capability: 'project.task.write',
          expires_at: '2026-07-19T12:05:00.000Z',
          task: {
            source_task_id: 'task-1', flight_id: 'flight-1', request_id: 'req-1',
            title: 'Test delivery', state: 'in_progress', priority: 'high',
            blocker_summary: null, success_predicate: 'n/a', progress_summary: 'n/a',
          },
          evidence: null,
        },
        localKeys.privateKey,
      )
      await deliverProjectLinkEnvelope(e, created.link.id, signed, { fetcher, now: NOW, maxAttempts: 1 })
      expect(dialedUrls).toHaveLength(1)
      // Without normalization this would be 'https://dme.mupot.testapi/project-links/...' —
      // a different (and invalid) host string entirely.
      expect(dialedUrls[0].startsWith('https://dme.mupot.test/api/project-links/')).toBe(true)
    } finally {
      harness.close()
    }
  })
})
