// tests/admission-tape.test.ts — admission by observation, P0 (SHADOW ONLY).
// Pure layer (rules scorer, arg shape), store layer (real sqlite D1 from the full migration chain), and the real
// handler (mcpApp -> seat session -> invokeTool) for flag-off identity, the tap, and whoami.admission.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { interceptDb, sqlAll, sqlGet, sqlRun } from './helpers/db-intercept'
import { call, newWorld, oauthClient, HARNESS_CHOICE, type Json, type World } from './helpers/door-clients'
import { buildAuthContextFromProps } from '../src/mcp/oauth-authorize'
import { invokeTool } from '../src/mcp/index'
import {
  TAPE_THRESHOLDS, describeArgs, hasSecretLike, isDestructiveTool, scoreWindow, windowIsFull, type TapeEvent,
} from '../src/admission/tape-rules'
import { admissionTapeEnabled, buildTapeEvent, computeTapeHash, recordTapeCall, resetTapeStatsForTest, tapToolCall, tapeStats } from '../src/admission/tape-store'
import type { AuthContext, Env } from '../src/types'

afterEach(() => { vi.unstubAllGlobals(); resetTapeStatsForTest() })

const T0 = Date.parse('2026-10-18T12:00:00.000Z')
function ev(over: Partial<TapeEvent> = {}): TapeEvent {
  return { seat_id: 's1', member_id: 'm1', squad: 'sq0', tool: 'task_list', min: 'observer', status: 200, error: null, arg_shape: { keys: {} }, target_drift: false, t: T0, ...over }
}
const spread = (n: number, step: number, mk: (i: number) => Partial<TapeEvent> = () => ({})): TapeEvent[] => Array.from({ length: n }, (_, i) => ev({ t: T0 + i * step, ...mk(i) }))

const callOf = (tool: string, args: Record<string, unknown>, now: number, ok = true) => ({ tool, min: 'observer', args, outcome: ok ? ({ ok: true } as const) : ({ ok: false, status: 403, error: 'forbidden' } as const), now })

// ── arg shape ──────────────────────────────────────────────────────────────────────────────────────────────────
describe('describeArgs: shape only, never values', () => {
  const RAW = {
    title: 'quarterly plan for ACME corp',
    url: 'https://example.com/private/path?x=1',
    to: 'victim@example.com',
    task_id: '3f2b8c1e-1111-4222-8333-444455556666',
    api_key: 'sk-live-ABCDEFGHIJKLMNOPQRSTUVWX',
    nested: { password: 'hunter2hunter2' },
    list: ['alpha-secret-value', 'beta'],
    n: 42,
    flag: true,
  }
  const shape = describeArgs(RAW)

  it('contains no raw value anywhere in its serialisation', () => {
    const s = JSON.stringify(shape)
    for (const raw of ['quarterly plan', 'ACME', 'example.com', 'victim', '3f2b8c1e', 'sk-live', 'ABCDEFGH', 'hunter2', 'alpha-secret', 'beta']) {
      expect(s, `raw value fragment ${raw} leaked`).not.toContain(raw)
    }
  })
  it('records key names, lengths and classes', () => {
    expect(shape.keys.title).toEqual({ type: 'string', len: RAW.title.length })
    expect(shape.keys.url.classes).toEqual(['url'])
    expect(shape.keys.to.classes).toEqual(['email'])
    expect(shape.keys.task_id.classes).toEqual(['id'])
    expect(shape.keys.api_key.classes).toContain('secret_like')
    expect(shape.keys.nested.classes).toBeUndefined() // 'hunter2' has no value-pattern; object leaves are scanned by value patterns only
    expect(shape.keys.list).toMatchObject({ type: 'array', len: 2 })
    expect(shape.keys.n).toEqual({ type: 'number' })
  })
  it('negative: a plain sentence and a bare uuid are not secret-like', () => {
    expect(hasSecretLike(describeArgs({ text: 'please summarise the board', id: '3f2b8c1e-1111-4222-8333-444455556666' }))).toBe(false)
  })
  it('positive: value patterns (jwt, github, pem, long hex that is not an id) are secret-like under an innocent key', () => {
    for (const v of ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghij', 'ghp_abcdefghijklmnopqrstuvwxyz0123', '-----BEGIN RSA PRIVATE KEY-----\nabc', 'a'.repeat(64) + 'Z']) {
      expect(hasSecretLike(describeArgs({ note: v })), v.slice(0, 12)).toBe(true)
    }
  })
  it('a secret nested in an object is classed, not copied', () => {
    const shape = describeArgs({ cfg: { note: 'ghp_abcdefghijklmnopqrstuvwxyz0123' } })
    expect(shape.keys.cfg.classes).toEqual(['secret_like'])
    expect(JSON.stringify(shape)).not.toContain('ghp_abc')
    expect(hasSecretLike(describeArgs({ cfg: { note: 'hello' } }))).toBe(false)
  })
  it('a secret inside an array is classed, not copied', () => {
    const shape = describeArgs({ items: ['ghp_abcdefghijklmnopqrstuvwxyz0123'] })
    expect(shape.keys.items.classes).toEqual(['secret_like'])
    expect(JSON.stringify(shape)).not.toContain('ghp_abc')
    expect(hasSecretLike(describeArgs({ items: ['a'] }))).toBe(false)
  })
  it('bounds a hostile key name', () => {
    const k = 'k'.repeat(500)
    expect(Object.keys(describeArgs({ [k]: 'x' }).keys)[0].length).toBe(64)
  })
})

