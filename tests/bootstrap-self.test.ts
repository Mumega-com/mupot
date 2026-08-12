// tests/bootstrap-self.test.ts — mupot#925: bootstrap_self, the exit ramp from
// "connected but mute" for an unbound, verified directory session.
//
// Drives src/members/bootstrap-self.ts directly against a REAL sqlite D1 built
// from the full committed migration chain (tests/helpers/migrations.ts) — never
// a hand-written schema, never a hand-mocked D1. See src/members/bootstrap-self.ts
// for the full design rationale (River's ruling, the atomic-batch argument, the
// adversarial review's fixes).
//
// MUTATION-CHECK DISCIPLINE (per the build brief): every regression test below
// was proven to fail when its corresponding fix was reverted. The mutations
// applied and the resulting red output are recorded in the final build report,
// not restated per-test here — but each test's comment names exactly what
// removing/breaking would make it fail, so the mapping is auditable from this
// file alone.
//
// WHAT THESE TESTS DO NOT PROVE: this harness's env.DB.batch() is a real SQLite
// transaction (BEGIN IMMEDIATE ... COMMIT, sequential) — see
// tests/helpers/sqlite-d1.ts. It cannot reproduce any hypothetical defect where a
// statement inside a real Cloudflare D1 batch fails to see an earlier statement's
// write in the SAME batch. This suite proves the LOGIC (gates, idempotence,
// atomicity of intent, audit shape) is correct against real SQLite semantics; it
// does not (and cannot) prove anything about D1's actual cross-shard batch
// behaviour on production.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import {
  bootstrapSelf,
  defaultBootstrapSelfDeps,
  checkBootstrapSelfRateLimit,
  refundBootstrapSelfRateLimit,
  type BootstrapSelfDeps,
  type BootstrapAuth,
} from '../src/members/bootstrap-self'
import { createDepartment, createSquad } from '../src/org/service'
import type { Env } from '../src/types'

const TENANT = 'mumega'
const HUMAN = 'member-human-1'

function memoryKv() {
  const store = new Map<string, string>()
  return {
    async get(key: string) {
      return store.get(key) ?? null
    },
    async put(key: string, value: string) {
      store.set(key, value)
    },
    async delete(key: string) {
      store.delete(key)
    },
    _store: store,
  }
}

function envFor(harness: SqliteD1Harness, extra: Record<string, unknown> = {}): Env {
  return {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    SESSIONS: memoryKv(),
    ...extra,
  } as unknown as Env
}

function unboundDirectoryAuth(memberId = HUMAN): BootstrapAuth {
  return { channel: 'directory', boundAgentId: null, memberId }
}

/** Seed a `members` row — bootstrap_self reads/writes against the human's own
 *  member id but never creates it (findOrCreateMember, a separate flow, already
 *  did that at OAuth time). */
function seedHuman(sqlite: SqliteD1Harness['sqlite'], memberId = HUMAN): void {
  // email is UNIQUE on members — derive it from memberId so tests seeding
  // multiple distinct humans (P0-N1, LOW-4) don't collide on a shared literal.
  sqlite.exec(
    `INSERT INTO members (id, email, display_name, status, created_at, tenant)
     VALUES ('${memberId}', '${memberId}@example.test', 'Human', 'active', '2026-08-11T00:00:00.000Z', '${TENANT}')`,
  )
}

let harness: SqliteD1Harness

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  seedHuman(harness.sqlite)
})

afterEach(() => {
  harness.close()
})

