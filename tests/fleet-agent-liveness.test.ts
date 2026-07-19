// tests/fleet-agent-liveness.test.ts — getFleetAgentRuntime / getFleetAgentLiveness
// (S353 v2, src/fleet/registry.ts), against REAL SQLite (tests/helpers/sqlite-d1.ts) — not a
// hand-rolled JS restatement of the query. That distinction matters here specifically: a first
// version of readFleetAgentRow used a single `LEFT JOIN fleet_agents ON fa.agent_id = a.id OR
// fa.agent_id = a.slug` + `ORDER BY last_reported_at DESC`, and a hand-rolled mock happily
// "passed" against it because the mock re-implemented the SAME (broken) join logic in TS instead
// of running the actual SQL. The bug that slipped through: `agents.slug` is
// `UNIQUE(squad_id, slug)` (migration 0001_init.sql) — unique PER SQUAD, not tenant-wide — so
// two different agents in two different squads can share a slug, and the naive join let a
// same-slug agent's fleet row hijack the wrong agent's dispatch (and let a more-recent slug
// match outrank an exact id match on pure recency). These tests run the REAL query against a
// REAL in-memory SQLite database, seeded with exactly that collision shape, so they fail against
// the broken join and pass against the fix.
//
// These read through the agents.id ↔ fleet_agents.agent_id identifier-space bridge: task
// assignment (and so every task_dispatch wake) always carries `agents.id` (a uuid), but the
// fleet-attach / signed-inbox surface is keyed by `agents.slug` — confirmed against the live
// mumega tenant DB (2026-07-14): kasra's `agents.id` is a uuid, `agents.slug='kasra'`, and its
// `fleet_agents.agent_id` / `agent_keys.agent_id` are BOTH `'kasra'`, never the uuid.

import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { getFleetAgentRuntime, getFleetAgentLiveness, DEFAULT_PRESENCE_TTL_SEC } from '../src/fleet/registry'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 't'
const KASRA_UUID = 'ea2b0370-ff27-4371-9581-5bcaf322baa7'

