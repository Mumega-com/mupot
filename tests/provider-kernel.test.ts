// tests/provider-kernel.test.ts — the provider kernel (src/harness/kernel.ts): every dispatch is metered BEFORE launch, behind a kill
// switch; a per-run token is minted and revoked; settlement books usage once; the reconcile cron closes stale runs.
// Real sqlite D1 from the full migration chain; the vendor is faked (fetch stubbed / a fake adapter).

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeTool } from '../src/mcp'
import { dispatchViaKernel, finalizeRun, reconcileProviderRuns } from '../src/harness/kernel'
import { reserveCursorCloudWork } from '../src/cursor/dispatch'
import { dispatchStudioFlight } from '../src/dashboard/studio'
import { cursorCloudAdapter } from '../src/harness/adapters/cursor'
import { registerHarnessAdapter } from '../src/harness/registry'
import { getReservation, insertReservation, markReconciled, computeRequestDigest } from '../src/harness/reservations'
import type { DispatchOutcome, DispatchRequest, HarnessContext, ProviderAdapter, ProviderUsage } from '../src/harness/types'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'mumega'
const CURSOR_OK = { agent: { id: 'bc-11111111-2222-3333-4444-555555555555', name: 'T', status: 'ACTIVE', url: 'https://cursor.com/agents/bc-11111111-2222-3333-4444-555555555555', createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z', latestRunId: 'run-1', repos: [{ url: 'https://github.com/x/y' }] }, run: { id: 'run-11111111-2222-3333-4444-555555555555', agentId: 'bc-11111111-2222-3333-4444-555555555555', status: 'CREATING', createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z' } }
const cursorOk = (): Response => new Response(JSON.stringify(CURSOR_OK), { status: 200, headers: { 'content-type': 'application/json' } })
let h: SqliteD1Harness
const n = (sql: string, ...p: unknown[]): number => Number((h.sqlite.prepare(sql).get(...p) as { n: number }).n)
const one = <T>(sql: string, ...p: unknown[]): T | undefined => h.sqlite.prepare(sql).get(...p) as T | undefined

function envFor(extra: Record<string, unknown> = {}): Env {
  return { DB: h.db, TENANT_SLUG: TENANT, CURSOR_API_TOKEN: 'cursor-secret-token-xyz', BUS: { send: async () => {} }, ...extra } as unknown as Env
}
function auth(): AuthContext {
  return {
    userId: 'member-builder', memberId: 'member-builder', email: 'b@test.com', role: 'member', tenant: TENANT, channel: 'workspace',
    boundAgentId: 'agent-builder', capabilities: [{ member_id: 'member-builder', scope_type: 'squad', scope_id: 'squad-core', capability: 'member' }],
  } as AuthContext
}

beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-core', 'dept-core', 'Core');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-core', 'dept-core', 'squad-core', 'Core Squad');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-builder', 'squad-core', 'agent-builder', 'Agent Builder', 'builder', 't', 'active');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('member-builder', 'b@test.com', 'Builder', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-b', 'member-builder', 'squad', 'squad-core', 'member');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', 'agent-builder', 'member-builder', datetime('now'));
  `)
})
afterEach(() => { h.close(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

// ── a fake provider with a callback and vendor usage (uses the 'codex-cli' kind slot) ───────────────────────────
interface FakeState { seenToken: string | null; status: 'running' | 'done'; usage: ProviderUsage | null; launches: number; refuse: boolean; throws: boolean }
const fake: FakeState = { seenToken: null, status: 'running', usage: null, launches: 0, refuse: false, throws: false }
const fakeAdapter: ProviderAdapter = {
  kind: 'codex-cli',
  capabilities: () => ({ kind: 'codex-cli', launch: true, followUp: false, status: true, cancel: false, asyncAttach: false, requiresRepoUrl: false, requiresApiToken: true, usage: 'vendor_exact', vendorBudget: false, callback: 'mcp_token', webhook: false }),
  isAvailable: () => true,
  credentialNeeds: () => ({ slot: 'openai_api', kinds: ['operator'] }),
  estimate: () => 200_000,
  async launch(env: Env, req: DispatchRequest, ctx?: HarnessContext): Promise<DispatchOutcome> {
    fake.launches++
    fake.seenToken = ctx?.runToken?.raw ?? null
    if (fake.throws) throw new Error('vendor exploded')
    if (fake.refuse) return { accepted: false, error: 'dispatch_failed' }
    const digest = await computeRequestDigest('codex-cli', req)
    const id = crypto.randomUUID()
    const ins = await insertReservation(env, { id, adapter: 'codex-cli', idempotencyKey: req.idempotencyKey, requestDigest: digest, agentId: req.agentId, squadId: req.squadId, actor: req.actor })
    if (ins.outcome !== 'inserted') return { accepted: true, state: 'attached', reservationId: ins.outcome === 'replay' ? ins.row.id : id, taskId: null, flightId: null, adapter: 'codex-cli', idempotencyKey: req.idempotencyKey, replay: true }
    const now = new Date().toISOString()
    await env.DB.prepare(`UPDATE harness_reservations SET state='attached', vendor_agent_id='va', vendor_run_id='vr', attached_at=?2 WHERE id=?1`).bind(id, now).run()
    return { accepted: true, state: 'attached', reservationId: id, taskId: null, flightId: null, adapter: 'codex-cli', idempotencyKey: req.idempotencyKey, replay: false }
  },
  status: async () => { throw new Error('unused') },
  async reconcile(env, reservationId) {
    const row = await getReservation(env, reservationId)
    if (!row) throw new Error('reservation_not_found')
    if (row.state === 'attached' && fake.status === 'done') {
      const changed = await markReconciled(env, reservationId, 'FINISHED')
      return { reservationId, previousState: 'attached', nextState: changed ? 'reconciled' : 'attached', changed }
    }
    return { reservationId, previousState: row.state, nextState: row.state, changed: false }
  },
  dispatch: (env, req, ctx) => fakeAdapter.launch(env, req, ctx),
  usage: async () => fake.usage,
}
beforeEach(() => { registerHarnessAdapter(fakeAdapter); Object.assign(fake, { seenToken: null, status: 'running', usage: null, launches: 0, refuse: false, throws: false }) })

const req = (extra: Partial<DispatchRequest> = {}): DispatchRequest => ({
  name: 'job', prompt: 'do it', squadId: 'squad-core', agentId: 'agent-builder', actor: { kind: 'agent', id: 'agent-builder' }, idempotencyKey: `k-${crypto.randomUUID()}`, ...extra,
})
const setCap = (cents: number | null): void => { h.sqlite.prepare(`UPDATE agents SET budget_cap_cents = ? WHERE id = 'agent-builder'`).run(cents) }
const age = (rid: string): void => { h.sqlite.prepare(`UPDATE harness_reservations SET updated_at = ?2 WHERE id = ?1`).run(rid, new Date(Date.now() - 60_000).toISOString()) }
const reservations = (): number => n(`SELECT COUNT(*) AS n FROM harness_reservations`)

describe('1. unmetered dispatch is impossible', () => {
  it('a cap-hit refuses BEFORE anything is reserved or launched, and raises one decision card (deduped)', async () => {
    setCap(1) // 1 cent; a Cursor run is estimated at 50 cents
    const fetchSpy = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetchSpy)
    const out = await dispatchViaKernel(envFor(), cursorCloudAdapter, { ...req(), repoUrl: 'https://github.com/x/y' })
    expect(out.accepted).toBe(false)
    expect((out as { error: string }).error).toBe('budget_blocked')
    expect((out as { detail?: { reason?: string } }).detail?.reason).toBe('budget_cap_exceeded')
    expect(reservations()).toBe(0)
    expect(fetchSpy).not.toHaveBeenCalled()
    const cards = () => n(`SELECT COUNT(*) AS n FROM tasks WHERE title LIKE 'Budget cap reached:%'`)
    expect(cards()).toBe(1)
    await dispatchViaKernel(envFor(), cursorCloudAdapter, { ...req(), repoUrl: 'https://github.com/x/y' })
    expect(cards()).toBe(1) // one open card, not one per refused attempt
  })

  it('the MCP tool is metered: cursor_dispatch at the cap is a 429 budget_blocked, not a launch', async () => {
    setCap(1)
    const fetchSpy = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetchSpy)
    const r = await invokeTool(auth(), envFor(), 'cursor_dispatch', { name: 'n', repo_url: 'https://github.com/x/y', prompt: 'p' }, 'https://pot.test')
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).toContain('budget_blocked')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(reservations()).toBe(0)
  })

  it('the day dispatch cap also stops a provider run (the meter counts vendor runs now)', async () => {
    const env = envFor({ EXEC_MAX_DISPATCH_DAY: '1' })
    expect((await dispatchViaKernel(env, fakeAdapter, req())).accepted).toBe(true)
    const second = await dispatchViaKernel(env, fakeAdapter, req())
    expect(second.accepted).toBe(false)
    expect((second as { detail?: { reason?: string } }).detail?.reason).toBe('rate_limited')
    expect(fake.launches).toBe(1)
  })

  it('ratchet: nothing outside the kernel and the adapters launches a provider run', () => {
    const root = new URL('../src', import.meta.url).pathname
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [] })
    const offenders = walk(root).filter((f) => {
      const rel = f.slice(root.length + 1)
      if (rel === 'harness/kernel.ts' || rel.startsWith('harness/adapters/')) return false
      const code = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
      return /\b(?:cursorCloudAdapter|grokCliAdapter|requireHarnessAdapter\([^)]*\)|getHarnessAdapter\([^)]*\))\s*(?:\?\.|\.)\s*(?:dispatch|launch)\s*\(/.test(code)
        || (rel !== 'cursor/client.ts' && rel !== 'cursor/dispatch.ts' && /\blaunchCursorAgent\s*\(/.test(code)) // the vendor launch fn: only the adapter's own attach step and the kernel may call it
    })
    expect(offenders).toEqual([])
    expect(readFileSync(new URL('../src/mcp/cursor.ts', import.meta.url), 'utf8')).toContain('dispatchViaKernel(')
  })
})

describe('2. the kill switch blocks launch', () => {
  it('global HARNESS_DISPATCH_DISABLED=1 and a per-provider org_settings row both refuse, with nothing reserved; other providers are unaffected', async () => {
    const off = await dispatchViaKernel(envFor({ HARNESS_DISPATCH_DISABLED: '1' }), fakeAdapter, req())
    expect(off).toMatchObject({ accepted: false, error: 'provider_disabled' })
    expect(fake.launches).toBe(0)
    expect(reservations()).toBe(0)
    h.sqlite.prepare(`INSERT INTO org_settings (key, value) VALUES ('provider_disabled:codex-cli', '1')`).run()
    expect(await dispatchViaKernel(envFor(), fakeAdapter, req())).toMatchObject({ accepted: false, error: 'provider_disabled' })
    expect(fake.launches).toBe(0)
    h.sqlite.prepare(`DELETE FROM org_settings WHERE key = 'provider_disabled:codex-cli'`).run()
    expect((await dispatchViaKernel(envFor(), fakeAdapter, req())).accepted).toBe(true)
  })

  it('fails closed: an unreadable kill-switch row refuses rather than opens', async () => {
    h.sqlite.exec('DROP TABLE org_settings')
    expect(await dispatchViaKernel(envFor(), fakeAdapter, req())).toMatchObject({ accepted: false, error: 'provider_disabled' })
  })
})

describe('3. the per-run token is minted for the run and revoked at finalize', () => {
  const tokenRow = (id: string) => one<{ revoked_at: string | null; expires_at: string | null; agent_id: string | null }>(`SELECT revoked_at, expires_at, agent_id FROM member_tokens WHERE id = ?`, id)

  it('minted before launch (adapter sees it), short-lived and agent-bound, recorded on the reservation, revoked when the run is finalized', async () => {
    const out = await dispatchViaKernel(envFor(), fakeAdapter, req())
    expect(out.accepted).toBe(true)
    const rid = (out as { reservationId: string }).reservationId
    expect(fake.seenToken).toMatch(/^mupot_/)
    const row = (await getReservation(envFor(), rid))!
    expect(row.run_token_id).toBeTruthy()
    const t = tokenRow(row.run_token_id as string)!
    expect(t.revoked_at).toBeNull()
    expect(t.agent_id).toBe('agent-builder')
    const ttlMs = Date.parse(t.expires_at as string) - Date.now()
    expect(ttlMs).toBeGreaterThan(0)
    expect(ttlMs).toBeLessThanOrEqual(120 * 60_000 + 5_000)
    fake.status = 'done'
    age(rid)
    await reconcileProviderRuns(envFor())
    expect(tokenRow(row.run_token_id as string)!.revoked_at).not.toBeNull()
    expect((await getReservation(envFor(), rid))!.finalized_at).not.toBeNull()
  })

  it('a refused launch revokes the token at once; a replay mints none; the raw token is never stored or returned', async () => {
    fake.refuse = true
    expect((await dispatchViaKernel(envFor(), fakeAdapter, req())).accepted).toBe(false)
    const minted = one<{ id: string; revoked_at: string | null }>(`SELECT id, revoked_at FROM member_tokens WHERE label LIKE 'run:%'`)!
    expect(minted.revoked_at).not.toBeNull()
    fake.refuse = false
    const key = 'k-replay'
    await dispatchViaKernel(envFor(), fakeAdapter, req({ idempotencyKey: key }))
    const raw = fake.seenToken as string
    expect(raw).toMatch(/^mupot_/)
    const before = n(`SELECT COUNT(*) AS n FROM member_tokens WHERE label LIKE 'run:%'`)
    const again = await dispatchViaKernel(envFor(), fakeAdapter, req({ idempotencyKey: key }))
    expect((again as { replay: boolean }).replay).toBe(true)
    expect(n(`SELECT COUNT(*) AS n FROM member_tokens WHERE label LIKE 'run:%'`)).toBe(before)
    expect(JSON.stringify(h.sqlite.prepare('SELECT * FROM harness_reservations').all())).not.toContain(raw)
    expect(JSON.stringify(again)).not.toContain(raw)
  })

  it('an adapter with no callback (Cursor) never gets a token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => cursorOk()))
    await dispatchViaKernel(envFor(), cursorCloudAdapter, { ...req(), repoUrl: 'https://github.com/x/y' }, { waitUntil: () => {} })
    expect(n(`SELECT COUNT(*) AS n FROM member_tokens WHERE label LIKE 'run:%'`)).toBe(0)
  })
})

describe('4. finalize books usage once', () => {
  it('vendor usage is booked via recordTokens and the flight cost is metered; a second finalize does nothing', async () => {
    fake.usage = { model: 'm', input: 1000, output: 500, costMicroUsd: 123_456 }
    const out = await dispatchViaKernel(envFor(), fakeAdapter, req())
    const rid = (out as { reservationId: string }).reservationId
    fake.status = 'done'
    age(rid)
    await reconcileProviderRuns(envFor())
    const meter = one<{ cost_micro_usd: number; tokens: number }>(`SELECT cost_micro_usd, tokens FROM execution_meter WHERE window_key LIKE '%agent-builder%'`)!
    expect(meter.cost_micro_usd).toBe(123_456)
    expect(meter.tokens).toBe(1500)
    expect(one(`SELECT usage_cost_micro_usd AS c, usage_estimated AS e FROM harness_reservations WHERE id = ?`, rid)).toEqual({ c: 123_456, e: 0 })
    expect((await finalizeRun(envFor(), rid)).finalized).toBe(false)
    expect(one<{ cost_micro_usd: number }>(`SELECT cost_micro_usd FROM execution_meter WHERE window_key LIKE '%agent-builder%'`)!.cost_micro_usd).toBe(123_456) // no double booking
  })

  it('a provider with no usage (Cursor) books the pre-call ESTIMATE, marked estimated, flight cost_metered = 0', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => cursorOk()))
    const out = await dispatchViaKernel(envFor(), cursorCloudAdapter, { ...req(), repoUrl: 'https://github.com/x/y' })
    const rid = (out as { reservationId: string }).reservationId
    expect((await getReservation(envFor(), rid))!.estimate_micro_usd).toBe(500_000)
    await markReconciled(envFor(), rid, 'FINISHED')
    const fin = await finalizeRun(envFor(), rid)
    expect(fin).toMatchObject({ finalized: true, costMicroUsd: 500_000, estimated: true })
    const row = (await getReservation(envFor(), rid))!
    expect(row.usage_estimated).toBe(1)
    const flight = one<{ cost_micro_usd: number; cost_metered: number }>(`SELECT cost_micro_usd, cost_metered FROM flights WHERE id = ?`, row.flight_id)!
    expect(flight).toEqual({ cost_micro_usd: 500_000, cost_metered: 0 })
  })

  it('a run that failed before launch books nothing', async () => {
    const env = envFor()
    const id = crypto.randomUUID()
    await insertReservation(env, { id, adapter: 'codex-cli', idempotencyKey: 'k-pre', requestDigest: 'a'.repeat(64), agentId: 'agent-builder', squadId: 'squad-core', actor: { kind: 'agent', id: 'agent-builder' } })
    h.sqlite.prepare(`UPDATE harness_reservations SET state = 'failed', last_error = 'reserve_failed' WHERE id = ?`).run(id)
    expect(await finalizeRun(env, id)).toMatchObject({ costMicroUsd: 0, estimated: false })
    expect(n(`SELECT COUNT(*) AS n FROM execution_meter WHERE cost_micro_usd > 0`)).toBe(0)
  })
})

describe('5. the reconcile cron closes stale runs', () => {
  it('an attached run the vendor never reports terminal is closed as stale, settled, and its token revoked', async () => {
    const out = await dispatchViaKernel(envFor(), fakeAdapter, req())
    const rid = (out as { reservationId: string }).reservationId
    const row0 = (await getReservation(envFor(), rid))!
    const old = new Date(Date.now() - 30 * 3_600_000).toISOString()
    h.sqlite.prepare(`UPDATE harness_reservations SET reserved_at = ?2, updated_at = ?2 WHERE id = ?1`).run(rid, old)
    const sweep = await reconcileProviderRuns(envFor())
    expect(sweep.staleClosed).toBe(1)
    const row = (await getReservation(envFor(), rid))!
    expect(row.state).toBe('reconciled')
    expect(row.last_vendor_status).toBe('stale_timeout')
    expect(row.finalized_at).not.toBeNull()
    expect(one<{ revoked_at: string | null }>(`SELECT revoked_at FROM member_tokens WHERE id = ?`, row0.run_token_id)!.revoked_at).not.toBeNull()
  })

  it('a fresh attached run is left alone, and the cron is wired into the maintenance heartbeat', async () => {
    const out = await dispatchViaKernel(envFor(), fakeAdapter, req())
    h.sqlite.prepare(`UPDATE harness_reservations SET updated_at = ?2 WHERE id = ?1`).run((out as { reservationId: string }).reservationId, new Date(Date.now() - 60_000).toISOString())
    const sweep = await reconcileProviderRuns(envFor())
    expect(sweep).toMatchObject({ staleClosed: 0, reconciled: 0, finalized: 0 })
    expect(readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')).toContain("['provider-reconcile', () => reconcileProviderRuns(env)]")
  })
})

describe('6. gate-round fixes', () => {
  const stuckReserved = async (): Promise<string> => {
    const r = await reserveCursorCloudWork(envFor(), { name: 'old', repoUrl: 'https://github.com/x/y', prompt: 'p', squadId: 'squad-core', agentId: 'agent-builder', actor: { kind: 'agent', id: 'agent-builder' }, idempotencyKey: `k-${crypto.randomUUID()}` })
    return r.reservationId
  }
  const ageRow = (rid: string, minutes: number): void => { h.sqlite.prepare(`UPDATE harness_reservations SET updated_at = ?2, reserved_at = ?2 WHERE id = ?1`).run(rid, new Date(Date.now() - minutes * 60_000).toISOString()) }

  it('P0 reconcile never launches: with the kill switch ON and a stuck reserved row, the cron makes no vendor call and releases the row (task blocked)', async () => {
    const rid = await stuckReserved()
    ageRow(rid, 30)
    const fetchSpy = vi.fn(async () => cursorOk())
    vi.stubGlobal('fetch', fetchSpy)
    const sweep = await reconcileProviderRuns(envFor({ HARNESS_DISPATCH_DISABLED: '1' }))
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(sweep.released).toBe(1)
    const row = (await getReservation(envFor(), rid))!
    expect(row.state).toBe('failed')
    expect(row.last_error).toContain('released_unlaunched')
    expect(one<{ status: string }>(`SELECT status FROM tasks WHERE id = ?`, row.task_id)!.status).toBe('blocked')
  })

  it('P0 a fresh reserved row is left to its attacher and never attached by the cron, switch on or off; a stuck attaching row closes as launch_unconfirmed', async () => {
    const fresh = await stuckReserved()
    const fetchSpy = vi.fn(async () => cursorOk())
    vi.stubGlobal('fetch', fetchSpy)
    h.sqlite.prepare(`UPDATE harness_reservations SET updated_at = ?2 WHERE id = ?1`).run(fresh, new Date(Date.now() - 60_000).toISOString())
    await reconcileProviderRuns(envFor())
    expect(fetchSpy).not.toHaveBeenCalled()
    expect((await getReservation(envFor(), fresh))!.state).toBe('reserved')
    const stuck = await stuckReserved()
    h.sqlite.prepare(`UPDATE harness_reservations SET state = 'attaching', attach_lease_id = 'l', attach_lease_until = ?2 WHERE id = ?1`).run(stuck, new Date(Date.now() - 3_600_000).toISOString())
    ageRow(stuck, 30)
    await reconcileProviderRuns(envFor())
    expect(fetchSpy).not.toHaveBeenCalled()
    const row = (await getReservation(envFor(), stuck))!
    expect(row.state).toBe('failed')
    expect(row.last_error).toContain('launch_unconfirmed')
  })

  it('P0 Studio is not a bypass: with the kill switch on, a Studio dispatch makes no vendor call; at a cap it is refused and the slot is released', async () => {
    const fetchSpy = vi.fn(async () => cursorOk())
    vi.stubGlobal('fetch', fetchSpy)
    const input = { prompt: 'build it', repoUrl: 'https://github.com/x/y', model: 'cursor-cloud' }
    const off = await dispatchStudioFlight(envFor({ HARNESS_DISPATCH_DISABLED: '1' }), auth(), input)
    expect(off).toMatchObject({ ok: false, error: 'provider_disabled' })
    setCap(1)
    const capped = await dispatchStudioFlight(envFor(), auth(), input)
    expect(capped).toMatchObject({ ok: false, status: 429, error: 'budget_blocked' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('P1 the dollar cap is RESERVED: six 20-cent runs against a $1 cap, only five are accepted; finalize settles to the real cost', async () => {
    setCap(100)
    const env = envFor()
    const rids: string[] = []
    let accepted = 0
    for (let i = 0; i < 6; i++) {
      const out = await dispatchViaKernel(env, fakeAdapter, req())
      if (out.accepted) { accepted++; rids.push(out.reservationId) }
    }
    expect(accepted).toBe(5)
    expect(one<{ c: number }>(`SELECT cost_micro_usd AS c FROM execution_meter WHERE window_key LIKE '%agent-builder%'`)!.c).toBe(1_000_000)
    // the vendor reports a cheaper real cost for one run: the window gives the difference back
    fake.usage = { costMicroUsd: 50_000 }
    fake.status = 'done'
    age(rids[0] as string)
    await reconcileProviderRuns(env, 1)
    expect(one<{ c: number }>(`SELECT cost_micro_usd AS c FROM execution_meter WHERE window_key LIKE '%agent-builder%'`)!.c).toBe(1_000_000 - 200_000 + 50_000)
  })

  it('P1 a refused launch and a thrown launch both refund the slot; the token of a thrown launch is revoked', async () => {
    const env = envFor()
    fake.refuse = true
    await dispatchViaKernel(env, fakeAdapter, req())
    const slot = () => one<{ c: number; n: number }>(`SELECT cost_micro_usd AS c, count AS n FROM execution_meter WHERE window_key LIKE '%agent-builder%'`)
    expect(slot()).toEqual({ c: 0, n: 0 })
    fake.refuse = false
    fake.throws = true
    await expect(dispatchViaKernel(env, fakeAdapter, req())).rejects.toThrow('vendor exploded')
    expect(slot()).toEqual({ c: 0, n: 0 })
    const tokens = h.sqlite.prepare(`SELECT revoked_at FROM member_tokens WHERE label LIKE 'run:%'`).all() as Array<{ revoked_at: string | null }>
    expect(tokens.length).toBeGreaterThan(0)
    expect(tokens.every((t) => t.revoked_at !== null)).toBe(true)
  })

  it('P2 concurrent finalize: two settlers, one booking', async () => {
    fake.usage = { costMicroUsd: 90_000, input: 10, output: 5 }
    const out = await dispatchViaKernel(envFor(), fakeAdapter, req())
    const rid = (out as { reservationId: string }).reservationId
    h.sqlite.prepare(`UPDATE harness_reservations SET state = 'reconciled', reconciled_at = datetime('now') WHERE id = ?`).run(rid)
    const [a, b] = await Promise.all([finalizeRun(envFor(), rid), finalizeRun(envFor(), rid)])
    expect([a.finalized, b.finalized].filter(Boolean)).toHaveLength(1)
    expect(one<{ c: number }>(`SELECT cost_micro_usd AS c FROM execution_meter WHERE window_key LIKE '%agent-builder%'`)!.c).toBe(90_000)
  })

  it('P2 the same idempotency key raced concurrently counts the dispatch once', async () => {
    const key = 'k-race'
    const [a, b] = await Promise.all([dispatchViaKernel(envFor(), fakeAdapter, req({ idempotencyKey: key })), dispatchViaKernel(envFor(), fakeAdapter, req({ idempotencyKey: key }))])
    expect(a.accepted && b.accepted).toBe(true)
    expect(one<{ n: number }>(`SELECT count AS n FROM execution_meter WHERE window_key LIKE '%agent-builder%'`)!.n).toBe(1)
    expect(reservations()).toBe(1)
  })

  it('P2 a bound member above member tier gets NO run token: the dispatch is refused and its slot refunded', async () => {
    h.sqlite.exec(`UPDATE capabilities SET capability = 'lead' WHERE id = 'cap-b'`)
    const out = await dispatchViaKernel(envFor(), fakeAdapter, req())
    expect(out).toMatchObject({ accepted: false, error: 'budget_blocked', detail: { reason: 'run_token_unavailable' } })
    expect(fake.launches).toBe(0)
    expect(one<{ n: number }>(`SELECT count AS n FROM execution_meter WHERE window_key LIKE '%agent-builder%'`)!.n).toBe(0)
  })

  it('P2 reconcile fairness: with a batch of 1, successive sweeps rotate through running runs instead of re-checking the oldest', async () => {
    const a = (await dispatchViaKernel(envFor(), fakeAdapter, req())) as { reservationId: string }
    const b = (await dispatchViaKernel(envFor(), fakeAdapter, req())) as { reservationId: string }
    for (const [i, r] of [a, b].entries()) h.sqlite.prepare(`UPDATE harness_reservations SET updated_at = ?2 WHERE id = ?1`).run(r.reservationId, new Date(Date.now() - (120 - i) * 60_000).toISOString())
    await reconcileProviderRuns(envFor(), 1)
    await reconcileProviderRuns(envFor(), 1)
    const checked = (id: string) => one<{ t: string | null }>(`SELECT reconcile_checked_at AS t FROM harness_reservations WHERE id = ?`, id)!.t
    expect(checked(a.reservationId)).not.toBeNull()
    expect(checked(b.reservationId)).not.toBeNull()
  })

  it('P0 the kill switch is re-checked at attach: switched off between reserve and attach, the vendor is never called and the run is released', async () => {
    const { attachCursorCloudExecution } = await import('../src/cursor/dispatch')
    const rid = await stuckReserved()
    const fetchSpy = vi.fn(async () => cursorOk())
    vi.stubGlobal('fetch', fetchSpy)
    const r = await attachCursorCloudExecution(envFor({ HARNESS_DISPATCH_DISABLED: '1' }), rid)
    expect(r).toMatchObject({ state: 'failed', error: 'provider_disabled' })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect((await getReservation(envFor(), rid))!.state).toBe('failed')
  })
})
