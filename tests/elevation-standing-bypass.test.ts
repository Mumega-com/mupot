// tests/elevation-standing-bypass.test.ts
//
// mupot#1906: a bound agent holding a grant for an action on scope Y must never use STANDING authority on scope X for
// mint_agent_token / grant_agent_capability / create_squad. Real engine, real elevation ledger.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { createElevationRequest, decideElevationRequest } from '../src/auth/elevation'
import { createWebSession } from '../src/auth/web-sessions'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { STRUCTURAL_ACTIONS, agentMustHoldMatchingGrant, type StructuralAction } from '../src/operators/chokepoint'

const authState = vi.hoisted(() => ({ current: null as AuthContext | null }))

vi.mock('../src/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/auth')>()
  return {
    ...actual,
    requireAuth: async (
      c: { set: (key: 'auth', value: AuthContext) => void; json: (body: unknown, status: 401) => Response },
      next: () => Promise<void>,
    ) => {
      if (!authState.current) return c.json({ error: 'unauthenticated' }, 401)
      c.set('auth', authState.current)
      await next()
    },
  }
})

const TENANT = 'tenant-struct'
const ORIGIN = 'https://pot.test'

const DEPT_A = 'dept-a'
const DEPT_B = 'dept-b'
const DEPT_HOME = 'dept-home'
const SQUAD_A1 = 'squad-a1'
const SQUAD_A2 = 'squad-a2'
const SQUAD_B1 = 'squad-b1'
const SQUAD_HOME = 'squad-home'

const AGENT_ID = 'agent-rava'
const AGENT_MEMBER = 'member-rava'
const TOKEN_ID = 'tok-rava-1'

const APPROVER = 'member-approver'
const APPROVER_IDENTITY = 'identity-approver'
const ADMIN_HUMAN = 'member-human-admin'

let harness: SqliteD1Harness
let env: Env

function memoryKv(): Env['SESSIONS'] {
  const store = new Map<string, string>()
  return {
    async put(key: string, value: string) { store.set(key, value) },
    async get(key: string) { return store.get(key) ?? null },
    async delete(key: string) { store.delete(key) },
  } as unknown as Env['SESSIONS']
}

