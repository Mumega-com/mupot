// tests/mint-capability-cap.test.ts — squad-core P0 29805baa.
//
// THE CLAIM: "Agent-token mint issues MORE capability than the dropdown states —
// `member` selection returned a token carrying lead AND admin."
//
// THE TRAP THE TASK ITSELF NAMES. Its done_when does not merely ask for a cap test;
// it asks that "the mutation set includes a fixture agent WITH pre-existing higher
// grants so the cap check cannot pass vacuously." That is the whole difficulty. A
// test that mints `member` for a FRESH agent and finds `member` proves nothing —
// the clamp and a total absence of authority produce identical output. The question
// is only interesting when the principal already holds more than the dropdown says.
//
// WHY MOCKS CANNOT ANSWER IT. tests/provision-tools.test.ts asserts on a fake DB
// (stmts[0].args[3]). A mock returns whatever the mock was told to return, so it can
// confirm the clamp is CALLED but never what the resulting principal CARRIES —
// which is the actual claim. Real schema, full migration chain, no mock (#999).
//
// Every tool enters through invokeTool. spec.min is enforced centrally BEFORE run()
// (mupot#1289), so a proof that bypasses it proves nothing about the production path.

import { describe, expect, it } from 'vitest'
import { createAgent } from '../src/org/service'
import { invokeTool } from '../src/mcp'
import type { ToolCtx } from '../src/mcp'
import { resolveCapabilities } from '../src/auth/capability'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'tenant-mintcap'
const DEPT = 'dept-eng'
const SQUAD = 'squad-crew'
const OPERATOR = 'mem-op'
const CTX: ToolCtx = { origin: 'test', transport: 'mcp' }

function callTool(name: string, auth: AuthContext, env: Env, args: Record<string, unknown>) {
  return invokeTool(auth, env, name, args, CTX)
}

function grantAuth(grants: CapabilityGrant[]): AuthContext {
  return {
    userId: OPERATOR,
    memberId: OPERATOR,
    email: 'op@x.test',
    role: 'member',
    tenant: TENANT,
    channel: 'dashboard',
    boundAgentId: null,
    capabilities: grants,
  } as unknown as AuthContext
}

const squadAdmin = () =>
  grantAuth([{ member_id: OPERATOR, scope_type: 'squad', scope_id: SQUAD, capability: 'admin' }])

/** In-memory KV — mint writes the single-use credential claim to SESSIONS
 *  (src/auth/credential-claim.ts). Without it the tool throws and invokeTool's
 *  leak guard converts the throw to an opaque 500, which is indistinguishable
 *  from an authorization refusal. That masking cost me a diagnostic round here,
 *  and it is the same shape as the audit-chain masking recorded elsewhere. */
function memoryKv() {
  const store = new Map<string, string>()
  return {
    put: async (k: string, v: string) => { store.set(k, v) },
    get: async (k: string) => store.get(k) ?? null,
    delete: async (k: string) => { store.delete(k) },
  }
}

interface Fixture { h: SqliteD1Harness; env: Env; agentId: string }

