// tests/mcp-token-identity.test.ts — MCP bearer authentication token identity
// (src/mcp/index.ts#authenticateMember).
//
// Real SQLite, and the schema is the WHOLE committed migration chain via
// applyAllMigrations (the #684/#720 ratchet — scripts/check-test-schema-source.mjs).
//
// The first draft of this file hand-rolled a D1-shaped `prepare()` object literal
// that string-matched the SQL text and answered whatever the test expected — it
// never executed a query, so a SELECT naming a column that does not exist (the
// exact #684 defect class), or a tenant predicate silently dropped, could not be
// contradicted. It could only ever confirm the author's belief about the schema,
// never the schema itself.

import { createHash } from 'node:crypto'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { authenticateMember } from '../src/mcp'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'digid'
const RAW_TOKEN = 'issued-agent-key'
const TOKEN_HASH = createHash('sha256').update(RAW_TOKEN).digest('hex')

function makeEnv(harness: SqliteD1Harness, tenant: string): Env {
  return { TENANT_SLUG: tenant, DB: harness.db } as unknown as Env
}

/** Same shape `authenticateMember`'s caller (mcpApp) provides: a header reader. */
function requestWith(rawToken: string | undefined) {
  return {
    req: {
      header: (name: string) =>
        rawToken !== undefined && name.toLowerCase() === 'authorization' ? `Bearer ${rawToken}` : undefined,
    },
  }
}

function seedAgent(sqlite: SqliteD1Harness['sqlite'], tenant: string, agentId: string): void {
  sqlite
    .prepare(
      `INSERT INTO departments (id, slug, name) VALUES (?, ?, ?)`,
    )
    .run(`dept-${tenant}`, `dept-${tenant}`, `Dept ${tenant}`)
  sqlite
    .prepare(
      `INSERT INTO squads (id, department_id, slug, name) VALUES (?, ?, ?, ?)`,
    )
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
    tokenHash: string
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
    .run(opts.memberId, `${opts.memberId}@digid.test`, opts.memberId, opts.status ?? 'active', opts.tenant)
  if (opts.boundAgentId) {
    // member_tokens_agent_binding_insert (migration 0071) aborts a bound INSERT unless
    // this weld row already exists for the exact (tenant, agent_id, member_id) triple —
    // the same real trigger production relies on, not a fixture belief about it.
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
       VALUES (?, ?, ?, 'test', 'workspace', datetime('now'), ?, ?)`,
    )
    .run(opts.tokenId, opts.memberId, opts.tokenHash, opts.boundAgentId ?? null, opts.tenant)
}

describe('authenticateMember — token identity', () => {
  let harness: SqliteD1Harness

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
  })
  afterEach(() => harness.close())

  it('derives tokenId and boundAgentId from the same live tenant-scoped token row', async () => {
    seedAgent(harness.sqlite, TENANT, 'agent-7')
    seedMemberToken(harness.sqlite, {
      memberId: 'member-7',
      tokenId: 'tok-agent-7',
      tokenHash: TOKEN_HASH,
      tenant: TENANT,
      boundAgentId: 'agent-7',
    })

    const auth = await authenticateMember({ ...requestWith(RAW_TOKEN), env: makeEnv(harness, TENANT) })

    expect(auth).toMatchObject({
      tokenId: 'tok-agent-7',
      memberId: 'member-7',
      boundAgentId: 'agent-7',
      tenant: TENANT,
    })
  })

  it('an unbound token authenticates the member with boundAgentId null', async () => {
    seedMemberToken(harness.sqlite, {
      memberId: 'member-human-1',
      tokenId: 'tok-human-1',
      tokenHash: TOKEN_HASH,
      tenant: TENANT,
    })

    const auth = await authenticateMember({ ...requestWith(RAW_TOKEN), env: makeEnv(harness, TENANT) })

    expect(auth).toMatchObject({
      tokenId: 'tok-human-1',
      memberId: 'member-human-1',
      boundAgentId: null,
      tenant: TENANT,
    })
  })

  it('never authenticates a token row belonging to another tenant', async () => {
    // Same-shaped row, live and active — the ONLY thing wrong with it is tenant.
    // A tenant predicate dropped from the SQL (or silently short-circuited) would
    // let this succeed; a mock that string-matches the query text can never prove
    // it stayed in the executed statement the way a real WHERE clause does.
    seedMemberToken(harness.sqlite, {
      memberId: 'member-other-tenant',
      tokenId: 'tok-other-tenant',
      tokenHash: TOKEN_HASH,
      tenant: 'other-tenant',
    })

    const auth = await authenticateMember({ ...requestWith(RAW_TOKEN), env: makeEnv(harness, TENANT) })

    expect(auth).toBeNull()
  })

  it('a suspended member authenticates to null even with a live, unrevoked token', async () => {
    seedMemberToken(harness.sqlite, {
      memberId: 'member-suspended',
      tokenId: 'tok-suspended',
      tokenHash: TOKEN_HASH,
      tenant: TENANT,
      status: 'suspended',
    })

    const auth = await authenticateMember({ ...requestWith(RAW_TOKEN), env: makeEnv(harness, TENANT) })

    expect(auth).toBeNull()
  })

  it('null on a missing Authorization header (no DB hit needed)', async () => {
    const auth = await authenticateMember({ ...requestWith(undefined), env: makeEnv(harness, TENANT) })
    expect(auth).toBeNull()
  })
})
