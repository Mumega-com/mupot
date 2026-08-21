// tests/agent-bound-oauth-consent.test.ts — mupot#903b: agent-bound OAuth sessions.
//
// THE PROBLEM (src/mcp/oauth-authorize.ts, before this change): a directory-channel
// OAuth seat (claude.ai / ChatGPT / Claude Desktop, connected via /authorize) was
// force-zeroed AND force-unbound — `capabilities = []`, `boundAgentId = null` —
// REGARDLESS of what the connecting human held or explicitly wanted to hand the
// connector. The B1 ceiling's INTENT (a public OAuth door must never silently
// inherit a human's standing grants) is correct and MUST survive this change; these
// tests pin it from both directions.
//
// THE FIX: a consent screen between the Google callback and completeAuthorization
// lets the human explicitly choose ONE agent. Selection is authorized via the SAME
// `canOnSquad` primitive that already gates the `connect` tool's agent-claim check
// (src/mcp/index.ts toolConnect) — not a new rule. The session's capabilities
// become the CHOSEN AGENT's own capability set (via agent_member_bindings — a
// member row dedicated to that agent, isolated from the human's own `capabilities`
// rows), never the human's, and never more than the agent itself holds.
//
// Sections:
//   A. listConsentableAgents / memberMayConsentToAgent — the selection rule
//   B. buildAuthContextFromProps — the capability invariants (unbound unchanged,
//      consented = agent's own grants, never human's, deactivation kills it)
//   C. The HTTP flow — GET /oauth/google-callback renders consent, POST
//      /oauth/consent re-validates + completes (or declines, cleanly)

import { readFileSync } from 'node:fs'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import {
  buildAuthContextFromProps,
  handleOAuthAuthorize,
  listConsentableAgents,
  listConsentableSquads,
  memberMayConsentToAgent,
} from '../src/mcp/oauth-authorize'
import { invokeTool, mcpApp } from '../src/mcp/index'
import { AUTH_CONTEXT_HEADER } from '../src/mcp/auth-header'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'

const TENANT = 'mumega'

// ── shared fixture ───────────────────────────────────────────────────────────
//
//   dept-eng
//     squad-a  (agent-a: bound + active — the ONE agent the human may consent to
//               by default; human holds 'member' here)
//     squad-b  (agent-b: bound + active — human has NO access here)
//     squad-c  (agent-e: bound + active — human has NO DEFAULT access; used only
//               by the P0-1 clamp tests, which grant it explicitly per-test)
//   agent-c on squad-a: NEVER minted (no agent_member_bindings row) — nothing to
//     consent to, excluded even though the human has squad-a access.
//   agent-d on squad-a: bound but status='inactive' — a tombstone, excluded.
//   agent-e on squad-c: bound + active, but its OWN dedicated member holds
//     'admin' on squad-c — ABOVE what 'member'-or-higher eligibility requires.
//     This is the root-cause fixture the 2026-08-10 adversarial review named
//     explicitly: "every test gives the agent and the human IDENTICAL grants...
//     the whole class 'the agent holds more than you' is invisible to your
//     suite." Kept off the default listing (squad-c, no default human access) so
//     it cannot silently change any pre-existing assertion — only tests that
//     explicitly grant squad-c access see it.
//
// human-1 holds 'member' on squad-a only (by default). member-agent-a /
// member-agent-b / member-agent-e are the DEDICATED member rows created at each
// agent's first mint (agent_member_bindings).

const HUMAN = 'member-human-1'
const AGENT_A = { id: 'agent-a', slug: 'agent-a', name: 'Agent A', squad_id: 'squad-a' }
const AGENT_B = { id: 'agent-b', slug: 'agent-b', name: 'Agent B', squad_id: 'squad-b' }
const AGENT_C = { id: 'agent-c', slug: 'agent-c', name: 'Agent C', squad_id: 'squad-a' }
const AGENT_D = { id: 'agent-d', slug: 'agent-d', name: 'Agent D', squad_id: 'squad-a' }
const AGENT_E = { id: 'agent-e', slug: 'agent-e', name: 'Agent E', squad_id: 'squad-c' }
const MEMBER_AGENT_A = 'member-agent-a'
const MEMBER_AGENT_B = 'member-agent-b'
const MEMBER_AGENT_D = 'member-agent-d'
const MEMBER_AGENT_E = 'member-agent-e'