// ── rule signals ───────────────────────────────────────────────────────────────────────────────────────────────
describe('scoreWindow: each signal, positive and negative', () => {
  it('quiet window: score 0, no trips, no hold', () => {
    const s = scoreWindow(spread(10, 60_000))
    expect(s).toMatchObject({ score: 0, hard_trips: [], would_hold: false })
  })
  it('scope drift: positive trips scope_drift and scores; negative does not', () => {
    const pos = scoreWindow(spread(5, 60_000, (i) => ({ target_drift: i === 0 })))
    expect(pos.signals.drift).toBe(1)
    expect(pos.hard_trips).toContain('scope_drift')
    expect(pos.score).toBe(TAPE_THRESHOLDS.drift.per)
    expect(pos.would_hold).toBe(true)
    expect(scoreWindow(spread(5, 60_000)).hard_trips).not.toContain('scope_drift')
  })
  it('destructive verbs: positive scores without a hard trip; negative scores 0', () => {
    const pos = scoreWindow(spread(3, 60_000, () => ({ tool: 'archive_row' })))
    expect(pos.signals.destructive).toBe(3)
    expect(pos.score).toBe(3 * TAPE_THRESHOLDS.destructive.per)
    expect(pos.hard_trips).toEqual([])
    expect(isDestructiveTool('task_verdict')).toBe(true)
    expect(isDestructiveTool('revoke_agent_token')).toBe(true)
    expect(isDestructiveTool('task_list')).toBe(false)
    expect(isDestructiveTool('recall')).toBe(false)
  })
  it('destructive points are capped', () => {
    expect(scoreWindow(spread(9, 60_000, () => ({ tool: 'archive_row' }))).score).toBe(TAPE_THRESHOLDS.destructive.cap)
  })
  it('secret-like arg on an OUTBOUND tool is a hard trip; same arg on a non-outbound tool is not', () => {
    const shape = describeArgs({ body: 'ghp_abcdefghijklmnopqrstuvwxyz0123' })
    expect(scoreWindow([ev({ tool: 'send', arg_shape: shape })]).hard_trips).toContain('secret_outbound')
    expect(scoreWindow([ev({ tool: 'task_get', arg_shape: shape })]).hard_trips).not.toContain('secret_outbound')
    expect(scoreWindow([ev({ tool: 'send', arg_shape: describeArgs({ body: 'hello' }) })]).hard_trips).toEqual([])
  })
  it('3 floor refusals in 5 minutes is a probe; 2, or 3 spread over 20 minutes, is not', () => {
    const refuse = (): Partial<TapeEvent> => ({ status: 403, error: 'forbidden', tool: 'task_update' })
    expect(scoreWindow(spread(3, 60_000, refuse)).hard_trips).toContain('floor_probe')
    expect(scoreWindow(spread(2, 60_000, refuse)).hard_trips).not.toContain('floor_probe')
    expect(scoreWindow(spread(3, 10 * 60_000, refuse)).hard_trips).not.toContain('floor_probe')
    // a 404 or a validation failure is not a floor refusal
    expect(scoreWindow(spread(3, 1000, () => ({ status: 400, error: 'invalid_args' }))).hard_trips).toEqual([])
  })
  it('cross-tenant: any tenant-mismatch error is a hard trip', () => {
    expect(scoreWindow([ev({ status: 403, error: 'tenant_mismatch' })]).hard_trips).toContain('cross_tenant')
    expect(scoreWindow([ev({ status: 403, error: 'not_found' })]).hard_trips).not.toContain('cross_tenant')
  })
  it('hard-list tool attempted is a hard trip', () => {
    expect(scoreWindow([ev({ tool: 'mint_agent_token', status: 403, error: 'forbidden' })]).hard_trips).toContain('hard_list_tool')
    expect(scoreWindow([ev({ tool: 'task_list' })]).hard_trips).not.toContain('hard_list_tool')
  })
  it('velocity: a burst scores; a slow stream and a short burst do not', () => {
    const burst = scoreWindow(spread(20, 1000)) // 60 per minute
    expect(burst.score).toBe(TAPE_THRESHOLDS.velocity.redPoints)
    expect(burst.hard_trips).toEqual([])
    expect(scoreWindow(spread(20, 60_000)).score).toBe(0)
    expect(scoreWindow(spread(4, 100)).score).toBe(0) // under minEvents
  })
  it('score at or above the threshold would hold even with no hard trip', () => {
    const s = scoreWindow(spread(20, 1000, (i) => ({ tool: i < 4 ? 'archive_row' : 'task_list' }))) // destructive 40 + velocity 35 = 75
    expect(s.hard_trips).toEqual([])
    expect(s.score).toBeGreaterThanOrEqual(TAPE_THRESHOLDS.holdScore)
    expect(s.would_hold).toBe(true)
  })
  it('score is clamped to 0-100', () => {
    const s = scoreWindow(spread(20, 100, () => ({ tool: 'archive_row', target_drift: true, status: 403, error: 'forbidden' })))
    expect(s.score).toBeLessThanOrEqual(100)
  })
  it('window closes at 20 events or 10 minutes', () => {
    expect(windowIsFull(spread(19, 1000), T0 + 19_000)).toBe(false)
    expect(windowIsFull(spread(20, 1000), T0 + 20_000)).toBe(true)
    expect(windowIsFull(spread(2, 1000), T0 + TAPE_THRESHOLDS.windowMs)).toBe(true)
    expect(windowIsFull([], T0)).toBe(false)
  })
})

