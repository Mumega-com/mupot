import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { TOOLS } from '../src/mcp'
// @ts-expect-error - plain .mjs CLI (zero-dependency, intentionally untyped)
import { EXIT, SHORTCUTS, coerceArg, main, resolveArgs } from '../cli/mupot.mjs'

const CLI_PATH = join(__dirname, '..', 'cli', 'mupot.mjs')
const SECRET = 'mpt_FAKE-secret-token-0123456789abcdefXYZ'

interface Call { url: string; init: RequestInit; body: { id: number; method: string; params: { name?: string; arguments?: Record<string, unknown> } }; headers: Record<string, string> }

const MOCK_TOOLS = [
  { name: 'boot_context', description: 'self; minimum capability: authenticated. Args: {}', inputSchema: { type: 'object', properties: { source: { type: 'string' } }, additionalProperties: false } },
  { name: 'status', description: 'self; minimum capability: authenticated. Args: {}', inputSchema: { type: 'object', properties: { agent_id: { type: 'string' } }, additionalProperties: false } },
  { name: 'inbox', description: 'self; minimum capability: authenticated.', inputSchema: { type: 'object', properties: { limit: { type: 'number' }, peek: { type: 'boolean' }, since_seq: { type: 'number' } }, required: [], additionalProperties: false } },
  { name: 'inbox_ack', description: 'self; minimum capability: authenticated.', inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'], additionalProperties: false } },
  { name: 'send', description: 'agent; minimum capability: authenticated.', inputSchema: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' }, kind: { type: 'string' } }, required: ['to', 'body'], additionalProperties: false } },
  { name: 'task_list', description: 'squad; minimum capability: member.', inputSchema: { type: 'object', properties: { status: { type: 'string' }, limit: { type: 'number' }, squad_id: { type: 'string' } }, additionalProperties: false } },
  { name: 'task_get', description: 'squad; minimum capability: member.', inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'], additionalProperties: false } },
  { name: 'task_create', description: 'squad; minimum capability: member.', inputSchema: { type: 'object', properties: { title: { type: 'string' }, done_when: { type: 'string' }, priority: { type: 'string' } }, required: ['title', 'done_when'], additionalProperties: false } },
  { name: 'harness_capacity_list', description: 'org; minimum capability: observer.', inputSchema: { type: 'object', properties: { harness: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false } },
  { name: 'routine_proposal_submit', description: 'x; minimum capability: member.', inputSchema: { type: 'object', properties: { version: { type: 'number' }, title: { type: 'string' } } } },
  { name: 'tagger', description: 'x; minimum capability: member.', inputSchema: { type: 'object', properties: { n: { type: 'integer' }, tags: { type: 'array', items: { type: 'number' } }, meta: { type: 'object' }, flag: { type: 'boolean' }, dry_run: { type: 'boolean' } } } },
]

type Responder = (call: Call) => Response | Promise<Response>
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const rpcOk = (result: unknown) => json({ jsonrpc: '2.0', id: 'AUTO', result })
const toolOk = (structured: unknown) => rpcOk({ content: [{ type: 'text', text: JSON.stringify({ ok: true, result: structured }) }], structuredContent: structured })

let home: string
let calls: Call[]
let out: string
let err: string
let now: number
let tokenFile: string

function defaultResponder(call: Call): Response {
  if (call.body.method === 'tools/list') return rpcOk({ tools: MOCK_TOOLS })
  return toolOk({ echoed: call.body.params.arguments ?? {} })
}

async function run(argv: string[], opts: { responder?: Responder; env?: Record<string, string>; stdin?: string } = {}) {
  const responder = opts.responder ?? defaultResponder
  out = ''
  err = ''
  const code = await main(argv, {
    env: { MUPOT_TOKEN_FILE: tokenFile, ...opts.env },
    home,
    now: () => now,
    out: (s: string) => { out += s },
    err: (s: string) => { err += s },
    readStdin: () => opts.stdin ?? '',
    fetch: async (url: string, init: RequestInit) => {
      const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>))
      const call: Call = { url, init, body: JSON.parse(String(init.body)), headers }
      calls.push(call)
      const res = await responder(call)
      // Mocks write id 'AUTO'; echo the real request id like a server does. Tests that need a wrong id write a number.
      if (!(res instanceof Response)) return res
      const text = await res.clone().text()
      if (!text.includes('"id":"AUTO"')) return res
      return new Response(text.replace('"id":"AUTO"', `"id":${call.body.id}`), { status: res.status, headers: res.headers })
    },
  })
  return code as number
}

const toolCalls = () => calls.filter((c) => c.body.method === 'tools/call')

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mupot-cli-'))
  calls = []
  now = 1_800_000_000_000
  mkdirSync(join(home, '.config', 'mupot'), { recursive: true })
  tokenFile = join(home, 'tok')
  writeFileSync(tokenFile, `${SECRET}\n`, { mode: 0o600 })
  chmodSync(tokenFile, 0o600)
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('flag coercion from the tool schema', () => {
  it('coerces numbers, integers, booleans, arrays and objects', () => {
    expect(coerceArg('n', { type: 'number' }, ['2.5'])).toBe(2.5)
    expect(coerceArg('n', { type: 'integer' }, ['7'])).toBe(7)
    expect(() => coerceArg('n', { type: 'integer' }, ['7.5'])).toThrow(/integer/)
    expect(() => coerceArg('n', { type: 'number' }, ['abc'])).toThrow(/number/)
    expect(coerceArg('b', { type: 'boolean' }, ['yes'])).toBe(true)
    expect(coerceArg('b', { type: 'boolean' }, ['0'])).toBe(false)
    expect(() => coerceArg('b', { type: 'boolean' }, ['maybe'])).toThrow(/boolean/)
    expect(coerceArg('a', { type: 'array', items: { type: 'string' } }, ['x,y', 'z'])).toEqual(['x', 'y', 'z'])
    expect(coerceArg('a', { type: 'array', items: { type: 'number' } }, ['1,2', '3'])).toEqual([1, 2, 3])
    expect(coerceArg('a', { type: 'array', items: { type: 'string' } }, ['["a,b","c"]'])).toEqual(['a,b', 'c'])
    expect(coerceArg('o', { type: 'object' }, ['{"k":[1]}'])).toEqual({ k: [1] })
    expect(() => coerceArg('o', { type: 'object' }, ['[1]'])).toThrow(/object/)
    expect(coerceArg('s', { type: ['string', 'null'] }, ['hi'])).toBe('hi')
    expect(coerceArg('n', { type: ['number', 'null'] }, ['3'])).toBe(3)
  })

  it('resolves dashed flags to snake_case props, negation, equals form and boolean give-back', () => {
    const schema = MOCK_TOOLS.find((t) => t.name === 'tagger')!.inputSchema
    const items = [
      { t: 'flag', name: 'n', eq: '3' },
      { t: 'flag', name: 'tags' }, { t: 'pos', v: '1,2' },
      { t: 'flag', name: 'dry-run' }, { t: 'pos', v: 'extra' },
      { t: 'flag', name: 'no-flag' },
      { t: 'flag', name: 'meta' }, { t: 'pos', v: '{"a":1}' },
    ]
    const r = resolveArgs(items, schema)
    expect(r.args).toEqual({ n: 3, tags: [1, 2], dry_run: true, flag: false, meta: { a: 1 } })
    expect(r.positionals).toEqual(['extra'])
  })

  it('coerces through the real command line (number, boolean, repeated array)', async () => {
    expect(await run(['tagger', '--n', '4', '--tags', '1', '--tags', '2,3', '--dry-run', '--meta', '{"x":true}'])).toBe(0)
    expect(toolCalls()[0].body.params).toEqual({ name: 'tagger', arguments: { n: 4, tags: [1, 2, 3], dry_run: true, meta: { x: true } } })
  })

  it('--json-args passes raw args; flags override; stdin form works', async () => {
    expect(await run(['task_list', '--json-args', '{"limit":9,"status":"open"}', '--limit', '3'])).toBe(0)
    expect(toolCalls()[0].body.params.arguments).toEqual({ limit: 3, status: 'open' })
    calls = []
    expect(await run(['task_list', '--json-args', '-'], { stdin: '{"status":"done"}' })).toBe(0)
    expect(toolCalls()[0].body.params.arguments).toEqual({ status: 'done' })
  })
})

describe('shortcuts map onto real tools', () => {
  it('every shortcut targets a tool that exists in src/mcp with the args it sends', () => {
    const byName = new Map(TOOLS.map((t) => [t.name, t]))
    const sample: Record<string, string[]> = {
      ack: ['a', 'b'], send: ['bob', 'hi', 'there'], 'task get': ['t1'], 'task new': ['a', 'title'],
    }
    for (const [key, sc] of Object.entries(SHORTCUTS) as Array<[string, { tool: string; pos?: (p: string[], f: Record<string, unknown>) => Record<string, unknown> }]>) {
      const spec = byName.get(sc.tool)
      expect(spec, `${key} -> ${sc.tool}`).toBeDefined()
      const props = Object.keys((spec!.inputSchema as { properties?: object }).properties ?? {})
      for (const arg of Object.keys(sc.pos ? sc.pos(sample[key] ?? [], {}) : {})) expect(props, `${key}: ${arg}`).toContain(arg)
    }
  })

  it('maps status/whoami/inbox/ack/send/task/capacity to the right tool and args', async () => {
    const cases: Array<[string[], string, Record<string, unknown>]> = [
      [['status'], 'boot_context', {}],
      [['whoami'], 'status', {}],
      [['inbox', '--peek'], 'inbox', { peek: true }],
      [['inbox', '--limit', '5'], 'inbox', { limit: 5 }],
      [['ack', 'm1', 'm2,m3'], 'inbox_ack', { ids: ['m1', 'm2', 'm3'] }],
      [['send', 'athena', 'hello', 'there'], 'send', { to: 'athena', body: 'hello there' }],
      [['task', 'list', '--status', 'open', '--limit', '2'], 'task_list', { status: 'open', limit: 2 }],
      [['task', 'get', 'abc'], 'task_get', { task_id: 'abc' }],
      [['task', 'new', 'Fix', 'it', '--done-when', 'tests green'], 'task_create', { title: 'Fix it', done_when: 'tests green' }],
      [['capacity', '--harness', 'orca'], 'harness_capacity_list', { harness: 'orca' }],
    ]
    for (const [argv, tool, args] of cases) {
      calls = []
      expect(await run(argv), argv.join(' ')).toBe(0)
      expect(toolCalls()[0].body.params, argv.join(' ')).toEqual({ name: tool, arguments: args })
    }
  })
})

describe('transport', () => {
  it('sends what a real MCP client sends, never follows redirects, bearer only in the header', async () => {
    expect(await run(['status'])).toBe(0)
    const c = toolCalls()[0]
    expect(c.url).toBe('https://mupot.mumega.com/mcp')
    expect(c.init.method).toBe('POST')
    expect(c.init.redirect).toBe('manual')
    expect(c.headers.accept).toBe('application/json, text/event-stream')
    expect(c.headers['content-type']).toBe('application/json')
    expect(c.headers['mcp-protocol-version']).toBe('2025-06-18')
    expect(c.headers.authorization).toBe(`Bearer ${SECRET}`)
    expect(JSON.stringify(c.body)).not.toContain(SECRET)
    expect(c.url).not.toContain(SECRET)
    for (const l of calls) expect(l.init.redirect).toBe('manual')
  })

  it('parses an SSE-framed response', async () => {
    const sse = (c: Call) => c.body.method === 'tools/list'
      ? rpcOk({ tools: MOCK_TOOLS })
      : new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 'AUTO', result: { structuredContent: { a: 1 }, content: [] } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    expect(await run(['status', '--json'], { responder: sse })).toBe(0)
    expect(JSON.parse(out)).toEqual({ a: 1 })
  })

  it('refuses a cleartext non-loopback API, allows loopback', async () => {
    expect(await run(['tools', '--api', 'http://example.com'])).toBe(EXIT.USAGE)
    expect(calls).toHaveLength(0)
    expect(await run(['status', '--api', 'http://127.0.0.1:8787'])).toBe(0)
    expect(toolCalls()[0].url).toBe('http://127.0.0.1:8787/mcp')
  })

  it('uses pots/profiles from config.json; --api overrides', async () => {
    const other = join(home, 'other.token')
    writeFileSync(other, 'other-token-value-123456\n', { mode: 0o600 })
    writeFileSync(join(home, '.config', 'mupot', 'config.json'), JSON.stringify({
      pots: { acme: { api: 'https://acme.example', token_file: other } }, default: 'acme',
    }))
    // The env vars (MUPOT_TOKEN_FILE from run(), plus MUPOT_TOKEN) are SET; the pot's own token wins.
    expect(await run(['status'], { env: { MUPOT_TOKEN: 'env-token-value-123456' } })).toBe(0)
    expect(toolCalls()[0].url).toBe('https://acme.example/mcp')
    expect(toolCalls()[0].headers.authorization).toBe('Bearer other-token-value-123456')
    calls = []
    expect(await run(['status', '--api', 'https://acme.example/'])).toBe(0)
    expect(toolCalls()[0].url).toBe('https://acme.example/mcp')
    expect(await run(['status', '--pot', 'nope'])).toBe(EXIT.USAGE)
  })
})

describe('auth sources', () => {
  it('prefers ~/.config/mupot/<pot>.token over the env vars, then falls back to MUPOT_TOKEN', async () => {
    writeFileSync(join(home, '.config', 'mupot', 'mumega.token'), 'default-path-token-123456\n', { mode: 0o600 })
    expect(await run(['status'], { env: { MUPOT_TOKEN: 'env-token-value-123456' } })).toBe(0)
    expect(toolCalls()[0].headers.authorization).toBe('Bearer default-path-token-123456')
    rmSync(join(home, '.config', 'mupot', 'mumega.token'))
    calls = []
    expect(await run(['status'], { env: { MUPOT_TOKEN_FILE: '', MUPOT_TOKEN: 'env-token-value-123456' } })).toBe(0)
    expect(toolCalls()[0].headers.authorization).toBe('Bearer env-token-value-123456')
  })

  it('no token at all is an auth error (3) without a tools/call', async () => {
    expect(await run(['status'], { env: { MUPOT_TOKEN_FILE: '' } })).toBe(EXIT.AUTH)
    expect(toolCalls()).toHaveLength(0)
  })

  it('refuses a group- or world-readable token file with a clear message', async () => {
    for (const mode of [0o644, 0o640, 0o604, 0o660, 0o666, 0o610]) {
      chmodSync(tokenFile, mode)
      calls = []
      expect(await run(['status']), mode.toString(8)).toBe(EXIT.AUTH)
      expect(err).toMatch(/accessible by group\/others/)
      expect(err).toMatch(/chmod 600/)
      expect(err).not.toContain(SECRET)
      expect(out).not.toContain(SECRET)
      expect(calls).toHaveLength(0)
    }
    chmodSync(tokenFile, 0o400)
    expect(await run(['status'])).toBe(0)
  })

  it('the file mode is also enforced for a config token_file and for tools', async () => {
    chmodSync(tokenFile, 0o644)
    expect(await run(['tools'])).toBe(EXIT.AUTH)
    expect(calls).toHaveLength(0)
  })
})

describe('redirects', () => {
  it('treats a 3xx as an error and never makes a second request', async () => {
    const redirect = () => new Response(null, { status: 302, headers: { location: 'https://evil.example/mcp' } })
    expect(await run(['status'], { responder: redirect })).toBe(EXIT.NETWORK)
    expect(err).toMatch(/redirect/)
    expect(err).not.toContain('evil.example')
    expect(err).not.toContain(SECRET)
    expect(calls.filter((c) => c.url.includes('evil'))).toHaveLength(0)
    expect(calls).toHaveLength(1)
  })
})

describe('exit codes', () => {
  it('0 ok / 1 tool isError / 1 JSON-RPC error / 2 usage / 3 auth / 4 network', async () => {
    expect(await run(['status'])).toBe(0)
    expect(await run(['status'], { responder: (c) => c.body.method === 'tools/list' ? rpcOk({ tools: MOCK_TOOLS }) : rpcOk({ isError: true, content: [], structuredContent: { ok: false, error: 'nope', status: 403, detail: { need: 'admin' } } }) })).toBe(EXIT.TOOL)
    expect(err).toMatch(/error: nope \(status 403\)/)
    expect(await run(['status'], { responder: (c) => c.body.method === 'tools/list' ? rpcOk({ tools: MOCK_TOOLS }) : json({ jsonrpc: '2.0', id: 'AUTO', error: { code: -32602, message: 'invalid_args' } }) })).toBe(EXIT.TOOL)
    expect(await run(['status'], { responder: (c) => c.body.method === 'tools/list' ? rpcOk({ tools: MOCK_TOOLS }) : json({ jsonrpc: '2.0', id: 'AUTO', error: { code: -32001, message: 'unauthenticated' } }, 401) })).toBe(EXIT.AUTH)
    expect(await run(['status'], { responder: () => json({ error: 'forbidden' }, 403) })).toBe(EXIT.AUTH)
    expect(await run(['status'], { responder: () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) } })).toBe(EXIT.NETWORK)
    expect(await run(['status'], { responder: () => new Response('<html>bad gateway</html>', { status: 502 }) })).toBe(EXIT.NETWORK)
    // usage
    expect(await run([])).toBe(EXIT.USAGE)
    expect(await run(['no_such_tool'])).toBe(EXIT.USAGE)
    expect(await run(['task_list', '--bogus', '1'])).toBe(EXIT.USAGE)
    expect(await run(['task_list', '--limit', 'abc'])).toBe(EXIT.USAGE)
    expect(await run(['send', 'onlyto'])).toBe(EXIT.USAGE)
    expect(await run(['ack'])).toBe(EXIT.USAGE)
    expect(await run(['task', 'new', 'title only'])).toBe(EXIT.USAGE)
    expect(await run(['--peek', 'inbox'])).toBe(EXIT.USAGE)
  })

  it('help/agent-context/--version exit 0 and need no token', async () => {
    expect(await run(['help'], { env: { MUPOT_TOKEN_FILE: '' } })).toBe(0)
    expect(await run(['agent-context'], { env: { MUPOT_TOKEN_FILE: '' } })).toBe(0)
    const ctx = JSON.parse(out)
    expect(ctx.exit_codes).toEqual(expect.objectContaining({ 0: expect.any(String), 4: expect.any(String) }))
    expect(ctx.commands.map((c: { name: string }) => c.name)).toEqual(expect.arrayContaining(['tools', 'status', 'whoami', 'inbox', 'ack', 'send', 'task list', 'task get', 'task new', 'capacity']))
    expect(await run(['--version'], { env: { MUPOT_TOKEN_FILE: '' } })).toBe(0)
  })
})

