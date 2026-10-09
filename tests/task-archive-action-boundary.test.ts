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
import { runApprovedActs, createOutboundAct } from '../src/integrations/ghl'
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

/** Every string / template literal in a TS source, as raw text (outermost template only, nested
 *  `${ ... }` included), with the offset it starts at. A real small lexer: comments are skipped, quotes
 *  inside comments/regex/other literals cannot open a literal, and anything that is not provably inside
 *  a literal is NOT scanned as SQL. Throws if the file ends mid-token so a mis-lex cannot pass silently. */
function stringLiterals(src: string): Array<{ text: string; start: number }> {
  const out: Array<{ text: string; start: number }> = []
  let i = 0
  const n = src.length
  const skipTemplate = (from: number): number => {
    // from points just after the opening backtick; returns index just after the closing backtick
    let j = from
    while (j < n) {
      const c = src[j]
      if (c === '\\') { j += 2; continue }
      if (c === '`') return j + 1
      if (c === '$' && src[j + 1] === '{') { j = skipBraces(j + 2); continue }
      j += 1
    }
    throw new Error('unterminated template literal')
  }
  const skipQuoted = (from: number, q: string): number => {
    let j = from
    while (j < n) {
      const c = src[j]
      if (c === '\\') { j += 2; continue }
      if (c === q) return j + 1
      if (c === '\n') throw new Error('unterminated string literal')
      j += 1
    }
    throw new Error('unterminated string literal')
  }
  // inside a template ${ ... }: code context, so nested literals/comments are lexed properly
  const skipBraces = (from: number): number => {
    let j = from
    let depth = 1
    while (j < n) {
      const c = src[j]
      if (c === '{') { depth += 1; j += 1; continue }
      if (c === '}') { depth -= 1; j += 1; if (depth === 0) return j; continue }
      j = stepCode(j)
    }
    throw new Error('unterminated ${')
  }
  let prevSignificant = ''
  const stepCode = (j: number): number => {
    const c = src[j]
    const d = src[j + 1]
    if (c === '/' && d === '/') { const e = src.indexOf('\n', j); return e === -1 ? n : e }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', j + 2); if (e === -1) throw new Error('unterminated comment'); return e + 2 }
    if (c === '"' || c === "'") { const e = skipQuoted(j + 1, c); prevSignificant = 'x'; return e }
    if (c === '`') { const e = skipTemplate(j + 1); prevSignificant = 'x'; return e }
    if (c === '/' && (prevSignificant === '' || '(,=:[!&|?{};'.includes(prevSignificant))) {
      // regex literal: scan to the closing slash, honouring escapes and [...] classes
      let k = j + 1
      let inClass = false
      while (k < n) {
        const ch = src[k]
        if (ch === '\\') { k += 2; continue }
        if (ch === '\n') throw new Error('unterminated regex at line ' + src.slice(0, j).split('\n').length)
        if (ch === '[') inClass = true
        else if (ch === ']') inClass = false
        else if (ch === '/' && !inClass) break
        k += 1
      }
      prevSignificant = 'x'
      return k + 1
    }
    if (/[A-Za-z_$]/.test(c)) {
      let k = j + 1
      while (k < n && /[A-Za-z0-9_$]/.test(src[k])) k += 1
      // a keyword that can precede an expression makes a following `/` a regex, not a division
      prevSignificant = ['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do'].includes(src.slice(j, k)) ? '(' : 'x'
      return k
    }
    if (!/\s/.test(c)) prevSignificant = c
    return j + 1
  }
  while (i < n) {
    const c = src[i]
    if (c === '"' || c === "'") {
      const e = skipQuoted(i + 1, c)
      out.push({ text: src.slice(i, e), start: i })
      prevSignificant = 'x'
      i = e
    } else if (c === '`') {
      const e = skipTemplate(i + 1)
      out.push({ text: src.slice(i, e), start: i })
      prevSignificant = 'x'
      i = e
    } else {
      i = stepCode(i)
    }
  }
  return out
}

/** Writers of `tasks` found in a source text: `UPDATE [OR x] tasks`, case-insensitive, inside a literal only. Each site's
 *  statement runs from the match to the next `UPDATE tasks` match or the end of its literal. */
