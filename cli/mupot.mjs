#!/usr/bin/env node
// mupot - command-line client for a mupot pot (MCP over HTTP, JSON-RPC).
//
// ZERO dependencies: Node >= 20, built-in fetch, node: built-ins only. No imports from src/.
// Distributed from the pot itself: GET /cli serves these exact bytes (see docs/cli.md).
//
// Security invariants (each has a test in tests/mupot-cli.test.ts):
//   - The bearer token is NEVER accepted as a command-line argument (argv is world-readable
//     via /proc and `ps`). It comes from a 0600 file or the MUPOT_TOKEN env var only.
//   - The token is never printed: every byte written to stdout/stderr passes through a
//     redactor that knows every secret this process has loaded or rejected.
//   - A group/world-accessible token file is refused.
//   - Redirects are never followed with the bearer attached (redirect: 'manual'; 3xx = error).
//   - A cleartext http:// API is refused except for loopback (the bearer would cross the wire).

import { createHash } from 'node:crypto'
import {
  closeSync, fstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const VERSION = '0.1.0'
export const EXIT = Object.freeze({ OK: 0, TOOL: 1, USAGE: 2, AUTH: 3, NETWORK: 4 })

const DEFAULT_API = 'https://mupot.mumega.com'
const DEFAULT_POT = 'mumega'
const CACHE_TTL_MS = 60 * 60 * 1000
const PROTOCOL_VERSION = '2025-06-18'
const DEFAULT_TIMEOUT_S = 30
const MIN_SECRET_LEN = 6

// Auth-looking flag names that must never carry a secret on the command line.
const FORBIDDEN_FLAGS = new Set(['token', 'bearer', 'authorization', 'auth-token', 'auth', 'api-key', 'apikey', 'access-token', 'password'])

const GLOBAL_BOOL = new Set(['json', 'refresh', 'help', 'version'])
const GLOBAL_VALUE = new Set(['pot', 'api', 'json-args', 'timeout'])

class CliError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}
const usageError = (m) => new CliError(EXIT.USAGE, m)

// ---- shortcuts: thin aliases onto real tools (names + args verified against src/mcp) ----
// `pos` maps positional words to tool args; flags are then coerced against the tool's schema.
export const SHORTCUTS = {
  status: { tool: 'boot_context', usage: 'status', help: 'Boot context for this token (boot_context). Note: records a presence touch.' },
  whoami: { tool: 'status', usage: 'whoami', help: 'Who am I: principal, capabilities, seat (the status tool with no agent_id).' },
  inbox: { tool: 'inbox', usage: 'inbox [--peek] [--limit N] [--since-seq N]', help: 'Read your agent inbox. Without --peek, messages are consumed per server semantics.' },
  ack: {
    tool: 'inbox_ack',
    usage: 'ack <id...>',
    help: 'Acknowledge inbox messages (inbox_ack { ids }). Ids may be repeated or comma separated.',
    pos: (p) => (p.length ? { ids: p.flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean) } : {}),
  },
  send: {
    tool: 'send',
    usage: 'send <to> <text...> [--kind K] [--in-reply-to ID] [--request-id ID]',
    help: 'Send a message to an agent (send { to, body }).',
    pos: (p) => ({ ...(p[0] ? { to: p[0] } : {}), ...(p.length > 1 ? { body: p.slice(1).join(' ') } : {}) }),
  },
  capacity: { tool: 'harness_capacity_list', usage: 'capacity [--harness orca|herdr] [--limit N]', help: 'Harness capacity snapshots (harness_capacity_list).' },
  'task list': { tool: 'task_list', usage: 'task list [--status S] [--squad-id ID] [--project-id ID] [--limit N]', help: 'List tasks (task_list).' },
  'task get': {
    tool: 'task_get',
    usage: 'task get <task_id>',
    help: 'Fetch one task (task_get { task_id }).',
    pos: (p) => (p[0] ? { task_id: p[0] } : {}),
  },
  'task new': {
    tool: 'task_create',
    usage: 'task new <title...> --done-when <predicate> [--body T] [--priority P0..P3] [--squad-id ID]',
    help: 'Create a task (task_create { title, done_when, ... }). A write.',
    pos: (p) => (p.length ? { title: p.join(' ') } : {}),
  },
}

