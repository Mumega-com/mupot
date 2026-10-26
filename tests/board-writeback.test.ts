// S3 board two-way: capability dispatch, receipt-gated Linear write-back, idempotency, flag/opt-in, inbound webhook,
// and secret hygiene. Real migrations on sqlite-backed D1; Linear is a fake fetch against a GraphQL stub.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { encryptConnectorSecret } from '../src/connectors/crypto'
import { runBoardWriteback, writebackForBusEvent, retryFailedWritebacks } from '../src/projects/board-writeback'
import { linearPushStatus, stateMapFromMeta } from '../src/integrations/linear-writeback'
import { registerBoardProvider } from '../src/projects/providers/registry'
import { boardWebhookApp } from '../src/integrations/board-webhook-routes'
import { runBoardSyncTick } from '../src/projects/board-sync'
import type { BoardCapability, ProjectProviderBinding, TaskBoardPort, TransitionReceipt } from '../src/projects/providers/port'
import type { BusEvent, Env } from '../src/types'

const SRC_DIR = join(__dirname, '..', 'src')
const MASTER_KEY = '22'.repeat(32)
const TENANT = 'tenant-a'
const SECRET = 'lin_secret_DO_NOT_LEAK'
const WEBHOOK_SECRET = 'whsec_test_secret'

interface Call { kind: 'states' | 'update' | 'comment'; vars: Record<string, string>; auth: string | null }

const STATES = [
  { id: 'S-todo', name: 'Todo', type: 'unstarted' },
  { id: 'S-prog', name: 'In Progress', type: 'started' },
  { id: 'S-rev', name: 'In Review', type: 'started' },
  { id: 'S-done', name: 'Done', type: 'completed' },
  { id: 'S-canc', name: 'Canceled', type: 'canceled' },
  { id: 'S-shipped', name: 'Shipped', type: 'started' }, // a custom state with a non-completed type
]

/** Fake Linear: answers by operation, records every call. `current` is the issue's current state id. */
function linearStub(opts: { teamKey?: string; current?: string; failMutations?: boolean } = {}) {
  const calls: Call[] = []
  const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, string> }
    const auth = new Headers(init?.headers).get('authorization')
    if (/mutation/.test(body.query)) {
      if (/issueUpdate/.test(body.query)) calls.push({ kind: 'update', vars: body.variables, auth })
      else if (/commentCreate/.test(body.query)) calls.push({ kind: 'comment', vars: body.variables, auth })
      if (opts.failMutations) return new Response(JSON.stringify({ errors: [{ message: 'boom ' + SECRET }] }), { status: 200 })
      const field = /issueUpdate/.test(body.query) ? 'issueUpdate' : 'commentCreate'
      return new Response(JSON.stringify({ data: { [field]: { success: true } } }), { status: 200 })
    }
    calls.push({ kind: 'states', vars: body.variables, auth })
    const current = STATES.find((s) => s.id === (opts.current ?? 'S-todo')) ?? null
    return new Response(
      JSON.stringify({ data: { issue: { id: body.variables.id, team: { key: opts.teamKey ?? 'ENG', states: { nodes: STATES } }, state: current } } }),
      { status: 200 },
    )
  })
  return { calls, fetchFn: fetchFn as unknown as typeof fetch, mutations: () => calls.filter((c) => c.kind !== 'states') }
}

