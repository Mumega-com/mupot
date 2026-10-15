// tests/mcp-tools-list-per-auth-1910.test.ts — mupot#1910 (Codex wrapper "Unknown tool") + #1956
// (inbox_mark_handled missing from an attached connector's catalog).
//
// FINDING pinned here: tools/list is computed by advertisedTools(env) alone. It never reads the caller, so every
// authenticated shape (workspace bearer, attached chat, directory/OAuth, harness credential) is shown the SAME
// catalog, and it only changes with env flags. A connector that lacks a tool therefore cached its catalog before
// the tool shipped (client-side), and a refusal named "Unknown tool" with -32001 is never produced by this server
// for an unknown name (that is -32602 unknown_tool; -32001 is only 'unauthenticated').
//
// Real sqlite D1 + the full migration chain; requests go through mcpApp via the internal auth header, the same way
// the OAuth provider dispatches. MUTATIONS proven: see the PR body.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { advertisedTools, mcpApp, unknownToolDetail, resolveToolSpec, wireName, TOOL_WIRE_ALIASES, TOOLS } from '../src/mcp/index'
import { toolAnnotations } from '../src/mcp/tool-annotations'
import { mcpInternalRequest } from '../src/mcp/internal-dispatch'
import { HARNESS_SESSION_ALLOWED_TOOLS } from '../src/members/harness-credential'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'mumega'

let h: SqliteD1Harness
beforeEach(() => { h = createSqliteD1(); applyAllMigrations(h.sqlite) })
afterEach(() => h.close())

function envFor(extra: Record<string, unknown> = {}): Env {
  return {
    DB: h.db, TENANT_SLUG: TENANT, PUBLIC_ORIGIN: 'https://pot.test',
    SESSIONS: { get: async () => null, put: async () => undefined, delete: async () => undefined },
    OAUTH_KV: { get: async () => null, put: async () => undefined },
    SEAT_AUTO_ENROLL: '1', SEAT_ATTACH: '1', ...extra,
  } as unknown as Env
}

const base = { email: null, role: 'member', tenant: TENANT, capabilities: [] }
// The auth shapes are built as plain data (the internal-header blob the provider hands mcpApp), cast once: the
// type is wider than a fixture needs and the point is that tools/list does not read it.
const SHAPES: Record<string, AuthContext> = {
  workspace: { ...base, userId: 'mem-a', memberId: 'mem-a', boundAgentId: 'agent-a', channel: 'workspace', tokenId: 'tok-ws' } as unknown as AuthContext,
  attached: { ...base, userId: 'mem-a', memberId: 'mem-a', boundAgentId: 'agent-a', channel: 'directory', tokenId: 'tok-att',
    seatBinding: { seatId: 's', label: 'l', harnessId: 'h', grantTokenId: 'g', humanMemberId: 'mem-h', source: 'auto:openai_session',
      attached: { attachmentId: 'att', admissionId: 'adm', agentId: 'agent-a', seatAgentId: 'seat-a', ceiling: 'member' } } } as unknown as AuthContext,
  directory: { ...base, userId: 'mem-h', memberId: 'mem-h', boundAgentId: null, channel: 'directory', tokenId: 'tok-dir' } as unknown as AuthContext,
  harness: { ...base, userId: 'mem-h', memberId: 'mem-h', boundAgentId: null, channel: 'directory', tokenId: 'tok-hn', harnessCredential: true } as unknown as AuthContext,
}