// ── store + real handler ───────────────────────────────────────────────────────────────────────────────────────
interface SeatWorld { w: World; env: Env; seatId: string; auth: AuthContext; call: (name: string, args?: Json) => Promise<unknown> }

async function seatWorld(flag: '1' | undefined): Promise<SeatWorld> {
  const w = newWorld()
  const env = { ...w.env, ...(flag ? { ADMISSION_TAPE: flag } : {}) } as Env
  w.env = env
  const c = await oauthClient(w, 'chatgpt', 'ChatGPT', HARNESS_CHOICE, { 'openai/session': 'conv-tape-1' })
  const boot = (await call(w, c, 'boot_context')).body
  const seatId = String((boot.whoami as { seat?: { seat_id?: string } }).seat?.seat_id)
  const base = await buildAuthContextFromProps(env, c.props as unknown as Parameters<typeof buildAuthContextFromProps>[1]) // props are the consent handler's own OAuthMemberProps
  if (!base) throw new Error('no auth')
  await new Promise((r) => setTimeout(r, 50)) // let the boot call's own (fire-and-forget) tap settle, then start from an empty tape
  w.h.sqlite.exec('DELETE FROM seat_tape_window')
  const auth: AuthContext = { ...base, seatBinding: { seatId, label: 'x', harnessId: 'h', grantTokenId: 't', humanMemberId: 'mem-human', source: 'auto:openai_session' } }
  return { w, env, seatId, auth, call: async (name, args = {}) => (await call(w, c, name, args)).body }
}

const tapeRows = (w: World): Array<Record<string, unknown>> => sqlAll(w.h, 'SELECT * FROM seat_tape ORDER BY window_end, rowid')
const windowRows = (w: World): number => Number(sqlGet(w.h, 'SELECT COUNT(*) AS n FROM seat_tape_window')!.n)

