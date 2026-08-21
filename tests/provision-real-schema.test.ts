// tests/provision-real-schema.test.ts — the owed follow-up to mupot#684/#685.
//
// WHAT #684 WAS, AND WHY THE SUITE COULD NOT SEE IT
//
// `list_agent_tokens` shipped naming `member_tokens.capability` — a column that does
// not exist. D1 rejected the query; the tool returned internal_error on its first live
// call. Twelve tests were green throughout. They could not have been anything else:
// tests/provision-tools.test.ts supplies a D1-SHAPED OBJECT that routes on
// `sql.includes('FROM member_tokens')` and answers with a canned row. The SQL is never
// executed, so a query naming a column that does not exist is not merely undetected —
// it is UNDETECTABLE. There is nothing in that test capable of contradicting it.
//
// The hotfix (#689) removed the column. The extraction of the query into a
// dependency-free `src/mcp/token-queries.ts` (so production and the test consume ONE
// string, never a transcription) closed the hole for `list_agent_tokens`.
//
// IT CLOSED IT FOR EXACTLY ONE QUERY. Measured on this head, the rest of the
// credential/identity surface in src/mcp/provision.ts still had only mock coverage:
//
//   revoke_agent_token   — `revokeTokenOwnershipQuery()` is IMPORTED by
//                          tests/list-agent-tokens-real-schema.test.ts and never used.
//                          Zero real-schema execution.
//   register_agent_key   — agent_keys writes: mock only (provision-tools.test.ts).
//   deactivate_agent     — the member_tokens / fleet_agents / agent_keys teardown
//                          batch: mock only (deactivate-agent.test.ts).
//   list_agent_tokens    — the QUERY STRING is covered; the HANDLER that binds and runs
//                          it is not.
//
// So #684 remained reproducible: name a nonexistent column in any of those and every
// test stays green. This file makes that impossible for them.
//
// HOW: no mock. `applyAllMigrations()` from tests/helpers/migrations.ts builds the
// whole committed chain (the only schema that cannot drift from production — a
// hand-written CREATE TABLE here would simply contain the same invented column I was
// wrong about), and the REAL handlers are driven through `invokeTool` — the same
// dispatch path, capability floor and all, that an MCP caller reaches.
//
// THE PROPERTY THIS FILE PINS:
//   if a provision query names a column that does not exist, a test fails.
//
// Proven by mutation, not asserted. Reintroducing `capability` into
// listAgentTokensQuery (literal #684) and, separately, into
// revokeTokenOwnershipQuery (the same defect at a site nothing covered) each turns
// this file RED while tests/provision-tools.test.ts stays 41/41 GREEN.
//
// AND ONE RESULT WORTH KEEPING, because it is why "a mock went red too" must never be
// accepted as coverage. Injecting `capability` MID-LIST into revokeTokenOwnershipQuery
// does turn tests/agent-token-lifecycle.test.ts red — but not by detecting anything.
// That mock routes on the literal substring `'agent_id, label, revoked_at'`; inserting
// a column between `label` and `revoked_at` breaks the substring, so the mock falls
// through to a different branch and answers with the wrong row. Move the SAME injection
// to the END of the SELECT list, leaving the substring intact, and the mock returns to
// 20/20 GREEN with the identical production defect in place. Its red was a string-shape
// coincidence. This file is red for both placements, because it executes the query.
//
// NOTE ON ENTRY ORDER: `../src/mcp` (index) must be the first module entered.
// provision.ts imports memberCanOnSquad back from index.ts — a real, working circular
// import that Node's ESM resolution only completes safely from that direction. Same
// reason tests/provision-tools.test.ts and tests/update-squad-tool.test.ts enter here.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'tenant-test'
const ORIGIN = 'https://pot.test'

const DEPT_ID = 'dept-1'
const HOME_SQUAD_ID = 'squad-home'
const AGENT_ID = 'agent-test'
const AGENT_SLUG = 'test-agent'
const OTHER_AGENT_ID = 'agent-other'
const OPERATOR_MEMBER_ID = 'member-operator'
const AGENT_MEMBER_ID = 'member-agent'
const OTHER_MEMBER_ID = 'member-other'

// A canonical Ed25519 JWK `x` (base64url, 32 bytes) — register_agent_key validates the
// key cryptographically via crypto.subtle.importKey before it ever touches the DB, so a
// placeholder string would fail at 400 and never exercise the agent_keys write.
const VALID_ED25519_X = '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo'

/**
 * Org structure with an ALREADY-MINTED agent identity: agent → member weld, home-squad
 * grant, one live credential, one fleet presence row.
 *
 * Seeded through the real schema, so any drift in these tables (a renamed column, a new
 * NOT NULL) fails here loudly rather than being papered over by a fixture.
 */
