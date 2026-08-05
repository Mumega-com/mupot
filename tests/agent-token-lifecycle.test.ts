import { describe, expect, it } from 'vitest'
import { mcpApp } from '../src/mcp'
import type { CapabilityGrant, Env } from '../src/types'

// mupot#682 — list_agent_tokens / revoke_agent_token.
//
// mint_agent_token shipped with no counterpart: the pot could ISSUE a credential
// through its own surface but not SEE or WITHDRAW one. These tests pin the security
// properties of the two new tools, not their prose:
//
//   - revoke is gated exactly like mint (admin on the agent's squad, operator only)
//   - a token can only be revoked THROUGH the agent that actually owns it
//   - a wrong-owner token is indistinguishable from a missing one (no id oracle)
//   - revoke is idempotent
//   - neither tool can emit a secret

const OPERATOR = 'member-operator'
const AGENT = { id: 'agent-1', squad_id: 'squad-1', slug: 'growth-lead', name: 'Growth Lead' }
const OTHER_AGENT = { id: 'agent-2', squad_id: 'squad-2', slug: 'other-agent', name: 'Other' }

const TOKEN_MINE = {
  id: 'tok-mine',
  member_id: 'member-agent-1',
  agent_id: AGENT.id,
  label: 'desktop',
  channel: 'workspace',
  capability: 'member',
  created_at: '2026-08-05T00:00:00.000Z',
  revoked_at: null as string | null,
  token_hash: 'SECRET-HASH-MUST-NEVER-APPEAR',
}
const TOKEN_OTHERS = { ...TOKEN_MINE, id: 'tok-others', agent_id: OTHER_AGENT.id }

interface Opts {
  grants?: CapabilityGrant[]
  boundAgentId?: string | null
  /** the row returned when revoke looks up token_id */
  tokenRow?: Record<string, unknown> | null
  /** rows returned by the list projection */
  listRows?: Record<string, unknown>[]
  /** false ⇒ revokeMemberToken reports "nothing changed" (already revoked) */
  revokeChanges?: number
  /** collects every BUS.send payload so a probe can assert NO side effect */
  busSent?: unknown[]
}

function makeEnv(opts: Opts = {}): Env {
  const grants = opts.grants ?? [
    { member_id: OPERATOR, scope_type: 'org', scope_id: null, capability: 'admin' },
  ]
  const revokeChanges = opts.revokeChanges ?? 1

  const handler = (sql: string) => ({
    bind(...args: unknown[]) {
      return {
        async first() {
          // ORDER MATTERS. revoke's ownership lookup is matched FIRST by its distinctive
          // projection; every other member_tokens read is the authn lookup. Getting this
          // backwards makes the mock swallow authentication and every test 401s before
          // reaching the logic under test — which is exactly what happened first try.
          if (sql.includes('FROM member_tokens') && sql.includes('agent_id, label, revoked_at')) {
            return opts.tokenRow === undefined ? TOKEN_MINE : opts.tokenRow
          }
          if (sql.includes('FROM member_tokens')) {
            return {
              member_id: OPERATOR,
              email: null,
              display_name: 'Operator',
              telegram_chat_id: null,
              status: 'active',
              created_at: '2026-08-05 00:00:00',
              channel: 'workspace',
              bound_agent_id: opts.boundAgentId ?? null,
            }
          }
          if (sql.includes('FROM agent_member_bindings')) return null
          if (sql.includes('FROM agent_keys')) return null
          if (sql.includes('FROM squads')) {
            const ref = args[0]
            if (ref === OTHER_AGENT.squad_id) return { id: OTHER_AGENT.squad_id, department_id: 'dept-2' }
            return { id: AGENT.squad_id, department_id: 'dept-1' }
          }
          if (sql.includes('FROM agents')) {
            const ref = args[0]
            if (ref === AGENT.id || ref === AGENT.slug) return AGENT
            if (ref === OTHER_AGENT.id || ref === OTHER_AGENT.slug) return OTHER_AGENT
            return null
          }
          if (sql.includes('FROM members')) return { id: OPERATOR, status: 'active' }
          return null
        },
        async all() {
          if (sql.includes('FROM member_tokens')) return { results: opts.listRows ?? [] }
          if (sql.includes('FROM capabilities')) return { results: grants }
          return { results: [] }
        },
        async run() {
          return { meta: { changes: revokeChanges } }
        },
      }
    },
  })

  return {
    DB: { prepare: (sql: string) => handler(sql), batch: async () => [] },
    TENANT_SLUG: 'mumega',
    PUBLIC_ORIGIN: 'https://mupot.mumega.com',
    BUS: { send: async (e: unknown) => { (opts.busSent ??= []).push(e) } },
  } as unknown as Env
}

