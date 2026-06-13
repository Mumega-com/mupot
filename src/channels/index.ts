// mupot — channels CORE (the microkernel). The platform's scoped channel IS the
// squad: a bound channel maps to one squad, and a platform user maps to one
// member. A person "has effect" by sending a message in a bound channel, gated
// by the SAME frozen capability API as the MCP/IM/web surfaces.
//
// MICROKERNEL DISCIPLINE
//   - This file contains ZERO platform-specific code. It speaks ONLY the
//     ChannelAdapter interface (verify / parseInbound / post / listChannelMembers
//     / roleCapability) resolved through the registry. Adding a platform never
//     touches this file — only registry.ts + a new adapter leaf.
//
// SOVEREIGN-CORE DISCIPLINE (identical to src/mcp + src/im + src/auth)
//   - Identity is ALWAYS the platform→member MAPPING (member_identities), never
//     anything in the message TEXT. Text carries an intent ("task: …", "wake X");
//     it never carries "who". The exception is '/link <code>' where the code — a
//     server-issued, single-use secret — proves a claim; we still never trust a
//     self-asserted member id.
//   - AuthZ is OURS: every action is gated by the FROZEN capability API
//     (resolveCapabilities / hasCapability) against the scope it targets. A
//     'department' grant inherits down to its squads; an 'org' grant covers all.
//   - Tenant is environment-derived (env.TENANT_SLUG), never client-supplied.
//   - An unbound channel / unmapped user / over-scope intent is SAFELY REFUSED
//     via adapter.post — we do not act and we do not leak which ids are known.
//   - Every effect emits an ATTRIBUTED BusEvent (actor {kind:'member', id}).

import { Hono } from 'hono'
import type {
  Env,
  Capability,
  CapabilityGrant,
  BusEvent,
  Agent,
  Squad,
  ChannelBinding,
} from '../types'
import { resolveCapabilities, hasCapability } from '../auth/capability'
import { createBus } from '../bus'
import { getAdapter } from './registry'
import { createTask } from '../tasks/service'

type AppEnv = { Bindings: Env }

// ── attribution ───────────────────────────────────────────────────────────────
function memberActor(memberId: string): { kind: 'member'; id: string } {
  return { kind: 'member', id: memberId }
}

// ── resolution: externalChannelId → binding (→ squad) ─────────────────────────
// The channel↔squad mapping. A channel with no binding row is "unbound": the core
// refuses (politely) and takes NO action. Tenant isolation is structural — this
// pot's D1 only holds this pot's bindings.
async function bindingForChannel(
  env: Env,
  platform: string,
  externalChannelId: string,
): Promise<ChannelBinding | null> {
  const row = await env.DB.prepare(
    `SELECT id, platform, external_channel_id, squad_id, max_capability, created_at
       FROM channel_bindings
      WHERE platform = ?1 AND external_channel_id = ?2
      LIMIT 1`,
  )
    .bind(platform, externalChannelId)
    .first<ChannelBinding>()
  return row ?? null
}

// All bindings for a squad — used by the agent-activity feed to fan an agent
// event out to every channel watching that squad.
async function bindingsForSquad(env: Env, squadId: string): Promise<ChannelBinding[]> {
  const rows = await env.DB.prepare(
    `SELECT id, platform, external_channel_id, squad_id, max_capability, created_at
       FROM channel_bindings
      WHERE squad_id = ?1`,
  )
    .bind(squadId)
    .all<ChannelBinding>()
  return rows.results ?? []
}

// ── resolution: externalUserId → member ───────────────────────────────────────
// The platform-user↔member mapping (member_identities). This is the ONLY way an
// inbound principal is identified. Returns the member id, or null when unmapped.
async function memberForIdentity(
  env: Env,
  platform: string,
  externalUserId: string,
): Promise<{ memberId: string; status: string } | null> {
  const row = await env.DB.prepare(
    `SELECT m.id AS member_id, m.status AS status
       FROM member_identities mi
       JOIN members m ON m.id = mi.member_id
      WHERE mi.platform = ?1 AND mi.external_user_id = ?2
      LIMIT 1`,
  )
    .bind(platform, externalUserId)
    .first<{ member_id: string; status: string }>()
  if (!row) return null
  return { memberId: row.member_id, status: row.status }
}