function seed(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    INSERT INTO departments (id, slug, name)
    VALUES ('${DEPT_ID}', 'test-dept', 'Test Department');

    INSERT INTO squads (id, department_id, slug, name)
    VALUES ('${HOME_SQUAD_ID}', '${DEPT_ID}', 'home', 'Home Squad');

    INSERT INTO agents (id, squad_id, slug, name, status)
    VALUES
      ('${AGENT_ID}', '${HOME_SQUAD_ID}', '${AGENT_SLUG}', 'Test Agent', 'active'),
      ('${OTHER_AGENT_ID}', '${HOME_SQUAD_ID}', 'other-agent', 'Other Agent', 'active');

    INSERT INTO members (id, display_name, status, tenant)
    VALUES
      ('${OPERATOR_MEMBER_ID}', 'Operator', 'active', '${TENANT}'),
      ('${AGENT_MEMBER_ID}', 'Agent Member', 'active', '${TENANT}'),
      ('${OTHER_MEMBER_ID}', 'Other Agent Member', 'active', '${TENANT}');

    -- The weld: the immutable agent → member identity binding. The schema enforces
    -- this: a member_tokens row whose agent_id disagrees with the binding raises
    -- agent_identity_conflict from a trigger. Each agent therefore needs its OWN
    -- member. (A mock has no such constraint — this seed was wrong on the first
    -- attempt and only the real chain said so.)
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
    VALUES
      ('${TENANT}', '${AGENT_ID}', '${AGENT_MEMBER_ID}', '2026-08-05T00:00:00Z'),
      ('${TENANT}', '${OTHER_AGENT_ID}', '${OTHER_MEMBER_ID}', '2026-08-05T00:00:00Z');

    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
    VALUES
      ('cap-op-org-admin', '${OPERATOR_MEMBER_ID}', 'org', NULL, 'admin'),
      ('cap-agent-home', '${AGENT_MEMBER_ID}', 'squad', '${HOME_SQUAD_ID}', 'member'),
      ('cap-other-home', '${OTHER_MEMBER_ID}', 'squad', '${HOME_SQUAD_ID}', 'member');

    INSERT INTO memberships (id, agent_id, squad_id, capability)
    VALUES ('mem-agent-home', '${AGENT_ID}', '${HOME_SQUAD_ID}', 'member');

    -- One live credential welded to the agent (member_tokens.agent_id is the weld).
    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
    VALUES ('tok-live', '${AGENT_MEMBER_ID}', 'hash-live', 'workspace', 'workspace',
            '2026-08-05T00:00:00Z', '${AGENT_ID}', '${TENANT}');

    -- One already-revoked credential, so include_revoked has something to include.
    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, revoked_at, agent_id, tenant)
    VALUES ('tok-dead', '${AGENT_MEMBER_ID}', 'hash-dead', 'old', 'workspace',
            '2026-08-04T00:00:00Z', '2026-08-04T12:00:00Z', '${AGENT_ID}', '${TENANT}');

    -- A credential on a DIFFERENT agent — the ownership check must refuse to revoke it.
    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
    VALUES ('tok-elsewhere', '${OTHER_MEMBER_ID}', 'hash-else', 'elsewhere', 'workspace',
            '2026-08-05T00:00:00Z', '${OTHER_AGENT_ID}', '${TENANT}');

    INSERT INTO fleet_agents (agent_id, tenant, display, runtime, status)
    VALUES ('${AGENT_ID}', '${TENANT}', 'Test Agent', 'claude-code', 'idle');
  `)
}

/** An org-admin operator principal — the rank every tool below is gated at. */
function operatorAuth(): AuthContext {
  return {
    userId: OPERATOR_MEMBER_ID,
    memberId: OPERATOR_MEMBER_ID,
    email: `${OPERATOR_MEMBER_ID}@example.test`,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: null,
    capabilities: [
      { member_id: OPERATOR_MEMBER_ID, scope_type: 'org', scope_id: null, capability: 'admin' },
    ],
  } as AuthContext
}

/**
 * The one non-D1 binding on this path. mint_agent_token no longer returns the raw
 * credential inline (#987/#1100) — it parks it in KV behind a one-time claim, so the
 * handler touches `env.SESSIONS.put`. An in-memory Map is the whole dependency; it is
 * NOT a stand-in for a schema, and nothing below asserts against it. Every claim this
 * file makes about persisted state is read back out of real SQLite.
 */
function memoryKv(): Env['SESSIONS'] {
  const store = new Map<string, string>()
  return {
    async put(key: string, value: string) { store.set(key, value) },
    async get(key: string) { return store.get(key) ?? null },
    async delete(key: string) { store.delete(key) },
  } as unknown as Env['SESSIONS']
}

let harness: SqliteD1Harness
let env: Env

function call(tool: string, args: Record<string, unknown>) {
  return invokeTool(operatorAuth(), env, tool, args, ORIGIN)
}

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  seed(harness.sqlite)
  env = {
    TENANT_SLUG: TENANT,
    DB: harness.db,
    PUBLIC_ORIGIN: ORIGIN,
    SESSIONS: memoryKv(),
  } as unknown as Env
})

afterEach(() => {
  harness.sqlite.close()
})

describe('provision handlers against the real migration chain (mupot#684 owed follow-up)', () => {
  // The premise of #684, stated as an executable fact rather than a memory. If a
  // migration ever ADDS member_tokens.capability, this goes red and the whole framing
  // of this file needs revisiting — which is the point.
  it('member_tokens has no `capability` column — the assumption that broke production', () => {
    const cols = (harness.sqlite.prepare('PRAGMA table_info(member_tokens)').all() as { name: string }[])
      .map((c) => c.name)
    expect(cols.length).toBeGreaterThan(0)
    expect(cols).not.toContain('capability')
  })

  // ── list_agent_tokens ──────────────────────────────────────────────────────
  // The #684 tool itself. token-queries.ts already pins the QUERY STRING; this pins
  // the HANDLER — bind order, tenant scoping, projection — executing it for real.
  describe('list_agent_tokens', () => {
    it('executes its real query against the real schema and returns the live token', async () => {
      const res = await call('list_agent_tokens', { agent: AGENT_ID })
      expect(res.ok).toBe(true)
      const out = res.result as { tokens: { id: string }[]; live_count: number }
      expect(out.tokens.map((t) => t.id)).toEqual(['tok-live'])
      expect(out.live_count).toBe(1)
    })

    it('include_revoked widens the result — the other branch of the query', async () => {
      const res = await call('list_agent_tokens', { agent: AGENT_ID, include_revoked: true })
      expect(res.ok).toBe(true)
      const out = res.result as { tokens: { id: string }[]; live_count: number }
      expect(out.tokens.map((t) => t.id).sort()).toEqual(['tok-dead', 'tok-live'])
      expect(out.live_count).toBe(1)
    })

    it('never returns token_hash', async () => {
      const res = await call('list_agent_tokens', { agent: AGENT_ID, include_revoked: true })
      expect(JSON.stringify(res.result)).not.toContain('hash-live')
    })
  })

  // ── revoke_agent_token ─────────────────────────────────────────────────────
  // The genuinely uncovered one. `revokeTokenOwnershipQuery()` had NO real-schema
  // execution anywhere in the suite — it is imported by
  // tests/list-agent-tokens-real-schema.test.ts and never called. A nonexistent column
  // in it reproduced #684 exactly, with the entire suite green.
  describe('revoke_agent_token', () => {
    it('executes the ownership lookup for real and revokes the row', async () => {
      const res = await call('revoke_agent_token', { agent: AGENT_ID, token_id: 'tok-live' })
      expect(res.ok).toBe(true)
      expect(res.result).toMatchObject({ revoked: true, already_revoked: false })

      const row = harness.sqlite
        .prepare('SELECT revoked_at FROM member_tokens WHERE id = ?')
        .get('tok-live') as { revoked_at: string | null }
      expect(row.revoked_at).not.toBeNull()
    })

    it('is idempotent — a second revoke reports already_revoked', async () => {
      await call('revoke_agent_token', { agent: AGENT_ID, token_id: 'tok-live' })
      const res = await call('revoke_agent_token', { agent: AGENT_ID, token_id: 'tok-live' })
      expect(res.ok).toBe(true)
      expect(res.result).toMatchObject({ revoked: false, already_revoked: true })
    })

    it('refuses a token welded to a different agent, and leaves it live', async () => {
      const res = await call('revoke_agent_token', { agent: AGENT_ID, token_id: 'tok-elsewhere' })
      expect(res.ok).toBe(false)

      // The authorization claim is only real if the row is untouched.
      const row = harness.sqlite
        .prepare('SELECT revoked_at FROM member_tokens WHERE id = ?')
        .get('tok-elsewhere') as { revoked_at: string | null }
      expect(row.revoked_at).toBeNull()
    })
  })

  // ── mint_agent_token ───────────────────────────────────────────────────────
  // The write half of the same table, through the tool rather than the service.
  describe('mint_agent_token', () => {
    it('writes a real member_tokens row welded to the agent', async () => {
      const res = await call('mint_agent_token', { agent: AGENT_ID, label: 'fresh' })
      expect(res.ok).toBe(true)

      const rows = harness.sqlite
        .prepare(
          `SELECT id, agent_id, member_id, revoked_at FROM member_tokens
            WHERE tenant = ? AND agent_id = ? AND label = 'fresh'`,
        )
        .all(TENANT, AGENT_ID) as { agent_id: string; member_id: string; revoked_at: string | null }[]
      expect(rows).toHaveLength(1)
      // THE WELD and THE ESCALATION GUARD: the credential is bound to this agent and
      // carries the agent's own member identity, never the operator's.
      expect(rows[0].agent_id).toBe(AGENT_ID)
      expect(rows[0].member_id).toBe(AGENT_MEMBER_ID)
      expect(rows[0].member_id).not.toBe(OPERATOR_MEMBER_ID)
      expect(rows[0].revoked_at).toBeNull()
    })

    it('the minted token is visible to list_agent_tokens — one table, two queries agree', async () => {
      await call('mint_agent_token', { agent: AGENT_ID, label: 'fresh' })
      const res = await call('list_agent_tokens', { agent: AGENT_ID })
      const out = res.result as { tokens: { label: string }[] }
      expect(out.tokens.map((t) => t.label)).toContain('fresh')
    })
  })

  // ── register_agent_key ─────────────────────────────────────────────────────
  describe('register_agent_key', () => {
    it('writes agent_keys against the real schema', async () => {
      const res = await call('register_agent_key', { agent: AGENT_ID, public_key: VALID_ED25519_X })
      expect(res.ok).toBe(true)

      const rows = harness.sqlite
        .prepare('SELECT agent_id, pubkey, member_id FROM agent_keys WHERE tenant = ?')
        .all(TENANT) as { agent_id: string; pubkey: string; member_id: string | null }[]
      expect(rows).toHaveLength(1)
      expect(rows[0].pubkey).toBe(VALID_ED25519_X)
      // Bound to the agent's welded member identity, read from agent_member_bindings.
      expect(rows[0].member_id).toBe(AGENT_MEMBER_ID)
    })

    it('re-registering the same key is idempotent, not a second row', async () => {
      await call('register_agent_key', { agent: AGENT_ID, public_key: VALID_ED25519_X })
      const res = await call('register_agent_key', { agent: AGENT_ID, public_key: VALID_ED25519_X })
      expect(res.ok).toBe(true)
      const count = harness.sqlite
        .prepare('SELECT COUNT(*) AS n FROM agent_keys WHERE tenant = ?')
        .get(TENANT) as { n: number }
      expect(Number(count.n)).toBe(1)
    })
  })

  // ── deactivate_agent ───────────────────────────────────────────────────────
  // A four-to-six statement D1 batch spanning member_tokens, fleet_agents and
  // agent_keys. Under the mock every one of those statements is a string that gets
  // matched; here they execute or the test fails.
  describe('deactivate_agent', () => {
    it('runs the full teardown batch against the real schema', async () => {
      await call('register_agent_key', { agent: AGENT_ID, public_key: VALID_ED25519_X })

      const res = await call('deactivate_agent', { agent: AGENT_ID, reason: 'retired' })
      expect(res.ok).toBe(true)
      expect(res.result).toMatchObject({ status: 'deactivated' })

      const agent = harness.sqlite
        .prepare('SELECT status FROM agents WHERE id = ?')
        .get(AGENT_ID) as { status: string }
      expect(agent.status).toBe('inactive')

      // Retirement is only real if the agent actually loses the ability to act.
      const live = harness.sqlite
        .prepare('SELECT COUNT(*) AS n FROM member_tokens WHERE agent_id = ? AND revoked_at IS NULL')
        .get(AGENT_ID) as { n: number }
      expect(Number(live.n)).toBe(0)

      const presence = harness.sqlite
        .prepare('SELECT COUNT(*) AS n FROM fleet_agents WHERE tenant = ? AND agent_id = ?')
        .get(TENANT, AGENT_ID) as { n: number }
      expect(Number(presence.n)).toBe(0)

      const keys = harness.sqlite
        .prepare('SELECT COUNT(*) AS n FROM agent_keys WHERE tenant = ? AND agent_id = ?')
        .get(TENANT, AGENT_ID) as { n: number }
      expect(Number(keys.n)).toBe(0)
    })

    it('leaves another agent\'s credential alone', async () => {
      await call('deactivate_agent', { agent: AGENT_ID })
      const row = harness.sqlite
        .prepare('SELECT revoked_at FROM member_tokens WHERE id = ?')
        .get('tok-elsewhere') as { revoked_at: string | null }
      expect(row.revoked_at).toBeNull()
    })
  })
})