const GENERAL_HELP = `mupot ${VERSION} - command-line client for a mupot pot

usage:
  mupot tools [filter] [--refresh]       list live tool names and descriptions
  mupot help [tool|shortcut]             show usage / a tool's input schema
  mupot <tool> [--key value ...]         call any tool; flags are coerced from its inputSchema
  mupot <tool> --json-args '{...}'       pass raw JSON args ('-' reads the JSON from stdin)
  mupot call <tool> ...                  same, explicit (use when a tool name equals a shortcut)

shortcuts:
${Object.entries(SHORTCUTS).map(([k, v]) => `  mupot ${v.usage.padEnd(52)} ${v.help.split('.')[0]}`).join('\n')}

other:
  mupot agent-context                    machine-readable JSON description of this CLI
  mupot --version                        version + sha256 of this file

global flags:
  --pot <name>      profile from ~/.config/mupot/config.json (default: config "default", else "${DEFAULT_POT}")
  --api <url>       API base (default ${DEFAULT_API}); overrides the profile
  --json            raw result only, as JSON, on stdout
  --refresh         bypass the 1h tools/list cache (~/.cache/mupot/)
  --timeout <sec>   request timeout (default ${DEFAULT_TIMEOUT_S})

auth: token file $MUPOT_TOKEN_FILE, else the profile token_file, else ~/.config/mupot/<pot>.token
      (mode 0600 required), else env MUPOT_TOKEN. A token is never accepted as an argument.

exit codes: 0 ok, 1 tool error, 2 usage, 3 auth, 4 network
`

// ------------------------------------------------------------------ context & output

function makeCtx(io) {
  const env = io.env ?? process.env
  const secrets = new Set()
  const envTok = (env.MUPOT_TOKEN ?? '').trim()
  if (envTok.length >= MIN_SECRET_LEN) secrets.add(envTok)
  const rawOut = io.out ?? ((s) => process.stdout.write(s))
  const rawErr = io.err ?? ((s) => process.stderr.write(s))
  const redact = (s) => {
    let t = String(s)
    for (const sec of secrets) t = t.split(sec).join('[redacted]')
    return t.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [redacted]')
  }
  return {
    env,
    home: io.home ?? homedir(),
    fetch: io.fetch ?? globalThis.fetch,
    now: io.now ?? (() => Date.now()),
    readStdin: io.readStdin ?? (() => readFileSync(0, 'utf8')),
    secrets,
    redact,
    out: (s) => rawOut(redact(s)),
    err: (s) => rawErr(redact(s)),
    rid: 0,
    json: false,
    refresh: false,
    timeoutS: DEFAULT_TIMEOUT_S,
  }
}

// ------------------------------------------------------------------ arg parsing

function tokenize(argv) {
  const items = []
  let rest = false
  for (const a of argv) {
    if (rest) { items.push({ t: 'pos', v: a }); continue }
    if (a === '--') { rest = true; continue }
    if (a === '-h') { items.push({ t: 'flag', name: 'help', eq: 'true' }); continue }
    if (a.startsWith('--') && a.length > 2) {
      const body = a.slice(2)
      const eqi = body.indexOf('=')
      items.push(eqi >= 0 ? { t: 'flag', name: body.slice(0, eqi), eq: body.slice(eqi + 1) } : { t: 'flag', name: body })
    } else {
      items.push({ t: 'pos', v: a })
    }
  }
  return items
}

function parseBool(raw, name) {
  const v = String(raw).trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(v)) return true
  if (['false', '0', 'no', 'off'].includes(v)) return false
  throw usageError(`--${name}: expected a boolean (true/false), got "${raw}"`)
}

/** Extract global flags; return {globals, items} where items has globals removed. */
function extractGlobals(ctx, items) {
  const globals = {}
  const out = []
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i]
    if (it.t === 'flag' && FORBIDDEN_FLAGS.has(it.name)) {
      // Register the would-be secret with the redactor, then refuse WITHOUT echoing it.
      const next = items[i + 1]
      const val = it.eq ?? (next && next.t === 'pos' ? next.v : undefined)
      if (val && val.length >= MIN_SECRET_LEN) ctx.secrets.add(val)
      throw usageError(`--${it.name}: credentials are never accepted on the command line (use $MUPOT_TOKEN_FILE, ~/.config/mupot/<pot>.token, or $MUPOT_TOKEN; a tool parameter with this name can be passed via --json-args -)`)
    }
    if (it.t === 'flag' && GLOBAL_BOOL.has(it.name)) {
      globals[it.name] = it.eq === undefined ? true : parseBool(it.eq, it.name)
      continue
    }
    if (it.t === 'flag' && GLOBAL_VALUE.has(it.name)) {
      let v = it.eq
      if (v === undefined) {
        const next = items[i + 1]
        if (!next || next.t !== 'pos') throw usageError(`--${it.name} requires a value`)
        v = next.v
        i += 1
      }
      globals[it.name] = v
      continue
    }
    out.push(it)
  }
  return { globals, items: out }
}

