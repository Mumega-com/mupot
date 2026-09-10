import type { ConnectionChannel, Env } from '../types'
import { canOnSquad, resolveCapabilities } from '../auth/capability'
import { nowSqlUtc, TOKEN_LIVE_PREDICATE } from '../auth/token-lifecycle'
import { readAgentInbox } from '../agents/messages'
import { resolveBoundSeat } from '../agents/inbox-seat'
import { resolveConsentedAgentCapabilities } from './oauth-authorize'
import { done, fail, type ToolSpec } from './index'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ROUTE = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/
const CHANNELS = new Set(['directory', 'workspace', 'im', 'dashboard'])
const MAX_BYTES = 8192
const MAX_ITEMS = 3

interface ReadBinding {
  tenant: string
  caller_member_id: string
  caller_agent_id: string | null
  token_id: string
  channel: ConnectionChannel
  consenting_human_id: string | null
  selected_agent_id: string
  route_id: string
  target_seat: null
  expires_at: string
}

const BINDING_KEYS = ['tenant', 'caller_member_id', 'caller_agent_id', 'token_id', 'channel',
  'consenting_human_id', 'selected_agent_id', 'route_id', 'target_seat', 'expires_at']

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && value.trim() === value
}

/** Protected operator configuration, never a request-body grant. Invalid configuration
 * denies ALL peer reads. An audit receipt or an admin role is not a read delegation. */
function readBindings(raw: string | undefined): ReadBinding[] {
  if (!raw || raw.length > 32768) return []
  try {
    const rows: unknown = JSON.parse(raw)
    if (!Array.isArray(rows) || rows.length > 32) return []
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)
        || Object.keys(row).length !== BINDING_KEYS.length
        || !BINDING_KEYS.every(key => Object.hasOwn(row, key))
        || !identifier(row.tenant) || !identifier(row.caller_member_id) || !identifier(row.token_id)
        || !(row.caller_agent_id === null || (typeof row.caller_agent_id === 'string' && UUID.test(row.caller_agent_id)))
        || !CHANNELS.has(row.channel)
        || !(row.consenting_human_id === null || identifier(row.consenting_human_id))
        || (row.channel !== 'directory' && row.consenting_human_id !== null)
        || typeof row.selected_agent_id !== 'string' || !UUID.test(row.selected_agent_id)
        || typeof row.route_id !== 'string' || !ROUTE.test(row.route_id)
        || row.target_seat !== null
        || typeof row.expires_at !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.expires_at)
        || !Number.isFinite(Date.parse(row.expires_at))
        || new Date(row.expires_at).toISOString() !== row.expires_at) return []
    }
    return rows as ReadBinding[]
  } catch {
    return []
  }
}

/** Canonical binding proves tenant membership; agents themselves have no tenant column. */
async function activeAgent(env: Env, agentId: string) {
  return env.DB.prepare(
    `SELECT a.id, a.squad_id, b.member_id
       FROM agents a
       JOIN agent_member_bindings b ON b.agent_id = a.id AND b.tenant = ?2
       JOIN members m ON m.id = b.member_id AND m.tenant = ?2 AND m.status = 'active'
      WHERE a.id = ?1 AND a.status = 'active' LIMIT 1`,
  ).bind(agentId, env.TENANT_SLUG).first<{ id: string; squad_id: string; member_id: string }>()
}

/** Deliberately a projection: buildOrient writes induction state and renders directives.
 * No caller capability is displayed as if it belonged to the selected agent. */