function seedBase(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    INSERT INTO org_settings (key, value, updated_at) VALUES ('billing_state', '{"tier":"scale"}', '2026-08-01T00:00:00.000Z');
    INSERT INTO departments (id, slug, name) VALUES ('dept-eng', 'eng', 'Engineering');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-eng', 'squad-a', 'Squad A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-b', 'dept-eng', 'squad-b', 'Squad B');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-c', 'dept-eng', 'squad-c', 'Squad C');

    INSERT INTO agents (id, squad_id, slug, name, status, autonomy, budget_cap_cents, budget_window)
      VALUES ('${AGENT_A.id}', '${AGENT_A.squad_id}', '${AGENT_A.slug}', '${AGENT_A.name}', 'active', 'execute', 5000, 'week');
    INSERT INTO agents (id, squad_id, slug, name, status)
      VALUES ('${AGENT_B.id}', '${AGENT_B.squad_id}', '${AGENT_B.slug}', '${AGENT_B.name}', 'active');
    INSERT INTO agents (id, squad_id, slug, name, status)
      VALUES ('${AGENT_C.id}', '${AGENT_C.squad_id}', '${AGENT_C.slug}', '${AGENT_C.name}', 'active');
    INSERT INTO agents (id, squad_id, slug, name, status)
      VALUES ('${AGENT_D.id}', '${AGENT_D.squad_id}', '${AGENT_D.slug}', '${AGENT_D.name}', 'inactive');
    INSERT INTO agents (id, squad_id, slug, name, status)
      VALUES ('${AGENT_E.id}', '${AGENT_E.squad_id}', '${AGENT_E.slug}', '${AGENT_E.name}', 'active');

    INSERT INTO members (id, email, display_name, status, created_at, tenant)
      VALUES ('${HUMAN}', 'human@example.test', 'Human', 'active', '2026-08-01T00:00:00.000Z', '${TENANT}');
    INSERT INTO members (id, email, display_name, status, created_at, tenant)
      VALUES ('${MEMBER_AGENT_A}', NULL, '${AGENT_A.name}', 'active', '2026-08-01T00:00:00.000Z', '${TENANT}');
    INSERT INTO members (id, email, display_name, status, created_at, tenant)
      VALUES ('${MEMBER_AGENT_B}', NULL, '${AGENT_B.name}', 'active', '2026-08-01T00:00:00.000Z', '${TENANT}');
    INSERT INTO members (id, email, display_name, status, created_at, tenant)
      VALUES ('${MEMBER_AGENT_D}', NULL, '${AGENT_D.name}', 'active', '2026-08-01T00:00:00.000Z', '${TENANT}');
    INSERT INTO members (id, email, display_name, status, created_at, tenant)
      VALUES ('${MEMBER_AGENT_E}', NULL, '${AGENT_E.name}', 'active', '2026-08-01T00:00:00.000Z', '${TENANT}');

    -- agent-c has NO binding row — unminted, nothing to consent to.
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('${TENANT}', '${AGENT_A.id}', '${MEMBER_AGENT_A}', '2026-08-01T00:00:00.000Z');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('${TENANT}', '${AGENT_B.id}', '${MEMBER_AGENT_B}', '2026-08-01T00:00:00.000Z');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('${TENANT}', '${AGENT_D.id}', '${MEMBER_AGENT_D}', '2026-08-01T00:00:00.000Z');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('${TENANT}', '${AGENT_E.id}', '${MEMBER_AGENT_E}', '2026-08-01T00:00:00.000Z');

    -- Each agent's OWN capability set — the escalation-guarded home-squad grant,
    -- exactly what prepareAgentBoundTokenMintForBinding would have written.
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-a-home', '${MEMBER_AGENT_A}', 'squad', '${AGENT_A.squad_id}', 'member');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-b-home', '${MEMBER_AGENT_B}', 'squad', '${AGENT_B.squad_id}', 'member');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-d-home', '${MEMBER_AGENT_D}', 'squad', '${AGENT_D.squad_id}', 'member');
    -- agent-e: legitimately granted 'admin' on its OWN home squad (setAgentSquadAccess
    -- permits up to 'admin' for an agent-bound member — src/members/index.ts) — ABOVE
    -- the 'member' floor every other fixture agent uses. This is the outranking case.
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-e-home', '${MEMBER_AGENT_E}', 'squad', '${AGENT_E.squad_id}', 'admin');

    -- The HUMAN's own standing grants: squad-a ADMIN access (P0-3, adversarial
    -- review 2026-08-10 — the floor to WELD an OAuth session to an agent is
    -- 'admin', matching mint_agent_token, the only other producer of that weld;
    -- 'member' is no longer sufficient to consent at all — see section D0),
    -- PLUS an unrelated org:owner grant — this is the human's OWN authority and
    -- must never leak into a consented session's capabilities.
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-human-squad-a', '${HUMAN}', 'squad', '${AGENT_A.squad_id}', 'admin');
  `)
}

function envFor(harness: SqliteD1Harness, extra: Record<string, unknown> = {}): Env {
  return {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    BUS: { send: async () => {} },
    ...extra,
  } as unknown as Env
}

let harness: SqliteD1Harness

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  seedBase(harness.sqlite)
})

afterEach(() => {
  harness.close()
  vi.unstubAllGlobals()
})

// ════════════════════════════════════════════════════════════════════════════
// A. Selection rule — listConsentableAgents / memberMayConsentToAgent
// ════════════════════════════════════════════════════════════════════════════

describe('A. selection rule — a human may consent to agent A iff active + bound + squad access', () => {
  it('lists exactly the eligible agent: excludes no-access, unminted, and inactive', async () => {
    const env = envFor(harness)
    const list = await listConsentableAgents(env, HUMAN)
    expect(list.map((a) => a.id)).toEqual([AGENT_A.id])
  })

  it('the capability preview shown for the eligible agent is EXACTLY its own grant set', async () => {
    const env = envFor(harness)
    const list = await listConsentableAgents(env, HUMAN)
    expect(list[0].capabilities).toEqual([
      { member_id: MEMBER_AGENT_A, scope_type: 'squad', scope_id: AGENT_A.squad_id, capability: 'member' },
    ])
    // The human's own org:owner-shaped standing grant (if any were seeded) must never
    // appear here — this preview is the agent's grant set, not the human's.
    expect(list[0].capabilities.some((c) => c.capability === 'owner')).toBe(false)
  })

  it('org-wide grant on the human sees every active, bound agent (inheritance, same as canOnSquad)', async () => {
    harness.sqlite.exec(`
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-human-org', '${HUMAN}', 'org', NULL, 'admin');
    `)
    const env = envFor(harness)
    const list = await listConsentableAgents(env, HUMAN)
    // Includes agent-e (squad-c) too — an org grant covers every scope, same as
    // canOnSquad's own inheritance. Its capability PREVIEW is separately pinned by
    // section D (clamped to the human's rank, never agent-e's raw 'admin').
    expect(list.map((a) => a.id).sort()).toEqual([AGENT_A.id, AGENT_B.id, AGENT_E.id].sort())
  })

  it('memberMayConsentToAgent: true for the eligible agent', async () => {
    const env = envFor(harness)
    expect(await memberMayConsentToAgent(env, HUMAN, AGENT_A.id)).toBe(true)
  })

  it('memberMayConsentToAgent: false — human has no squad access on agent-b', async () => {
    const env = envFor(harness)
    expect(await memberMayConsentToAgent(env, HUMAN, AGENT_B.id)).toBe(false)
  })

  it('memberMayConsentToAgent: false — agent-c is unminted (no agent_member_bindings row)', async () => {
    const env = envFor(harness)
    expect(await memberMayConsentToAgent(env, HUMAN, AGENT_C.id)).toBe(false)
  })

  it('memberMayConsentToAgent: false — agent-d is inactive (tombstone)', async () => {
    const env = envFor(harness)
    expect(await memberMayConsentToAgent(env, HUMAN, AGENT_D.id)).toBe(false)
  })

  it('memberMayConsentToAgent: false — nonexistent agent id (fail closed, not a lookup crash)', async () => {
    const env = envFor(harness)
    expect(await memberMayConsentToAgent(env, HUMAN, 'no-such-agent')).toBe(false)
  })

  it('a human with ZERO grants is offered nothing', async () => {
    const env = envFor(harness)
    const list = await listConsentableAgents(env, 'member-nobody')
    expect(list).toEqual([])
    expect(await memberMayConsentToAgent(env, 'member-nobody', AGENT_A.id)).toBe(false)
  })

  it('memberMayConsentToAgent: false — a binding for this agent exists ONLY in a DIFFERENT tenant (resolveAgentForConsent\'s `b.tenant = ?2` join, adversarial review 2026-08-10 — untested before this)', async () => {
    // agent-f exists (globally — agents carries no tenant column at all, see the
    // mintMemberId design comment above), active, but has NO agent_member_bindings
    // row in OUR tenant ('mumega') — only in a hypothetical other tenant sharing
    // the same D1. Without the tenant-scoped JOIN, resolveAgentForConsent would
    // find that OTHER tenant's binding and treat agent-f as legitimately minted.
    harness.sqlite.exec(`
      INSERT INTO agents (id, squad_id, slug, name, status)
        VALUES ('agent-f', '${AGENT_A.squad_id}', 'agent-f', 'Agent F', 'active');
      INSERT INTO members (id, email, display_name, status, created_at, tenant)
        VALUES ('member-agent-f-other-tenant', NULL, 'Agent F (other tenant)', 'active', '2026-08-01T00:00:00.000Z', 'other-tenant');
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
        VALUES ('other-tenant', 'agent-f', 'member-agent-f-other-tenant', '2026-08-01T00:00:00.000Z');
    `)
    const env = envFor(harness)
    expect(await memberMayConsentToAgent(env, HUMAN, 'agent-f')).toBe(false)
    const list = await listConsentableAgents(env, HUMAN)
    expect(list.map((a) => a.id)).not.toContain('agent-f')
  })
})

describe('A2. listConsentableSquads — squads where human holds admin to mint an agent seat', () => {
  it('an admin human on squad-a sees squad-a in listConsentableSquads', async () => {
    const env = envFor(harness)
    const squads = await listConsentableSquads(env, HUMAN)
    expect(squads.map((s) => s.id)).toContain('squad-a')
    expect(squads.map((s) => s.id)).not.toContain('squad-b')
  })

  it('a member-only human on squad-a sees no squads to mint in', async () => {
    harness.sqlite.exec(`
      UPDATE capabilities SET capability = 'member' WHERE member_id = '${HUMAN}' AND scope_id = 'squad-a'
    `)
    const env = envFor(harness)
    const squads = await listConsentableSquads(env, HUMAN)
    expect(squads).toEqual([])
  })
})

// ════════════════════════════════════════════════════════════════════════════
// B. buildAuthContextFromProps — the hard capability invariants
// ════════════════════════════════════════════════════════════════════════════

/** Inserts a member_tokens row exactly as mintDirectoryToken would.
 *
 *  `memberId` here must be the row's ACTUAL member_id — for an agent-bound row that
 *  is the agent's own dedicated member (e.g. MEMBER_AGENT_A), never the connecting
 *  human. Migration 0071's `member_tokens_agent_binding_insert` trigger enforces this
 *  at the schema level: it raises `agent_identity_conflict` on any INSERT where
 *  agent_id IS NOT NULL and (tenant, agent_id, member_id) is not already a row in
 *  agent_member_bindings — and that table only ever pairs an agent with its own weld,
 *  never an arbitrary human. See "the DB itself refuses..." test in B3 below, which
 *  asserts this trigger fires for exactly the shape this helper must never construct. */
function insertDirectoryToken(
  sqlite: SqliteD1Harness['sqlite'],
  tokenId: string,
  memberId: string,
  agentId: string | null,
): void {
  sqlite.exec(
    `INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
     VALUES ('${tokenId}', '${memberId}', 'hash-${tokenId}', 'oauth:test', 'directory', '2026-08-01T00:00:00.000Z', ${agentId ? `'${agentId}'` : 'NULL'}, '${TENANT}')`,
  )
}

describe('B1. unbound directory session — byte-for-byte unchanged (the hard requirement)', () => {
  it('capabilities=[], boundAgentId=null, latentCapabilities=the human\'s real grants — full object', async () => {
    const env = envFor(harness)
    insertDirectoryToken(harness.sqlite, 'tok-unbound', HUMAN, null)

    const auth = await buildAuthContextFromProps(env, {
      memberId: HUMAN, tokenId: 'tok-unbound', email: 'human@example.test',
    })

    expect(auth).toEqual({
      userId: HUMAN,
      email: 'human@example.test',
      role: 'member',
      tenant: TENANT,
      memberId: HUMAN,
      channel: 'directory',
      capabilities: [],
      boundAgentId: null,
      consentedByMemberId: null,
      latentCapabilities: [
        { member_id: HUMAN, scope_type: 'squad', scope_id: AGENT_A.squad_id, capability: 'admin' },
      ],
      // mupot#847 (rebased onto this test, kasra-git 2026-08-14): buildAuthContextFromProps
      // now always echoes back the live-verified token id — see oauth-authorize.ts's
      // `tokenId: props.tokenId` and the comment above it ("live row was re-read above").
      // Genuinely new field, not a regression of "byte-for-byte unchanged" — the token row
      // read at the top of this function (tokenRow) already re-verifies props.tokenId is
      // live before this function returns at all, so exposing it here adds no new trust.
      tokenId: 'tok-unbound',
    })
  })
})

describe('B2. consent-bound session gets EXACTLY the chosen agent\'s own capabilities', () => {
  // Every token here mints under MEMBER_AGENT_A (the agent's OWN dedicated member),
  // never HUMAN — see insertDirectoryToken's doc comment for why HUMAN+agent_id is a
  // schema-level impossibility (0071's member_tokens_agent_binding_insert trigger).
  // buildAuthContextFromProps.props.memberId must match the row's actual member_id
  // (same rule the real /oauth/consent handler follows — see mintMemberId there).

  it('capabilities === the agent\'s own grant set (not empty, not the human\'s)', async () => {
    const env = envFor(harness)
    insertDirectoryToken(harness.sqlite, 'tok-bound', MEMBER_AGENT_A, AGENT_A.id)

    const auth = await buildAuthContextFromProps(env, {
      memberId: MEMBER_AGENT_A, tokenId: 'tok-bound', email: 'human@example.test',
      consentedByMemberId: HUMAN,
    })

    expect(auth).not.toBeNull()
    expect(auth!.boundAgentId).toBe(AGENT_A.id)
    expect(auth!.capabilities).toEqual([
      { member_id: MEMBER_AGENT_A, scope_type: 'squad', scope_id: AGENT_A.squad_id, capability: 'member' },
    ])
  })

  it('NEVER the human\'s standing grants — human org:owner does not leak into the session', async () => {
    harness.sqlite.exec(`
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-human-org-owner', '${HUMAN}', 'org', NULL, 'owner');
    `)
    const env = envFor(harness)
    insertDirectoryToken(harness.sqlite, 'tok-bound-2', MEMBER_AGENT_A, AGENT_A.id)

    const auth = await buildAuthContextFromProps(env, {
      memberId: MEMBER_AGENT_A, tokenId: 'tok-bound-2', email: 'human@example.test',
      consentedByMemberId: HUMAN,
    })

    expect(auth!.capabilities.some((c) => c.capability === 'owner')).toBe(false)
    expect(auth!.capabilities.some((c) => c.scope_type === 'org')).toBe(false)
    // Provably NOT ambient-org-admin: a directory seat bound to agent-a still
    // cannot act on squad-b, which the human's (irrelevant, unused) org grant
    // would otherwise cover.
    const out = await invokeTool(auth!, env, 'task_create', {
      squad_id: AGENT_B.squad_id, title: 'sneaky', done_when: 'check done',
    }, 'https://pot.test')
    expect((out as { error?: string }).error).toBe('forbidden')
  })

  it('NEVER more than the agent holds — a grant on a squad the human belongs to but the agent does not stays out', async () => {
    // Human also has member access to squad-b (separately from agent-a's squad).
    // agent-a's own grant set is unaffected — it only ever reflects agent-a's OWN
    // agent_member_bindings row, never the connecting human's unrelated grants.
    harness.sqlite.exec(`
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-human-squad-b', '${HUMAN}', 'squad', '${AGENT_B.squad_id}', 'admin');
    `)
    const env = envFor(harness)
    insertDirectoryToken(harness.sqlite, 'tok-bound-3', MEMBER_AGENT_A, AGENT_A.id)

    const auth = await buildAuthContextFromProps(env, {
      memberId: MEMBER_AGENT_A, tokenId: 'tok-bound-3', email: 'human@example.test',
      consentedByMemberId: HUMAN,
    })
    expect(auth!.capabilities.some((c) => c.scope_id === AGENT_B.squad_id)).toBe(false)
  })

  it('end-to-end: the bound session can actually act with the agent\'s capability (task_create on its own squad)', async () => {
    const env = envFor(harness)
    insertDirectoryToken(harness.sqlite, 'tok-bound-4', MEMBER_AGENT_A, AGENT_A.id)
    const auth = await buildAuthContextFromProps(env, {
      memberId: MEMBER_AGENT_A, tokenId: 'tok-bound-4', email: 'human@example.test',
      consentedByMemberId: HUMAN,
    })
    const out = await invokeTool(auth!, env, 'task_create', {
      squad_id: AGENT_A.squad_id, title: 'via consented session', done_when: 'check done',
    }, 'https://pot.test')
    expect((out as { ok?: boolean }).ok).toBe(true)
  })
})

describe('B3. deactivating the agent kills the session\'s authority', () => {
  it('(a) via the real deactivate_agent tool: the token is revoked, the session dies entirely (401-equivalent null)', async () => {
    const env = envFor(harness)
    insertDirectoryToken(harness.sqlite, 'tok-to-kill', MEMBER_AGENT_A, AGENT_A.id)

    // Confirm the session is live before deactivation.
    const before = await buildAuthContextFromProps(env, {
      memberId: MEMBER_AGENT_A, tokenId: 'tok-to-kill', email: 'human@example.test',
      consentedByMemberId: HUMAN,
    })
    expect(before).not.toBeNull()
    expect(before!.capabilities.length).toBeGreaterThan(0)

    // Deactivate agent-a as an org-admin, through the real MCP tool — the same
    // path an operator uses in production.
    const orgAdmin: AuthContext = {
      userId: 'member-admin', email: 'admin@example.test', role: 'member', tenant: TENANT,
      memberId: 'member-admin', channel: 'workspace',
      capabilities: [{ member_id: 'member-admin', scope_type: 'org', scope_id: null, capability: 'admin' }],
      boundAgentId: null,
    }
    const deactivation = await invokeTool(orgAdmin, env, 'deactivate_agent', { agent: AGENT_A.id }, 'https://pot.test')
    expect((deactivation as { ok?: boolean }).ok).toBe(true)

    const after = await buildAuthContextFromProps(env, {
      memberId: MEMBER_AGENT_A, tokenId: 'tok-to-kill', email: 'human@example.test',
      consentedByMemberId: HUMAN,
    })
    expect(after).toBeNull()
  })

  it('(b) defence in depth: even if the token were somehow NOT revoked, an inactive agent grants ZERO capabilities', async () => {
    // Isolates the resolveConsentedAgentCapabilities status guard from the
    // token-revocation side effect above — flips agents.status directly, leaves
    // member_tokens untouched.
    const env = envFor(harness)
    insertDirectoryToken(harness.sqlite, 'tok-status-only', MEMBER_AGENT_A, AGENT_A.id)
    harness.sqlite.exec(`UPDATE agents SET status = 'inactive' WHERE id = '${AGENT_A.id}'`)

    const auth = await buildAuthContextFromProps(env, {
      memberId: MEMBER_AGENT_A, tokenId: 'tok-status-only', email: 'human@example.test',
      consentedByMemberId: HUMAN,
    })
    expect(auth).not.toBeNull() // token itself still live (member row untouched)
    expect(auth!.capabilities).toEqual([]) // but the agent's grant is gone
  })

  it('the DB schema itself refuses to mint a member_tokens row pointing at an unminted agent — the strongest form of "unminted grants zero"', () => {
    // agent-orphan has NO agent_member_bindings row (never went through
    // mint_agent_token). Earlier drafts of this suite tried to construct that state
    // as a LIVE token (agent_id set, capabilities expected []) — but that state is
    // not reachable at all: migration 0071's member_tokens_agent_binding_insert
    // trigger raises 'agent_identity_conflict' on any INSERT where agent_id IS NOT
    // NULL and (tenant, agent_id, member_id) is not already an agent_member_bindings
    // row, for ANY member_id (the agent's own or anyone else's). This is a schema-
    // level guarantee, stronger than an application-layer check: the row simply
    // cannot exist, so resolveConsentedAgentCapabilities's own `binding.kind !==
    // 'bound'` branch is unreachable defense-in-depth, not a load-bearing path.
    harness.sqlite.exec(
      `INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-orphan', '${AGENT_A.squad_id}', 'orphan', 'Orphan', 'active')`,
    )
    expect(() => insertDirectoryToken(harness.sqlite, 'tok-orphan', MEMBER_AGENT_A, 'agent-orphan'))
      .toThrow(/agent_identity_conflict/)
  })
})