// ════════════════════════════════════════════════════════════════════════════
// 1. The gate — River's condition 2
// ════════════════════════════════════════════════════════════════════════════
describe('gate — auth.channel === "directory" && !auth.boundAgentId, and nothing else', () => {
  it('refuses an agent-bound token even on the directory channel', async () => {
    const env = envFor(harness)
    const out = await bootstrapSelf(env, { channel: 'directory', boundAgentId: 'agent-x', memberId: HUMAN }, 'Aria')
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('expected refusal')
    expect(out.error).toBe('not_unbound_directory_session')
    // Nothing was created.
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM agents').get()!.n).toBe(0)
  })

  it('refuses a workspace-channel session (not the public first-run door)', async () => {
    const env = envFor(harness)
    const out = await bootstrapSelf(env, { channel: 'workspace', boundAgentId: null, memberId: HUMAN }, 'Aria')
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('expected refusal')
    expect(out.error).toBe('not_unbound_directory_session')
  })

  it('refuses an im-channel session', async () => {
    const env = envFor(harness)
    const out = await bootstrapSelf(env, { channel: 'im', boundAgentId: null, memberId: HUMAN }, 'Aria')
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('expected refusal')
    expect(out.error).toBe('not_unbound_directory_session')
  })

  it('refuses a dashboard-channel session', async () => {
    const env = envFor(harness)
    const out = await bootstrapSelf(env, { channel: 'dashboard', boundAgentId: null, memberId: HUMAN }, 'Aria')
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('expected refusal')
    expect(out.error).toBe('not_unbound_directory_session')
  })

  it('passes the gate for an unbound directory session', async () => {
    const env = envFor(harness)
    const out = await bootstrapSelf(env, unboundDirectoryAuth(), 'Aria')
    expect(out.ok).toBe(true)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 2. agent_name — River's condition 1 (naming is the witness act)
// ════════════════════════════════════════════════════════════════════════════
describe('agent_name is required — no silent auto-create, no default', () => {
  it('rejects a missing agent_name', async () => {
    const env = envFor(harness)
    const out = await bootstrapSelf(env, unboundDirectoryAuth(), undefined)
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('expected refusal')
    expect(out.error).toBe('agent_name_required')
  })

  it('rejects an empty/whitespace-only agent_name', async () => {
    const env = envFor(harness)
    const out = await bootstrapSelf(env, unboundDirectoryAuth(), '   ')
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('expected refusal')
    expect(out.error).toBe('agent_name_required')
  })

  it('rejects a non-string agent_name', async () => {
    const env = envFor(harness)
    const out = await bootstrapSelf(env, unboundDirectoryAuth(), 42)
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('expected refusal')
    expect(out.error).toBe('agent_name_required')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 3. Success path + the capability clamp — River's condition 3
// ════════════════════════════════════════════════════════════════════════════
describe('success path', () => {
  it('creates department, squad, agent, and a workspace-channel token', async () => {
    const env = envFor(harness)
    const out = await bootstrapSelf(env, unboundDirectoryAuth(), 'Aria')
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error('expected success')

    expect(out.agent.name).toBe('Aria')
    expect(out.token.raw).toMatch(/^mupot_/)
    expect(out.token.capability).toBe('member')

    const agentRow = harness.sqlite
      .prepare('SELECT * FROM agents WHERE id = ?').get(out.agent.id) as { squad_id: string; status: string }
    expect(agentRow.squad_id).toBe(out.squad.id)
    expect(agentRow.status).toBe('active')

    const squadRow = harness.sqlite
      .prepare('SELECT department_id FROM squads WHERE id = ?').get(out.squad.id) as { department_id: string }
    expect(squadRow.department_id).toBe(out.department.id)

    // The token is minted through the SAME weld member_tokens uses everywhere else.
    const tokenRow = harness.sqlite
      .prepare('SELECT agent_id, member_id, channel, revoked_at FROM member_tokens WHERE id = ?')
      .get(out.token.id) as { agent_id: string; member_id: string; channel: string; revoked_at: string | null }
    expect(tokenRow.agent_id).toBe(out.agent.id)
    expect(tokenRow.member_id).toBe(out.member_id)
    expect(tokenRow.channel).toBe('workspace')
    expect(tokenRow.revoked_at).toBeNull()
  })

  it('the agent slug/dept slug/squad slug are DERIVED from the member id, never from agent_name (P0-1)', async () => {
    const env = envFor(harness)
    // A hostile agent_name that would collide with a real agent's slug if it were
    // ever used as one.
    const out = await bootstrapSelf(env, unboundDirectoryAuth(), 'kasra')
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error('expected success')
    expect(out.agent.slug).not.toBe('kasra')
    expect(out.agent.slug).toContain(HUMAN)
    expect(out.squad.slug).toContain(HUMAN)
    expect(out.department.slug).toContain(HUMAN)
    // The human-authored label is preserved as the NAME (display), separately.
    expect(out.agent.name).toBe('kasra')
  })

  it('capability clamp: the agent is MEMBER on its home squad, never lead/admin/owner', async () => {
    const env = envFor(harness)
    const out = await bootstrapSelf(env, unboundDirectoryAuth(), 'Aria')
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error('expected success')

    const rows = harness.sqlite
      .prepare('SELECT scope_type, scope_id, capability FROM capabilities WHERE member_id = ?')
      .all(out.member_id) as { scope_type: string; scope_id: string; capability: string }[]

    expect(rows).toHaveLength(1)
    expect(rows[0].scope_type).toBe('squad')
    expect(rows[0].scope_id).toBe(out.squad.id)
    expect(rows[0].capability).toBe('member')
    expect(['lead', 'admin', 'owner']).not.toContain(rows[0].capability)
  })

  it('WARN-1: bootstrapSelf never reads auth.latentCapabilities (source-level guard)', async () => {
    // Distinct from the founder-grant tests below: this pins that the WRITE
    // decision (what to grant) never depends on READING the human's existing
    // latent authority — only auth.channel/boundAgentId/memberId are consulted.
    // Reading latentCapabilities on a write path would reinstate exactly the
    // inheritance the B1 ceiling exists to prevent (#712).
    const src = readFileSync(join(__dirname, '..', 'src', 'members', 'bootstrap-self.ts'), 'utf8')
    expect(src).not.toContain('latentCapabilities')
  })

  it('river addendum A — the founding human gets EXACTLY squad:admin on their own home squad', async () => {
    const env = envFor(harness)
    const out = await bootstrapSelf(env, unboundDirectoryAuth(), 'Aria')
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error('expected success')

    expect(out.founder_grant).toEqual({ member_id: HUMAN, squad_id: out.squad.id, capability: 'admin' })

    const humanRows = harness.sqlite
      .prepare('SELECT scope_type, scope_id, capability FROM capabilities WHERE member_id = ?')
      .all(HUMAN) as { scope_type: string; scope_id: string; capability: string }[]
    expect(humanRows).toHaveLength(1)
    expect(humanRows[0]).toEqual({ scope_type: 'squad', scope_id: out.squad.id, capability: 'admin' })
  })

  it('binding condition 1: EVERY capabilities row this path writes is scope_type=squad, scope_id=homeSquadId — never org, never department, never another squad', async () => {
    const env = envFor(harness)
    const beforeIds = new Set(
      (harness.sqlite.prepare('SELECT id FROM capabilities').all() as { id: string }[]).map((r) => r.id),
    )
    const out = await bootstrapSelf(env, unboundDirectoryAuth(), 'Aria')
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error('expected success')

    const allRows = harness.sqlite
      .prepare('SELECT id, scope_type, scope_id, capability FROM capabilities')
      .all() as { id: string; scope_type: string; scope_id: string | null; capability: string }[]
    const written = allRows.filter((r) => !beforeIds.has(r.id))

    expect(written.length).toBeGreaterThan(0)
    for (const row of written) {
      expect(row.scope_type).toBe('squad')
      // The org-scope shape is scope_id IS NULL (migrations/0002_members.sql) —
      // that row must never appear among what this path writes.
      expect(row.scope_id).not.toBeNull()
      expect(row.scope_id).toBe(out.squad.id)
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 4. Provenance — River's condition 4
// ════════════════════════════════════════════════════════════════════════════
describe('provenance — the audit record', () => {
  it('writes exactly one agent_audit row, actor=the human, action=bootstrap_self', async () => {
    const env = envFor(harness)
    const out = await bootstrapSelf(env, unboundDirectoryAuth(), 'Aria')
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error('expected success')

    const row = harness.sqlite
      .prepare('SELECT * FROM agent_audit WHERE id = ?')
      .get(out.audit_id) as {
        agent_id: string
        actor_id: string
        actor_type: string
        action: string
        before_state: string
        after_state: string
      }
    expect(row.agent_id).toBe(out.agent.id)
    expect(row.actor_id).toBe(HUMAN)
    expect(row.actor_type).toBe('user')
    expect(row.action).toBe('bootstrap_self')
  })

  it('after_state is non-blank AND != before_state — the single assertion the two-phase backfill shape would fail', async () => {
    const env = envFor(harness)
    const out = await bootstrapSelf(env, unboundDirectoryAuth(), 'Aria')
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error('expected success')

    const row = harness.sqlite
      .prepare('SELECT before_state, after_state FROM agent_audit WHERE id = ?')
      .get(out.audit_id) as { before_state: string; after_state: string }

    expect(row.after_state).not.toBe('')
    expect(row.after_state).not.toBe(row.before_state)

    const before = JSON.parse(row.before_state) as Record<string, unknown>
    const after = JSON.parse(row.after_state) as Record<string, unknown>
    // before: the honest "did not exist" image — every audited field null.
    for (const key of Object.keys(before)) expect(before[key]).toBeNull()
    // after: the real created row.
    expect(after.slug).toBe(out.agent.slug)
    expect(after.name).toBe('Aria')
    expect(after.squad_id).toBe(out.squad.id)
  })

  it('the agent_audit append-only triggers still hold — no UPDATE, no DELETE (regression guard, not new behaviour)', () => {
    harness.sqlite.exec(
      `INSERT INTO agent_audit (id, agent_id, actor_id, actor_type, action, fields_changed, before_state, after_state)
       VALUES ('a1', 'agent-none', 'm1', 'user', 'bootstrap_self', '[]', '{}', '{"x":1}')`,
    )
    expect(() => harness.sqlite.exec(`UPDATE agent_audit SET action = 'x' WHERE id = 'a1'`)).toThrow()
    expect(() => harness.sqlite.exec(`DELETE FROM agent_audit WHERE id = 'a1'`)).toThrow()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 5. Idempotent-once per member — River's condition 5 + migration 0092
// ════════════════════════════════════════════════════════════════════════════
describe('idempotent-once PER MEMBER, not per token', () => {
  it('a second call for the SAME member does not mint a second agent', async () => {
    const env = envFor(harness)
    const first = await bootstrapSelf(env, unboundDirectoryAuth(), 'Aria')
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error('expected success')

    // A different TOKEN (new session), same human member id — exactly the
    // re-login/second-harness case river's condition names.
    const second = await bootstrapSelf(env, unboundDirectoryAuth(), 'A different name entirely')
    expect(second.ok).toBe(false)
    if (second.ok) throw new Error('expected already_bootstrapped')
    expect(second.error).toBe('already_bootstrapped')
    expect((second.detail as { agent_id?: string })?.agent_id).toBe(first.agent.id)

    const agentCount = harness.sqlite.prepare('SELECT COUNT(*) AS n FROM agents').get() as { n: number }
    expect(agentCount.n).toBe(1)
    const auditCount = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM agent_audit WHERE actor_id = ? AND action = 'bootstrap_self'`)
      .get(HUMAN) as { n: number }
    expect(auditCount.n).toBe(1)
  })

  it('STRUCTURAL guard (migration 0092): a raw second INSERT for the same actor_id/action is rejected by the DB itself', () => {
    harness.sqlite.exec(
      `INSERT INTO agent_audit (id, agent_id, actor_id, actor_type, action, fields_changed, before_state, after_state)
       VALUES ('a1', 'agent-1', '${HUMAN}', 'user', 'bootstrap_self', '[]', '{}', '{"x":1}')`,
    )
    expect(() => harness.sqlite.exec(
      `INSERT INTO agent_audit (id, agent_id, actor_id, actor_type, action, fields_changed, before_state, after_state)
       VALUES ('a2', 'agent-2', '${HUMAN}', 'user', 'bootstrap_self', '[]', '{}', '{"y":2}')`,
    )).toThrow(/UNIQUE constraint failed/)
  })

  it('the partial index does NOT constrain update_agent rows for the same actor (must not break the existing path)', () => {
    harness.sqlite.exec(
      `INSERT INTO agent_audit (id, agent_id, actor_id, actor_type, action, fields_changed, before_state, after_state)
       VALUES ('u1', 'agent-1', '${HUMAN}', 'user', 'update_agent', '[]', '{}', '{"x":1}')`,
    )
    // A second update_agent row for the SAME actor must succeed — this is the
    // normal "an admin corrects the same agent's profile twice" case.
    expect(() => harness.sqlite.exec(
      `INSERT INTO agent_audit (id, agent_id, actor_id, actor_type, action, fields_changed, before_state, after_state)
       VALUES ('u2', 'agent-1', '${HUMAN}', 'user', 'update_agent', '[]', '{"x":1}', '{"x":2}')`,
    )).not.toThrow()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 6. Compensation on mid-chain failure — P0-5's "cannot fully unwind" concern,
//    resolved by making the risky cluster ONE atomic batch: only department and
//    squad (never delete-guarded) can ever be left behind, and both always are
//    fully cleaned up.
// ════════════════════════════════════════════════════════════════════════════
describe('compensation on mid-chain failure', () => {
  function depsWithFailingMintPrepare(): BootstrapSelfDeps {
    return {
      ...defaultBootstrapSelfDeps(),
      prepareAgentBoundTokenMint: async () => {
        throw new Error('simulated mint-prepare failure')
      },
    }
  }

  it('mint-prepare failure: department and squad are deleted, nothing else was ever created', async () => {
    const env = envFor(harness)
    const out = await bootstrapSelf(env, unboundDirectoryAuth(), 'Aria', depsWithFailingMintPrepare())
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('expected failure')
    expect(out.error).toBe('provisioning_failed')

    expect(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM departments').get()!.n).toBe(0)
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM squads').get()!.n).toBe(0)
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM agents').get()!.n).toBe(0)
    // A retry (real deps) must succeed cleanly afterward — no orphan slug lockout.
    const retry = await bootstrapSelf(env, unboundDirectoryAuth(), 'Aria')
    expect(retry.ok).toBe(true)
  })

  // WARN-2 (adversarial review, second pass): the PREVIOUS version of this test
  // was titled "batch failure ... department and squad are deleted" but seeded
  // the winner audit row BEFORE calling bootstrapSelf — so the app-level
  // pre-check (bootstrap-self.ts, "Condition 5 (part 1 of 2)") short-circuited
  // to already_bootstrapped before ever creating a department, and its
  // departments==0/squads==0 assertions passed VACUOUSLY (nothing was ever
  // created in the first place). Nothing in the suite ever reached the actual
  // batch-catch compensator code.
  //
  // REACHABILITY NOTE on the scenario the old test THOUGHT it was covering (a
  // concurrent same-member race losing specifically on the agent_audit
  // uniqueness guard, INSIDE the batch): after P0-N2's adopt-existing fix, two
  // concurrent bootstrap_self calls for the SAME member converge on the SAME
  // department AND the SAME squad (server-derived, deterministic slugs), which
  // means their agent INSERTs also collide on agents' own
  // UNIQUE(squad_id, slug) — and that statement runs BEFORE the audit INSERT
  // in this batch's statement order (preparedAgent.statements is first). So the
  // race now fails on `agents`, not `agent_audit`, and isBootstrapAuditConflict
  // (which pattern-matches specifically on 'agent_audit' in the error message)
  // does not classify it as already_bootstrapped — it falls through to the
  // generic provisioning_failed{stage:'batch'} path instead, which is provably
  // safe: compensateCreatedRows is only ever called with squadCreatedHere/
  // departmentCreatedHere ids, so the LOSING caller (which adopted, not
  // created) leaves the WINNER's real rows completely untouched (see the
  // 'squad-vs-department adoption is respected by the compensator' test below,
  // which pins that behavior directly). I did not find a way to reach
  // isBootstrapAuditConflict's TRUE branch through the batch catch via a normal
  // same-member race anymore, given that statement ordering.
  //
  // What THIS test verifies instead is the compensator branch itself: a batch
  // call that reports success at the D1-call level (no thrown error) but whose
  // writes never actually landed in THIS test's sqlite (the stub never touches
  // the real env.DB.batch) — the exact "phantom success" shape LOW-3's
  // assertBatchWritten (src/lib/receipt.ts) exists to catch. assertBatchWritten
  // throws AFTER the stub "commits" (returns normally), which is exactly what
  // reaches bootstrap-self.ts's real batch-catch block and its compensator.
  function depsWithPhantomBatchWrite(): BootstrapSelfDeps {
    return {
      ...defaultBootstrapSelfDeps(),
      batch: async (_env, statements) => statements.map(() => ({ success: true, meta: { changes: 0 } })),
    }
  }

  it('WARN-2: a phantom batch write (assertBatchWritten/LOW-3 catches it) — department and squad are deleted', async () => {
    const env = envFor(harness)
    const out = await bootstrapSelf(env, unboundDirectoryAuth(), 'Aria', depsWithPhantomBatchWrite())
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('expected failure')
    expect(out.error).toBe('provisioning_failed')
    expect((out.detail as { stage?: string })?.stage).toBe('batch')
    expect((out.detail as { reason?: string })?.reason).toMatch(/receipt_failed/)

    expect(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM departments').get()!.n).toBe(0)
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM squads').get()!.n).toBe(0)
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM agents').get()!.n).toBe(0)

    // A retry (real deps) must succeed cleanly afterward — no orphan slug lockout.
    const retry = await bootstrapSelf(env, unboundDirectoryAuth(), 'Aria')
    expect(retry.ok).toBe(true)
  })
  // NOTE (build brief: "verify both independently, do not assume one covers
  // the other"): the mint-prepare-failure test above throws BEFORE deps.batch
  // is ever called (no batch statement exists yet — it exercises the
  // mint_prepare catch block). This phantom-write test throws AFTER
  // deps.batch returns (inside assertBatchWritten — it exercises the batch
  // catch block). Two distinct try/catch blocks, two distinct trigger points,
  // both asserted above independently — not inferred from one another.
})

// ════════════════════════════════════════════════════════════════════════════
// 7. Per-member attempt throttle (adversarial review LOW-1)
// ════════════════════════════════════════════════════════════════════════════
describe('per-member attempt throttle', () => {
  it('allows up to 5 attempts per hour, then blocks the 6th', async () => {
    const kv = memoryKv()
    const env = { DB: harness.db, TENANT_SLUG: TENANT, SESSIONS: kv } as unknown as Env
    for (let i = 0; i < 5; i += 1) {
      const r = await checkBootstrapSelfRateLimit(env, HUMAN)
      expect(r.allowed).toBe(true)
    }
    const sixth = await checkBootstrapSelfRateLimit(env, HUMAN)
    expect(sixth.allowed).toBe(false)
    expect(sixth.retryAfter).toBeGreaterThan(0)
  })

  it('is keyed on the MEMBER, not shared globally — a different member has its own budget', async () => {
    const kv = memoryKv()
    const env = { DB: harness.db, TENANT_SLUG: TENANT, SESSIONS: kv } as unknown as Env
    for (let i = 0; i < 5; i += 1) await checkBootstrapSelfRateLimit(env, 'member-a')
    const blocked = await checkBootstrapSelfRateLimit(env, 'member-a')
    expect(blocked.allowed).toBe(false)
    const other = await checkBootstrapSelfRateLimit(env, 'member-b')
    expect(other.allowed).toBe(true)
  })

  it('bootstrapSelf itself refuses once the throttle trips', async () => {
    const kv = memoryKv()
    const env = { DB: harness.db, TENANT_SLUG: TENANT, SESSIONS: kv } as unknown as Env
    for (let i = 0; i < 5; i += 1) await checkBootstrapSelfRateLimit(env, HUMAN)
    const out = await bootstrapSelf(env, unboundDirectoryAuth(), 'Aria')
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('expected refusal')
    expect(out.error).toBe('rate_limited')
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM agents').get()!.n).toBe(0)
  })

  // LOW-1 (adversarial review, second pass): the throttle check now runs
  // BEFORE the already-bootstrapped pre-check (bootstrap-self.ts). Before this
  // reorder, an already-bootstrapped member's repeat calls short-circuited at
  // the pre-check and NEVER reached checkRateLimit, so they cost nothing —
  // an unmetered "is this member bootstrapped yet" poll loop.
  it('LOW-1: repeat calls from an already-bootstrapped member consume throttle budget too', async () => {
    const env = envFor(harness)
    const first = await bootstrapSelf(env, unboundDirectoryAuth(), 'Aria')
    expect(first.ok).toBe(true)

    // 4 more repeat calls (already_bootstrapped) — 5 calls total (1 fresh +
    // 4 repeats), still within the 5/hour budget.
    for (let i = 0; i < 4; i += 1) {
      const r = await bootstrapSelf(env, unboundDirectoryAuth(), 'Aria')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toBe('already_bootstrapped')
    }

    // The 6th call exceeds the budget — even though every repeat was a cheap
    // already-bootstrapped short-circuit, not a fresh provisioning attempt.
    const sixth = await bootstrapSelf(env, unboundDirectoryAuth(), 'Aria')
    expect(sixth.ok).toBe(false)
    if (sixth.ok) throw new Error('expected refusal')
    expect(sixth.error).toBe('rate_limited')
  })

  // Unit-level pin of the refund primitive itself. As documented on
  // refundBootstrapSelfRateLimit's own doc comment, bootstrapSelf currently has
  // NO reachable call site for this (P0-N1's kind:'home' exemption means
  // createDepartment/createSquad/prepareAgentCreate never return a
  // *_limit_reached reason for a kind:'home' create) — this test proves the
  // primitive itself is correct in isolation, not that bootstrapSelf exercises
  // it end-to-end.
  it('refundBootstrapSelfRateLimit returns one unit of budget to a member', async () => {
    const kv = memoryKv()
    const env = { DB: harness.db, TENANT_SLUG: TENANT, SESSIONS: kv } as unknown as Env
    for (let i = 0; i < 5; i += 1) await checkBootstrapSelfRateLimit(env, 'member-refund')
    const blocked = await checkBootstrapSelfRateLimit(env, 'member-refund')
    expect(blocked.allowed).toBe(false)

    await refundBootstrapSelfRateLimit(env, 'member-refund')
    const afterRefund = await checkBootstrapSelfRateLimit(env, 'member-refund')
    expect(afterRefund.allowed).toBe(true)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 8. P0-N2 — orphan lockout: adopt-existing, never a permanent 500
// ════════════════════════════════════════════════════════════════════════════
describe('P0-N2: a prior partial attempt\'s dept/squad is ADOPTED, not a permanent lockout', () => {
  it('resume path: create a dept+squad exactly as a crashed prior attempt would, then bootstrap_self completes', async () => {
    const env = envFor(harness)
    // Simulate the exact crash point P0-2 describes: the worker died AFTER the
    // createDepartment/createSquad commits but BEFORE the atomic agent/mint/
    // audit batch ever ran. Call the real service functions directly with the
    // SAME server-derived slugs bootstrapSelf itself would compute.
    const deptSlug = `dept-home-${HUMAN}`
    const squadSlug = `home-${HUMAN}`
    const deptRes = await createDepartment(env, { slug: deptSlug, name: 'Home — Aria', kind: 'home' })
    expect(deptRes.ok).toBe(true)
    if (!deptRes.ok) throw new Error('setup failed')
    const squadRes = await createSquad(env, deptRes.value.id, { slug: squadSlug, name: 'Home — Aria', kind: 'home' })
    expect(squadRes.ok).toBe(true)
    if (!squadRes.ok) throw new Error('setup failed')

    // Before P0-N2: this returned provisioning_failed{stage:'department',
    // reason:'slug_taken'} — FOREVER, on every retry, no audit row, no recovery.
    const out = await bootstrapSelf(env, unboundDirectoryAuth(), 'Aria')
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error(`expected the resume to succeed, got: ${JSON.stringify(out)}`)
    expect(out.department.id).toBe(deptRes.value.id) // ADOPTED, not a fresh row
    expect(out.squad.id).toBe(squadRes.value.id)

    // Adoption did not create a duplicate department/squad for this member.
    const deptCount = harness.sqlite
      .prepare('SELECT COUNT(*) AS n FROM departments WHERE slug = ?').get(deptSlug) as { n: number }
    expect(deptCount.n).toBe(1)
    const squadCount = harness.sqlite
      .prepare('SELECT COUNT(*) AS n FROM squads WHERE slug = ?').get(squadSlug) as { n: number }
    expect(squadCount.n).toBe(1)
  })

  it('a batch failure AFTER adopting a prior dept/squad does NOT delete the adopted rows', async () => {
    const env = envFor(harness)
    const deptSlug = `dept-home-${HUMAN}`
    const squadSlug = `home-${HUMAN}`
    const deptRes = await createDepartment(env, { slug: deptSlug, name: 'Home — Aria', kind: 'home' })
    if (!deptRes.ok) throw new Error('setup failed')
    const squadRes = await createSquad(env, deptRes.value.id, { slug: squadSlug, name: 'Home — Aria', kind: 'home' })
    if (!squadRes.ok) throw new Error('setup failed')

    const depsWithFailingMintPrepare: BootstrapSelfDeps = {
      ...defaultBootstrapSelfDeps(),
      prepareAgentBoundTokenMint: async () => {
        throw new Error('simulated mint-prepare failure')
      },
    }
    const out = await bootstrapSelf(env, unboundDirectoryAuth(), 'Aria', depsWithFailingMintPrepare)
    expect(out.ok).toBe(false)

    // The ADOPTED department/squad from the prior attempt must survive — they
    // were never created by THIS call, so compensateCreatedRows must never
    // touch them.
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM departments').get()!.n).toBe(1)
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM squads').get()!.n).toBe(1)
    expect(
      harness.sqlite.prepare('SELECT id FROM departments WHERE slug = ?').get(deptSlug),
    ).toBeTruthy()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 9. P0-N1 — home containers are exempt from plan-limit counters
//    (river ruling rul-2026-08-11-bootstrap-self, addendum C)
// ════════════════════════════════════════════════════════════════════════════
describe('P0-N1: a fresh free-tier pot admits MANY humans via bootstrap_self, not one', () => {
  it('at least 3 distinct humans succeed on a fresh (unconfigured -> free) pot', async () => {
    const env = envFor(harness)
    // No billing_state row is seeded -> resolveTier fails closed to 'free'
    // (maxSquads:1, maxAgents:2 — see src/billing/plans.ts). Before P0-N1, the
    // SECOND human here got squad_limit_reached (1 existing squad -> 1+1=2 > 1).
    const humans = [HUMAN, 'human-b', 'human-c']
    for (const h of humans) if (h !== HUMAN) seedHuman(harness.sqlite, h)

    const results = []
    for (const h of humans) {
      results.push(await bootstrapSelf(env, unboundDirectoryAuth(h), `Agent-${h}`))
    }
    const succeeded = results.filter((r) => r.ok)
    expect(succeeded.length).toBeGreaterThanOrEqual(3)

    // Each human got their OWN distinct home department/squad/agent.
    const squadIds = new Set(succeeded.map((r) => (r as { squad: { id: string } }).squad.id))
    expect(squadIds.size).toBe(3)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 10. LOW-4 — slug length at the REAL 48-char cap boundary
// ════════════════════════════════════════════════════════════════════════════
describe('LOW-4: slugs stay within the 48-char cap for a REAL UUID-length member id', () => {
  it('dept-home-<uuid> (46 chars) / home-<uuid> (41) / self-<uuid> (41) all validate and succeed', async () => {
    // findOrCreateMember always mints a real crypto.randomUUID() (36 chars) —
    // the existing suite's HUMAN = 'member-human-1' (14 chars) never exercises
    // "dept-home-" (10 chars) + a real UUID = 46 chars against the 48-char cap
    // (src/org/service.ts's isValidSlug). This test uses a real UUID shape.
    const realUuidMember = crypto.randomUUID()
    expect(realUuidMember.length).toBe(36)
    seedHuman(harness.sqlite, realUuidMember)
    const env = envFor(harness)
    const out = await bootstrapSelf(env, unboundDirectoryAuth(realUuidMember), 'Aria')
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error(`expected success, got: ${JSON.stringify(out)}`)
    expect(out.department.slug).toBe(`dept-home-${realUuidMember}`)
    expect(out.department.slug.length).toBe(46)
    expect(out.squad.slug.length).toBeLessThanOrEqual(48)
    expect(out.agent.slug.length).toBeLessThanOrEqual(48)
  })
})
