import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { upsertHarness } from '../src/members/harness'
import { buildAuthContextFromProps } from '../src/mcp/oauth-authorize'
import { mcpApp } from '../src/mcp/index'
import { mcpInternalRequest } from '../src/mcp/internal-dispatch'
import { resetHarnessProbeSampling } from '../src/mcp/harness-identity-probe'
import { mintSeatHandle } from '../src/members/seat-handle'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'mumega'
function memoryKv() { const s = new Map<string, string>(); return { async get(k: string, t?: string) { const v = s.get(k); return v === undefined ? null : t === 'json' ? JSON.parse(v) : v }, async put(k: string, v: string) { s.set(k, v) }, async delete(k: string) { s.delete(k) } } }
let h: SqliteD1Harness
const envFor = (extra: Record<string, unknown> = {}): Env => ({ DB: h.db, TENANT_SLUG: TENANT, SESSIONS: memoryKv(), ...extra } as unknown as Env)
beforeEach(() => { h = createSqliteD1(); applyAllMigrations(h.sqlite); h.sqlite.exec(`INSERT INTO members (id, email, display_name, status, created_at, tenant) VALUES ('m1','m1@x.test','M1','active','2026-10-09T00:00:00.000Z','${TENANT}')`); resetHarnessProbeSampling() })
afterEach(() => { h.close(); vi.restoreAllMocks() })