describe('B4. non-directory channels are unaffected by any of this', () => {
  it('a workspace weld still gets its own live grants exactly as before', async () => {
    const env = envFor(harness)
    harness.sqlite.exec(
      `INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
       VALUES ('tok-workspace', '${MEMBER_AGENT_A}', 'hash-tok-workspace', 'laptop', 'workspace', '2026-08-01T00:00:00.000Z', '${AGENT_A.id}', '${TENANT}')`,
    )
    const auth = await buildAuthContextFromProps(env, {
      memberId: MEMBER_AGENT_A, tokenId: 'tok-workspace', email: null,
    })
    expect(auth!.channel).toBe('workspace')
    expect(auth!.boundAgentId).toBe(AGENT_A.id)
    expect(auth!.capabilities).toEqual([
      { member_id: MEMBER_AGENT_A, scope_type: 'squad', scope_id: AGENT_A.squad_id, capability: 'member' },
    ])
  })
})

// ════════════════════════════════════════════════════════════════════════════
// C. The HTTP flow — GET google-callback renders consent; POST consent completes
// ════════════════════════════════════════════════════════════════════════════

function memoryKv() {
  const store = new Map<string, string>()
  return {
    async get(key: string, type?: string) {
      const v = store.get(key)
      if (v === undefined) return null
      return type === 'json' ? JSON.parse(v) : v
    },
    async put(key: string, value: string) {
      store.set(key, value)
    },
    async delete(key: string) {
      store.delete(key)
    },
    _store: store,
  }
}

function stubOAuthProvider() {
  return {
    parseAuthRequest: vi.fn(async () => ({ clientId: 'client-1', scope: ['mcp:read', 'mcp:write'] })),
    completeAuthorization: vi.fn(async () => ({ redirectTo: 'https://client.example.test/callback?code=xyz' })),
  }
}

function stubGoogleFetch(email: string, googleId = 'google-sub-1') {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'gtok' }), { status: 200 })
    }
    if (url.includes('googleapis.com/oauth2/v2/userinfo')) {
      return new Response(
        JSON.stringify({ id: googleId, name: 'Human', email, verified_email: true }),
        { status: 200 },
      )
    }
    throw new Error(`unexpected fetch: ${url}`)
  }))
}

function httpEnv(harnessRef: SqliteD1Harness, oauthProvider: ReturnType<typeof stubOAuthProvider>) {
  const kv = memoryKv()
  const env = {
    DB: harnessRef.db,
    TENANT_SLUG: TENANT,
    BRAND: 'mupot',
    POT_TIER: 'scale',
    GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    SESSIONS: kv,
    OAUTH_PROVIDER: oauthProvider,
    BUS: { send: async () => {} },
  } as unknown as Env
  return { env, kv }
}

/** Drives GET /authorize then GET /oauth/google-callback, returns the consent page + cookies.
 *  Takes the CALLER's `env` (not a harness to build a fresh one from) — the consent
 *  record this writes to `env.SESSIONS` must be visible to whatever request the caller
 *  makes next against that SAME env/KV instance. Building a second, throwaway env here
 *  (as an earlier draft did) silently writes the pending-consent record to a KV Map the
 *  caller's later POST /oauth/consent never reads from — every C-suite test that
 *  continues past this screen would 400 with "Consent session expired or invalid",
 *  which is exactly the failure this comment exists to prevent regressing to. */
async function reachConsentScreen(
  env: Env,
  oauthProvider: ReturnType<typeof stubOAuthProvider>,
  email: string,
): Promise<{ res: Response; html: string; consentCookie: string }> {
  const authorizeReq = new Request(
    'https://pot.test/authorize?client_id=client-1&response_type=code&redirect_uri=https://client.example.test/callback&code_challenge=abc&code_challenge_method=S256',
  )
  const authorizeRes = await handleOAuthAuthorize(authorizeReq, env)
  const setCookie = authorizeRes.headers.get('Set-Cookie') ?? ''
  const nonceMatch = /mupot_oauth_nonce=([^;]+)/.exec(setCookie)
  const nonce = nonceMatch![1]

  stubGoogleFetch(email)
  const callbackReq = new Request(
    `https://pot.test/oauth/google-callback?code=abc&state=${nonce}`,
    { headers: { Cookie: `mupot_oauth_nonce=${nonce}` } },
  )
  const res = await handleOAuthAuthorize(callbackReq, env)
  const html = await res.clone().text()
  const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('Set-Cookie') ?? '']
  const consentCookieLine = cookies.find((c) => c.startsWith('mupot_oauth_consent=')) ?? ''
  const consentNonceMatch = /mupot_oauth_consent=([^;]+)/.exec(consentCookieLine)
  return { res, html, consentCookie: consentNonceMatch ? consentNonceMatch[1] : '' }
}

