// mupot — IM seam. How IM-only employees (Telegram, relayed by Hermes) act on
// the pot. A person who lives in chat is still a first-class network node: their
// chat_id maps to a Member + capabilities, and they "have effect" by sending a
// message — gated by the SAME frozen capability API as the MCP/web surfaces.
//
// Sovereign-core discipline (identical to src/mcp + src/auth):
//   - Identity is ALWAYS derived server-side from the chat_id → member mapping
//     (members.telegram_chat_id). We NEVER read an identity out of message TEXT.
//     Text carries an intent ("task: …", "wake X"); it never carries "who".
//   - AuthZ is OURS: every mutating intent is gated by the FROZEN capability API
//     (resolveCapabilities / hasCapability) against the scope it targets. A
//     'department' grant inherits down to its squads; an 'org' grant covers all.
//   - Tenant is environment-derived (env.TENANT_SLUG), never client-supplied. A
//     suspended member is inert. An unmapped chat_id is politely refused — we do
//     NOT act and we do NOT leak which chat_ids are known.
//   - Every effect emits an ATTRIBUTED BusEvent (actor {kind:'member', id}) so the
//     activity feed/consumer knows a human caused it.
//
// Exports:
//   - imApp            : Hono sub-app. POST /webhook accepts a Telegram-style
//                        update {message:{chat:{id}, text}}, resolves the member,
//                        runs the intent, and returns a short text reply.
//   - handleImMessage  : (env, chatId, text) => Promise<string>. The pure entry
//                        Hermes can call directly (or the webhook calls for it).

import { Hono } from 'hono'
import type {
  Env,
  Member,
  Capability,
  CapabilityGrant,
  BusEvent,
  Agent,
  Squad,
} from '../types'
import { resolveCapabilities, hasCapability } from '../auth/capability'
import { createBus } from '../bus'
import { createTask } from '../tasks/service'
import { emitControlRequest } from '../fleet/control'
import { CONTROL_VERBS, type ControlVerb } from '../fleet/control-request'
import { listFleetAgents, type FleetAgentRow } from '../fleet/registry'

type AppEnv = { Bindings: Env }

// ── attribution ───────────────────────────────────────────────────────────────
function memberActor(memberId: string): { kind: 'member'; id: string } {
  return { kind: 'member', id: memberId }
}

// ── identity resolution (chat_id → Member) ────────────────────────────────────
// The ONLY way an IM principal is identified. Normalised to a string because a
// Telegram chat id arrives as a number; member_tokens/members store it as TEXT.
// A suspended member resolves to null here — their messages are inert.
async function memberForChat(env: Env, chatId: string): Promise<Member | null> {
  const row = await env.DB.prepare(
    `SELECT id, email, display_name, telegram_chat_id, status, created_at
       FROM members
      WHERE telegram_chat_id = ?1
      LIMIT 1`,
  )
    .bind(chatId)
    .first<Member>()
  if (!row) return null
  if (row.status !== 'active') return null
  return row
}

// ── scope helpers (frozen 4-arg hasCapability + explicit inheritance) ─────────
// The frozen API is hasCapability(grants, scopeType, scopeId, min). Per the
// contract: an 'org' grant applies to ALL scopes (handled inside hasCapability);
// a 'department' grant applies to that department AND its squads; a 'squad' grant
// applies to that squad. To gate a SQUAD action we therefore check the squad
// grant AND the squad's department grant explicitly — fail-closed if the squad's
// department can't be resolved (unknown squad → no inheritance, no access).
async function squadDepartmentId(env: Env, squadId: string): Promise<string | null> {
  const r = await env.DB.prepare('SELECT department_id FROM squads WHERE id = ?1')
    .bind(squadId)
    .first<{ department_id: string }>()
  return r?.department_id ?? null
}

async function canOnSquad(
  env: Env,
  grants: CapabilityGrant[],
  squadId: string,
  min: Capability,
): Promise<boolean> {
  // squad-level grant (also covers an org grant, per hasCapability's contract)
  if (hasCapability(grants, 'squad', squadId, min)) return true
  // inherited department-level grant
  const deptId = await squadDepartmentId(env, squadId)
  if (deptId && hasCapability(grants, 'department', deptId, min)) return true
  return false
}

