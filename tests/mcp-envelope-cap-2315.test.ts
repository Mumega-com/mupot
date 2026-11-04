// tests/mcp-envelope-cap-2315.test.ts — mupot#2315: the 65536-byte wiki body must pass the REAL /mcp and /actions
// HTTP entrypoints (not only invokeTool), a 65537 body gets the typed body_too_large refusal, and malicious
// envelopes (declared, chunked, escaped-up) still 413 with a JSON-RPC error that says what and what next.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mcpActionsApp, mcpApp } from '../src/mcp'
import { MCP_BASE_REQUEST_CAP_BYTES, MCP_REQUEST_CAP_BYTES, readBoundedText } from '../src/mcp/request-cap'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { encryptConnectorSecret } from '../src/connectors/crypto'
import { FakeWikiDocuments } from './helpers/fake-wiki-documents'

const TENANT = 'pot-2315'
const MASTER_KEY = '77'.repeat(32)
const SECRET = 'cap-secret-2315'
const CONNECTOR_ID = 'connector-inkwell-2315'
const TOKEN = 'mupot_member_bearer_2315'
const PROJ = 'proj-2315'
const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

let harness: SqliteD1Harness
let env: Env
let fake: FakeWikiDocuments

beforeAll(async () => {
  harness = createSqliteD1()
  for (const f of readdirSync(join(__dirname, '..', 'migrations')).filter((n) => n.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(__dirname, '..', 'migrations', f), 'utf8'))
  }
  const enc = await encryptConnectorSecret(MASTER_KEY, CONNECTOR_ID, 'inkwell', SECRET)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('sq-w', 'dept-a', 'sq-w', 'W');
    INSERT INTO projects (id, slug, name, status) VALUES ('${PROJ}', 'proj-2315-slug', 'P', 'active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('${PROJ}', 'sq-w', 'write');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('m-w', 'w@pot.test', 'W', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('c-w', 'm-w', 'squad', 'sq-w', 'member');
    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
      VALUES ('t-w', 'm-w', '${sha(TOKEN)}', 'w', 'workspace', datetime('now'), NULL, '${TENANT}');
    INSERT INTO connectors (id, tenant, type, label, encrypted_secret, meta, scope_type, scope_id, created_by, created_at)
      VALUES ('${CONNECTOR_ID}', '${TENANT}', 'inkwell', 'w', '${enc}', NULL, 'pot', NULL, 't', '2026-01-01T00:00:00Z');
  `)
  fake = new FakeWikiDocuments(TENANT, SECRET)
  const svc = fake.asFetcher()
  env = { DB: harness.db, TENANT_SLUG: TENANT, BRAND: 'T', CONNECTOR_MASTER_KEY: MASTER_KEY, INKWELL_API_URL: 'https://inkwell-api.test', INKWELL_SVC: svc } as unknown as Env
}, 120_000)
afterAll(() => harness?.close())

const args = (slug: string, body: string) => ({ project_id: PROJ, slug, title: 'Cap probe', summary: 'envelope cap probe', purpose: 'decision', tier: 'project', expected_version: 0, body })
const rpcBody = (slug: string, body: string) => JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'project_wiki_upsert', arguments: args(slug, body) } })
// A real client (and Cloudflare) sends Content-Length for a buffered body; Hono's test request does not, so set it.
const clen = (raw: string): Record<string, string> => ({ 'content-length': String(new TextEncoder().encode(raw).byteLength) })
const post = (raw: string, extra: Record<string, string> = {}) =>
  mcpApp.request('https://pot.example/', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...clen(raw), ...extra }, body: raw }, env)
const act = (raw: string, tool = 'project_wiki_upsert') =>
  mcpActionsApp.request(`https://pot.example/actions/${tool}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...clen(raw) }, body: raw }, env)
// The tool result text of a tools/call response, parsed.
async function toolPayload(res: Response): Promise<Record<string, unknown>> {
  const j = (await res.json()) as { result?: { content?: Array<{ text: string }>; isError?: boolean }; error?: unknown }
  const text = j.result?.content?.[0]?.text
  return text ? (JSON.parse(text) as Record<string, unknown>) : { rpc: j }
}

describe('wiki body at the real /mcp HTTP handler', () => {
  it('exactly 65536 ASCII bytes passes transport and is stored verbatim', async () => {
    const body = 'a'.repeat(65536)
    const res = await post(rpcBody('cap-ascii-ok', body))
    expect(res.status).toBe(200)
    const p = await toolPayload(res)
    expect(p.ok).not.toBe(false)
    expect(fake.topics.get('cap-ascii-ok')?.body).toBe(body)
  })
  it('exactly 65536 multibyte UTF-8 bytes (32768 x 2-byte) passes', async () => {
    const res = await post(rpcBody('cap-mb-ok', 'é'.repeat(32768)))
    expect(res.status).toBe(200)
    expect((await toolPayload(res)).ok).not.toBe(false)
  })
  it('65536 bytes of 3-byte chars written fully \\u-escaped (worst-case wire form) still passes', async () => {
    const body = '€'.repeat(21845) + 'a' // 65536 bytes
    const wire = JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'project_wiki_upsert', arguments: args('cap-esc-ok', body) } })
      .replace(/./gu, (ch) => (ch.charCodeAt(0) > 127 ? `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}` : ch))
    expect(wire.length).toBeLessThanOrEqual(MCP_REQUEST_CAP_BYTES)
    const res = await post(wire)
    expect(res.status).toBe(200)
    expect((await toolPayload(res)).ok).not.toBe(false)
  })
  it('65537 bytes reaches the tool and gets the typed body_too_large refusal with a next step', async () => {
    const res = await post(rpcBody('cap-over', 'a'.repeat(65537)))
    expect(res.status).toBe(200)
    const p = await toolPayload(res)
    expect(p).toMatchObject({ ok: false, error: 'body_too_large' })
    expect(JSON.stringify(p)).toMatch(/Split the page/)
    expect(JSON.stringify(p)).toMatch(/65537/)
  })
  it('the same two sizes through /actions/:tool', async () => {
    const okRes = await act(JSON.stringify(args('act-ok', 'b'.repeat(65536))))
    expect(okRes.status).toBe(200)
    const over = await act(JSON.stringify(args('act-over', 'b'.repeat(65537))))
    expect(JSON.stringify(await over.json())).toMatch(/body_too_large/)
  })
})