describe('C1. GET /oauth/google-callback renders the consent screen', () => {
  it('shows the eligible agent\'s slug, name, squad, autonomy, budget, and capabilities', async () => {
    const oauthProvider = stubOAuthProvider()
    const { env } = httpEnv(harness, oauthProvider)
    const { res, html } = await reachConsentScreen(env, oauthProvider, 'human@example.test')

    expect(res.status).toBe(200)
    expect(html).toContain(AGENT_A.slug)
    expect(html).toContain(AGENT_A.name)
    expect(html).toContain('Squad A')
    expect(html).toContain('execute') // autonomy
    expect(html).toContain('5000') // budget_cap_cents
    expect(html).toContain('week') // budget_window
    expect(html).toContain('member') // the capability grant preview
    // completeAuthorization must NOT have run yet — consent has not been given.
    expect(oauthProvider.completeAuthorization).not.toHaveBeenCalled()
  })

  it('does NOT show an agent the human has no squad access to', async () => {
    const oauthProvider = stubOAuthProvider()
    const { env } = httpEnv(harness, oauthProvider)
    const { html } = await reachConsentScreen(env, oauthProvider, 'human@example.test')
    expect(html).not.toContain(AGENT_B.slug)
  })

  it('always offers "continue unbound" as an explicit option', async () => {
    const oauthProvider = stubOAuthProvider()
    const { env } = httpEnv(harness, oauthProvider)
    const { html } = await reachConsentScreen(env, oauthProvider, 'human@example.test')
    expect(html.toLowerCase()).toContain('unbound')
  })

  it('requires an explicit user selection: none of the radio buttons are pre-checked, all have required', async () => {
    const oauthProvider = stubOAuthProvider()
    const { env } = httpEnv(harness, oauthProvider)
    const { html } = await reachConsentScreen(env, oauthProvider, 'human@example.test')
    // No radio input should be pre-checked (zero silent welds, zero silent unbound defaults)
    expect(html).not.toMatch(/<input[^>]*type="radio"[^>]*checked/)
    // All radio inputs must have required attribute
    const radioMatches = html.match(/<input[^>]*type="radio"[^>]*>/g) || []
    expect(radioMatches.length).toBeGreaterThan(0)
    for (const r of radioMatches) {
      expect(r).toContain('required')
    }
  })

  it('escapes agent name content — no stored-XSS via an admin-authored agent name', async () => {
    harness.sqlite.exec(
      `UPDATE agents SET name = '<script>alert(1)</script>' WHERE id = '${AGENT_A.id}'`,
    )
    const oauthProvider = stubOAuthProvider()
    const { env } = httpEnv(harness, oauthProvider)
    const { html } = await reachConsentScreen(env, oauthProvider, 'human@example.test')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

describe('C2. POST /oauth/consent — decline yields no token at all', () => {
  it('decline: completeAuthorization is never called, no member_tokens row is inserted', async () => {
    const oauthProvider = stubOAuthProvider()
    const { env } = httpEnv(harness, oauthProvider)
    const { consentCookie } = await reachConsentScreen(env, oauthProvider, 'human@example.test')

    const before = harness.sqlite.prepare('SELECT COUNT(*) AS n FROM member_tokens').all()[0].n

    const form = new URLSearchParams({ consent_nonce: consentCookie, action: 'decline', agent_id: AGENT_A.id })
    const declineReq = new Request('https://pot.test/oauth/consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `mupot_oauth_consent=${consentCookie}` },
      body: form.toString(),
    })
    const res = await handleOAuthAuthorize(declineReq, env)

    expect(res.status).toBe(200)
    expect(oauthProvider.completeAuthorization).not.toHaveBeenCalled()
    const after = harness.sqlite.prepare('SELECT COUNT(*) AS n FROM member_tokens').all()[0].n
    expect(after).toBe(before)
  })
})

describe('C3. POST /oauth/consent — continue without an agent preserves today\'s exact default', () => {
  it('empty agent_id mints an UNBOUND token, agent_id column NULL', async () => {
    const oauthProvider = stubOAuthProvider()
    const { env } = httpEnv(harness, oauthProvider)
    const { consentCookie } = await reachConsentScreen(env, oauthProvider, 'human@example.test')

    const form = new URLSearchParams({ consent_nonce: consentCookie, action: 'continue', agent_id: '' })
    const req = new Request('https://pot.test/oauth/consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `mupot_oauth_consent=${consentCookie}` },
      body: form.toString(),
    })
    const res = await handleOAuthAuthorize(req, env)

    expect(res.status).toBe(302)
    expect(oauthProvider.completeAuthorization).toHaveBeenCalledTimes(1)
    const call = oauthProvider.completeAuthorization.mock.calls[0][0]
    expect(call.props.boundAgentId).toBeNull()
    // Unbound stays the human's own member — unchanged from before mupot#903b.
    expect(call.props.memberId).toBe(HUMAN)

    const row = harness.sqlite.prepare(
      `SELECT agent_id, member_id FROM member_tokens WHERE channel = 'directory' ORDER BY created_at DESC LIMIT 1`,
    ).all()[0]
    expect(row.agent_id).toBeNull()
    expect(row.member_id).toBe(HUMAN)
  })
})

describe('C4. POST /oauth/consent — a valid agent_id mints an agent-bound token', () => {
  it('mints with agent_id set AND member_id = the AGENT\'s own dedicated member, never the human\'s', async () => {
    const oauthProvider = stubOAuthProvider()
    const { env } = httpEnv(harness, oauthProvider)
    const { consentCookie } = await reachConsentScreen(env, oauthProvider, 'human@example.test')

    const form = new URLSearchParams({ consent_nonce: consentCookie, action: 'continue', agent_id: AGENT_A.id })
    const req = new Request('https://pot.test/oauth/consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `mupot_oauth_consent=${consentCookie}` },
      body: form.toString(),
    })
    const res = await handleOAuthAuthorize(req, env)

    expect(res.status).toBe(302)
    const call = oauthProvider.completeAuthorization.mock.calls[0][0]
    expect(call.props.boundAgentId).toBe(AGENT_A.id)
    // The row this mints must satisfy 0071's member_tokens_agent_binding_insert
    // trigger — (tenant, agent_id, member_id) must already be an agent_member_bindings
    // row, which only ever pairs an agent with its OWN member. If this regressed back
    // to props.memberId = the human (the first draft's shape), THIS request would 500
    // (the trigger aborts the INSERT — proven live by this exact assertion failing
    // before the fix) rather than silently leaking the human's identity into the row.
    expect(call.props.memberId).toBe(MEMBER_AGENT_A)
    expect(call.props.memberId).not.toBe(HUMAN)

    const row = harness.sqlite.prepare(
      `SELECT agent_id, member_id FROM member_tokens WHERE channel = 'directory' ORDER BY created_at DESC LIMIT 1`,
    ).all()[0]
    expect(row.agent_id).toBe(AGENT_A.id)
    expect(row.member_id).toBe(MEMBER_AGENT_A)
  })

  it('P1-3 (adversarial review): writes an immutable consent receipt naming the HUMAN, the agent, and the minted token', async () => {
    const oauthProvider = stubOAuthProvider()
    const { env } = httpEnv(harness, oauthProvider)
    const { consentCookie } = await reachConsentScreen(env, oauthProvider, 'human@example.test')

    const form = new URLSearchParams({ consent_nonce: consentCookie, action: 'continue', agent_id: AGENT_A.id })
    const req = new Request('https://pot.test/oauth/consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `mupot_oauth_consent=${consentCookie}` },
      body: form.toString(),
    })
    await handleOAuthAuthorize(req, env)

    const receipt = harness.sqlite.prepare(
      `SELECT consenting_member_id, agent_id, agent_member_id, token_id FROM oauth_consent_receipts`,
    ).all()[0] as { consenting_member_id: string; agent_id: string; agent_member_id: string; token_id: string } | undefined
    expect(receipt).toBeDefined()
    expect(receipt!.consenting_member_id).toBe(HUMAN)
    expect(receipt!.agent_id).toBe(AGENT_A.id)
    expect(receipt!.agent_member_id).toBe(MEMBER_AGENT_A)

    const mintedTokenRow = harness.sqlite.prepare(
      `SELECT id FROM member_tokens WHERE channel = 'directory' ORDER BY created_at DESC LIMIT 1`,
    ).all()[0] as { id: string }
    expect(receipt!.token_id).toBe(mintedTokenRow.id)
  })

  it('the receipt is append-only: UPDATE and DELETE are both rejected by the schema', async () => {
    const oauthProvider = stubOAuthProvider()
    const { env } = httpEnv(harness, oauthProvider)
    const { consentCookie } = await reachConsentScreen(env, oauthProvider, 'human@example.test')
    const form = new URLSearchParams({ consent_nonce: consentCookie, action: 'continue', agent_id: AGENT_A.id })
    const req = new Request('https://pot.test/oauth/consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `mupot_oauth_consent=${consentCookie}` },
      body: form.toString(),
    })
    await handleOAuthAuthorize(req, env)

    expect(() => harness.sqlite.exec(
      `UPDATE oauth_consent_receipts SET consenting_member_id = 'someone-else'`,
    )).toThrow(/oauth_consent_receipts is append-only/)
    expect(() => harness.sqlite.exec(
      `DELETE FROM oauth_consent_receipts`,
    )).toThrow(/oauth_consent_receipts is append-only/)
  })
})

describe('C4b. POST /oauth/consent — continuing UNBOUND writes no consent receipt', () => {
  it('no agent chosen -> zero rows in oauth_consent_receipts (nothing to attest)', async () => {
    const oauthProvider = stubOAuthProvider()
    const { env } = httpEnv(harness, oauthProvider)
    const { consentCookie } = await reachConsentScreen(env, oauthProvider, 'human@example.test')
    const form = new URLSearchParams({ consent_nonce: consentCookie, action: 'continue', agent_id: '' })
    const req = new Request('https://pot.test/oauth/consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `mupot_oauth_consent=${consentCookie}` },
      body: form.toString(),
    })
    await handleOAuthAuthorize(req, env)

    const count = harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM oauth_consent_receipts`).all()[0] as { n: number }
    expect(count.n).toBe(0)
  })

  it('the schema ALSO refuses a receipt with a NULL agent_id — defense in depth beyond the app-level `if (boundAgentId)` guard', () => {
    // Mutation-check note: removing the `if (boundAgentId)` guard in the handler is
    // NOT independently detected by the test above — a receipt insert attempted for
    // an unbound consent would carry agent_id=NULL, and this NOT NULL constraint
    // throws inside the handler's own try/catch (best-effort, non-fatal), so no row
    // appears either way and that test still passes. This test pins the SCHEMA
    // guarantee directly, so at least one layer of "unbound writes no receipt" has
    // a mutation-resistant proof rather than two protections that happen to look
    // the same from outside.
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, created_at, tenant)
        VALUES ('member-unbound-probe', 'probe@example.test', 'Probe', 'active', '2026-08-01T00:00:00.000Z', '${TENANT}');
    `)
    expect(() => harness.sqlite.exec(
      `INSERT INTO oauth_consent_receipts (id, tenant, token_id, consenting_member_id, agent_id, agent_member_id, created_at)
       VALUES ('receipt-null-agent', '${TENANT}', 'tok-x', 'member-unbound-probe', NULL, 'member-x', datetime('now'))`,
    )).toThrow()
  })
})

describe('C4c. POST /oauth/consent — Mint-in-Chooser (__mint_new__)', () => {
  it('creates and binds a brand new agent seat when __mint_new__ is posted with valid squad admin grants', async () => {
    const oauthProvider = stubOAuthProvider()
    const { env } = httpEnv(harness, oauthProvider)
    const { consentCookie } = await reachConsentScreen(env, oauthProvider, 'human@example.test')

    const form = new URLSearchParams({
      consent_nonce: consentCookie,
      action: 'continue',
      agent_id: '__mint_new__',
      new_agent_name: 'Cursor Kasra',
      new_agent_slug: 'cursor-kasra',
      new_agent_squad_id: 'squad-a',
      new_agent_purpose: 'Cursor Agent seat on muvps',
    })
    const req = new Request('https://pot.test/oauth/consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `mupot_oauth_consent=${consentCookie}` },
      body: form.toString(),
    })
    const res = await handleOAuthAuthorize(req, env)
    const errText = res.status !== 302 ? await res.text() : ''
    expect(errText).toBe('')
    expect(res.status).toBe(302)
    const call = oauthProvider.completeAuthorization.mock.calls[0][0]
    expect(call.props.boundAgentId).toBeDefined()

    // Verify agent was created in DB
    const createdAgent = harness.sqlite.prepare(
      `SELECT id, slug, name, squad_id, purpose FROM agents WHERE slug = 'cursor-kasra'`,
    ).all()[0] as { id: string; slug: string; name: string; squad_id: string; purpose: string }
    expect(createdAgent).toBeDefined()
    expect(createdAgent.name).toBe('Cursor Kasra')
    expect(createdAgent.squad_id).toBe('squad-a')
    expect(createdAgent.purpose).toBe('Cursor Agent seat on muvps')

    expect(call.props.boundAgentId).toBe(createdAgent.id)

    // Verify dedicated member was created and bound
    const binding = harness.sqlite.prepare(
      `SELECT member_id FROM agent_member_bindings WHERE agent_id = ?`,
    ).all(createdAgent.id)[0] as { member_id: string }
    expect(binding).toBeDefined()
    expect(call.props.memberId).toBe(binding.member_id)

    // Verify receipt was written
    const receipt = harness.sqlite.prepare(
      `SELECT consenting_member_id, agent_id, agent_member_id FROM oauth_consent_receipts WHERE agent_id = ?`,
    ).all(createdAgent.id)[0] as { consenting_member_id: string; agent_id: string; agent_member_id: string }
    expect(receipt).toBeDefined()
    expect(receipt.consenting_member_id).toBe(HUMAN)
    expect(receipt.agent_id).toBe(createdAgent.id)
    expect(receipt.agent_member_id).toBe(binding.member_id)
  })

  it('rejects minting if human lacks admin capability on the chosen squad (403)', async () => {
    const oauthProvider = stubOAuthProvider()
    const { env } = httpEnv(harness, oauthProvider)
    const { consentCookie } = await reachConsentScreen(env, oauthProvider, 'human@example.test')

    const form = new URLSearchParams({
      consent_nonce: consentCookie,
      action: 'continue',
      agent_id: '__mint_new__',
      new_agent_name: 'Unauthorized Agent',
      new_agent_squad_id: 'squad-b', // human has no admin on squad-b
    })
    const req = new Request('https://pot.test/oauth/consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `mupot_oauth_consent=${consentCookie}` },
      body: form.toString(),
    })
    const res = await handleOAuthAuthorize(req, env)
    expect(res.status).toBe(403)
  })

  it('rejects minting if required fields are missing (400)', async () => {
    const oauthProvider = stubOAuthProvider()
    const { env } = httpEnv(harness, oauthProvider)
    const { consentCookie } = await reachConsentScreen(env, oauthProvider, 'human@example.test')

    const form = new URLSearchParams({
      consent_nonce: consentCookie,
      action: 'continue',
      agent_id: '__mint_new__',
      new_agent_name: '', // missing name
      new_agent_squad_id: 'squad-a',
    })
    const req = new Request('https://pot.test/oauth/consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `mupot_oauth_consent=${consentCookie}` },
      body: form.toString(),
    })
    const res = await handleOAuthAuthorize(req, env)
    expect(res.status).toBe(400)
  })
})

