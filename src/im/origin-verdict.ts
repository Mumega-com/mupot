// mupot#1424 slice — harness-attested human origin for task_verdict.
//
// The class of problem (Hadi, direct, 2026-09-16): today a human decides over
// Telegram only via the raw `/im/webhook` update. The next shape is a human
// talking to their OWN agent (KayHermes) in natural language; the HARNESS
// (never the LLM) stamps the message's origin onto the agent's mupot calls;
// mupot resolves that origin to the member and writes the verdict AS the
// member. No origin, or an origin that does not resolve, and the call runs
// under the agent's own seat only — unchanged from today. One call, two
// authorities.
//
// This module is the ONE place that resolution happens, called from
// task_verdict's MCP/actions handler (src/mcp/index.ts) — never re-derived
// per call site, same discipline as evaluateVerdictGates
// (src/tasks/index.ts) being the one shared verdict-gate predicate.
//
// Trust boundary, stated plainly (also see docs/architecture/
// human-decision-channel-contract.md, "Harness-attested origin"): the HARNESS
// is the attestation boundary. mupot trusts a stamp only because (a) the
// agent seat is owned by the resolved member (agents.owner_member_id), (b)
// the member is bound to that exact chat, and (c) the message is FRESH and
// UNREPLAYED. mupot cannot itself distinguish a harness-stamped human_origin
// from one a model typed into its own tool call — it never sees the raw
// Telegram update, only the stamp — so every defense that IS server-checkable
// is enforced here, not merely assumed of the harness: a plugin-side gate can
// silently no-op (older Hermes, native_gateway off) and must never be the
// only boundary. A compromised harness can therefore forge AT MOST one
// verdict per fresh, unreplayed message from its owner's own chat — the same
// blast radius as the owner's own Telegram client sending that one message.
// It can never impersonate a DIFFERENT member, never replay one message
// twice, never reach back into stale context to mint a decision from an old
// message, and never burst more than one applied decision per chat per
// window (see FRESHNESS/RATE_LIMIT below).
//
// Every conjunct below is re-checked at call time (no caching across calls):
// caller is agent-bound; the agent has an owner; the owner is active; the
// origin is a well-formed, private-chat-shaped, FRESH Telegram identity; the
// origin resolves to (or first-binds) that SAME member; the member is not
// the assignee's owner (conflict of interest, memberOwnsAssigneeAgent — a
// DIFFERENT, agent_keys-based ownership fact, deliberately not conflated with
// agents.owner_member_id, see the field comment on Agent.owner_member_id in
// src/types.ts); the origin message has not already cast a decision; and
// this (agent, chat) pair has not already applied a decision within the rate
// window. ANY conjunct false falls back to the calling agent's own
// authority — this module never raises for that; the ONLY hard failures are
// the two the caller (task_verdict) must itself refuse the whole request
// for: a non-agent-bound caller supplying human_origin at all, and a
// replayed origin message.

import type { AuthContext, Env, Member } from '../types'
import { resolveCapabilities } from '../auth/capability'
import { canonicalJsonDigest } from '../lib/canonical-json'
import { MEMBER_BIND_ELIGIBLE_SQL } from '../members/project-invites'
import { memberAuth, memberForChat, memberOwnsAssigneeAgent, telegramId } from './index'
import { completeTelegramUpdate, reserveTelegramUpdate, type TelegramUpdateIdentity } from './telegram-receipts'

export interface HumanOriginInput {
  channel: 'telegram'
  user_id: string
  chat_id: string
  message_id: string
  message_at: string
}

export type HumanOriginFailureReason =
  | 'invalid_origin_shape'
  | 'origin_stale'
  | 'agent_not_owned'
  | 'member_inactive'
  | 'origin_member_mismatch'
  | 'chat_already_bound'
  | 'member_not_eligible'
  | 'assignee_conflict'
  | 'origin_rate_limited'

export type HumanOriginResolution =
  | { replayed: true }
  | { replayed: false; applied: true; member: Member; auth: AuthContext; boundNow: boolean }
  | { replayed: false; applied: false; reason: HumanOriginFailureReason }

interface OriginTaskRef {
  assignee_agent_id: string | null
}

// Freshness window (server-checkable defense against a stale stamp reused
// out of context — the model retaining an old message_at/chat_id/message_id
// triple from earlier in its context and replaying it to mint a NEW
// decision on a NEW task, which the replay reservation alone cannot catch
// since a different task_id/verdict produces a different digest). A real
// human message is decided on within minutes, not replayed hours later.
const FRESHNESS_MAX_AGE_MS = 10 * 60 * 1000 // 10 minutes old
const FRESHNESS_MAX_FUTURE_MS = 60 * 1000 // 60 seconds ahead of server clock