describe('token never reaches argv or output (every error path)', () => {
  const echoResponder: Responder = (c) => {
    if (c.body.method === 'tools/list') return rpcOk({ tools: MOCK_TOOLS })
    return rpcOk({ isError: true, content: [], structuredContent: { ok: false, error: `echo ${SECRET}`, detail: { auth: `Bearer ${SECRET}` } } })
  }
  const paths: Array<[string, string[], Responder | undefined]> = [
    ['success human', ['status'], undefined],
    ['success json', ['status', '--json'], undefined],
    ['401', ['status'], () => json({ error: `bad ${SECRET}` }, 401)],
    ['403', ['status'], () => json({ error: `Bearer ${SECRET}` }, 403)],
    ['redirect', ['status'], () => new Response(null, { status: 307, headers: { location: `https://x.example/?t=${SECRET}` } })],
    ['network error echoing header', ['status'], () => { throw new Error(`failed with Authorization: Bearer ${SECRET}`) }],
    ['isError echoing token', ['status'], echoResponder],
    ['isError echoing token json', ['status', '--json'], echoResponder],
    ['json-rpc error echoing token', ['status'], (c) => c.body.method === 'tools/list' ? rpcOk({ tools: MOCK_TOOLS }) : json({ jsonrpc: '2.0', id: 'AUTO', error: { code: -32000, message: `x ${SECRET}`, data: { t: SECRET } } })],
    ['non-json 502', ['status'], () => new Response(`upstream ${SECRET}`, { status: 502 })],
    ['usage: unknown tool', ['nope'], undefined],
    ['usage: bad flag', ['task_list', '--bogus', '1'], undefined],
    ['tools', ['tools'], undefined],
    ['help tool', ['help', 'send'], undefined],
    ['agent-context', ['agent-context'], undefined],
  ]
  for (const [label, argv, responder] of paths) {
    it(label, async () => {
      await run(argv, { responder })
      expect(out).not.toContain(SECRET)
      expect(err).not.toContain(SECRET)
      expect(argv.join(' ')).not.toContain(SECRET)
      expect(JSON.stringify(calls.map((c) => c.body))).not.toContain(SECRET)
      expect(calls.map((c) => c.url).join(' ')).not.toContain(SECRET)
    })
  }

  it('a token passed as a flag is refused (exit 2) and never echoed', async () => {
    for (const argv of [['status', '--token', SECRET], ['status', `--token=${SECRET}`], ['tools', '--bearer', SECRET], ['task_list', '--authorization', `Bearer ${SECRET}`]]) {
      calls = []
      expect(await run(argv, { env: { MUPOT_TOKEN_FILE: '' } })).toBe(EXIT.USAGE)
      expect(out + err).not.toContain(SECRET)
      expect(err).toMatch(/never accepted on the command line|put options after/)
      expect(calls).toHaveLength(0)
    }
  })

  it('in a real process too: --token is refused and the secret is not echoed', () => {
    const r = spawnSync(process.execPath, [CLI_PATH, 'status', '--token', SECRET], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: home } })
    expect(r.status).toBe(2)
    expect(r.stdout + r.stderr).not.toContain(SECRET)
  })

  it('MUPOT_TOKEN from the env is redacted even when the server echoes it', async () => {
    const envTok = 'env-only-token-ABCDEFGHIJKL'
    await run(['status'], { env: { MUPOT_TOKEN_FILE: '', MUPOT_TOKEN: envTok }, responder: echoResponderFor(envTok) })
    expect(out + err).not.toContain(envTok)
  })
})

