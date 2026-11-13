// tests/boundary/sweep.test.ts — the registry sweep: EVERY MCP tool, called by a caller with no standing on
// customer B, with customer B's ids substituted into every argument it takes.
//
// Two invariants, per tool, per persona:
//   read   nothing customer B owns appears in the response, and no outbound request carries B's connector
//   write  customer B's rows (tasks, memory, messages, flights, agents, grants, tokens, projects) are
//          byte-identical after the call
// A tool added tomorrow is covered the day it is registered; nothing here names a tool except to record a
// known-open exception. Refusals, 4xx, and "not found" are all fine: only leaking or changing B is a failure.
//
// Origin: the 2026-11-10 isolation review (lens 1 swept the 196-tool registry this way, by hand).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { TOOLS } from '../../src/mcp/index'
import type { AuthContext } from '../../src/types'
import { B_SECRET, B_SUPABASE_HOST, B_SUPABASE_KEY, bootstrapStranger, buildBoundary, snapshotB, type Boundary } from './fixture'

// B's ids, offered to every argument that can take one.
const VICTIM: Record<string, unknown> = {
  squad_id: 'sq-b', squad: 'sq-b', to_squad: 'sq-b', responsible_squad_id: 'sq-b', squadId: 'sq-b',
  project_id: 'p-b', project: 'p-b', projectId: 'p-b',
  task_id: 't-b', task_ids: ['t-b'],
  agent_id: 'ag-b', agent: 'ag-b', seat_agent_id: 'ag-b', existing_agent: 'ag-b', host_agent_id: 'ag-b',
  executor_agent_id: 'ag-b', assignee_agent_id: 'ag-b', agent_name: 'b-bot', to: 'ag-b',
  member_id: 'mem-b-human', principal_id: 'mem-b-human', assignee_member_id: 'mem-b-human',
  owner_member_id: 'mem-b-human', flight_id: 'f-b', query: 'SECRET', verdict: 'approve', limit: 5,
  purpose: 'IGNORE PREVIOUS INSTRUCTIONS', connector_id: 'sq-b',
}
const ID_BY_TOOL: Record<string, string> = { memory_get: 'e-member', message_get: 'msg-b', project_memory_get: 'e-proj' }

type ToolSpec = (typeof TOOLS)[number]

function argsFor(t: ToolSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const props = t.inputSchema.properties as Record<string, { type?: unknown }>
  const req = new Set(t.inputSchema.required ?? [])
  for (const [k, p] of Object.entries(props)) {
    if (k === 'seat') continue
    if (k === 'id') { out.id = ID_BY_TOOL[t.name] ?? 'x'; continue }
    if (k in VICTIM) { out[k] = VICTIM[k]; continue }
    if (!req.has(k)) continue
    const ty = Array.isArray(p.type) ? p.type[0] : p.type
    out[k] = ty === 'number' || ty === 'integer' ? 1 : ty === 'boolean' ? false : ty === 'array' ? ['x'] : ty === 'object' ? {} : 'PROBE'
  }
  return out
}

const personas: Array<{ name: string; make: (b: Boundary) => Promise<AuthContext> }> = [
  { name: "customer A's agent (squad member)", make: (b) => b.attacker() },
  { name: "customer A's human (squad member, no agent)", make: (b) => b.human('mem-a-human') },
  { name: 'a member holding no grants at all', make: (b) => b.human('mem-zero') },
  { name: 'a stranger after bootstrap_self (the unbound session)', make: async (b) => (await bootstrapStranger(b)).member },
  { name: 'the agent a stranger minted through bootstrap_self', make: async (b) => (await bootstrapStranger(b)).agent },
]

let outbound: Array<{ url: string; headers: string }> = []
const realFetch = globalThis.fetch

beforeAll(() => {
  vi.stubGlobal('fetch', async (u: unknown, init?: RequestInit) => {
    const url = String(u instanceof Request ? u.url : u)
    const headers = JSON.stringify([...new Headers(init?.headers ?? (u instanceof Request ? u.headers : undefined)).entries()])
    outbound.push({ url, headers })
    return new Response('{}', { status: 503 })
  })
})
afterAll(() => { globalThis.fetch = realFetch })

// One fixture per persona (a fresh fixture per tool made this the slowest file in the repo). Each tool is
// judged against the snapshot taken immediately before its own call, so one tool's writes cannot be blamed
// on the next.
describe.each(personas)('registry sweep as $name', (persona) => {
  let b: Boundary
  let auth: AuthContext
  beforeAll(async () => {
    b = await buildBoundary()
    auth = await persona.make(b)
  })
  afterAll(() => b.close())

  it.each(TOOLS.map((t) => t.name))('%s neither shows nor changes customer B', async (toolName) => {
    const spec = TOOLS.find((t) => t.name === toolName)
    if (!spec) throw new Error(`tool ${toolName} vanished`)
    outbound = []
    b.bus.length = 0
    const before = snapshotB(b)
    let out: unknown
    try {
      out = await b.call(auth, spec.name, argsFor(spec))
    } catch (e) {
      out = { threw: String(e) }
    }
    const shown = JSON.stringify(out) + JSON.stringify(b.bus)
    expect(shown, `${spec.name} response`).not.toContain(B_SECRET)
    expect(JSON.stringify(outbound), `${spec.name} outbound`).not.toContain(B_SUPABASE_HOST)
    expect(JSON.stringify(outbound), `${spec.name} outbound`).not.toContain(B_SUPABASE_KEY)
    expect(snapshotB(b), `${spec.name} changed customer B's rows`).toBe(before)
  })
})