// Per-(agent, chat) rate window — bounds a compromised or buggy harness to
// at most one APPLIED harness-attested verdict per chat per window, even
// across DISTINCT, individually fresh, individually unreplayed messages.
const RATE_LIMIT_WINDOW_MS = 30 * 1000

// Validation strictness mirrors the IM webhook path (src/im/index.ts):
// digit-only immutable ids (telegramId, the SAME validator the real webhook
// uses — no second copy of "what is a valid Telegram id"), and the identical
// private-chat invariant `/im/webhook` assumes (message.from.id ===
// message.chat.id): a harness relaying a GROUP chat, or lying about who sent
// what, cannot be told apart from a private DM by mupot — the invariant this
// module can actually check is "the claimed sender IS the claimed chat",
// exactly as the real webhook checks it. message_at is REQUIRED (not
// optional) — freshness cannot be checked against a timestamp the caller may
// omit.
type ParsedOrigin =
  | { ok: true; value: HumanOriginInput }
  | { ok: false; reason: 'invalid_origin_shape' | 'origin_stale' }

function parseHumanOrigin(raw: unknown, now: number = Date.now()): ParsedOrigin {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'invalid_origin_shape' }
  }
  const obj = raw as Record<string, unknown>
  if (obj.channel !== 'telegram') return { ok: false, reason: 'invalid_origin_shape' }
  const userId = telegramId(obj.user_id)
  const chatId = telegramId(obj.chat_id)
  const messageId = telegramId(obj.message_id)
  if (!userId || !chatId || !messageId) return { ok: false, reason: 'invalid_origin_shape' }
  if (userId !== chatId) return { ok: false, reason: 'invalid_origin_shape' } // private-chat invariant
  if (typeof obj.message_at !== 'string') return { ok: false, reason: 'invalid_origin_shape' }
  const messageAtMs = new Date(obj.message_at).getTime()
  if (Number.isNaN(messageAtMs)) return { ok: false, reason: 'invalid_origin_shape' }

  const age = now - messageAtMs
  if (age > FRESHNESS_MAX_AGE_MS || age < -FRESHNESS_MAX_FUTURE_MS) {
    return { ok: false, reason: 'origin_stale' }
  }

  return {
    ok: true,
    value: { channel: 'telegram', user_id: userId, chat_id: chatId, message_id: messageId, message_at: obj.message_at },
  }
}

function isUniqueViolationOn(error: unknown, column: string): boolean {
  return error instanceof Error && new RegExp(`UNIQUE constraint failed: .*${column}`, 'i').test(error.message)
}

/**
 * Resolve a harness-attested `human_origin` into the member's own AuthContext,
 * or a named reason it does not apply. `boundAgentId` is the CALLING agent
 * (auth.boundAgentId) — the caller (task_verdict) must have already confirmed
 * this is set before calling here; a null/undefined boundAgentId is a caller
 * bug, not a resolvable outcome of this function.
 */