export function primaryType(schema) {
  if (!schema || typeof schema !== 'object') return undefined
  const t = schema.type
  if (typeof t === 'string') return t
  if (Array.isArray(t)) return t.find((x) => x !== 'null')
  if (Array.isArray(schema.enum)) return 'string'
  if (Array.isArray(schema.anyOf)) {
    const hit = schema.anyOf.map(primaryType).find((x) => x && x !== 'null')
    if (hit) return hit
  }
  return undefined
}

function coerceScalar(name, type, raw) {
  if (typeof raw !== 'string') return raw // already typed (came from a JSON array)
  if (type === 'number' || type === 'integer') {
    if (raw.trim() === '' || !Number.isFinite(Number(raw))) throw usageError(`--${name}: expected a number, got "${raw}"`)
    const n = Number(raw)
    if (type === 'integer' && !Number.isInteger(n)) throw usageError(`--${name}: expected an integer, got "${raw}"`)
    return n
  }
  if (type === 'boolean') return parseBool(raw, name)
  if (type === 'object') return parseJsonObject(name, raw)
  return raw
}

function parseJsonObject(name, raw) {
  let v
  try { v = JSON.parse(raw) } catch { throw usageError(`--${name}: expected a JSON object`) }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw usageError(`--${name}: expected a JSON object`)
  return v
}

/** Coerce the raw string values collected for one flag using its inputSchema. */
export function coerceArg(name, schema, raws) {
  const type = primaryType(schema)
  const last = raws[raws.length - 1]
  switch (type) {
    case 'boolean':
      return parseBool(last, name)
    case 'number':
    case 'integer':
      return coerceScalar(name, type, last)
    case 'object':
      return parseJsonObject(name, last)
    case 'array': {
      const itemType = primaryType(schema.items)
      const flat = []
      for (const r of raws) {
        const s = r.trim()
        if (s.startsWith('[')) {
          let arr
          try { arr = JSON.parse(s) } catch { throw usageError(`--${name}: invalid JSON array`) }
          if (!Array.isArray(arr)) throw usageError(`--${name}: expected a JSON array`)
          flat.push(...arr)
        } else if (itemType === 'object') {
          flat.push(r)
        } else {
          flat.push(...s.split(',').map((x) => x.trim()).filter((x) => x.length > 0))
        }
      }
      return flat.map((x) => coerceScalar(name, itemType, x))
    }
    default:
      return last
  }
}

function lookupProp(props, name) {
  if (Object.prototype.hasOwnProperty.call(props, name)) return name
  const snake = name.replace(/-/g, '_')
  if (Object.prototype.hasOwnProperty.call(props, snake)) return snake
  return undefined
}

/** Resolve remaining flag/positional items against a tool schema. */
export function resolveArgs(items, schema) {
  const props = (schema && schema.properties) || {}
  const closed = schema && schema.additionalProperties === false
  const positionals = []
  const raw = new Map()
  const push = (k, v) => { raw.set(k, [...(raw.get(k) ?? []), v]) }
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i]
    if (it.t === 'pos') { positionals.push(it.v); continue }
    let name = it.name
    let negate = false
    let key = lookupProp(props, name)
    if (key === undefined && name.startsWith('no-')) {
      const k2 = lookupProp(props, name.slice(3))
      if (k2 !== undefined && primaryType(props[k2]) === 'boolean') { key = k2; negate = true; name = name.slice(3) }
    }
    if (key === undefined) {
      if (closed) throw usageError(`unknown flag --${it.name} (see: mupot help <tool>)`)
      key = it.name.replace(/-/g, '_')
    }
    const type = primaryType(props[key])
    let val
    if (negate) {
      val = 'false'
    } else if (it.eq !== undefined) {
      val = it.eq
    } else if (type === 'boolean') {
      const next = items[i + 1]
      if (next && next.t === 'pos' && /^(true|false)$/i.test(next.v)) { val = next.v; i += 1 } else val = 'true'
    } else {
      const next = items[i + 1]
      if (!next || next.t !== 'pos') throw usageError(`--${it.name} requires a value`)
      val = next.v
      i += 1
    }
    push(key, val)
  }
  const args = {}
  for (const [key, raws] of raw) args[key] = coerceArg(key, props[key], raws)
  return { positionals, args }
}

// ------------------------------------------------------------------ config & auth

function readJsonFile(path, label) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') return null
    throw usageError(`cannot read ${label} ${path}: ${e && e.code ? e.code : 'error'}`)
  }
  try { return JSON.parse(text) } catch { throw usageError(`${label} ${path} is not valid JSON`) }
}

function expandHome(ctx, p) {
  if (p === '~') return ctx.home
  if (p.startsWith('~/')) return join(ctx.home, p.slice(2))
  return p
}