function seed(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('${DEPT_A}', 'dept-a', 'Dept A'), ('${DEPT_B}', 'dept-b', 'Dept B');
    INSERT INTO departments (id, slug, name, kind) VALUES ('${DEPT_HOME}', 'dept-home', 'Home Dept', 'home');
    -- Lift the plan quota so a refusal below is authorization, not a limit message.
    INSERT INTO org_settings (key, value) VALUES ('billing_state', '{"tier":"scale"}')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('${SQUAD_A1}', '${DEPT_A}', 'a1-sqd', 'A One'),
      ('${SQUAD_A2}', '${DEPT_A}', 'a2-sqd', 'A Two'),
      ('${SQUAD_B1}', '${DEPT_B}', 'b1-sqd', 'B One');
    INSERT INTO squads (id, department_id, slug, name, kind) VALUES ('${SQUAD_HOME}', '${DEPT_HOME}', 'home-sqd', 'Home', 'home');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('${AGENT_ID}', '${SQUAD_A1}', 'rava', 'Rava', 'active');
    INSERT INTO members (id, display_name, status, tenant) VALUES
      ('${AGENT_MEMBER}', 'Rava seat', 'active', '${TENANT}'),
      ('${APPROVER}', 'Approver', 'active', '${TENANT}'),
      ('${ADMIN_HUMAN}', 'Human Admin', 'active', '${TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', '${AGENT_ID}', '${AGENT_MEMBER}', '2026-09-01T00:00:00Z');
    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, tenant, agent_id, created_at)
      VALUES ('${TOKEN_ID}', '${AGENT_MEMBER}', 'hash-rava-1', 'primary', 'workspace', '${TENANT}', '${AGENT_ID}', datetime('now'));
    -- The agent's ENTIRE standing authority: lead on its own squad. No admin anywhere.
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-rava', '${AGENT_MEMBER}', 'squad', '${SQUAD_A1}', 'lead');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('cap-approver', '${APPROVER}', 'org', NULL, 'admin'),
      ('cap-human-admin', '${ADMIN_HUMAN}', 'org', NULL, 'admin');
    INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id, created_at)
      VALUES ('${APPROVER_IDENTITY}', '${TENANT}', 'google', '${APPROVER}', 'approver@x.test', '${APPROVER}', datetime('now'));
  `)
}

function agentAuth(extra: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: AGENT_MEMBER,
    memberId: AGENT_MEMBER,
    email: null,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: AGENT_ID,
    tokenId: TOKEN_ID,
    capabilities: [{ member_id: AGENT_MEMBER, scope_type: 'squad', scope_id: SQUAD_A1, capability: 'lead' }],
    ...extra,
  } as unknown as AuthContext
}

function humanAdminAuth(): AuthContext {
  return {
    userId: ADMIN_HUMAN,
    memberId: ADMIN_HUMAN,
    email: 'h@x.test',
    role: 'admin',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: null,
    capabilities: [{ member_id: ADMIN_HUMAN, scope_type: 'org', scope_id: null, capability: 'admin' }],
  } as unknown as AuthContext
}

async function checkIn(): Promise<string> {
  const res = await invokeTool(agentAuth(), env, 'check_in', {}, ORIGIN)
  if (!res.ok) throw new Error(`setup: check_in failed: ${JSON.stringify(res)}`)
  return (res.result as { agent_session: { id: string } }).agent_session.id
}

let approvalSeq = 0
async function approve(
  sessionId: string,
  scopeType: 'org' | 'department' | 'squad',
  scopeId: string,
  durationMinutes: number,
  nowMs: number,
  actions: string[] = ['action:org_structure'],
): Promise<string> {
  approvalSeq += 1
  const approverSession = await createWebSession(
    env,
    `raw-approver-${approvalSeq}`,
    { tenant: TENANT, memberId: APPROVER, loginIdentityId: APPROVER_IDENTITY },
    nowMs,
  )
  const created = await createElevationRequest(
    env,
    {
      tenant: TENANT, agentSessionId: sessionId, agentId: AGENT_ID, memberId: AGENT_MEMBER,
      actions, scopeType, scopeId, durationMinutes, reason: 'fix org structure',
    },
    nowMs,
  )
  if (!created.ok) throw new Error(`approve: request failed: ${JSON.stringify(created)}`)
  const decision = await decideElevationRequest(
    env,
    {
      tenant: TENANT, requestId: created.request.id, decision: 'approve', selectedActions: actions,
      decidedByMemberId: APPROVER,
      decidedByCapabilities: [{ member_id: APPROVER, scope_type: 'org', scope_id: null, capability: 'admin' }],
      decidedByWebSessionHash: approverSession.id_hash,
      recentReauthOk: true,
    },
    nowMs,
  )
  if (!decision.ok) throw new Error(`approve: decision failed: ${JSON.stringify(decision)}`)
  return created.request.id
}


const AGENT_B1 = 'agent-b1'
const VICTIM = 'agent-victim'
const T0 = Date.parse('2026-10-14T12:00:00.000Z')

function seedExtra(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES
      ('${VICTIM}', '${SQUAD_A2}', 'victim', 'Victim', 'active'),
      ('${AGENT_B1}', '${SQUAD_B1}', 'b1-agent', 'B1 Agent', 'active');
  `)
}

beforeEach(() => {
  approvalSeq = 0
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  seed(harness.sqlite)
  seedExtra(harness.sqlite)
  env = { DB: harness.db, TENANT_SLUG: TENANT, SESSIONS: memoryKv(), PUBLIC_ORIGIN: ORIGIN } as unknown as Env
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
  harness.sqlite.close()
})

const standing = (...caps: Array<['org' | 'department' | 'squad', string | null, 'admin' | 'lead' | 'member']>) => ({
  capabilities: caps.map(([scope_type, scope_id, capability]) => ({ member_id: AGENT_MEMBER, scope_type, scope_id, capability })),
} as unknown as Partial<AuthContext>)

const mint = (agent: string, auth: AuthContext, extra: Record<string, unknown> = {}) =>
  invokeTool(auth, env, 'mint_agent_token', { agent, ...extra }, ORIGIN)
const grantCap = (agent: string, squad: string, capability: string, auth: AuthContext) =>
  invokeTool(auth, env, 'grant_agent_capability', { agent, squad, capability }, ORIGIN)