// ── lookups: a human types a NAME/slug, not a uuid ────────────────────────────
// We resolve a free-text reference to exactly one squad/agent in THIS pot. We
// match on slug first (exact), then on a case-insensitive name match. Ambiguous
// (>1) or absent (0) → null so the caller can ask the human to disambiguate.
async function resolveSquad(env: Env, ref: string): Promise<Squad | 'ambiguous' | null> {
  const needle = ref.trim()
  if (!needle) return null
  const rows = await env.DB.prepare(
    `SELECT id, department_id, slug, name, charter, created_at
       FROM squads
      WHERE slug = ?1 OR lower(name) = lower(?1)
      LIMIT 2`,
  )
    .bind(needle)
    .all<Squad>()
  const results = rows.results ?? []
  if (results.length === 0) return null
  if (results.length > 1) return 'ambiguous'
  return results[0]
}

async function resolveAgent(env: Env, ref: string): Promise<Agent | 'ambiguous' | null> {
  const needle = ref.trim()
  if (!needle) return null
  const rows = await env.DB.prepare(
    `SELECT id, squad_id, slug, name, role, model, status, created_at
       FROM agents
      WHERE slug = ?1 OR lower(name) = lower(?1)
      LIMIT 2`,
  )
    .bind(needle)
    .all<Agent>()
  const results = rows.results ?? []
  if (results.length === 0) return null
  if (results.length > 1) return 'ambiguous'
  return results[0]
}

// The member's default squad: the single squad they hold a squad-scoped grant on.
// Used so "task: …" with no @squad still works for someone bound to one squad.
async function soleSquadGrant(grants: CapabilityGrant[]): Promise<string | null> {
  const squadGrants = grants.filter((g) => g.scope_type === 'squad' && g.scope_id)
  const ids = new Set(squadGrants.map((g) => g.scope_id as string))
  return ids.size === 1 ? [...ids][0] : null
}

// ── intent parsing (text → intent; identity is NEVER here) ────────────────────
type Intent =
  | { kind: 'help' }
  | { kind: 'status'; ref: string | null }
  | { kind: 'wake'; ref: string }
  | { kind: 'fleet'; verb: ControlVerb; ref: string }
  | { kind: 'task'; title: string; squadRef: string | null }
  | { kind: 'unknown' }

// Parse a leading "@squad" or trailing "@squad" reference out of a task title.
// We only treat a token as a squad ref when it's prefixed with '@' — a plain word
// in the title stays in the title (humans write natural titles).
function extractSquadRef(raw: string): { title: string; squadRef: string | null } {
  const text = raw.trim()
  // trailing "@ref" (e.g. "ship the thing @growth")
  const trailing = text.match(/\s+@([A-Za-z0-9_-]+)\s*$/)
  if (trailing) {
    return { title: text.slice(0, trailing.index).trim(), squadRef: trailing[1] }
  }
  // leading "@ref" (e.g. "@growth ship the thing")
  const leading = text.match(/^@([A-Za-z0-9_-]+)\s+(.+)$/)
  if (leading) {
    return { title: leading[2].trim(), squadRef: leading[1] }
  }
  return { title: text, squadRef: null }
}

