// tests/token-label-honesty.test.ts — P0 honesty lock-in (Kasra 3750 AMBER).
//
// boot_context / status echo member_tokens.label as token_label.
// check_in 403 seat_mismatch when args.seat ≠ that label.
// A minted session that claimed the wrong seat still returns enroll_url (/enroll).
//
// Kasra 3750 rejected ONE line: "enroll keys stay cap member" for an existing
// agent. That is FALSE — AGENT_TOKEN_CAPABILITIES clamps what the mint MAY WRITE,
// not what resolveCapabilities loads for a workspace-channel key. This suite does
// not implement or assert that false clamp, and does not grant admin / org:admin
// / operator to enroll keys or Cursor cloud runs.
//
// Schema: createSqliteD1() + applyAllMigrations() only.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { invokeTool } from '../src/mcp/index'
import { mcpApp } from '../src/mcp'
import { mintAgentBoundToken } from '../src/members/service'
import { enrollUrl } from '../src/dashboard/enroll'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'mumega'
const ORIGIN = 'https://pot.test'
const SQUAD = 'squad-eng'
const AGENT_ID = 'a-grok-desktop'
const MEMBER_ID = 'm-grok-desktop'
const TOKEN_LABEL = 'grok-bot-desktop'
const CLAIMED_SEAT = 'cursor-river'