export async function resolveHarnessAttestedOrigin(
  env: Env,
  boundAgentId: string,
  rawOrigin: unknown,
  taskId: string,
  verdict: 'approved' | 'rejected',
  task: OriginTaskRef,
): Promise<HumanOriginResolution> {
  const parsed = parseHumanOrigin(rawOrigin)
  if (!parsed.ok) return { replayed: false, applied: false, reason: parsed.reason }
  const origin = parsed.value

  // ── replay reservation FIRST — one decision per origin message, enforced
  // BEFORE the first-bind step too (a leaked/stale stamp cannot mint a
  // binding any more than it can mint a verdict) ──────────────────────────
  // Reuses telegram_webhook_receipts (0152) verbatim via reserveTelegramUpdate
  // / completeTelegramUpdate, keyed on a synthetic `update_id` — that column
  // is unconstrained TEXT (no format CHECK), so this composite key fits the
  // existing PRIMARY KEY (tenant, update_id) fence with no schema change. The
  // digest binds the origin to THIS exact (task_id, verdict) pair: a second
  // origin message deciding a DIFFERENT task, or the same task with a
  // different verdict, is a different digest and therefore a different
  // decision, not a replay of this one.
  const updateId = `origin:telegram:${origin.chat_id}:${origin.message_id}`
  const digest = await canonicalJsonDigest({
    chat_id: origin.chat_id,
    user_id: origin.user_id,
    message_id: origin.message_id,
    task_id: taskId,
    verdict,
  })
  const identity: TelegramUpdateIdentity = { update_id: updateId, telegram_user_id: origin.user_id, request_digest: digest }
  const reservation = await reserveTelegramUpdate(env, identity)
  // Any non-fresh reservation — an exact-match retry (reservation.duplicate)
  // or a conflicting one (different digest / still processing) — is a
  // replay for this caller's purposes: task_verdict does NOT reuse a cached
  // response the way the Telegram webhook itself does (that idempotency is
  // for a redelivered TRANSPORT event; here two calls naming the same origin
  // message is always a bug or an attack, never a legitimate retry the tool
  // should paper over). "One decision per origin message" means exactly one
  // attempt at resolution, full stop.
  if (!reservation.ok || reservation.duplicate) {
    return { replayed: true }
  }

  // ── per-(agent, chat) rate limit ─────────────────────────────────────────
  // Bounds a burst of DISTINCT, individually fresh, individually unreplayed
  // messages to at most one APPLIED decision per window — the replay
  // reservation above only ever catches the SAME message reused, not many
  // different real messages fired in quick succession. Checked against
  // task_verdicts (no new table): every APPLIED harness-attested verdict
  // already stamps origin_agent_id and, via decided_by, a member whose
  // telegram_chat_id names the chat — cheap, indexed, no separate ledger.
  if (await recentAppliedOriginExists(env, boundAgentId, origin.chat_id, now())) {
    const outcome: HumanOriginResolution = { replayed: false, applied: false, reason: 'origin_rate_limited' }
    await completeTelegramUpdate(env, identity, JSON.stringify(redactedOutcome(outcome)))
    return outcome
  }

  const outcome = await resolveOwnedMemberOrigin(env, boundAgentId, origin, task)
  await completeTelegramUpdate(env, identity, JSON.stringify(redactedOutcome(outcome)))
  return outcome
}

function now(): number {
  return Date.now()
}

async function recentAppliedOriginExists(env: Env, agentId: string, chatId: string, nowMs: number): Promise<boolean> {
  const cutoff = new Date(nowMs - RATE_LIMIT_WINDOW_MS).toISOString()
  const row = await env.DB.prepare(
    `SELECT 1
       FROM task_verdicts v
       JOIN members m ON m.id = v.decided_by
      WHERE v.origin_agent_id = ?1
        AND v.decided_via = 'agent_attested_origin'
        AND m.telegram_chat_id = ?2
        AND v.decided_at > ?3
      LIMIT 1`,
  ).bind(agentId, chatId, cutoff).first<{ 1: number }>()
  return row !== null
}

function redactedOutcome(outcome: HumanOriginResolution): Record<string, unknown> {
  if (outcome.replayed) return { replayed: true }
  if (outcome.applied) return { applied: true, member_id: outcome.member.id, bound_now: outcome.boundNow }
  return { applied: false, reason: outcome.reason }
}