const createSquadVia = (department: string, slug: string, auth: AuthContext) =>
  invokeTool(auth, env, 'create_squad', { department, slug, name: slug }, ORIGIN)

function tokenCount(agentId: string): number {
  return (harness.sqlite.prepare('SELECT COUNT(*) AS n FROM member_tokens WHERE agent_id = ?').get(agentId) as { n: number }).n
}
function usage(action: string): number {
  return (harness.sqlite.prepare('SELECT COUNT(*) AS n FROM elevation_usage_log WHERE action = ?').get(action) as { n: number }).n
}
function squadExists(slug: string): boolean {
  return harness.sqlite.prepare('SELECT 1 FROM squads WHERE slug = ?').get(slug) !== undefined
}
function memberOf(agentId: string): string {
  return (harness.sqlite.prepare('SELECT member_id FROM agent_member_bindings WHERE agent_id = ?').get(agentId) as { member_id: string }).member_id
}
function standingCap(memberId: string, squadId: string): string | undefined {
  return (harness.sqlite.prepare("SELECT capability FROM capabilities WHERE member_id = ? AND scope_type = 'squad' AND scope_id = ?").get(memberId, squadId) as { capability: string } | undefined)?.capability
}

describe('mint_agent_token: a grant on B1 never opens the standing path on A2', () => {
  it('standing admin on A2 + mint_token grant on B1 cannot mint for a victim in A2 (no token, no usage row); the grant still works on B1', async () => {
    const sessionId = await checkIn()
    await approve(sessionId, 'squad', SQUAD_B1, 60, T0, ['action:mint_token'])
    const a = agentAuth(standing(['squad', SQUAD_A2, 'admin']))
    const before = tokenCount(VICTIM)
    const refused = await mint(VICTIM, a)
    expect(refused.ok, JSON.stringify(refused)).toBe(false)
    expect(JSON.stringify(refused)).toContain('no_matching_grant')
    expect(tokenCount(VICTIM)).toBe(before)
    expect(usage('action:mint_token')).toBe(0)
    const ok = await mint(AGENT_B1, a)
    expect(ok.ok, JSON.stringify(ok)).toBe(true)
    expect(tokenCount(AGENT_B1)).toBe(1)
    expect(usage('action:mint_token')).toBeGreaterThan(0)
  })

  it('standing admin on its own squad + a grant elsewhere cannot mint a second token for ITSELF', async () => {
    const sessionId = await checkIn()
    await approve(sessionId, 'squad', SQUAD_B1, 60, T0, ['action:mint_token'])
    const before = tokenCount(AGENT_ID)
    const out = await mint(AGENT_ID, agentAuth(standing(['squad', SQUAD_A1, 'admin'])))
    expect(out.ok, JSON.stringify(out)).toBe(false)
    expect(tokenCount(AGENT_ID)).toBe(before)
    expect(usage('action:mint_token')).toBe(0)
  })

  it('a standing ORG-admin agent holding even a MATCHING mint grant cannot rotate (revoke) a prior token: rotation stays standing-human-only', async () => {
    const sessionId = await checkIn()
    await approve(sessionId, 'squad', SQUAD_A1, 60, T0, ['action:mint_token'])
    const out = await mint(AGENT_ID, agentAuth(standing(['org', null, 'admin'])), { rotate_prior_token_id: TOKEN_ID })
    expect(out.ok, JSON.stringify(out)).toBe(false)
    expect(harness.sqlite.prepare('SELECT revoked_at FROM member_tokens WHERE id = ?').get(TOKEN_ID)).toEqual({ revoked_at: null })
  })

  it('a human admin mints unchanged', async () => {
    const out = await mint(VICTIM, humanAdminAuth())
    expect(out.ok, JSON.stringify(out)).toBe(true)
    expect(tokenCount(VICTIM)).toBe(1)
  })
})