// SECURITY: email auto-bind was REMOVED. The shared-token webhook verify does not
// cryptographically prove the payload's sender email, so auto-binding from it let a
// holder of the verify token forge any member's email and act as them (P0). All
// platforms — Google included — now require an explicit, single-use '/link <code>'.
// Re-enable Google email auto-bind ONLY behind a verified Google-signed JWT
// (audience = the app's project) so the email is cryptographically authenticated.

// ── scope helpers (frozen hasCapability + explicit department inheritance) ─────
// Mirrors src/im: a SQUAD action is allowed by a squad grant, an inherited
// department grant, or an org grant. Fail-closed when the squad's department is
// unresolvable (unknown squad → no inheritance, no access).
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
  if (hasCapability(grants, 'squad', squadId, min)) return true
  const deptId = await squadDepartmentId(env, squadId)
  if (deptId && hasCapability(grants, 'department', deptId, min)) return true
  return false
}

// ── lookups (a human types a name/slug, not a uuid) ───────────────────────────
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

async function loadSquad(env: Env, squadId: string): Promise<Squad | null> {
  const row = await env.DB.prepare(
    `SELECT id, department_id, slug, name, charter, created_at FROM squads WHERE id = ?1 LIMIT 1`,
  )
    .bind(squadId)
    .first<Squad>()
  return row ?? null
}

// ── intent parsing (text → intent; identity is NEVER here) ────────────────────
// The bound channel already names the squad, so intents act on THAT squad — no
// @squad reference is needed (unlike IM, where one chat reaches many squads).
type Intent =
  | { kind: 'help' }
  | { kind: 'link'; code: string }
  | { kind: 'status' }
  | { kind: 'wake'; ref: string }
  | { kind: 'task'; title: string }
  | { kind: 'unknown' }

function parseIntent(text: string): Intent {
  const trimmed = text.trim()
  if (!trimmed) return { kind: 'unknown' }
  const lower = trimmed.toLowerCase()

  if (lower === 'help' || lower === '/help' || lower === '?') return { kind: 'help' }

  // '/link <code>' — redeem a single-use link code to bind this platform user.
  const linkMatch = trimmed.match(/^\/?link\s+(.+)$/i)
  if (linkMatch) {
    const code = linkMatch[1].trim()
    return code ? { kind: 'link', code } : { kind: 'unknown' }
  }

  if (lower === 'status' || lower === '/status') return { kind: 'status' }

  const wakeMatch = trimmed.match(/^\/?wake\s+(.+)$/i)
  if (wakeMatch) {
    const ref = wakeMatch[1].trim()
    return ref ? { kind: 'wake', ref } : { kind: 'unknown' }
  }

  // "task: <title>" (also tolerate "task <title>").
  const taskMatch = trimmed.match(/^\/?task\s*[:|-]?\s+(.+)$/i)
  if (taskMatch) {
    const title = taskMatch[1].trim()
    return title ? { kind: 'task', title } : { kind: 'unknown' }
  }

  return { kind: 'unknown' }
}

// ── reply copy (short, friendly, never leaks internals) ───────────────────────
const HELP =
  'I can: "task: <title>", "status", "wake <agent>". This channel is wired to a ' +
  'squad; I act as you, with your permissions. New here? "/link <code>".'

