// tests/task-archive-action-boundary.test.ts - mupot#1571.
//
// ARCHIVED = NO ACTION. #1561 shipped archive as a READER filter; on 2ba72320 a real SQLite
// run proved router_tick and the concierge cron still assigned an archived open task and
// task_update still moved it. This file is the contract that archive is an ACTION boundary:
//
//  1. SEAM SCAN (raw text, same discipline as the other CI ratchets): every `UPDATE tasks` in
//     src/ either carries TASK_NOT_ARCHIVED_SQL in its own WHERE or is on a justified
//     allowlist. A new unguarded writer fails CI.
//  2. BEHAVIOUR on real SQLite with the full migration chain: with an archived open task,
//     router_tick, the concierge cron, task_update, task_verdict, task_dispatch,
//     task_submit_result, flight_dispatch, runtime receipts, the executor claim and the
//     bus-consumer block write all refuse.
//  3. The refusal is honest (named error / skip decision), never a success-shaped no-op.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeTool } from '../src/mcp/index'
import { runRouterTick } from '../src/router/engine'
import { runProjectConcierge, conciergeIdentity, BUILD_CAPABILITY } from '../src/concierge/service'
import { registerModule } from '../src/registry/service'
import { recordTaskDispatchRuntimeReceipt, TaskDispatchRuntimeReceiptError } from '../src/tasks/runtime-receipts'
import { runTaskExecution } from '../src/agents/execute'
import {
  syncTaskStatusFromIssue, closeGitHubPrMirrorTasks, syncCiResultToTask, markApprovedTaskDoneFromGate, reverseTaskVerdict,
} from '../src/tasks/service'
import { persistGateWakeNotice } from '../src/gates/grants'
import { startTaskPipeline } from '../src/workflows/pipeline'
import type { Agent, AuthContext, BusEvent, CapabilityGrant, Env, Project } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

// ── 1. seam scan ─────────────────────────────────────────────────────────────

const SRC_DIR = join(__dirname, '..', 'src')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (name.endsWith('.ts')) out.push(full)
  }
  return out
}

interface TaskUpdateSite {
  file: string
  line: number
  statement: string
}

/** Statement text from `UPDATE tasks` to the closing backtick of its template literal,
 *  brace-aware so a nested `${ cond ? `...` : '' }` does not end it early. */
function statementFrom(src: string, start: number): string {
  let depth = 0
  for (let i = start; i < src.length; i += 1) {
    const c = src[i]
    if (c === '$' && src[i + 1] === '{') { depth += 1; i += 1; continue }
    if (c === '}' && depth > 0) { depth -= 1; continue }
    if (c === '`' && depth === 0) return src.slice(start, i)
  }
  return src.slice(start)
}