describe('buildTapeEvent: scope drift is computed at tap time, the target is not kept', () => {
  const auth = { tenant: 't', userId: 'u', seatBinding: { seatId: 's1', label: 'x', harnessId: 'h', grantTokenId: 'g', humanMemberId: 'm1', source: 'handle' } } as AuthContext // minimal seat auth; only seatBinding is read
  const facts = { squadId: 'sq-own-id', squadSlug: 'own' }
  const mk = (args: Record<string, unknown>) => buildTapeEvent(auth, callOf('squad_message', args, T0), facts)
  it('own squad by slug or id: no drift; another squad: drift; no target: no drift', () => {
    expect(mk({ squad: 'own' })?.target_drift).toBe(false)
    expect(mk({ squad_id: 'sq-own-id' })?.target_drift).toBe(false)
    expect(mk({ squad: 'other' })?.target_drift).toBe(true)
    expect(mk({ to_squad: 'other' })?.target_drift).toBe(true)
    expect(mk({ body: 'x' })?.target_drift).toBe(false)
  })
  it('the event holds the verdict, never the target value', () => {
    expect(JSON.stringify(mk({ squad: 'secret-other-squad' }))).not.toContain('secret-other-squad')
  })
  it('no seat, no event', () => {
    const { seatBinding: _s, ...noSeat } = auth // eslint-disable-line @typescript-eslint/no-unused-vars
    expect(buildTapeEvent(noSeat as AuthContext, callOf('task_list', {}, T0), facts)).toBeNull() // rest of an AuthContext is an AuthContext
  })
})

describe('seat_tape: append-only and hash-chained', () => {
  it('UPDATE and DELETE are refused by trigger', async () => {
    const sw = await seatWorld('1')
    try {
      for (let i = 0; i < 20; i++) await recordTapeCall(sw.env, sw.auth, callOf('task_list', {}, T0 + i * 1000))
      expect(tapeRows(sw.w)).toHaveLength(1)
      expect(() => sw.w.h.sqlite.exec("UPDATE seat_tape SET score = 0")).toThrow(/append-only/)
      expect(() => sw.w.h.sqlite.exec("UPDATE seat_tape SET would_hold = 1")).toThrow(/append-only/)
      expect(() => sw.w.h.sqlite.exec("DELETE FROM seat_tape")).toThrow(/append-only/)
      expect(tapeRows(sw.w)).toHaveLength(1)
    } finally { sw.w.h.close() }
  })
  it('rows link: prev_hash is the previous row_hash and row_hash recomputes; a forked prev_hash is refused', async () => {
    const sw = await seatWorld('1')
    try {
      for (let win = 0; win < 3; win++) for (let i = 0; i < 20; i++) await recordTapeCall(sw.env, sw.auth, callOf('task_list', {}, T0 + (win * 20 + i) * 1000))
      const rows = tapeRows(sw.w)
      expect(rows).toHaveLength(3)
      expect(rows[0].prev_hash).toBe('')
      for (let i = 0; i < 3; i++) {
        if (i > 0) expect(rows[i].prev_hash).toBe(rows[i - 1].row_hash)
        const r = rows[i]
        const recomputed = await computeTapeHash(String(r.prev_hash), {
          id: String(r.id), seat_id: String(r.seat_id), member_id: String(r.member_id), window_start: String(r.window_start), window_end: String(r.window_end),
          event_count: Number(r.event_count), score: Number(r.score), signals: String(r.signals),
          status_before: r.status_before === null ? null : String(r.status_before), status_after: r.status_after === null ? null : String(r.status_after), would_hold: Number(r.would_hold),
        })
        expect(recomputed).toBe(r.row_hash)
      }
      // two writers racing on the same head: the second link to the same prev_hash is rejected by the unique index
      expect(() => sw.w.h.sqlite.exec(`INSERT INTO seat_tape (id, seat_id, member_id, window_start, window_end, event_count, score, signals, would_hold, prev_hash, row_hash)
        VALUES ('fork', '${sw.seatId}', 'm', 'a', 'b', 1, 0, '{}', 0, '${String(rows[0].prev_hash)}', '${'f'.repeat(64)}')`)).toThrow(/UNIQUE/i)
    } finally { sw.w.h.close() }
  })
  it('stores no raw value: a secret in the args does not appear anywhere in the tape or window tables', async () => {
    const sw = await seatWorld('1')
    try {
      const RAW = 'sk-live-ABCDEFGHIJKLMNOPQRSTUVWX'
      for (let i = 0; i < 19; i++) await recordTapeCall(sw.env, sw.auth, callOf('send', { body: RAW, to: 'victim@example.com' }, T0 + i * 1000))
      expect(JSON.stringify(sqlAll(sw.w.h, 'SELECT events_json FROM seat_tape_window'))).not.toContain('ABCDEFGH')
      await recordTapeCall(sw.env, sw.auth, callOf('send', { body: RAW }, T0 + 19_000))
      const all = JSON.stringify(tapeRows(sw.w)) + JSON.stringify(sqlAll(sw.w.h, 'SELECT * FROM seat_tape_window'))
      expect(all).not.toContain('ABCDEFGH')
      expect(all).not.toContain('victim')
      expect(String(tapeRows(sw.w)[0].signals)).toContain('secret_outbound')
    } finally { sw.w.h.close() }
  })
})

