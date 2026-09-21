// tests/home-squad-callsite-coverage.test.ts — mupot#1452 P0-1 Round 2,
// Athena condition (b): every collapsed `canOnSquad` call site
// (src/im/index.ts, src/channels/index.ts, src/org/index.ts,
// src/dashboard/index.ts) and every `hasWorkspaceAdmin`-bypass site fixed in
// src/mcp/index.ts (flight delegation, flight referenced-squares, flight_list,
// wake_agent — wake_agent already covered by tests/home-squad.test.ts's test
// (g)) must be proven THROUGH that call site, not merely at the shared
// primitive (already exhaustively mutation-proven in tests/home-squad.test.ts
// and tests/org-kind-exemption.test.ts). Real migration chain throughout.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHomeForMember, createDepartment, createSquad } from '../src/org/service'
import { invokeTool } from '../src/mcp'
import { handleImMessage } from '../src/im'
import { runInbound } from '../src/channels'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'mumega'

function orgAdminGrantAuth(memberId: string, boundAgentId: string | null = null): AuthContext {
  return {
    userId: memberId,
    memberId,
    email: null,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId,
    // A rank-4 org-scope grant — NOT the legacy role plane — is exactly the
    // shape hasWorkspaceAdmin's manual bypass used to honour unconditionally
    // for every squad, home included, before this round's fix.
    capabilities: [{ member_id: memberId, scope_type: 'org', scope_id: null, capability: 'admin' }],
  }
}

