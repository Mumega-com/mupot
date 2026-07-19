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
    ['single-label hostname', 'https://internal/'],
    ['single-label hostname, trailing dot bypass attempt', 'https://internal./'],
    ['metadata single-label', 'https://metadata/'],
  ])('rejects %s', (_label, value) => {
    expect(validHttpsBaseUrl(value)).toBe(false)
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
})
