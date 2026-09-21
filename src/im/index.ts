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
//   - Tenant is environment-derived (env.TENANT_SLUG), never client-supplied.
//     Suspended members are inert. Only an authenticated single-use invitation
//     can establish a new member mapping.
//   - Telegram reserves one principal-bound digest before handling an intent.
//     Domain services own the attributed decision and membership receipts.
//
// Exports:
//   - imApp            : Hono sub-app. POST /webhook accepts a Telegram-style
//                        update with update_id, message.from.id and private chat,
//                        verifies matching sender/chat IDs, resolves the member,
//                        runs the intent, and returns a short text reply.
//   - handleImMessage  : (env, chatId, text) => Promise<string>. The pure entry
//                        Hermes can call directly (or the webhook calls for it).

import { Hono } from 'hono'
import { TASK_SELECT_COLUMNS } from '../tasks/ranking'
import type {
  Env,
  Member,
  CapabilityGrant,
  BusEvent,
  Agent,
  Squad,
  Task,
  AuthContext,
} from '../types'
import { resolveCapabilities, hasCapability, canOnSquad as sharedCanOnSquad } from '../auth/capability'
import { createBus } from '../bus'
import { createTask, writeVerdict, VerdictRaceError, TaskEvidenceFenceError, NonHumanVerdictRefusedError } from '../tasks/service'
import { evaluateVerdictGates } from '../tasks/index'
import { emitControlRequest } from '../fleet/control'
import { CONTROL_VERBS, type ControlVerb } from '../fleet/control-request'
import { listFleetAgentRuntimeView, type FleetAgentRuntimeView } from '../fleet/registry'
import {
  clearHumanDirective,
  HUMAN_DIRECTIVE_KEY,
  HUMAN_DIRECTIVE_MAX_CHARS,
  setHumanDirective,
  validateHumanDirectiveText,
  type HumanDirectiveAction,
} from '../brain/directive'
import { timingSafeEqual } from '../lib/crypto'
import { routeAgentWake } from '../agents/wake-routing'
import { canonicalJsonDigest } from '../lib/canonical-json'
import { redeemTelegramProjectInvite } from '../members/project-invites'
import { listNeedsYou } from '../attention/service'
import { answerRoutineRun, getRoutinePendingQuestion, getRoutineProjectAccessRequest } from '../routines/actions'
import { routinePrincipal } from '../routines/access'
import { projectReadAccessFromGrants, projectVisibilityClause } from '../projects/access'
import { completeTelegramUpdate, reserveTelegramUpdate, type TelegramUpdateIdentity } from './telegram-receipts'

type AppEnv = { Bindings: Env }

export const IM_WEBHOOK_MAX_BODY_BYTES = 64 * 1024

type CappedBody =
  | { ok: true; raw: string }
  | { ok: false; reason: 'too_large' | 'bad_utf8' }

async function readCappedBody(req: Request, maxBytes: number): Promise<CappedBody> {
  const declared = req.headers.get('content-length')
  if (declared && Number(declared) > maxBytes) return { ok: false, reason: 'too_large' }
  const buf = await req.arrayBuffer()
  if (buf.byteLength > maxBytes) return { ok: false, reason: 'too_large' }
  try {
    return { ok: true, raw: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf) }
  } catch {
    return { ok: false, reason: 'bad_utf8' }
  }
}

// ── attribution ───────────────────────────────────────────────────────────────
function memberActor(memberId: string): { kind: 'member'; id: string } {
  return { kind: 'member', id: memberId }
}

// ── identity resolution (chat_id → Member) ────────────────────────────────────
// The ONLY way an IM principal is identified. Normalised to a string because a
// Telegram chat id arrives as a number; member_tokens/members store it as TEXT.
// A suspended member resolves to null here — their messages are inert.
export async function memberForChat(env: Env, chatId: string): Promise<Member | null> {
  const row = await env.DB.prepare(
    `SELECT id, email, display_name, telegram_chat_id, status, created_at
       FROM members
      WHERE telegram_chat_id = ?1 AND tenant = ?2
      LIMIT 1`,
  )
    .bind(chatId, env.TENANT_SLUG)
    .first<Member>()
  if (!row) return null
  if (row.status !== 'active') return null
  return row
}

// ── scope helper ────────────────────────────────────────────────────────────
// G-FP1b point 1: this used to be a hand-rolled reimplementation of the
// canonical squad-scope check (bare squadId, separately-resolved deptId) —
// exactly the shape that let round 2's kind='home' exclusion miss call
// sites. Delegates to the ONE canOnSquad in src/auth/capability.ts, which
// loads a real SquadScope and applies planeCoversScope, instead of
// re-deriving department inheritance here.
const canOnSquad = sharedCanOnSquad

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
// FP-01 Slice 2 v2 (successor to PR #1488, plugin v2 contract §2f(a) point 3
// collateral fix): every bound member now gets a home squad on first
// contact (memberIntakeEnvelope), which ALSO grants them an 'admin'
// capability there — meaning EVERY such member has at least two squad-scope
// grants going forward, permanently breaking "task: <title>" (no @ref)'s
// old "there is exactly one, use it" shorthand for anyone who previously
// had exactly one real working-squad grant. A home squad is a private
// personal space, never a team the member does `task:` shorthand work for
// (the same "home is special" treatment G-FP1b already applies to workspace-
// admin standing) — excluded from the ambiguity count here for that reason,
// not merely to route around the collision.
async function soleSquadGrant(env: Env, grants: CapabilityGrant[]): Promise<string | null> {
  const squadIds = [...new Set(
    grants.filter((g) => g.scope_type === 'squad' && g.scope_id).map((g) => g.scope_id as string),
  )]
  if (squadIds.length === 0) return null
  if (squadIds.length === 1) return squadIds[0]
  const placeholders = squadIds.map((_, index) => `?${index + 1}`).join(', ')
  const rows = await env.DB.prepare(
    `SELECT id FROM squads WHERE id IN (${placeholders}) AND kind != 'home'`,
  ).bind(...squadIds).all<{ id: string }>()
  const nonHomeIds = rows.results ?? []
  return nonHomeIds.length === 1 ? nonHomeIds[0].id : null
}

