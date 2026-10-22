// mupot — seed B1: idempotent bounty -> task binding over the HMAC event-ingest surface.
//
// Real SQLite with the WHOLE committed migration chain (no hand-written schema), driven through the
// real eventIngestApp route. Every guard here was mutated and confirmed red (see the PR body).
//
// Contract pinned:
//   - HMAC missing/bad -> 401, nothing written
//   - closed payload schema violations -> 400, nothing written
//   - first delivery -> 201, one task + one binding, task tagged external_source='mumega-bounty:<id>'
//   - identical replay -> 200, SAME task id, nothing new written, no second task.created event
//   - same bounty_id with a different revision or payload -> 409, nothing changed
//   - concurrent identical deliveries -> exactly one task
//   - a task already holding the key without a binding is never adopted
//   - wrong-tenant isolation: unknown squad 404, project the squad cannot write 403

import type { D1Database } from '@cloudflare/workers-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EVENT_REGISTRY, eventIngestApp } from '../src/events/ingest'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const SECRET = 'bounty_secret_not_real'
const SQUAD = 'squad-bounty'
const OTHER_SQUAD = 'squad-other'
const PROJECT = 'project-bounty'
const OTHER_PROJECT = 'project-other-squad-only'
const EMAIL_SHA = 'a'.repeat(64)

let harness: SqliteD1Harness
let busSend: ReturnType<typeof vi.fn>
let env: Env

async function hmac(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bounty_id: 'bty-001',
    award_revision: 1,
    issuer_tenant: 'mumega',
    claimant_ref: { identity_id: 'ident-7c1', email_sha256: EMAIL_SHA },
    title: 'Write the onboarding explainer',
    done_when: 'explainer published at the agreed URL and reviewed against the brief',
    price_minor: 1000,
    currency: 'USD',
    gate_owner: 'gate:mumega-bounty',
    project: PROJECT,
    ...overrides,
  }
}

function envelope(p: Record<string, unknown>, squad = SQUAD): Record<string, unknown> {
  return { type: 'bounty.claimed', source: 'mumega-com', squad_id: squad, payload: p }
}

interface Res { status: number; json: Record<string, unknown> }

