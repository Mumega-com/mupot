// tests/mcp-bootstrap-tool.test.ts — mupot#925: the bootstrap_self MCP TOOL
// wiring (schema, dispatch, min:'authenticated', error mapping). The service
// logic itself (gates, idempotence, audit, compensation) is covered against
// real sqlite in tests/bootstrap-self.test.ts — this file proves the thin MCP
// glue in src/mcp/bootstrap.ts is actually reachable through invokeTool/TOOLS,
// the same seam a real connector call goes through.

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { TOOLS, invokeTool } from '../src/mcp/index'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'mumega'
const HUMAN = 'member-human-1'

function memoryKv() {
  const store = new Map<string, string>()
  return {
    async get(key: string) { return store.get(key) ?? null },
    async put(key: string, value: string) { store.set(key, value) },
    async delete(key: string) { store.delete(key) },
  }
}

function envFor(harness: SqliteD1Harness): Env {
  return { DB: harness.db, TENANT_SLUG: TENANT, SESSIONS: memoryKv() } as unknown as Env
}

function unboundDirectoryAuth(): AuthContext {
  return {
    userId: HUMAN,
    email: 'human@example.test',
    role: 'member',
    tenant: TENANT,
    memberId: HUMAN,
    channel: 'directory',
    capabilities: [],
    boundAgentId: null,
  }
}

let harness: SqliteD1Harness

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(
    `INSERT INTO members (id, email, display_name, status, created_at, tenant)
     VALUES ('${HUMAN}', 'human@example.test', 'Human', 'active', '2026-08-11T00:00:00.000Z', '${TENANT}')`,
  )
})

afterEach(() => {
  harness.close()
})

describe('bootstrap_self is registered on the tool surface', () => {
  it('is present in TOOLS with min:"authenticated" (same posture as connect)', () => {
    const spec = TOOLS.find((t) => t.name === 'bootstrap_self')
    expect(spec).toBeDefined()
    expect(spec?.min).toBe('authenticated')
    expect(spec?.inputSchema.required).toEqual(['agent_name'])
  })
})