describe('C5. POST /oauth/consent — a tampered/ineligible agent_id is rejected server-side', () => {
  it('agent_id for a squad the human cannot reach → 403, no mint, no completeAuthorization', async () => {
    const oauthProvider = stubOAuthProvider()
    const { env } = httpEnv(harness, oauthProvider)
    const { consentCookie } = await reachConsentScreen(env, oauthProvider, 'human@example.test')
    const before = harness.sqlite.prepare('SELECT COUNT(*) AS n FROM member_tokens').all()[0].n

    // agent-b was never offered on the rendered screen — this simulates a client
    // that tampers with the posted form field directly.
    const form = new URLSearchParams({ consent_nonce: consentCookie, action: 'continue', agent_id: AGENT_B.id })
    const req = new Request('https://pot.test/oauth/consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `mupot_oauth_consent=${consentCookie}` },
      body: form.toString(),
    })
    const res = await handleOAuthAuthorize(req, env)

    expect(res.status).toBe(403)
    expect(oauthProvider.completeAuthorization).not.toHaveBeenCalled()
    const after = harness.sqlite.prepare('SELECT COUNT(*) AS n FROM member_tokens').all()[0].n
    expect(after).toBe(before)
  })

  it('agent-a\'s own dedicated member row is suspended → 403, no mint (memberMayConsentToAgent alone would pass — it never checks the BOUND member\'s status, only the human\'s grants and the agent\'s own; this is the handler\'s independent resolveAgentMemberBinding re-check catching what that first gate cannot)', async () => {
    harness.sqlite.exec(`UPDATE members SET status = 'suspended' WHERE id = '${MEMBER_AGENT_A}'`)

    const oauthProvider = stubOAuthProvider()
    const { env } = httpEnv(harness, oauthProvider)
    const { consentCookie } = await reachConsentScreen(env, oauthProvider, 'human@example.test')
    const before = harness.sqlite.prepare('SELECT COUNT(*) AS n FROM member_tokens').all()[0].n

    const form = new URLSearchParams({ consent_nonce: consentCookie, action: 'continue', agent_id: AGENT_A.id })
    const req = new Request('https://pot.test/oauth/consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `mupot_oauth_consent=${consentCookie}` },
      body: form.toString(),
    })
    const res = await handleOAuthAuthorize(req, env)

    expect(res.status).toBe(403)
    expect(oauthProvider.completeAuthorization).not.toHaveBeenCalled()
    const after = harness.sqlite.prepare('SELECT COUNT(*) AS n FROM member_tokens').all()[0].n
    expect(after).toBe(before)
  })
})