describe('P0 token_label honesty lock-in (real SQLite D1)', () => {
  let harness: SqliteD1Harness
  let env: Env
  let minted: { raw: string; tokenId: string; grantCapability: string }
  let labelledAuth: AuthContext

  beforeAll(async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)

    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name, created_at) VALUES ('dept-1', 'eng', 'Engineering', datetime('now'));
      INSERT INTO squads (id, department_id, slug, name, created_at) VALUES ('${SQUAD}', 'dept-1', 'squad-eng', 'Engineering Squad', datetime('now'));
      INSERT INTO members (id, tenant, display_name, email, status, created_at) VALUES
        ('${MEMBER_ID}', '${TENANT}', 'hadi-grok-desktop', NULL, 'active', datetime('now'));
      INSERT INTO agents (id, squad_id, slug, name, role, model, status, created_at) VALUES
        ('${AGENT_ID}', '${SQUAD}', 'hadi-grok-desktop', 'hadi-grok-desktop', 'agent', 'grok-4.6', 'active', datetime('now'));
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES
        ('${TENANT}', '${AGENT_ID}', '${MEMBER_ID}', datetime('now'));
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
        ('cap-1', '${MEMBER_ID}', 'squad', '${SQUAD}', 'member');
    `)

    const sessionsStore = new Map<string, string>()
    env = {
      TENANT_SLUG: TENANT,
      PUBLIC_ORIGIN: ORIGIN,
      DB: harness.db,
      SESSIONS: {
        get: async (k: string) => sessionsStore.get(k) ?? null,
        put: async (k: string, v: string) => { sessionsStore.set(k, v) },
        delete: async (k: string) => { sessionsStore.delete(k) },
      },
    } as unknown as Env

    minted = await mintAgentBoundToken(
      env,
      { id: AGENT_ID, slug: 'hadi-grok-desktop', name: 'hadi-grok-desktop', squad_id: SQUAD } as never,
      TOKEN_LABEL,
    )

    labelledAuth = {
      userId: MEMBER_ID,
      memberId: MEMBER_ID,
      email: null,
      role: 'member',
      tenant: TENANT,
      channel: 'workspace',
      boundAgentId: AGENT_ID,
      tokenId: minted.tokenId,
      capabilities: [{ member_id: MEMBER_ID, scope_type: 'squad', scope_id: SQUAD, capability: 'member' }],
    }
  })

  afterAll(() => {
    harness.close()
  })

  async function callTool(toolName: string, args: Record<string, unknown>, raw = minted.raw) {
    return mcpApp.request(
      `${ORIGIN}/`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${raw}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: `req-${toolName}`,
          method: 'tools/call',
          params: { name: toolName, arguments: args },
        }),
      },
      env,
    )
  }

  it('mint write-path still records capability member — not a runtime clamp, not admin', () => {
    // The mint MAY WRITE observer|member. Kasra 3750: that is NOT what the bound
    // member already HOLDS at resolve time. We only assert the write, and we never
    // elevate it to admin / org:admin / operator.
    expect(minted.grantCapability).toBe('member')
    const row = harness.sqlite.prepare(
      `SELECT label, channel FROM member_tokens WHERE id = ?`,
    ).get(minted.tokenId) as { label: string; channel: string }
    expect(row.label).toBe(TOKEN_LABEL)
    expect(row.channel).toBe('workspace')
  })

  it('boot_context echoes token_label from the live member_tokens.label', async () => {
    const res = await callTool('boot_context', {})
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      result: { structuredContent: { token_label: string | null; identity_status: string; enroll_url?: string } }
    }
    const sc = body.result.structuredContent
    expect(sc.identity_status).toBe('minted')
    expect(sc.token_label).toBe(TOKEN_LABEL)
    expect(sc.enroll_url).toBeUndefined()
  })

  it('status self-echo includes token_label', async () => {
    const res = await invokeTool(labelledAuth, env, 'status', {})
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect((res.result as { token_label: string | null }).token_label).toBe(TOKEN_LABEL)
  })

  it('check_in with the matching seat succeeds and echoes token_label', async () => {
    const res = await invokeTool(labelledAuth, env, 'check_in', {
      seat: TOKEN_LABEL,
      harness: 'grok-cli',
      machine: 'hadi-mac',
      model: 'grok-4.6',
      provider: 'xai',
      effort: 'high',
    }, ORIGIN)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.result).toMatchObject({
      seat: TOKEN_LABEL,
      token_label: TOKEN_LABEL,
      agent_id: AGENT_ID,
      debounced: false,
    })
  })

  it('check_in with a different seat is 403 seat_mismatch and still returns /enroll', async () => {
    const res = await invokeTool(labelledAuth, env, 'check_in', {
      seat: CLAIMED_SEAT,
      harness: 'cursor-cloud',
      machine: 'cursor-cloud-vm',
      model: 'grok-4.6',
      provider: 'xai',
      effort: 'high',
    }, ORIGIN)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(403)
    expect(res.error).toBe('seat_mismatch')
    const detail = res.detail as { token_label: string; enroll_url: string; detail: string }
    expect(detail.token_label).toBe(TOKEN_LABEL)
    expect(detail.enroll_url).toBe(enrollUrl(ORIGIN, CLAIMED_SEAT))
    expect(detail.enroll_url).toContain('/enroll')
    expect(detail.enroll_url).not.toContain('/connect')
    expect(detail.enroll_url).toContain(CLAIMED_SEAT)

    const lyingPresence = harness.sqlite.prepare(
      `SELECT label FROM presence WHERE tenant = ? AND member_id = ? AND label = ?`,
    ).get(TENANT, MEMBER_ID, CLAIMED_SEAT)
    expect(lyingPresence).toBeUndefined()
  })

  it('minted boot_context on the wrong claimed seat still returns enroll_url at /enroll', async () => {
    const res = await callTool('boot_context', { seat: CLAIMED_SEAT })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      result: {
        structuredContent: {
          token_label: string | null
          identity_status: string
          enroll_url?: string
          next_step: string
        }
      }
    }
    const sc = body.result.structuredContent
    expect(sc.identity_status).toBe('minted')
    expect(sc.token_label).toBe(TOKEN_LABEL)
    expect(sc.enroll_url).toBe(enrollUrl(ORIGIN, CLAIMED_SEAT))
    expect(sc.enroll_url).toContain('/enroll')
    expect(sc.enroll_url).not.toContain('/connect')
    expect(sc.next_step).not.toContain('/enroll')
    expect(sc.next_step).not.toContain('/connect?')
  })

  it('check_in without args.seat still succeeds on a labelled token', async () => {
    const res = await invokeTool(labelledAuth, env, 'check_in', {
      harness: 'grok-cli',
      source: 'grok-cli',
    }, ORIGIN)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect((res.result as { token_label: string | null }).token_label).toBe(TOKEN_LABEL)
    expect((res.result as { seat: string }).seat).toBe(TOKEN_LABEL)
  })

  it('check_in with a declared seat still works when the token has no label binding', async () => {
    const noTokenAuth: AuthContext = {
      ...labelledAuth,
      tokenId: undefined,
    }
    const res = await invokeTool(noTokenAuth, env, 'check_in', { seat: 'cursor-mac' }, ORIGIN)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect((res.result as { seat: string }).seat).toBe('cursor-mac')
    expect((res.result as { token_label: string | null }).token_label).toBeNull()
  })
})