describe('mupot#1452 P0-1 call-site coverage (Athena condition b)', () => {
  let harness: SqliteD1Harness
  let env: Env
  let workSquadId: string
  let homeSquadId: string
  let homeAgentId: string

  beforeEach(async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = { TENANT_SLUG: TENANT, DB: harness.db } as unknown as Env

    await env.DB.prepare(`INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('member-shadi', ?1, NULL, 'Shadi', 'active', datetime('now'))`).bind(TENANT).run()
    await env.DB.prepare(`INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('member-admin', ?1, NULL, 'Admin', 'active', datetime('now'))`).bind(TENANT).run()

    const dept = await createDepartment(env, { slug: 'dept-work', name: 'Work Dept' })
    if (!dept.ok) throw new Error('setup failed')
    const squad = await createSquad(env, dept.value.id, { slug: 'squad-work', name: 'Work Squad' })
    if (!squad.ok) throw new Error('setup failed')
    workSquadId = squad.value.id

    const home = await createHomeForMember(env, 'member-shadi', {
      userId: 'member-shadi',
      memberId: 'member-shadi',
      email: null,
      role: 'member',
      tenant: TENANT,
      channel: 'workspace',
      boundAgentId: null,
      capabilities: [],
    })
    if (!home.ok) throw new Error('setup failed')
    homeSquadId = home.squad.id

    homeAgentId = 'agent-home-shadi-cov'
    await env.DB.prepare(
      `INSERT INTO agents (id, squad_id, slug, name, status) VALUES (?1, ?2, 'self-shadi-cov', 'Shadi Self', 'active')`,
    ).bind(homeAgentId, homeSquadId).run()
  })

  afterEach(() => harness.close())

  // ── site: src/im/index.ts's canOnSquad (delegates to auth/capability.ts) ────
  it('im/index.ts wakeReply: an org-scope admin grant is refused waking an agent seated on a home squad', async () => {
    await env.DB.prepare(`INSERT INTO members (id, tenant, email, display_name, telegram_chat_id, status, created_at)
       VALUES ('member-im-admin', ?1, NULL, 'IM Admin', '999888', 'active', datetime('now'))`).bind(TENANT).run()
    await env.DB.prepare(
      `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
       VALUES ('cap-im-admin', 'member-im-admin', 'org', NULL, 'admin')`,
    ).run()

    const reply = await handleImMessage(env, '999888', 'wake self-shadi-cov')
    expect(reply).toContain("don't have permission")
  })

  // ── site: src/channels/index.ts's canOnSquad (delegates to auth/capability.ts) ─
  // NOTE: 'wake'/'task' intents are directive-capable actions, gated FIRST by a
  // hardcoded Hadi-only sender allowlist (mumega-com#722) — a non-directive
  // sender never reaches canOnSquad at all. Using the directive sender here is
  // what it takes to exercise THIS call site; the directive gate itself is a
  // separate, unrelated control this test does not touch.
  it('channels/index.ts runInbound wake path: an org-scope admin grant is refused waking an agent seated on a home squad', async () => {
    await env.DB.prepare(
      `INSERT INTO channel_bindings (id, platform, external_channel_id, squad_id) VALUES ('cb-1', 'telegram', 'chan-1', ?1)`,
    ).bind(workSquadId).run()
    await env.DB.prepare(
      `INSERT INTO member_identities (id, member_id, platform, external_user_id) VALUES ('mi-1', 'member-admin', 'telegram', '765204057')`,
    ).run()
    await env.DB.prepare(
      `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
       VALUES ('cap-ch-admin', 'member-admin', 'org', NULL, 'admin')`,
    ).run()

    const reply = await runInbound(env, 'telegram', 'chan-1', '765204057', 'wake self-shadi-cov')
    expect(reply).toContain("don't have permission")
  })

  // (src/org/index.ts's `canOnSquad` and src/dashboard/index.ts's `canOnSquad` /
  // `canOnSquadRead` are HTTP routes gated by the `requireAuth` middleware —
  // covered in tests/org-home-squad-http-routes.test.ts, which mocks that
  // middleware the same way tests/org-kind-boundary.test.ts and
  // tests/org-home-squad-listing.test.ts already do. Kept in a separate file
  // because `vi.mock('../src/auth')` is module-global and would otherwise
  // break this file's real auth-resolution paths for IM/channels/MCP.)

  // ── site: src/mcp/index.ts flight_list's initial squad gate ────────────────
  it('mcp/index.ts flight_list: an org-scope admin grant is refused the initial squad gate on a home squad', async () => {
    const auth = orgAdminGrantAuth('member-admin')
    const out = await invokeTool(auth, env, 'flight_list', { squad_id: homeSquadId }, 'test')
    expect(out.ok).toBe(false)
    expect((out as unknown as { status: number })).toMatchObject({ status: 403 })
  })

  // ── site: src/mcp/index.ts flight_dispatch executor delegation ─────────────
  it('mcp/index.ts flight_dispatch: delegating execution to an agent seated on a home squad is refused for an org-scope admin grant', async () => {
    const dispatcherId = 'agent-dispatcher-cov'
    await env.DB.prepare(
      `INSERT INTO agents (id, squad_id, slug, name, status) VALUES (?1, ?2, 'dispatcher-cov', 'Dispatcher', 'active')`,
    ).bind(dispatcherId, workSquadId).run()

    const auth = orgAdminGrantAuth('member-admin', dispatcherId)
    const meta = {
      schema: 'mupot.flight.meta/v1',
      goal_id: 'g1',
      objective_id: 'o1',
      squad_ids: [workSquadId, homeSquadId],
      task_ids: ['t1'],
      done_when: ['d1'],
      artifact_refs: [],
      receipt_refs: [],
      confidentiality: 'internal',
      publication_target: 'none',
      parent_flight_id: null,
    }
    const signals = {
      contextComplete: true,
      toolsReachable: true,
      budgetRemainingMicroUsd: 0,
      budgetEstimateMicroUsd: 0,
      recentProgress: 0.5,
      progressPerStep: 0.5,
      wastePerStep: 0.1,
      stepSeconds: 10,
    }
    const out = await invokeTool(auth, env, 'flight_dispatch', {
      squad_id: workSquadId,
      goal: 'test delegation refusal',
      budget_micro_usd: 0,
      meta_json: JSON.stringify(meta),
      signals_json: JSON.stringify(signals),
      executor_agent_id: homeAgentId,
    }, 'test')
    expect(out.ok).toBe(false)
    expect((out as unknown as { status: number; error: string })).toMatchObject({ status: 403, error: 'flight_delegation_forbidden' })
  })

  // ── site: src/mcp/index.ts flight_dispatch referenced-squares loop ─────────
  it('mcp/index.ts flight_dispatch: a home squad merely REFERENCED in flight meta is refused for an org-scope admin grant', async () => {
    const dispatcherId = 'agent-dispatcher-cov2'
    await env.DB.prepare(
      `INSERT INTO agents (id, squad_id, slug, name, status) VALUES (?1, ?2, 'dispatcher-cov2', 'Dispatcher2', 'active')`,
    ).bind(dispatcherId, workSquadId).run()

    const auth = orgAdminGrantAuth('member-admin', dispatcherId)
    const meta = {
      schema: 'mupot.flight.meta/v1',
      goal_id: 'g2',
      objective_id: 'o2',
      squad_ids: [workSquadId, homeSquadId],
      task_ids: ['t2'],
      done_when: ['d2'],
      artifact_refs: [],
      receipt_refs: [],
      confidentiality: 'internal',
      publication_target: 'none',
      parent_flight_id: null,
    }
    const signals = {
      contextComplete: true,
      toolsReachable: true,
      budgetRemainingMicroUsd: 0,
      budgetEstimateMicroUsd: 0,
      recentProgress: 0.5,
      progressPerStep: 0.5,
      wastePerStep: 0.1,
      stepSeconds: 10,
    }
    const out = await invokeTool(auth, env, 'flight_dispatch', {
      squad_id: workSquadId,
      goal: 'test referenced-squad refusal',
      budget_micro_usd: 0,
      meta_json: JSON.stringify(meta),
      signals_json: JSON.stringify(signals),
      // no executor_agent_id: executor === dispatcher, isDelegated=false, so
      // the delegation check above is skipped and ONLY the referenced-squares
      // loop can refuse this call.
    }, 'test')
    expect(out.ok).toBe(false)
    expect((out as unknown as { status: number; squad_id?: string })).toMatchObject({ status: 403 })
  })
})