async function fixture(): Promise<Fixture> {
  const h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('${DEPT}', 'eng', 'Engineering');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD}', '${DEPT}', 'crew', 'Crew');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('${OPERATOR}', 'op@x.test', 'Operator', 'active', '${TENANT}');
    INSERT INTO org_settings (key, value, updated_at)
      VALUES ('billing_state', '{"tier":"scale"}', '2026-07-22 00:00:00');
  `)
  const env = {
    DB: h.db, TENANT_SLUG: TENANT, PUBLIC_ORIGIN: 'https://mupot.test',
    SESSIONS: memoryKv(),
  } as unknown as Env
  const created = await createAgent(env, SQUAD, {
    slug: 'seat-one', name: 'Seat One', role: 'member', model: 'deepseek-v4-flash',
  })
  if (!created.ok) throw new Error(`fixture agent create failed: ${created.error}`)
  return { h, env, agentId: created.value.id }
}

/** Every capability row the agent's dedicated member holds, across every scope. */
async function effectiveGrantsOfAgentMember(h: SqliteD1Harness, env: Env, agentId: string) {
  const binding = h.sqlite
    .prepare('SELECT member_id FROM agent_member_bindings WHERE agent_id = ?')
    .get(agentId) as { member_id: string } | undefined
  if (!binding) return { memberId: null as string | null, grants: [] as CapabilityGrant[] }
  const grants = await resolveCapabilities(env, binding.member_id)
  return { memberId: binding.member_id, grants }
}

describe('29805baa — what a `member` mint actually leaves the principal holding', () => {
  it('BASELINE (deliberately weak, and labelled as such): a fresh agent minted `member` holds only member', async () => {
    // This is the test that would pass vacuously if it stood alone. It is kept
    // BECAUSE it is weak: it establishes that the clamp is wired at all, so a
    // failure in the strong test below cannot be blamed on the mint being broken
    // outright. It proves the floor, not the ceiling.
    const { h, env, agentId } = await fixture()
    try {
      const out = await callTool('mint_agent_token', squadAdmin(), env, {
        agent: agentId, capability: 'member', label: 'seat',
      })
      expect(out.ok, JSON.stringify(out)).toBe(true)

      const { grants } = await effectiveGrantsOfAgentMember(h, env, agentId)
      // NON-EMPTY FIRST. [].every(...) is TRUE, so asserting only `every` would pass
      // if the mint wrote no grant at all — vacuously true in exactly the failure case
      // this test exists to exclude. Caught by the gate (athena, #1379): a test labelled
      // "deliberately weak" is still expected to be non-vacuous, and "weak" was the wrong
      // word for an assertion that cannot fail on absence.
      expect(grants.length, 'mint wrote no grant at all — `every` would have passed vacuously').toBeGreaterThan(0)
      expect(grants.every((g) => g.capability === 'member')).toBe(true)
    } finally {
      h.sqlite.close()
    }
  })

  it('THE REAL QUESTION: `member` minted for an agent whose member ALREADY holds org admin', async () => {
    // The done_when's own condition. Seed prior higher standing on a DIFFERENT
    // scope from the one the mint writes, because that is the shape the claim
    // describes: the clamp bounds the row it writes, and says nothing about what
    // the principal already carries elsewhere. hasCapability's org branch matches
    // every scope-level question, so an org grant is the sharpest case.
    const { h, env, agentId } = await fixture()
    try {
      const mint = await callTool('mint_agent_token', squadAdmin(), env, {
        agent: agentId, capability: 'member', label: 'seat',
      })
      expect(mint.ok, JSON.stringify(mint)).toBe(true)

      const { memberId } = await effectiveGrantsOfAgentMember(h, env, agentId)
      expect(memberId, 'mint did not weld a member to the agent').not.toBeNull()

      // Prior standing, as a real row — an org-scope admin grant on the agent's own member.
      h.sqlite.exec(
        `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
         VALUES ('cap-prior', '${memberId}', 'org', NULL, 'admin')`,
      )

      // Mint AGAIN at `member`. If the dropdown describes the credential, the
      // principal must end up at member. If it only describes one grant row, the
      // org admin survives and the token carries admin while the operator was
      // shown "member".
      const second = await callTool('mint_agent_token', squadAdmin(), env, {
        agent: agentId, capability: 'member', label: 'seat-2',
      })
      expect(second.ok, JSON.stringify(second)).toBe(true)

      const after = await effectiveGrantsOfAgentMember(h, env, agentId)
      const caps = after.grants.map((g) => `${g.scope_type}:${g.capability}`).sort()

      // Record what is TRUE rather than what is comfortable. This assertion states
      // the measured behaviour; if it reads as a defect, the defect is the finding.
      expect(caps).toContain('org:admin')
      expect(
        caps.some((c) => c.endsWith(':admin')),
        'the principal carries admin after a `member` mint — the dropdown describes the GRANT, not the CREDENTIAL',
      ).toBe(true)
    } finally {
      h.sqlite.close()
    }
  })

  it('the clamp itself is real: `lead` and `admin` are refused at the mint boundary', async () => {
    const { h, env, agentId } = await fixture()
    try {
      for (const capability of ['lead', 'admin', 'owner']) {
        const out = await callTool('mint_agent_token', squadAdmin(), env, {
          agent: agentId, capability, label: `try-${capability}`,
        })
        expect(out.ok, `capability=${capability} was accepted`).toBe(false)
        if (!out.ok) expect(out.error).toBe('invalid_capability')
      }
    } finally {
      h.sqlite.close()
    }
  })
})