function resolveTarget(ctx, globals) {
  const cfgPath = join(ctx.home, '.config', 'mupot', 'config.json')
  const cfg = readJsonFile(cfgPath, 'config') ?? {}
  const pots = cfg && typeof cfg.pots === 'object' && cfg.pots !== null ? cfg.pots : {}
  const pot = globals.pot ?? (typeof cfg.default === 'string' ? cfg.default : DEFAULT_POT)
  if (!/^[A-Za-z0-9_.-]+$/.test(pot) || pot.startsWith('.')) throw usageError('invalid --pot name')
  const entry = Object.prototype.hasOwnProperty.call(pots, pot) && pots[pot] && typeof pots[pot] === 'object' ? pots[pot] : undefined
  let api = globals.api ?? (entry && typeof entry.api === 'string' ? entry.api : undefined)
  if (api === undefined) {
    if (pot !== DEFAULT_POT) throw usageError(`pot "${pot}" has no api in ${cfgPath}; add it or pass --api`)
    api = DEFAULT_API
  }
  let url
  try { url = new URL(api) } catch { throw usageError('invalid --api URL') }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw usageError('refusing a non-https API (the bearer token would cross the network in cleartext); http:// is allowed for loopback only')
  }
  if (url.username || url.password) throw usageError('credentials in the API URL are not accepted')
  const base = `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  return { pot, api: base, tokenFile: entry && typeof entry.token_file === 'string' ? entry.token_file : undefined }
}

/** Read a token file. Returns null only when the file does not exist. */
function readTokenFile(ctx, path) {
  let fd
  try {
    fd = openSync(path, 'r')
  } catch (e) {
    if (e && e.code === 'ENOENT') return null
    throw new CliError(EXIT.AUTH, `cannot open token file ${path}: ${e && e.code ? e.code : 'error'}`)
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) throw new CliError(EXIT.AUTH, `token file ${path} is not a regular file`)
    if (st.mode & 0o077) {
      const mode = (st.mode & 0o777).toString(8).padStart(3, '0')
      throw new CliError(EXIT.AUTH, `token file ${path} is accessible by group/others (mode ${mode}); refusing to use it. Fix with: chmod 600 ${path}`)
    }
    const token = readFileSync(fd, 'utf8').trim()
    if (token.length >= MIN_SECRET_LEN) ctx.secrets.add(token)
    return validateToken(token, `token file ${path}`)
  } finally {
    closeSync(fd)
  }
}

function validateToken(token, where) {
  if (!token) throw new CliError(EXIT.AUTH, `${where} is empty`)
  if (!/^[\x21-\x7e]+$/.test(token)) throw new CliError(EXIT.AUTH, `${where} contains characters not valid in a bearer token`)
  return token
}

export function loadToken(ctx, target) {
  const explicit = ctx.env.MUPOT_TOKEN_FILE
  if (explicit) {
    const t = readTokenFile(ctx, expandHome(ctx, explicit))
    if (t === null) throw new CliError(EXIT.AUTH, `MUPOT_TOKEN_FILE ${explicit} does not exist`)
    return t
  }
  if (target.tokenFile) {
    const p = expandHome(ctx, target.tokenFile)
    const t = readTokenFile(ctx, p)
    if (t === null) throw new CliError(EXIT.AUTH, `token_file ${p} (pot "${target.pot}") does not exist`)
    return t
  }
  const def = join(ctx.home, '.config', 'mupot', `${target.pot}.token`)
  const t = readTokenFile(ctx, def)
  if (t !== null) return t
  const envTok = (ctx.env.MUPOT_TOKEN ?? '').trim()
  if (envTok) return validateToken(envTok, 'MUPOT_TOKEN')
  return null
}

function requireToken(ctx, target) {
  const t = loadToken(ctx, target)
  if (t === null) {
    throw new CliError(EXIT.AUTH, `no token found for pot "${target.pot}". Provide a 0600 file via $MUPOT_TOKEN_FILE or ~/.config/mupot/${target.pot}.token, or set $MUPOT_TOKEN.`)
  }
  return t
}

// ------------------------------------------------------------------ transport

function safeSnippet(v) {
  const s = typeof v === 'string' ? v : ''
  return s.length > 200 ? `${s.slice(0, 200)}...` : s
}

function parseSse(text, id) {
  let found
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n')
    if (!data) continue
    try {
      const msg = JSON.parse(data)
      if (msg && (msg.id === id || 'result' in msg || 'error' in msg)) found = msg
    } catch { /* ignore non-JSON events */ }
  }
  return found
}

async function rpc(ctx, target, token, method, params) {
  ctx.rid += 1
  const id = ctx.rid
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': PROTOCOL_VERSION,
    'user-agent': `mupot-cli/${VERSION}`,
  }
  if (token) headers.authorization = `Bearer ${token}`
  const url = `${target.api}/mcp`
  let res
  try {
    res = await ctx.fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      redirect: 'manual',
      signal: AbortSignal.timeout(ctx.timeoutS * 1000),
    })
  } catch (e) {
    const code = e && e.cause && e.cause.code ? e.cause.code : e && e.name === 'TimeoutError' ? 'timeout' : 'unreachable'
    throw new CliError(EXIT.NETWORK, `network error contacting ${new URL(url).host} (${code})`)
  }
  if ((res.status >= 300 && res.status < 400) || res.type === 'opaqueredirect') {
    throw new CliError(EXIT.NETWORK, `${new URL(url).host} answered with a redirect (HTTP ${res.status}); refusing to follow it with credentials`)
  }
  const text = await res.text()
  const ctype = (res.headers.get('content-type') ?? '').toLowerCase()
  let msg
  if (ctype.includes('text/event-stream')) msg = parseSse(text, id)
  else { try { msg = JSON.parse(text) } catch { msg = undefined } }
  if (res.status === 401 || res.status === 403) {
    const why = safeSnippet(msg && (typeof msg.error === 'string' ? msg.error : msg.error && msg.error.message))
    throw new CliError(EXIT.AUTH, `authentication/authorization failed (HTTP ${res.status}${why ? `: ${why}` : ''})`)
  }
  if (!msg || typeof msg !== 'object') {
    throw new CliError(res.status >= 500 || res.status === 429 ? EXIT.NETWORK : EXIT.TOOL, `unexpected non-JSON response (HTTP ${res.status})`)
  }
  if (msg.error) {
    const e = msg.error
    const m = typeof e === 'string' ? e : e.message ?? 'error'
    const detail = typeof e === 'object' && e.data !== undefined ? ` ${JSON.stringify(e.data)}` : ''
    throw new CliError(EXIT.TOOL, `${safeSnippet(String(m))}${detail}`.trim())
  }
  if (!res.ok) throw new CliError(res.status >= 500 ? EXIT.NETWORK : EXIT.TOOL, `HTTP ${res.status}`)
  return msg.result
}

// ------------------------------------------------------------------ tools cache

function cachePath(ctx, target) {
  const key = createHash('sha256').update(`${target.api}\0${target.pot}`).digest('hex').slice(0, 16)
  return join(ctx.home, '.cache', 'mupot', `tools-${key}.json`)
}

function readCache(ctx, target) {
  try {
    const c = JSON.parse(readFileSync(cachePath(ctx, target), 'utf8'))
    if (c && c.api === target.api && c.pot === target.pot && Array.isArray(c.tools) && typeof c.fetched_at === 'number'
      && ctx.now() - c.fetched_at < CACHE_TTL_MS && ctx.now() >= c.fetched_at) return c.tools
  } catch { /* miss */ }
  return null
}

function writeCache(ctx, target, tools) {
  try {
    const p = cachePath(ctx, target)
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 })
    const tmp = `${p}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ api: target.api, pot: target.pot, fetched_at: ctx.now(), tools }), { mode: 0o600 })
    renameSync(tmp, p)
  } catch { /* cache is best-effort */ }
}

