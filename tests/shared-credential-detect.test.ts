// tests/shared-credential-detect.test.ts — mupot#1794 W4: shared-credential detection.
//
// READ-ONLY observability behind SHARED_CREDENTIAL_DETECT (default off, its own flag). Real sqlite D1
// from the full migration chain; requests go through the real mcpApp bearer path. Not proven: real D1
// cross-isolate interleaving (Promise.all over a serialized sqlite proves ONE atomic statement).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { mcpApp } from '../src/mcp/index'
import { mintMemberToken } from '../src/members/service'
import { membersApp } from '../src/members'
import {
  buildFingerprint, CRED_FP_GLOBAL_PRUNE_LIMIT, CRED_FP_MAX_ROWS, CRED_FP_WINDOW_MS, readCredentialSharing, recordCredentialSession,
  resetCredentialSessionMemo, sharedCredentialHint, sharedCredentialThreshold, uaFamily, upsertCredentialFingerprint,
} from '../src/members/credential-sharing'
import type { Env } from '../src/types'

const TENANT = 'mumega'
const HUMAN = 'member-human-1'

function envFor(h: SqliteD1Harness, extra: Record<string, unknown> = {}): Env {
  const store = new Map<string, string>([['sess:admin-sid', JSON.stringify({ userId: 'u-admin', email: 'a@x.test', role: 'admin', createdAt: '2026-01-01T00:00:00Z' })]])
  return {
    DB: h.db, TENANT_SLUG: TENANT, PUBLIC_ORIGIN: 'https://pot.test',
    SESSIONS: { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v), delete: async (k: string) => void store.delete(k) },
    OAUTH_KV: { get: async () => null, put: async () => undefined },
    SHARED_CREDENTIAL_DETECT: '1', ...extra,
  } as unknown as Env
}

let h: SqliteD1Harness
const n = (sql: string, ...p: unknown[]): number => Number(h.sqlite.prepare(sql).get(...p)!.n)

