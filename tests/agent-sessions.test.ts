// tests/agent-sessions.test.ts — the D1-backed, listable/revocable/expiring
// AGENT runtime-session registry (Delivery Sequence step 2, docs/superpowers/
// specs/2026-09-01-human-approved-session-bound-agent-elevation-design.md).
//
// RED/GREEN framing: before this module existed, an agent's authenticated
// connection had NO first-class session identity at all — only the member_
// tokens row backing it (unlistable as "sessions", with no independent
// idle/absolute ceiling of its own, and nothing a future elevation grant
// could bind to more narrowly than "the whole agent"). Every test below is
// RED against that old shape and GREEN against this one. Uses the REAL
// migration chain (createSqliteD1 + applyAllMigrations) per tests/helpers/
// migrations.ts's rule — never a hand-written schema.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations, migrationFiles } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import {
  AGENT_SESSION_ABSOLUTE_TTL_MS,
  AGENT_SESSION_IDLE_TIMEOUT_MS,
  AGENT_SESSION_LAST_SEEN_COALESCE_MS,
  createAgentSession,
  deriveAgentAuthKind,
  evaluateAgentSession,
  getOrCreateAgentSession,
  listAgentSessions,
  loadAgentSessionById,
  loadLiveAgentSessionByCredential,
  resolveAgentSessionContext,
  revokeAgentSessionByCredential,
  revokeAgentSessionByCredentialSafe,
  revokeAgentSessionById,
  revokeAllAgentSessionsForAgent,
  touchAgentSession,
} from '../src/auth/agent-sessions'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TENANT = 'mumega'
const DEPT = 'dept-1'
const SQUAD = 'squad-1'
const AGENT_A = 'agent-a'
const AGENT_B = 'agent-b'
const MEMBER_A = 'member-a'
const MEMBER_B = 'member-b'