/** tools/list is bearerless on the server; a token is sent when one exists, never required. */
async function getTools(ctx, target, { force = false } = {}) {
  if (!force && !ctx.refresh) {
    const hit = readCache(ctx, target)
    if (hit) return hit
  }
  const token = loadToken(ctx, target)
  const result = await rpc(ctx, target, token, 'tools/list', {})
  const tools = Array.isArray(result && result.tools) ? result.tools : null
  if (!tools) throw new CliError(EXIT.TOOL, 'server returned no tools list')
  writeCache(ctx, target, tools)
  return tools
}

async function findTool(ctx, target, name) {
  let tools = await getTools(ctx, target)
  let tool = tools.find((t) => t.name === name)
  if (!tool && !ctx.refresh) {
    tools = await getTools(ctx, target, { force: true })
    tool = tools.find((t) => t.name === name)
  }
  if (!tool) throw usageError(`unknown tool "${name}" (list them with: mupot tools)`)
  return tool
}

// ------------------------------------------------------------------ rendering

function scalar(v) {
  if (v === null || v === undefined) return '-'
  if (typeof v === 'string') return v
  return String(v)
}

function isScalar(v) { return v === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof v) }
function isPlain(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) }

export function renderHuman(value, indent = 0) {
  const pad = ' '.repeat(indent)
  if (isScalar(value)) return `${pad}${scalar(value)}`
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}(empty)`
    if (value.every((r) => isPlain(r) && Object.values(r).every(isScalar))) {
      const cols = [...new Set(value.flatMap((r) => Object.keys(r)))]
      const cell = (v) => { const s = scalar(v).replace(/\s+/g, ' '); return s.length > 48 ? `${s.slice(0, 45)}...` : s }
      const widths = cols.map((c) => Math.max(c.length, ...value.map((r) => cell(r[c]).length)))
      const line = (cells) => `${pad}${cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd()}`
      return [line(cols), ...value.map((r) => line(cols.map((c) => cell(r[c]))))].join('\n')
    }
    return value.map((v) => (isScalar(v) ? `${pad}- ${scalar(v)}` : `${pad}-\n${renderHuman(v, indent + 2)}`)).join('\n')
  }
  const keys = Object.keys(value)
  if (keys.length === 0) return `${pad}(empty)`
  return keys.map((k) => {
    const v = value[k]
    if (isScalar(v)) return `${pad}${k}: ${scalar(v)}`
    if (Array.isArray(v) && v.length === 0) return `${pad}${k}: (empty)`
    return `${pad}${k}:\n${renderHuman(v, indent + 2)}`
  }).join('\n')
}

function printValue(ctx, value) {
  ctx.out(`${ctx.json ? JSON.stringify(value, null, 2) : renderHuman(value)}\n`)
}

function toolBlurb(t) {
  const d = String(t.description ?? '')
  const scope = d.split(';')[0]
  const min = /minimum capability: (\w+)/.exec(d)
  return `${min ? `[${min[1]}] ` : ''}${scope}`
}

function renderToolHelp(tool, usage) {
  const schema = tool.inputSchema ?? {}
  const props = schema.properties ?? {}
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  const lines = []
  if (usage) lines.push(`usage: mupot ${usage}`)
  lines.push(`${tool.name} - ${String(tool.description ?? '').split(' Args:')[0]}`)
  const names = Object.keys(props)
  if (names.length === 0) lines.push('parameters: none')
  else {
    lines.push('parameters (flag form: --name value, underscores may be written as dashes):')
    for (const n of names) {
      const p = props[n] ?? {}
      const t = primaryType(p) ?? 'any'
      const extra = [required.has(n) ? 'required' : null, Array.isArray(p.enum) ? `one of ${p.enum.join('|')}` : null, p.description ?? null].filter(Boolean).join('; ')
      lines.push(`  --${n} <${t}>${extra ? `  ${extra}` : ''}`)
    }
  }
  lines.push(`raw form: mupot ${tool.name} --json-args '{...}'`)
  return lines.join('\n')
}

// ------------------------------------------------------------------ commands

function readJsonArgs(ctx, spec) {
  const text = spec === '-' ? ctx.readStdin() : spec
  let v
  try { v = JSON.parse(text) } catch { throw usageError('--json-args: invalid JSON') }
  if (!isPlain(v)) throw usageError('--json-args: expected a JSON object')
  return v
}

function handleToolResult(ctx, result) {
  if (result && result.isError) {
    let body = result.structuredContent
    if (body === undefined) {
      const txt = Array.isArray(result.content) && result.content[0] ? result.content[0].text : undefined
      try { body = JSON.parse(txt) } catch { body = { error: safeSnippet(txt) || 'tool error' } }
    }
    if (ctx.json) ctx.err(`${JSON.stringify(body)}\n`)
    else {
      const b = isPlain(body) ? body : { error: String(body) }
      ctx.err(`error: ${scalar(b.error)}${b.status !== undefined ? ` (status ${b.status})` : ''}\n`)
      if (b.detail !== undefined) ctx.err(`${renderHuman(b.detail, 2)}\n`)
      if (b.need !== undefined) ctx.err(`  need: ${typeof b.need === 'string' ? b.need : JSON.stringify(b.need)}\n`)
    }
    return EXIT.TOOL
  }
  let payload = result && result.structuredContent
  if (payload === undefined) {
    const txt = result && Array.isArray(result.content) && result.content[0] ? result.content[0].text : undefined
    try { const parsed = JSON.parse(txt); payload = parsed && 'result' in parsed ? parsed.result : parsed } catch { payload = txt ?? result }
  }
  printValue(ctx, payload)
  return EXIT.OK
}

async function cmdTools(ctx, target, positionals) {
  const tools = await getTools(ctx, target)
  const filter = positionals[0]?.toLowerCase()
  const shown = filter ? tools.filter((t) => t.name.toLowerCase().includes(filter)) : tools
  if (ctx.json) {
    ctx.out(`${JSON.stringify(shown, null, 2)}\n`)
    return EXIT.OK
  }
  const w = Math.max(0, ...shown.map((t) => t.name.length))
  for (const t of shown) {
    const line = `${t.name.padEnd(w)}  ${toolBlurb(t)}`
    ctx.out(`${line.length > 110 ? `${line.slice(0, 107)}...` : line}\n`)
  }
  ctx.out(`${shown.length} tool(s)\n`)
  return EXIT.OK
}

async function cmdHelp(ctx, target, what) {
  if (!what) { ctx.out(GENERAL_HELP); return EXIT.OK }
  const sc = SHORTCUTS[what]
  const name = sc ? sc.tool : what
  const tool = await findTool(ctx, target, name)
  if (ctx.json) { ctx.out(`${JSON.stringify(tool.inputSchema ?? {}, null, 2)}\n`); return EXIT.OK }
  ctx.out(`${renderToolHelp(tool, sc && sc.usage)}\n`)
  return EXIT.OK
}

export function agentContext() {
  return {
    name: 'mupot',
    version: VERSION,
    description: 'CLI for a mupot pot. Talks JSON-RPC to <api>/mcp (tools/list, tools/call). Zero dependencies, Node >= 20.',
    usage: 'mupot [global flags] <command> [args] [--flag value ...]',
    commands: [
      { name: 'tools', args: '[filter]', description: 'List live tool names and descriptions (tools/list; cached 1h).' },
      { name: 'help', args: '[tool|shortcut]', description: "Print usage, or a tool's input schema." },
      { name: '<tool_name>', args: '[--key value ...] | --json-args <json|->', description: 'Call any tool. Flags are coerced from its inputSchema (number, boolean, array via repeated flag or comma list, object via JSON).' },
      { name: 'call', args: '<tool_name> ...', description: 'Explicit form of <tool_name>.' },
      ...Object.entries(SHORTCUTS).map(([name, s]) => ({ name, usage: s.usage, maps_to: s.tool, description: s.help })),
      { name: 'agent-context', args: '', description: 'Print this JSON document.' },
    ],
    global_flags: [
      { flag: '--pot <name>', description: 'Profile from ~/.config/mupot/config.json.' },
      { flag: '--api <url>', description: `API base URL (default ${DEFAULT_API}). https only, http allowed on loopback.` },
      { flag: '--json', description: 'Emit the raw result only, as JSON, on stdout. Tool errors are emitted as JSON on stderr.' },
      { flag: '--json-args <json|->', description: 'Raw tool arguments; "-" reads stdin. Flags override keys from it.' },
      { flag: '--refresh', description: 'Bypass the tools/list cache.' },
      { flag: '--timeout <sec>', description: `Request timeout (default ${DEFAULT_TIMEOUT_S}).` },
      { flag: '--version', description: 'Print version and sha256 of this file.' },
    ],
    exit_codes: { 0: 'ok', 1: 'tool error / isError / JSON-RPC error', 2: 'usage error', 3: 'auth (401/403, missing or unusable token)', 4: 'network (unreachable, timeout, redirect, 5xx without a JSON-RPC body)' },
    auth: {
      token_sources_in_order: ['file at $MUPOT_TOKEN_FILE', 'token_file of the pot in ~/.config/mupot/config.json', '~/.config/mupot/<pot>.token', 'env MUPOT_TOKEN'],
      token_file_mode: 'must not be group/world accessible (chmod 600)',
      never_on_argv: true,
    },
    config: { path: '~/.config/mupot/config.json', shape: { pots: { '<name>': { api: 'https://...', token_file: '/path' } }, default: '<name>' } },
    cache: { path: '~/.cache/mupot/', ttl_seconds: CACHE_TTL_MS / 1000 },
    output: { default: 'human-readable on stdout', json: 'raw tool result (structuredContent) on stdout', errors: 'stderr' },
  }
}

function ownSha256() {
  return createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex')
}

async function runTool(ctx, target, toolName, positionalArgs, rest, globals, usage) {
  const tool = await findTool(ctx, target, toolName)
  const schema = tool.inputSchema ?? {}
  const { positionals, args: flagArgs } = resolveArgs(rest, schema)
  if (positionals.length > 0) {
    throw usageError(`unexpected argument "${positionals[0]}"${usage ? ` (usage: mupot ${usage})` : ' (tool arguments are passed as --flags or --json-args)'}`)
  }
  const jsonArgs = globals['json-args'] !== undefined ? readJsonArgs(ctx, globals['json-args']) : {}
  const args = { ...jsonArgs, ...positionalArgs, ...flagArgs }
  const missing = (Array.isArray(schema.required) ? schema.required : []).filter((k) => args[k] === undefined)
  if (missing.length) {
    throw usageError(`missing required argument(s): ${missing.map((k) => `--${k.replace(/_/g, '-')}`).join(', ')}${usage ? ` (usage: mupot ${usage})` : ` (see: mupot help ${toolName})`}`)
  }
  const token = requireToken(ctx, target)
  const result = await rpc(ctx, target, token, 'tools/call', { name: toolName, arguments: args })
  return handleToolResult(ctx, result)
}

async function run(ctx, argv) {
  const tokens = tokenize(argv)
  const { globals, items } = extractGlobals(ctx, tokens)
  ctx.json = globals.json === true
  ctx.refresh = globals.refresh === true
  if (globals.timeout !== undefined) {
    const n = Number(globals.timeout)
    if (!Number.isFinite(n) || n <= 0) throw usageError('--timeout: expected a positive number of seconds')
    ctx.timeoutS = n
  }
  if (globals.version) {
    ctx.out(`mupot ${VERSION} sha256:${ownSha256()}\n`)
    return EXIT.OK
  }
  if (items.length === 0) {
    if (globals.help) { ctx.out(GENERAL_HELP); return EXIT.OK }
    ctx.err(GENERAL_HELP)
    return EXIT.USAGE
  }
  if (items[0].t !== 'pos') throw usageError(`put options after the command (got --${items[0].name} first)`)
  let command = items[0].v
  let rest = items.slice(1)

  if (command === 'agent-context') {
    ctx.out(`${JSON.stringify(agentContext(), null, 2)}\n`)
    return EXIT.OK
  }

  if (command === 'call') {
    if (!rest[0] || rest[0].t !== 'pos') throw usageError('usage: mupot call <tool> [--flags]')
    const name = rest[0].v
    rest = rest.slice(1)
    const target = resolveTarget(ctx, globals)
    if (globals.help) return cmdHelp(ctx, target, name)
    return runTool(ctx, target, name, {}, rest, globals, undefined)
  }

  if (command === 'help') {
    const target = resolveTarget(ctx, globals)
    let what = rest[0] && rest[0].t === 'pos' ? rest[0].v : undefined
    if (what === 'task' && rest[1] && rest[1].t === 'pos') what = `task ${rest[1].v}`
    return cmdHelp(ctx, target, what)
  }

  if (command === 'tools') {
    const target = resolveTarget(ctx, globals)
    const { positionals } = resolveArgs(rest, { properties: {}, additionalProperties: false })
    return cmdTools(ctx, target, positionals)
  }

  // shortcut or raw tool name
  let key = command
  if (command === 'task') {
    if (!rest[0] || rest[0].t !== 'pos') throw usageError('usage: mupot task list|get|new ...')
    key = `task ${rest[0].v}`
    rest = rest.slice(1)
    if (!SHORTCUTS[key]) throw usageError('usage: mupot task list|get|new ...')
  }
  const target = resolveTarget(ctx, globals)
  const sc = SHORTCUTS[key]
  if (globals.help) return cmdHelp(ctx, target, key)
  if (sc) {
    // Positional words are consumed by the shortcut's mapper; flags still go through the schema.
    const tool = await findTool(ctx, target, sc.tool)
    const { positionals, args: flagArgs } = resolveArgs(rest, tool.inputSchema ?? {})
    const posArgs = sc.pos ? sc.pos(positionals) : {}
    if (!sc.pos && positionals.length) throw usageError(`unexpected argument "${positionals[0]}" (usage: mupot ${sc.usage})`)
    const schema = tool.inputSchema ?? {}
    const jsonArgs = globals['json-args'] !== undefined ? readJsonArgs(ctx, globals['json-args']) : {}
    const args = { ...jsonArgs, ...posArgs, ...flagArgs }
    const missing = (Array.isArray(schema.required) ? schema.required : []).filter((k) => args[k] === undefined)
    if (missing.length) throw usageError(`missing required argument(s): ${missing.map((k) => `--${k.replace(/_/g, '-')}`).join(', ')} (usage: mupot ${sc.usage})`)
    const token = requireToken(ctx, target)
    const result = await rpc(ctx, target, token, 'tools/call', { name: sc.tool, arguments: args })
    return handleToolResult(ctx, result)
  }
  command = key
  return runTool(ctx, target, command, {}, rest, globals, undefined)
}

export async function main(argv, io = {}) {
  const ctx = makeCtx(io)
  try {
    return await run(ctx, argv)
  } catch (e) {
    if (e instanceof CliError) {
      ctx.err(`mupot: ${e.message}\n`)
      return e.code
    }
    ctx.err(`mupot: unexpected error: ${e && e.message ? e.message : 'unknown'}\n`)
    return EXIT.TOOL
  }
}

function isEntrypoint() {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntrypoint()) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code })
}