async function post(
  body: unknown,
  opts: { secret?: string | null; signWith?: string; raw?: string; target?: Env } = {},
): Promise<Res> {
  const raw = opts.raw ?? JSON.stringify(body)
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const signer = opts.signWith ?? SECRET
  if (opts.secret !== null) headers['x-mupot-signature'] = await hmac(signer, raw)
  const res = await eventIngestApp.request('/ingest', { method: 'POST', headers, body: raw }, opts.target ?? env)
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

function count(table: string, where = '1 = 1'): number {
  return Number((harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n)
}
const bountyTasks = (): number => count('tasks', "external_source GLOB 'mumega-bounty:*'")

function makeEnv(db: D1Database): Env {
  return {
    TENANT_SLUG: 'tenant-bounty',
    DB: db,
    BUS: { send: busSend } as unknown as Env['BUS'],
    EVENT_INGEST_SECRET: SECRET,
  } as unknown as Env
}

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-b', 'bounty', 'Bounty');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('${SQUAD}', 'dept-b', 'bounty', 'Bounty'),
      ('${OTHER_SQUAD}', 'dept-b', 'other', 'Other');
    INSERT INTO projects (id, slug, name) VALUES
      ('${PROJECT}', 'bounty-p', 'Bounty Project'),
      ('${OTHER_PROJECT}', 'other-p', 'Other Project');
    INSERT INTO project_squad_access (project_id, squad_id, access_level, granted_at) VALUES
      ('${PROJECT}', '${SQUAD}', 'write', '2026-10-22T00:00:00.000Z'),
      ('${OTHER_PROJECT}', '${OTHER_SQUAD}', 'write', '2026-10-22T00:00:00.000Z');
  `)
  busSend = vi.fn().mockResolvedValue(undefined)
  env = makeEnv(harness.db)
})

afterEach(() => harness.close())

describe('registry', () => {
  it('bounty.claimed is a registered event type', () => {
    expect(EVENT_REGISTRY.has('bounty.claimed')).toBe(true)
  })
})

describe('HMAC auth', () => {
  it('missing signature -> 401 and nothing written', async () => {
    const res = await post(envelope(payload()), { secret: null })
    expect(res.status).toBe(401)
    expect(count('tasks')).toBe(0)
    expect(count('bounty_task_bindings')).toBe(0)
  })

  it('signature from the wrong secret -> 401 and nothing written', async () => {
    const res = await post(envelope(payload()), { signWith: 'some_other_secret' })
    expect(res.status).toBe(401)
    expect(count('tasks')).toBe(0)
  })

  it('signature over a different body (tampered after signing) -> 401', async () => {
    const signed = JSON.stringify(envelope(payload()))
    const tampered = JSON.stringify(envelope(payload({ price_minor: 999999 })))
    const headers = { 'content-type': 'application/json', 'x-mupot-signature': await hmac(SECRET, signed) }
    const res = await eventIngestApp.request('/ingest', { method: 'POST', headers, body: tampered }, env)
    expect(res.status).toBe(401)
    expect(count('tasks')).toBe(0)
  })

  it('no secret configured -> 503, never an unauthenticated create', async () => {
    const noSecret = { ...env, EVENT_INGEST_SECRET: undefined } as unknown as Env
    const res = await post(envelope(payload()), { target: noSecret })
    expect(res.status).toBe(503)
    expect(count('tasks')).toBe(0)
  })
})

describe('closed payload schema', () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['unknown top-level field', payload({ extra: 'smuggled' })],
    ['raw email smuggled as a field', payload({ claimant_email: 'a@b.example' })],
    ['missing bounty_id', (() => { const p = payload(); delete p.bounty_id; return p })()],
    ['bounty_id with whitespace/punctuation', payload({ bounty_id: "bty 1'; --" })],
    ['non-integer revision', payload({ award_revision: 1.5 })],
    ['negative revision', payload({ award_revision: -1 })],
    ['string revision', payload({ award_revision: '1' })],
    ['negative price', payload({ price_minor: -5 })],
    ['float price', payload({ price_minor: 10.5 })],
    ['lower-case currency', payload({ currency: 'usd' })],
    ['gate_owner not a gate capability', payload({ gate_owner: 'agent-123' })],
    ['placeholder done_when', payload({ done_when: '(set via task update)' })],
    ['blank done_when', payload({ done_when: '   ' })],
    ['control character in title', payload({ title: 'bad\u0000title' })],
    ['claimant_ref missing', (() => { const p = payload(); delete p.claimant_ref; return p })()],
    ['claimant_ref carries a raw email', payload({ claimant_ref: { identity_id: 'i1', email_sha256: 'x@y.example' } })],
    ['claimant_ref extra key', payload({ claimant_ref: { identity_id: 'i1', email_sha256: EMAIL_SHA, email: 'x@y.example' } })],
    ['upper-case hex hash', payload({ claimant_ref: { identity_id: 'i1', email_sha256: 'A'.repeat(64) } })],
  ]
  it.each(bad)('%s -> 400, nothing written', async (_name, p) => {
    const res = await post(envelope(p))
    expect(res.status).toBe(400)
    expect(res.json.error).toBe('invalid_payload')
    expect(count('tasks')).toBe(0)
    expect(count('bounty_task_bindings')).toBe(0)
  })

  it('payload that is not an object -> 400', async () => {
    const res = await post({ type: 'bounty.claimed', source: 'mumega-com', squad_id: SQUAD, payload: 'nope' })
    expect(res.status).toBe(400)
    expect(count('tasks')).toBe(0)
  })
})

describe('create', () => {
  it('first delivery creates one task, tagged and gated, plus its binding', async () => {
    const res = await post(envelope(payload()))
    expect(res.status).toBe(201)
    expect(res.json.ok).toBe(true)
    expect(count('tasks')).toBe(1)

    const task = harness.sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get(res.json.task_id as string) as Record<string, unknown>
    expect(task.external_source).toBe('mumega-bounty:bty-001')
    expect(task.gate_owner).toBe('gate:mumega-bounty')
    expect(task.status).toBe('open')
    expect(task.squad_id).toBe(SQUAD)
    expect(task.project_id).toBe(PROJECT)
    expect(task.assignee_agent_id).toBeNull()
    expect(task.done_when).toBe(payload().done_when)

    const binding = harness.sqlite.prepare('SELECT * FROM bounty_task_bindings WHERE bounty_id = ?').get('bty-001') as Record<string, unknown>
    expect(binding.task_id).toBe(res.json.task_id)
    expect(binding.award_revision).toBe(1)
    expect(binding.issuer_tenant).toBe('mumega')
    expect(binding.claimant_identity_id).toBe('ident-7c1')
    expect(binding.claimant_email_sha256).toBe(EMAIL_SHA)
    expect(String(binding.payload_sha256)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('the claimant reference never lands in the task title or body', async () => {
    const res = await post(envelope(payload()))
    const task = harness.sqlite.prepare('SELECT title, body FROM tasks WHERE id = ?').get(res.json.task_id as string) as { title: string; body: string }
    for (const secretish of ['ident-7c1', EMAIL_SHA]) {
      expect(task.title).not.toContain(secretish)
      expect(task.body).not.toContain(secretish)
    }
  })

  it('emits task.created exactly once for the creating delivery', async () => {
    await post(envelope(payload()))
    const created = busSend.mock.calls.filter((c) => (c[0] as { type: string }).type === 'task.created')
    expect(created).toHaveLength(1)
  })
})

describe('idempotent replay (lost response)', () => {
  it('identical redelivery -> 200, same task id, nothing new written, no second event', async () => {
    const first = await post(envelope(payload()))
    const second = await post(envelope(payload()))
    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    expect(second.json.task_id).toBe(first.json.task_id)
    expect(second.json.replayed).toBe(true)
    expect(count('tasks')).toBe(1)
    expect(count('bounty_task_bindings')).toBe(1)
    expect(busSend.mock.calls.filter((c) => (c[0] as { type: string }).type === 'task.created')).toHaveLength(1)
  })

  it('a re-serialised payload (different key order) is still a replay', async () => {
    const first = await post(envelope(payload()))
    const p = payload()
    const reordered = Object.fromEntries(Object.entries(p).reverse())
    const second = await post(envelope(reordered))
    expect(second.status).toBe(200)
    expect(second.json.task_id).toBe(first.json.task_id)
  })

  it('a replay still answers after the task has moved on', async () => {
    const first = await post(envelope(payload()))
    harness.sqlite.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(first.json.task_id as string)
    const second = await post(envelope(payload()))
    expect(second.status).toBe(200)
    expect(second.json.task_id).toBe(first.json.task_id)
  })
})

describe('conflicts never adopt', () => {
  async function seed(): Promise<string> {
    const r = await post(envelope(payload()))
    return r.json.task_id as string
  }

  it.each([
    ['different award_revision', payload({ award_revision: 2 }), 'revision_mismatch'],
    ['changed title', payload({ title: 'A different title' }), 'payload_mismatch'],
    ['changed price', payload({ price_minor: 2000 }), 'payload_mismatch'],
    ['changed gate_owner', payload({ gate_owner: 'gate:someone-else' }), 'payload_mismatch'],
    ['changed done_when', payload({ done_when: 'a quite different acceptance predicate' }), 'payload_mismatch'],
    ['different claimant identity', payload({ claimant_ref: { identity_id: 'ident-other', email_sha256: EMAIL_SHA } }), 'payload_mismatch'],
    ['different issuer tenant', payload({ issuer_tenant: 'someone-else' }), 'payload_mismatch'],
  ])('%s -> 409 and the original task is untouched', async (_n, p, reason) => {
    const taskId = await seed()
    const before = harness.sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId)
    const res = await post(envelope(p))
    expect(res.status).toBe(409)
    expect(res.json.error).toBe('bounty_binding_conflict')
    expect(res.json.reason).toBe(reason)
    expect(res.json.task_id).toBeUndefined()
    expect(count('tasks')).toBe(1)
    expect(count('bounty_task_bindings')).toBe(1)
    expect(harness.sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId)).toEqual(before)
  })

  it('the same bounty (same project) aimed at a different squad -> 409, not a second task', async () => {
    // OTHER_SQUAD may legitimately write PROJECT, so the ONLY difference is the destination squad.
    harness.sqlite.exec(`INSERT INTO project_squad_access (project_id, squad_id, access_level, granted_at)
      VALUES ('${PROJECT}', '${OTHER_SQUAD}', 'write', '2026-10-22T00:00:00.000Z')`)
    await seed()
    const res = await post(envelope(payload(), OTHER_SQUAD))
    expect(res.status).toBe(409)
    expect(res.json.reason).toBe('payload_mismatch')
    expect(count('tasks')).toBe(1)
  })

  it('a task that already holds the key but has no binding is never adopted', async () => {
    harness.sqlite.exec(`
      INSERT INTO tasks (id, squad_id, title, done_when, status, external_source)
        VALUES ('squatter', '${SQUAD}', 'squatter', 'whatever it was', 'open', 'mumega-bounty:bty-001');
    `)
    const res = await post(envelope(payload()))
    expect(res.status).toBe(409)
    expect(res.json.reason).toBe('external_source_taken')
    expect(count('tasks')).toBe(1)
    expect(count('bounty_task_bindings')).toBe(0)
  })
})

describe('concurrency', () => {
  it('five concurrent identical deliveries create exactly one task', async () => {
    // Barrier: no delivery may pass its binding read until ALL five have performed it, so every one of
    // them sees "no binding" and all five attempt the write. Without the barrier the runtime can happen
    // to serialise them and the test would prove nothing.
    const N = 5
    let arrived = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const barrierDb = {
      prepare(sql: string) {
        const stmt = harness.db.prepare(sql)
        if (!/FROM\s+bounty_task_bindings/i.test(sql)) return stmt
        return {
          bind: (...values: unknown[]) => {
            const bound = stmt.bind(...values)
            return {
              first: async <T>(): Promise<T | null> => {
                const row = await bound.first<T>()
                arrived += 1
                if (arrived >= N) release()
                await gate
                return row
              },
            }
          },
        }
      },
      batch: harness.db.batch.bind(harness.db),
    } as unknown as D1Database
    const racing = makeEnv(barrierDb)
    const results = await Promise.all(Array.from({ length: N }, () => post(envelope(payload()), { target: racing })))
    // N first reads, plus the losers' re-reads after their rolled-back write.
    expect(arrived).toBeGreaterThanOrEqual(N)
    expect(results.filter((r) => r.status === 201)).toHaveLength(1)
    expect(results.filter((r) => r.status === 200)).toHaveLength(N - 1)
    expect(new Set(results.map((r) => r.json.task_id)).size).toBe(1)
    expect(bountyTasks()).toBe(1)
    expect(count('bounty_task_bindings')).toBe(1)
  })

  // Deterministic loser path: a winner commits between this delivery's read and its write.
  function envWithWinnerBeforeBatch(winner: () => void | Promise<void>): Env {
    let injected = false
    return makeEnv({
      prepare: harness.db.prepare.bind(harness.db),
      async batch(statements: Parameters<D1Database['batch']>[0]) {
        if (!injected) {
          injected = true
          await winner()
        }
        return harness.db.batch(statements)
      },
    } as unknown as D1Database)
  }

  it('loser of a race against a winner with a DIFFERENT payload gets 409, not a second task or a 500', async () => {
    let winnerTask = ''
    const racing = envWithWinnerBeforeBatch(() => {
      winnerTask = 'winner-task'
      harness.sqlite.exec(`
        INSERT INTO tasks (id, squad_id, title, done_when, status, external_source, created_at, updated_at)
          VALUES ('winner-task', '${SQUAD}', 'w', 'w', 'open', 'mumega-bounty:bty-001', 'x', 'x');
      `)
      harness.sqlite.prepare(`INSERT INTO bounty_task_bindings
          (bounty_id, task_id, award_revision, payload_sha256, issuer_tenant, claimant_identity_id, claimant_email_sha256, created_at)
          VALUES ('bty-001', 'winner-task', 1, ?, 'mumega', 'ident-7c1', ?, 'x')`).run(WINNER_DIGEST_PLACEHOLDER, EMAIL_SHA)
    })
    // The winner row above carries a placeholder digest, so the loser must see a payload mismatch.
    const res = await post(envelope(payload()), { target: racing })
    expect(winnerTask).toBe('winner-task')
    expect(res.status).toBe(409)
    expect(res.json.reason).toBe('payload_mismatch')
    expect(bountyTasks()).toBe(1)
  })

  it('loser of a race whose winner is the SAME delivery recovers it (200, same id)', async () => {
    // The winner is a full, real first delivery that commits between the loser's read and its write.
    let winner: Res | null = null
    const racing = envWithWinnerBeforeBatch(async () => {
      winner = await post(envelope(payload()))
    })
    const loser = await post(envelope(payload()), { target: racing })
    expect(winner).not.toBeNull()
    expect(winner!.status).toBe(201)
    expect(loser.status).toBe(200)
    expect(loser.json.task_id).toBe(winner!.json.task_id)
    expect(loser.json.replayed).toBe(true)
    expect(bountyTasks()).toBe(1)
    expect(count('bounty_task_bindings')).toBe(1)
  })
})

const WINNER_DIGEST_PLACEHOLDER = 'f'.repeat(64)

describe('wrong-tenant isolation', () => {
  it('a squad that is not in this pot -> 404, nothing created', async () => {
    const res = await post(envelope(payload(), 'squad-from-another-pot'))
    expect(res.status).toBe(404)
    expect(count('tasks')).toBe(0)
    expect(count('bounty_task_bindings')).toBe(0)
  })

  it('a project the destination squad cannot write -> 403, nothing created', async () => {
    const res = await post(envelope(payload({ project: OTHER_PROJECT })))
    expect(res.status).toBe(403)
    expect(count('tasks')).toBe(0)
    expect(count('bounty_task_bindings')).toBe(0)
  })

  it('a project that does not exist -> 404, nothing created', async () => {
    const res = await post(envelope(payload({ project: 'no-such-project' })))
    expect(res.status).toBe(404)
    expect(count('tasks')).toBe(0)
  })
})

describe('index scope (additive migration does not break other external sources)', () => {
  it('many tasks may share a non-bounty external_source (event-ingest:<source> is a constant)', async () => {
    for (let i = 0; i < 2; i += 1) {
      const res = await post({
        type: 'lead.captured', source: 'ghl', squad_id: SQUAD, payload: { lead_id: `lead-${i}` },
      })
      expect(res.status).toBe(201)
    }
    expect(count('tasks', "external_source = 'event-ingest:ghl'")).toBe(2)
  })

  it('the database itself refuses two tasks with the same bounty key', () => {
    harness.sqlite.exec(`INSERT INTO tasks (id, squad_id, title, done_when, status, external_source)
      VALUES ('t1', '${SQUAD}', 'a', 'a', 'open', 'mumega-bounty:dup')`)
    expect(() => harness.sqlite.exec(`INSERT INTO tasks (id, squad_id, title, done_when, status, external_source)
      VALUES ('t2', '${SQUAD}', 'b', 'b', 'open', 'mumega-bounty:dup')`)).toThrow(/UNIQUE/)
  })
})