function echoResponderFor(tok: string): Responder {
  return (c) => c.body.method === 'tools/list' ? rpcOk({ tools: MOCK_TOOLS }) : toolOk({ leaked: tok })
}

describe('tools/list cache', () => {
  it('caches for 1h keyed by api+pot, expires, and --refresh bypasses', async () => {
    const lists = () => calls.filter((c) => c.body.method === 'tools/list').length
    expect(await run(['status'])).toBe(0)
    expect(await run(['whoami'])).toBe(0)
    expect(lists()).toBe(1)
    const dir = join(home, '.cache', 'mupot')
    const files = readdirSync(dir)
    expect(files).toHaveLength(1)
    expect(statSync(join(dir, files[0])).mode & 0o077).toBe(0)
    expect(statSync(dir).mode & 0o077).toBe(0)
    expect(readFileSync(join(dir, files[0]), 'utf8')).not.toContain(SECRET)
    expect(await run(['status', '--refresh'])).toBe(0)
    expect(lists()).toBe(2)
    now += 3_600_001
    expect(await run(['status'])).toBe(0)
    expect(lists()).toBe(3)
    expect(await run(['status', '--api', 'https://other.example'])).toBe(0)
    expect(lists()).toBe(4)
    expect(readdirSync(dir)).toHaveLength(2)
  })

  it('tools lists names/descriptions; --json emits the raw list', async () => {
    expect(await run(['tools', 'task'])).toBe(0)
    expect(out).toMatch(/task_list/)
    expect(out).not.toMatch(/inbox_ack/)
    expect(await run(['tools', '--json'])).toBe(0)
    expect(JSON.parse(out)).toHaveLength(MOCK_TOOLS.length)
  })

  it('help <tool> prints the schema', async () => {
    expect(await run(['help', 'send'])).toBe(0)
    expect(out).toMatch(/--to <string>.*required/)
    expect(await run(['help', 'task', 'new'])).toBe(0)
    expect(out).toMatch(/--done_when|--done-when/)
    expect(await run(['help', 'send', '--json'])).toBe(0)
    expect(JSON.parse(out).required).toEqual(['to', 'body'])
  })
})