function parseIntent(text: string): Intent {
  const trimmed = text.trim()
  if (!trimmed) return { kind: 'unknown' }
  const lower = trimmed.toLowerCase()

  if (lower === 'help' || lower === '/help' || lower === '?') return { kind: 'help' }

  // "status" or "status <agent>"
  if (lower === 'status' || lower === '/status') return { kind: 'status', ref: null }
  const statusMatch = trimmed.match(/^\/?status\s+(.+)$/i)
  if (statusMatch) return { kind: 'status', ref: statusMatch[1].trim() }

  // "wake <agent>"
  const wakeMatch = trimmed.match(/^\/?wake\s+(.+)$/i)
  if (wakeMatch) {
    const ref = wakeMatch[1].trim()
    return ref ? { kind: 'wake', ref } : { kind: 'unknown' }
  }

  // "fleet <start|stop|restart|status> <host-agent>"
  const fleetMatch = trimmed.match(/^\/?fleet\s+([A-Za-z]+)\s+(.+)$/i)
  if (fleetMatch) {
    const verb = fleetMatch[1].toLowerCase()
    const ref = fleetMatch[2].trim()
    if ((CONTROL_VERBS as readonly string[]).includes(verb) && ref) {
      return { kind: 'fleet', verb: verb as ControlVerb, ref }
    }
    return { kind: 'unknown' }
  }

  // "task: <title>" (also tolerate "task <title>")
  const taskMatch = trimmed.match(/^\/?task\s*[:|-]?\s+(.+)$/i)
  if (taskMatch) {
    const { title, squadRef } = extractSquadRef(taskMatch[1])
    return title ? { kind: 'task', title, squadRef } : { kind: 'unknown' }
  }

  return { kind: 'unknown' }
}

// ── reply copy (short, friendly, never leaks internals) ───────────────────────
const HELP =
  'I can: "task: <title>" (optionally "@squad"), "status" or "status <agent>", ' +
  '"wake <agent>", or "fleet start|stop|restart|status <agent>". I act as you, with your permissions.'

const IM_TASK_DONE_WHEN =
  'A task result or linked artifact provides evidence that the requested IM task is complete.'

// ── the entry point Hermes calls ──────────────────────────────────────────────
// (env, chatId, text) → a short text reply to send back into the chat. Pure with
// respect to HTTP — no Hono context — so Hermes can invoke it directly.
export async function handleImMessage(
  env: Env,
  chatId: string | number,
  text: string,
): Promise<string> {
  const chat = String(chatId)

  // 1) Identity: chat_id → member. No member → polite refusal, NO action taken.
  const member = await memberForChat(env, chat)
  if (!member) {
    return "You're not registered with this workspace yet. Ask an admin to invite you, then connect Telegram."
  }

  // 2) Capabilities for this member (the real RBAC).
  const grants = await resolveCapabilities(env, member.id)

  // 3) Parse the intent from TEXT (never identity).
  const intent = parseIntent(text ?? '')

  switch (intent.kind) {
    case 'help':
      return HELP

    case 'unknown':
      return `Sorry, I didn't catch that. ${HELP}`

    case 'status':
      return statusReply(env, member, intent.ref)

    case 'wake':
      return wakeReply(env, member, grants, intent.ref)

    case 'fleet':
      return fleetReply(env, member, grants, intent.verb, intent.ref)

    case 'task':
      return taskReply(env, member, grants, intent.title, intent.squadRef)
  }
}

// ── intent: status (read-only) ────────────────────────────────────────────────
// No agent → echo "who am I + my scopes". With an agent → read its runtime, but
// only for an agent that exists in THIS pot (tenant-scoped by construction).
async function statusReply(env: Env, member: Member, ref: string | null): Promise<string> {
  if (!ref) {
    const grants: CapabilityGrant[] = await resolveCapabilities(env, member.id)
    const scopes =
      grants.length === 0
        ? 'no capabilities yet'
        : grants
            .map(
              (g: CapabilityGrant) =>
                `${g.capability}@${g.scope_type}${g.scope_id ? `:${g.scope_id}` : ''}`,
            )
            .join(', ')
    return `You are ${member.display_name}. Scopes: ${scopes}.`
  }

  const agent = await resolveAgent(env, ref)
  if (agent === 'ambiguous') return `More than one agent matches "${ref}". Be more specific.`
  if (!agent) return `No agent named "${ref}" here.`

  const stub = env.AGENT.get(env.AGENT.idFromName(agent.id))
  const res = await stub.fetch('https://agent/status')
  const runtime = (await res.json<unknown>().catch(() => null)) as Record<string, unknown> | null
  const note = runtime && typeof runtime === 'object' ? '' : ' (runtime unavailable)'
  return `${agent.name} — ${agent.role}, ${agent.status}${note}.`
}