async function call(name: string, args: Record<string, unknown>, env: Env) {
  return mcpApp.request(
    'https://mupot.mumega.com/',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    },
    env,
  )
}

describe('token lifecycle — the tools exist at all (mupot#682)', () => {
  it('mint has counterparts: list and revoke are advertised', async () => {
    const res = await mcpApp.request(
      'https://mupot.mumega.com/',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      },
      makeEnv(),
    )
    const body = (await res.json()) as { result: { tools: { name: string }[] } }
    const names = body.result.tools.map((t) => t.name)
    expect(names).toContain('mint_agent_token')
    expect(names).toContain('list_agent_tokens')
    expect(names).toContain('revoke_agent_token')
  })
})

describe('revoke_agent_token — authorization', () => {
  it('squad member (not admin) cannot revoke — revoking must be gated like minting', async () => {
    const env = makeEnv({
      grants: [{ member_id: OPERATOR, scope_type: 'squad', scope_id: AGENT.squad_id, capability: 'member' }],
    })
    const res = await call('revoke_agent_token', { agent: AGENT.slug, token_id: TOKEN_MINE.id }, env)
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { data: { need: string } } }
    expect(body.error.data.need).toBe('admin')
  })

  it('an agent-bound principal cannot revoke — operator principals only', async () => {
    const env = makeEnv({ boundAgentId: AGENT.id })
    const res = await call('revoke_agent_token', { agent: AGENT.slug, token_id: TOKEN_MINE.id }, env)
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toBe('operator_principal_required')
  })
})