// ── '/link <code>' redemption — bind a platform user to a member ──────────────
// Single-use, unexpired code (channel_link_codes). The code is the server-issued
// secret that proves the claim; we still derive the member from the CODE row, not
// from anything the user asserts. On success, insert the member_identities row.
async function redeemLink(
  env: Env,
  platform: string,
  externalUserId: string,
  code: string,
): Promise<string> {
  const now = new Date().toISOString()

  // Atomic single-use claim: flip used_at ONLY if unused, unexpired, and for THIS
  // platform. A concurrent redeem changes zero rows → already-used.
  const claim = await env.DB.prepare(
    `UPDATE channel_link_codes
        SET used_at = ?1
      WHERE code = ?2
        AND platform = ?3
        AND used_at IS NULL
        AND expires_at > ?1`,
  )
    .bind(now, code, platform)
    .run()

  if (!claim.meta || claim.meta.changes === 0) {
    // Unknown / expired / already-used — do not distinguish (no oracle).
    return 'That link code is invalid or has expired. Ask an admin for a new one.'
  }

  // Resolve the member the code was issued for (server-trusted), then bind.
  const codeRow = await env.DB.prepare(
    'SELECT member_id FROM channel_link_codes WHERE code = ?1 LIMIT 1',
  )
    .bind(code)
    .first<{ member_id: string }>()
  if (!codeRow) {
    return 'That link code is invalid or has expired. Ask an admin for a new one.'
  }

  try {
    await env.DB.prepare(
      `INSERT INTO member_identities (id, member_id, platform, external_user_id)
         VALUES (?1, ?2, ?3, ?4)`,
    )
      .bind(crypto.randomUUID(), codeRow.member_id, platform, externalUserId)
      .run()
  } catch {
    // This platform user is already bound to a member (UNIQUE collision). The code
    // was consumed; tell them they're already connected rather than leaking who.
    return "You're already connected to this workspace."
  }

  return "You're connected. Try \"status\" to see your access, or \"task: <title>\"."
}

// ── intent handlers (each returns the reply text the adapter will post) ───────

async function statusReply(env: Env, memberId: string, squad: Squad): Promise<string> {
  const grants = await resolveCapabilities(env, memberId)
  const scopes =
    grants.length === 0
      ? 'no capabilities yet'
      : grants
          .map((g) => `${g.capability}@${g.scope_type}${g.scope_id ? `:${g.scope_id}` : ''}`)
          .join(', ')
  return `This channel is wired to "${squad.name}". Your scopes: ${scopes}.`
}

async function wakeReply(
  env: Env,
  memberId: string,
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

  const now = new Date().toISOString()
  const event: BusEvent<{ by: string; reason: string }> = {
    type: 'agent.wake',
    tenant: env.TENANT_SLUG,
    squad_id: agent.squad_id,
    agent_id: agent.id,
    actor: memberActor(memberId),
    payload: { by: memberId, reason: 'channel.wake' },
    ts: now,
  }
  await createBus(env).emit(event)

  const stub = env.AGENT.get(env.AGENT.idFromName(agent.id))
  const res = await stub.fetch('https://agent/wake', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'channel.wake', squad_id: agent.squad_id }),
  })
  if (!res.ok) return `Tried to wake ${agent.name} but it didn't run. Try again shortly.`
  return `Woke ${agent.name}. It's running one cycle now.`
}

async function taskReply(
  env: Env,
  memberId: string,
  grants: CapabilityGrant[],
  squad: Squad,
  title: string,
): Promise<string> {
  // The bound channel names the squad — the action targets THAT squad only.
  if (!(await canOnSquad(env, grants, squad.id, 'member'))) {
    return `You don't have permission to add tasks to ${squad.name} (need member on it).`
  }

  const task = await createTask(
    env,
    {
      squad_id: squad.id,
      title: title.trim(),
      // #142: channel quick-add has no predicate — sentinel flags it for backfill.
      done_when: '(set via task update)',
      body: '',
    },
    { actor: memberActor(memberId) },
  )

  return `Added to ${squad.name}: "${task.title}".`
}