describe('malicious envelopes are still 413, as a JSON-RPC error that says what and what next', () => {
  it('declared Content-Length over the cap', async () => {
    const res = await post('{}', { 'content-length': String(MCP_REQUEST_CAP_BYTES + 1) })
    expect(res.status).toBe(413)
    const j = (await res.json()) as { jsonrpc: string; id: unknown; error: { code: number; message: string; data: { what: string; limit_bytes: number; next_step: string } } }
    expect(j).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'payload_too_large' } })
    expect(j.error.data.limit_bytes).toBe(MCP_REQUEST_CAP_BYTES)
    expect(j.error.data.what).toMatch(/request body/)
    expect(j.error.data.next_step).toMatch(/split/i)
  })
  it('actual bytes over the cap (body larger than the cap)', async () => {
    expect((await post(`{"pad":"${'x'.repeat(MCP_REQUEST_CAP_BYTES)}"}`)).status).toBe(413)
    expect((await act(`{"pad":"${'x'.repeat(MCP_REQUEST_CAP_BYTES)}"}`)).status).toBe(413)
  })
  it('a chunked body with no Content-Length is bounded by the bytes actually read', async () => {
    const chunk = new Uint8Array(64 * 1024).fill(120)
    let sent = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(ctl) { if (sent > 20) { ctl.close(); return } sent += 1; ctl.enqueue(chunk) },
    })
    const req = new Request('https://pot.example/', { method: 'POST', body: stream, duplex: 'half' } as RequestInit)
    expect(req.headers.get('content-length')).toBeNull()
    const out = await readBoundedText(req)
    expect(out).toEqual({ ok: false, reason: 'stream_too_large' })
    expect(sent).toBeLessThan(10) // it stopped reading; it did not drain the whole stream
  })
  it('chunked (no Content-Length) oversize is 413 at both real routes, not only at the reader', async () => {
    const mk = () => new ReadableStream<Uint8Array>({
      start(ctl) { for (let i = 0; i < 8; i++) ctl.enqueue(new Uint8Array(64 * 1024).fill(120)); ctl.close() },
    })
    const init = (): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: mk(), duplex: 'half' } as RequestInit)
    expect((await mcpApp.request('https://pot.example/', init(), env)).status).toBe(413)
    expect((await mcpActionsApp.request('https://pot.example/actions/project_wiki_upsert', init(), env)).status).toBe(413)
  })
  it('the cap is a bounded value: 64 KiB x 6 + 16 KiB', () => {
    expect(MCP_REQUEST_CAP_BYTES).toBe(64 * 1024 * 6 + 16 * 1024)
  })
  it('the needs-you profile keeps its own 64 KiB cap', async () => {
    const res = await mcpApp.request('https://pot.example/profile/needs-you', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(64 * 1024 + 1) }, body: '{}' }, env)
    expect(res.status).toBe(413)
  })
  it('an unauthenticated oversize envelope is still refused before auth', async () => {
    const res = await mcpApp.request('https://pot.example/', { method: 'POST', headers: { 'content-type': 'application/json', ...clen(`{"pad":"${'x'.repeat(MCP_REQUEST_CAP_BYTES)}"}`) }, body: `{"pad":"${'x'.repeat(MCP_REQUEST_CAP_BYTES)}"}` }, env)
    expect(res.status).toBe(413)
  })
})