describe('grant_agent_capability: a grant on B1 never opens the standing path on A2', () => {
  async function mintedVictim(): Promise<string> {
    expect((await mint(VICTIM, humanAdminAuth())).ok, 'setup: victim minted').toBe(true)
    expect((await mint(AGENT_B1, humanAdminAuth())).ok, 'setup: b1 agent minted').toBe(true)
    return memberOf(VICTIM)
  }

  it('standing admin on A2 + manage_access grant on B1 cannot write a standing ADMIN row for the victim on A2; the grant works on B1 with a usage row', async () => {
    const victimMember = await mintedVictim()
    const sessionId = await checkIn()
    await approve(sessionId, 'squad', SQUAD_B1, 60, T0, ['action:manage_access'])
    const a = agentAuth(standing(['squad', SQUAD_A2, 'admin']))
    const heldBefore = standingCap(victimMember, SQUAD_A2) // minting seeds a 'member' row
    const out = await grantCap(VICTIM, SQUAD_A2, 'admin', a)
    expect(out.ok, JSON.stringify(out)).toBe(false)
    expect(JSON.stringify(out)).toContain('no_matching_grant')
    expect(standingCap(victimMember, SQUAD_A2)).toBe(heldBefore)
    expect(usage('action:manage_access')).toBe(0)
    const ok = await grantCap(VICTIM, SQUAD_B1, 'member', a)
    expect(ok.ok, JSON.stringify(ok)).toBe(true)
    expect(standingCap(victimMember, SQUAD_B1)).toBe('member')
    expect(usage('action:manage_access')).toBeGreaterThan(0)
  })

  it('on the elevated path self-grant, a rank above member and a member-cap bypass remain refused', async () => {
    await mintedVictim()
    const sessionId = await checkIn()
    await approve(sessionId, 'squad', SQUAD_B1, 60, T0, ['action:manage_access'])
    const a = agentAuth(standing(['squad', SQUAD_A2, 'admin']))
    expect(JSON.stringify(await grantCap(AGENT_ID, SQUAD_B1, 'member', a))).toMatch(/cannot_grant_to_self|agent_identity_unminted/)
    expect(JSON.stringify(await grantCap(AGENT_B1, SQUAD_B1, 'admin', a))).toContain('elevation_capability_ceiling')
  })

  it('a human admin grants unchanged (including admin)', async () => {
    const victimMember = await mintedVictim()
    const out = await grantCap(VICTIM, SQUAD_A2, 'admin', humanAdminAuth())
    expect(out.ok, JSON.stringify(out)).toBe(true)
    expect(standingCap(victimMember, SQUAD_A2)).toBe('admin')
  })
})

describe('create_squad: with DELEGATED_OPERATORS on, a grant on dept A never opens standing admin on dept B', () => {
  const flagOn = () => { env = { ...env, DELEGATED_OPERATORS: '1' } as Env }
  const deptBAdmin = () => agentAuth(standing(['department', DEPT_B, 'admin']))

  it('flag ON: standing dept-B admin + project_lifecycle grant on dept A cannot create a squad in B; the grant works in A with a usage row', async () => {
    flagOn()
    const sessionId = await checkIn()
    await approve(sessionId, 'department', DEPT_A, 60, T0, ['action:project_lifecycle'])
    const refused = await createSquadVia(DEPT_B, 'sneaky-b', deptBAdmin())
    expect(refused.ok, JSON.stringify(refused)).toBe(false)
    expect(JSON.stringify(refused)).toContain('no_matching_grant')
    expect(squadExists('sneaky-b')).toBe(false)
    expect(usage('action:project_lifecycle')).toBe(0)
    const ok = await createSquadVia(DEPT_A, 'legit-a', deptBAdmin())
    expect(ok.ok, JSON.stringify(ok)).toBe(true)
    expect(squadExists('legit-a')).toBe(true)
    expect(usage('action:project_lifecycle')).toBeGreaterThan(0)
  })

  it('flag ON, no grant at all: refused at the chokepoint (unchanged)', async () => {
    flagOn()
    const out = await createSquadVia(DEPT_B, 'nogrant-b', deptBAdmin())
    expect(out.ok).toBe(false)
    expect(squadExists('nogrant-b')).toBe(false)
  })

  it('flag OFF: the pre-W0 capability lane is unchanged: a standing dept-admin agent creates a squad with NO grant, and with a grant elsewhere (no new power either way)', async () => {
    const plain = await createSquadVia(DEPT_B, 'legacy-b', deptBAdmin())
    expect(plain.ok, JSON.stringify(plain)).toBe(true)
    const sessionId = await checkIn()
    await approve(sessionId, 'department', DEPT_A, 60, T0, ['action:project_lifecycle'])
    const withGrant = await createSquadVia(DEPT_B, 'legacy-b2', deptBAdmin())
    expect(withGrant.ok, JSON.stringify(withGrant)).toBe(true)
  })

  it('flag ON: a human admin creates squads unchanged', async () => {
    flagOn()
    expect((await createSquadVia(DEPT_B, 'human-b', humanAdminAuth())).ok).toBe(true)
  })
})

