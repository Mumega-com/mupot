import { describe, expect, it } from 'vitest'
import { mcpApp } from '../src/mcp'
import type { CapabilityGrant, Env } from '../src/types'
import { resolveAgentTokenExpiry } from '../src/auth/token-lifecycle'

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
  /** Whether a requested replacement token passes the service's live-ownership preflight. */
  liveReplacementToken?: boolean
  memberBinding?: string | null
  batches?: unknown[][]
  busReject?: { value: boolean }
  claimReject?: boolean
}

function makeEnv(opts: Opts = {}): Env {
  const grants = opts.grants ?? [
    { member_id: OPERATOR, scope_type: 'org', scope_id: null, capability: 'admin' },
  ]
  const revokeChanges = opts.revokeChanges ?? 1
  let replacementHandoff: Record<string, unknown> | null = null

  const handler = (sql: string) => ({
    bind(...args: unknown[]) {
      return {
        sql,
        args,
        async first() {
          // ORDER MATTERS. revoke's ownership lookup is matched FIRST by its distinctive
          // projection; every other member_tokens read is the authn lookup. Getting this
          // backwards makes the mock swallow authentication and every test 401s before
          // reaching the logic under test — which is exactly what happened first try.
          if (sql.includes('FROM member_tokens') && sql.includes('agent_id, label, revoked_at')) {
            return opts.tokenRow === undefined ? TOKEN_MINE : opts.tokenRow
          }
          if (sql.includes('SELECT id FROM member_tokens') || sql.includes('SELECT t.id FROM member_tokens')) {
            return opts.liveReplacementToken ? { id: args[0] } : null
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
          if (sql.includes('FROM agent_member_bindings')) {
            return opts.memberBinding ? { member_id: opts.memberBinding } : null
          }
          if (sql.includes('FROM agent_token_rotation_handoffs')) return replacementHandoff
          if (sql.includes('FROM capabilities')) return { capability: 'member' }
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
          if (sql.includes("UPDATE agent_token_rotation_handoffs") && replacementHandoff) {
            if (sql.includes("audit_state = 'sent'")) replacementHandoff.audit_state = 'sent'
            if (sql.includes("state = 'active'")) replacementHandoff.state = 'active'
          }
          return { meta: { changes: revokeChanges } }
        },
      }
    },
  })

  return {
    DB: {
      prepare: (sql: string) => handler(sql),
      batch: async (stmts: unknown[]) => {
        opts.batches?.push(stmts)
        const handoffInsert = (stmts as Array<{ sql?: string; args?: unknown[] }>).find((stmt) =>
          stmt.sql?.includes('INSERT INTO agent_token_rotation_handoffs'),
        )
        if (handoffInsert?.args) {
          const args = handoffInsert.args
          replacementHandoff = {
            id: args[0], tenant: args[1], agent_id: args[2], member_id: args[3], prior_token_id: args[4],
            replacement_token_id: args[5], minted_by_member_id: args[6], claim_id: args[7],
            claim_fingerprint: args[8], claim_expires_at: args[9], audit_state: 'pending', state: 'pending',
            created_at: args[10], activated_at: null,
          }
        }
        return stmts.map(() => ({ meta: { changes: 1 } }))
      },
    },
    TENANT_SLUG: 'mumega',
    PUBLIC_ORIGIN: 'https://mupot.mumega.com',
    BUS: {
      send: async (e: unknown) => {
        if (opts.busReject?.value) throw new Error('bus unavailable')
        ;(opts.busSent ??= []).push(e)
      },
    },
    // mupot#987: mint_agent_token stores raw behind a one-time SESSIONS-KV claim
    // (src/auth/credential-claim.ts) instead of returning it directly.
    SESSIONS: (() => {
      const store = new Map<string, string>()
      return {
        async get(key: string) { return store.get(key) ?? null },
        async put(key: string, value: string) {
          if (opts.claimReject) throw new Error('claim store unavailable')
          store.set(key, value)
        },
        async delete(key: string) { store.delete(key) },
      }
    })(),
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

describe('Flight-002: mint_agent_token expiry and rotation', () => {
  it('allows non-expiring agent tokens only through the explicit owner exception', () => {
    expect(resolveAgentTokenExpiry({ nonExpiring: true, allowNonExpiring: false })).toEqual({
      ok: false,
      code: 'non_expiring_owner_required',
    })
    expect(resolveAgentTokenExpiry({ nonExpiring: true, allowNonExpiring: true })).toMatchObject({
      ok: true,
      expiresAt: null,
    })
  })

  it('rejects zero, negative, and non-finite expiry inputs rather than minting non-expiring tokens', () => {
    for (const expiresInDays of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveAgentTokenExpiry({ expiresInDays, allowNonExpiring: false })).toEqual({
        ok: false,
        code: 'invalid_expiry',
      })
    }
  })

  // mupot#987: mint_agent_token's tool result must never carry the raw token —
  // only a single-use credential_claim, redeemed via reveal_credential_claim.
  async function revealRaw(env: Env, claimId: string): Promise<{ status: number; raw?: string }> {
    const res = await call('reveal_credential_claim', { claim_id: claimId }, env)
    if (res.status !== 200) return { status: res.status }
    const body = (await res.json()) as { result: { structuredContent: { raw: string } } }
    return { status: res.status, raw: body.result.structuredContent.raw }
  }

  it('mints agent token with default 30-day expiry when unspecified', async () => {
    const env = makeEnv()
    const res = await call('mint_agent_token', { agent: AGENT.slug }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      result: { structuredContent: { token: { id: string }; credential_claim: { claim_id: string } } }
    }
    expect(JSON.stringify(body)).not.toMatch(/"raw"\s*:/)
    expect(body.result.structuredContent.token.id).toBeDefined()
    const revealed = await revealRaw(env, body.result.structuredContent.credential_claim.claim_id)
    expect(revealed.raw).toMatch(/^mupot_/)
  })

  it('mints agent token with custom expiry days', async () => {
    const env = makeEnv()
    const res = await call('mint_agent_token', { agent: AGENT.slug, expires_in_days: 90 }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      result: { structuredContent: { credential_claim: { claim_id: string } } }
    }
    expect(JSON.stringify(body)).not.toMatch(/"raw"\s*:/)
    const revealed = await revealRaw(env, body.result.structuredContent.credential_claim.claim_id)
    expect(revealed.raw).toMatch(/^mupot_/)
  })

  it('mints non-expiring agent token when explicitly requested', async () => {
    const env = makeEnv({
      grants: [{ member_id: OPERATOR, scope_type: 'org', scope_id: null, capability: 'owner' }],
    })
    const res = await call('mint_agent_token', { agent: AGENT.slug, non_expiring: true }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      result: { structuredContent: { credential_claim: { claim_id: string } } }
    }
    expect(JSON.stringify(body)).not.toMatch(/"raw"\s*:/)
    const revealed = await revealRaw(env, body.result.structuredContent.credential_claim.claim_id)
    expect(revealed.raw).toMatch(/^mupot_/)
  })

  it('refuses non-expiring mint requests from a non-owner before creating a credential claim', async () => {
    const res = await call('mint_agent_token', { agent: AGENT.slug, non_expiring: true }, makeEnv())

    expect(res.status).toBe(400)
    const body = await res.text()
    expect(body).toContain('non_expiring_owner_required')
    expect(body).not.toMatch(/credential_claim|mupot_|token_hash/)
  })

  it('refuses zero expiry through the MCP surface before creating a credential claim', async () => {
    const res = await call('mint_agent_token', { agent: AGENT.slug, expires_in_days: 0 }, makeEnv())

    expect(res.status).toBe(400)
    const body = await res.text()
    expect(body).toContain('invalid_expiry')
    expect(body).not.toMatch(/credential_claim|mupot_|token_hash/)
  })

  it('blank_or_whitespace_replacement_id_is_refused_without_token_claim_binding_gate_or_bus_effect', async () => {
    for (const rotate_prior_token_id of ['', '   ']) {
      const batches: unknown[][] = []
      const busSent: unknown[] = []
      const res = await call(
        'mint_agent_token',
        { agent: AGENT.slug, rotate_prior_token_id },
        makeEnv({ batches, busSent }),
      )

      expect(res.status).toBe(400)
      expect(await res.text()).toContain('invalid_replacement_token_id')
      expect(batches).toHaveLength(0)
      expect(busSent).toHaveLength(0)
    }
  })

  it('atomically rotates prior token on mint when rotate_prior_token_id provided', async () => {
    const env = makeEnv({ liveReplacementToken: true, memberBinding: 'member-agent-1' })
    const res = await call('mint_agent_token', { agent: AGENT.slug, rotate_prior_token_id: 'tok-old' }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { structuredContent: { token: { id: string } } } }
    expect(body.result.structuredContent.token.id).toBeDefined()
  })

  it('replacement_bus_failure_preserves_prior_and_leaves_no_live_replacement', async () => {
    const busReject = { value: true }
    const batches: unknown[][] = []
    const busSent: unknown[] = []
    const env = makeEnv({
      liveReplacementToken: true,
      memberBinding: 'member-agent-1',
      busReject,
      batches,
      busSent,
    })

    const res = await call('mint_agent_token', { agent: AGENT.slug, rotate_prior_token_id: 'tok-old' }, env)

    expect(res.status).toBe(503)
    expect(await res.text()).not.toMatch(/credential_claim|mupot_|token_hash/)
    expect(batches).toHaveLength(1)
    expect(busSent).toHaveLength(0)
  })

  it('replacement_claim_failure_preserves_prior_and_leaves_no_live_replacement', async () => {
    const batches: unknown[][] = []
    const busSent: unknown[] = []
    const env = makeEnv({
      liveReplacementToken: true,
      memberBinding: 'member-agent-1',
      claimReject: true,
      batches,
      busSent,
    })

    const res = await call('mint_agent_token', { agent: AGENT.slug, rotate_prior_token_id: 'tok-old' }, env)

    expect(res.status).toBe(503)
    expect(await res.text()).not.toMatch(/credential_claim|mupot_|token_hash/)
    // Reservation then compensating cleanup; no claim or bus handoff is emitted.
    expect(batches).toHaveLength(2)
    expect(busSent).toHaveLength(0)
  })

  it('replacement_retry_resumes_without_duplicate_live_token_or_audit', async () => {
    const busReject = { value: true }
    const batches: unknown[][] = []
    const busSent: unknown[] = []
    const env = makeEnv({
      liveReplacementToken: true,
      memberBinding: 'member-agent-1',
      busReject,
      batches,
      busSent,
    })
    const args = { agent: AGENT.slug, rotate_prior_token_id: 'tok-old' }

    expect((await call('mint_agent_token', args, env)).status).toBe(503)
    busReject.value = false
    expect((await call('mint_agent_token', args, env)).status).toBe(200)

    expect(batches).toHaveLength(1)
    expect(busSent).toHaveLength(1)
  })

  it('returns the same opaque replacement conflict for a missing or foreign prior token without a claim', async () => {
    const missing = await call(
      'mint_agent_token',
      { agent: AGENT.slug, rotate_prior_token_id: 'missing-prior-token' },
      makeEnv(),
    )
    const foreign = await call(
      'mint_agent_token',
      { agent: AGENT.slug, rotate_prior_token_id: 'foreign-prior-token' },
      makeEnv(),
    )
    expect(missing.status).toBe(409)
    expect(foreign.status).toBe(409)
    const missingBody = await missing.text()
    const foreignBody = await foreign.text()
    expect(missingBody).toBe(foreignBody)
    expect(missingBody).toContain('replacement_token_unavailable')
    expect(missingBody).not.toMatch(/credential_claim|mupot_|token_hash/)
  })

  it('a claim can only be redeemed once — the second reveal is refused (mupot#987)', async () => {
    const env = makeEnv()
    const res = await call('mint_agent_token', { agent: AGENT.slug }, env)
    const body = (await res.json()) as {
      result: { structuredContent: { credential_claim: { claim_id: string } } }
    }
    const claimId = body.result.structuredContent.credential_claim.claim_id
    const first = await revealRaw(env, claimId)
    expect(first.status).toBe(200)
    const second = await revealRaw(env, claimId)
    expect(second.status).toBe(410)
  })
})

describe('Flight-002: expiring-soon detection & maintenance sweep', () => {
  it('isTokenExpiringSoon detects token expiring within 7 days and ignores token 8 days out', async () => {
    const { isTokenExpiringSoon } = await import('../src/auth/token-lifecycle')
    const now = Date.now()
    const in6Days = new Date(now + 6 * 24 * 60 * 60 * 1000).toISOString()
    const in8Days = new Date(now + 8 * 24 * 60 * 60 * 1000).toISOString()

    expect(isTokenExpiringSoon(in6Days, 7)).toBe(true)
    expect(isTokenExpiringSoon(in8Days, 7)).toBe(false)
    expect(isTokenExpiringSoon(null, 7)).toBe(false)
    expect(isTokenExpiringSoon(undefined, 7)).toBe(false)
  })

  it('sweepExpiringTokensWarning warns seat/operator for tokens expiring within 7 days and emits bus event', async () => {
    const { sweepExpiringTokensWarning } = await import('../src/auth/token-lifecycle')
    const now = Date.now()
    const in6Days = new Date(now + 6 * 24 * 60 * 60 * 1000).toISOString()
    const in10Days = new Date(now + 10 * 24 * 60 * 60 * 1000).toISOString()

    const busEvents: unknown[] = []
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            all: async () => ({
              results: [
                { id: 'tok-exp-soon', agent_id: 'agent-1', label: 'daemon', expires_at: in6Days },
                { id: 'tok-fine', agent_id: 'agent-2', label: 'safe', expires_at: in10Days },
              ],
            }),
          }),
        }),
      },
      TENANT_SLUG: 'mumega',
      BUS: {
        send: async (e: unknown) => { busEvents.push(e) },
      },
    } as unknown as Env

    const res = await sweepExpiringTokensWarning(env, 7)
    expect(res.warned).toBe(1)
    expect(res.tokens[0].id).toBe('tok-exp-soon')
    expect(busEvents.length).toBe(1)
    expect((busEvents[0] as { payload: { kind: string } }).payload.kind).toBe('token_expiring_soon')
  })

  it('heartbeat wiring: scheduled handler in src/index.ts wires token-expiry-warning into maintenance cron', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8')

    // PINNED: If someone deletes or comments out the maintenance wiring in src/index.ts, this test fails RED.
    expect(src).toContain("['token-expiry-warning', () => sweepExpiringTokensWarning(env)]")
    expect(src).toContain("const { sweepExpiringTokensWarning } = await import('./auth/token-lifecycle')")

    // Pin the maintenance array structure and scheduled execution hook in src/index.ts
    expect(src).toMatch(/const maintenance:\s*ReadonlyArray<readonly \[string,\s*\(\)\s*=>\s*Promise<unknown>\]>\s*=\s*\[[\s\S]*?\['token-expiry-warning',\s*\(\)\s*=>\s*sweepExpiringTokensWarning\(env\)\]/)
    expect(src).toContain(
      'const heartbeat = maintenance[maintenanceSlot(scheduledAt.getUTCMinutes(), maintenance.length)]',
    )

    // WHY THE PIN ABOVE CHANGED, and why the assertion below now exists.
    //
    // This previously pinned `maintenance[scheduledAt.getUTCMinutes() % 15]`. That selector could
    // only ever address indices 0-9 — every minute the maintenance cron fires satisfies
    // `minute % 15 in 0..9` — while the array holds eleven entries. token-expiry-warning sits at
    // index [10] and therefore NEVER RAN in production.
    //
    // This test passed the entire time. It asserted the entry EXISTS in the array and that a
    // selector line EXISTS, but never that the entry was REACHABLE — so it could not distinguish
    // "wired up" from "wired to nothing", which is exactly the distinction it was written to
    // defend. Pinning the buggy line as expected text additionally meant the defect had a test
    // protecting it.
    //
    // The pin is therefore no longer purely textual: this asserts the sweep's own slot is actually
    // selectable by a real firing minute of the cron.
    // COUNT AND INDEX ARE DERIVED FROM THE SOURCE, NEVER HARDCODED.
    //
    // These were literals (`heartbeatCount = 11`, `tokenExpirySlot = 10`, commented "the last
    // entry"). Appending the twelfth heartbeat in #1138 made all three wrong at once while the
    // test stayed GREEN: reachableSlots(11) still contains 10, so it kept asserting a property
    // of an eleven-entry array that no longer exists. A pin describing a stale shape is not a
    // weaker pin, it is a FALSE one — it reports on code nobody is running.
    //
    // Parsing the real array means appending, removing, or REORDERING a heartbeat is picked up
    // here automatically, which is the only version of this assertion that cannot rot.
    const { MAINTENANCE_FIRING_MINUTES, maintenanceSlot } = await import('../src/scheduled/slots')

    const arrayBlock = /const maintenance:[\s\S]*?=\s*\[([\s\S]*?)\n\s*\]/.exec(src)?.[1]
    expect(arrayBlock, 'could not locate the maintenance array in src/index.ts').toBeTruthy()
    const labels = [...(arrayBlock as string).matchAll(/\[\s*'([^']+)'\s*,/g)].map((m) => m[1])

    expect(labels.length, 'parsed no heartbeats — the regex has drifted from the source').toBeGreaterThan(0)
    expect(new Set(labels).size, `duplicate heartbeat labels: ${labels.join(', ')}`).toBe(labels.length)

    const tokenExpirySlot = labels.indexOf('token-expiry-warning')
    expect(tokenExpirySlot, 'token-expiry-warning is not in the maintenance array at all').toBeGreaterThanOrEqual(0)

    const reachable = new Set(
      MAINTENANCE_FIRING_MINUTES.map((m) => maintenanceSlot(m, labels.length)),
    )
    expect(
      reachable.has(tokenExpirySlot),
      `token-expiry-warning sits at index ${tokenExpirySlot} of ${labels.length} but no firing minute selects it — the sweep is wired to nothing`,
    ).toBe(true)

    // Every OTHER heartbeat must be reachable too. token-expiry-warning died alone last time
    // only because nobody was checking the rest.
    const unreachable = labels.filter((_, i) => !reachable.has(i))
    expect(unreachable, `heartbeats in the array that no firing minute selects: ${unreachable.join(', ')}`).toEqual([])
  })
})