async function call(env: Env, raw: string, name: string, headers: Record<string, string> = {}, args: Record<string, unknown> = {}, meta?: Record<string, unknown>) {
  const res = await mcpApp.fetch(new Request('https://pot.test/', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${raw}`, ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } }),
  }), env)
  const body = (await res.json()) as { result?: { structuredContent?: Record<string, unknown> } }
  return { status: res.status, sc: body.result?.structuredContent ?? {}, text: JSON.stringify(body) }
}

async function workspaceToken(env: Env): Promise<{ raw: string; id: string }> {
  const t = await mintMemberToken(env, HUMAN, 'ws', 'workspace')
  return { raw: t.raw, id: t.id }
}

beforeEach(() => {
  h = createSqliteD1(); applyAllMigrations(h.sqlite)
  h.sqlite.exec(`INSERT INTO members (id, email, display_name, status, created_at, tenant) VALUES ('${HUMAN}', 'h@example.test', 'Human', 'active', '2026-10-09T00:00:00.000Z', '${TENANT}')`)
  resetCredentialSessionMemo()
})
afterEach(() => h.close())

describe('flag off (default): nothing is read, written or added', () => {
  it('no table writes, no boot_context field, response identical with the var unset, "0" or garbage', async () => {
    const outs: string[] = []
    for (const v of [undefined, '0', 'true', '']) {
      const env = envFor(h, { SHARED_CREDENTIAL_DETECT: v })
      const t = await workspaceToken(env)
      for (let i = 0; i < 6; i++) await call(env, t.raw, 'boot_context', { 'mcp-session-id': `s${i}`, 'user-agent': `agent-${i}` })
      const r = await call(env, t.raw, 'boot_context', { 'mcp-session-id': 's-final' })
      expect(r.sc).not.toHaveProperty('shared_credential')
      outs.push(JSON.stringify(Object.keys(r.sc).sort()))
    }
    expect(new Set(outs).size).toBe(1)
    expect(n(`SELECT COUNT(*) AS n FROM credential_session_fingerprints`)).toBe(0)
  })

  it('recordCredentialSession / readCredentialSharing are inert off', async () => {
    const env = envFor(h, { SHARED_CREDENTIAL_DETECT: undefined })
    await recordCredentialSession(env, 'tok', { mcpSessionId: 's1' })
    expect(n(`SELECT COUNT(*) AS n FROM credential_session_fingerprints`)).toBe(0)
    expect(await readCredentialSharing(env, 'tok')).toBeNull()
  })
})

describe('flag on', () => {
  it('more than N distinct concurrent sessions on one credential -> shared_suspected with a plain hint; N or fewer -> silent', async () => {
    const env = envFor(h)
    const t = await workspaceToken(env)
    for (let i = 0; i < 3; i++) await call(env, t.raw, 'boot_context', { 'mcp-session-id': `s${i}` })
    expect((await call(env, t.raw, 'boot_context', { 'mcp-session-id': 's0' })).sc).not.toHaveProperty('shared_credential')
    await call(env, t.raw, 'boot_context', { 'mcp-session-id': 's3' })
    const r = await call(env, t.raw, 'boot_context', { 'mcp-session-id': 's4' })
    const sc = r.sc.shared_credential as { shared_suspected: boolean; sessions: number; hint: string }
    expect(sc).toMatchObject({ shared_suspected: true, sessions: 5 })
    expect(sc.hint).toContain('this credential is used by 5 sessions')
    expect(sc.hint).toContain('ask an org admin') // seat enrolment off -> no seat_select advice
  })

  it('with SEAT_AUTO_ENROLL on the hint names the harness token / OAuth option and seat_select', async () => {
    const env = envFor(h, { SEAT_AUTO_ENROLL: '1' })
    const t = await workspaceToken(env)
    for (let i = 0; i < 5; i++) await call(env, t.raw, 'boot_context', { 'mcp-session-id': `s${i}` })
    const sc = (await call(env, t.raw, 'boot_context', { 'mcp-session-id': 's5' })).sc
    expect((sc.shared_credential as { hint: string }).hint).toContain('connect via a harness token or the harness OAuth option and call seat_select so each thread gets its own agent')
    // emitted ONCE: top level only, never duplicated inside the identity receipt
    expect(sc.shared_credential).toBeTruthy()
    expect(sc.identity_receipt as Record<string, unknown>).not.toHaveProperty('shared_credential')
    expect(JSON.stringify(sc).split('"shared_credential"').length - 1).toBe(1)
  })

  it('threshold is configurable and clamped', () => {
    expect(sharedCredentialThreshold({})).toBe(3)
    expect(sharedCredentialThreshold({ SHARED_CREDENTIAL_MAX_SESSIONS: '6' })).toBe(6)
    expect(sharedCredentialThreshold({ SHARED_CREDENTIAL_MAX_SESSIONS: '1' })).toBe(3)
    expect(sharedCredentialThreshold({ SHARED_CREDENTIAL_MAX_SESSIONS: 'x' })).toBe(3)
    expect(sharedCredentialThreshold({ SHARED_CREDENTIAL_MAX_SESSIONS: '9999' })).toBe(3)
    expect(sharedCredentialThreshold({ SHARED_CREDENTIAL_MAX_SESSIONS: '200' })).toBe(CRED_FP_MAX_ROWS)
  })

  it('Codex thread id / openai session hints and the UA family also separate sessions (stateless clients)', async () => {
    const env = envFor(h)
    const t = await workspaceToken(env)
    for (let i = 0; i < 4; i++) await call(env, t.raw, 'status', {}, {}, { threadId: `thr-${i}` })
    const r = await call(env, t.raw, 'boot_context', {}, {}, { threadId: 'thr-9' })
    expect((r.sc.shared_credential as { sessions: number }).sessions).toBe(5)
  })

  it('it NEVER changes auth: the identity is identical whatever Mcp-Session-Id / UA says, and boot still works', async () => {
    const env = envFor(h)
    const t = await workspaceToken(env)
    const a = await call(env, t.raw, 'boot_context', { 'mcp-session-id': 'one', 'user-agent': 'codex-cli/1' })
    const b = await call(env, t.raw, 'boot_context', { 'mcp-session-id': 'two', 'user-agent': 'cursor/9' })
    for (const r of [a, b]) expect(r).toMatchObject({ status: 200 })
    expect(a.sc.member_id).toBe(b.sc.member_id)
    expect(a.sc.channel).toBe(b.sc.channel)
    expect(a.sc.capabilities).toEqual(b.sc.capabilities)
  })

  it('a failing recorder (table gone) never fails or alters the request', async () => {
    const env = envFor(h)
    const t = await workspaceToken(env)
    h.sqlite.exec(`DROP TABLE credential_session_fingerprints`)
    const r = await call(env, t.raw, 'boot_context', { 'mcp-session-id': 's1' })
    expect(r.status).toBe(200)
    expect(r.sc.member_id).toBe(HUMAN)
    expect(r.sc).not.toHaveProperty('shared_credential')
  })

  it('every credential kind is covered: agent-bound-shaped ids too (the writer keys on the credential id only)', async () => {
    const env = envFor(h)
    await recordCredentialSession(env, 'tok-agent-bound', { mcpSessionId: 'a' })
    await recordCredentialSession(env, 'tok-oauth-grant', { mcpSessionId: 'b' })
    expect(n(`SELECT COUNT(DISTINCT token_id) AS n FROM credential_session_fingerprints`)).toBe(2)
  })
})

describe('window, bounds, privacy', () => {
  it('only fingerprints seen inside the window count', async () => {
    const env = envFor(h)
    const now = Date.parse('2026-10-10T12:00:00.000Z')
    for (let i = 0; i < 6; i++) await upsertCredentialFingerprint(env, await buildFingerprint('tok', { mcpSessionId: `s${i}` }), now - CRED_FP_WINDOW_MS - 1000 * (i + 1))
    expect((await readCredentialSharing(env, 'tok', now))?.sessions).toBe(0)
    for (let i = 0; i < 4; i++) await upsertCredentialFingerprint(env, await buildFingerprint('tok', { mcpSessionId: `fresh${i}` }), now - 1000 * i)
    expect(await readCredentialSharing(env, 'tok', now)).toMatchObject({ sessions: 4, shared_suspected: true, window_minutes: 15 })
  })

  it('storage is bounded: at most 64 rows per credential, other credentials unaffected; stale rows pruned in the same batch', async () => {
    const env = envFor(h)
    const now = Date.parse('2026-10-10T12:00:00.000Z')
    for (let i = 0; i < 100; i++) await upsertCredentialFingerprint(env, await buildFingerprint('tok', { mcpSessionId: `s${i}` }), now)
    expect(n(`SELECT COUNT(*) AS n FROM credential_session_fingerprints WHERE token_id = 'tok'`)).toBe(CRED_FP_MAX_ROWS)
    await upsertCredentialFingerprint(env, await buildFingerprint('other', { mcpSessionId: 'x' }), now)
    expect(n(`SELECT COUNT(*) AS n FROM credential_session_fingerprints WHERE token_id = 'other'`)).toBe(1)
    // two hours later every old row is pruned by the next write, freeing the cap
    await upsertCredentialFingerprint(env, await buildFingerprint('tok', { mcpSessionId: 'late' }), now + 2 * 3600_000)
    expect(n(`SELECT COUNT(*) AS n FROM credential_session_fingerprints WHERE token_id = 'tok'`)).toBe(1)
  })

  it('GLOBAL prune: a write for one credential also removes (bounded) stale rows of dead credentials', async () => {
    const env = envFor(h)
    const now = Date.parse('2026-10-10T12:00:00.000Z')
    for (let i = 0; i < 40; i++) {
      h.sqlite.exec(`INSERT INTO credential_session_fingerprints (tenant, token_id, fp, first_seen, last_seen) VALUES ('${TENANT}', 'dead-${i}', '${String(i).padStart(32, '0')}', '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z')`)
    }
    h.sqlite.exec(`INSERT INTO credential_session_fingerprints (tenant, token_id, fp, first_seen, last_seen) VALUES ('${TENANT}', 'recent', '${'f'.repeat(32)}', '2026-10-10T11:59:00.000Z', '2026-10-10T11:59:00.000Z')`)
    await upsertCredentialFingerprint(env, await buildFingerprint('live', { mcpSessionId: 'x' }), now)
    // bounded: one write removes at most CRED_FP_GLOBAL_PRUNE_LIMIT stale rows of OTHER credentials
    expect(n(`SELECT COUNT(*) AS n FROM credential_session_fingerprints WHERE token_id LIKE 'dead-%'`)).toBe(40 - CRED_FP_GLOBAL_PRUNE_LIMIT)
    await upsertCredentialFingerprint(env, await buildFingerprint('live', { mcpSessionId: 'x' }), now + 1000)
    expect(n(`SELECT COUNT(*) AS n FROM credential_session_fingerprints WHERE token_id LIKE 'dead-%'`)).toBe(0)
    // fresh rows of other credentials are never touched
    expect(n(`SELECT COUNT(*) AS n FROM credential_session_fingerprints WHERE token_id = 'recent'`)).toBe(1)
  })

  it('stores no raw session id, user-agent, IP or thread id — only a hash and sanitised labels', async () => {
    const env = envFor(h)
    const t = await workspaceToken(env)
    await call(env, t.raw, 'boot_context', { 'mcp-session-id': 'SECRET-SESSION-ID', 'user-agent': 'Codex/1.2.3 (SECRET-UA-DETAIL)', 'x-forwarded-for': '203.0.113.77', 'cf-connecting-ip': '203.0.113.78' },
      {}, { threadId: 'SECRET-THREAD', clientInfo: { name: 'codex-mcp-client', version: '0.9.1' } })
    const dump = JSON.stringify(h.sqlite.prepare(`SELECT * FROM credential_session_fingerprints`).all())
    for (const secret of ['SECRET-SESSION-ID', 'SECRET-UA-DETAIL', '203.0.113', 'SECRET-THREAD']) expect(dump).not.toContain(secret)
    const row = h.sqlite.prepare(`SELECT * FROM credential_session_fingerprints`).get()!
    expect(row).toMatchObject({ ua_family: 'codex', client_name: 'codex-mcp-client', client_version: '0.9.1', hits: 1 })
    expect(String(row.fp)).toMatch(/^[0-9a-f]{32}$/)
  })

  it('uaFamily is a bounded vocabulary', () => {
    expect(uaFamily('claude-code/2.0 (cli)')).toBe('claude-code')
    expect(uaFamily('Cursor/1')).toBe('cursor')
    expect(uaFamily('totally-new-agent')).toBe('other')
    expect(uaFamily(undefined)).toBe('none')
  })

  it('the hint wording', () => {
    expect(sharedCredentialHint(7, true)).toBe('this credential is used by 7 sessions; connect via a harness token or the harness OAuth option and call seat_select so each thread gets its own agent')
  })
})

describe('the counter write is ONE atomic statement (no read-compare-put)', () => {
  it('25 concurrent writes of the SAME fingerprint -> one row, hits === 25', async () => {
    const env = envFor(h)
    const fp = await buildFingerprint('tok', { mcpSessionId: 's' })
    await Promise.all(Array.from({ length: 25 }, () => upsertCredentialFingerprint(env, fp, Date.now())))
    expect(n(`SELECT COUNT(*) AS n FROM credential_session_fingerprints`)).toBe(1)
    expect(n(`SELECT hits AS n FROM credential_session_fingerprints`)).toBe(25)
  })

  it('100 concurrent DISTINCT fingerprints -> exactly the cap, never more', async () => {
    const env = envFor(h)
    const fps = await Promise.all(Array.from({ length: 100 }, (_, i) => buildFingerprint('tok', { mcpSessionId: `s${i}` })))
    await Promise.all(fps.map((f) => upsertCredentialFingerprint(env, f, Date.now())))
    expect(n(`SELECT COUNT(*) AS n FROM credential_session_fingerprints`)).toBe(CRED_FP_MAX_ROWS)
  })

  it('the isolate memo only reduces writes: a repeat inside 30s is skipped, a new fingerprint is not', async () => {
    const env = envFor(h)
    const now = Date.now()
    await recordCredentialSession(env, 'tok', { mcpSessionId: 's' }, now)
    await recordCredentialSession(env, 'tok', { mcpSessionId: 's' }, now + 1000)
    expect(n(`SELECT hits AS n FROM credential_session_fingerprints`)).toBe(1)
    await recordCredentialSession(env, 'tok', { mcpSessionId: 's' }, now + 31_000)
    expect(n(`SELECT hits AS n FROM credential_session_fingerprints`)).toBe(2)
    await recordCredentialSession(env, 'tok', { mcpSessionId: 's2' }, now + 1000)
    expect(n(`SELECT COUNT(*) AS n FROM credential_session_fingerprints`)).toBe(2)
  })
})

describe('shared harness token + seats: seat sessions are not nagged', () => {
  it('a seat-handle session never carries the hint even when its credential is shared', async () => {
    const env = envFor(h, { SEAT_AUTO_ENROLL: '1', SEAT_MAX_PER_MEMBER: '50' })
    const mintRes = await membersApp.request('/members/' + HUMAN + '/tokens', {
      method: 'POST', headers: { cookie: 'mupot_session=admin-sid', 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'shared-ci', harness_kind: 'ci' }),
    }, env)
    const raw = ((await mintRes.json()) as { token: { raw: string } }).token.raw
    const sel = await call(env, raw, 'seat_select', { 'mcp-session-id': 'a' }, { project: 'p', folder: '/a' })
    const handle = sel.sc.seat_handle as string
    for (let i = 0; i < 6; i++) await call(env, raw, 'boot_context', { 'mcp-session-id': `t${i}` })
    const seated = await call(env, raw, 'boot_context', { 'mcp-session-id': 'z', 'x-mupot-seat': handle })
    expect(seated.sc.bound_agent_id).toBeTruthy()
    expect(seated.sc).not.toHaveProperty('shared_credential')
    const bare = await call(env, raw, 'boot_context', { 'mcp-session-id': 'y' })
    expect(bare.sc).toHaveProperty('shared_credential') // the un-seated thread IS told
  })
})