async function rpc(env: Env, auth: AuthContext, method: string, params?: unknown): Promise<{ status: number; body: { result?: Record<string, unknown>; error?: { code: number; message: string; data?: unknown } } }> {
  const req = new Request('https://pot.test/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const res = await mcpApp.fetch(mcpInternalRequest(req, auth), env)
  return { status: res.status, body: (await res.json()) as never }
}
const namesOf = async (env: Env, auth: AuthContext): Promise<string[]> =>
  ((await rpc(env, auth, 'tools/list')).body.result?.tools as Array<{ name: string }>).map((t) => t.name)

describe('tools/list snapshot per auth shape (#1910, #1956)', () => {
  it('every auth shape sees the identical catalog = advertisedTools(env), including boot_context and inbox_mark_handled', async () => {
    const env = envFor()
    const expected = advertisedTools(env).map((t) => wireName(t.name))
    expect(expected).toContain('inbox_mark_handled')
    expect(expected).toContain('boot_context')
    for (const [shape, auth] of Object.entries(SHAPES)) {
      expect(await namesOf(env, auth), shape).toEqual(expected)
    }
  })

  it('every advertised name is a registered tool, unique, and unprefixed (no name a client could not send back bare)', async () => {
    const names = await namesOf(envFor(), SHAPES.workspace)
    const registered = new Set(TOOLS.map((t) => t.name))
    expect(new Set(names).size).toBe(names.length)
    for (const n of names) {
      expect(registered.has(n) || resolveToolSpec(n) !== undefined, n).toBe(true)
      expect(n.startsWith('mupot'), n).toBe(false)
      expect(n.length, n).toBeLessThanOrEqual(48) // room for Codex's `mcp__<server>__` prefix inside the 64-char limit
    }
  })

  it('SEAT_ATTACH off removes inbox_mark_handled for EVERY shape (the catalog tracks the flag, never the caller)', async () => {
    const off = envFor({ SEAT_ATTACH: undefined })
    for (const [shape, auth] of Object.entries(SHAPES)) {
      const names = await namesOf(off, auth)
      expect(names, shape).not.toContain('inbox_mark_handled')
      expect(names, shape).toContain('boot_context')
    }
  })

  it('the harness shape lists nothing a harness session can reach beyond what the other shapes list (no widening), and its allowed set is all listed', async () => {
    const env = envFor()
    const harness = new Set(await namesOf(env, SHAPES.harness))
    const workspace = new Set(await namesOf(env, SHAPES.workspace))
    for (const n of harness) expect(workspace.has(n), n).toBe(true)
    // worktree_* is allowed to a harness session but is flag-gated (WORKSPACES off here): only the advertised ones are checked.
    for (const n of HARNESS_SESSION_ALLOWED_TOOLS) if (workspace.has(n)) expect(harness.has(n), n).toBe(true)
  })

  it('tools/list never claims a list_changed channel it cannot deliver (stateless HTTP)', async () => {
    const init = await rpc(envFor(), SHAPES.workspace, 'initialize', { protocolVersion: '2025-06-18' })
    expect(JSON.stringify(init.body.result?.capabilities)).not.toContain('listChanged')
  })
})

describe('a call through the name a Codex client sends (#1910)', () => {
  it('the bare name the catalog advertises resolves and runs (no unknown_tool, no -32001)', async () => {
    const env = envFor()
    for (const name of ['boot_context', 'inbox_consumer_status']) {
      const r = await rpc(env, SHAPES.workspace, 'tools/call', { name, arguments: {} })
      expect(r.status).toBe(200)
      expect(r.body.error?.message, name).not.toBe('unknown_tool')
      expect(r.body.error?.code, name).not.toBe(-32001)
    }
  })

  it('a client-namespaced name is refused as -32602 unknown_tool (never -32001, never executed) and names the bare tool', async () => {
    const env = envFor()
    for (const wire of ['mupot.boot_context', 'mupot_boot_context', 'mcp__mupot__boot_context', 'mcp__codex_apps__mupot_w2__boot_context', 'Boot_Context']) {
      const r = await rpc(env, SHAPES.workspace, 'tools/call', { name: wire, arguments: {} })
      expect(r.status, wire).toBe(200)
      expect(r.body.result, wire).toBeUndefined()
      expect(r.body.error, wire).toMatchObject({ code: -32602, message: 'unknown_tool' })
      expect(JSON.stringify(r.body.error?.data), wire).toContain('did you mean \\"boot_context\\"')
    }
  })

  it('the hint never resolves: unknownToolDetail only suggests registered names and returns the bare input for strangers', () => {
    expect(unknownToolDetail('no_such_tool')).toBe('no_such_tool')
    expect(unknownToolDetail('mupot.no_such_tool')).toBe('mupot.no_such_tool')
    expect(unknownToolDetail('my_status')).toBe('my_status') // an unrelated suffix is not a namespace: no suggestion
    expect(unknownToolDetail('mupot_inbox_mark_handled')).toContain('"inbox_mark_handled"')
    expect(unknownToolDetail('boot_context')).toBe('boot_context') // an exact name is not "unknown": nothing to suggest
  })

  it('an unauthenticated tools/call is -32001 unauthenticated BEFORE tool lookup (the only source of -32001)', async () => {
    const res = await mcpApp.fetch(new Request('https://pot.test/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'mupot.boot_context', arguments: {} } }) }), envFor())
    const body = (await res.json()) as { error?: { code: number; message: string } }
    expect(body.error).toMatchObject({ code: -32001, message: 'unauthenticated' })
  })
})

describe('inbox_consumer_status tells an attached chat how to refresh a stale catalog (#1956)', () => {
  it('attached status carries if_tool_missing while SEAT_ATTACH is on, and omits it when off', async () => {
    const { invokeTool } = await import('../src/mcp/index')
    const on = (await invokeTool(SHAPES.attached, envFor(), 'inbox_consumer_status', {}, 'https://pot.test')) as { ok: boolean; result?: Record<string, unknown> }
    expect(on.result?.mark_handled_tool).toBe('inbox_mark_handled')
    expect(String(on.result?.if_tool_missing)).toMatch(/Refresh or reconnect the connector/)
    const off = (await invokeTool(SHAPES.attached, envFor({ SEAT_ATTACH: undefined }), 'inbox_consumer_status', {}, 'https://pot.test')) as { result?: Record<string, unknown> }
    expect(off.result?.if_tool_missing).toBeUndefined()
  })
})

const OFFICE = ['publish_post', 'list_pending_approvals', 'health', 'review_approval', 'reconcile_stalled_publish']

describe('wire-safe tool names: office.* underscore aliases (#1910)', () => {
  const ALL_ON = { SEAT_ATTACH: '1', SEAT_AUTO_ENROLL: '1', ACCESS_APPROVE_ENABLED: '1', SECURE_MOMENTS: '1', SECURE_DROP: '1', TELEGRAM_MINIAPP: '1', WORKSPACES: '1' }

  it('CI gate: EVERY name advertised by tools/list (all flags on, every shape) matches ^[A-Za-z0-9_-]{1,64}$', async () => {
    const env = envFor(ALL_ON)
    for (const [shape, auth] of Object.entries(SHAPES)) {
      for (const n of await namesOf(env, auth)) expect(n, `${shape}:${n}`).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    }
  })

  it('GET /mcp/tools advertises the same wire-safe names', async () => {
    const res = await mcpApp.fetch(new Request('https://pot.test/tools'), envFor(ALL_ON))
    const names = ((await res.json()) as { tools: Array<{ name: string }> }).tools.map((t) => t.name)
    expect(names.length).toBeGreaterThan(100)
    for (const n of names) expect(n).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
  })

  it('the five office aliases are advertised, the dotted names are not', async () => {
    const names = await namesOf(envFor(ALL_ON), SHAPES.workspace)
    for (const o of OFFICE) { expect(names).toContain(`office_${o}`); expect(names).not.toContain(`office.${o}`) }
    expect([...TOOL_WIRE_ALIASES.keys()].sort()).toEqual(OFFICE.map((o) => `office_${o}`).sort())
  })

  it('alias and dotted name resolve to the IDENTICAL spec object; the advertised entry carries the dotted tool\'s annotations', async () => {
    const list = (await rpc(envFor(ALL_ON), SHAPES.workspace, 'tools/list')).body.result?.tools as Array<{ name: string; annotations?: unknown; inputSchema: unknown }>
    for (const o of OFFICE) {
      const spec = resolveToolSpec(`office.${o}`)
      expect(spec).toBeDefined()
      expect(resolveToolSpec(`office_${o}`)).toBe(spec)
      expect(wireName(`office.${o}`)).toBe(`office_${o}`)
      const entry = list.find((t) => t.name === `office_${o}`)
      expect(entry?.annotations).toEqual(toolAnnotations(`office.${o}`))
      expect(JSON.stringify(entry?.inputSchema)).toBe(JSON.stringify(spec?.inputSchema))
    }
  })

  it('both names are callable and refuse identically through the same floor (an observer-less caller cannot use either)', async () => {
    const env = envFor(ALL_ON)
    for (const o of OFFICE) {
      const a = await rpc(env, SHAPES.directory, 'tools/call', { name: `office_${o}`, arguments: {} })
      const d = await rpc(env, SHAPES.directory, 'tools/call', { name: `office.${o}`, arguments: {} })
      expect(a.body.error?.message, o).not.toBe('unknown_tool')
      expect(d.body.error?.message, o).not.toBe('unknown_tool')
      expect(JSON.stringify(a.body)).toBe(JSON.stringify(d.body))
    }
  })

  it('an alias that is not a derived underscore twin is still unknown (no wildcard resolution)', async () => {
    expect(resolveToolSpec('office_nope')).toBeUndefined()
    expect(resolveToolSpec('office.nope')).toBeUndefined()
  })
})