describe('output', () => {
  it('--json emits only the raw tool result on stdout; human mode renders a table', async () => {
    const rows = { snapshots: [{ harness: 'orca', free: 3 }, { harness: 'herdr', free: 0 }] }
    const r: Responder = (c) => c.body.method === 'tools/list' ? rpcOk({ tools: MOCK_TOOLS }) : toolOk(rows)
    expect(await run(['capacity', '--json'], { responder: r })).toBe(0)
    expect(JSON.parse(out)).toEqual(rows)
    expect(err).toBe('')
    expect(await run(['capacity'], { responder: r })).toBe(0)
    expect(out).toMatch(/harness\s+free/)
    expect(out).toMatch(/orca\s+3/)
  })

  it('--version prints the CLI version plus the sha256 of the file itself', async () => {
    expect(await run(['--version'])).toBe(0)
    const sha = createHash('sha256').update(readFileSync(CLI_PATH)).digest('hex')
    expect(out).toBe(`mupot 0.1.0 sha256:${sha}\n`)
    const r = spawnSync(process.execPath, [CLI_PATH, '--version'], { encoding: 'utf8' })
    expect(r.stdout).toBe(`mupot 0.1.0 sha256:${sha}\n`)
  })

  it('the file has no dependencies: no npm imports and nothing from src/', () => {
    const src = readFileSync(CLI_PATH, 'utf8')
    const imports = [...src.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])
    expect(imports.length).toBeGreaterThan(0)
    for (const i of imports) expect(i.startsWith('node:'), i).toBe(true)
    expect(src).not.toMatch(/require\(|from ['"]\.\.?\//)
    expect(existsSync(CLI_PATH)).toBe(true)
    expect(src.startsWith('#!/usr/bin/env node\n')).toBe(true)
    expect(statSync(CLI_PATH).mode & 0o111).not.toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------
// Round 2 (PR #1769 gate): credential binding, redaction, response validation, terminal safety.
// ---------------------------------------------------------------------------------------------

const SECOND = 'second-pot-token-0123456789ABCDEF'

function writeConfig(pots: Record<string, unknown>, def?: string) {
  writeFileSync(join(home, '.config', 'mupot', 'config.json'), JSON.stringify({ pots, ...(def ? { default: def } : {}) }))
}
function writeToken(path: string, value: string) {
  writeFileSync(path, `${value}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}
/** No 12-character substring of the secret may appear in the text (catches half-redacted leaks). */
function expectNoPartialSecret(text: string, secret = SECRET) {
  for (let i = 0; i + 12 <= secret.length; i += 1) expect(text, `substring @${i}`).not.toContain(secret.slice(i, i + 12))
}
const afterList = (r: (c: Call) => Response): Responder => (c) => (c.body.method === 'tools/list' ? rpcOk({ tools: MOCK_TOOLS }) : r(c))
const sentTokens = () => calls.map((c) => c.headers.authorization)

describe('P0: a credential is bound to one origin (never travels with the pot name)', () => {
  const GAF = 'https://gaf.example'
  it('env vars SET together with --pot: the pot\'s own token_file wins, the env token never reaches gaf', async () => {
    const gafTok = join(home, 'gaf.token')
    writeToken(gafTok, SECOND)
    writeConfig({ mumega: { api: 'https://mupot.mumega.com' }, gaf: { api: GAF, token_file: gafTok } })
    expect(await run(['--pot', 'gaf', 'tools'], { env: { MUPOT_TOKEN: 'env-only-token-ABCDEFGHIJ' } })).toBe(0)
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) {
      expect(c.url.startsWith(GAF)).toBe(true)
      expect(c.headers.authorization).toBe(`Bearer ${SECOND}`)
    }
    expect(JSON.stringify(sentTokens())).not.toContain(SECRET)
  })

  it('pot token at ~/.config/mupot/<pot>.token also outranks the env vars', async () => {
    writeToken(join(home, '.config', 'mupot', 'gaf.token'), SECOND)
    writeConfig({ gaf: { api: GAF } })
    expect(await run(['--pot', 'gaf', 'status'])).toBe(0)
    for (const c of calls) expect(c.headers.authorization).toBe(`Bearer ${SECOND}`)
  })

  it('env token + non-default pot that has no token of its own: refused (exit 2), nothing sent', async () => {
    writeConfig({ gaf: { api: GAF } })
    expect(await run(['--pot', 'gaf', 'tools'])).toBe(EXIT.USAGE)
    expect(err).toMatch(/default pot/)
    expect(calls).toHaveLength(0)
  })

  it('env token + non-default pot + --api elsewhere: refused (exit 2), nothing sent', async () => {
    writeConfig({ gaf: { api: GAF } })
    expect(await run(['--pot', 'gaf', '--api', 'https://evil.example', 'tools'])).toBe(EXIT.USAGE)
    expect(calls).toHaveLength(0)
  })

  it('a pot the config does not define cannot borrow any credential', async () => {
    expect(await run(['--pot', 'gaf', '--api', 'https://evil.example', 'tools'])).toBe(EXIT.USAGE)
    expect(calls).toHaveLength(0)
  })
})

describe('P1: --api never re-aims a bound token', () => {
  it('own token + --api to another origin, no env pairing: refused (exit 2), nothing sent', async () => {
    writeToken(join(home, '.config', 'mupot', 'mumega.token'), SECOND)
    expect(await run(['status', '--api', 'https://other.example'], { env: { MUPOT_TOKEN_FILE: '' } })).toBe(EXIT.USAGE)
    expect(err).toMatch(/bound to https:\/\/mupot\.mumega\.com/)
    expect(calls).toHaveLength(0)
    expect(await run(['tools', '--api', 'https://other.example'], { env: { MUPOT_TOKEN_FILE: '' } })).toBe(EXIT.USAGE)
    expect(calls).toHaveLength(0)
  })

  it('own token + --api to another origin + env token explicitly paired: only the env token goes there', async () => {
    writeToken(join(home, '.config', 'mupot', 'mumega.token'), SECOND)
    expect(await run(['status', '--api', 'https://other.example'])).toBe(0)
    for (const c of calls) {
      expect(c.url.startsWith('https://other.example')).toBe(true)
      expect(c.headers.authorization).toBe(`Bearer ${SECRET}`)
    }
    expect(JSON.stringify(sentTokens())).not.toContain(SECOND)
  })

  it('--api with the same origin as the bound one still uses the own token', async () => {
    writeToken(join(home, '.config', 'mupot', 'mumega.token'), SECOND)
    expect(await run(['status', '--api', 'https://mupot.mumega.com/'])).toBe(0)
    for (const c of calls) expect(c.headers.authorization).toBe(`Bearer ${SECOND}`)
  })

  it('a configured non-default pot with token_file cannot be re-aimed with --api', async () => {
    const t = join(home, 'acme.token')
    writeToken(t, SECOND)
    writeConfig({ acme: { api: 'https://acme.example', token_file: t } }, 'mumega')
    expect(await run(['--pot', 'acme', '--api', 'https://evil.example', 'status'], { env: { MUPOT_TOKEN_FILE: '' } })).toBe(EXIT.USAGE)
    expect(calls).toHaveLength(0)
  })

  it('production model: a bearerless tools/list is a 401, which is exit 3 (tools needs a token there)', async () => {
    const prod: Responder = (c) => (c.headers.authorization ? rpcOk({ tools: MOCK_TOOLS }) : json({ error: 'unauthenticated' }, 401))
    expect(await run(['tools'], { env: { MUPOT_TOKEN_FILE: '' }, responder: prod })).toBe(EXIT.AUTH)
    expect(calls).toHaveLength(1)
    expect(calls[0].headers.authorization).toBeUndefined()
    expect(await run(['tools'], { responder: prod })).toBe(0)
  })
})

describe('P2-1: redact BEFORE truncating', () => {
  it('a token straddling every truncation point never prints, not even partially', async () => {
    const pad = (n: number) => 'x'.repeat(n)
    const cases: Array<[string, string[], Responder]> = [
      ['rpc error message (snippet cut at 200)', ['status'], afterList(() => json({ jsonrpc: '2.0', id: 'AUTO', error: { code: -32000, message: `${pad(180)}${SECRET}${pad(50)}` } }))],
      ['401 reason', ['status'], () => json({ error: `${pad(180)}${SECRET}` }, 401)],
      ['table cell (cut at 48)', ['capacity'], afterList(() => toolOk({ rows: [{ note: `${pad(40)}${SECRET}`, n: 1 }] }))],
      ['tools line (cut at 110)', ['tools', '--refresh'], () => rpcOk({ tools: [{ name: 't', description: `${pad(70)}${SECRET}; minimum capability: member.` }] })],
      ['isError detail', ['status'], afterList(() => rpcOk({ isError: true, content: [], structuredContent: { ok: false, error: 'e', detail: { k: `${pad(180)}${SECRET}` } } }))],
      ['non-JSON isError text', ['status'], afterList(() => rpcOk({ isError: true, content: [{ type: 'text', text: `${pad(190)}${SECRET}` }] }))],
    ]
    for (const [label, argv, responder] of cases) {
      await run(argv, { responder })
      expectNoPartialSecret(out + err)
      expect(out + err, label).toBeDefined()
    }
  })
})

describe('P2-2: a success-shaped no-op is not a success', () => {
  it('requires result|error AND id === request id', async () => {
    const cases: Array<[string, Response, number]> = [
      ['no result/error', new Response('{"jsonrpc":"2.0","id":2}', { headers: { 'content-type': 'application/json' } }), EXIT.TOOL],
      ['plain status object', json({ status: 'ok' }), EXIT.TOOL],
      ['wrong id', json({ jsonrpc: '2.0', id: 999, result: { structuredContent: { a: 1 }, content: [] } }), EXIT.TOOL],
      ['array body', json([{ jsonrpc: '2.0', id: 2, result: {} }]), EXIT.NETWORK],
      ['non-JSON 200', new Response('ok', { status: 200 }), EXIT.NETWORK],
      ['SSE with only a wrong id', new Response(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 999, result: {} })}\n\n`, { headers: { 'content-type': 'text/event-stream' } }), EXIT.NETWORK],
    ]
    for (const [label, bad, code] of cases) {
      expect(await run(['status'], { responder: afterList(() => bad.clone()) }), label).toBe(code)
      expect(out, label).toBe('')
    }
    // the same guard protects tools/list
    expect(await run(['tools', '--refresh'], { responder: () => json({ status: 'ok' }) })).toBe(EXIT.TOOL)
    expect(await run(['tools', '--refresh'], { responder: () => json({ jsonrpc: '2.0', id: 999, result: { tools: MOCK_TOOLS } }) })).toBe(EXIT.TOOL)
  })
})

describe('P2-3: terminal escapes in server-supplied strings', () => {
  const NASTY = 'a\u001b[31mRED\u001b]0;pwn\u0007b\rc\u009bd\u007fe\tf\ng'
  const RAW_CTL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/
  const responder: Responder = (c) => (c.body.method === 'tools/list'
    ? rpcOk({ tools: [{ name: `evil${NASTY}`, description: `scope${NASTY}; minimum capability: member.`, inputSchema: { type: 'object', properties: { p: { type: 'string', description: NASTY } } } }] })
    : toolOk({ body: NASTY, messages: [{ id: 'm', body: NASTY }] }))

  it('human mode prints no raw control characters (results, errors, tool names, descriptions, inbox bodies)', async () => {
    await run(['status'], { responder: () => json({ jsonrpc: '2.0', id: 'AUTO', error: { message: NASTY } }) })
    expect(err).not.toMatch(RAW_CTL)
    await run(['status'], { responder: afterList(() => rpcOk({ isError: true, content: [], structuredContent: { ok: false, error: NASTY, detail: { x: NASTY } } })) })
    expect(err).not.toMatch(RAW_CTL)
    await run(['inbox', '--peek'], { responder: (c) => (c.body.method === 'tools/list' ? rpcOk({ tools: MOCK_TOOLS }) : toolOk({ messages: [{ id: 'm', body: NASTY }] })) })
    expect(out).not.toMatch(RAW_CTL)
    expect(out).toContain('\\x1b')
    await run(['status'], { responder: (c) => (c.body.method === 'tools/list' ? rpcOk({ tools: MOCK_TOOLS }) : toolOk({ body: NASTY })) })
    expect(out).not.toMatch(RAW_CTL)
    expect(out).toContain('\tf\ng') // tab and newline are the only controls kept
    await run(['tools', '--refresh'], { responder })
    expect(out).toContain('evil')
    expect(out).not.toMatch(RAW_CTL)
    await run(['help', 'evil', '--refresh'], { responder })
    expect(out + err).not.toMatch(RAW_CTL)
  })

  it('--json stays raw JSON: no raw control bytes, and the value round-trips exactly', async () => {
    await run(['status', '--json'], { responder: (c) => (c.body.method === 'tools/list' ? rpcOk({ tools: MOCK_TOOLS }) : toolOk({ body: NASTY })) })
    expect(out).not.toMatch(RAW_CTL)
    expect(JSON.parse(out)).toEqual({ body: NASTY })
    await run(['tools', '--json', '--refresh'], { responder })
    expect(out).not.toMatch(RAW_CTL)
    expect(JSON.parse(out)[0].name).toBe(`evil${NASTY}`)
    await run(['status', '--json'], { responder: afterList(() => rpcOk({ isError: true, content: [], structuredContent: { ok: false, error: NASTY } })) })
    expect(err).not.toMatch(RAW_CTL)
    expect(JSON.parse(err).error).toBe(NASTY)
  })
})

describe('P2-4: --version only swallows the flag when no tool is named', () => {
  it('routine_proposal_submit --version 2 reaches the tool as version:2', async () => {
    expect((TOOLS.find((t) => t.name === 'routine_proposal_submit')!.inputSchema as { properties: Record<string, unknown> }).properties).toHaveProperty('version')
    expect(await run(['routine_proposal_submit', '--version', '2', '--title', 't'])).toBe(0)
    expect(toolCalls()[0].body.params).toEqual({ name: 'routine_proposal_submit', arguments: { version: 2, title: 't' } })
    expect(out).not.toMatch(/sha256/)
  })

  it('--version / -V print the version as the first token or with no tool named', async () => {
    for (const argv of [['--version'], ['-V'], ['--version', '--json'], ['--pot', 'mumega', '--version']]) {
      expect(await run(argv), argv.join(' ')).toBe(0)
      expect(out).toMatch(/^mupot 0\.1\.0 sha256:[0-9a-f]{64}\n$/)
    }
    expect(await run(['status', '--version'])).toBe(EXIT.USAGE)
    expect(out).toBe('')
  })
})

describe('P3', () => {
  it('a response body that times out while being read is a network error (4)', async () => {
    const hang: Responder = () => ({
      status: 200, type: 'default', ok: true, headers: new Headers({ 'content-type': 'application/json' }),
      text: () => Promise.reject(new DOMException('timed out', 'TimeoutError')),
    } as unknown as Response)
    expect(await run(['status'], { responder: hang })).toBe(EXIT.NETWORK)
    expect(err).toMatch(/timeout/)
  })

  it('send --to bob hello world keeps the whole text; conflicting forms are usage errors', async () => {
    expect(await run(['send', '--to', 'bob', 'hello', 'world'])).toBe(0)
    expect(toolCalls()[0].body.params.arguments).toEqual({ to: 'bob', body: 'hello world' })
    calls = []
    expect(await run(['send', 'bob', '--body', 'x', 'extra'])).toBe(EXIT.USAGE)
    expect(await run(['send', '--to', 'bob', '--body', 'x'])).toBe(0)
    expect(await run(['send', 'bob', 'hi', '--to', 'carol'])).toBe(0)
    expect(toolCalls().pop()!.body.params.arguments).toEqual({ to: 'carol', body: 'bob hi' })
  })

  it('a boolean flag consumes only true/false/yes/no/1/0 and otherwise keeps the word', () => {
    const schema = { properties: { dispatch: { type: 'boolean' } } }
    const f = { t: 'flag', name: 'dispatch' }
    for (const [w, v] of [['no', false], ['yes', true], ['0', false], ['1', true], ['FALSE', false]] as const) {
      const r = resolveArgs([f, { t: 'pos', v: w }], schema)
      expect(r.args.dispatch, w).toBe(v)
      expect(r.positionals, w).toEqual([])
    }
    const r = resolveArgs([f, { t: 'pos', v: 'word' }], schema)
    expect(r.args.dispatch).toBe(true)
    expect(r.positionals).toEqual(['word'])
  })

  it('rejects hex, exponent, Infinity, blank and padded numbers', () => {
    for (const bad of ['0x10', '1e3', '1E3', 'Infinity', '', ' 5', '5 ', '.5', '+5', '0b1', '1_0']) {
      expect(() => coerceArg('n', { type: 'number' }, [bad]), JSON.stringify(bad)).toThrow(/decimal number/)
    }
    expect(coerceArg('n', { type: 'number' }, ['-3.5'])).toBe(-3.5)
    expect(coerceArg('n', { type: 'integer' }, ['007'])).toBe(7)
  })

  it('credential-looking flags are refused case-insensitively and by substring, before any network', async () => {
    for (const flag of ['--Token', '--TOKEN=x1234567', '--api-token', '--my-secret', '--passwordFile', '--x-Bearer-y', '--Authorization', '--ApiKey', '--api-key']) {
      calls = []
      const argv = ['task_list', flag, ...(flag.includes('=') ? [] : [SECRET])]
      expect(await run(argv), flag).toBe(EXIT.USAGE)
      expect(out + err).not.toContain(SECRET)
      expect(calls, flag).toHaveLength(0)
    }
    expect(await run(['task_list', '--limit', '3'])).toBe(0)
  })

  it('check-cli-bundle-fresh.mjs still checks when run through a symlink', () => {
    const link = join(home, 'check-link.mjs')
    symlinkSync(join(__dirname, '..', 'scripts', 'check-cli-bundle-fresh.mjs'), link)
    const r = spawnSync(process.execPath, [link], { encoding: 'utf8' })
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/cli bundle is fresh/)
  })

  it('null error data / detail is not printed as the word null', async () => {
    await run(['status'], { responder: afterList(() => json({ jsonrpc: '2.0', id: 'AUTO', error: { code: -32000, message: 'internal_error', data: null } })) })
    expect(err).toBe('mupot: internal_error\n')
    await run(['status'], { responder: afterList(() => rpcOk({ isError: true, content: [], structuredContent: { ok: false, error: 'internal_error', status: 500, detail: null } })) })
    expect(err).toBe('error: internal_error (status 500)\n')
  })
})