describe('agent-session registry (D1, real migration chain)', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = { TENANT_SLUG: TENANT, DB: harness.db } as unknown as Env
    await seedOrg()
  })

  afterEach(() => harness.close())

  async function seedOrg() {
    await env.DB.prepare(`INSERT INTO departments (id, slug, name) VALUES (?1, 'dept', 'Dept')`).bind(DEPT).run()
    await env.DB.prepare(`INSERT INTO squads (id, department_id, slug, name) VALUES (?1, ?2, 'squad', 'Squad')`)
      .bind(SQUAD, DEPT)
      .run()
    for (const [agentId, memberId] of [[AGENT_A, MEMBER_A], [AGENT_B, MEMBER_B]] as const) {
      await env.DB.prepare(
        `INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES (?1, ?2, ?3, ?3, 'member', 'test', 'active')`,
      )
        .bind(agentId, SQUAD, agentId)
        .run()
      await env.DB.prepare(
        `INSERT INTO members (id, tenant, display_name, status, created_at) VALUES (?1, ?2, ?1, 'active', datetime('now'))`,
      )
        .bind(memberId, TENANT)
        .run()
    }
  }

  // ── createAgentSession ─────────────────────────────────────────────────

  it('creates a row with independent idle (24h) and absolute (7d) ceilings at creation', async () => {
    const nowMs = Date.parse('2026-09-01T00:00:00.000Z')
    const record = await createAgentSession(
      env,
      { tenant: TENANT, agentId: AGENT_A, memberId: MEMBER_A, authKind: 'workspace_token', credentialId: 'token-1' },
      nowMs,
    )
    expect(Date.parse(record.idle_expires_at)).toBe(nowMs + AGENT_SESSION_IDLE_TIMEOUT_MS)
    expect(Date.parse(record.absolute_expires_at)).toBe(nowMs + AGENT_SESSION_ABSOLUTE_TTL_MS)
    expect(record.revoked_at).toBeNull()
    expect(record.id).not.toBe('token-1') // the id is NOT the credential — a fresh opaque row id
  })

  it('two DIFFERENT credentials for the SAME agent produce two DISTINCT sessions', async () => {
    const a = await createAgentSession(env, {
      tenant: TENANT, agentId: AGENT_A, memberId: MEMBER_A, authKind: 'workspace_token', credentialId: 'token-1',
    })
    const b = await createAgentSession(env, {
      tenant: TENANT, agentId: AGENT_A, memberId: MEMBER_A, authKind: 'workspace_token', credentialId: 'token-2',
    })
    expect(a.id).not.toBe(b.id)
  })

  // ── evaluateAgentSession (pure, fail closed) ──────────────────────────────

  it('evaluateAgentSession: revoked wins even if neither expiry has passed yet', () => {
    const nowMs = Date.parse('2026-09-01T00:00:00.000Z')
    const session = {
      id: 's1', tenant: TENANT, agent_id: AGENT_A, member_id: MEMBER_A,
      auth_kind: 'workspace_token' as const, credential_id: 'token-1', seat: null,
      created_at: new Date(nowMs).toISOString(),
      last_seen_at: new Date(nowMs).toISOString(),
      idle_expires_at: new Date(nowMs + AGENT_SESSION_IDLE_TIMEOUT_MS).toISOString(),
      absolute_expires_at: new Date(nowMs + AGENT_SESSION_ABSOLUTE_TTL_MS).toISOString(),
      revoked_at: new Date(nowMs).toISOString(),
      revoke_reason: 'human_revoke',
    }
    expect(evaluateAgentSession(session, nowMs + 1)).toEqual({ ok: false, reason: 'revoked' })
  })

  it('idle expiry (24h) fails closed even though absolute (7d) has not passed', async () => {
    const t0 = Date.parse('2026-09-01T00:00:00.000Z')
    const created = await createAgentSession(env, {
      tenant: TENANT, agentId: AGENT_A, memberId: MEMBER_A, authKind: 'workspace_token', credentialId: 'token-1',
    }, t0)
    const evaluated = evaluateAgentSession(created, t0 + AGENT_SESSION_IDLE_TIMEOUT_MS)
    expect(evaluated).toEqual({ ok: false, reason: 'expired_idle' })
  })

  // ── touchAgentSession ──────────────────────────────────────────────────

  it('touchAgentSession coalesces: no write inside the 5-minute window', async () => {
    const t0 = Date.parse('2026-09-01T00:00:00.000Z')
    const created = await createAgentSession(env, {
      tenant: TENANT, agentId: AGENT_A, memberId: MEMBER_A, authKind: 'workspace_token', credentialId: 'token-1',
    }, t0)
    await touchAgentSession(env, created.id, t0 + AGENT_SESSION_LAST_SEEN_COALESCE_MS - 1000)
    const row = await loadAgentSessionById(env, TENANT, created.id)
    expect(row?.last_seen_at).toBe(created.last_seen_at)
    expect(row?.idle_expires_at).toBe(created.idle_expires_at)
  })

  it('touchAgentSession bumps last_seen_at + idle_expires_at once the coalesce window has passed', async () => {
    const t0 = Date.parse('2026-09-01T00:00:00.000Z')
    const created = await createAgentSession(env, {
      tenant: TENANT, agentId: AGENT_A, memberId: MEMBER_A, authKind: 'workspace_token', credentialId: 'token-1',
    }, t0)
    const t1 = t0 + AGENT_SESSION_LAST_SEEN_COALESCE_MS + 1000
    await touchAgentSession(env, created.id, t1)
    const row = await loadAgentSessionById(env, TENANT, created.id)
    expect(row?.last_seen_at).toBe(new Date(t1).toISOString())
    expect(Date.parse(row!.idle_expires_at)).toBe(t1 + AGENT_SESSION_IDLE_TIMEOUT_MS)
  })

  it('touchAgentSession never resurrects a revoked session', async () => {
    const t0 = Date.parse('2026-09-01T00:00:00.000Z')
    const created = await createAgentSession(env, {
      tenant: TENANT, agentId: AGENT_A, memberId: MEMBER_A, authKind: 'workspace_token', credentialId: 'token-1',
    }, t0)
    await revokeAgentSessionById(env, TENANT, AGENT_A, created.id, 'test', t0)
    await touchAgentSession(env, created.id, t0 + AGENT_SESSION_LAST_SEEN_COALESCE_MS + 1000)
    const row = await loadAgentSessionById(env, TENANT, created.id)
    expect(row?.last_seen_at).toBe(created.last_seen_at)
  })

  it('touchAgentSession updates seat when one is supplied and differs, even inside the coalesce window', async () => {
    const t0 = Date.parse('2026-09-01T00:00:00.000Z')
    const created = await createAgentSession(env, {
      tenant: TENANT, agentId: AGENT_A, memberId: MEMBER_A, authKind: 'workspace_token', credentialId: 'token-1', seat: null,
    }, t0)
    await touchAgentSession(env, created.id, t0 + 1000, 'claude-code-laptop')
    const row = await loadAgentSessionById(env, TENANT, created.id)
    expect(row?.seat).toBe('claude-code-laptop')
    // The seat write must NOT have also bumped idle_expires_at (still inside coalesce window).
    expect(row?.idle_expires_at).toBe(created.idle_expires_at)
  })

  // ── getOrCreateAgentSession — the "agent authentication" touchpoint ─────

  it('getOrCreateAgentSession creates on first use, then reuses (touches) the same row on repeat use', async () => {
    const t0 = Date.parse('2026-09-01T00:00:00.000Z')
    const input = { tenant: TENANT, agentId: AGENT_A, memberId: MEMBER_A, authKind: 'workspace_token' as const, credentialId: 'token-1' }
    const first = await getOrCreateAgentSession(env, input, t0)
    expect(first?.created).toBe(true)
    expect(first?.rotatedFromId).toBeNull()

    const t1 = t0 + AGENT_SESSION_LAST_SEEN_COALESCE_MS + 1000
    const second = await getOrCreateAgentSession(env, input, t1)
    expect(second?.created).toBe(false)
    expect(second?.session.id).toBe(first?.session.id)
    expect(second?.session.last_seen_at).toBe(new Date(t1).toISOString())
  })

  it('getOrCreateAgentSession: two different tokens for the same agent resolve to two distinct sessions, and touching one never touches the other', async () => {
    const t0 = Date.parse('2026-09-01T00:00:00.000Z')
    const a = await getOrCreateAgentSession(env, {
      tenant: TENANT, agentId: AGENT_A, memberId: MEMBER_A, authKind: 'workspace_token', credentialId: 'token-1',
    }, t0)
    const b = await getOrCreateAgentSession(env, {
      tenant: TENANT, agentId: AGENT_A, memberId: MEMBER_A, authKind: 'workspace_token', credentialId: 'token-2',
    }, t0)
    expect(a?.session.id).not.toBe(b?.session.id)

    const t1 = t0 + AGENT_SESSION_LAST_SEEN_COALESCE_MS + 1000
    await getOrCreateAgentSession(env, {
      tenant: TENANT, agentId: AGENT_A, memberId: MEMBER_A, authKind: 'workspace_token', credentialId: 'token-1',
    }, t1)
    const untouchedB = await loadAgentSessionById(env, TENANT, b!.session.id)
    expect(untouchedB?.last_seen_at).toBe(b!.session.last_seen_at) // session B's own creation time, unchanged
  })

  it('elevating (in spirit: touching) one agent session never affects a sibling session for a DIFFERENT agent', async () => {
    const t0 = Date.parse('2026-09-01T00:00:00.000Z')
    const a = await getOrCreateAgentSession(env, {
      tenant: TENANT, agentId: AGENT_A, memberId: MEMBER_A, authKind: 'workspace_token', credentialId: 'token-a',
    }, t0)
    const b = await getOrCreateAgentSession(env, {
      tenant: TENANT, agentId: AGENT_B, memberId: MEMBER_B, authKind: 'workspace_token', credentialId: 'token-b',
    }, t0)
    await revokeAgentSessionById(env, TENANT, AGENT_A, a!.session.id, 'test')
    const bAfter = await loadAgentSessionById(env, TENANT, b!.session.id)
    expect(evaluateAgentSession(bAfter!).ok).toBe(true)
  })

  it('ADVERSARIAL: absolute expiry (7d) fails closed even if the credential is continuously used — the SAME credential rotates to a NEW session id, the old one ends up revoked', async () => {
    const t0 = Date.parse('2026-09-01T00:00:00.000Z')
    const input = { tenant: TENANT, agentId: AGENT_A, memberId: MEMBER_A, authKind: 'workspace_token' as const, credentialId: 'token-1' }
    const first = await getOrCreateAgentSession(env, input, t0)
    const firstId = first!.session.id

    // Use the credential every 20h (< 24h idle window) up to just past the 7-day mark.
    // idle_expires_at keeps getting bumped forward on the ORIGINAL row, but
    // absolute_expires_at is fixed at creation and this loop never rescues it
    // past that ceiling.
    let t = t0
    let last: Awaited<ReturnType<typeof getOrCreateAgentSession>> = first
    while (t < t0 + AGENT_SESSION_ABSOLUTE_TTL_MS) {
      t += 20 * 60 * 60 * 1000
      last = await getOrCreateAgentSession(env, input, t)
    }

    // The original row is now dead — it must NOT still read as live.
    const originalRow = await loadAgentSessionById(env, TENANT, firstId)
    expect(evaluateAgentSession(originalRow!, t).ok).toBe(false)
    expect(originalRow?.revoked_at).not.toBeNull()
    expect(originalRow?.revoke_reason).toBe('auto_expired_absolute')

    // But the SAME still-valid credential got a FRESH session id rather than
    // being permanently locked out — ordinary standing access continues.
    expect(last?.session.id).not.toBe(firstId)
    expect(last?.rotatedFromId).toBe(firstId)
    expect(evaluateAgentSession(last!.session, t).ok).toBe(true)

    // Any hypothetical elevation bound to the OLD exact session id is now
    // unreachable through the live-credential lookup — it can only resolve
    // to the NEW id going forward.
    const liveNow = await loadLiveAgentSessionByCredential(env, TENANT, 'workspace_token', 'token-1')
    expect(liveNow?.id).toBe(last?.session.id)
  })

  // ── listAgentSessions ────────────────────────────────────────────────────

  it('listAgentSessions: newest first, scoped to (tenant, agent) — never leaks another agent', async () => {
    const t0 = Date.parse('2026-09-01T00:00:00.000Z')
    await createAgentSession(env, { tenant: TENANT, agentId: AGENT_A, memberId: MEMBER_A, authKind: 'workspace_token', credentialId: 'token-1' }, t0)
    await createAgentSession(env, { tenant: TENANT, agentId: AGENT_A, memberId: MEMBER_A, authKind: 'workspace_token', credentialId: 'token-2' }, t0 + 1000)
    await createAgentSession(env, { tenant: TENANT, agentId: AGENT_B, memberId: MEMBER_B, authKind: 'workspace_token', credentialId: 'token-3' }, t0)

    const rows = await listAgentSessions(env, TENANT, AGENT_A)
    expect(rows).toHaveLength(2)
    expect(rows[0].credential_id).toBe('token-2') // newest first
    expect(rows.every((r) => r.agent_id === AGENT_A)).toBe(true)
  })

  it('listAgentSessions includes revoked rows as history, not just current', async () => {
    const created = await createAgentSession(env, { tenant: TENANT, agentId: AGENT_A, memberId: MEMBER_A, authKind: 'workspace_token', credentialId: 'token-1' })
    await revokeAgentSessionById(env, TENANT, AGENT_A, created.id, 'test')
    const rows = await listAgentSessions(env, TENANT, AGENT_A)
    expect(rows).toHaveLength(1)
    expect(rows[0].revoked_at).not.toBeNull()
  })

  // ── revoke primitives ────────────────────────────────────────────────────

  it('revokeAgentSessionById is scoped to (tenant, agent_id, id) — cannot revoke a DIFFERENT agent\'s session by guessing its id', async () => {
    const created = await createAgentSession(env, { tenant: TENANT, agentId: AGENT_A, memberId: MEMBER_A, authKind: 'workspace_token', credentialId: 'token-1' })
    const { revoked } = await revokeAgentSessionById(env, TENANT, AGENT_B, created.id, 'wrong_agent')
    expect(revoked).toBe(false)
    const row = await loadAgentSessionById(env, TENANT, created.id)
    expect(row?.revoked_at).toBeNull()
  })

  it('revokeAgentSessionById is idempotent: revoking an already-revoked row reports revoked:false, never an error', async () => {
    const created = await createAgentSession(env, { tenant: TENANT, agentId: AGENT_A, memberId: MEMBER_A, authKind: 'workspace_token', credentialId: 'token-1' })
    const first = await revokeAgentSessionById(env, TENANT, AGENT_A, created.id, 'first')
    const second = await revokeAgentSessionById(env, TENANT, AGENT_A, created.id, 'second')
    expect(first.revoked).toBe(true)
    expect(second.revoked).toBe(false)
  })

  it('revokeAgentSessionByCredential (the agent self-revoke primitive) needs no id — it targets exactly the live row for that credential', async () => {
    const created = await createAgentSession(env, { tenant: TENANT, agentId: AGENT_A, memberId: MEMBER_A, authKind: 'workspace_token', credentialId: 'token-1' })
    const { revoked, sessionId } = await revokeAgentSessionByCredential(env, TENANT, 'workspace_token', 'token-1', 'agent_self_revoke')
    expect(revoked).toBe(true)
    expect(sessionId).toBe(created.id)
  })

  it('revokeAgentSessionByCredential: no session found for an unknown credential reports revoked:false, sessionId:null (no oracle)', async () => {
    const result = await revokeAgentSessionByCredential(env, TENANT, 'workspace_token', 'never-existed', 'agent_self_revoke')
    expect(result).toEqual({ revoked: false, sessionId: null })
  })

  it('revokeAllAgentSessionsForAgent revokes every live session for that agent and none of another agent\'s', async () => {
    const a1 = await createAgentSession(env, { tenant: TENANT, agentId: AGENT_A, memberId: MEMBER_A, authKind: 'workspace_token', credentialId: 'token-a1' })
    const a2 = await createAgentSession(env, { tenant: TENANT, agentId: AGENT_A, memberId: MEMBER_A, authKind: 'oauth', credentialId: 'token-a2' })
    const b1 = await createAgentSession(env, { tenant: TENANT, agentId: AGENT_B, memberId: MEMBER_B, authKind: 'workspace_token', credentialId: 'token-b1' })

    const { revokedCount } = await revokeAllAgentSessionsForAgent(env, TENANT, AGENT_A, 'agent_deactivated')
    expect(revokedCount).toBe(2)

    expect((await loadAgentSessionById(env, TENANT, a1.id))?.revoked_at).not.toBeNull()
    expect((await loadAgentSessionById(env, TENANT, a2.id))?.revoked_at).not.toBeNull()
    expect((await loadAgentSessionById(env, TENANT, b1.id))?.revoked_at).toBeNull()
  })

  // ── resolveAgentSessionContext (pure) ───────────────────────────────────

  function makeAuth(overrides: Partial<AuthContext> = {}): AuthContext {
    return {
      userId: MEMBER_A,
      email: null,
      role: 'member',
      tenant: TENANT,
      memberId: MEMBER_A,
      channel: 'workspace',
      boundAgentId: AGENT_A,
      tokenId: 'token-1',
      ...overrides,
    }
  }

  it('resolveAgentSessionContext: not_agent_session for a pure human/operator principal (no boundAgentId)', () => {
    const result = resolveAgentSessionContext(makeAuth({ boundAgentId: null }))
    expect(result).toEqual({ ok: false, reason: 'not_agent_session' })
  })

  it('resolveAgentSessionContext: not_agent_session when there is no live tokenId', () => {
    const result = resolveAgentSessionContext(makeAuth({ tokenId: null }))
    expect(result).toEqual({ ok: false, reason: 'not_agent_session' })
  })

  it('resolveAgentSessionContext: not_agent_session for an unrecognized channel', () => {
    const result = resolveAgentSessionContext(makeAuth({ channel: undefined }))
    expect(result).toEqual({ ok: false, reason: 'not_agent_session' })
  })

  it('resolveAgentSessionContext: derives workspace_token for workspace/im/dashboard channels, oauth for directory', () => {
    expect(deriveAgentAuthKind('workspace')).toBe('workspace_token')
    expect(deriveAgentAuthKind('im')).toBe('workspace_token')
    expect(deriveAgentAuthKind('dashboard')).toBe('workspace_token')
    expect(deriveAgentAuthKind('directory')).toBe('oauth')
  })

  it('resolveAgentSessionContext: everything is derived from auth, args are never trusted for identity', () => {
    const result = resolveAgentSessionContext(makeAuth(), '  my-laptop  ')
    expect(result).toEqual({
      ok: true,
      context: {
        authKind: 'workspace_token',
        credentialId: 'token-1',
        agentId: AGENT_A,
        memberId: MEMBER_A,
        seat: 'my-laptop',
      },
    })
  })

  // ── missing-table graceful degradation (migration 0141 not applied yet) ──

  describe('when migration 0141 has not been applied yet', () => {
    let preMigrationHarness: SqliteD1Harness
    let preMigrationEnv: Env

    beforeEach(() => {
      preMigrationHarness = createSqliteD1()
      // Apply every REAL migration file EXCEPT this module's own — this is
      // still the real migration chain, just stopped one file short, which
      // is exactly the "branch merged, migration not yet applied" scenario
      // this task's boundary describes. Never a hand-written schema.
      for (const file of migrationFiles()) {
        if (file === '0141_agent_sessions.sql') continue
        preMigrationHarness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
      }
      preMigrationEnv = { TENANT_SLUG: TENANT, DB: preMigrationHarness.db } as unknown as Env
    })

    afterEach(() => preMigrationHarness.close())

    it('loadLiveAgentSessionByCredential returns null instead of throwing', async () => {
      await expect(
        loadLiveAgentSessionByCredential(preMigrationEnv, TENANT, 'workspace_token', 'token-1'),
      ).resolves.toBeNull()
    })

    it('getOrCreateAgentSession returns null instead of throwing (no session tracking yet, request still succeeds)', async () => {
      await expect(
        getOrCreateAgentSession(preMigrationEnv, {
          tenant: TENANT, agentId: AGENT_A, memberId: MEMBER_A, authKind: 'workspace_token', credentialId: 'token-1',
        }),
      ).resolves.toBeNull()
    })

    it('touchAgentSession is a silent no-op instead of throwing', async () => {
      await expect(touchAgentSession(preMigrationEnv, 'whatever')).resolves.toBeUndefined()
    })

    it('revokeAllAgentSessionsForAgent (deactivate_agent\'s call site) reports zero instead of throwing', async () => {
      await expect(
        revokeAllAgentSessionsForAgent(preMigrationEnv, TENANT, AGENT_A, 'agent_deactivated'),
      ).resolves.toEqual({ revokedCount: 0 })
    })

    it('revokeAgentSessionByCredentialSafe (revoke_agent_token\'s call site) reports not-revoked instead of throwing', async () => {
      await expect(
        revokeAgentSessionByCredentialSafe(preMigrationEnv, TENANT, 'workspace_token', 'token-1', 'token_revoked'),
      ).resolves.toEqual({ revoked: false, sessionId: null })
    })
  })
})