describe('HTTP door: POST /departments/:id/squads (mupot#1906)', () => {
  const flagOn = () => { env = { ...env, DELEGATED_OPERATORS: '1' } as Env }
  const deptBAdmin = () => agentAuth(standing(['department', DEPT_B, 'admin']))
  async function postSquad(department: string, slug: string, auth: AuthContext): Promise<Response> {
    const { orgApp } = await import('../src/org/index')
    authState.current = auth
    return orgApp.request(`/departments/${department}/squads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug, name: slug }),
    }, env)
  }

  it('flag ON: standing dept-B admin + grant on dept A cannot create in B (no row, no usage); the grant works in A with a usage row and stamp', async () => {
    flagOn()
    const sessionId = await checkIn()
    await approve(sessionId, 'department', DEPT_A, 60, T0, ['action:project_lifecycle'])
    const refused = await postSquad(DEPT_B, 'http-sneaky-b', deptBAdmin())
    expect(refused.status).toBe(403)
    expect(squadExists('http-sneaky-b')).toBe(false)
    expect(usage('action:project_lifecycle')).toBe(0)
    const ok = await postSquad(DEPT_A, 'http-legit-a', deptBAdmin())
    expect(ok.status, await ok.clone().text()).toBeLessThan(300)
    expect(squadExists('http-legit-a')).toBe(true)
    expect(usage('action:project_lifecycle')).toBeGreaterThan(0)
  })

  it('no standing floor on the elevated branch (parity with MCP ELEVATION_FLOOR_BYPASS_TOOLS): zero-admin + matching grant is allowed; zero-admin + non-matching grant is 403', async () => {
    flagOn()
    const sessionId = await checkIn()
    await approve(sessionId, 'department', DEPT_A, 60, T0, ['action:project_lifecycle'])
    const ok = await postSquad(DEPT_A, 'http-zero-admin-ok', agentAuth())
    expect(ok.status, await ok.clone().text()).toBeLessThan(300)
    expect(squadExists('http-zero-admin-ok')).toBe(true)
    const no = await postSquad(DEPT_B, 'http-zero-admin-no', agentAuth())
    expect(no.status).toBe(403)
    expect(squadExists('http-zero-admin-no')).toBe(false)
  })

  it('usage receipt only after success: bad body and slug conflict leave no usage row; success leaves exactly one', async () => {
    flagOn()
    const sessionId = await checkIn()
    await approve(sessionId, 'department', DEPT_A, 60, T0, ['action:project_lifecycle'])
    const { orgApp } = await import('../src/org/index')
    authState.current = agentAuth()
    const bad = await orgApp.request(`/departments/${DEPT_A}/squads`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' }, env)
    expect(bad.status).toBe(400)
    expect(usage('action:project_lifecycle')).toBe(0)
    expect((await postSquad(DEPT_A, 'dup-sq', agentAuth())).status).toBeLessThan(300)
    expect(usage('action:project_lifecycle')).toBe(1)
    const dup = await postSquad(DEPT_A, 'dup-sq', agentAuth())
    expect(dup.status).toBeGreaterThanOrEqual(400)
    expect(usage('action:project_lifecycle')).toBe(1)
  })

  it('MCP create_squad: slug conflict leaves no usage row; success leaves one', async () => {
    flagOn()
    const sessionId = await checkIn()
    await approve(sessionId, 'department', DEPT_A, 60, T0, ['action:project_lifecycle'])
    expect((await createSquadVia(DEPT_A, 'a1-sqd', agentAuth())).ok).toBe(false) // slug of an existing squad
    expect(usage('action:project_lifecycle')).toBe(0)
    expect((await createSquadVia(DEPT_A, 'mcp-fresh', agentAuth())).ok).toBe(true)
    expect(usage('action:project_lifecycle')).toBe(1)
  })

  it('flag ON: a human admin is unchanged; flag OFF: a standing dept admin agent is unchanged', async () => {
    expect((await postSquad(DEPT_B, 'http-legacy-b', deptBAdmin())).status).toBeLessThan(300)
    flagOn()
    expect((await postSquad(DEPT_B, 'http-human-b', humanAdminAuth())).status).toBeLessThan(300)
  })
})

describe('mint_agent_token: a grant never mints a non-expiring token from the standing org-owner plane', () => {
  it('standing org OWNER agent + matching grant: non_expiring refused, a normal mint works', async () => {
    const sessionId = await checkIn()
    await approve(sessionId, 'squad', SQUAD_B1, 60, T0, ['action:mint_token'])
    const a = agentAuth(standing(['org', null, 'owner']))
    const refused = await mint(AGENT_B1, a, { non_expiring: true })
    expect(refused.ok, JSON.stringify(refused)).toBe(false)
    expect(JSON.stringify(refused)).toContain('non_expiring_owner_required')
    expect(tokenCount(AGENT_B1)).toBe(0)
    const ok = await mint(AGENT_B1, a)
    expect(ok.ok, JSON.stringify(ok)).toBe(true)
  })
})

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const f = join(dir, n)
    return statSync(f).isDirectory() ? walk(f) : f.endsWith('.ts') ? [f] : []
  })
}

describe('ratchet: every authorizeStructuralWrite caller of a grant-door act consults agentMustHoldMatchingGrant (code only, comments stripped)', () => {
  const root = new URL('../src', import.meta.url).pathname
  const entries = Object.entries(STRUCTURAL_ACTIONS) as Array<[StructuralAction, (typeof STRUCTURAL_ACTIONS)[StructuralAction]]>
  // Acts whose standing lane an agent could ride in on a grant: a door the predicate can be true for.
  const doorActs = entries.filter(([, p]) => p.elevationAction && (p.agentLane === 'refuse' || p.delegable)).map(([a]) => a)
  // Callers that refuse EVERY non-principal verdict themselves (gate.kind !== 'principal'): no standing lane to ride.
  const principalOnly = new Set(['org/squad-packs.ts', 'loops/outreach-pack.ts'])
  const files = walk(root).map((f) => ({ rel: f.slice(root.length + 1), code: stripComments(readFileSync(f, 'utf8')) }))
    .filter((f) => /authorizeStructuralWrite\(|structuralGate\(/.test(f.code) && f.rel !== 'operators/chokepoint.ts')

  it('the door set and the caller scan are non-empty', () => {
    expect(doorActs).toEqual(expect.arrayContaining(['mint_agent_token', 'grant_agent_capability', 'update_squad', 'update_department', 'create_squad']))
    expect(files.map((f) => f.rel)).toEqual(expect.arrayContaining(['mcp/provision.ts', 'org/index.ts']))
  })

  const cases = doorActs.flatMap((a) => files.filter((f) => !principalOnly.has(f.rel) && f.code.includes(`'${a}'`)).map((f) => [a, f.rel] as const))
  it.each(cases)('%s in %s consumes agentMustHoldMatchingGrant for it', (action, rel) => {
    const code = files.find((f) => f.rel === rel)?.code ?? ''
    expect(code, `${rel} gates '${action}' without agentMustHoldMatchingGrant(..., '${action}')`).toMatch(
      new RegExp(`agentMustHoldMatchingGrant\\([^,]+,[^,]+,\\s*'${action}'\\)`),
    )
  })

  it.each(doorActs.filter((a) => STRUCTURAL_ACTIONS[a].agentLane === 'refuse'))('%s: true for a bound agent, false for a human', (action) => {
    expect(agentMustHoldMatchingGrant(env, agentAuth(), action)).toBe(true)
    expect(agentMustHoldMatchingGrant(env, humanAdminAuth(), action)).toBe(false)
  })

  it('create_squad (capability lane): true only when DELEGATED_OPERATORS is on', () => {
    expect(agentMustHoldMatchingGrant(env, agentAuth(), 'create_squad')).toBe(false)
    expect(agentMustHoldMatchingGrant({ ...env, DELEGATED_OPERATORS: '1' } as Env, agentAuth(), 'create_squad')).toBe(true)
  })
})