// ── intent: wake (cap: lead+ on the agent's squad) ────────────────────────────
async function wakeReply(
  env: Env,
  member: Member,
  grants: CapabilityGrant[],
  ref: string,
): Promise<string> {
  const agent = await resolveAgent(env, ref)
  if (agent === 'ambiguous') return `More than one agent matches "${ref}". Be more specific.`
  if (!agent) return `No agent named "${ref}" here.`

  if (!(await canOnSquad(env, grants, agent.squad_id, 'lead'))) {
    return `You don't have permission to wake ${agent.name} (need lead on its squad).`
  }
  if (agent.status !== 'active') return `${agent.name} is paused; can't wake it.`

  // Attributed wake announcement on the bus, then drive the DO synchronously —
  // same contract as agentsApp / the MCP wake_agent tool.
  const now = new Date().toISOString()
  const event: BusEvent<{ by: string; reason: string }> = {
    type: 'agent.wake',
    tenant: env.TENANT_SLUG,
    squad_id: agent.squad_id,
    agent_id: agent.id,
    actor: memberActor(member.id),
    payload: { by: member.id, reason: 'im.wake' },
    ts: now,
  }
  await createBus(env).emit(event)

  const stub = env.AGENT.get(env.AGENT.idFromName(agent.id))
  const res = await stub.fetch('https://agent/wake', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'im.wake', squad_id: agent.squad_id }),
  })
  if (!res.ok) return `Tried to wake ${agent.name} but it didn't run. Try again shortly.`
  return `Woke ${agent.name}. It's running one cycle now.`
}

// ── intent: fleet (cap: owner on org) ────────────────────────────────────────
// This is host process control, so IM uses the exact same signed fleet-control
// plane as the dashboard: owner gate here, Ed25519 verification on the host.
function canControlFleet(grants: CapabilityGrant[]): boolean {
  return hasCapability(grants, 'org', null, 'owner')
}

async function resolveFleetAgent(env: Env, ref: string): Promise<FleetAgentRow | 'ambiguous' | null> {
  const needle = ref.trim().toLowerCase()
  if (!needle) return null

  const rows = await listFleetAgents(env)
  const exact = rows.filter(
    (row) => row.agent_id.toLowerCase() === needle || row.display.toLowerCase() === needle,
  )
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) return 'ambiguous'

  const prefixed = rows.filter((row) => row.agent_id.toLowerCase().startsWith(`${needle}-`))
  if (prefixed.length === 1) return prefixed[0]
  if (prefixed.length > 1) return 'ambiguous'

  return null
}

async function fleetReply(
  env: Env,
  member: Member,
  grants: CapabilityGrant[],
  verb: ControlVerb,
  ref: string,
): Promise<string> {
  if (!canControlFleet(grants)) {
    return `You don't have permission to control fleet agents (need owner on the org).`
  }

  const agent = await resolveFleetAgent(env, ref)
  if (agent === 'ambiguous') return `More than one fleet agent matches "${ref}". Be more specific.`
  if (!agent) return `No fleet agent named "${ref}" here.`

  const res = await emitControlRequest(
    env,
    { agent_id: agent.agent_id, verb },
    { memberId: member.id, boundAgentId: null },
  )
  if (!res.ok) {
    if (res.reason === 'unconfigured') return 'Fleet control is not configured here yet.'
    if (res.reason === 'invalid_input') return `I couldn't queue fleet ${verb} for ${agent.display || agent.agent_id}: ${res.detail ?? 'invalid request'}.`
    return `Fleet control request for ${agent.display || agent.agent_id} could not be delivered.`
  }

  const now = new Date().toISOString()
  const event: BusEvent<{ verb: ControlVerb; nonce: string; seq: number | null }> = {
    type: 'fleet.control.requested',
    tenant: env.TENANT_SLUG,
    agent_id: agent.agent_id,
    actor: memberActor(member.id),
    payload: { verb, nonce: res.nonce, seq: res.seq },
    ts: now,
  }
  await createBus(env).emit(event)

  return `Queued fleet ${verb} for ${agent.display || agent.agent_id}.`
}