async function readContext(env: Env, agentId: string) {
  const agent = await env.DB.prepare(
    `SELECT id, slug, name, role, status, squad_id, okr, kpi_target, kpi_progress, effort, autonomy
       FROM agents WHERE id = ?1`,
  ).bind(agentId).first<{ id: string; squad_id: string; [key: string]: unknown }>()
  const squad = agent ? await env.DB.prepare(
    'SELECT id, name, charter, okr, department_id FROM squads WHERE id = ?1',
  ).bind(agent.squad_id).first<{ id: string; department_id: string; [key: string]: unknown }>() : null
  const department = squad ? await env.DB.prepare('SELECT id, name FROM departments WHERE id = ?1')
    .bind(squad.department_id).first() : null
  const tasks = await env.DB.prepare(
    `SELECT id, title, status FROM tasks
      WHERE assignee_agent_id = ?1 AND status IN ('open', 'in_progress', 'blocked')
      ORDER BY created_at ASC, id ASC LIMIT ?2`,
  ).bind(agentId, MAX_ITEMS).all()
  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM tasks
      WHERE assignee_agent_id = ?1 AND status IN ('open', 'in_progress', 'blocked')`,
  ).bind(agentId).first<{ n: number }>()
  const remaining = Math.max(0, Number(count?.n ?? 0) - tasks.results.length)
  return { projection: 'agent_squad_open_tasks', agent, squad, department,
    tasks: tasks.results, tasks_remaining: remaining, tasks_complete: remaining === 0 }
}

const toolAgentContext: ToolSpec = {
  name: 'agent_context',
  scope: 'read-only self, or explicitly delegated caller/target/route with live admin eligibility',
  min: 'authenticated',
  args: '{ agent_id: UUID, route_id?: string (required for peer), inbox_limit?: 1..3, max_bytes?: 1..8192 }',
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: { type: 'string' }, route_id: { type: 'string' },
      inbox_limit: { type: 'integer', minimum: 1, maximum: MAX_ITEMS },
      max_bytes: { type: 'integer', minimum: 1, maximum: MAX_BYTES },
    },
    required: ['agent_id'], additionalProperties: false,
  },
  shouldTouchPresence: () => false,
  async run(auth, env, args) {
    const targetId = args.agent_id
    const limit = args.inbox_limit ?? MAX_ITEMS
    const maxBytes = args.max_bytes ?? MAX_BYTES
    if (typeof targetId !== 'string' || !UUID.test(targetId)
      || (args.route_id !== undefined && (typeof args.route_id !== 'string' || !ROUTE.test(args.route_id)))
      || typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_ITEMS
      || typeof maxBytes !== 'number' || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) {
      return fail(400, 'invalid_args')
    }

    const deny = () => fail(403, 'forbidden', { need: 'active_canonical_identity_and_authorized_read_route' })
    // AuthContext is supplied exclusively by the trusted dispatcher. Refresh liveness
    // and canonical binding without rewriting it, even when invokeTool reuses a snapshot.
    if (!auth?.memberId || !auth.tokenId || auth.tenant !== env.TENANT_SLUG || !CHANNELS.has(auth.channel ?? '')) return deny()
    const token = await env.DB.prepare(
      `SELECT t.agent_id, t.channel
         FROM member_tokens t JOIN members m ON m.id = t.member_id
        WHERE t.id = ?1 AND t.member_id = ?2 AND t.tenant = ?3
          AND m.tenant = ?3 AND m.status = 'active' AND ${TOKEN_LIVE_PREDICATE('?4')}`,
    ).bind(auth.tokenId, auth.memberId, env.TENANT_SLUG, nowSqlUtc())
      .first<{ agent_id: string | null; channel: string }>()
    if (!token || token.channel !== auth.channel || token.agent_id !== (auth.boundAgentId ?? null)) return deny()

    const callerAgentId = auth.boundAgentId ?? null
    if (callerAgentId) {
      const caller = await activeAgent(env, callerAgentId)
      if (!caller || caller.member_id !== auth.memberId) return deny()
    }
    let grantMemberId = auth.memberId
    if (auth.channel === 'directory' && callerAgentId) {
      if (!auth.consentedByMemberId
        || (await resolveConsentedAgentCapabilities(env, callerAgentId, auth.consentedByMemberId)).length === 0) return deny()
      grantMemberId = auth.consentedByMemberId
    } else if (auth.consentedByMemberId) {
      // In particular: a dead directory weld must not fall back to the human's
      // latent admin grants after the builder has nulled boundAgentId.
      return deny()
    }

    const target = await activeAgent(env, targetId)
    if (!target) return deny() // same refusal for unknown, foreign and inactive resources
    const self = callerAgentId === targetId
    if (!self) {
      const approved = readBindings(env.AGENT_CONTEXT_READ_BINDINGS).some(binding =>
        binding.tenant === env.TENANT_SLUG && binding.caller_member_id === auth.memberId
        && binding.caller_agent_id === callerAgentId && binding.token_id === auth.tokenId
        && binding.channel === auth.channel
        && binding.consenting_human_id === (auth.consentedByMemberId ?? null)
        && binding.selected_agent_id === targetId && binding.route_id === args.route_id
        && Date.parse(binding.expires_at) > Date.now())
      if (!approved) return fail(403, 'forbidden', { need: 'explicit_server_read_binding', scope: 'caller_target_route' })
      const grants = await resolveCapabilities(env, grantMemberId)
      if (!(await canOnSquad(env, grants, target.squad_id, 'admin'))) {
        return fail(403, 'forbidden', { need: 'admin', scope: 'target_squad' })
      }
    }

    // A caller's token seat is meaningful only in its OWN inbox. Peer delegation
    // covers unseated messages only; it does not grant any target seat partition.
    const seat = self ? await resolveBoundSeat(env, auth.tokenId) : null
    const inbox = await readAgentInbox(env, { agent: targetId, peek: true, limit, seat: seat ?? undefined })
    if (!inbox.ok) {
      if (inbox.reason === 'consumer_fenced') return fail(409, 'consumer_fenced')
      return fail(500, 'inbox_unavailable')
    }
    const context = await readContext(env, targetId)
    const output = {
      caller_member_id: auth.memberId, caller_agent_id: callerAgentId, selected_agent_id: targetId,
      mode: 'read_only_target', route_id: self ? null : args.route_id,
      untrusted_data: true,
      context: context as typeof context | null,
      inbox: { messages: [...inbox.messages], remaining: inbox.remaining, complete: inbox.complete,
        consumed: false, partition: self && seat ? 'caller_token_seat_and_unseated' : 'unseated' },
      receipt: { bytes: 0, max_bytes: maxBytes, inbox_limit: limit, messages_omitted: 0, context_omitted: false },
    }
    const encoder = new TextEncoder()
    const measure = () => {
      // Include the byte-count field itself in the compact JSON result's receipt.
      let bytes = encoder.encode(JSON.stringify(output)).length
      while (output.receipt.bytes !== bytes) {
        output.receipt.bytes = bytes
        bytes = encoder.encode(JSON.stringify(output)).length
      }
      return bytes
    }
    if (measure() > maxBytes && encoder.encode(JSON.stringify(context)).length > maxBytes / 2) {
      output.context = null
      output.receipt.context_omitted = true
    }
    while (measure() > maxBytes && output.inbox.messages.length > 0) {
      // Whole rows only: never turn a clipped body into an apparently intact message.
      output.inbox.messages.pop()
      output.receipt.messages_omitted++
      output.inbox.remaining++
      output.inbox.complete = false
    }
    if (measure() > maxBytes && output.context !== null) {
      output.context = null
      output.receipt.context_omitted = true
    }
    if (measure() > maxBytes) return fail(400, 'max_bytes_too_small')
    return done(output)
  },
}

export const AGENT_CONTEXT_TOOLS: ToolSpec[] = [toolAgentContext]