describe('C6. POST /oauth/consent — CSRF and replay protection', () => {
  it('mismatched consent cookie → 403, no mint', async () => {
    const oauthProvider = stubOAuthProvider()
    const { env } = httpEnv(harness, oauthProvider)
    const { consentCookie } = await reachConsentScreen(env, oauthProvider, 'human@example.test')

    const form = new URLSearchParams({ consent_nonce: consentCookie, action: 'continue', agent_id: '' })
    const req = new Request('https://pot.test/oauth/consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: 'mupot_oauth_consent=some-other-nonce' },
      body: form.toString(),
    })
    const res = await handleOAuthAuthorize(req, env)
    expect(res.status).toBe(403)
    expect(oauthProvider.completeAuthorization).not.toHaveBeenCalled()
  })

  it('replay: the same consent_nonce cannot be submitted twice', async () => {
    const oauthProvider = stubOAuthProvider()
    const { env } = httpEnv(harness, oauthProvider)
    const { consentCookie } = await reachConsentScreen(env, oauthProvider, 'human@example.test')

    const form = new URLSearchParams({ consent_nonce: consentCookie, action: 'continue', agent_id: '' })
    const makeReq = () => new Request('https://pot.test/oauth/consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `mupot_oauth_consent=${consentCookie}` },
      body: form.toString(),
    })

    const first = await handleOAuthAuthorize(makeReq(), env)
    expect(first.status).toBe(302)

    const second = await handleOAuthAuthorize(makeReq(), env)
    expect(second.status).toBe(400)
    expect(oauthProvider.completeAuthorization).toHaveBeenCalledTimes(1)
  })

  it('expired/unknown consent nonce → 400, no mint', async () => {
    const oauthProvider = stubOAuthProvider()
    const { env } = httpEnv(harness, oauthProvider)

    const form = new URLSearchParams({ consent_nonce: 'never-issued', action: 'continue', agent_id: '' })
    const req = new Request('https://pot.test/oauth/consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: 'mupot_oauth_consent=never-issued' },
      body: form.toString(),
    })
    const res = await handleOAuthAuthorize(req, env)
    expect(res.status).toBe(400)
    expect(oauthProvider.completeAuthorization).not.toHaveBeenCalled()
  })

  it('missing agent_id in POST body → 400, no mint (explicit choice required, zero silent unbound default)', async () => {
    const oauthProvider = stubOAuthProvider()
    const { env } = httpEnv(harness, oauthProvider)
    const { consentCookie } = await reachConsentScreen(env, oauthProvider, 'human@example.test')

    const before = (harness.sqlite.prepare('SELECT COUNT(*) AS n FROM member_tokens').all()[0] as { n: number }).n

    // Submit form WITHOUT agent_id parameter
    const form = new URLSearchParams({ consent_nonce: consentCookie, action: 'continue' })
    const req = new Request('https://pot.test/oauth/consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `mupot_oauth_consent=${consentCookie}` },
      body: form.toString(),
    })
    const res = await handleOAuthAuthorize(req, env)
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('Missing agent_id')
    expect(oauthProvider.completeAuthorization).not.toHaveBeenCalled()
    const after = (harness.sqlite.prepare('SELECT COUNT(*) AS n FROM member_tokens').all()[0] as { n: number }).n
    expect(after).toBe(before)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// D. P0-1 (adversarial review 2026-08-10) — capabilities clamp to the CONSENTING
// HUMAN's own live rank, never the agent's raw grant. Uses AGENT_E / MEMBER_AGENT_E,
// the fixture the review named as missing: "the agent holds more than you."
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// D0. P0-3 (adversarial review 2026-08-10, GATE DECISION) — the weld floor is
// ADMIN, not member. memberMayConsentToAgent writes a REAL member_tokens.agent_id
// weld (mintDirectoryToken) — the SAME durable artifact mint_agent_token produces,
// and mint_agent_token has required 'admin' since it was written (provision.ts:
// "Minting a credential that IS an agent is an org-trust act -> admin, never
// lead/member"). Proven live pre-fix: a human holding only squad-a:member
// consented to agent-a, then read + CONSUMED agent-a's own inbox and SENT on the
// bus under agent-a's attribution (inbox/send gate on boundAgentId alone, zero
// capability check). This section is what was missing before: nothing pinned
// WHICH rank obtains a weld, which is exactly why 53 tests were green while the
// gap was open.
// ════════════════════════════════════════════════════════════════════════════

describe('D0. P0-3 — the weld floor is admin, not member', () => {
  it('memberMayConsentToAgent: a human holding only member -> false (member is NOT enough to weld)', async () => {
    // The base fixture's HUMAN grant on squad-a is 'admin' (see seedBase) —
    // narrow it here specifically to prove the OLD floor no longer qualifies.
    harness.sqlite.exec(`UPDATE capabilities SET capability = 'member' WHERE id = 'cap-human-squad-a'`)
    const env = envFor(harness)
    expect(await memberMayConsentToAgent(env, HUMAN, AGENT_A.id)).toBe(false)
  })

  it('memberMayConsentToAgent: a human holding admin -> true', async () => {
    const env = envFor(harness)
    expect(await memberMayConsentToAgent(env, HUMAN, AGENT_A.id)).toBe(true)
  })

  it('listConsentableAgents: a member-only human sees NOTHING — not even agent-a, reachable at the old floor', async () => {
    harness.sqlite.exec(`UPDATE capabilities SET capability = 'member' WHERE id = 'cap-human-squad-a'`)
    const env = envFor(harness)
    const list = await listConsentableAgents(env, HUMAN)
    expect(list).toEqual([])
  })

  it('listConsentableAgents: an admin human still sees agent-a (unchanged from the base fixture)', async () => {
    const env = envFor(harness)
    const list = await listConsentableAgents(env, HUMAN)
    expect(list.map((a) => a.id)).toContain(AGENT_A.id)
  })

  it('POST /oauth/consent: a member-only human is refused server-side exactly like a tampered agent_id — 403, no mint, and the agent is not even offered on render', async () => {
    harness.sqlite.exec(`UPDATE capabilities SET capability = 'member' WHERE id = 'cap-human-squad-a'`)
    const oauthProvider = stubOAuthProvider()
    const { env } = httpEnv(harness, oauthProvider)
    const { consentCookie, html } = await reachConsentScreen(env, oauthProvider, 'human@example.test')
    expect(html).not.toContain(AGENT_A.slug)
    const before = harness.sqlite.prepare('SELECT COUNT(*) AS n FROM member_tokens').all()[0] as { n: number }

    const form = new URLSearchParams({ consent_nonce: consentCookie, action: 'continue', agent_id: AGENT_A.id })
    const req = new Request('https://pot.test/oauth/consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `mupot_oauth_consent=${consentCookie}` },
      body: form.toString(),
    })
    const res = await handleOAuthAuthorize(req, env)

    expect(res.status).toBe(403)
    expect(oauthProvider.completeAuthorization).not.toHaveBeenCalled()
    const after = harness.sqlite.prepare('SELECT COUNT(*) AS n FROM member_tokens').all()[0] as { n: number }
    expect(after.n).toBe(before.n)
  })

  it('the org owner (org:owner, coordinator\'s note: does not lock the owner out) still passes the admin floor via inheritance', async () => {
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, created_at, tenant)
        VALUES ('member-owner-probe', 'owner@example.test', 'Owner', 'active', '2026-08-01T00:00:00.000Z', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-owner-probe', 'member-owner-probe', 'org', NULL, 'owner');
    `)
    const env = envFor(harness)
    expect(await memberMayConsentToAgent(env, 'member-owner-probe', AGENT_A.id)).toBe(true)
  })

  it('a session already consent-bound while admin has its capabilities zeroed AND its identity weld killed (boundAgentId -> null) the moment the human is merely DEMOTED to member (P0-2 x P0-3 x P1)', async () => {
    // P1 (adversarial review round 3, 2026-08-10): capabilities alone were not
    // enough. inbox/inbox_consumer_status gate on auth.boundAgentId ALONE, zero
    // capability check — a capability-zeroed-but-still-bound session could keep
    // draining a live agent's inbox. buildAuthContextFromProps now nulls
    // boundAgentId in the SAME pass that zeroes capabilities, so this test asserts
    // BOTH — "killed" is only accurate once boundAgentId is actually null, not
    // merely when capabilities is empty.
    const env = envFor(harness)
    insertDirectoryToken(harness.sqlite, 'tok-d0-1', MEMBER_AGENT_A, AGENT_A.id)
    const before = await buildAuthContextFromProps(env, {
      memberId: MEMBER_AGENT_A, tokenId: 'tok-d0-1', email: 'human@example.test',
      consentedByMemberId: HUMAN,
    })
    expect(before!.capabilities.length).toBeGreaterThan(0)
    expect(before!.boundAgentId).toBe(AGENT_A.id)

    harness.sqlite.exec(`UPDATE capabilities SET capability = 'member' WHERE id = 'cap-human-squad-a'`)

    const after = await buildAuthContextFromProps(env, {
      memberId: MEMBER_AGENT_A, tokenId: 'tok-d0-1', email: 'human@example.test',
      consentedByMemberId: HUMAN,
    })
    expect(after).not.toBeNull() // the D1 row itself (the agent's own member_tokens row) is still live, unrevoked
    expect(after!.capabilities).toEqual([]) // 'member' no longer clears the weld floor
    expect(after!.boundAgentId).toBeNull() // AND the identity weld itself is killed, not just its authority
  })

  it('P1 (adversarial review round 3): a demoted session cannot read (or DRAIN) agent-a\'s inbox — the identity weld dies with capabilities, not just ambient authority', async () => {
    // Before this fix: inbox/inbox_consumer_status gated on auth.boundAgentId
    // ALONE, zero capability check. A capability-zeroed-but-still-bound session
    // could keep reading (and, by default, CONSUMING) a live agent's inbox
    // indefinitely — the real agent never receives those messages.
    harness.sqlite.exec(`
      INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, kind, body, created_at)
        VALUES ('msg-secret', '${TENANT}', '${AGENT_A.id}', '${AGENT_A.id}', '${MEMBER_AGENT_A}', 'message', 'SECRET-PAYLOAD', '2026-08-01T00:00:00.000Z');
    `)
    const env = envFor(harness)
    insertDirectoryToken(harness.sqlite, 'tok-d0-inbox', MEMBER_AGENT_A, AGENT_A.id)

    // Live and bound: CAN peek its own inbox (proves the fixture is realistic;
    // peek does not consume, so the message survives for the real assertion below).
    const before = await buildAuthContextFromProps(env, {
      memberId: MEMBER_AGENT_A, tokenId: 'tok-d0-inbox', email: 'human@example.test',
      consentedByMemberId: HUMAN,
    })
    const peekOut = await invokeTool(before!, env, 'inbox', { peek: true }, 'https://pot.test')
    expect((peekOut as { result?: { messages?: { body: string }[] } }).result?.messages?.[0]?.body).toBe('SECRET-PAYLOAD')

    // Demote the human below the P0-3 weld floor.
    harness.sqlite.exec(`UPDATE capabilities SET capability = 'member' WHERE id = 'cap-human-squad-a'`)

    const after = await buildAuthContextFromProps(env, {
      memberId: MEMBER_AGENT_A, tokenId: 'tok-d0-inbox', email: 'human@example.test',
      consentedByMemberId: HUMAN,
    })
    expect(after!.boundAgentId).toBeNull() // P1 fix

    const afterOut = await invokeTool(after!, env, 'inbox', {}, 'https://pot.test')
    expect((afterOut as { error?: string }).error).toBe('not_agent_bound')

    // The message was NEVER consumed by the demoted session — proves this closes
    // the DRAIN, not merely the read: it is still waiting for the real agent-a.
    const stillUnread = harness.sqlite.prepare(
      `SELECT read_at FROM agent_messages WHERE id = 'msg-secret'`,
    ).all()[0] as { read_at: string | null }
    expect(stillUnread.read_at).toBeNull()
  })
})

describe('D. P0-1 — vertical-escalation clamp (agent-e holds admin on its own squad; human ALSO admin, but on a scope the agent separately holds MORE grants on)', () => {
  function grantHumanSquadC(capability: 'member' | 'admin'): void {
    harness.sqlite.exec(`
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-human-squad-c', '${HUMAN}', 'squad', '${AGENT_E.squad_id}', '${capability}');
    `)
  }

  it('a human below the P0-3 admin floor (only member) gets a fully zeroed session even probed directly — create_agent 403s for the more fundamental reason (zero capabilities, not merely a clamp)', async () => {
    // Pre-P0-3 this scenario clamped agent-e's raw 'admin' down to 'member'. Post-
    // P0-3 'member' no longer clears the live eligibility re-check inside
    // resolveConsentedAgentCapabilities either (raised to 'admin' alongside the
    // consent-time gate) — so the session is zeroed outright, not merely narrowed.
    grantHumanSquadC('member')
    const env = envFor(harness)
    insertDirectoryToken(harness.sqlite, 'tok-e-1', MEMBER_AGENT_E, AGENT_E.id)
    const auth = await buildAuthContextFromProps(env, {
      memberId: MEMBER_AGENT_E, tokenId: 'tok-e-1', email: 'human@example.test',
      consentedByMemberId: HUMAN,
    })
    expect(auth!.capabilities).toEqual([])

    const out = await invokeTool(auth!, env, 'create_agent', {
      squad: AGENT_E.squad_id, slug: 'puppet', name: 'Puppet',
    }, 'https://pot.test')
    expect((out as { error?: string }).error).toBe('forbidden')
    const created = harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM agents WHERE slug = 'puppet'`).all()[0] as { n: number }
    expect(created.n).toBe(0)
  })

  it('human ALSO holds admin there -> session correctly carries admin (the only reachable single-scope state at floor=ceiling=admin)', async () => {
    grantHumanSquadC('admin')
    const env = envFor(harness)
    insertDirectoryToken(harness.sqlite, 'tok-e-3', MEMBER_AGENT_E, AGENT_E.id)
    const auth = await buildAuthContextFromProps(env, {
      memberId: MEMBER_AGENT_E, tokenId: 'tok-e-3', email: 'human@example.test',
      consentedByMemberId: HUMAN,
    })
    expect(auth!.capabilities).toEqual([
      { member_id: MEMBER_AGENT_E, scope_type: 'squad', scope_id: AGENT_E.squad_id, capability: 'admin' },
    ])
  })

  it('human holds NOTHING on the agent\'s scope -> the grant is dropped entirely, not clamped to some default (fail closed on ambiguous)', async () => {
    // No grantHumanSquadC call: human has zero standing on squad-c. Consent-time
    // eligibility (memberMayConsentToAgent) would already refuse this; this proves
    // the SAME zeroing independently, e.g. for a token whose human's grant was
    // fully revoked (not just narrowed) after consent — see section E.
    const env = envFor(harness)
    insertDirectoryToken(harness.sqlite, 'tok-e-4', MEMBER_AGENT_E, AGENT_E.id)
    const auth = await buildAuthContextFromProps(env, {
      memberId: MEMBER_AGENT_E, tokenId: 'tok-e-4', email: 'human@example.test',
      consentedByMemberId: HUMAN,
    })
    expect(auth!.capabilities).toEqual([])
  })

  it('per-scope drop: agent holds a SECOND grant on a squad the human passed the OVERALL (admin) gate on but never touched at all -> that second grant is dropped, the eligible one survives', async () => {
    // The overall eligibility gate (canOnSquad(..., agent's home squad, 'admin'))
    // only checks ONE scope. An agent-bound member can separately hold capability
    // on OTHER squads too (setAgentSquadAccess is callable per-squad) — each grant
    // must be clamped against the human's rank on THAT SAME scope independently,
    // not just gated once overall. Without this, a grant on a squad the human never
    // touched at all would leak through unclamped once the human clears the single
    // overall gate on a DIFFERENT scope. Human is 'admin' on squad-c (clears the
    // P0-3 floor) but has NOTHING on squad-d.
    grantHumanSquadC('admin')
    harness.sqlite.exec(`
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-d', 'dept-eng', 'squad-d', 'Squad D');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-e-squad-d', '${MEMBER_AGENT_E}', 'squad', 'squad-d', 'admin');
    `)
    const env = envFor(harness)
    insertDirectoryToken(harness.sqlite, 'tok-e-5', MEMBER_AGENT_E, AGENT_E.id)
    const auth = await buildAuthContextFromProps(env, {
      memberId: MEMBER_AGENT_E, tokenId: 'tok-e-5', email: 'human@example.test',
      consentedByMemberId: HUMAN,
    })
    // squad-c grant survives (human is admin there too); squad-d grant is dropped
    // entirely — the clamp remains load-bearing even with the raised floor,
    // because the floor only governs the ONE scope memberMayConsentToAgent checks.
    expect(auth!.capabilities).toEqual([
      { member_id: MEMBER_AGENT_E, scope_type: 'squad', scope_id: AGENT_E.squad_id, capability: 'admin' },
    ])
    expect(auth!.capabilities.some((c) => c.scope_id === 'squad-d')).toBe(false)
  })

  it('the consent-screen PREVIEW is honest: shows the TRUE per-scope-filtered value, excluding a grant on a squad the human never touched', async () => {
    grantHumanSquadC('admin')
    harness.sqlite.exec(`
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-d-preview', 'dept-eng', 'squad-d-preview', 'Squad D Preview');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-e-squad-d-preview', '${MEMBER_AGENT_E}', 'squad', 'squad-d-preview', 'admin');
    `)
    const env = envFor(harness)
    const list = await listConsentableAgents(env, HUMAN)
    const e = list.find((a) => a.id === AGENT_E.id)
    expect(e).toBeDefined()
    expect(e!.capabilities).toEqual([
      { member_id: MEMBER_AGENT_E, scope_type: 'squad', scope_id: AGENT_E.squad_id, capability: 'admin' },
    ])
  })
})

// ════════════════════════════════════════════════════════════════════════════
// E. P0-2 (adversarial review 2026-08-10) — offboarding the CONSENTING HUMAN kills
// the session's authority live, even though the agent's own member row is untouched.
// ════════════════════════════════════════════════════════════════════════════