// ── round 2: auth-tiered cap, per-tool bound, bounded needs-you, boundaries ─────────────────────────────────
const KIB = 1024
/** A JSON-RPC initialize padded so the whole wire body is EXACTLY `total` bytes. */
function initializeOfSize(total: number): string {
  const frame = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { pad: '' } })
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { pad: 'p'.repeat(total - frame.length) } })
}
const postAs = (raw: string, headers: Record<string, string>) =>
  mcpApp.request('https://pot.example/', { method: 'POST', headers: { 'content-type': 'application/json', ...clen(raw), ...headers }, body: raw }, env)
const BEARER = { authorization: `Bearer ${TOKEN}` }
const rpcCall = (name: string, a: Record<string, unknown>) => JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: a } })

describe('auth-tiered cap: only an ACCEPTED bearer unlocks the raised read', () => {
  it('unauthenticated 390 KiB initialize: 413', async () => {
    const raw = initializeOfSize(390 * KIB)
    expect((await postAs(raw, {})).status).toBe(413)
  })
  it('a merely PRESENT but unaccepted Authorization header: 413', async () => {
    expect((await postAs(initializeOfSize(390 * KIB), { authorization: 'Bearer not-a-real-token' })).status).toBe(413)
    expect((await postAs(initializeOfSize(390 * KIB), { authorization: 'Bearer' })).status).toBe(413)
  })
  it('an authenticated 390 KiB initialize is allowed past the transport cap', async () => {
    expect((await postAs(initializeOfSize(390 * KIB), BEARER)).status).toBe(200)
  })
  it('route-level boundary, authenticated: exactly the cap passes, cap + 1 is 413', async () => {
    expect((await postAs(initializeOfSize(MCP_REQUEST_CAP_BYTES), BEARER)).status).toBe(200)
    expect((await postAs(initializeOfSize(MCP_REQUEST_CAP_BYTES + 1), BEARER)).status).toBe(413)
  })
  it('route-level boundary, unauthenticated: exactly 64 KiB passes, 64 KiB + 1 is 413', async () => {
    expect((await postAs(initializeOfSize(MCP_BASE_REQUEST_CAP_BYTES), {})).status).toBe(200)
    expect((await postAs(initializeOfSize(MCP_BASE_REQUEST_CAP_BYTES + 1), {})).status).toBe(413)
  })
  it('chunked unauthenticated 100 KiB: 413 (the tier applies to bytes read, not the header)', async () => {
    const stream = new ReadableStream<Uint8Array>({ start(ctl) { for (let i = 0; i < 2; i++) ctl.enqueue(new Uint8Array(50 * KIB).fill(120)); ctl.close() } })
    const res = await mcpApp.request('https://pot.example/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit, env)
    expect(res.status).toBe(413)
  })
  it('/actions pre-auth: an oversize declared body with no or a bad bearer is 413, not 401, and nothing is read', async () => {
    for (const h of [{}, { authorization: 'Bearer nope' }]) {
      const res = await mcpActionsApp.request('https://pot.example/actions/remember', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(100 * KIB), ...h }, body: '{}' }, env)
      expect(res.status).toBe(413)
    }
  })
})