// ── intent: task (cap: member+ on the target squad) ───────────────────────────
async function taskReply(
  env: Env,
  member: Member,
  grants: CapabilityGrant[],
  title: string,
  squadRef: string | null,
): Promise<string> {
  // Resolve the target squad: explicit @ref, else the member's sole squad grant.
  let squad: Squad | null = null
  if (squadRef) {
    const r = await resolveSquad(env, squadRef)
    if (r === 'ambiguous') return `More than one squad matches "${squadRef}". Be more specific.`
    if (!r) return `No squad named "${squadRef}" here.`
    squad = r
  } else {
    const soleId = await soleSquadGrant(grants)
    if (!soleId) {
      return 'Which squad? You belong to more than one — say "task: <title> @squad".'
    }
    const r = await env.DB.prepare(
      `SELECT id, department_id, slug, name, charter, created_at FROM squads WHERE id = ?1 LIMIT 1`,
    )
      .bind(soleId)
      .first<Squad>()
    if (!r) return 'I could not resolve your squad. Ask an admin to check your access.'
    squad = r
  }

  if (!(await canOnSquad(env, grants, squad.id, 'member'))) {
    return `You don't have permission to add tasks to ${squad.name} (need member on it).`
  }

  const task = await createTask(
    env,
    {
      squad_id: squad.id,
      title: title.trim(),
      done_when: IM_TASK_DONE_WHEN,
      body: '',
    },
    { actor: memberActor(member.id) },
  )

  return `Added to ${squad.name}: "${task.title}".`
}

// ── HTTP surface ──────────────────────────────────────────────────────────────
// Minimal + safe. Hermes can POST the raw Telegram update here, OR call
// handleImMessage(env, chatId, text) directly. We ONLY trust chat.id for identity
// and message.text for the intent — nothing else from the body.
export const imApp = new Hono<AppEnv>()

imApp.get('/health', (c) => c.json({ ok: true, component: 'im', tenant: c.env.TENANT_SLUG }))

// The slice of a Telegram update we read. Everything else is ignored. We do NOT
// read any "from"/username/identity field — identity is the chat.id mapping only.
interface TelegramUpdate {
  message?: {
    chat?: { id?: unknown }
    text?: unknown
  }
}

// POST /webhook — accept a Telegram-style update, resolve + act, reply.
// Returns { ok, reply } so the Hermes relay can echo `reply` back into the chat.
// We always answer 200 with a reply string (even for refusals) so the relay has
// a clear message to deliver; transport-level problems are the only non-200s.
imApp.post('/webhook', async (c) => {
  // Auth (fail-closed): the webhook must carry the shared secret. Telegram sends
  // the secret_token you registered via setWebhook in this header. Without a
  // configured secret the webhook is sealed — an unauthenticated POST could forge
  // a chat_id and impersonate that member's capabilities over IM.
  if (!c.env.IM_WEBHOOK_SECRET) {
    return c.json({ error: 'webhook_not_configured' }, 503)
  }
  if (c.req.header('X-Telegram-Bot-Api-Secret-Token') !== c.env.IM_WEBHOOK_SECRET) {
    return c.json({ error: 'unauthorized' }, 401)
  }

  let update: TelegramUpdate
  try {
    update = (await c.req.json()) as TelegramUpdate
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  const rawId = update.message?.chat?.id
  // chat id may arrive as number or string; anything else is unusable.
  const chatId =
    typeof rawId === 'number' && Number.isFinite(rawId)
      ? String(rawId)
      : typeof rawId === 'string' && rawId.trim().length > 0
        ? rawId.trim()
        : null
  if (!chatId) return c.json({ error: 'no_chat_id' }, 400)

  const text = typeof update.message?.text === 'string' ? update.message.text : ''

  const reply = await handleImMessage(c.env, chatId, text)
  return c.json({ ok: true, reply })
})