async function resolveOwnedMemberOrigin(
  env: Env,
  boundAgentId: string,
  origin: HumanOriginInput,
  task: OriginTaskRef,
): Promise<HumanOriginResolution> {
  // (2) the calling agent must be OWNED by a member — agents.owner_member_id
  // (0155), re-read fresh every call, never cached across a session.
  const agentRow = await env.DB.prepare('SELECT owner_member_id FROM agents WHERE id = ?')
    .bind(boundAgentId)
    .first<{ owner_member_id: string | null }>()
  const ownerMemberId = agentRow?.owner_member_id ?? null
  if (!ownerMemberId) return { replayed: false, applied: false, reason: 'agent_not_owned' }

  const owner = await env.DB.prepare(
    `SELECT id, email, display_name, telegram_chat_id, status, created_at
       FROM members WHERE id = ?1 AND tenant = ?2 LIMIT 1`,
  ).bind(ownerMemberId, env.TENANT_SLUG).first<Member>()
  if (!owner || owner.status !== 'active') {
    return { replayed: false, applied: false, reason: 'member_inactive' }
  }

  let boundNow = false
  if (owner.telegram_chat_id === null) {
    // (4) FIRST-BIND BY ORIGIN — no invite, no button (Hadi, direct,
    // 2026-09-16): the owning member has no Telegram identity bound yet, and
    // this agent's own owner_member_id is the authority for binding it, in
    // this same request, before resolving the verdict. Reuses
    // MEMBER_BIND_ELIGIBLE_SQL verbatim (the SAME predicate the invite-claim
    // bind path uses, src/members/project-invites.ts) so this bind and that
    // one can never drift into checking different member facts — status
    // active, exact non-NULL tenant match, telegram_chat_id NULL-or-already-
    // this-value.
    try {
      // Plain `?` throughout, matching MEMBER_BIND_UPDATE_SQL's own placeholder
      // style byte for byte (never mixed with MEMBER_BIND_ELIGIBLE_SQL's own
      // plain `?`s — numbered and unnumbered placeholders in the same
      // statement bind unpredictably).
      const result = await env.DB.prepare(
        `UPDATE members
            SET telegram_chat_id = ?, telegram_bound_at = ?
          WHERE ${MEMBER_BIND_ELIGIBLE_SQL}`,
      ).bind(origin.chat_id, claimTimestamp(), owner.id, env.TENANT_SLUG, origin.chat_id).run()
      if (result.meta.changes !== 1) {
        // 0 rows: MEMBER_BIND_ELIGIBLE_SQL failed. Disambiguate: a
        // concurrent change since the read above, most likely a DIFFERENT
        // chat_id already bound to this exact member (mismatch) or the
        // member having gone inactive/cross-tenant in the interim
        // (member_not_eligible) — never rebind, never guess.
        const fresh = await env.DB.prepare('SELECT telegram_chat_id, status FROM members WHERE id = ?')
          .bind(owner.id)
          .first<{ telegram_chat_id: string | null; status: string }>()
        if (fresh?.telegram_chat_id && fresh.telegram_chat_id !== origin.chat_id) {
          return { replayed: false, applied: false, reason: 'origin_member_mismatch' }
        }
        return { replayed: false, applied: false, reason: 'member_not_eligible' }
      }
      boundNow = true
      await env.DB.prepare(
        `INSERT INTO telegram_origin_bind_receipts (id, tenant, member_id, agent_id, chat_id, message_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), env.TENANT_SLUG, owner.id, boundAgentId, origin.chat_id, origin.message_id, new Date().toISOString()).run()
    } catch (err) {
      // Another member already holds this exact chat_id (members.telegram_chat_id
      // is UNIQUE, migration 0002) — never overwrite someone else's binding.
      if (isUniqueViolationOn(err, 'telegram_chat_id')) {
        return { replayed: false, applied: false, reason: 'chat_already_bound' }
      }
      throw err
    }
  } else if (owner.telegram_chat_id !== origin.chat_id) {
    // (3) never rebind an already-bound member to a DIFFERENT chat — the
    // origin claims to be someone this member demonstrably is not.
    return { replayed: false, applied: false, reason: 'origin_member_mismatch' }
  }

  // (5) resolve via the SAME helper the IM path uses (memberForChat) — proves
  // this bind (or pre-existing bind) reads back exactly the way /approve etc.
  // over the real Telegram webhook would see it, not merely that our own
  // write believes it landed.
  const resolved = await memberForChat(env, origin.chat_id)
  if (!resolved || resolved.id !== owner.id) {
    return { replayed: false, applied: false, reason: 'origin_member_mismatch' }
  }

  // (7)-(8) fresh capabilities, role forced 'member' — through memberAuth,
  // the SAME helper the IM path builds its AuthContext with. Not re-derived.
  const grants = await resolveCapabilities(env, resolved.id)

  // Conflict of interest — memberOwnsAssigneeAgent (agent_keys), UNCHANGED
  // and NOT conflated with agents.owner_member_id above: this asks whether
  // the resolving member owns the TASK'S ASSIGNEE agent (which may be a
  // different agent than the one that made this call), the same guard IM's
  // verdictReply layers on top of evaluateVerdictGates.
  if (await memberOwnsAssigneeAgent(env, resolved.id, task.assignee_agent_id)) {
    return { replayed: false, applied: false, reason: 'assignee_conflict' }
  }

  const auth = memberAuth(env, resolved, grants)
  return { replayed: false, applied: true, member: resolved, auth, boundNow }
}

function claimTimestamp(): string {
  const iso = new Date().toISOString()
  const random = new Uint32Array(1)
  crypto.getRandomValues(random)
  const suffix = String(random[0] % 1_000_000).padStart(6, '0')
  return iso.replace('Z', `${suffix}Z`)
}