describe('E. P0-2 — offboarding the consenting human, not just the agent, kills authority', () => {
  it('human member.status flips to suspended -> capabilities zero AND boundAgentId null (agent stays active, token stays live)', async () => {
    const env = envFor(harness)
    insertDirectoryToken(harness.sqlite, 'tok-off-1', MEMBER_AGENT_A, AGENT_A.id)

    const before = await buildAuthContextFromProps(env, {
      memberId: MEMBER_AGENT_A, tokenId: 'tok-off-1', email: 'human@example.test',
      consentedByMemberId: HUMAN,
    })
    expect(before!.capabilities.length).toBeGreaterThan(0)

    harness.sqlite.exec(`UPDATE members SET status = 'suspended' WHERE id = '${HUMAN}'`)

    const after = await buildAuthContextFromProps(env, {
      memberId: MEMBER_AGENT_A, tokenId: 'tok-off-1', email: 'human@example.test',
      consentedByMemberId: HUMAN,
    })
    expect(after).not.toBeNull() // the row's own member (the agent's) is still live
    expect(after!.capabilities).toEqual([])
    expect(after!.boundAgentId).toBeNull() // P1: the identity weld is killed too, not just authority
  })

  it('P1, full offboard (member.status=suspended AND the capability row deleted — the coordinator\'s exact PROBE4 second stage): inbox is refused and the queued message survives unconsumed', async () => {
    harness.sqlite.exec(`
      INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, kind, body, created_at)
        VALUES ('msg-secret-2', '${TENANT}', '${AGENT_A.id}', '${AGENT_A.id}', '${MEMBER_AGENT_A}', 'message', 'SECRET-2', '2026-08-01T00:00:00.000Z');
    `)
    const env = envFor(harness)
    insertDirectoryToken(harness.sqlite, 'tok-off-full', MEMBER_AGENT_A, AGENT_A.id)

    harness.sqlite.exec(`
      UPDATE members SET status = 'suspended' WHERE id = '${HUMAN}';
      DELETE FROM capabilities WHERE id = 'cap-human-squad-a';
    `)

    const auth = await buildAuthContextFromProps(env, {
      memberId: MEMBER_AGENT_A, tokenId: 'tok-off-full', email: 'human@example.test',
      consentedByMemberId: HUMAN,
    })
    expect(auth!.capabilities).toEqual([])
    expect(auth!.boundAgentId).toBeNull()

    const out = await invokeTool(auth!, env, 'inbox', {}, 'https://pot.test')
    expect((out as { error?: string }).error).toBe('not_agent_bound')

    const stillUnread = harness.sqlite.prepare(
      `SELECT read_at FROM agent_messages WHERE id = 'msg-secret-2'`,
    ).all()[0] as { read_at: string | null }
    expect(stillUnread.read_at).toBeNull()
  })

  it('human\'s capability grant on the agent\'s squad is revoked -> capabilities zero (member.status stays active)', async () => {
    const env = envFor(harness)
    insertDirectoryToken(harness.sqlite, 'tok-off-2', MEMBER_AGENT_A, AGENT_A.id)
    harness.sqlite.exec(`DELETE FROM capabilities WHERE id = 'cap-human-squad-a'`)

    const auth = await buildAuthContextFromProps(env, {
      memberId: MEMBER_AGENT_A, tokenId: 'tok-off-2', email: 'human@example.test',
      consentedByMemberId: HUMAN,
    })
    expect(auth).not.toBeNull()
    expect(auth!.capabilities).toEqual([])
  })

  it('human is DOWNGRADED (not revoked) below the eligibility floor — member -> observer on the SAME scope the agent holds it -> capabilities zero entirely, not clamped down to observer', async () => {
    // Distinct from a full revoke: the human still has a NON-ZERO grant, so the
    // per-grant clamp alone (min(agent rank, human rank)) would produce 'observer'
    // rather than []. Eligibility (memberMayConsentToAgent's rule: member-or-higher)
    // must be re-checked as its OWN gate, live, every call — a human who no longer
    // clears the SAME bar that let them consent in the first place loses the
    // session entirely, not a demoted-but-still-live view of it.
    const env = envFor(harness)
    insertDirectoryToken(harness.sqlite, 'tok-off-4', MEMBER_AGENT_A, AGENT_A.id)
    harness.sqlite.exec(`UPDATE capabilities SET capability = 'observer' WHERE id = 'cap-human-squad-a'`)

    const auth = await buildAuthContextFromProps(env, {
      memberId: MEMBER_AGENT_A, tokenId: 'tok-off-4', email: 'human@example.test',
      consentedByMemberId: HUMAN,
    })
    expect(auth).not.toBeNull()
    expect(auth!.capabilities).toEqual([])
  })

  it('latentCapabilities also dies with the human — never keeps leaking their (now-suspended) standing grants through connect', async () => {
    harness.sqlite.exec(`
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-human-org-owner-2', '${HUMAN}', 'org', NULL, 'owner');
    `)
    const env = envFor(harness)
    insertDirectoryToken(harness.sqlite, 'tok-off-3', MEMBER_AGENT_A, AGENT_A.id)
    harness.sqlite.exec(`UPDATE members SET status = 'suspended' WHERE id = '${HUMAN}'`)

    const auth = await buildAuthContextFromProps(env, {
      memberId: MEMBER_AGENT_A, tokenId: 'tok-off-3', email: 'human@example.test',
      consentedByMemberId: HUMAN,
    })
    expect(auth!.latentCapabilities).toEqual([])
  })
})

// ════════════════════════════════════════════════════════════════════════════
// F. resolveAuth — the REAL McpOAuthApiHandler -> header -> mcpApp dispatch path.
// Every test above calls invokeTool directly with an already-built AuthContext,
// which is exactly why the resolveAuth header-zeroing defect (found independently
// while investigating this review) was invisible to them: before this fix,
// src/mcp/index.ts's resolveAuth forced capabilities=[] and boundAgentId=null for
// ANY channel that wasn't a KNOWN non-directory one — which included a legitimately
// consent-bound directory session. That would have made the entire feature dead on
// arrival in production despite every unit test above passing. These tests drive
// the real dispatch path (mcpApp.request with the internal header set, exactly as
// McpOAuthApiHandler does) to close that gap.
// ════════════════════════════════════════════════════════════════════════════