// ── the pipeline: resolve → gate → act → post ─────────────────────────────────
// Pure with respect to HTTP (no Hono context) so the webhook handler — and tests
// — can drive it directly. Returns the reply text that was posted.
async function runInbound(
  env: Env,
  platform: string,
  externalChannelId: string,
  externalUserId: string,
  text: string,
): Promise<string> {
  // 1) Channel↔squad: an unbound channel is refused, NO action taken.
  const binding = await bindingForChannel(env, platform, externalChannelId)
  if (!binding) {
    return 'This channel is not wired to a squad yet. Ask an admin to bind it.'
  }
  const squad = await loadSquad(env, binding.squad_id)
  if (!squad) {
    // Binding points at a deleted squad (CASCADE should prevent this, but fail-safe).
    return 'This channel is wired to a squad that no longer exists. Ask an admin.'
  }

  const intent = parseIntent(text ?? '')

  // 2) '/link' runs BEFORE identity resolution — it is how an unmapped user binds.
  if (intent.kind === 'link') {
    return redeemLink(env, platform, externalUserId, intent.code)
  }

  // 3) Identity: platform user → member, ALWAYS via an explicit prior '/link'
  // (no payload-email auto-bind — see the SECURITY note above). Unmapped = refused.
  const identity = await memberForIdentity(env, platform, externalUserId)
  if (!identity) {
    return "You're not connected to this workspace yet. Send \"/link <code>\" with the code an admin gave you."
  }
  if (identity.status !== 'active') {
    // A suspended member is inert — same posture as the IM seam.
    return 'Your access is suspended. Ask an admin to reactivate you.'
  }

  // 4) Capabilities for this member (the real RBAC).
  const grants = await resolveCapabilities(env, identity.memberId)

  // 5) Act on the bound squad, gated by capability.
  switch (intent.kind) {
    case 'help':
      return HELP
    case 'unknown':
      return `Sorry, I didn't catch that. ${HELP}`
    case 'status':
      return statusReply(env, identity.memberId, squad)
    case 'wake':
      return wakeReply(env, identity.memberId, grants, intent.ref)
    case 'task':
      return taskReply(env, identity.memberId, grants, squad, intent.title)
  }
}