describe('revoke_agent_token — ownership', () => {
  it("cannot revoke another agent's token by naming an agent you DO have admin on", async () => {
    // The caller has admin, names AGENT (which they may revoke through), but supplies a
    // token welded to OTHER_AGENT on a different squad. Authorization must be checked
    // against the token's REAL owner, not the agent the caller claimed.
    const env = makeEnv({ tokenRow: TOKEN_OTHERS })
    const res = await call('revoke_agent_token', { agent: AGENT.slug, token_id: TOKEN_OTHERS.id }, env)
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toBe('token_not_found')
  })

  // codex gate on #683: my first version of this test was FAKE-GREEN. It probed two
  // DIFFERENT token ids and compared only status + error.message. Codex mutated the
  // wrong-owner branch to leak `row.agent_id` in the detail while keeping the 404 and
  // the message — creating the exact cross-squad owner oracle this test claims to
  // prevent — and the suite still passed 9/9.
  //
  // The property is: for the SAME agent and the SAME candidate token_id, a missing row
  // and a wrong-owner row must be indistinguishable in the COMPLETE response, and
  // neither may produce a side effect. Compare the whole body, not a field I chose.
  it('missing vs wrong-owner: identical agent, identical token_id, byte-identical response', async () => {
    const CANDIDATE = 'tok-probe'
    const missingBus: unknown[] = []
    const wrongBus: unknown[] = []

    const missingRes = await call(
      'revoke_agent_token',
      { agent: AGENT.slug, token_id: CANDIDATE },
      makeEnv({ tokenRow: null, busSent: missingBus }),
    )
    const wrongRes = await call(
      'revoke_agent_token',
      { agent: AGENT.slug, token_id: CANDIDATE },
      makeEnv({ tokenRow: { ...TOKEN_OTHERS, id: CANDIDATE }, busSent: wrongBus }),
    )

    expect(missingRes.status).toBe(wrongRes.status)
    // WHOLE body, byte-for-byte — not a field the author picked.
    expect(await missingRes.text()).toBe(await wrongRes.text())

    // No side effect from either failed probe: no revocation event, nothing token-bearing.
    expect(missingBus).toHaveLength(0)
    expect(wrongBus).toHaveLength(0)
  })

  it('a failed probe emits no bus event at all (no pre-refusal emit)', async () => {
    const bus: unknown[] = []
    await call('revoke_agent_token', { agent: AGENT.slug, token_id: 'tok-probe' }, makeEnv({ tokenRow: null, busSent: bus }))
    expect(JSON.stringify(bus)).not.toMatch(/token_revoked/)
    expect(bus).toHaveLength(0)
  })

  // codex requirement 3: the fixture must match its claim. Default grants were ORG admin,
  // which passes every squad gate and therefore never exercised the authorization
  // disagreement this test is named for.
  it('SQUAD-A-ONLY admin: naming agent A with a squad-B token gets the shared 404', async () => {
    const squadAOnly: CapabilityGrant[] = [
      { member_id: OPERATOR, scope_type: 'squad', scope_id: AGENT.squad_id, capability: 'admin' },
    ]
    const res = await call(
      'revoke_agent_token',
      { agent: AGENT.slug, token_id: TOKEN_OTHERS.id },
      makeEnv({ grants: squadAOnly, tokenRow: TOKEN_OTHERS }),
    )
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toBe('token_not_found')
  })

  it('SQUAD-A-ONLY admin: naming the REAL squad-B agent fails the squad gate with 403', async () => {
    const squadAOnly: CapabilityGrant[] = [
      { member_id: OPERATOR, scope_type: 'squad', scope_id: AGENT.squad_id, capability: 'admin' },
    ]
    const res = await call(
      'revoke_agent_token',
      { agent: OTHER_AGENT.slug, token_id: TOKEN_OTHERS.id },
      makeEnv({ grants: squadAOnly, tokenRow: TOKEN_OTHERS }),
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { data: { need: string } } }
    expect(body.error.data.need).toBe('admin')
  })
})

describe('revoke_agent_token — idempotence', () => {
  it('revoking a live token reports revoked:true', async () => {
    const res = await call('revoke_agent_token', { agent: AGENT.slug, token_id: TOKEN_MINE.id }, makeEnv({ revokeChanges: 1 }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { structuredContent: { revoked: boolean; already_revoked: boolean } } }
    expect(body.result.structuredContent.revoked).toBe(true)
    expect(body.result.structuredContent.already_revoked).toBe(false)
  })

  it('revoking an already-revoked token succeeds and reports already_revoked (idempotent)', async () => {
    const res = await call('revoke_agent_token', { agent: AGENT.slug, token_id: TOKEN_MINE.id }, makeEnv({ revokeChanges: 0 }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { structuredContent: { revoked: boolean; already_revoked: boolean } } }
    expect(body.result.structuredContent.revoked).toBe(false)
    expect(body.result.structuredContent.already_revoked).toBe(true)
  })
})

describe('no tool may emit a secret', () => {
  it('list_agent_tokens never returns a hash, even if the row carries one', async () => {
    // The mock deliberately includes token_hash in the row to prove the tool projects
    // it away rather than relying on the caller not to look.
    const env = makeEnv({ listRows: [{ ...TOKEN_MINE }] })
    const res = await call('list_agent_tokens', { agent: AGENT.slug }, env)
    expect(res.status).toBe(200)
    const raw = await res.text()
    expect(raw).not.toMatch(/SECRET-HASH-MUST-NEVER-APPEAR/)
    expect(raw).not.toMatch(/token_hash/)
  })

  it('revoke_agent_token never echoes a hash or raw value', async () => {
    const res = await call('revoke_agent_token', { agent: AGENT.slug, token_id: TOKEN_MINE.id }, makeEnv())
    const raw = await res.text()
    expect(raw).not.toMatch(/SECRET-HASH-MUST-NEVER-APPEAR/)
    expect(raw).not.toMatch(/"raw"/)
  })
})