async function makeEnv(extra: Record<string, unknown> = {}) {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'squad-a', 'Squad A');
    INSERT INTO projects (id, slug, name, status) VALUES ('proj-1', 'proj-1', 'Proj 1', 'active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('proj-1', 'squad-a', 'write');
  `)
  const encrypted = await encryptConnectorSecret(MASTER_KEY, 'connector-linear-1', 'linear', SECRET)
  harness.sqlite.exec(
    `INSERT INTO connectors (id, tenant, type, label, encrypted_secret, meta, scope_type, scope_id, created_by, created_at)
     VALUES ('connector-linear-1', '${TENANT}', 'linear', 'Linear', '${encrypted}', NULL, 'pot', NULL, 'admin-1', datetime('now'));`,
  )
  const kvStore = new Map<string, string>()
  const env = {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    CONNECTOR_MASTER_KEY: MASTER_KEY,
    SESSIONS: {
      get: async (k: string) => kvStore.get(k) ?? null,
      put: async (k: string, v: string) => { kvStore.set(k, v) },
    },
    BOARD_WRITEBACK: '1',
    LINEAR_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ...extra,
  } as unknown as Env
  return { env, harness, kvStore }
}

type Harness = Awaited<ReturnType<typeof makeEnv>>['harness']

function bindLinear(h: Harness, meta: Record<string, unknown> = { writeback: true, defaultSquadId: 'squad-a' }) {
  h.sqlite.prepare(
    `INSERT OR REPLACE INTO project_provider_bindings (project_id, provider, external_id, connector_id, meta_json) VALUES ('proj-1','linear','ENG','connector-linear-1', ?)`,
  ).run(JSON.stringify(meta))
}

let seq = 0
function insertTask(h: Harness, status: string, gate: string | null = 'gate:hadi', result: string | null = null): string {
  const id = `task-${++seq}`
  h.sqlite.prepare(
    `INSERT INTO tasks (id, squad_id, project_id, title, status, gate_owner, result) VALUES (?, 'squad-a', 'proj-1', 'Do it', ?, ?, ?)`,
  ).run(id, status, gate, result)
  return id
}
function link(h: Harness, taskId: string, provider = 'linear', nativeId = 'ISSUE-UUID-1') {
  h.sqlite.prepare(
    `INSERT INTO board_item_links (tenant, task_id, project_id, provider, item_native_id, item_ref, created_at) VALUES (?, ?, 'proj-1', ?, ?, 'ENG-1', datetime('now'))`,
  ).run(TENANT, taskId, provider, nativeId)
}
function submission(h: Harness, taskId: string, artifact = 'https://github.com/mumega/mupot/pull/9'): string {
  const id = `sub-${++seq}`
  h.sqlite.prepare(
    `INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest, result_text)
     VALUES (?, ?, ?, 'squad-a', 'agent-1', ?, ?, ?, 'done')`,
  ).run(id, TENANT, taskId, artifact, 'a'.repeat(64), 'b'.repeat(64))
  return id
}
function verdict(h: Harness, taskId: string, v: 'approved' | 'rejected', reversed = false): string {
  const id = `ver-${++seq}`
  h.sqlite.prepare(
    `INSERT INTO task_verdicts (id, task_id, verdict, note, decided_by, decided_at) VALUES (?, ?, ?, 'ok', 'mem-1', ?)`,
  ).run(id, taskId, v, new Date().toISOString())
  if (reversed) h.sqlite.prepare(`UPDATE task_verdicts SET reversed_at = ? WHERE id = ?`).run(new Date().toISOString(), id)
  return id
}
const count = (h: Harness, table: string) => (h.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

let stub: ReturnType<typeof linearStub>
beforeEach(() => {
  stub = linearStub()
  vi.stubGlobal('fetch', stub.fetchFn)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('capability dispatch never names a provider', () => {
  it('the dispatcher source contains no provider name', () => {
    const src = readFileSync(join(SRC_DIR, 'projects', 'board-writeback.ts'), 'utf8')
    // Strip comments: prose may describe the design; code may not branch on a name.
    const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const name of ['linear', 'github_projects', 'notion', 'jira', 'asana']) {
      expect(code.toLowerCase()).not.toContain(name)
    }
    const registry = readFileSync(join(SRC_DIR, 'projects', 'providers', 'registry-core.ts'), 'utf8')
    expect(registry).not.toMatch(/switch\s*\(/)
  })

  it('drives a brand-new provider that only registers itself', async () => {
    const { env, harness } = await makeEnv()
    const pushed: Array<{ kind: string; native: string }> = []
    const commented: string[] = []
    registerBoardProvider('fakeboard', () => ({
      provider: 'fakeboard',
      capabilities: new Set<BoardCapability>(['pushStatus', 'postComment']),
      listItems: async () => ({ ok: true, items: [] }),
      syncIntoProject: async () => ({ ok: true, imported: 0, skipped: 0, items: [] }),
      pushStatus: async (_b, task, receipt) => { pushed.push({ kind: receipt.kind, native: task.item.native_id }); return { ok: true, applied: true } },
      postComment: async (_b, _i, text) => { commented.push(text); return { ok: true, applied: true } },
    }))
    // A binding row for the fake provider needs the CHECK on the provider column relaxed in a real deploy; the
    // dispatcher only reads it through getProjectBinding, so insert with the constraint off for this fixture.
    harness.sqlite.exec('PRAGMA ignore_check_constraints = ON')
    harness.sqlite.prepare(
      `INSERT INTO project_provider_bindings (project_id, provider, external_id, connector_id, meta_json) VALUES ('proj-1','fakeboard','X',NULL,'{"writeback":true}')`,
    ).run()
    harness.sqlite.exec('PRAGMA ignore_check_constraints = OFF')
    const t = insertTask(harness, 'review')
    submission(harness, t)
    link(harness, t, 'fakeboard', 'FAKE-9')
    const report = await runBoardWriteback(env, t)
    expect(report.outcome).toBe('ran')
    expect(pushed).toEqual([{ kind: 'submitted', native: 'FAKE-9' }])
    expect(commented).toHaveLength(1)
    expect(stub.fetchFn).not.toHaveBeenCalled()
  })

  it('a provider without a capability is skipped cleanly', async () => {
    const { env, harness } = await makeEnv()
    registerBoardProvider('nocap', (): TaskBoardPort => ({
      provider: 'nocap',
      capabilities: new Set<BoardCapability>(),
      listItems: async () => ({ ok: true, items: [] }),
      syncIntoProject: async () => ({ ok: true, imported: 0, skipped: 0, items: [] }),
    }))
    harness.sqlite.exec('PRAGMA ignore_check_constraints = ON')
    harness.sqlite.prepare(
      `INSERT INTO project_provider_bindings (project_id, provider, external_id, connector_id, meta_json) VALUES ('proj-1','nocap','X',NULL,'{"writeback":true}')`,
    ).run()
    harness.sqlite.exec('PRAGMA ignore_check_constraints = OFF')
    const t = insertTask(harness, 'review')
    submission(harness, t)
    link(harness, t, 'nocap', 'N-1')
    const report = await runBoardWriteback(env, t)
    expect(report).toEqual({
      outcome: 'ran',
      transition: expect.stringMatching(/^submitted:/),
      actions: [{ action: 'status', result: 'unsupported' }, { action: 'comment', result: 'unsupported' }],
    })
    expect(count(harness, 'board_writeback_ledger')).toBe(0)
  })
})

describe('pushStatus runs only with a receipt', () => {
  const binding = (): ProjectProviderBinding => ({
    project_id: 'proj-1', provider: 'linear', external_id: 'ENG', connector_id: 'connector-linear-1',
    meta_json: '{"writeback":true}', synced_at: null, created_at: '', updated_at: '',
  })
  const task = { id: 't', item: { native_id: 'I1', ref: 'ENG-1' } }

  it('refuses a missing receipt id, an unknown kind, and a verdict without a gate: zero Linear calls', async () => {
    const { env } = await makeEnv()
    const bad: Array<[TransitionReceipt, string]> = [
      [{ kind: 'approved', receipt_id: '', gate_owner: 'gate:hadi' }, 'receipt_required'],
      [{ kind: 'approved', receipt_id: 'v1', gate_owner: null }, 'gated_verdict_required'],
      [{ kind: 'rejected', receipt_id: 'v1', gate_owner: null }, 'gated_verdict_required'],
      [{ kind: 'closed' as never, receipt_id: 'v1', gate_owner: 'gate:hadi' }, 'unmapped_transition'],
    ]
    for (const [receipt, error] of bad) {
      expect(await linearPushStatus(env, binding(), task, receipt)).toEqual({ ok: false, error })
    }
    expect(stub.fetchFn).not.toHaveBeenCalled()
  })

  it('dispatcher: no submission row, no live verdict, ungated, or reversed verdict means no write', async () => {
    const { env, harness } = await makeEnv()
    bindLinear(harness)
    const noSub = insertTask(harness, 'review'); link(harness, noSub)
    expect(await runBoardWriteback(env, noSub)).toEqual({ outcome: 'skipped', reason: 'no_receipt' })

    const noVerdict = insertTask(harness, 'approved'); link(harness, noVerdict, 'linear', 'I2')
    expect(await runBoardWriteback(env, noVerdict)).toEqual({ outcome: 'skipped', reason: 'no_receipt' })

    const ungated = insertTask(harness, 'approved', null); verdict(harness, ungated, 'approved'); link(harness, ungated, 'linear', 'I3')
    expect(await runBoardWriteback(env, ungated)).toEqual({ outcome: 'skipped', reason: 'no_receipt' })

    const reversed = insertTask(harness, 'approved'); verdict(harness, reversed, 'approved', true); link(harness, reversed, 'linear', 'I4')
    expect(await runBoardWriteback(env, reversed)).toEqual({ outcome: 'skipped', reason: 'no_receipt' })

    const mismatch = insertTask(harness, 'approved'); verdict(harness, mismatch, 'rejected'); link(harness, mismatch, 'linear', 'I5')
    expect(await runBoardWriteback(env, mismatch)).toEqual({ outcome: 'skipped', reason: 'no_receipt' })

    expect(stub.fetchFn).not.toHaveBeenCalled()
    expect(count(harness, 'board_writeback_ledger')).toBe(0)
  })
})

describe('status mapping', () => {
  it('submitted -> In Review, with the PR link as a comment', async () => {
    const { env, harness } = await makeEnv()
    bindLinear(harness)
    const t = insertTask(harness, 'review'); submission(harness, t); link(harness, t)
    const r = await runBoardWriteback(env, t)
    expect(r.outcome).toBe('ran')
    const m = stub.mutations()
    expect(m[0]).toMatchObject({ kind: 'update', vars: { id: 'ISSUE-UUID-1', stateId: 'S-rev' } })
    expect(m[1]).toMatchObject({ kind: 'comment', vars: { issueId: 'ISSUE-UUID-1' } })
    expect(m[1].vars.body).toContain('https://github.com/mumega/mupot/pull/9')
  })

  it('approved gated verdict -> Done', async () => {
    const { env, harness } = await makeEnv()
    bindLinear(harness)
    const t = insertTask(harness, 'approved'); verdict(harness, t, 'approved'); link(harness, t)
    await runBoardWriteback(env, t)
    expect(stub.mutations()[0]).toMatchObject({ kind: 'update', vars: { stateId: 'S-done' } })
    expect(stub.mutations()[1].vars.body).toContain('APPROVED')
  })

  it('rejected gated verdict -> In Progress, never Done', async () => {
    const { env, harness } = await makeEnv({}) 
    bindLinear(harness)
    const t = insertTask(harness, 'rejected'); verdict(harness, t, 'rejected'); link(harness, t)
    await runBoardWriteback(env, t)
    expect(stub.mutations()[0]).toMatchObject({ kind: 'update', vars: { stateId: 'S-prog' } })
  })

  it('honours the per-binding state map (names only) and ignores unknown keys', async () => {
    expect(stateMapFromMeta('{"stateMap":{"in_review":"Peer Review","bogus":"X","done":""}}')).toEqual({
      in_review: 'Peer Review', in_progress: 'In Progress', done: 'Done',
    })
    const { env, harness } = await makeEnv()
    bindLinear(harness, { writeback: true, stateMap: { done: 'Shipped' } })
    const t = insertTask(harness, 'approved'); verdict(harness, t, 'approved'); link(harness, t)
    const r = await runBoardWriteback(env, t)
    // 'Shipped' is a started-type state: Done may only land on a completed-type state.
    expect(r).toMatchObject({ outcome: 'ran', actions: [{ action: 'status', result: 'failed', detail: 'state_type_mismatch' }] })
    expect(stub.mutations()).toHaveLength(0)
  })

  it('never overrides a human cancel, never writes to another team, no-ops when already there', async () => {
    const { env, harness } = await makeEnv()
    bindLinear(harness)
    const t = insertTask(harness, 'approved'); verdict(harness, t, 'approved'); link(harness, t)

    stub = linearStub({ current: 'S-canc' }); vi.stubGlobal('fetch', stub.fetchFn)
    const canceled = await runBoardWriteback(env, t)
    expect(canceled).toMatchObject({ actions: [{ action: 'status', result: 'done', detail: 'human_canceled' }] })
    expect(canceled.outcome === 'ran' && canceled.actions).toHaveLength(1)
    expect(stub.mutations()).toHaveLength(0)

    const t2 = insertTask(harness, 'approved'); verdict(harness, t2, 'approved'); link(harness, t2, 'linear', 'I-OTHER')
    stub = linearStub({ teamKey: 'OPS' }); vi.stubGlobal('fetch', stub.fetchFn)
    expect(await runBoardWriteback(env, t2)).toMatchObject({ actions: [{ action: 'status', result: 'failed', detail: 'team_mismatch' }] })
    expect(stub.mutations()).toHaveLength(0)

    const t3 = insertTask(harness, 'approved'); verdict(harness, t3, 'approved'); link(harness, t3, 'linear', 'I-DONE')
    stub = linearStub({ current: 'S-done' }); vi.stubGlobal('fetch', stub.fetchFn)
    await runBoardWriteback(env, t3)
    expect(stub.mutations().filter((c) => c.kind === 'update')).toHaveLength(0)
  })

  it('a prior human cancel stays a refusal on redelivery: no comment is ever posted', async () => {
    const { env, harness } = await makeEnv()
    bindLinear(harness)
    const t = insertTask(harness, 'approved'); verdict(harness, t, 'approved'); link(harness, t)
    stub = linearStub({ current: 'S-canc' }); vi.stubGlobal('fetch', stub.fetchFn)
    await runBoardWriteback(env, t)
    const again = await runBoardWriteback(env, t)
    expect(again.outcome === 'ran' && again.actions).toEqual([{ action: 'status', result: 'duplicate' }])
    expect(stub.mutations()).toHaveLength(0)
    expect(harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM board_writeback_ledger WHERE action = 'comment'`).get()).toEqual({ n: 0 })
  })

  it('team_mismatch exhausted then a new event posts nothing to that issue', async () => {
    const { env, harness } = await makeEnv()
    bindLinear(harness)
    const t = insertTask(harness, 'approved'); verdict(harness, t, 'approved'); link(harness, t, 'linear', 'I-OTHER')
    stub = linearStub({ teamKey: 'OPS' }); vi.stubGlobal('fetch', stub.fetchFn)
    for (let i = 0; i < 7; i++) await runBoardWriteback(env, t)
    const last = await runBoardWriteback(env, t)
    expect(last.outcome === 'ran' && last.actions).toEqual([{ action: 'status', result: 'duplicate' }])
    expect(stub.mutations()).toHaveLength(0)
    expect(harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM board_writeback_ledger WHERE action = 'comment'`).get()).toEqual({ n: 0 })
  })

  it('only ever sends issueUpdate{stateId} and commentCreate (no delete/assign)', async () => {
    const src = readFileSync(join(SRC_DIR, 'integrations', 'linear-writeback.ts'), 'utf8')
    const ops = [...src.matchAll(/mutation\(([^)]*)\)\s*\{\s*(\w+)/g)].map((m) => m[2]).sort()
    expect(ops).toEqual(['commentCreate', 'issueUpdate'])
    expect(src).not.toMatch(/issueDelete|issueArchive|assigneeId|issueUnarchive/)
  })
})

describe('idempotency per (task, transition)', () => {
  it('a redelivered event writes once; a new submission is a new transition', async () => {
    const { env, harness } = await makeEnv()
    bindLinear(harness)
    const t = insertTask(harness, 'review'); const s1 = submission(harness, t); link(harness, t)
    await runBoardWriteback(env, t)
    const second = await runBoardWriteback(env, t)
    expect(second).toMatchObject({ actions: [{ result: 'duplicate' }, { result: 'duplicate' }] })
    expect(stub.mutations()).toHaveLength(2) // one status + one comment, ever, for s1

    const s2 = submission(harness, t, 'https://github.com/mumega/mupot/pull/10')
    expect(s2).not.toBe(s1)
    await runBoardWriteback(env, t)
    expect(stub.mutations()).toHaveLength(4)
  })

  it('goes through the bus: events for the same transition do not double-write', async () => {
    const { env, harness } = await makeEnv()
    bindLinear(harness)
    const t = insertTask(harness, 'approved'); verdict(harness, t, 'approved'); link(harness, t)
    const ev = (type: BusEvent['type']): BusEvent => ({ type, tenant: TENANT, payload: { task_id: t }, ts: new Date().toISOString() })
    await writebackForBusEvent(env, ev('task.verdict'))
    await writebackForBusEvent(env, ev('task.verdict'))
    await writebackForBusEvent(env, ev('task.updated'))
    expect(stub.mutations()).toHaveLength(2)
    expect(await writebackForBusEvent(env, ev('lead.new'))).toEqual({ outcome: 'skipped', reason: 'event_not_a_transition' })
  })

  it('a failed write is retried (bounded) and never reported as done', async () => {
    const { env, harness } = await makeEnv()
    bindLinear(harness)
    const t = insertTask(harness, 'approved'); verdict(harness, t, 'approved'); link(harness, t)
    stub = linearStub({ failMutations: true }); vi.stubGlobal('fetch', stub.fetchFn)
    const r = await runBoardWriteback(env, t)
    expect(r).toMatchObject({ actions: [{ action: 'status', result: 'failed' }] })
    expect(harness.sqlite.prepare(`SELECT status, attempts FROM board_writeback_ledger`).get()).toMatchObject({ status: 'failed', attempts: 1 })
    // Linear recovers; the cron retry re-drives it (ledger row is older than the retry window).
    harness.sqlite.prepare(`UPDATE board_writeback_ledger SET updated_at = '2020-01-01T00:00:00.000Z'`).run()
    stub = linearStub(); vi.stubGlobal('fetch', stub.fetchFn)
    expect(await retryFailedWritebacks(env)).toBe(1)
    expect(stub.mutations().some((c) => c.kind === 'update')).toBe(true)
    expect(harness.sqlite.prepare(`SELECT status FROM board_writeback_ledger WHERE action='status'`).get()).toMatchObject({ status: 'done' })
  })
})

describe('flags', () => {
  it('BOARD_WRITEBACK unset or not "1": zero DB access and zero Linear calls', async () => {
    for (const flag of [undefined, '0', 'true', '']) {
      const { env, harness } = await makeEnv({ BOARD_WRITEBACK: flag })
      bindLinear(harness)
      const t = insertTask(harness, 'approved'); verdict(harness, t, 'approved'); link(harness, t)
      const prepare = vi.spyOn(env.DB, 'prepare')
      expect(await runBoardWriteback(env, t)).toEqual({ outcome: 'skipped', reason: 'flag_off' })
      expect(await writebackForBusEvent(env, { type: 'task.verdict', tenant: TENANT, payload: { task_id: t }, ts: '' })).toEqual({ outcome: 'skipped', reason: 'flag_off' })
      expect(await retryFailedWritebacks(env)).toBe(0)
      expect(prepare).not.toHaveBeenCalled()
      expect(stub.fetchFn).not.toHaveBeenCalled()
      expect(count(harness, 'board_writeback_ledger')).toBe(0)
    }
  })

  it('per-binding meta.writeback must be exactly true', async () => {
    for (const meta of [{}, { writeback: false }, { writeback: 'true' }, { writeback: 1 }]) {
      const { env, harness } = await makeEnv()
      bindLinear(harness, meta)
      const t = insertTask(harness, 'approved'); verdict(harness, t, 'approved'); link(harness, t)
      expect(await runBoardWriteback(env, t)).toEqual({ outcome: 'skipped', reason: 'binding_not_enabled' })
      expect(stub.fetchFn).not.toHaveBeenCalled()
    }
  })

  it('an unlinked task is skipped', async () => {
    const { env, harness } = await makeEnv()
    bindLinear(harness)
    const t = insertTask(harness, 'approved'); verdict(harness, t, 'approved')
    expect(await runBoardWriteback(env, t)).toEqual({ outcome: 'skipped', reason: 'no_link' })
  })
})

describe('inbound webhook', () => {
  async function sign(body: string, secret = WEBHOOK_SECRET): Promise<string> {
    const enc = new TextEncoder()
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body))), (b) => b.toString(16).padStart(2, '0')).join('')
  }
  const issueBody = (over: Record<string, unknown> = {}, ts = Date.now()) => JSON.stringify({
    action: 'create', type: 'Issue', webhookTimestamp: ts,
    data: { id: 'NEW-UUID-1', identifier: 'ENG-7', title: 'Imported', url: 'https://linear.app/x/issue/ENG-7', team: { key: 'ENG' }, state: { name: 'Todo' } },
    ...over,
  })
  async function post(env: Env, body: string, headers: Record<string, string> = {}, provider = 'linear') {
    return boardWebhookApp.request(`/${provider}`, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } }, env)
  }
  const signed = async (body: string, extra: Record<string, string> = {}) => ({ 'linear-signature': await sign(body), 'linear-delivery': 'd-1', ...extra })

  it('rejects a bad HMAC, a missing signature, and a body signed with another secret', async () => {
    const { env, harness } = await makeEnv(); bindLinear(harness)
    const body = issueBody()
    expect((await post(env, body, { 'linear-signature': 'f'.repeat(64), 'linear-delivery': 'x' })).status).toBe(401)
    expect((await post(env, body)).status).toBe(401)
    expect((await post(env, body, { 'linear-signature': await sign(body, 'wrong'), 'linear-delivery': 'y' })).status).toBe(401)
    expect(count(harness, 'tasks')).toBe(0)
    expect(count(harness, 'board_webhook_deliveries')).toBe(0) // unauthenticated requests never touch the ledger
  })

  it('fails closed (503) when the secret is not configured', async () => {
    const { env } = await makeEnv({ LINEAR_WEBHOOK_SECRET: undefined })
    const body = issueBody()
    expect((await post(env, body, await signed(body))).status).toBe(503)
  })

  it('rejects a replay: same delivery id is a no-op, and a stale timestamp is refused', async () => {
    const { env, harness } = await makeEnv(); bindLinear(harness)
    const body = issueBody()
    const first = await post(env, body, await signed(body))
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({ ok: true, imported: 1 })
    const again = await post(env, body, await signed(body))
    expect(await again.json()).toEqual({ ok: true, duplicate: true })
    expect(count(harness, 'tasks')).toBe(1)

    const old = issueBody({}, Date.now() - 5 * 60_000)
    expect((await post(env, old, await signed(old, { 'linear-delivery': 'd-old' }))).status).toBe(401)
    expect(count(harness, 'tasks')).toBe(1)
  })

  it('dedupes on the signed body, not the unsigned delivery header', async () => {
    const { env, harness } = await makeEnv(); bindLinear(harness)
    const body = issueBody()
    expect((await post(env, body, await signed(body, { 'linear-delivery': 'one' }))).status).toBe(200)
    const again = await post(env, body, await signed(body, { 'linear-delivery': 'two' }))
    expect(await again.json()).toEqual({ ok: true, duplicate: true })
    expect(count(harness, 'tasks')).toBe(1)
  })

  it('releases the delivery claim when the handler fails so a redelivery retries', async () => {
    const { env, harness } = await makeEnv(); bindLinear(harness)
    const body = issueBody()
    harness.sqlite.exec(`CREATE TRIGGER boom BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT, 'boom'); END;`)
    const failed = await post(env, body, await signed(body))
    expect(failed.status).toBe(503)
    expect(count(harness, 'board_webhook_deliveries')).toBe(0)
    harness.sqlite.exec(`DROP TRIGGER boom`)
    const retry = await post(env, body, await signed(body))
    expect(await retry.json()).toMatchObject({ ok: true, imported: 1 })
  })

  it('caps the body size before verifying', async () => {
    const { env } = await makeEnv()
    const big = 'x'.repeat(300 * 1024)
    const res = await post(env, big, { 'linear-signature': 'a'.repeat(64) })
    expect(res.status).toBe(413)
  })

  it('imports a new issue as an UNASSIGNED task with a link; no event, no agent', async () => {
    const { env, harness } = await makeEnv(); bindLinear(harness)
    const body = issueBody()
    await post(env, body, await signed(body))
    const task = harness.sqlite.prepare(`SELECT title, assignee_agent_id, external_source, status FROM tasks`).get() as Record<string, unknown>
    expect(task).toMatchObject({ title: 'Imported', assignee_agent_id: null, external_source: 'linear:ENG', status: 'open' })
    expect(harness.sqlite.prepare(`SELECT item_native_id, item_ref FROM board_item_links`).get()).toEqual({ item_native_id: 'NEW-UUID-1', item_ref: 'ENG-7' })
  })

  it('a status change becomes a note, never a verdict or a status change', async () => {
    const { env, harness } = await makeEnv(); bindLinear(harness)
    const t = insertTask(harness, 'review'); link(harness, t, 'linear', 'NEW-UUID-1')
    const body = issueBody({ action: 'update', updatedFrom: { stateId: 'old-state' }, data: { id: 'NEW-UUID-1', identifier: 'ENG-7', team: { key: 'ENG' }, state: { name: 'Done' } } })
    const res = await post(env, body, await signed(body))
    expect(await res.json()).toMatchObject({ ok: true, noted: 1 })
    expect(harness.sqlite.prepare(`SELECT to_status, task_id FROM board_inbound_observations`).get()).toEqual({ to_status: 'Done', task_id: t })
    expect(harness.sqlite.prepare(`SELECT status FROM tasks WHERE id = ?`).get(t)).toEqual({ status: 'review' })
    expect(count(harness, 'task_verdicts')).toBe(0)
  })

  it('answers 404 for an unknown provider and for one without the webhook capability', async () => {
    const { env } = await makeEnv()
    expect((await post(env, '{}', {}, 'nope')).status).toBe(404)
    expect((await post(env, '{}', {}, 'notion')).status).toBe(404)
  })

  it('inbound import still works with BOARD_WRITEBACK off', async () => {
    const { env, harness } = await makeEnv({ BOARD_WRITEBACK: undefined }); bindLinear(harness, { defaultSquadId: 'squad-a' })
    const body = issueBody()
    await post(env, body, await signed(body))
    expect(count(harness, 'tasks')).toBe(1)
  })
})

describe('scheduled sync', () => {
  it('is rate limited: one attempt per binding per interval, bounded per tick', async () => {
    const { env, harness } = await makeEnv(); bindLinear(harness)
    stub = linearStub(); vi.stubGlobal('fetch', stub.fetchFn)
    expect((await runBoardSyncTick(env)).attempted).toBe(1)
    expect((await runBoardSyncTick(env)).attempted).toBe(0) // marker holds, even though synced_at may not be stamped
  })
})

describe('no secret in meta, ledger or logs', () => {
  it('never leaks the connector secret, even when Linear echoes it in an error', async () => {
    const logs: string[] = []
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')) })
    }
    const { env, harness } = await makeEnv(); bindLinear(harness)
    stub = linearStub({ failMutations: true }); vi.stubGlobal('fetch', stub.fetchFn)
    const t = insertTask(harness, 'approved'); verdict(harness, t, 'approved'); link(harness, t)
    await runBoardWriteback(env, t)
    const dump = JSON.stringify([
      harness.sqlite.prepare(`SELECT * FROM board_writeback_ledger`).all(),
      harness.sqlite.prepare(`SELECT * FROM project_provider_bindings`).all(),
      harness.sqlite.prepare(`SELECT * FROM board_item_links`).all(),
      logs,
    ])
    expect(dump).not.toContain(SECRET)
    expect(dump).not.toContain(WEBHOOK_SECRET)
    // The credential was used (server side), only via the vault authorization header.
    expect(stub.calls.every((c) => c.auth === SECRET)).toBe(true)
    expect(JSON.parse((harness.sqlite.prepare(`SELECT meta_json FROM project_provider_bindings`).get() as { meta_json: string }).meta_json)).not.toHaveProperty('token')
  })

  it('the state map reader accepts names only', () => {
    expect(JSON.stringify(stateMapFromMeta('{"stateMap":{"done":"Done"},"apiKey":"x"}'))).not.toContain('apiKey')
  })
})