describe('bootstrap_self via invokeTool — an unbound directory session with ZERO capabilities can still reach it', () => {
  it('a zero-capability directory session succeeds (the AAGATE floor does not block it)', async () => {
    const env = envFor(harness)
    const out = await invokeTool(unboundDirectoryAuth(), env, 'bootstrap_self', { agent_name: 'Aria' }, 'https://pot.test')
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error(`expected success, got ${out.error}`)
    const result = out.result as {
      agent: { id: string; name: string }
      token: { id: string; capability: string }
      credential_claim: { claim_id: string; fingerprint: string; expires_at: string }
      next_actions: {
        current_session_bound: boolean
        recommended: string
        agent_id: string
        credential_claim_use: string
        steps: string[]
      }
      note: string
    }
    expect(result.agent.name).toBe('Aria')
    // mupot#987: the raw token must never appear in this tool result — only a
    // single-use claim. Structural proof (not a field-by-field allowlist): the
    // string "raw" never appears as a key anywhere in the serialized result.
    expect(JSON.stringify(out.result)).not.toMatch(/"raw"\s*:/)
    expect(result.credential_claim.claim_id).toBeTruthy()
    expect(result.credential_claim.fingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(result.next_actions).toEqual({
      current_session_bound: false,
      recommended: 'reconnect_and_select_agent',
      agent_id: result.agent.id,
      credential_claim_use: 'local_or_headless_only',
      steps: [
        'Reconnect the Mupot MCP connector.',
        'Select the newly created agent at the consent screen.',
        'Call boot_context, orient, then check_in.',
      ],
    })
    expect(result.note).toMatch(/reconnect.*select/i)
    expect(result.note).toMatch(/do not reveal.*interactive OAuth/i)

    const revealed = await invokeTool(
      unboundDirectoryAuth(),
      env,
      'reveal_credential_claim',
      { claim_id: result.credential_claim.claim_id },
      'https://pot.test',
    )
    expect(revealed.ok).toBe(true)
    if (!revealed.ok) throw new Error(`expected reveal to succeed, got ${revealed.error}`)
    expect((revealed.result as { raw: string }).raw).toMatch(/^mupot_/)

    // Single-use: redeeming the same claim again finds nothing.
    const revealedAgain = await invokeTool(
      unboundDirectoryAuth(),
      env,
      'reveal_credential_claim',
      { claim_id: result.credential_claim.claim_id },
      'https://pot.test',
    )
    expect(revealedAgain.ok).toBe(false)
    if (revealedAgain.ok) throw new Error('expected the second reveal to be refused')
    expect(revealedAgain.status).toBe(410)
  })

  it('a DIFFERENT member cannot redeem someone else\'s claim (owner-gated, mupot#987)', async () => {
    const env = envFor(harness)
    const out = await invokeTool(unboundDirectoryAuth(), env, 'bootstrap_self', { agent_name: 'Aria' }, 'https://pot.test')
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error(`expected success, got ${out.error}`)
    const result = out.result as { credential_claim: { claim_id: string } }

    const attacker: AuthContext = { ...unboundDirectoryAuth(), userId: 'someone-else', memberId: 'someone-else' }
    const stolen = await invokeTool(
      attacker,
      env,
      'reveal_credential_claim',
      { claim_id: result.credential_claim.claim_id },
      'https://pot.test',
    )
    expect(stolen.ok).toBe(false)
    if (stolen.ok) throw new Error('expected the wrong-owner reveal to be refused')
    expect(stolen.status).toBe(410)

    // And it burned the claim even on the wrong-owner attempt — the legitimate
    // owner can no longer redeem it either (fail-closed, not fail-open-once-checked).
    const ownerRetry = await invokeTool(
      unboundDirectoryAuth(),
      env,
      'reveal_credential_claim',
      { claim_id: result.credential_claim.claim_id },
      'https://pot.test',
    )
    expect(ownerRetry.ok).toBe(false)
  })

  it('rejects a missing agent_name at the schema layer, before the handler runs', async () => {
    const env = envFor(harness)
    const out = await invokeTool(unboundDirectoryAuth(), env, 'bootstrap_self', {}, 'https://pot.test')
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('expected refusal')
    expect(out.status).toBe(400)
    expect(out.error).toBe('invalid_args')
  })

  it('a workspace-channel token (not the public directory door) is refused by the tool handler', async () => {
    const env = envFor(harness)
    const auth: AuthContext = { ...unboundDirectoryAuth(), channel: 'workspace' }
    const out = await invokeTool(auth, env, 'bootstrap_self', { agent_name: 'Aria' }, 'https://pot.test')
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('expected refusal')
    expect(out.status).toBe(403)
    expect(out.error).toBe('not_unbound_directory_session')
  })

  it('an agent-bound token is refused even though it already has real capabilities', async () => {
    const env = envFor(harness)
    const auth: AuthContext = {
      ...unboundDirectoryAuth(),
      boundAgentId: 'agent-already-bound',
      capabilities: [{ member_id: HUMAN, scope_type: 'squad', scope_id: 'squad-x', capability: 'member' }],
    }
    const out = await invokeTool(auth, env, 'bootstrap_self', { agent_name: 'Aria' }, 'https://pot.test')
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('expected refusal')
    expect(out.status).toBe(403)
    expect(out.error).toBe('not_unbound_directory_session')
  })

  it('a second call for the same member surfaces already_bootstrapped as a 409 through the tool seam', async () => {
    const env = envFor(harness)
    const first = await invokeTool(unboundDirectoryAuth(), env, 'bootstrap_self', { agent_name: 'Aria' }, 'https://pot.test')
    expect(first.ok).toBe(true)
    const second = await invokeTool(unboundDirectoryAuth(), env, 'bootstrap_self', { agent_name: 'Bora' }, 'https://pot.test')
    expect(second.ok).toBe(false)
    if (second.ok) throw new Error('expected refusal')
    expect(second.status).toBe(409)
    expect(second.error).toBe('already_bootstrapped')
  })
})