function createSchema(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    CREATE TABLE agents (id TEXT PRIMARY KEY, squad_id TEXT NOT NULL, slug TEXT NOT NULL);
    CREATE TABLE fleet_agents (
      tenant TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      runtime TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'unknown',
      last_reported_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (tenant, agent_id)
    );
  `)
}

function addAgent(sqlite: SqliteD1Harness['sqlite'], id: string, squadId: string, slug: string): void {
  sqlite.prepare('INSERT INTO agents (id, squad_id, slug) VALUES (?, ?, ?)').run(id, squadId, slug)
}

function addFleetRow(
  sqlite: SqliteD1Harness['sqlite'],
  agentId: string,
  opts: { tenant?: string; runtime?: string; status?: string; lastReportedAt?: string } = {},
): void {
  sqlite.prepare(
    'INSERT INTO fleet_agents (tenant, agent_id, runtime, status, last_reported_at) VALUES (?, ?, ?, ?, ?)',
  ).run(
    opts.tenant ?? TENANT,
    agentId,
    opts.runtime ?? 'claude-code',
    opts.status ?? 'running',
    opts.lastReportedAt ?? utcStamp(Date.now()),
  )
}

// SQLite datetime('now')-shaped UTC stamp (no 'T', no 'Z') — matches derivePresence's parsing.
function utcStamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

describe('getFleetAgentRuntime / getFleetAgentLiveness — real SQLite', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    createSchema(harness.sqlite)
    env = { TENANT_SLUG: TENANT, DB: harness.db } as Env
  })

  afterEach(() => harness.close())

  describe('id ↔ slug bridge (single-agent cases)', () => {
    it('resolves through agents.slug when the fleet row is keyed by slug and the caller passes the uuid', async () => {
      addAgent(harness.sqlite, KASRA_UUID, 'squad-1', 'kasra')
      addFleetRow(harness.sqlite, 'kasra', { runtime: 'claude-code' })

      expect(await getFleetAgentRuntime(env, KASRA_UUID)).toBe('claude-code')
    })

    it('also matches a fleet row keyed directly by the uuid (forward-compatible, and preferred)', async () => {
      addAgent(harness.sqlite, KASRA_UUID, 'squad-1', 'kasra')
      addFleetRow(harness.sqlite, KASRA_UUID, { runtime: 'codex' })

      expect(await getFleetAgentRuntime(env, KASRA_UUID)).toBe('codex')
    })

    it('returns empty string when no agents row matches the caller\'s id at all', async () => {
      expect(await getFleetAgentRuntime(env, 'ghost-uuid')).toBe('')
    })

    it('returns empty string when the agent exists but has no fleet_agents row under either identity', async () => {
      addAgent(harness.sqlite, KASRA_UUID, 'squad-1', 'kasra')
      expect(await getFleetAgentRuntime(env, KASRA_UUID)).toBe('')
    })

    it('returns empty string for an empty runtime column', async () => {
      addAgent(harness.sqlite, KASRA_UUID, 'squad-1', 'kasra')
      addFleetRow(harness.sqlite, 'kasra', { runtime: '' })
      expect(await getFleetAgentRuntime(env, KASRA_UUID)).toBe('')
    })
  })

  describe('BLOCK regression — slug-collision misrouting (#353 v2 re-gate)', () => {
    it('a same-slug agent in a DIFFERENT squad is NEVER matched — the slug fallback refuses an ambiguous slug', async () => {
      // Agent A: squad-1, slug 'kasra', has a LIVE external fleet row keyed by that slug.
      const uuidA = 'uuid-agent-a'
      addAgent(harness.sqlite, uuidA, 'squad-1', 'kasra')
      addFleetRow(harness.sqlite, 'kasra', { runtime: 'claude-code', status: 'running', lastReportedAt: utcStamp(Date.now()) })

      // Agent B: squad-2 (DIFFERENT squad), ALSO slug 'kasra' — legal under the real schema's
      // UNIQUE(squad_id, slug) constraint (unique per squad, not tenant-wide).
      const uuidB = 'uuid-agent-b'
      addAgent(harness.sqlite, uuidB, 'squad-2', 'kasra')

      // A dispatch to B (event.agent_id = uuidB) must NEVER resolve to A's fleet row. The naive
      // join (`fa.agent_id = a.id OR fa.agent_id = a.slug`) would match here — B has no row of
      // its own, but `a.slug` (B's own slug) is 'kasra', which DOES exist in fleet_agents (it's
      // A's row). The fix must refuse this: B's slug is ambiguous tenant-wide (2 agents share
      // it), so B gets no delivery target at all — safe fallback to the in-Worker route, never a
      // misdelivery into A's inbox.
      const forB = await getFleetAgentLiveness(env, uuidB)
      expect(forB).toEqual({ runtime: '', live: false, agentId: '' })

      // The reverse must ALSO be refused, for the same reason: now that B exists with the same
      // slug, A's OWN resolution is equally ambiguous (fleet_agents has no squad_id column at
      // all — a bare slug key genuinely cannot tell A and B apart once both exist). This is the
      // correct, conservative behavior: better to fall back to in-Worker for BOTH than to guess.
      const forA = await getFleetAgentLiveness(env, uuidA)
      expect(forA).toEqual({ runtime: '', live: false, agentId: '' })
    })

    it('an EXACT id match always wins over a more-recent slug match — never overridden by recency', async () => {
      const uuid = 'uuid-agent-a'
      addAgent(harness.sqlite, uuid, 'squad-1', 'kasra')
      // Slug-keyed row: MORE RECENT, and would (wrongly) win under a plain
      // `ORDER BY last_reported_at DESC` across both match kinds.
      addFleetRow(harness.sqlite, 'kasra', { runtime: 'hermes-cron', lastReportedAt: utcStamp(Date.now()) })
      // Exact id-keyed row: OLDER, but must win because an exact PK match is unambiguous by
      // construction — recency must never be allowed to override it.
      addFleetRow(harness.sqlite, uuid, { runtime: 'codex', lastReportedAt: utcStamp(Date.now() - 3_600_000) })

      const result = await getFleetAgentLiveness(env, uuid)
      expect(result.runtime).toBe('codex')
      expect(result.agentId).toBe(uuid)
    })

    it('reserves an exact fleet identity from another agent whose unique slug matches that id', async () => {
      const exactAgentId = 'shared-runtime-id'
      const slugCandidateId = 'uuid-agent-b'
      addAgent(harness.sqlite, exactAgentId, 'squad-1', 'agent-a-slug')
      addAgent(harness.sqlite, slugCandidateId, 'squad-2', exactAgentId)
      addFleetRow(harness.sqlite, exactAgentId, {
        runtime: 'codex',
        status: 'running',
        lastReportedAt: utcStamp(Date.now()),
      })

      expect(await getFleetAgentLiveness(env, exactAgentId)).toEqual({
        runtime: 'codex',
        live: true,
        agentId: exactAgentId,
      })
      expect(await getFleetAgentLiveness(env, slugCandidateId)).toEqual({
        runtime: '',
        live: false,
        agentId: '',
      })
    })

    it('a same-slug collision across three squads still refuses safely (not just the 2-way case)', async () => {
      const uuidA = 'uuid-a'
      const uuidB = 'uuid-b'
      const uuidC = 'uuid-c'
      addAgent(harness.sqlite, uuidA, 'squad-1', 'kasra')
      addAgent(harness.sqlite, uuidB, 'squad-2', 'kasra')
      addAgent(harness.sqlite, uuidC, 'squad-3', 'kasra')
      addFleetRow(harness.sqlite, 'kasra', { runtime: 'claude-code' })

      for (const uuid of [uuidA, uuidB, uuidC]) {
        expect(await getFleetAgentLiveness(env, uuid)).toEqual({ runtime: '', live: false, agentId: '' })
      }
    })

    it('a DIFFERENT slug in a different squad does not collide (sanity: collision detection is not over-eager)', async () => {
      const uuidA = 'uuid-a'
      const uuidB = 'uuid-b'
      addAgent(harness.sqlite, uuidA, 'squad-1', 'kasra')
      addAgent(harness.sqlite, uuidB, 'squad-2', 'codex-agent') // distinct slug — no collision
      addFleetRow(harness.sqlite, 'kasra', { runtime: 'claude-code' })

      const result = await getFleetAgentLiveness(env, uuidA)
      expect(result.runtime).toBe('claude-code')
      expect(result.agentId).toBe('kasra')
    })
  })

  describe('presence semantics (derivePresence reuse — unchanged by the re-gate fix)', () => {
    it('external + running + within TTL → live', async () => {
      addAgent(harness.sqlite, KASRA_UUID, 'squad-1', 'kasra')
      addFleetRow(harness.sqlite, 'kasra', { runtime: 'claude-code', status: 'running', lastReportedAt: utcStamp(Date.now() - 5_000) })

      expect(await getFleetAgentLiveness(env, KASRA_UUID)).toEqual({ runtime: 'claude-code', live: true, agentId: 'kasra' })
    })

    it('external + running but beyond TTL → not live (stale)', async () => {
      const staleMs = Date.now() - (DEFAULT_PRESENCE_TTL_SEC + 60) * 1000
      addAgent(harness.sqlite, KASRA_UUID, 'squad-1', 'kasra')
      addFleetRow(harness.sqlite, 'kasra', { runtime: 'claude-code', status: 'running', lastReportedAt: utcStamp(staleMs) })

      expect(await getFleetAgentLiveness(env, KASRA_UUID)).toEqual({ runtime: 'claude-code', live: false, agentId: 'kasra' })
    })

    it('external + status=stopped → not live even with a fresh heartbeat (intent wins over recency)', async () => {
      addAgent(harness.sqlite, KASRA_UUID, 'squad-1', 'kasra')
      addFleetRow(harness.sqlite, 'kasra', { runtime: 'claude-code', status: 'stopped', lastReportedAt: utcStamp(Date.now()) })

      expect(await getFleetAgentLiveness(env, KASRA_UUID)).toEqual({ runtime: 'claude-code', live: false, agentId: 'kasra' })
    })

    it('no matching agents row → not external, not live, no delivery target', async () => {
      expect(await getFleetAgentLiveness(env, 'ghost-uuid')).toEqual({ runtime: '', live: false, agentId: '' })
    })

    it('tenant-scoped: a slug-matching fleet row in a different tenant is invisible', async () => {
      addAgent(harness.sqlite, KASRA_UUID, 'squad-1', 'kasra')
      addFleetRow(harness.sqlite, 'kasra', { tenant: 'other-tenant', runtime: 'claude-code', status: 'running' })

      expect(await getFleetAgentLiveness(env, KASRA_UUID)).toEqual({ runtime: '', live: false, agentId: '' })
    })

    it('defaults nowMs to Date.now() when omitted', async () => {
      addAgent(harness.sqlite, KASRA_UUID, 'squad-1', 'kasra')
      addFleetRow(harness.sqlite, 'kasra', { runtime: 'claude-code', status: 'running', lastReportedAt: utcStamp(Date.now()) })

      expect(await getFleetAgentLiveness(env, KASRA_UUID)).toEqual({ runtime: 'claude-code', live: true, agentId: 'kasra' })
    })
  })
})