export function findTaskUpdateSitesIn(src: string, file: string): TaskUpdateSite[] {
  const sites: TaskUpdateSite[] = []
  for (const lit of stringLiterals(src)) {
    // `SET` is required: it separates a statement from prose such as tool-annotations' "UPDATE tasks (service.ts:540)".
    const re = /\bUPDATE\s+(?:OR\s+\w+\s+)?"?tasks"?\s+SET\b/gi
    const matches = [...lit.text.matchAll(re)]
    matches.forEach((m, idx) => {
      const from = m.index ?? 0
      const to = idx + 1 < matches.length ? (matches[idx + 1].index ?? lit.text.length) : lit.text.length
      sites.push({
        file,
        line: src.slice(0, lit.start + from).split('\n').length,
        statement: lit.text.slice(from, to),
      })
    })
  }
  return sites
}

/** Claim statements on TASK-KEYED tables that precede an external effect. They are not `UPDATE tasks`, so the scan
 *  above cannot see them; each must carry the task archive guard in its own WHERE. A general "every claim table" scan
 *  is deliberately not attempted (no reliable marker for what is a claim); these are the ones that gate an outbound
 *  effect today, found by enumerating the effect sites (see the PR body). */
const EFFECT_CLAIMS: Array<{ file: string; marker: RegExp; effect: string }> = [
  { file: 'src/addons/office/service.ts', marker: /UPDATE\s+office_publish_freezes\s+SET\s+claimed_by/i, effect: 'WordPress publish' },
  { file: 'src/integrations/ghl.ts', marker: /UPDATE\s+outbound_acts\s+SET\s+status\s*=\s*'sending'/i, effect: 'GHL send' },
]