// ── postAgentActivity — the live agent-activity feed ──────────────────────────
// For an agent-authored BusEvent, post a short attributed line into every channel
// bound to the agent's squad. This is how a human watching the channel SEES the
// squad's agents working. No-op for member-authored events (those are the human's
// own action, already echoed as a reply) and for events without a squad.
export async function postAgentActivity(env: Env, event: BusEvent): Promise<void> {
  if (event.actor?.kind !== 'agent') return
  if (!event.squad_id) return

  const bindings = await bindingsForSquad(env, event.squad_id)
  if (bindings.length === 0) return

  const summary = summarizeAgentEvent(event)
  const agentLabel = event.agent_id ?? event.actor.id

  // Fan out to every bound channel via its adapter. One failing platform must not
  // block the others — isolate each post.
  await Promise.all(
    bindings.map(async (b) => {
      const adapter = getAdapter(b.platform)
      if (!adapter) return
      try {
        await adapter.post(env, b.external_channel_id, `🤖 ${agentLabel} ${summary}`)
      } catch (err) {
        console.error('channels: agent-activity post failed', {
          platform: b.platform,
          channel: b.external_channel_id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }),
  )
}

// Map a BusEvent to a one-line human summary. Platform-agnostic; the adapter owns
// rendering. We read only the typed event shape — never platform specifics.
function summarizeAgentEvent(event: BusEvent): string {
  switch (event.type) {
    case 'task.created':
      return readField(event.payload, 'title')
        ? `created task "${readField(event.payload, 'title')}".`
        : 'created a task.'
    case 'task.updated':
      return readField(event.payload, 'title')
        ? `updated task "${readField(event.payload, 'title')}".`
        : 'updated a task.'
    case 'task.completed':
      return readField(event.payload, 'title')
        ? `completed task "${readField(event.payload, 'title')}".`
        : 'completed a task.'
    case 'task.blocked':
      return readField(event.payload, 'title')
        ? `got blocked on task "${readField(event.payload, 'title')}".`
        : 'got blocked on a task.'
    case 'agent.wake':
      return 'woke up and is working.'
    case 'squad.dispatch':
      return 'is coordinating the squad.'
    case 'lead.new':
      return 'is handling a new lead.'
    default:
      return 'did something.'
  }
}

// Safely read a string field from an unknown payload (no `any`).
function readField(payload: unknown, key: string): string | null {
  if (payload && typeof payload === 'object' && key in payload) {
    const v = (payload as Record<string, unknown>)[key]
    return typeof v === 'string' ? v : null
  }
  return null
}

// ── HTTP surface: the /channels webhook ───────────────────────────────────────
// POST /:platform/webhook — the single inbound seam. The core resolves the
// adapter from the path, then runs verify → parseInbound → pipeline → post. Every
// platform shares this exact flow; the adapter supplies the platform specifics.
export const channelsApp = new Hono<AppEnv>()

channelsApp.get('/health', (c) =>
  c.json({ ok: true, component: 'channels', tenant: c.env.TENANT_SLUG }),
)

// ── Hermes relay ──────────────────────────────────────────────────────────────
// Hermes is the always-on gateway (it holds the Discord/Telegram connections a CF
// Worker can't). It POSTs already-normalized, platform-verified messages here; mupot
// runs the SAME resolve→gate→act pipeline and returns the reply for Hermes to post
// back into the channel. Auth = a shared secret header (fail-closed). Hermes vouches
// for the platform identity; mupot still capability-gates every action.
interface RelayBody {
  platform?: unknown
  externalChannelId?: unknown
  externalUserId?: unknown
  text?: unknown
}
channelsApp.post('/relay', async (c) => {
  if (!c.env.HERMES_RELAY_SECRET) return c.json({ error: 'relay_not_configured' }, 503)
  if (c.req.header('X-Relay-Secret') !== c.env.HERMES_RELAY_SECRET) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  let body: RelayBody
  try {
    body = (await c.req.json()) as RelayBody
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }
  const platform = typeof body.platform === 'string' ? body.platform : ''
  const channel = typeof body.externalChannelId === 'string' ? body.externalChannelId : ''
  const user = typeof body.externalUserId === 'string' ? body.externalUserId : ''
  const text = typeof body.text === 'string' ? body.text : ''
  if (!platform || !channel || !user) {
    return c.json({ error: 'platform, externalChannelId, externalUserId required' }, 400)
  }
  const reply = await runInbound(c.env, platform, channel, user, text)
  return c.json({ ok: true, reply })
})

channelsApp.post('/:platform/webhook', async (c) => {
  const platform = c.req.param('platform')
  const adapter = getAdapter(platform)
  // Unknown platform → 503 (no adapter registered). Fail-closed, no body echoed.
  if (!adapter) {
    return c.json({ error: 'unknown_platform', platform }, 503)
  }

  // 0) Inline-response platforms (Discord interactions: PING→PONG, slash command →
  // {type:4}). The adapter owns its own verify + the HTTP response; the core only
  // hands it the resolve→gate→act pipeline via `run`. A non-null Response is returned
  // verbatim. Adapters without respond() (Telegram, Google Chat) fall through to the
  // standard verify → parseInbound → post() path below.
  if (adapter.respond) {
    const r = await adapter.respond(c.req.raw, c.env, (inb) =>
      runInbound(c.env, inb.platform, inb.externalChannelId, inb.externalUserId, inb.text),
    )
    if (r) return r
  }

  // 1) Authenticity (fail-closed). A false/throwing verify is a hard 401 — we do
  // NOT parse or act on an unverified webhook (it could forge a channel + user).
  let verified: boolean
  try {
    verified = await adapter.verify(c.req.raw, c.env)
  } catch {
    verified = false
  }
  if (!verified) {
    return c.json({ error: 'unauthorized' }, 401)
  }

  // 2) Normalize the inbound message via the adapter. null = nothing actionable
  // (a non-message event, a bot's own echo, a join notice) → ack 200, no action.
  let inbound
  try {
    inbound = await adapter.parseInbound(c.req.raw, c.env)
  } catch {
    return c.json({ error: 'invalid_payload' }, 400)
  }
  if (!inbound) {
    return c.json({ ok: true, ignored: true })
  }

  // Defensive: the adapter declares its platform; the path must agree. Mismatch =
  // misrouted; refuse rather than act under the wrong platform key.
  if (inbound.platform !== platform) {
    return c.json({ error: 'platform_mismatch' }, 400)
  }

  // 3) Resolve → gate → act. Returns the reply text.
  const reply = await runInbound(
    c.env,
    inbound.platform,
    inbound.externalChannelId,
    inbound.externalUserId,
    inbound.text,
  )

  // 4) Post the reply back through the adapter. If posting fails we still ack the
  // webhook (the effect, if any, already happened + emitted on the bus); the
  // platform should not redeliver and re-run the intent.
  try {
    await adapter.post(c.env, inbound.externalChannelId, reply)
  } catch (err) {
    console.error('channels: reply post failed', {
      platform,
      channel: inbound.externalChannelId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return c.json({ ok: true })
})

// reconcileMembership lives in ./sync; re-exported here so the channels core has a
// single import surface for the Integrate phase (index.ts / cron).
export { reconcileMembership } from './sync'