describe('F. resolveAuth header re-derivation — real dispatch, not invokeTool direct-call', () => {
  it('a consent-bound session survives the header round-trip and can act with the clamped capability', async () => {
    grantHumanSquadCFixture()
    const env = envFor(harness)
    insertDirectoryToken(harness.sqlite, 'tok-http-1', MEMBER_AGENT_A, AGENT_A.id)

    // Exactly what McpOAuthApiHandler would serialize into the header — EXCEPT
    // capabilities is deliberately wrong ([]) here, to prove resolveAuth re-derives
    // from D1 rather than trusting the header's claim (same posture the
    // known-non-directory branch already had).
    const forgedHeaderAuth: AuthContext = {
      userId: MEMBER_AGENT_A, email: 'human@example.test', role: 'member', tenant: TENANT,
      memberId: MEMBER_AGENT_A, channel: 'directory',
      capabilities: [], // WRONG on purpose
      boundAgentId: AGENT_A.id,
      consentedByMemberId: HUMAN,
    }

    const res = await mcpApp.request('https://pot.test/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [AUTH_CONTEXT_HEADER]: JSON.stringify(forgedHeaderAuth) },
      body: JSON.stringify({
        tool: 'task_create',
        args: { squad_id: AGENT_A.squad_id, title: 'via real dispatch', done_when: 'check done' },
      }),
    }, env)

    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  it('P1 (adversarial review round 3): driven through the FULL real seam — mint, persisted props, buildAuthContextFromProps, internal header, mcpApp — a demoted session cannot read agent-a\'s inbox', async () => {
    // Reproduces the coordinator's exact seam: /oauth/consent mint -> persisted
    // props -> buildAuthContextFromProps -> internal header -> mcpApp, not a
    // hand-forged header. This is the actual request path a browser tab drives.
    harness.sqlite.exec(`
      INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, kind, body, created_at)
        VALUES ('msg-secret-3', '${TENANT}', '${AGENT_A.id}', '${AGENT_A.id}', '${MEMBER_AGENT_A}', 'message', 'SECRET-3', '2026-08-01T00:00:00.000Z');
    `)
    const env = envFor(harness)
    insertDirectoryToken(harness.sqlite, 'tok-http-inbox', MEMBER_AGENT_A, AGENT_A.id)

    // buildAuthContextFromProps is what McpOAuthApiHandler calls to build the
    // AuthContext it serializes into the header — using it here (not a hand-built
    // object) means the header carries whatever the real mint+props path produces.
    harness.sqlite.exec(`UPDATE capabilities SET capability = 'member' WHERE id = 'cap-human-squad-a'`)
    const realAuth = await buildAuthContextFromProps(env, {
      memberId: MEMBER_AGENT_A, tokenId: 'tok-http-inbox', email: 'human@example.test',
      consentedByMemberId: HUMAN,
    })
    expect(realAuth!.boundAgentId).toBeNull() // P1 fix, confirmed before dispatch

    const res = await mcpApp.request('https://pot.test/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [AUTH_CONTEXT_HEADER]: JSON.stringify(realAuth) },
      body: JSON.stringify({ tool: 'inbox', args: {} }),
    }, env)

    const body = await res.json() as { ok?: boolean; error?: string }
    expect(body.ok).not.toBe(true)
    expect(body.error).toBe('not_agent_bound')

    const stillUnread = harness.sqlite.prepare(
      `SELECT read_at FROM agent_messages WHERE id = 'msg-secret-3'`,
    ).all()[0] as { read_at: string | null }
    expect(stillUnread.read_at).toBeNull()
  })

  it('P1, isolating resolveAuth\'s OWN null-out specifically: a header that STILL CLAIMS boundAgentId (as if site 1\'s fix did not run) is independently nulled by site 2, and inbox is refused', async () => {
    // The test above derives its header via buildAuthContextFromProps, which
    // already nulls boundAgentId (site 1) — so it cannot, by itself, prove site 2
    // (resolveAuth's own re-derivation) does the same independently; a mutation
    // that deleted ONLY site 2's null-out survived against that test alone (site
    // 1's result flows straight through). This test hand-forges the header the
    // same way the OTHER section-F tests do — boundAgentId still set, exactly as
    // it would be BEFORE site 2 runs its own check — so only site 2's own logic
    // is under test.
    harness.sqlite.exec(`
      INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, kind, body, created_at)
        VALUES ('msg-secret-4', '${TENANT}', '${AGENT_A.id}', '${AGENT_A.id}', '${MEMBER_AGENT_A}', 'message', 'SECRET-4', '2026-08-01T00:00:00.000Z');
    `)
    const env = envFor(harness)
    insertDirectoryToken(harness.sqlite, 'tok-http-inbox-2', MEMBER_AGENT_A, AGENT_A.id)
    harness.sqlite.exec(`UPDATE capabilities SET capability = 'member' WHERE id = 'cap-human-squad-a'`)

    const forgedHeaderAuth: AuthContext = {
      userId: MEMBER_AGENT_A, email: 'human@example.test', role: 'member', tenant: TENANT,
      memberId: MEMBER_AGENT_A, channel: 'directory',
      capabilities: [{ member_id: MEMBER_AGENT_A, scope_type: 'squad', scope_id: AGENT_A.squad_id, capability: 'admin' }], // forged, stale, wrong
      boundAgentId: AGENT_A.id, // still claims the weld — the exact pre-site-2 shape
      consentedByMemberId: HUMAN,
    }

    const res = await mcpApp.request('https://pot.test/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [AUTH_CONTEXT_HEADER]: JSON.stringify(forgedHeaderAuth) },
      body: JSON.stringify({ tool: 'inbox', args: {} }),
    }, env)

    const body = await res.json() as { ok?: boolean; error?: string }
    expect(body.ok).not.toBe(true)
    expect(body.error).toBe('not_agent_bound')

    const stillUnread = harness.sqlite.prepare(
      `SELECT read_at FROM agent_messages WHERE id = 'msg-secret-4'`,
    ).all()[0] as { read_at: string | null }
    expect(stillUnread.read_at).toBeNull()
  })

  it('an unbound directory session STILL gets zero through this same real path (regression pin)', async () => {
    const env = envFor(harness)
    insertDirectoryToken(harness.sqlite, 'tok-http-2', HUMAN, null)

    const unboundHeaderAuth: AuthContext = {
      userId: HUMAN, email: 'human@example.test', role: 'member', tenant: TENANT,
      memberId: HUMAN, channel: 'directory',
      capabilities: [{ member_id: HUMAN, scope_type: 'org', scope_id: null, capability: 'owner' }], // forged, high value
      boundAgentId: null,
      consentedByMemberId: null,
    }

    const res = await mcpApp.request('https://pot.test/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [AUTH_CONTEXT_HEADER]: JSON.stringify(unboundHeaderAuth) },
      body: JSON.stringify({
        tool: 'task_create',
        args: { squad_id: AGENT_A.squad_id, title: 'should be refused', done_when: 'check done' },
      }),
    }, env)

    const body = await res.json() as { ok?: boolean; error?: string }
    expect(body.ok).not.toBe(true)
  })

  it('the P0-1 clamp ALSO applies through this real path: forged high-rank header capabilities cannot substitute for D1 truth', async () => {
    grantHumanSquadCFixture()
    const env = envFor(harness)
    insertDirectoryToken(harness.sqlite, 'tok-http-3', MEMBER_AGENT_E, AGENT_E.id)

    const forgedHeaderAuth: AuthContext = {
      userId: MEMBER_AGENT_E, email: 'human@example.test', role: 'member', tenant: TENANT,
      memberId: MEMBER_AGENT_E, channel: 'directory',
      // Forged: claims admin directly in the header. D1 truth is human=member,
      // agent-e=admin -> clamped result is 'member', which cannot pass create_agent's
      // 'lead' floor. If resolveAuth trusted this instead of re-deriving, it would.
      capabilities: [{ member_id: MEMBER_AGENT_E, scope_type: 'squad', scope_id: AGENT_E.squad_id, capability: 'admin' }],
      boundAgentId: AGENT_E.id,
      consentedByMemberId: HUMAN,
    }

    const res = await mcpApp.request('https://pot.test/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [AUTH_CONTEXT_HEADER]: JSON.stringify(forgedHeaderAuth) },
      body: JSON.stringify({
        tool: 'create_agent',
        args: { squad: AGENT_E.squad_id, slug: 'puppet-2', name: 'Puppet 2' },
      }),
    }, env)

    const body = await res.json() as { ok?: boolean; error?: string }
    expect(body.ok).not.toBe(true)
    const created = harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM agents WHERE slug = 'puppet-2'`).all()[0] as { n: number }
    expect(created.n).toBe(0)
  })
})

function grantHumanSquadCFixture(): void {
  harness.sqlite.exec(`
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-human-squad-c-f', '${HUMAN}', 'squad', '${AGENT_E.squad_id}', 'member');
  `)
}

// ════════════════════════════════════════════════════════════════════════════
// G. P2 (adversarial review 2026-08-10) — escaping coverage beyond agent NAME.
// The original suite only injected XSS via `a.name`; escapeHtml removed from
// a.slug/a.squad_name/budget_window specifically would have survived it.
// ════════════════════════════════════════════════════════════════════════════

describe('G. consent screen escaping — slug, squad name, budget window (not just name)', () => {
  it('escapes a malicious agent SLUG', async () => {
    harness.sqlite.exec(`UPDATE agents SET slug = '"><script>alert(2)</script>' WHERE id = '${AGENT_A.id}'`)
    const oauthProvider = stubOAuthProvider()
    const { env } = httpEnv(harness, oauthProvider)
    const { html } = await reachConsentScreen(env, oauthProvider, 'human@example.test')
    expect(html).not.toContain('<script>alert(2)</script>')
  })

  it('escapes a malicious SQUAD NAME', async () => {
    harness.sqlite.exec(`UPDATE squads SET name = '"><script>alert(3)</script>' WHERE id = '${AGENT_A.squad_id}'`)
    const oauthProvider = stubOAuthProvider()
    const { env } = httpEnv(harness, oauthProvider)
    const { html } = await reachConsentScreen(env, oauthProvider, 'human@example.test')
    expect(html).not.toContain('<script>alert(3)</script>')
  })

  it('escapes a malicious budget_window', async () => {
    harness.sqlite.exec(`UPDATE agents SET budget_window = '"><script>alert(4)</script>' WHERE id = '${AGENT_A.id}'`)
    const oauthProvider = stubOAuthProvider()
    const { env } = httpEnv(harness, oauthProvider)
    const { html } = await reachConsentScreen(env, oauthProvider, 'human@example.test')
    expect(html).not.toContain('<script>alert(4)</script>')
  })

  it('a non-numeric budget_cap_cents (SQLite dynamic typing) never reaches the page raw', async () => {
    // agents.budget_cap_cents is declared INTEGER but SQLite does not enforce that
    // strictly (dynamic typing) — write a string directly to prove the renderer
    // does not interpolate it unguarded.
    harness.sqlite.exec(`UPDATE agents SET budget_cap_cents = '<script>alert(5)</script>' WHERE id = '${AGENT_A.id}'`)
    const oauthProvider = stubOAuthProvider()
    const { env } = httpEnv(harness, oauthProvider)
    const { html } = await reachConsentScreen(env, oauthProvider, 'human@example.test')
    expect(html).not.toContain('<script>alert(5)</script>')
  })

  // The following four were already escaped in the code but had NO test coverage
  // (adversarial review 2026-08-10, P3 — "lower bar but free") — each would have
  // survived its escapeHtml call being deleted, undetected, exactly like slug/
  // squad_name/budget_window above before this file covered them.

  it('formatCapabilities escapes a malicious scope_id inside the capability PREVIEW itself — capabilities.scope_id has no FK, nothing stops a stray value from reaching here', async () => {
    // capabilities.scope_id (migrations/0002_members.sql) is free TEXT, no FK — the
    // capability PREVIEW line (formatCapabilities) interpolates scope_type:scope_id
    // for every grant the session would carry, escaped as a whole.
    //
    // The P0-1 clamp drops any grant on a scope the human holds nothing on — a
    // first version of this test gave agent-a's dedicated member a grant on a
    // nonsense scope_id and nothing else, which the clamp silently dropped before
    // formatCapabilities ever saw it (100% green even with .map(escapeHtml)
    // deleted — the exact "different mechanism, same visible result" trap noted
    // elsewhere in this suite). Fixed by ALSO granting the human an exact-match
    // capability on that same literal scope_id string, so the clamp lets the
    // grant through and formatCapabilities is the thing actually under test.
    const hostileScopeId = '"><script>alert(6)</script>'
    harness.sqlite.exec(`
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-a-hostile-scope', '${MEMBER_AGENT_A}', 'squad', '${hostileScopeId}', 'member');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-human-hostile-scope', '${HUMAN}', 'squad', '${hostileScopeId}', 'admin');
    `)
    const oauthProvider = stubOAuthProvider()
    const { env } = httpEnv(harness, oauthProvider)
    const { html } = await reachConsentScreen(env, oauthProvider, 'human@example.test')
    expect(html).not.toContain('<script>alert(6)</script>')
    // Positive check: the grant actually reached the preview (unescaped form would
    // show scope_id verbatim) — proves this test exercises formatCapabilities, not
    // a dropped-by-the-clamp no-op.
    expect(html).toContain('capabilities this session would carry:')
  })

  it('escapes a.autonomy', async () => {
    harness.sqlite.exec(`UPDATE agents SET autonomy = '"><script>alert(7)</script>' WHERE id = '${AGENT_A.id}'`)
    const oauthProvider = stubOAuthProvider()
    const { env } = httpEnv(harness, oauthProvider)
    const { html } = await reachConsentScreen(env, oauthProvider, 'human@example.test')
    expect(html).not.toContain('<script>alert(7)</script>')
  })

  it('escapes the signed-in EMAIL — IdP-supplied (Google), not admin-authored, the least trustworthy field on the page', async () => {
    const oauthProvider = stubOAuthProvider()
    const { env } = httpEnv(harness, oauthProvider)
    const { html } = await reachConsentScreen(env, oauthProvider, '"><script>alert(8)</script>@example.test')
    expect(html).not.toContain('<script>alert(8)</script>')
  })

  it('escapes a.id (the radio value)', async () => {
    // agents.id is normally a UUID (crypto.randomUUID()), but nothing besides
    // convention stops it from being something else — updating an existing row's
    // id in place isn't representable via UPDATE against a PRIMARY KEY cleanly in
    // this fixture, so this inserts a fresh agent whose id IS the payload,
    // eligible for and shown to HUMAN the same way agent-a is.
    harness.sqlite.exec(`
      INSERT INTO agents (id, squad_id, slug, name, status)
        VALUES ('"><script>alert(9)</script>', '${AGENT_A.squad_id}', 'hostile-id-agent', 'Hostile Id Agent', 'active');
      INSERT INTO members (id, email, display_name, status, created_at, tenant)
        VALUES ('member-hostile-id-agent', NULL, 'Hostile Id Agent', 'active', '2026-08-01T00:00:00.000Z', '${TENANT}');
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
        VALUES ('${TENANT}', '"><script>alert(9)</script>', 'member-hostile-id-agent', '2026-08-01T00:00:00.000Z');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-hostile-id-home', 'member-hostile-id-agent', 'squad', '${AGENT_A.squad_id}', 'member');
    `)
    const oauthProvider = stubOAuthProvider()
    const { env } = httpEnv(harness, oauthProvider)
    const { html } = await reachConsentScreen(env, oauthProvider, 'human@example.test')
    expect(html).not.toContain('<script>alert(9)</script>')
  })

  it('consent_nonce hidden field renders the server-generated UUID verbatim (escapeHtml around it is verified an EQUIVALENT MUTANT below, not a caught guard — see comment)', async () => {
    // Mutation-checked directly: removing escapeHtml(consentNonce) does NOT fail
    // this or any other test in this file. crypto.randomUUID() output is always
    // [0-9a-f-]{36} — it structurally cannot contain a character escapeHtml would
    // ever change, so there is no payload this test (or any test) could assert
    // against to distinguish "escaped" from "not escaped" here. Per the earlier
    // lesson in this file (M13/M15): label this honestly as untestable-by-payload
    // rather than leave a test reading as a catch it is not. The call stays in the
    // source as defence-in-depth against a future change to how consentNonce is
    // generated, not because this test proves it necessary today.
    const oauthProvider = stubOAuthProvider()
    const { env } = httpEnv(harness, oauthProvider)
    const { html } = await reachConsentScreen(env, oauthProvider, 'human@example.test')
    expect(html).toMatch(/name="consent_nonce" value="[0-9a-f-]{36}"/)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// H. P2 (adversarial review 2026-08-10) — GET /oauth/consent must be refused.
// SameSite=Lax still allows a top-level cross-site GET (unlike POST), so the
// method check is the layer keeping this endpoint off an <a href>/<img src>.
// ════════════════════════════════════════════════════════════════════════════

describe('H. GET /oauth/consent is refused even with a valid consent cookie', () => {
  it('GET with a valid, matching consent cookie -> 405, not processed as a submission', async () => {
    const oauthProvider = stubOAuthProvider()
    const { env } = httpEnv(harness, oauthProvider)
    const { consentCookie } = await reachConsentScreen(env, oauthProvider, 'human@example.test')

    const req = new Request(`https://pot.test/oauth/consent?agent_id=${AGENT_A.id}&action=continue`, {
      method: 'GET',
      headers: { Cookie: `mupot_oauth_consent=${consentCookie}` },
    })
    const res = await handleOAuthAuthorize(req, env)

    expect(res.status).toBe(405)
    expect(oauthProvider.completeAuthorization).not.toHaveBeenCalled()
  })
})

// Migration-chain sanity: fail loudly (not silently) if the fixture ever drifts
// from the real schema this test claims to exercise.
describe('fixture sanity', () => {
  it('the migrations dir this suite applies is non-empty (guards against a silently-empty glob)', () => {
    const files = readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8')
    expect(files).toContain('CREATE TABLE')
  })
})
