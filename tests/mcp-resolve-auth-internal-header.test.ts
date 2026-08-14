// tests/mcp-resolve-auth-internal-header.test.ts — resolveAuth's internal-header hop
// (src/mcp/index.ts, the workspace/im/dashboard "knownNonDirectory" re-read block).
//
// mupot #847 adversarial gate, P1: this re-read line —
//   if (knownNonDirectory) auth.boundAgentId = token.bound_agent_id ?? null
// — is a hand-resolved merge conflict on an auth path. Full-suite mutation proved:
//   Mutation A (delete the knownNonDirectory predicate)                -> 1 test RED.
//   Mutation B (keep predicate, assign a FOREIGN agent id as the VALUE) -> suite GREEN.
//   Mutation C (drop `AND t.tenant = ?3 AND m.tenant = ?3` from the re-read)
//                                                                       -> suite GREEN.
// Every existing test drives a `directory` channel through resolveAuth. None of them
// touch this branch at all, so B and C were unwitnessed, not merely under-asserted.
//
// Real SQLite (createSqliteD1 + applyAllMigrations, the #684/#720 ratchet) driven
// through the real HTTP surface (mcpApp.request), not a hand-rolled DB double — a
// dropped WHERE clause must be provable by a query that actually executes it.
//
// `boundAgentId` is a capability input, not a display field: resolveConsentedAgentCapabilities
// and the inbox/send agent-scoped tools gate on it directly. A wrong-but-present value
// is a privilege-confusion bug, not a cosmetic one — hence asserting the exact agent id,
// never merely `.not.toBeNull()`.

import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { mcpApp } from '../src/mcp'
import { AUTH_CONTEXT_HEADER } from '../src/mcp/auth-header'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'digid'
const OTHER_TENANT = 'othertenant'

function makeEnv(harness: SqliteD1Harness, tenant: string): Env {
  return { TENANT_SLUG: tenant, DB: harness.db } as unknown as Env
}

function seedAgent(sqlite: SqliteD1Harness['sqlite'], tenant: string, agentId: string): void {
  sqlite
    .prepare(`INSERT INTO departments (id, slug, name) VALUES (?, ?, ?)`)
    .run(`dept-${tenant}`, `dept-${tenant}`, `Dept ${tenant}`)
  sqlite
    .prepare(`INSERT INTO squads (id, department_id, slug, name) VALUES (?, ?, ?, ?)`)
    .run(`squad-${tenant}`, `dept-${tenant}`, `squad-${tenant}`, `Squad ${tenant}`)
  sqlite
    .prepare(
      `INSERT INTO agents (id, squad_id, slug, name, role, model, status)
       VALUES (?, ?, ?, ?, 'member', 'test', 'active')`,
    )
    .run(agentId, `squad-${tenant}`, agentId, agentId)
}

function seedMemberToken(
  sqlite: SqliteD1Harness['sqlite'],
  opts: {
    memberId: string
    tokenId: string
    tenant: string
    boundAgentId?: string | null
    status?: 'active' | 'suspended'
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO members (id, email, display_name, status, tenant)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(opts.memberId, `${opts.memberId}@example.test`, opts.memberId, opts.status ?? 'active', opts.tenant)
  if (opts.boundAgentId) {
    // member_tokens_agent_binding_insert (migration 0071) aborts a bound INSERT unless
    // this weld row already exists for the exact (tenant, agent_id, member_id) triple.
    sqlite
      .prepare(
        `INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
         VALUES (?, ?, ?, datetime('now'))`,
      )
      .run(opts.tenant, opts.boundAgentId, opts.memberId)
  }
  sqlite
    .prepare(
      `INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
       VALUES (?, ?, 'unused-hash-not-exercised-by-this-hop', 'test', 'workspace', datetime('now'), ?, ?)`,
    )
    .run(opts.tokenId, opts.memberId, opts.boundAgentId ?? null, opts.tenant)
}

/** Injected internal AuthContext, as McpOAuthApiHandler/mcpInternalRequest would set it. */
function authHeader(auth: AuthContext): Record<string, string> {
  return { [AUTH_CONTEXT_HEADER]: JSON.stringify(auth) }
}

async function statusVia(env: Env, auth: AuthContext): Promise<{ status: number; body: { ok: boolean; result?: { bound_agent_id: string | null } } }> {
  const res = await mcpApp.request(
    'https://pot.example/',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(auth) },
      body: JSON.stringify({ tool: 'status', args: {} }),
    },
    env,
  )
  const body = (await res.json()) as { ok: boolean; result?: { bound_agent_id: string | null } }
  return { status: res.status, body }
}

describe('resolveAuth internal-header hop — workspace-channel token re-read (P1 #847)', () => {
  let harness: SqliteD1Harness

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
  })
  afterEach(() => harness.close())

  it('resolves boundAgentId to the agent actually welded to the token row, not the header claim (kills mutation B)', async () => {
    seedAgent(harness.sqlite, TENANT, 'agent-real-weld')
    seedMemberToken(harness.sqlite, {
      memberId: 'member-workspace-1',
      tokenId: 'tok-workspace-1',
      tenant: TENANT,
      boundAgentId: 'agent-real-weld',
    })

    const injected: AuthContext = {
      userId: 'member-workspace-1',
      email: 'member-workspace-1@example.test',
      role: 'member',
      tenant: TENANT,
      memberId: 'member-workspace-1',
      channel: 'workspace',
      capabilities: [],
      // The header CLAIMS a different agent than the token row actually welds. If
      // resolveAuth ever trusted this claim instead of re-deriving from the live
      // token row, this value would leak straight into a capability input.
      boundAgentId: 'agent-FORGED-CLAIM',
      tokenId: 'tok-workspace-1',
    }

    const { status, body } = await statusVia(makeEnv(harness, TENANT), injected)

    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    // Exact value, not `.not.toBeNull()` — a wrong-but-present agent id is the
    // privilege-confusion bug the adversarial gate found unwitnessed.
    expect(body.result?.bound_agent_id).toBe('agent-real-weld')
    expect(body.result?.bound_agent_id).not.toBe('agent-FORGED-CLAIM')
  })

  it('never resolves boundAgentId from a token row belonging to another tenant (kills mutation C)', async () => {
    seedAgent(harness.sqlite, OTHER_TENANT, 'agent-other-tenant-weld')
    seedMemberToken(harness.sqlite, {
      memberId: 'member-cross-tenant',
      tokenId: 'tok-cross-tenant',
      tenant: OTHER_TENANT,
      boundAgentId: 'agent-other-tenant-weld',
    })

    const injected: AuthContext = {
      userId: 'member-cross-tenant',
      email: 'member-cross-tenant@example.test',
      role: 'member',
      // The outer AuthContext claims THIS tenant (matches env.TENANT_SLUG, so the
      // request clears the tools/call tenant check) — the only thing wrong is that
      // the token row it names lives in a DIFFERENT tenant.
      tenant: TENANT,
      memberId: 'member-cross-tenant',
      channel: 'workspace',
      capabilities: [],
      boundAgentId: 'agent-other-tenant-weld',
      tokenId: 'tok-cross-tenant',
    }

    const { status, body } = await statusVia(makeEnv(harness, TENANT), injected)

    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    // The cross-tenant token row must not resolve at all — boundAgentId falls back
    // to null exactly like an unbound/missing token, never the foreign tenant's weld.
    expect(body.result?.bound_agent_id).toBeNull()
  })
})