// ── intent parsing (text → intent; identity is NEVER here) ────────────────────
type Intent =
  | { kind: 'help' }
  | { kind: 'join'; code: string }
  | { kind: 'needs'; projectId: string | null }
  | { kind: 'answer'; runId: string; choice: string }
  | { kind: 'status'; ref: string | null }
  | { kind: 'wake'; ref: string }
  | { kind: 'fleet'; verb: ControlVerb; ref: string }
  | { kind: 'verdict'; verdict: 'approved' | 'rejected'; ref: string; note: string | null }
  | { kind: 'directive'; action: HumanDirectiveAction; text: string | null }
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
  const join = trimmed.match(/^\/start\s+(\S{1,512})$/i)
  if (join) return { kind: 'join', code: join[1] }
  const needs = trimmed.match(/^\/needs(?:\s+([A-Za-z0-9_-]{1,255}))?$/i)
  if (needs) return { kind: 'needs', projectId: needs[1] ?? null }
  const answer = trimmed.match(/^\/answer\s+([A-Za-z0-9_-]{1,255})\s+([\s\S]+)$/i)
  if (answer) return { kind: 'answer', runId: answer[1], choice: answer[2] }

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

  // "directive: <text>" pins a direct owner instruction for the brain.
  // "directive clear" removes it. The colon form is intentional so a natural
  // sentence starting with "directive" does not accidentally become control state.
  if (/^\/?directive\s+clear$/i.test(trimmed)) {
    return { kind: 'directive', action: 'clear', text: null }
  }
  const directiveMatch = trimmed.match(/^\/?directive\s*:\s*([\s\S]+)$/i)
  if (directiveMatch) {
    const text = directiveMatch[1]
    return { kind: 'directive', action: 'set', text }
  }

  // "approve <task-id> [note]" or "reject <task-id> <reason>"
  const verdictMatch = trimmed.match(/^\/?(approve|reject)\s+([A-Za-z0-9_-]{6,64})(?:\s+(.+))?$/i)
  if (verdictMatch) {
    const note = verdictMatch[3]?.trim() || null
    return {
      kind: 'verdict',
      verdict: verdictMatch[1].toLowerCase() === 'approve' ? 'approved' : 'rejected',
      ref: verdictMatch[2],
      note,
    }
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
  'I can: "/start <invite-code>", "/needs [project-id]", "/answer <run-id> <choice>", ' +
  '"task: <title>" (optionally "@squad"), "status" or "status <agent>", ' +
  '"wake <agent>", "fleet start|stop|restart|status <agent>", "approve <task-id>", ' +
  '"reject <task-id> <reason>", "directive: <text>", or "directive clear". ' +
  'I act as you, with your permissions.'

const IM_TASK_DONE_WHEN =
  'A task result or linked artifact provides evidence that the requested IM task is complete.'

export interface HandleImMessageOptions {
  /** True only when the transport can prove Telegram forwarded-message metadata. */
  forwarded?: boolean
  /** Set only by the authenticated webhook after reserving the envelope. */
  telegram?: TelegramUpdateIdentity
  /**
   * COSMETIC ONLY — Telegram's self-reported `first_name`/`username`, used
   * solely as the new member's stored `display_name` label. It carries NO
   * authority and is never part of identity, authorization, or the request
   * digest (computed upstream from update_id/telegram_user_id/chat_id/text/
   * forwarding only): membership binding is exclusively the authenticated
   * (tenant, update_id) receipt + Telegram user id. A caller cannot use this
   * field to claim or spoof a different identity than the one that reserved
   * the envelope.
   */
  displayName?: string
}

// ── the entry point Hermes calls ──────────────────────────────────────────────
// (env, chatId, text) → a short text reply to send back into the chat. Pure with
// respect to HTTP — no Hono context — so Hermes can invoke it directly.
//
// The 3-arg call is intentionally direct/trusted transport. Telegram webhook
// calls must pass { forwarded:true } when update metadata shows a forwarded
// message so every forwarded command can fail closed. New invitations also
// require the authenticated, reserved envelope; the trusted direct helper alone
// cannot establish membership.
export async function handleImMessage(
  env: Env,
  chatId: string | number,
  text: string,
  options: HandleImMessageOptions = {},
): Promise<string> {
  const chat = String(chatId)
  const intent = parseIntent(text ?? '')
  if (options.forwarded) return 'Send commands directly from your private chat; forwarded commands are refused.'

  // Invitations establish the mapping, so they must run before member lookup.
  if (intent.kind === 'join') {
    if (!options.telegram || options.telegram.telegram_user_id !== chat) {
      return 'Open your invitation in a direct Telegram conversation to join.'
    }
    const result = await redeemTelegramProjectInvite(env, {
      ...options.telegram,
      pairing_code: intent.code,
      display_name: sanitizeTelegramDisplayName(options.displayName),
    })
    // P2: never echo the raw error enum into the chat — `invalid_or_expired_pairing_code`
    // vs `ambiguous_pairing_code` vs `telegram_identity_conflict` vs `member_already_exists`
    // is a weak enumeration oracle over a secret pairing code. The distinguishing detail
    // (`result.error`) stays in this function's return value / caller-side receipts and
    // observability — never in the text that reaches the requester.
    // HOME CREATION ON FIRST CONTACT (mupot-plugin PR #19 v2 contract,
    // §2f(a) point 3; scoped down in FP-01 Slice 2 v2 round 2, P1-a): a
    // successful invite redemption is the ONE unambiguous first-contact
    // event this webhook can observe — provisioning happens HERE, exactly
    // once per redemption, never on any later or unrelated message (see
    // memberIntakeEnvelope's own doc comment for why it moved out of the
    // per-message read path). Members bound through a different channel
    // (e.g. the /account web Connect Telegram flow) are not provisioned by
    // this call site — a known, narrower scope than "any first message",
    // tracked as a follow-up rather than solved here.
    if (result.ok) await provisionHomeOnFirstContact(env, result.value.member_id)
    return result.ok ? joinedReply(result.value.project_id) : 'Could not join. Ask an admin for a new invitation.'
  }

  // 1) Identity: chat_id → member. No member → polite refusal, NO action taken.
  const member = await memberForChat(env, chat)
  if (!member) {
    return "You're not registered with this workspace yet. Ask an admin to invite you, then connect Telegram."
  }

  // 2) Capabilities for this member (the real RBAC).
  const grants = await resolveCapabilities(env, member.id)

  switch (intent.kind) {
    case 'needs':
      return needsReply(env, member, grants, intent.projectId)

    case 'answer': {
      const result = await answerRoutineRun(env, routinePrincipal(memberAuth(env, member, grants)), intent.runId, intent.choice)
      return result.ok
        ? (result.duplicate ? `Answer already recorded for ${intent.runId}.` : `Answer recorded for ${intent.runId}.`)
        : `Could not answer: ${result.error}.`
    }
    case 'help':
      return HELP

    case 'unknown':
      return `Sorry, I didn't catch that. ${HELP}`

    case 'status':
      return statusReply(env, member, intent.ref)

    case 'wake':
      return wakeReply(env, member, grants, intent.ref)

    case 'fleet':
      return fleetReply(env, member, grants, intent.verb, intent.ref, options)

    case 'verdict':
      return verdictReply(env, member, grants, intent.verdict, intent.ref, intent.note)

    case 'directive':
      return directiveReply(env, member, grants, intent.action, intent.text, options)

    case 'task':
      return taskReply(env, member, grants, intent.title, intent.squadRef)
  }
}

// provisionHomeOnFirstContact — FP-01 Slice 2 v2 round 2 (P1-a): the ONE
// write path for a bound member's home-squad provisioning over IM. Called
// EXACTLY once, from handleImMessage's 'join' case, right after a Telegram
// project-invite redemption succeeds — never from the per-message
// read-only envelope (memberIntakeEnvelope). Idempotent: an existing home
// is a pure read, no write attempted, no receipt written. On an actual
// provisioning attempt, a receipt (migrations/0161,
// member_home_provisioning_receipts) is written ONLY on success
// (created/existing) — a FAILED attempt writes nothing, so a transient
// failure can never accumulate unbounded rows in an append-only table; the
// next successful join (if the member ever retries) is what gets audited.
async function provisionHomeOnFirstContact(env: Env, memberId: string): Promise<void> {
  const { getMemberHomeSquad, createHomeForMember } = await import('../org/service')
  const home = await getMemberHomeSquad(env, memberId)
  if (home) return // idempotent: already has one — no write, no receipt.
  const created = await createHomeForMember(env, memberId)
  if (!created.ok) return // failed provisioning — no receipt row.
  try {
    await env.DB.prepare(
      `INSERT INTO member_home_provisioning_receipts (id, tenant, member_id, squad_id, channel, disposition)
       VALUES (?, ?, ?, ?, 'telegram', ?)`,
    ).bind(crypto.randomUUID(), env.TENANT_SLUG, memberId, created.squad.id, created.disposition).run()
  } catch { /* best-effort audit write; never blocks the join reply */ }
}

function joinedReply(projectId: string): string {
  return `Joined project ${projectId}. Use /needs to see what needs your attention.`
}

// IM resolves an ordinary human member, just like member HTTP/MCP auth. A
// capability row never synthesizes a legacy owner/admin role or agent identity.
export function memberAuth(env: Env, member: Member, grants: CapabilityGrant[]): AuthContext {
  return { userId: member.id, email: member.email, role: 'member', tenant: env.TENANT_SLUG,
    memberId: member.id, channel: 'im', capabilities: grants, boundAgentId: null }
}

async function needsReply(env: Env, member: Member, grants: CapabilityGrant[], projectId: string | null): Promise<string> {
  const principal = routinePrincipal(memberAuth(env, member, grants))
  const page = await listNeedsYou(env, principal, { ...(projectId ? { project_id: projectId } : {}), limit: 10 })
  if (!page.items.length) return 'Nothing needs your attention in your accessible projects.'
  const lines: string[] = []
  let omitted = Boolean(page.next_cursor || page.truncated)
  for (const item of page.items) {
    const actions = item.allowed_actions.map(action => {
      if (action === 'approve') return `/approve ${item.source_id}`
      if (action === 'reject') return `/reject ${item.source_id} <reason>`
      if (action === 'answer') return `/answer ${item.source_id} <choice>`
      if (action === 'view') return item.safe_url
      return action
    })
    let questionText = ''
    if (item.allowed_actions.includes('answer')) {
      const question = await getRoutinePendingQuestion(env, principal, item.source_id)
      if (question) questionText = `\n${question.question}${question.choices.length ? ` Choices: ${question.choices.join(' | ')}` : ''}`
    }
    // FP-01 Slice 2 v2 (successor to PR #1488, P1-6): a project_access
    // proposal must show member/project/access_level/reason BEFORE /approve
    // is possible — "the human approved it" is not defensible when the
    // channel never showed them what "it" is. Checked for every 'approve'-
    // eligible item (cheap: a single-row lookup keyed on the task id that
    // is a no-op unless a project_access proposal is actually waiting on
    // it), not just 'answer' items.
    if (item.allowed_actions.includes('approve')) {
      const request = await getRoutineProjectAccessRequest(env, principal, item.source_id)
      if (request) {
        questionText += `\nGrant ${request.access_level} on ${request.project_name} to `
          + `${request.member_name ?? request.member_id} (${request.member_id}). Reason: ${request.reason}`
      }
    }
    let line = `${item.project_name}: ${item.title} (${item.source_id})${questionText}\n${actions.join(' · ')}`
    if (line.length > 3900) {
      line = `${item.project_name.slice(0, 100)}: ${item.title.slice(0, 200)} (${item.source_id})\n${actions.join(' · ')}\nOpen the item to read its full details.`
    }
    if ([...lines, line].join('\n\n').length > 3900) {
      omitted = true
      break
    }
    lines.push(line)
  }
  if (omitted) lines.push('More items are available in the project dashboard.')
  return lines.join('\n\n')
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

  const routed = await routeAgentWake(env, {
    agent,
    byMemberId: member.id,
    reason: 'im.wake',
  })
  if (!routed.ok) return `Tried to wake ${agent.name} but it didn't run. Try again shortly.`
  if (routed.route === 'agent_do') return `Woke ${agent.name}. It's running one cycle now.`
  return `Wake request for ${agent.name} was durably queued.`
}

// ── intent: fleet (cap: owner on org) ────────────────────────────────────────
// This is host process control, so IM uses the exact same signed fleet-control
// plane as the dashboard: owner gate here, Ed25519 verification on the host.
function canControlFleet(grants: CapabilityGrant[]): boolean {
  return hasCapability(grants, 'org', null, 'owner')
}

async function resolveFleetAgent(env: Env, ref: string): Promise<FleetAgentRuntimeView | 'ambiguous' | null> {
  const needle = ref.trim().toLowerCase()
  if (!needle) return null

  const rows = await listFleetAgentRuntimeView(env)
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

function fleetAgentLabel(agent: FleetAgentRuntimeView): string {
  return agent.display || agent.agent_id
}

function fleetRuntimeContext(agent: FleetAgentRuntimeView): string {
  const lastSeen = agent.last_seen || 'unknown'
  return `Mupot sees presence ${agent.presence}, intent ${agent.status}, last seen ${lastSeen}.`
}

async function fleetReply(
  env: Env,
  member: Member,
  grants: CapabilityGrant[],
  verb: ControlVerb,
  ref: string,
  options: HandleImMessageOptions,
): Promise<string> {
  if (options.forwarded) {
    return 'Fleet control commands must be sent directly from your paired chat, not forwarded.'
  }
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
    if (res.reason === 'invalid_input') return `I couldn't queue fleet ${verb} for ${fleetAgentLabel(agent)}: ${res.detail ?? 'invalid request'}.`
    return `Fleet control request for ${fleetAgentLabel(agent)} could not be delivered.`
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

  return `Queued fleet ${verb} for ${fleetAgentLabel(agent)}. ${fleetRuntimeContext(agent)}`
}

// ── intent: approval verdict (shared member + gate grant policy) ────────────
// Approval authority remains the same append-only gate store as the dashboard:
// IM only resolves the member, checks access, then calls writeVerdict().
// mupot#1080/#1081 (2026-09-04): memberHasGateGrant and memberHasSurfaceGrant
// used to live here as verdictReply's own hand-rolled gate-ownership +
// surface-cap checks (bare gate_grants existence, no liveness join, no
// gate:agent-self-completion special case). Removed — verdictReply now calls
// the shared evaluateVerdictGates (src/tasks/index.ts), which covers both
// (via callerHoldsGateCapability, now liveness-joined, and hasSurfaceCap)
// plus the special case these two never had. See verdictReply's own comment
// for the exploit this closed.

export async function memberOwnsAssigneeAgent(
  env: Env,
  memberId: string,
  assigneeAgentId: string | null,
): Promise<boolean> {
  if (!assigneeAgentId) return false
  const row = await env.DB.prepare(
    `SELECT 1 FROM agent_keys
      WHERE tenant = ?1 AND agent_id = ?2 AND member_id = ?3
      LIMIT 1`,
  )
    .bind(env.TENANT_SLUG, assigneeAgentId, memberId)
    .first<{ 1: number }>()
  return row !== null
}

function escapeLikePrefix(ref: string): string {
  return ref.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

async function resolveTaskRef(env: Env, ref: string): Promise<Task | 'ambiguous' | null> {
  const exact = await env.DB.prepare(
    `SELECT ${TASK_SELECT_COLUMNS}, workflow_instance_id
       FROM tasks WHERE id = ?1 LIMIT 1`,
  )
    .bind(ref)
    .first<Task>()
  if (exact) return exact

  // Telegram is awkward for UUIDs; allow a unique prefix once it is specific enough.
  if (ref.length < 8) return null
  const rows = await env.DB.prepare(
    `SELECT ${TASK_SELECT_COLUMNS}, workflow_instance_id
       FROM tasks WHERE id LIKE ?1 ESCAPE '\\' ORDER BY created_at DESC LIMIT 2`,
  )
    .bind(`${escapeLikePrefix(ref)}%`)
    .all<Task>()
  const results = rows.results ?? []
  if (results.length === 0) return null
  if (results.length > 1) return 'ambiguous'
  return results[0]
}

async function verdictReply(
  env: Env,
  member: Member,
  grants: CapabilityGrant[],
  verdict: 'approved' | 'rejected',
  ref: string,
  note: string | null,
): Promise<string> {
  if (verdict === 'rejected' && !note) {
    return `Add a rejection reason: reject ${ref} <reason>.`
  }

  const task = await resolveTaskRef(env, ref)
  if (task === 'ambiguous') return `More than one task matches "${ref}". Use the full task id.`
  if (!task) return `No task named "${ref}" here.`

  if (!(await canOnSquad(env, grants, task.squad_id, 'member'))) {
    return `You don't have permission to decide that task (need member on its squad).`
  }
  if (!task.gate_owner) return `"${task.title}" has no approval gate.`
  if (task.status !== 'review') return `"${task.title}" is ${task.status}, not waiting for approval.`

  const auth = memberAuth(env, member, grants)
  const gateOwner = task.gate_owner
  const gateResult = await evaluateVerdictGates(
    env,
    auth,
    { squad_id: task.squad_id, gate_owner: gateOwner, assignee_agent_id: task.assignee_agent_id },
    verdict,
  )
  if (!gateResult.allowed) {
    if (gateResult.code === 'missing_surface_cap') {
      return `You don't have permission to approve "${task.title}" (need outreach:send-gated).`
    }
    if (gateResult.code === 'self_verdict') {
      // Unreachable in practice today: this function's principal is always a
      // member id, which can never equal an agent assignee_agent_id. Kept as
      // a defensive, sensible message rather than an unhandled branch.
      return `You can't decide "${task.title}" because you are the assignee.`
    }
    const need = gateOwner === 'gate:agent-self-completion' ? 'assignee_or_org_admin' : gateOwner
    return `You don't have permission to decide "${task.title}" (need ${need}).`
  }

  // IM-SPECIFIC conflict-of-interest rule, layered ON TOP of the shared
  // predicate above (not replaced by it): a human who owns/minted the
  // assignee agent's token may not verdict that agent's own task. This is
  // orthogonal to evaluateVerdictGates' self-verdict rule (which compares
  // the DECIDING principal to the assignee — for IM the deciding principal
  // is always a member, never the agent itself, so that rule can never fire
  // here) — memberOwnsAssigneeAgent is IM's own, additional guard.
  if (await memberOwnsAssigneeAgent(env, member.id, task.assignee_agent_id)) {
    return `You can't decide "${task.title}" because you are the assignee.`
  }

  try {
    await writeVerdict(
      env,
      { task, verdict, note, decidedBy: member.id },
      memberActor(member.id),
    )
  } catch (err) {
    if (err instanceof VerdictRaceError) {
      return `"${task.title}" changed before I could record the verdict. Reload approvals and try again.`
    }
    if (err instanceof TaskEvidenceFenceError) {
      return `"${task.title}"'s squad no longer has write access to its project — the verdict was not recorded.`
    }
    if (err instanceof NonHumanVerdictRefusedError) {
      return `"${task.title}" gates a member's project access request and needs your decision — the verdict was not recorded.`
    }
    throw err
  }

  if (task.workflow_instance_id && env.TASK_WORKFLOW) {
    try {
      const inst = await env.TASK_WORKFLOW.get(task.workflow_instance_id)
      await inst.sendEvent({ type: 'gate-verdict', payload: { verdict } })
    } catch {
      // The verdict is already durable in D1; the workflow re-reads it on resume.
    }
  }

  return verdict === 'approved' ? `Approved "${task.title}".` : `Rejected "${task.title}".`
}

// ── intent: human directive (cap: owner on org, direct chat only) ─────────────
function canPinHumanDirective(grants: CapabilityGrant[]): boolean {
  return hasCapability(grants, 'org', null, 'owner')
}

async function emitDirectiveUpdate(
  env: Env,
  member: Member,
  action: HumanDirectiveAction,
  textLength: number | null,
): Promise<void> {
  const now = new Date().toISOString()
  const payload: {
    action: HumanDirectiveAction
    key: typeof HUMAN_DIRECTIVE_KEY
    source: 'im'
    by_member_id: string
    text_length?: number
  } = {
    action,
    key: HUMAN_DIRECTIVE_KEY,
    source: 'im',
    by_member_id: member.id,
  }
  if (textLength !== null) payload.text_length = textLength

  const event: BusEvent<typeof payload> = {
    type: 'brain.directive.updated',
    tenant: env.TENANT_SLUG,
    actor: memberActor(member.id),
    payload,
    ts: now,
  }
  await createBus(env).emit(event)
}

async function directiveReply(
  env: Env,
  member: Member,
  grants: CapabilityGrant[],
  action: HumanDirectiveAction,
  text: string | null,
  options: HandleImMessageOptions,
): Promise<string> {
  if (options.forwarded) {
    return 'Brain directives must be sent directly from your paired chat, not forwarded.'
  }
  if (!canPinHumanDirective(grants)) {
    return `You don't have permission to pin brain directives (need owner on the org).`
  }

  if (action === 'clear') {
    await clearHumanDirective(env)
    await emitDirectiveUpdate(env, member, 'clear', null)
    return 'Cleared the pinned directive.'
  }

  const checked = validateHumanDirectiveText(text ?? '')
  if (!checked.ok) {
    if (checked.reason === 'too_long') {
      return `Directive is too long. Keep it under ${HUMAN_DIRECTIVE_MAX_CHARS} characters.`
    }
    return 'Write the directive after "directive:".'
  }

  const directive = await setHumanDirective(env, {
    text: checked.text,
    byMemberId: member.id,
    source: 'im',
  })
  await emitDirectiveUpdate(env, member, 'set', directive.text.length)
  return 'Pinned directive for the brain.'
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
    const soleId = await soleSquadGrant(env, grants)
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
// The shared secret authenticates Telegram's envelope. Only a private message
// whose immutable sender and chat IDs agree can establish a human principal.
export const imApp = new Hono<AppEnv>()

imApp.get('/health', (c) => c.json({ ok: true, component: 'im', tenant: c.env.TENANT_SLUG }))

export interface ResolvedProjectCandidate {
  id: string
  slug: string
  name: string
}

const RESOLVE_PROJECT_MAX_CANDIDATES = 5

// resolveMemberProjects — mupot-plugin PR #17 contract addendum (FP-01 Slice
// 2, mupot#1443): the plugin needs to turn a member's OWN free-text project
// reference ("Psychonom") into a real project id, WITHOUT Mubot resolving
// over its own whole project_list (Mubot's own standing may see projects
// this member cannot, or vice versa — the member's OWN readable set is the
// only correct answer here).
//
// Deliberately NOT an MCP tool: an MCP tool's caller is the AGENT (Mubot),
// and there is no existing, safe way for an MCP arg to assert "resolve
// using THIS OTHER member's standing" without inventing a fresh act-as-
// member primitive (a real capability-modeling question this flight has no
// mandate to open). The one place a member's identity is ALREADY
// authenticated server-side without trusting caller-supplied text is the
// chat_id -> member mapping this file already enforces for everything else
// (file header: "Identity is ALWAYS derived server-side... We NEVER read an
// identity out of message TEXT"). So this is exposed on the SAME
// shared-secret-authenticated IM surface, keyed on chat_id, never on a
// caller-supplied member_id — Mubot cannot use it to probe an arbitrary
// member's readable projects, only the one bound to the chat that called it.
//
// NO-ORACLE: a query that matches a REAL but unreadable project returns the
// exact same shape as a query matching nothing — the visibility clause is
// baked into the SQL itself, so there is no separate "exists but hidden"
// branch to leak through.
export async function resolveMemberProjects(
  env: Env,
  memberId: string,
  query: string,
  limit = RESOLVE_PROJECT_MAX_CANDIDATES,
): Promise<ResolvedProjectCandidate[]> {
  const needle = query.trim()
  if (!needle) return []
  const boundedLimit = Math.min(RESOLVE_PROJECT_MAX_CANDIDATES, Math.max(1, Math.floor(limit)))

  const grants = await resolveCapabilities(env, memberId)
  const access = projectReadAccessFromGrants(
    { userId: memberId, email: null, role: 'member', tenant: env.TENANT_SLUG, memberId, capabilities: grants },
    grants,
  )
  const visibility = projectVisibilityClause(access)
  const like = `%${needle.replace(/[%_]/g, char => `\\${char}`)}%`
  // Bare `?` throughout, matching projectVisibilityClause's own convention —
  // mixing bare `?` with explicit `?1`/`?2` numbering in one statement lets
  // SQLite's auto-numbering collide with an explicit number used later in
  // the same text (measured: LIMIT's explicit ?3 collided with the first
  // bare `?` from visibility.sql, binding a JSON array string where an
  // integer was expected). Bind order matches left-to-right text order.
  const rows = await env.DB.prepare(
    `SELECT p.id, p.slug, p.name
       FROM projects p
      WHERE (p.slug = ? OR p.slug LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\')
        AND ${visibility.sql}
      ORDER BY (p.slug = ?) DESC, p.name ASC
      LIMIT ?`,
  ).bind(needle, like, like, ...visibility.binds, needle, boundedLimit).all<ResolvedProjectCandidate>()
  return rows.results ?? []
}

// POST /resolve-project — plugin contract (mupot-plugin PR #19 v2 addendum,
// FP-01 Slice 2 v2, Athena's design ruling: "resolve-project fence = ENVELOPE
// IDENTITY, not a token"). Body shape is now the SAME Telegram envelope
// /webhook verifies — { update_id, message: { from: { id }, chat: { id,
// type: 'private' }, text }, query } — plus `query`/`limit`, over the SAME
// shared-secret header. This closes the adversarial P1 finding on the prior
// `{ chat_id, query }` shape (kasra-review 2026-09-21, PR #1488): a bare
// `chat_id` body field was never a fence — any secret holder could pick
// ANY member's identity by varying it, unlike /webhook where the identity
// comes from a signed Telegram envelope that ALSO enforces private_chat and
// from.id === chat.id. Deriving chatId/userId from `message.from.id` /
// `message.chat.id` here (identical fields, identical checks) restores that
// parity — a `member_id` or bare `chat_id` at the body's top level is never
// read at all, so it cannot select a different member's identity no matter
// what value is supplied. NOT a reservation-guarded update (no update_id
// idempotency needed — a pure read has no effect to make idempotent); the
// envelope's update_id/text fields are accepted for shape parity with
// /webhook and are otherwise unused here.
imApp.post('/resolve-project', async (c) => {
  if (!c.env.IM_WEBHOOK_SECRET) return c.json({ error: 'webhook_not_configured' }, 503)
  const providedSecret = c.req.header('X-Telegram-Bot-Api-Secret-Token')
  if (!providedSecret || !timingSafeEqual(providedSecret, c.env.IM_WEBHOOK_SECRET)) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  let body: TelegramUpdate & { query?: unknown; limit?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'invalid_update' }, 400)
  const chatId = telegramId(body.message?.chat?.id)
  if (!chatId) return c.json({ error: 'no_chat_id' }, 400)
  const userId = telegramId(body.message?.from?.id)
  if (!userId) return c.json({ error: 'no_user_id' }, 400)
  // P1-b (FP-01 Slice 2 v2 round 2): update_id is REQUIRED and RESERVED —
  // the SAME reserveTelegramUpdate/completeTelegramUpdate helper /webhook
  // itself uses (src/im/telegram-receipts.ts), not a hand-rolled copy. Prior
  // to this fix, this route had no update_id requirement and no
  // telegram_webhook_receipts row at all — replayable without limit, and an
  // oracle over telegram-id -> member -> readable-project-set for anyone
  // holding the shared secret. Reserving turns a replay of the identical
  // (update_id, identity, query) into the STORED prior response rather than
  // a second execution, exactly like every other webhook call this file
  // makes idempotent.
  const updateId = telegramId(body.update_id, true)
  if (!updateId) return c.json({ error: 'no_update_id' }, 400)
  // Identity fence — the SAME two conjuncts /webhook enforces (private_chat
  // + userId === chatId). A `chat_id`/`member_id` anywhere else in the body
  // is never consulted, so it can never stand in for these.
  if (body.message?.chat?.type !== 'private' || userId !== chatId) {
    return c.json({ error: 'private_chat_required' }, 400)
  }
  const query = typeof body.query === 'string' ? body.query : ''
  if (!query.trim()) return c.json({ error: 'invalid_query' }, 400)
  const limit = typeof body.limit === 'number' && Number.isFinite(body.limit) ? body.limit : RESOLVE_PROJECT_MAX_CANDIDATES

  // Namespaced update_id ('resolve-project:<id>') — telegram_webhook_receipts
  // has ONE UNIQUE(tenant, update_id) keyspace shared with /webhook. The
  // plugin may legitimately reuse the SAME Telegram update_id for both a
  // /webhook call and a /resolve-project call over the SAME inbound update
  // (one message, two purposes) — without a route-scoped prefix those two
  // calls would collide on this route's very first request.
  const scopedUpdateId = `resolve-project:${updateId}`
  let digest: string
  try {
    digest = await canonicalJsonDigest({ update_id: updateId, telegram_user_id: userId, chat_id: chatId, query, limit })
  } catch {
    return c.json({ error: 'invalid_update' }, 400)
  }
  const identity: TelegramUpdateIdentity = { update_id: scopedUpdateId, telegram_user_id: userId, request_digest: digest }
  const reservation = await reserveTelegramUpdate(c.env, identity)
  if (!reservation.ok) return c.json({ error: reservation.error }, 409)
  if (reservation.duplicate) {
    try {
      return c.json(JSON.parse(reservation.response_text))
    } catch {
      return c.json({ error: 'update_in_progress' }, 409)
    }
  }

  const member = await memberForChat(c.env, chatId)
  const response = member
    ? { bound: true as const, member_id: member.id, projects: await resolveMemberProjects(c.env, member.id, query, limit) }
    : { bound: false as const, member_id: null, projects: [] }

  const stored = await completeTelegramUpdate(c.env, identity, JSON.stringify(response))
  if (stored === null) return c.json({ error: 'update_in_progress' }, 409)
  return c.json(JSON.parse(stored))
})

// Display names and usernames never identify a human or contribute authority.
interface TelegramUpdate {
  update_id?: unknown
  message?: {
    chat?: { id?: unknown; type?: unknown }
    from?: { id?: unknown; first_name?: unknown; username?: unknown }
    text?: unknown
    forward_origin?: unknown
    forward_from?: unknown
    forward_from_chat?: unknown
    forward_date?: unknown
  }
}

export function telegramId(raw: unknown, allowZero = false): string | null {
  const value = typeof raw === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(raw)
    ? Number(raw) : typeof raw === 'number' ? raw : NaN
  return Number.isSafeInteger(value) && value >= (allowZero ? 0 : 1) ? String(value) : null
}

/**
 * COSMETIC ONLY — Telegram's self-reported `first_name`/`username` become the
 * new member's `display_name` label and nothing else: not identity, not
 * authority, not part of the request digest. Membership binding stays
 * exclusively the authenticated (tenant, update_id) receipt + Telegram user
 * id (see the header comment on TelegramUpdate above and on
 * HandleImMessageOptions.displayName). Capped well under
 * project-invites.ts's own 200-char display_name validation.
 */
function telegramDisplayName(from: { first_name?: unknown; username?: unknown } | undefined): string | undefined {
  const firstName = typeof from?.first_name === 'string' ? from.first_name.trim() : ''
  const username = typeof from?.username === 'string' ? from.username.trim() : ''
  const label = username ? (firstName ? `${firstName} (@${username})` : `@${username}`) : firstName
  const trimmed = label.slice(0, 100).trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** Falls back to a generic label if Telegram supplied nothing usable — still
 *  cosmetic only, see telegramDisplayName above. */
function sanitizeTelegramDisplayName(candidate: string | undefined): string {
  const trimmed = candidate?.trim()
  return trimmed && trimmed.length > 0 ? trimmed.slice(0, 100) : 'Telegram member'
}

// StoredTelegramReplyValue — the webhook's JSON response shape. `bound`,
// `member_id`, `home_squad_id` and `intake_state` are ADDITIVE (mupot-plugin
// PR #17 contract, FP-01 Slice 2): a caller (the mupot-plugin's
// first-person skill) needs the chat's bound/home/intake state as TYPED
// fields, never by string-matching the prose in `reply` — that
// string-matching anti-pattern is exactly what BLOCKed mupot-plugin PR #15
// round 1, and the plugin must never decide "is this a new member" locally.
export type IntakeState = 'none' | 'pending' | 'complete'

interface StoredTelegramReplyValue {
  ok: true
  reply: string
  bound: boolean
  member_id: string | null
  home_squad_id: string | null
  intake_state: IntakeState
}

// memberIntakeEnvelope — the ONE place bound/member_id/home_squad_id/intake_state
// are computed, shared by the webhook's per-message reply AND any other
// per-message status surface (same fields, same cost — a plugin polling for
// status gets byte-identical semantics to the webhook reply). All THREE
// reads are indexed point/EXISTS lookups (memberForChat: telegram_chat_id
// unique index; getMemberHomeSquad: department slug lookup then a
// department_id-indexed squad SELECT; the intake EXISTS below: a single
// json_extract EXISTS over routine_run_actions) — cheap enough for a
// rate-limited per-message poll, never a table scan.
//
// intake_state is entirely SERVER-derived, never left for a caller to infer:
//   'none'    — chatId maps to no member at all (memberForChat returned null).
//   'pending' — bound, but the project_access proposal chain (FP-01 Slice 2
//               Task A) has not yet been submitted for this member.
//   'complete'— a project_access routine proposal naming this member EXISTS
//               (routine_run_actions.kind='project_access') OR its
//               append-only project_access_grant_receipts row exists —
//               regardless of the proposal's own approved/rejected/waiting
//               outcome. "complete" names the INTAKE conversation having
//               produced a proposal, not the grant's own verdict, which is a
//               separate, later fact the grant chain itself already tracks
//               via task_verdicts.
//
// ATHENA ROUND-2 CONDITION 1: the receipt-row OR is not redundant. A
// routine_run_actions row is ordinary application data (no ON DELETE
// RESTRICT protects it from a rollback, an operator DELETE, or a future
// cleanup job) — the append-only project_access_grant_receipts row
// (migrations/0157) is the durable side of the pair. Checking BOTH means a
// deleted/rolled-back proposal row still reads 'complete' as long as its
// receipt survives. And a REJECTED verdict must NEVER flip a member back to
// 'pending': the routine_run_actions row (existence, not status) already
// covers this — a rejected proposal still exists, still counts as
// 'complete'. RE-INTAKE REQUIRES HUMAN WORD: nothing in this file ever
// deletes a project_access proposal or its receipt to "retry" intake; that
// would need an explicit human decision (a new proposal, or an operator
// action) — this derivation only ever reads, it never manufactures a path
// back to 'pending' on its own.
//
// NO MIGRATION for the routine_run_actions leg: reuses input_json (already
// storing member_id on a project_access action's own input, migrations/
// 0073+0158). The receipt leg reuses the table Task A already added.
export async function memberIntakeEnvelope(
  env: Env,
  member: Member | null,
): Promise<{ bound: boolean; member_id: string | null; home_squad_id: string | null; intake_state: IntakeState }> {
  if (!member) return { bound: false, member_id: null, home_squad_id: null, intake_state: 'none' }
  // READ-ONLY, genuinely (FP-01 Slice 2 v2 round 2, P1-a): this function is
  // called at the END of EVERY /im/webhook request — including a bare
  // status probe with no actionable intent at all — purely to compute the
  // response envelope. It must never itself provision a home; that is
  // provisionHomeOnFirstContact's job, called ONLY from handleImMessage's
  // 'join' case (the one unambiguous first-contact event), never here. A
  // prior version of this function called createHomeForMember whenever a
  // bound member had no home, on EVERY message — under IM_WEBHOOK_SECRET
  // alone (no rate limit, no idempotency beyond createHomeForMember's own),
  // any secret holder replaying probes against a homeless member minted
  // repeated 'failed'-disposition rows into the append-only
  // member_home_provisioning_receipts table with no way to ever clean them
  // up. Fixed by moving provisioning entirely out of this read path.
  const { getMemberHomeSquad } = await import('../org/service')
  const home = await getMemberHomeSquad(env, member.id)
  const homeId = home?.id ?? null
  // FP-01 Slice 2 v2 round 2 (P2-6, kasra-review adversarial gate on PR
  // #1490): the PRIOR derivation flipped 'complete' the moment a
  // project_access proposal merely EXISTED naming this member — BEFORE any
  // human ever verdicted it. That is a cross-member DoS: ANY proposer
  // (Mubot) can permanently lock a VICTIM's intake_state to 'complete' by
  // naming them in a proposal they never asked for and no human has
  // decided — the plugin only offers first-person intake while
  // intake_state==='pending' (§2f), so this silently and permanently kills
  // it for someone who never spoke to the bot.
  //
  // FIX: 'complete' now requires a DECIDED outcome — a task_verdicts row
  // BOUND (via proposal_id, 0159) to a project_access proposal naming this
  // member, OR a grant receipt. A REJECTED verdict still counts (Athena's
  // "denied stays complete" ruling, PR #1488's own round-2 condition) —
  // it IS a decision, just not a grant; only the UNDECIDED-proposal case is
  // now excluded. Bound via proposal_id specifically (not "any verdict on
  // the control task") so a stale/unrelated verdict elsewhere on the same
  // control task can't manufacture a false 'complete' either.
  //
  // Compared via julianday(), not raw string comparison — routine_run_actions
  // (and by extension a joined task_verdicts.decided_at) and
  // project_access_grant_receipts.created_at are shaped differently
  // ('YYYY-MM-DD HH:MM:SS' via `datetime('now')` vs 'YYYY-MM-DDTHH:MM:SS.SSSZ'
  // via `strftime('%Y-%m-%dT%H:%M:%fZ','now')`) — the two formats do NOT
  // compare correctly as plain strings (the space/'T' separator alone would
  // make every datetime('now')-shaped timestamp sort before every
  // strftime(...'%fZ'...)-shaped one, regardless of actual time order) —
  // julianday() parses both correctly.
  // TOLERATES ITS OWN MIGRATIONS NOT HAVING RUN YET (code and migrations
  // here deploy as separate manual steps): this query references
  // task_verdicts.proposal_id (0159) and
  // project_access_grant_receipts.kind (0160) — both new. This function
  // runs on EVERY /im/webhook message, so a deploy of this code ahead of
  // either migration must degrade safely, never 500 the whole webhook.
  // 'pending' is the conservative default (the same value a genuinely
  // undecided member reads) — never fabricates 'complete'.
  let completionJd = -Infinity
  let reintakeJd: number | null = null
  try {
    const completion = await env.DB.prepare(
      `SELECT
          (SELECT MAX(julianday(tv.decided_at))
             FROM routine_run_actions rra
             JOIN task_verdicts tv ON tv.proposal_id = rra.id
            WHERE rra.tenant = ?1 AND rra.kind = 'project_access'
              AND json_extract(rra.input_json, '$.member_id') = ?2) AS decision_jd,
          (SELECT MAX(julianday(created_at)) FROM project_access_grant_receipts
            WHERE tenant = ?1 AND member_id = ?2 AND kind = 'grant') AS grant_jd,
          (SELECT MAX(julianday(created_at)) FROM project_access_grant_receipts
            WHERE tenant = ?1 AND member_id = ?2 AND kind = 'reintake_authorized') AS reintake_jd`,
    ).bind(env.TENANT_SLUG, member.id).first<{ decision_jd: number | null; grant_jd: number | null; reintake_jd: number | null }>()
    completionJd = Math.max(completion?.decision_jd ?? -Infinity, completion?.grant_jd ?? -Infinity)
    reintakeJd = completion?.reintake_jd ?? null
  } catch { /* 0159/0160 not yet applied — degrade to the conservative 'pending' default below */ }
  const hasCompletion = Number.isFinite(completionJd)
  const reintakeAfter = reintakeJd != null && reintakeJd > completionJd
  const complete = hasCompletion && !reintakeAfter
  return {
    bound: true,
    member_id: member.id,
    home_squad_id: homeId,
    intake_state: complete ? 'complete' : 'pending',
  }
}

function storedTelegramReply(responseText: string): StoredTelegramReplyValue | null {
  try {
    const value = JSON.parse(responseText) as Record<string, unknown> | null
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const bound = value.bound === true
    const memberId = typeof value.member_id === 'string' ? value.member_id : null
    const homeSquadId = typeof value.home_squad_id === 'string' ? value.home_squad_id : null
    const intakeState: IntakeState = value.intake_state === 'complete'
      ? 'complete'
      : value.intake_state === 'pending' ? 'pending' : (bound ? 'pending' : 'none')
    if (value.ok === true && typeof value.reply === 'string') {
      return { ok: true, reply: value.reply, bound, member_id: memberId, home_squad_id: homeSquadId, intake_state: intakeState }
    }
    // Project redemption completes this receipt in its atomic membership batch.
    if (typeof value.member_id === 'string' && typeof value.project_id === 'string'
      && typeof value.squad_id === 'string' && typeof value.capability === 'string') {
      return {
        ok: true, reply: joinedReply(value.project_id), bound: true, member_id: value.member_id,
        // This legacy receipt shape predates home_squad_id/intake_state — a
        // replay of one of these rows reports the conservative unknown
        // state rather than fabricating a home id it never recorded.
        home_squad_id: null, intake_state: 'pending',
      }
    }
  } catch { /* An unreadable result is uncertain, never permission to retry. */ }
  return null
}

// POST /webhook — accept a Telegram-style update, resolve + act, reply.
// Returns { ok, reply, bound, member_id, home_squad_id, intake_state } so the
// Hermes relay can echo `reply` back into the chat AND (mupot-plugin PR #17
// contract) a caller like the first-person skill can read the other four as
// TYPED, server-derived fields — never by string-matching `reply`'s prose,
// and never by deciding "is this member new" locally. We always answer 200
// with a reply string (even for refusals) so the relay has a clear message
// to deliver; transport-level problems are the only non-200s.
imApp.post('/webhook', async (c) => {
  const body = await readCappedBody(c.req.raw, IM_WEBHOOK_MAX_BODY_BYTES)
  if (!body.ok) {
    const status = body.reason === 'too_large' ? 413 : 400
    const error = body.reason === 'too_large' ? 'payload_too_large' : 'invalid_json'
    return c.json({ error }, status)
  }

  // Auth (fail-closed): the webhook must carry the shared secret. Telegram sends
  // the secret_token you registered via setWebhook in this header. Without a
  // configured secret the webhook is sealed — an unauthenticated POST could forge
  // a chat_id and impersonate that member's capabilities over IM.
  if (!c.env.IM_WEBHOOK_SECRET) {
    return c.json({ error: 'webhook_not_configured' }, 503)
  }
  const providedSecret = c.req.header('X-Telegram-Bot-Api-Secret-Token')
  if (!providedSecret || !timingSafeEqual(providedSecret, c.env.IM_WEBHOOK_SECRET)) {
    return c.json({ error: 'unauthorized' }, 401)
  }

  let update: TelegramUpdate
  try {
    update = JSON.parse(body.raw) as TelegramUpdate
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }
  if (!update || typeof update !== 'object' || Array.isArray(update)) return c.json({ error: 'invalid_update' }, 400)
  const chatId = telegramId(update.message?.chat?.id)
  if (!chatId) return c.json({ error: 'no_chat_id' }, 400)
  const userId = telegramId(update.message?.from?.id)
  if (!userId) return c.json({ error: 'no_user_id' }, 400)
  const updateId = telegramId(update.update_id, true)
  if (!updateId) return c.json({ error: 'no_update_id' }, 400)
  if (update.message?.chat?.type !== 'private' || userId !== chatId) {
    return c.json({ error: 'private_chat_required' }, 400)
  }
  const text = typeof update.message?.text === 'string' ? update.message.text : ''
  if (text.length > 4096) return c.json({ error: 'message_too_long' }, 400)
  const forwarding = {
    forward_origin: update.message?.forward_origin !== undefined,
    forward_from: update.message?.forward_from !== undefined,
    forward_from_chat: update.message?.forward_from_chat !== undefined,
    forward_date: update.message?.forward_date !== undefined,
  }
  let digest: string
  try {
    digest = await canonicalJsonDigest({ update_id: updateId, telegram_user_id: userId, chat_id: chatId, text, forwarding })
  } catch {
    return c.json({ error: 'invalid_update' }, 400)
  }
  const identity: TelegramUpdateIdentity = { update_id: updateId, telegram_user_id: userId, request_digest: digest }
  const reservation = await reserveTelegramUpdate(c.env, identity)
  if (!reservation.ok) return c.json({ error: reservation.error }, 409)
  if (reservation.duplicate) {
    const response = storedTelegramReply(reservation.response_text)
    return response ? c.json(response) : c.json({ error: 'update_in_progress' }, 409)
  }
  // Never release or replace the reservation after an uncertain side effect.
  const reply = await handleImMessage(c.env, chatId, text, {
    forwarded: Object.values(forwarding).some(Boolean),
    telegram: identity,
    displayName: telegramDisplayName(update.message?.from),
  })
  // Resolved AFTER handleImMessage so a `/start <code>` that just redeemed an
  // invite in THIS call reports its own new bound state, not a pre-handling
  // snapshot. Read-only — safe to call a second time; the mupot-plugin
  // contract (PR #17) needs bound/member_id/home_squad_id/intake_state as
  // typed fields on every webhook reply, not only /start, so the plugin
  // never has to infer them from `reply`'s prose or decide "is this new"
  // locally.
  const member = await memberForChat(c.env, chatId)
  const envelope = await memberIntakeEnvelope(c.env, member)
  const stored = await completeTelegramUpdate(
    c.env, identity,
    JSON.stringify({ ok: true, reply, ...envelope }),
  )
  const response = stored === null ? null : storedTelegramReply(stored)
  return response ? c.json(response) : c.json({ error: 'update_in_progress' }, 409)
})