function findTaskUpdateSites(): TaskUpdateSite[] {
  const sites: TaskUpdateSite[] = []
  for (const full of walk(SRC_DIR)) {
    const file = relative(join(__dirname, '..'), full)
    // schema-chain.generated.ts embeds the migration SQL verbatim; migrations are DDL/backfill, not runtime writers.
    if (file.endsWith('schema-chain.generated.ts')) continue
    try {
      sites.push(...findTaskUpdateSitesIn(readFileSync(full, 'utf8'), file))
    } catch (error) {
      throw new Error(`seam scanner could not lex ${file}: ${error instanceof Error ? error.message : String(error)}`)
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

  it('the scanner itself: a single-quoted or lowercase UPDATE tasks is flagged; comments and prose are not', () => {
    const probe = [
      "env.DB.prepare('UPDATE tasks SET status = ? WHERE id = ?')",
      'db.prepare("update tasks set status = 1")',
      'db.prepare(`UPDATE\n   tasks SET x = 1`)',
    ].join('\n')
    expect(findTaskUpdateSitesIn(probe, 'probe.ts')).toHaveLength(3)
    const quiet = [
      '// UPDATE tasks SET status',
      '/* UPDATE tasks SET status */',
      "const msg = 'create or update the board'",
      "const note = 'UPDATE tasks (service.ts:540) + gate INSERT'",
      "const re = /[`'\"]UPDATE/",
    ].join('\n')
    expect(findTaskUpdateSitesIn(quiet, 'quiet.ts')).toEqual([])
    // and a guarded one is not an offender
    expect(findTaskUpdateSitesIn("db.prepare(`UPDATE tasks SET a = 1 WHERE ${TASK_NOT_ARCHIVED_SQL()}`)", 'g.ts')[0].statement)
      .toContain('TASK_NOT_ARCHIVED_SQL(')
  })

  it('claims on task-keyed tables that precede an external effect carry the archive guard', () => {
    for (const claim of EFFECT_CLAIMS) {
      const src = readFileSync(join(__dirname, '..', claim.file), 'utf8')
      const lits = stringLiterals(src).filter((l) => claim.marker.test(l.text))
      expect(lits.length, `${claim.effect}: claim statement not found in ${claim.file}`).toBeGreaterThan(0)
      for (const lit of lits) expect(lit.text, `${claim.effect} claim is unguarded`).toContain('TASK_NOT_ARCHIVED_SQL(')
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
    const lits = stringLiterals(src).filter((l) => l.text.includes('INSERT INTO task_dispatch_receipts'))
    expect(lits.length).toBe(1)
    expect(lits[0].text).toContain('TASK_NOT_ARCHIVED_SQL(')
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
      // mupot#1778: task archiving is opt-in (TASK_ARCHIVE_ENABLED); this suite exercises it.
      TASK_ARCHIVE_ENABLED: '1',
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

  /** Archive `taskId` the instant a statement matching `fragment` is prepared: the pre-read has
   *  already passed, so only the writer's OWN WHERE can still refuse. This is what proves the SQL
   *  guard is load-bearing rather than redundant behind a pre-check. */
  function archiveWhenPrepared(fragment: string, taskId: string) {
    const realPrepare = h.db.prepare.bind(h.db)
    let armed = true
    h.db.prepare = ((sql: string) => {
      if (armed && sql.includes(fragment)) {
        armed = false
        archive(taskId)
      }
      return realPrepare(sql)
    }) as typeof h.db.prepare
  }

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
    // MAX_ROUTES_PER_TICK (5) archived rows sort FIRST (oldest): a SELECT that ignored archive would
    // fill its whole LIMIT window with them and starve the live task behind (head-of-line stall).
    for (let i = 0; i < 5; i += 1) {
      h.sqlite.prepare(
        `INSERT INTO tasks (id, squad_id, project_id, title, done_when, status, created_at, updated_at)
         VALUES (?, ?, 'proj-c', 'Old archived work', 'done', 'open', ?, ?)`,
      ).run(`c-dead-${i}`, SQUAD, `2020-01-0${i + 1}T00:00:00.000Z`, `2020-01-0${i + 1}T00:00:00.000Z`)
      archive(`c-dead-${i}`)
    }
    h.sqlite.prepare(
      `INSERT INTO tasks (id, squad_id, project_id, title, done_when, status, created_at, updated_at)
       VALUES ('c-live', ?, 'proj-c', 'Live work', 'done', 'open', '2021-01-01T00:00:00.000Z', '2021-01-01T00:00:00.000Z')`,
    ).run(SQUAD)
    const reg = await registerModule(env, {
      identity: WORKER, kind: 'agent_system', adapter: 'cursor', projectId: null, capabilities: [BUILD_CAPABILITY],
    })
    expect(reg.ok).toBe(true)
    void conciergeIdentity
    const result = await runProjectConcierge(env, project)
    expect(result.decision).toEqual({ action: 'route', routed: 1 })
    for (let i = 0; i < 5; i += 1) expect(row(`c-dead-${i}`).a).toBeNull()
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
  function seedSubmitFixture(taskId: string) {
    h.sqlite.exec(`
      INSERT INTO members (id, display_name, status, tenant) VALUES ('member-gate', 'G', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-g', 'member-gate', 'squad', '${SQUAD}', 'member');
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', '${GATE_AGENT}', 'member-gate', '${T0}');
      INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, revoked_at, agent_id, tenant, expires_at)
        VALUES ('tok-g', 'member-gate', 'hash-g', 'g', 'workspace', '${T0}', NULL, '${GATE_AGENT}', '${TENANT}', '2099-01-01T00:00:00.000Z');
      INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
        VALUES ('gg-1', 'gate:gater', 'agent', '${GATE_AGENT}', '${OPERATOR}', '${T0}');
    `)
    seedTask(taskId, 'in_progress', { assignee: WORKER, gate: 'gate:gater' })
  }
  const submitAuth = () => adminAuth({
    boundAgentId: WORKER,
    capabilities: [{ member_id: OPERATOR, scope_type: 'squad', scope_id: SQUAD, capability: 'member' }],
  })
  const submitArgs = (taskId: string) => ({ task_id: taskId, result: `Artifact: out.md\nSHA256: ${'a'.repeat(64)}` })

  it('task_submit_result control: a live in_progress task moves to review', async () => {
    seedSubmitFixture('s-live')
    const result = await invoke(submitAuth(), 'task_submit_result', submitArgs('s-live'))
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(row('s-live').status).toBe('review')
  })

  it('task_submit_result refuses an archived in_progress task as 409 task_archived (status unchanged)', async () => {
    seedSubmitFixture('s-dead')
    archive('s-dead')
    const result = await invoke(submitAuth(), 'task_submit_result', submitArgs('s-dead'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    expect(result.error).toBe('task_archived')
    expect(row('s-dead').status).toBe('in_progress')
    expect(h.sqlite.prepare('SELECT COUNT(*) AS n FROM task_result_submissions WHERE task_id = ?').get('s-dead')).toEqual({ n: 0 })
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


    it('RACE runtime_consumed: archived between the pre-check and the batch -> no claim, no receipt row', async () => {
      seedTask('r-task', 'open', { assignee: WORKER, gate: 'gate:gater' })
      seedRuntime('r-task')
      archiveWhenPrepared("SET status = 'in_progress', execution_receipt_id", 'r-task')
      await expect(recordTaskDispatchRuntimeReceipt(env, rtAuth(), receipt)).rejects.toBeInstanceOf(TaskDispatchRuntimeReceiptError)
      expect(row('r-task')).toMatchObject({ status: 'open', r: null })
      expect(h.sqlite.prepare('SELECT COUNT(*) AS n FROM task_dispatch_runtime_receipts').get()).toEqual({ n: 0 })
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


  // ── race proofs: archive lands AFTER the pre-read, so only the writer's own WHERE can refuse ──
  it('RACE task_verdict: archived between the pre-check and the verdict batch -> task_archived, no verdict row', async () => {
    seedTask('rv', 'review', { assignee: WORKER, gate: 'gate:hadi' })
    grantHadiGate()
    archiveWhenPrepared('UPDATE tasks SET status = ?, updated_at = ?', 'rv')
    const result = await invoke(adminAuth(), 'task_verdict', { task_id: 'rv', verdict: 'approved' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('task_archived')
    expect(row('rv').status).toBe('review')
    expect(h.sqlite.prepare('SELECT COUNT(*) AS n FROM task_verdicts WHERE task_id = ?').get('rv')).toEqual({ n: 0 })
  })

  it('RACE task_dispatch: archived between the pre-read and the receipt INSERT -> task_archived, no receipt', async () => {
    seedTask('rd', 'open', { assignee: WORKER })
    archiveWhenPrepared('INSERT INTO task_dispatch_receipts', 'rd')
    const result = await invoke(adminAuth(), 'task_dispatch', { task_id: 'rd' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('task_archived')
    expect(h.sqlite.prepare('SELECT COUNT(*) AS n FROM task_dispatch_receipts WHERE task_id = ?').get('rd')).toEqual({ n: 0 })
  })

  it('RACE startTaskPipeline: archived after the instance was created -> instance id is NOT linked onto the archived task', async () => {
    seedTask('rp', 'open', { assignee: WORKER })
    archiveWhenPrepared('UPDATE tasks SET workflow_instance_id', 'rp')
    const wfEnv = { ...env, TASK_WORKFLOW: { create: async () => ({ id: 'wf-1' }) } } as unknown as Env
    await startTaskPipeline(wfEnv, 'rp', SQUAD)
    expect(h.sqlite.prepare('SELECT workflow_instance_id AS w FROM tasks WHERE id = ?').get('rp')).toEqual({ w: null })
  })


  // ── archive_row(tasks) write-time re-assertion: the state changes AFTER the pre-read ──
  describe('archive_row(tasks) re-asserts its preconditions inside the write', () => {
    const archiveRow = () => invoke(adminAuth(), 'archive_row', { table: 'tasks', id: 'w-task', reason: 'x', expected_status: 'open' })
    const hookBeforeArchiveWrite = (mutate: () => void) => {
      const realPrepare = h.db.prepare.bind(h.db)
      let armed = true
      h.db.prepare = ((sql: string) => {
        if (armed && sql.includes('INSERT OR IGNORE INTO tasks_archive_state')) { armed = false; mutate() }
        return realPrepare(sql)
      }) as typeof h.db.prepare
    }

    it('plan drift: status changed after the pre-read -> status_drift, nothing archived', async () => {
      seedTask('w-task', 'open')
      hookBeforeArchiveWrite(() => h.sqlite.exec(`UPDATE tasks SET status = 'blocked' WHERE id = 'w-task'`))
      const result = await archiveRow()
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toBe('status_drift')
      expect(h.sqlite.prepare('SELECT COUNT(*) AS n FROM tasks_archive_state').get()).toEqual({ n: 0 })
    })

    it('live claim appeared after the pre-read -> live_execution_claim, nothing archived', async () => {
      seedTask('w-task', 'open')
      h.sqlite.exec(`UPDATE tasks SET status = 'in_progress' WHERE id = 'w-task'`)
      hookBeforeArchiveWrite(() => h.sqlite.exec(`UPDATE tasks SET execution_claim_expires_at = ${Date.now() + 600_000} WHERE id = 'w-task'`))
      const result = await invoke(adminAuth(), 'archive_row', { table: 'tasks', id: 'w-task', reason: 'x' })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toBe('live_execution_claim')
      expect(h.sqlite.prepare('SELECT COUNT(*) AS n FROM tasks_archive_state').get()).toEqual({ n: 0 })
    })

    it('flight took the task after the pre-read -> in_air_flight, nothing archived', async () => {
      seedTask('w-task', 'open')
      hookBeforeArchiveWrite(() => h.sqlite.exec(
        `INSERT INTO flights (id, tenant, agent, goal, status, meta)
         VALUES ('fl-1', '${TENANT}', '${WORKER}', 'g', 'running', '{"task_ids":["w-task"]}')`,
      ))
      const result = await invoke(adminAuth(), 'archive_row', { table: 'tasks', id: 'w-task', reason: 'x' })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toBe('in_air_flight')
      expect(h.sqlite.prepare('SELECT COUNT(*) AS n FROM tasks_archive_state').get()).toEqual({ n: 0 })
    })

    it('idempotent: a second archive of the same task is already_archived with ONE receipt', async () => {
      seedTask('w-task', 'open')
      expect((await invoke(adminAuth(), 'archive_row', { table: 'tasks', id: 'w-task', reason: 'x' })).ok).toBe(true)
      const again = await invoke(adminAuth(), 'archive_row', { table: 'tasks', id: 'w-task', reason: 'x' })
      expect(again.ok && again.result).toMatchObject({ status: 'already_archived' })
      expect(h.sqlite.prepare(`SELECT COUNT(*) AS n FROM archive_receipts WHERE entity_id = 'w-task'`).get()).toEqual({ n: 1 })
    })
  })


  // ── GHL outbound sends (gate round 2, P1-2) ──
  describe('GHL outbound acts (runApprovedActs, also the pipeline acts step)', () => {
    const seedApprovedWithAct = async (id: string) => {
      seedTask(id, 'approved', { assignee: WORKER, gate: 'gate:hadi' })
      h.sqlite.prepare(
        `INSERT INTO task_verdicts (id, task_id, verdict, note, decided_by, decided_at, decided_via) VALUES (?, ?, 'approved', NULL, ?, ?, NULL)`,
      ).run(`v-${id}`, id, OPERATOR, T0)
      const act = await createOutboundAct(env, id, 'add_contact', { email: 'a@example.com' })
      return act.id
    }
    const ghlEnv = () => ({ ...env, GHL_API_KEY: 'k', GHL_LOCATION_ID: 'loc' }) as unknown as Env
    const actStatus = (id: string) => (h.sqlite.prepare('SELECT status FROM outbound_acts WHERE id = ?').get(id) as { status: string }).status

    it('control: a live approved task sends its pending act', async () => {
      const act = await seedApprovedWithAct('ghl-live')
      const ghlFetch = vi.fn(async () => ({ ok: true, status: 200 }))
      const result = await runApprovedActs(ghlEnv(), 'ghl-live', { ghlFetch })
      expect(result).toMatchObject({ ok: true, sent: 1 })
      expect(ghlFetch).toHaveBeenCalledOnce()
      expect(actStatus(act)).toBe('sent')
    })

    it('an archived approved task sends NOTHING: named task_archived, act stays pending', async () => {
      const act = await seedApprovedWithAct('ghl-dead')
      archive('ghl-dead')
      const ghlFetch = vi.fn(async () => ({ ok: true, status: 200 }))
      const result = await runApprovedActs(ghlEnv(), 'ghl-dead', { ghlFetch })
      expect(result).toMatchObject({ ok: false, reason: 'task_archived', sent: 0 })
      expect(ghlFetch).not.toHaveBeenCalled()
      expect(actStatus(act)).toBe('pending')
    })

    it('RACE: archived after the pre-check, before the per-act claim -> the claim UPDATE refuses, no send', async () => {
      const act = await seedApprovedWithAct('ghl-race')
      archiveWhenPrepared("UPDATE outbound_acts\n          SET status = 'sending'", 'ghl-race')
      const ghlFetch = vi.fn(async () => ({ ok: true, status: 200 }))
      const result = await runApprovedActs(ghlEnv(), 'ghl-race', { ghlFetch })
      expect(ghlFetch).not.toHaveBeenCalled()
      expect(result.sent).toBe(0)
      expect(actStatus(act)).toBe('pending')
    })
  })

  // ── archive refuses a task the bus consumer would still deliver (gate round 2, P1-1) ──
  it('archive_row refuses a task with an unsettled dispatch receipt: named in_flight_dispatch, nothing archived', async () => {
    seedTask('inflight', 'open', { assignee: WORKER })
    const dispatched = await invoke(adminAuth(), 'task_dispatch', { task_id: 'inflight' })
    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true)
    const result = await invoke(adminAuth(), 'archive_row', { table: 'tasks', id: 'inflight', reason: 'x' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    expect(result.error).toBe('in_flight_dispatch')
    expect(h.sqlite.prepare('SELECT COUNT(*) AS n FROM tasks_archive_state').get()).toEqual({ n: 0 })
  })

  it('RACE archive vs dispatch: a dispatch receipt minted after the pre-read still blocks the archive write', async () => {
    seedTask('inflight2', 'open', { assignee: WORKER })
    const realPrepare = h.db.prepare.bind(h.db)
    let armed = true
    h.db.prepare = ((sql: string) => {
      if (armed && sql.includes('INSERT OR IGNORE INTO tasks_archive_state')) {
        armed = false
        h.sqlite.exec(`INSERT INTO task_dispatch_receipts (id, tenant, task_id, squad_id, agent_id, actor_kind, actor_id, created_at, attempts)
          VALUES ('dr-race', '${TENANT}', 'inflight2', '${SQUAD}', '${WORKER}', 'member', '${OPERATOR}', '${T0}', 1)`)
      }
      return realPrepare(sql)
    }) as typeof h.db.prepare
    const result = await invoke(adminAuth(), 'archive_row', { table: 'tasks', id: 'inflight2', reason: 'x' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('in_flight_dispatch')
    expect(h.sqlite.prepare('SELECT COUNT(*) AS n FROM tasks_archive_state').get()).toEqual({ n: 0 })
  })

  it('archive_row accepts a task whose dispatch receipt has settled', async () => {
    seedTask('settled', 'open', { assignee: WORKER })
    h.sqlite.exec(`INSERT INTO task_dispatch_receipts (id, tenant, task_id, squad_id, agent_id, actor_kind, actor_id, created_at, attempts, settled_at)
      VALUES ('dr-settled', '${TENANT}', 'settled', '${SQUAD}', '${WORKER}', 'member', '${OPERATOR}', '${T0}', 1, '${T0}')`)
    const result = await invoke(adminAuth(), 'archive_row', { table: 'tasks', id: 'settled', reason: 'x' })
    expect(result.ok, JSON.stringify(result)).toBe(true)
  })

  // ── mupot#1780: archive blocks only a GENUINELY PENDING dispatch ─────────────────────
  // The Claude-seat flow (inbox read + task_submit_result) never writes a terminal runtime receipt,
  // so "no terminal receipt" must not wedge a done task whose envelope was already read.
  describe('in_flight_dispatch is "can still be delivered", not "no runtime receipt" (#1780)', () => {
    function seedDispatch(id: string, opts: { consumed: boolean; envelope?: { readAt?: string | null; deadLettered?: boolean } }): void {
      h.sqlite.exec(`INSERT INTO task_dispatch_receipts (id, tenant, task_id, squad_id, agent_id, actor_kind, actor_id, created_at, consumed_at, attempts)
        VALUES ('dr-${id}', '${TENANT}', '${id}', '${SQUAD}', '${WORKER}', 'member', '${OPERATOR}', '${T0}', ${opts.consumed ? `'${T0}'` : 'NULL'}, 1)`)
      if (opts.envelope) {
        h.sqlite.prepare(
          `INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, kind, body, request_id, created_at, read_at, dead_lettered_at)
           VALUES (?, ?, 'worker', 'mupot-dispatch', ?, 'request', '{}', ?, ?, ?, ?)`,
        ).run(`msg-${id}`, TENANT, OPERATOR, `dispatch-inbox:dr-${id}`, T0, opts.envelope.readAt ?? null, opts.envelope.deadLettered ? T0 : null)
      }
    }
    const tryArchive = (id: string) => invoke(adminAuth(), 'archive_row', { table: 'tasks', id, reason: 'x' })

    it('done task, dispatch consumed, envelope READ, no runtime receipt -> archivable', async () => {
      seedTask('read-done', 'done', { assignee: WORKER })
      seedDispatch('read-done', { consumed: true, envelope: { readAt: T0 } })
      const result = await tryArchive('read-done')
      expect(result.ok, JSON.stringify(result)).toBe(true)
    })

    it('unread live envelope -> in_flight_dispatch (still deliverable)', async () => {
      seedTask('unread', 'open', { assignee: WORKER })
      seedDispatch('unread', { consumed: true, envelope: { readAt: null } })
      const result = await tryArchive('unread')
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toBe('in_flight_dispatch')
    })

    it('unread but DEAD-LETTERED envelope -> archivable', async () => {
      seedTask('dead', 'open', { assignee: WORKER })
      seedDispatch('dead', { consumed: true, envelope: { readAt: null, deadLettered: true } })
      const result = await tryArchive('dead')
      expect(result.ok, JSON.stringify(result)).toBe(true)
    })

    it('queue event not yet consumed -> in_flight_dispatch even with no envelope', async () => {
      seedTask('queued', 'open', { assignee: WORKER })
      seedDispatch('queued', { consumed: false })
      const result = await tryArchive('queued')
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toBe('in_flight_dispatch')
    })

    it('the in-write guard uses the narrowed predicate: an UNREAD dispatch minted after the pre-read blocks, a read one does not', async () => {
      seedTask('race-unread', 'done', { assignee: WORKER })
      const realPrepare = h.db.prepare.bind(h.db)
      let armed = true
      h.db.prepare = ((sql: string) => {
        if (armed && sql.includes('INSERT OR IGNORE INTO tasks_archive_state')) {
          armed = false
          seedDispatch('race-unread', { consumed: true, envelope: { readAt: null } })
        }
        return realPrepare(sql)
      }) as typeof h.db.prepare
      const result = await tryArchive('race-unread')
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toBe('in_flight_dispatch')
      expect(h.sqlite.prepare('SELECT COUNT(*) AS n FROM tasks_archive_state').get()).toEqual({ n: 0 })
    })

    it('dispatch/reassign guards keep the OLD semantics: a read envelope with no terminal receipt is still in flight there', async () => {
      const { hasInFlightDispatchReceipt } = await import('../src/tasks/runtime-receipts')
      seedTask('old-sem', 'done', { assignee: WORKER })
      seedDispatch('old-sem', { consumed: true, envelope: { readAt: T0 } })
      expect(await hasInFlightDispatchReceipt(env, 'old-sem')).toBe(true)
    })
  })

  // ── unarchive cannot revive work inside an archived container (gate round 2, P2-1) ──
  describe('unarchive_row(task) with an archived parent', () => {
    it('squad archived after the task was archived -> parent_archived, task stays archived', async () => {
      seedTask('child', 'open')
      expect((await invoke(adminAuth(), 'archive_row', { table: 'tasks', id: 'child', reason: 'x' })).ok).toBe(true)
      h.sqlite.exec(`UPDATE squads SET status = 'archived' WHERE id = '${SQUAD}'`)
      const result = await invoke(adminAuth(), 'unarchive_row', { table: 'tasks', id: 'child', reason: 'x' })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.status).toBe(409)
      expect(result.error).toBe('parent_archived')
      expect(result.detail).toEqual({ parent: 'squad' })
      expect(h.sqlite.prepare('SELECT COUNT(*) AS n FROM tasks_archive_state').get()).toEqual({ n: 1 })
      expect(h.sqlite.prepare(`SELECT COUNT(*) AS n FROM archive_receipts WHERE action = 'unarchive'`).get()).toEqual({ n: 0 })
    })

    it('project archived -> parent_archived (project)', async () => {
      h.sqlite.exec(`INSERT INTO projects (id, slug, name, status) VALUES ('pp', 'pp', 'PP', 'active'); INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('pp', '${SQUAD}', 'admin');`)
      seedTask('child2', 'open', { project: 'pp' })
      expect((await invoke(adminAuth(), 'archive_row', { table: 'tasks', id: 'child2', reason: 'x' })).ok).toBe(true)
      h.sqlite.exec(`UPDATE projects SET status = 'archived' WHERE id = 'pp'`)
      const result = await invoke(adminAuth(), 'unarchive_row', { table: 'tasks', id: 'child2', reason: 'x' })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toBe('parent_archived')
      expect(result.detail).toEqual({ parent: 'project' })
    })

    it('RACE: squad archived after the pre-read -> the statements themselves refuse, nothing deleted or receipted', async () => {
      seedTask('child3', 'open')
      expect((await invoke(adminAuth(), 'archive_row', { table: 'tasks', id: 'child3', reason: 'x' })).ok).toBe(true)
      const realPrepare = h.db.prepare.bind(h.db)
      let armed = true
      h.db.prepare = ((sql: string) => {
        if (armed && sql.includes("'unarchive'")) { armed = false; h.sqlite.exec(`UPDATE squads SET status = 'archived' WHERE id = '${SQUAD}'`) }
        return realPrepare(sql)
      }) as typeof h.db.prepare
      const result = await invoke(adminAuth(), 'unarchive_row', { table: 'tasks', id: 'child3', reason: 'x' })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toBe('parent_archived')
      expect(h.sqlite.prepare('SELECT COUNT(*) AS n FROM tasks_archive_state').get()).toEqual({ n: 1 })
      expect(h.sqlite.prepare(`SELECT COUNT(*) AS n FROM archive_receipts WHERE action = 'unarchive'`).get()).toEqual({ n: 0 })
    })

    it('control: unarchive works when both parents are live', async () => {
      seedTask('child4', 'open')
      await invoke(adminAuth(), 'archive_row', { table: 'tasks', id: 'child4', reason: 'x' })
      expect((await invoke(adminAuth(), 'unarchive_row', { table: 'tasks', id: 'child4', reason: 'x' })).ok).toBe(true)
    })
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

  it('the executor claim also refuses an archived UNASSIGNED task (the self-claim branch)', async () => {
    seedTask('e-dead2', 'open')
    archive('e-dead2')
    const model = { chat: vi.fn(async () => ({ content: 'x', usage: { prompt_tokens: 1, completion_tokens: 1 } })) }
    const agent = h.sqlite.prepare('SELECT * FROM agents WHERE id = ?').get(WORKER) as unknown as Agent
    const result = await runTaskExecution(env, agent, 'e-dead2', { model: model as never })
    expect(result).toMatchObject({ ok: false, error: 'task_archived' })
    expect(model.chat).not.toHaveBeenCalled()
    expect(row('e-dead2')).toMatchObject({ status: 'open', a: null })
  })
})