describe('SHADOW: record would_hold, change nothing else', () => {
  it('a tripping window records would_hold=1 but never sets admission_status, creates tasks, or notifies', async () => {
    const sw = await seatWorld('1')
    try {
      const tasksBefore = Number(sqlGet(sw.w.h, 'SELECT COUNT(*) AS n FROM tasks')!.n)
      for (let i = 0; i < 20; i++) await recordTapeCall(sw.env, sw.auth, callOf('mint_agent_token', {}, T0 + i * 1000, false))
      const rows = tapeRows(sw.w)
      expect(rows[0].would_hold).toBe(1)
      expect(String(rows[0].signals)).toContain('hard_list_tool')
      expect(sqlGet(sw.w.h, 'SELECT admission_status AS s FROM agent_seats WHERE id = ?', sw.seatId)!.s).toBeNull()
      expect(Number(sqlGet(sw.w.h, 'SELECT COUNT(*) AS n FROM tasks')!.n)).toBe(tasksBefore)
      // and the live call path is not blocked: a tripping window does not change what the next call returns
      const out = await invokeTool(sw.auth, sw.env, 'task_get', {})
      expect(out.ok === false && out.error).toBe('forbidden') // the ordinary floor answer for this caller, not a hold
    } finally { sw.w.h.close() }
  })
})