describe('only project_wiki_upsert may exceed 64 KiB', () => {
  it('remember at 100 KiB, authenticated, is refused with a typed 413 and a next step', async () => {
    const res = await post(rpcCall('remember', { text: 'r'.repeat(100 * KIB) }))
    expect(res.status).toBe(413)
    const j = (await res.json()) as { id: unknown; error: { message: string; data: { limit_bytes: number; next_step: string } } }
    expect(j.id).toBe(9)
    expect(j.error.message).toBe('payload_too_large')
    expect(j.error.data.limit_bytes).toBe(MCP_BASE_REQUEST_CAP_BYTES)
    expect(j.error.data.next_step).toMatch(/project_wiki_upsert/)
  })
  it('legacy {tool,args} shape and /actions are bounded the same way', async () => {
    const legacy = JSON.stringify({ tool: 'remember', args: { text: 'r'.repeat(100 * KIB) } })
    expect((await post(legacy)).status).toBe(413)
    expect((await act(JSON.stringify({ text: 'r'.repeat(100 * KIB) }).replace(/^/, ''), 'remember')).status).toBe(413)
  })
  it('per-tool boundary: a non-wiki call of exactly 64 KiB passes the bound, 64 KiB + 1 is 413', async () => {
    const sized = (total: number) => { const base = rpcCall('remember', { text: '' }); return rpcCall('remember', { text: 'r'.repeat(total - base.length) }) }
    expect(new TextEncoder().encode(sized(MCP_BASE_REQUEST_CAP_BYTES)).byteLength).toBe(MCP_BASE_REQUEST_CAP_BYTES)
    expect((await post(sized(MCP_BASE_REQUEST_CAP_BYTES))).status).not.toBe(413)
    expect((await post(sized(MCP_BASE_REQUEST_CAP_BYTES + 1))).status).toBe(413)
  })
  it('a small remember is not affected by the new bound (reaches the tool)', async () => {
    expect((await post(rpcCall('remember', { text: 'hi' }))).status).not.toBe(413)
  })
  it('a 100 KiB project_wiki_upsert still reaches the tool', async () => {
    const res = await post(rpcBody('cap-100k', 'a'.repeat(65536)))
    expect(res.status).toBe(200)
  })
  it('worst case: 65536 ASCII bytes ALL written as \\u0061 through the real /mcp handler', async () => {
    const wire = `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"project_wiki_upsert","arguments":${JSON.stringify(args('cap-all-esc', ''))
      .replace('"body":""', `"body":"${'\\u0061'.repeat(65536)}"`)}}}`
    expect(wire.length).toBeGreaterThan(65536 * 6)
    expect(wire.length).toBeLessThanOrEqual(MCP_REQUEST_CAP_BYTES)
    const res = await post(wire)
    expect(res.status).toBe(200)
    expect((await toolPayload(res)).ok).not.toBe(false)
    expect(fake.topics.get('cap-all-esc')?.body).toBe('a'.repeat(65536))
  })
})

describe('needs-you profile and stream errors', () => {
  it('a chunked 5 MiB needs-you body is refused 413 and the stream is not drained', async () => {
    let pulled = 0
    const stream = new ReadableStream<Uint8Array>({ pull(ctl) { if (pulled >= 80) { ctl.close(); return } pulled += 1; ctl.enqueue(new Uint8Array(64 * KIB).fill(120)) } })
    const res = await mcpApp.request('https://pot.example/profile/needs-you', { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit, env)
    expect(res.status).toBe(413)
    expect(pulled).toBeLessThan(10)
  })
  const broken = () => new ReadableStream<Uint8Array>({ start(ctl) { ctl.enqueue(new Uint8Array(10).fill(120)); ctl.error(new Error('client aborted')) } })
  it('a stream error mid-body returns JSON 400, not a plain 500, on /mcp, /actions and needs-you', async () => {
    const mk = (): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json', ...BEARER }, body: broken(), duplex: 'half' } as RequestInit)
    for (const res of [
      await mcpApp.request('https://pot.example/', mk(), env),
      await mcpActionsApp.request('https://pot.example/actions/remember', mk(), env),
      await mcpApp.request('https://pot.example/profile/needs-you', mk(), env),
    ]) {
      expect(res.status).toBe(400)
      expect(res.headers.get('content-type')).toMatch(/json/)
    }
  })
})