function findTaskUpdateSites(): TaskUpdateSite[] {
  const sites: TaskUpdateSite[] = []
  for (const full of walk(SRC_DIR)) {
    const file = relative(join(__dirname, '..'), full)
    // schema-chain.generated.ts embeds the migration SQL verbatim; migrations are DDL/backfill, not runtime writers.
    if (file.endsWith('schema-chain.generated.ts')) continue
    const src = readFileSync(full, 'utf8')
    const re = /\bUPDATE\s+(?:OR\s+\w+\s+)?tasks\b/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) {
      const lineStart = src.lastIndexOf('\n', m.index) + 1
      const before = src.slice(lineStart, m.index)
      const trimmed = before.trim()
      // comments and prose (a `//` or `*` line, or text inside a single-quoted string with no template open)
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
      if ((before.match(/'/g) ?? []).length % 2 === 1 && !before.includes('`')) continue
      sites.push({ file, line: src.slice(0, m.index).split('\n').length, statement: statementFrom(src, m.index) })
    }
  }
  return sites
}

/** Each exemption states WHY the writer may touch an archived row. `contains` pins the entry to
 *  one statement in the file so a NEW unguarded UPDATE in the same file still fails. */
const UNARCHIVED_UPDATE_ALLOWLIST: Array<{ file: string; contains: string; why: string }> = [
  {
    file: 'src/hygiene/archive.ts',
    contains: 'SET status = (SELECT prior_status FROM tasks_archive_state',
    why: 'unarchive restore: runs while the row is still archived, inside the same batch that deletes the state row',
  },
  {
    file: 'src/org/service.ts',
    contains: 'SET assignee_agent_id = NULL',
    why: 'hard-deleting an agent must clear every assignment (archived rows included) or the FK delete fails; it releases work, never starts it',
  },
  {
    file: 'src/tasks/runtime-receipts.ts',
    contains: 'SET execution_receipt_id = NULL, execution_claim_expires_at = NULL',
    why: 'operator lease-reset repair: clears a settled dispatch pointer (status <> in_progress); a release, and blocking it would strand the pointer on an archived row',
  },
  {
    file: 'src/tasks/service.ts',
    contains: 'SET github_issue_url = ?1 WHERE id = ?2 AND github_issue_url IS NULL',
    why: 'createTask link-back on the row inserted earlier in the same call; a brand-new task cannot be archived yet',
  },
  {
    file: 'src/flight-spine/assignments.ts',
    contains: 'SET assignment_epoch',
    why: 'advances the epoch of a task INSERTed in the same atomic materialization batch; a brand-new task cannot be archived yet',
  },
]

describe('every UPDATE tasks in src/ carries the archive guard or a justified exemption (seam scan)', () => {
  const sites = findTaskUpdateSites()

  it('finds the writers (anti-vacuity)', () => {
    expect(sites.length).toBeGreaterThan(30)
  })

  it('no unguarded, un-allowlisted UPDATE tasks', () => {
    const offenders = sites.filter((site) => {
      if (site.statement.includes('TASK_NOT_ARCHIVED_SQL(')) return false
      return !UNARCHIVED_UPDATE_ALLOWLIST.some((e) => e.file === site.file && site.statement.includes(e.contains))
    })
    expect(
      offenders.map((o) => `${o.file}:${o.line}  ${o.statement.replace(/\s+/g, ' ').slice(0, 90)}`),
    ).toEqual([])
  })

  it('every allowlist entry still matches exactly one live statement (no stale exemptions)', () => {
    for (const entry of UNARCHIVED_UPDATE_ALLOWLIST) {
      const matches = sites.filter((s) => s.file === entry.file && s.statement.includes(entry.contains))
      expect(matches.length, `stale allowlist entry: ${entry.file} ${entry.contains}`).toBe(1)
      expect(entry.why.length).toBeGreaterThan(20)
    }
  })

  it('an allowlisted statement never also needs the guard (entries do not hide guarded writers)', () => {
    for (const entry of UNARCHIVED_UPDATE_ALLOWLIST) {
      const s = sites.find((x) => x.file === entry.file && x.statement.includes(entry.contains))
      expect(s?.statement.includes('TASK_NOT_ARCHIVED_SQL(')).toBe(false)
    }
  })

  it('no other writer shapes bypass the scan (INSERT OR REPLACE INTO tasks / ON CONFLICT upserts)', () => {
    for (const full of walk(SRC_DIR)) {
      if (full.endsWith('schema-chain.generated.ts')) continue
      const src = readFileSync(full, 'utf8')
      expect(src, relative(SRC_DIR, full)).not.toMatch(/\bREPLACE\s+INTO\s+tasks\b/)
      expect(src, relative(SRC_DIR, full)).not.toMatch(/INSERT\s+INTO\s+tasks\b[^`]*ON\s+CONFLICT[^`]*DO\s+UPDATE/)
    }
  })

  it('the dispatch receipt INSERT is guarded in the same statement', () => {
    const src = readFileSync(join(SRC_DIR, 'mcp', 'index.ts'), 'utf8')
    const at = src.indexOf('INSERT INTO task_dispatch_receipts')
    expect(at).toBeGreaterThan(0)
    expect(statementFrom(src, at)).toContain('TASK_NOT_ARCHIVED_SQL(')
  })
})

// ── 2. behaviour on real SQLite ──────────────────────────────────────────────

const TENANT = 'tenant-1571'
const ORIGIN = 'https://pot.test'
const OPERATOR = 'member-operator'
const SQUAD = 'squad-1'
const WORKER = 'agent-worker'
const GATE_AGENT = 'agent-gate'
const T0 = '2026-10-07T00:00:00.000Z'

function adminAuth(opts: { boundAgentId?: string | null; capabilities?: CapabilityGrant[] } = {}): AuthContext {
  return {
    userId: 'operator-caller',
    email: 'operator@example.com',
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    memberId: OPERATOR,
    capabilities: opts.capabilities ?? [{ member_id: OPERATOR, scope_type: 'org', scope_id: null, capability: 'admin' }],
    boundAgentId: opts.boundAgentId ?? null,
  } as AuthContext
}

describe('archived = no action (real SQLite, full migration chain)', () => {
  let h: SqliteD1Harness
  let env: Env
  let events: BusEvent[]

  const invoke = (a: AuthContext, tool: string, args: Record<string, unknown>) => invokeTool(a, env, tool, args, ORIGIN)
  const row = (id: string) => h.sqlite.prepare('SELECT status, assignee_agent_id AS a, execution_receipt_id AS r FROM tasks WHERE id = ?').get(id) as {
    status: string; a: string | null; r: string | null
  }
  const archive = (id: string) => h.sqlite.prepare(
    `INSERT INTO tasks_archive_state (task_id, archived_at, archived_reason, archived_by_member_id, prior_status) VALUES (?, ?, 'test', ?, (SELECT status FROM tasks WHERE id = ?))`,
  ).run(id, T0, OPERATOR, id)

  beforeEach(() => {
    h = createSqliteD1()
    applyAllMigrations(h.sqlite)
    events = []
    env = {
      DB: h.db,
      TENANT_SLUG: TENANT,
      BUS: { send: async (e: BusEvent) => { events.push(e) } },
    } as unknown as Env
    h.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'd', 'D');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD}', 'dept-1', 'sq', 'Sq');
      INSERT INTO agents (id, squad_id, slug, name, status) VALUES
        ('${WORKER}', '${SQUAD}', 'worker', 'Worker', 'active'),
        ('${GATE_AGENT}', '${SQUAD}', 'gater', 'Gater', 'active');
      INSERT INTO members (id, tenant, email, display_name, status) VALUES ('${OPERATOR}', '${TENANT}', 'op@example.com', 'Op', 'active');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-op', '${OPERATOR}', 'org', NULL, 'admin');
      INSERT INTO presence (tenant, member_id, display_name, source, label, agent_id, first_seen_at, last_seen_at)
        VALUES ('${TENANT}', 'seat-w', 'W', 'test', 'seat-w', '${WORKER}', datetime('now'), datetime('now'));
    `)
  })
  afterEach(() => h.close())

  const grantHadiGate = () => h.sqlite.exec(
    `INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
       VALUES ('gg-hadi', 'gate:hadi', 'member', '${OPERATOR}', '${OPERATOR}', '${T0}')`,
  )

  function seedTask(id: string, status: string, extra: { assignee?: string | null; gate?: string | null; project?: string | null } = {}) {
    h.sqlite.prepare(
      `INSERT INTO tasks (id, squad_id, title, body, done_when, status, assignee_agent_id, gate_owner, project_id, created_at, updated_at)
       VALUES (?, ?, 't', 'b', 'done', ?, ?, ?, ?, ?, ?)`,
    ).run(id, SQUAD, status, extra.assignee ?? null, extra.gate ?? null, extra.project ?? null, T0, T0)
  }

  // ── router_tick ──
  it('router_tick does not assign an archived open task (dry run and real), and a live sibling still routes', async () => {
    seedTask('t-dead', 'open')
    seedTask('t-live', 'open')
    archive('t-dead')
    const decision = { ok: true as const, tenant: TENANT, squadId: SQUAD, agentId: null, source: 'principal' as const }
    const dry = await runRouterTick(env, decision, { squadId: SQUAD, dryRun: true }, { memberId: OPERATOR })
    expect(dry.decisions.map((d) => d.task_id)).toEqual(['t-live'])
    const real = await runRouterTick(env, decision, { squadId: SQUAD, dryRun: false }, { memberId: OPERATOR })
    expect(real.decisions.map((d) => `${d.task_id}:${d.outcome}`)).toEqual(['t-live:assigned'])
    expect(row('t-dead').a).toBeNull()
    expect(row('t-live').a).toBe(WORKER)
  })

  it('router_tick claim UPDATE alone refuses a task archived AFTER the scan (lost_claim, no wake)', async () => {
    seedTask('t-race', 'open')
    const decision = { ok: true as const, tenant: TENANT, squadId: SQUAD, agentId: null, source: 'principal' as const }
    // Archive lands between the candidate SELECT and the claim UPDATE: a bus emit is the only seam, so
    // archive from the presence read the engine does after scanning.
    const realPrepare = h.db.prepare.bind(h.db)
    let armed = true
    h.db.prepare = ((sql: string) => {
      if (armed && sql.includes('SELECT DISTINCT a.id')) {
        armed = false
        archive('t-race')
      }
      return realPrepare(sql)
    }) as typeof h.db.prepare
    const result = await runRouterTick(env, decision, { squadId: SQUAD, dryRun: false }, { memberId: OPERATOR })
    expect(result.decisions.map((d) => d.outcome)).toEqual(['lost_claim'])
    expect(row('t-race').a).toBeNull()
    expect(events).toHaveLength(0)
  })

  // ── concierge cron ──
  it('the concierge cron (routeUnassignedWork) does not route an archived task and is not head-of-line blocked by it', async () => {
    const project: Project = {
      id: 'proj-c', slug: 'proj-c', name: 'C', description: '', goal: 'Ship it', status: 'active',
      parent_project_id: null, target_date: null, created_at: T0, updated_at: T0,
    }
    h.sqlite.exec(`
      INSERT INTO projects (id, slug, name, description, goal, status) VALUES ('proj-c', 'proj-c', 'C', '', 'Ship it', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('proj-c', '${SQUAD}', 'write');
    `)
    // Archived row sorts FIRST (oldest) so a SELECT that ignored archive would pick it first.
    h.sqlite.prepare(
      `INSERT INTO tasks (id, squad_id, project_id, title, done_when, status, created_at, updated_at)
       VALUES ('c-dead', ?, 'proj-c', 'Old archived work', 'done', 'open', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`,
    ).run(SQUAD)
    h.sqlite.prepare(
      `INSERT INTO tasks (id, squad_id, project_id, title, done_when, status, created_at, updated_at)
       VALUES ('c-live', ?, 'proj-c', 'Live work', 'done', 'open', '2021-01-01T00:00:00.000Z', '2021-01-01T00:00:00.000Z')`,
    ).run(SQUAD)
    archive('c-dead')
    const reg = await registerModule(env, {
      identity: WORKER, kind: 'agent_system', adapter: 'cursor', projectId: null, capabilities: [BUILD_CAPABILITY],
    })
    expect(reg.ok).toBe(true)
    void conciergeIdentity
    const result = await runProjectConcierge(env, project)
    expect(result.decision).toEqual({ action: 'route', routed: 1 })
    expect(row('c-dead').a).toBeNull()
    expect(row('c-live').a).toBe(WORKER)
  })

  // ── task_update ──
  it('task_update refuses a status change on an archived task with 409 task_archived and writes nothing', async () => {
    seedTask('u-dead', 'open', { assignee: WORKER })
    archive('u-dead')
    const before = h.sqlite.prepare('SELECT status, updated_at FROM tasks WHERE id = ?').get('u-dead')
    const result = await invoke(adminAuth(), 'task_update', { task_id: 'u-dead', status: 'in_progress' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    expect(result.error).toBe('task_archived')
    expect(h.sqlite.prepare('SELECT status, updated_at FROM tasks WHERE id = ?').get('u-dead')).toEqual(before)
  })

  it('task_update still works on a live task (the guard is not a blanket refusal)', async () => {
    seedTask('u-live', 'open', { assignee: WORKER })
    const result = await invoke(adminAuth(), 'task_update', { task_id: 'u-live', status: 'in_progress' })
    expect(result.ok).toBe(true)
    expect(row('u-live').status).toBe('in_progress')
  })

  // ── task_verdict ──
  it('task_verdict refuses an archived task in review with 409 task_archived and records no verdict', async () => {
    seedTask('v-dead', 'review', { assignee: WORKER, gate: 'gate:hadi' })
    grantHadiGate()
    archive('v-dead')
    const result = await invoke(adminAuth(), 'task_verdict', { task_id: 'v-dead', verdict: 'approved' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    expect(result.error).toBe('task_archived')
    expect(row('v-dead').status).toBe('review')
    expect(h.sqlite.prepare('SELECT COUNT(*) AS n FROM task_verdicts WHERE task_id = ?').get('v-dead')).toEqual({ n: 0 })
  })

  it('task_verdict still records a verdict on a live review task', async () => {
    seedTask('v-live', 'review', { assignee: WORKER, gate: 'gate:hadi' })
    grantHadiGate()
    const result = await invoke(adminAuth(), 'task_verdict', { task_id: 'v-live', verdict: 'approved' })
    expect(result.ok).toBe(true)
    expect(row('v-live').status).toBe('approved')
  })

  // ── task_dispatch ──
  it('task_dispatch refuses an archived task and mints no dispatch receipt', async () => {
    seedTask('d-dead', 'open', { assignee: WORKER })
    archive('d-dead')
    const result = await invoke(adminAuth(), 'task_dispatch', { task_id: 'd-dead' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('task_archived')
    expect(h.sqlite.prepare('SELECT COUNT(*) AS n FROM task_dispatch_receipts WHERE task_id = ?').get('d-dead')).toEqual({ n: 0 })
  })

  // ── task_submit_result ──
  it('task_submit_result refuses an archived in_progress task (named error, status unchanged)', async () => {
    seedTask('s-dead', 'in_progress', { assignee: WORKER, gate: 'gate:gater' })
    archive('s-dead')
    const agentAuth = adminAuth({
      boundAgentId: WORKER,
      capabilities: [{ member_id: OPERATOR, scope_type: 'squad', scope_id: SQUAD, capability: 'member' }],
    })
    const result = await invoke(agentAuth, 'task_submit_result', {
      task_id: 's-dead', result: 'Artifact: out.md\nSHA256: ' + 'a'.repeat(64),
    })
    expect(result.ok).toBe(false)
    expect(row('s-dead').status).toBe('in_progress')
  })

  // ── flight_dispatch ──
  it('flight_dispatch with an archived task id is refused 409 task_archived and creates no flight', async () => {
    seedTask('f-dead', 'open', { assignee: WORKER })
    archive('f-dead')
    const agentAuth = adminAuth({
      boundAgentId: WORKER,
      capabilities: [{ member_id: OPERATOR, scope_type: 'squad', scope_id: SQUAD, capability: 'lead' }],
    })
    const meta = {
      schema: 'mupot.flight.meta/v1', goal_id: 'g', objective_id: 'o', squad_ids: [SQUAD], task_ids: ['f-dead'],
      done_when: ['x'], artifact_refs: [], receipt_refs: [], confidentiality: 'internal', publication_target: 'none', parent_flight_id: null,
    }
    const signals = {
      contextComplete: true, toolsReachable: true, budgetRemainingMicroUsd: 999_000_000, budgetEstimateMicroUsd: 1,
      recentProgress: 0.9, progressPerStep: 0.8, wastePerStep: 0.1, stepSeconds: 10,
    }
    const result = await invoke(agentAuth, 'flight_dispatch', {
      squad_id: SQUAD, goal: 'g', meta_json: JSON.stringify(meta), signals_json: JSON.stringify(signals), budget_micro_usd: 1000,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    expect(result.error).toBe('task_archived')
    expect(h.sqlite.prepare('SELECT COUNT(*) AS n FROM flights').get()).toEqual({ n: 0 })
  })

  // ── runtime receipts ──
  describe('task_dispatch_runtime_receipt path', () => {
    const DISPATCH = 'dispatch-1'
    const MESSAGE = 'message-1'
    const MEMBER = 'member-rt'
    const TOKEN = 'token-rt'
    const GATE_MEMBER = 'member-gate'

    function seedRuntime(taskId: string) {
      h.sqlite.exec(`
        INSERT INTO members (id, display_name, status, tenant) VALUES ('${MEMBER}', 'RT', 'active', '${TENANT}'), ('${GATE_MEMBER}', 'G', 'active', '${TENANT}');
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
          ('cap-rt', '${MEMBER}', 'squad', '${SQUAD}', 'member'), ('cap-g', '${GATE_MEMBER}', 'squad', '${SQUAD}', 'member');
        INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES
          ('${TENANT}', '${WORKER}', '${MEMBER}', '${T0}'), ('${TENANT}', '${GATE_AGENT}', '${GATE_MEMBER}', '${T0}');
        INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, revoked_at, agent_id, tenant, expires_at) VALUES
          ('${TOKEN}', '${MEMBER}', 'hash-rt', 'rt', 'workspace', '${T0}', NULL, '${WORKER}', '${TENANT}', '2099-01-01T00:00:00.000Z'),
          ('tok-g', '${GATE_MEMBER}', 'hash-g', 'g', 'workspace', '${T0}', NULL, '${GATE_AGENT}', '${TENANT}', '2099-01-01T00:00:00.000Z');
        INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
          VALUES ('gg-1', 'gate:gater', 'agent', '${GATE_AGENT}', '${MEMBER}', '${T0}');
        INSERT INTO task_dispatch_receipts (id, tenant, task_id, squad_id, agent_id, actor_kind, actor_id, created_at, claimed_at, consumed_at, attempts)
          VALUES ('${DISPATCH}', '${TENANT}', '${taskId}', '${SQUAD}', '${WORKER}', 'member', '${MEMBER}', '${T0}', '${T0}', '${T0}', 1);
        INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, kind, body, request_id, created_at, delivery_attempts, lease_expires_at)
          VALUES ('${MESSAGE}', '${TENANT}', 'worker', 'mupot-dispatch', '${MEMBER}', 'request',
            '{"version":"runtime.dispatch/v1","type":"task_dispatch","task_id":"${taskId}","dispatch_receipt_id":"${DISPATCH}","squad_id":"${SQUAD}","runtime_address":"worker"}',
            'dispatch-inbox:${DISPATCH}', '${T0}', 1, '2099-01-01T00:00:00.000Z');
      `)
    }
    const rtAuth = (): AuthContext => ({
      userId: MEMBER, tenant: TENANT, channel: 'workspace', role: 'member', memberId: MEMBER, tokenId: TOKEN,
      boundAgentId: WORKER,
      capabilities: [{ member_id: MEMBER, scope_type: 'squad', scope_id: SQUAD, capability: 'member' }],
    }) as AuthContext
    const receipt = {
      taskId: 'r-task', dispatchReceiptId: DISPATCH, messageId: MESSAGE, stage: 'runtime_consumed' as const,
      runtimeReceiptHash: 'a'.repeat(64), attempt: 1,
    }

    it('control: a live task is claimed in_progress by runtime_consumed', async () => {
      seedTask('r-task', 'open', { assignee: WORKER, gate: 'gate:gater' })
      seedRuntime('r-task')
      const out = await recordTaskDispatchRuntimeReceipt(env, rtAuth(), receipt)
      expect(out.task_status).toBe('in_progress')
    })

    it('runtime_consumed refuses an archived task with a named error and writes no receipt', async () => {
      seedTask('r-task', 'open', { assignee: WORKER, gate: 'gate:gater' })
      seedRuntime('r-task')
      archive('r-task')
      await expect(recordTaskDispatchRuntimeReceipt(env, rtAuth(), receipt)).rejects.toMatchObject({ code: 'task_archived' })
      expect(row('r-task')).toMatchObject({ status: 'open', r: null })
      expect(h.sqlite.prepare('SELECT COUNT(*) AS n FROM task_dispatch_runtime_receipts').get()).toEqual({ n: 0 })
    })

    it('a task archived after being consumed cannot be completed (completed refused, stays in_progress)', async () => {
      seedTask('r-task', 'open', { assignee: WORKER, gate: 'gate:gater' })
      seedRuntime('r-task')
      await recordTaskDispatchRuntimeReceipt(env, rtAuth(), receipt)
      // simulate the claim lapsing so the archive is legal, then archive
      h.sqlite.exec(`UPDATE tasks SET execution_claim_expires_at = NULL WHERE id = 'r-task'`)
      archive('r-task')
      await expect(recordTaskDispatchRuntimeReceipt(env, rtAuth(), {
        ...receipt, stage: 'completed', result: 'Artifact: out.md\nSHA256: ' + 'b'.repeat(64), artifactRefs: ['out.md'], artifactSha256: 'b'.repeat(64),
      })).rejects.toBeInstanceOf(TaskDispatchRuntimeReceiptError)
      expect(row('r-task').status).toBe('in_progress')
    })

    it('the MCP tool maps the refusal to 409 task_archived', async () => {
      seedTask('r-task', 'open', { assignee: WORKER, gate: 'gate:gater' })
      seedRuntime('r-task')
      archive('r-task')
      const result = await invoke(rtAuth(), 'task_dispatch_runtime_receipt', {
        task_id: 'r-task', dispatch_receipt_id: DISPATCH, message_id: MESSAGE, stage: 'runtime_consumed',
        runtime_receipt_hash: 'a'.repeat(64), attempt: 1,
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.status).toBe(409)
      expect(result.error).toBe('task_archived')
    })
  })


  // ── flight_dispatch control: the same call on a LIVE task succeeds, so the refusal above is the archive ──
  it('flight_dispatch control: the identical dispatch with a live task id creates a flight', async () => {
    seedTask('f-live', 'open', { assignee: WORKER })
    const agentAuth = adminAuth({
      boundAgentId: WORKER,
      capabilities: [{ member_id: OPERATOR, scope_type: 'squad', scope_id: SQUAD, capability: 'lead' }],
    })
    const meta = {
      schema: 'mupot.flight.meta/v1', goal_id: 'g', objective_id: 'o', squad_ids: [SQUAD], task_ids: ['f-live'],
      done_when: ['x'], artifact_refs: [], receipt_refs: [], confidentiality: 'internal', publication_target: 'none', parent_flight_id: null,
    }
    const signals = {
      contextComplete: true, toolsReachable: true, budgetRemainingMicroUsd: 999_000_000, budgetEstimateMicroUsd: 1,
      recentProgress: 0.9, progressPerStep: 0.8, wastePerStep: 0.1, stepSeconds: 10,
    }
    const result = await invoke(agentAuth, 'flight_dispatch', {
      squad_id: SQUAD, goal: 'g', meta_json: JSON.stringify(meta), signals_json: JSON.stringify(signals), budget_micro_usd: 1000,
    })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(h.sqlite.prepare('SELECT COUNT(*) AS n FROM flights').get()).toEqual({ n: 1 })
  })

  // ── GitHub sync writers (webhook-driven, no human in the loop) ──
  it('GitHub issue/PR/CI sync writers do not move an archived task', async () => {
    seedTask('g-open', 'open')
    seedTask('g-done', 'done')
    seedTask('g-review', 'review')
    h.sqlite.exec(`UPDATE tasks SET github_issue_url = 'https://github.com/o/r/issues/1' WHERE id IN ('g-open','g-done')`)
    h.sqlite.exec(`UPDATE tasks SET github_issue_url = 'https://github.com/o/r/pull/7', gate_owner = 'gate:x' WHERE id = 'g-review'`)
    h.sqlite.exec(`UPDATE tasks SET title = '[GH o/r] PR #9 closed: x', status = 'open' WHERE id = 'g-open'`)
    archive('g-open'); archive('g-done'); archive('g-review')
    expect(await syncTaskStatusFromIssue(env, 'https://github.com/o/r/issues/1', 'closed')).toEqual({ updated: false })
    expect(await syncTaskStatusFromIssue(env, 'https://github.com/o/r/issues/1', 'reopened')).toEqual({ updated: false })
    expect(await closeGitHubPrMirrorTasks(env, 'o/r', 9)).toEqual({ closed: 0 })
    expect(await syncCiResultToTask(env, 7, 'failure')).toEqual({ updated: false })
    expect(['g-open', 'g-done', 'g-review'].map((id) => row(id).status)).toEqual(['open', 'done', 'review'])
  })

  it('GitHub sync writers still move a LIVE task (control)', async () => {
    seedTask('g-live', 'open')
    h.sqlite.exec(`UPDATE tasks SET github_issue_url = 'https://github.com/o/r/issues/2' WHERE id = 'g-live'`)
    expect(await syncTaskStatusFromIssue(env, 'https://github.com/o/r/issues/2', 'closed')).toEqual({ updated: true })
    expect(row('g-live').status).toBe('done')
  })

  // ── verdict-adjacent writers ──
  it('markApprovedTaskDoneFromGate does not close an archived approved task', async () => {
    seedTask('m-dead', 'approved', { gate: 'gate:hadi' })
    archive('m-dead')
    expect(await markApprovedTaskDoneFromGate(env, 'm-dead', 'receipt', T0)).toBe('none')
    expect(row('m-dead').status).toBe('approved')
  })

  it('verdict reversal on an archived task is refused before any gate-closing write', async () => {
    seedTask('x-dead', 'approved', { gate: 'gate:hadi' })
    archive('x-dead')
    const existing = h.sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get('x-dead') as never
    const out = await reverseTaskVerdict(env, {
      existing, next: { ...(existing as object), status: 'review' } as never, tenant: TENANT, reason: 'r', actorId: OPERATOR, actorType: 'member',
    })
    expect(out).toEqual({ ok: false, error: 'task_archived' })
  })

  // ── notice + workflow starters ──
  it('persistGateWakeNotice does not write onto an archived task', async () => {
    seedTask('n-dead', 'review', { gate: 'gate:hadi' })
    archive('n-dead')
    await persistGateWakeNotice(env, 'n-dead', 'wake')
    expect(h.sqlite.prepare('SELECT gate_wake_notice AS n FROM tasks WHERE id = ?').get('n-dead')).toEqual({ n: null })
  })

  it('startTaskPipeline refuses an archived task before creating a Workflow instance', async () => {
    seedTask('p-dead', 'open', { assignee: WORKER })
    archive('p-dead')
    const create = vi.fn(async () => ({ id: 'wf-1' }))
    const wfEnv = { ...env, TASK_WORKFLOW: { create } } as unknown as Env
    await expect(startTaskPipeline(wfEnv, 'p-dead', SQUAD)).rejects.toMatchObject({ code: 'task_archived' })
    expect(create).not.toHaveBeenCalled()
  })

  // ── executor claim ──
  it('the executor claim (agents/execute.ts) refuses an archived task as task_archived', async () => {
    seedTask('e-dead', 'open', { assignee: WORKER })
    archive('e-dead')
    const model = { chat: vi.fn(async () => ({ content: 'x', usage: { prompt_tokens: 1, completion_tokens: 1 } })) }
    const agent = h.sqlite.prepare('SELECT * FROM agents WHERE id = ?').get(WORKER) as unknown as Agent
    const result = await runTaskExecution(env, agent, 'e-dead', { model: model as never })
    expect(result).toMatchObject({ ok: false, error: 'task_archived' })
    expect(model.chat).not.toHaveBeenCalled()
    expect(row('e-dead')).toMatchObject({ status: 'open', a: WORKER, r: null })
  })
})