describe('flag ADMISSION_TAPE', () => {
  it('is strict "1"; default off', () => {
    expect(admissionTapeEnabled({})).toBe(false)
    expect(admissionTapeEnabled({ ADMISSION_TAPE: 'true' })).toBe(false)
    expect(admissionTapeEnabled({ ADMISSION_TAPE: '1' })).toBe(true)
  })

  it('OFF: no tap, no D1 touch of the tape tables, and the outcome equals the flag-on outcome', async () => {
    const off = await seatWorld(undefined)
    const on = await seatWorld('1')
    try {
      const waits: Promise<unknown>[] = []
      const run = (sw: SeatWorld) => Promise.all([
        invokeTool(sw.auth, sw.env, 'task_get', {}, { waitUntil: (p) => { waits.push(p) } }),
        invokeTool(sw.auth, sw.env, 'task_list', {}, { waitUntil: (p) => { waits.push(p) } }),
        invokeTool(sw.auth, sw.env, 'mint_agent_token', {}, { waitUntil: (p) => { waits.push(p) } }),
      ])
      const [a, b] = [await run(off), await run(on)]
      await Promise.all(waits)
      expect(JSON.stringify(a)).toBe(JSON.stringify(b)) // the tap never changes a response
      expect(windowRows(off.w)).toBe(0)
      expect(windowRows(on.w)).toBe(1) // the flag-on seat has its window: the tap really ran
      // and flag off never even issued a statement against the tape tables
      const prepared: string[] = []
      const spy = { ...off.env, DB: interceptDb(off.env.DB, /seat_tape|admission_status/, 'observe', prepared) } as Env
      await invokeTool(off.auth, spy, 'task_get', {})
      expect(prepared.filter((s) => /seat_tape|admission_status/.test(s))).toEqual([])
    } finally { off.w.h.close(); on.w.h.close() }
  })

  it('a tap that fails is swallowed and counted, and the response is unchanged and not delayed', async () => {
    const sw = await seatWorld('1')
    try {
      const baseline = await invokeTool(sw.auth, sw.env, 'task_get', {})
      for (const mode of ['reject', 'throw-sync'] as const) {
        resetTapeStatsForTest()
        const broken = { ...sw.env, DB: interceptDb(sw.env.DB, /seat_tape|admission_status|agent_seats/, mode === 'reject' ? 'reject' : 'throw-sync') } as Env
        const waits: Promise<unknown>[] = []
        const out = await invokeTool(sw.auth, broken, 'task_get', {}, { waitUntil: (p) => { waits.push(p) } })
        expect(JSON.stringify(out)).toBe(JSON.stringify(baseline))
        await Promise.all(waits) // waitUntil promises never reject
        expect(tapeStats().errors, mode).toBe(1)
      }
      // tapToolCall itself never throws, even with a waitUntil that throws
      expect(() => tapToolCall(sw.env, sw.auth, callOf('task_list', {}, T0), () => { throw new Error('wu') })).not.toThrow()
    } finally { sw.w.h.close() }
  })

  it('a hanging tap does not delay the response', async () => {
    const sw = await seatWorld('1')
    try {
      const hung = { ...sw.env, DB: interceptDb(sw.env.DB, /seat_tape|agent_seats/, 'hang') } as Env
      const waits: Promise<unknown>[] = []
      const out = await Promise.race([
        invokeTool(sw.auth, hung, 'task_get', {}, { waitUntil: (p) => { waits.push(p) } }),
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 2000)),
      ])
      expect(out).not.toBe('timeout')
      expect(waits).toHaveLength(1) // the work was handed to waitUntil, not awaited
    } finally { sw.w.h.close() }
  })

  it('a non-seat session is not tapped', async () => {
    const sw = await seatWorld('1')
    try {
      const { seatBinding: _s, ...noSeat } = sw.auth // eslint-disable-line @typescript-eslint/no-unused-vars
      const waits: Promise<unknown>[] = []
      await invokeTool(noSeat as AuthContext, sw.env, 'task_get', {}, { waitUntil: (p) => { waits.push(p) } }) // the destructured rest of an AuthContext is an AuthContext
      await Promise.all(waits)
      expect(windowRows(sw.w)).toBe(0)
    } finally { sw.w.h.close() }
  })

  it('the real handler taps a seat call through to a window row (flag on)', async () => {
    const sw = await seatWorld('1')
    try {
      await sw.call('status')
      await vi.waitFor(() => expect(windowRows(sw.w)).toBe(1))
      const win = String(sqlGet(sw.w.h, 'SELECT events_json FROM seat_tape_window')!.events_json)
      expect(win).toContain('"tool":"status"')
    } finally { sw.w.h.close() }
  })
})

describe('whoami.admission', () => {
  const admissionOf = (b: Json): unknown => (b.whoami as Json).admission

  it('flag off: never present, even when the seat has a status', async () => {
    const sw = await seatWorld(undefined)
    try {
      sqlRun(sw.w.h, "UPDATE agent_seats SET admission_status = 'observed' WHERE id = ?", sw.seatId)
      expect('admission' in (((await sw.call('status')).whoami) as Json)).toBe(false)
    } finally { sw.w.h.close() }
  })
  it('flag on, status NULL: absent (additive only when the seat has a status)', async () => {
    const sw = await seatWorld('1')
    try { expect(admissionOf((await sw.call('status')) as Json)).toBeUndefined() } finally { sw.w.h.close() }
  })
  it('flag on, status set: {status, reason_class} and nothing else; the score never appears', async () => {
    const sw = await seatWorld('1')
    try {
      sqlRun(sw.w.h, "UPDATE agent_seats SET admission_status = 'observed' WHERE id = ?", sw.seatId)
      for (let i = 0; i < 20; i++) await recordTapeCall(sw.env, sw.auth, callOf('archive_row', {}, T0 + i * 1000)) // a scored window exists
      expect(tapeRows(sw.w)).toHaveLength(1)
      const body = (await sw.call('status')) as Json
      expect(admissionOf(body)).toEqual({ status: 'observed', reason_class: 'new_seat_observed' })
      for (const k of ['score', 'would_hold', 'signals', 'threshold']) expect(JSON.stringify(body.whoami)).not.toContain(k)
    } finally { sw.w.h.close() }
  })
  it('the status column only accepts the closed vocabulary', async () => {
    const sw = await seatWorld('1')
    try { expect(() => sqlRun(sw.w.h, "UPDATE agent_seats SET admission_status = 'banned' WHERE id = ?", sw.seatId)).toThrow() } finally { sw.w.h.close() }
  })
})