async function ctxFor(env: Env): Promise<AuthContext> {
  const harness = await upsertHarness(env, 'm1', 'client-x', 'Cursor')
  h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant) VALUES ('tok1','m1','hash-tok1','oauth:client-x','directory','2026-10-09T00:00:00.000Z','${TENANT}')`)
  return (await buildAuthContextFromProps(env, { memberId: 'm1', tokenId: 'tok1', email: null, channel: 'directory', boundAgentId: null, harnessId: harness!.id }))!
}
const S = (n: string) => `RAWSECRET${n}ZZ`
const handle = mintSeatHandle()
const META: Record<string, unknown> = {
  auth: S('auth'), bearer: S('bearer'), credential: S('cred'), session: S('session'), jwt: S('jwt'), apiKey: S('apiKey'), api_key: S('api_key'),
  pass: S('pass'), pwd: S('pwd'), sig: S('sig'), signature: S('signature'), 'mupot/seat': handle, nested: { token: S('nested'), auth: S('nested2') },
  'ｔｏｋｅｎ': S('fullwidth'), 'tok​en': S('zwsp'), 'KEY': S('KEY'), 'openai/subject': S('subject'), 'openai/session': S('osess'),
  clientInfo: { name: 'Cur\u0000sor', version: S('ver') + ' x' },
  'openai/locale': 'en-CA',
}
const HDRS: Record<string, string> = {
  authorization: `Bearer ${S('authz')}`, cookie: `a=${S('cookie')}`, 'x-auth': S('xauth'), 'x-bearer': S('xbearer'), 'x-session': S('xsession'),
  'proxy-authorization': S('proxy'), 'cf-access-jwt-assertion': S('cfjwt'), 'x-mupot-seat': handle, 'x-client-sig': S('xclientsig'),
  'x-openai-session': S('xoasess'), 'user-agent': S('ua'), 'x-hub-signature-256': S('hubsig'), 'x-csrf-token': S('csrf'),
}
async function call(env: Env, ctx: AuthContext, opts: { legacy?: boolean; path?: string; tool?: string } = {}) {
  const payload = opts.legacy ? { tool: 'boot_context', args: {} } : { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: opts.tool ?? 'boot_context', arguments: {}, _meta: META } }
  const req = new Request(`https://pot.test${opts.path ?? '/mcp'}`, { method: 'POST', headers: { 'content-type': 'application/json', ...HDRS }, body: JSON.stringify(payload) })
  const res = await mcpApp.fetch(mcpInternalRequest(req, ctx), env)
  return { status: res.status, text: await res.text() }
}
const stable = (t: string): string => t.replace(/"(created_at|now|at|ts|issued_at|[a-z_]*_at)":"[^"]*"/g, '')
function captureLogs(): string[] {
  const logs: string[] = []
  for (const m of ['info', 'log', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')) })
  return logs
}
const probeLines = (logs: string[]): string[] => logs.filter((l) => l.includes('harness_identity_probe'))

describe('HARNESS_PROBE_VERBOSE end to end (mcpApp)', () => {
  for (const extra of [{}, { CONNECTOR_MASTER_KEY: 'k' }]) {
    it(`flag on, seat off ${JSON.stringify(extra)}: exactly one probe line, no planted secret anywhere, session identical to flag off`, async () => {
      const logs = captureLogs()
      const envOff = envFor(extra); const ctx = await ctxFor(envOff)
      const off = await call(envOff, ctx)
      expect(probeLines(logs.splice(0))).toEqual([]) // flag off + seat off: no line at all
      resetHarnessProbeSampling()
      const on = await call(envFor({ ...extra, HARNESS_PROBE_VERBOSE: '1' }), ctx)
      const onLogs = logs.splice(0)
      const lines = probeLines(onLogs)
      expect(lines.length).toBe(1)
      expect(on.status).toBe(off.status)
      expect(stable(on.text)).toBe(stable(off.text)) // boot_context reflects the resolved auth
      const all = onLogs.join('\n')
      expect(all).not.toMatch(/RAWSECRET/)
      expect(all).not.toContain(handle)
      expect(all).not.toContain('en-CA')
      const ev = JSON.parse(lines[0])
      expect(ev.verbose).toBeTruthy()
      for (const k of ['meta_h', 'header_h']) expect(JSON.stringify(ev.verbose[k])).not.toMatch(/RAWSECRET/)
      expect(ev.verbose.client_info_version).toBeNull() // planted version is not version-shaped
      expect(ev.verbose.client_info_name).not.toMatch(/\u0000/)
      expect(Object.keys(ev.verbose.meta_h).every((k) => ['openai/locale', 'openai/session', 'openai/subject'].includes(k))).toBe(true)
      expect(JSON.stringify(ev.verbose.meta_present)).not.toMatch(/seat|token|auth|key|pass|sig/i)
    })
  }

  it('skipSeat doors (legacy body, profile door) emit nothing even with the flag on', async () => {
    const logs = captureLogs()
    const env = envFor({ HARNESS_PROBE_VERBOSE: '1', CONNECTOR_MASTER_KEY: 'k' }); const ctx = await ctxFor(env)
    await call(env, ctx, { legacy: true })
    await call(env, ctx, { legacy: true, path: '/mcp/profile/needs-you' })
    expect(probeLines(logs)).toEqual([])
  })

  it('flag off: request headers are never enumerated for the probe', async () => {
    const logs = captureLogs()
    const env = envFor({ SEAT_AUTO_ENROLL: '1', CONNECTOR_MASTER_KEY: 'k' }); const ctx = await ctxFor(env) // harnessId survives only with seat enroll on
    const spy = vi.spyOn(Headers.prototype, 'forEach')
    await call(env, ctx, { tool: 'boot_context' })
    expect(spy).not.toHaveBeenCalled()
    expect(probeLines(logs).length).toBe(1) // seat on, verbose off: the plain line is emitted, nothing is gathered for it
    expect(spy).not.toHaveBeenCalled()
    resetHarnessProbeSampling()
    await call(envFor({ SEAT_AUTO_ENROLL: '1', HARNESS_PROBE_VERBOSE: '1' }), ctx, { tool: 'boot_context' })
    expect(spy).toHaveBeenCalled() // the spy can see the gather when the flag is on
  })

  for (const seat of [{}, { SEAT_AUTO_ENROLL: '1' }]) it(`a failure while gathering inputs is swallowed and does not change the response ${JSON.stringify(seat)}`, async () => {
    const logs = captureLogs()
    const env = envFor({ ...seat, HARNESS_PROBE_VERBOSE: '1', CONNECTOR_MASTER_KEY: 'k' }); const ctx = await ctxFor(env)
    const ok = await call(env, ctx, { tool: 'boot_context' })
    resetHarnessProbeSampling(); logs.length = 0
    vi.spyOn(Headers.prototype, 'forEach').mockImplementation(() => { throw new Error('boom') })
    const bad = await call(env, ctx, { tool: 'boot_context' })
    expect(bad.status).toBe(ok.status)
    expect(stable(bad.text)).toBe(stable(ok.text))
    expect(probeLines(logs).filter((l) => l.includes('"verbose"'))).toEqual([]) // seat on: the plain line may still appear, never the verbose part
  })
})
