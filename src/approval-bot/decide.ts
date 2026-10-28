// mupot — the approval bot's decision path ("/muapprove").
//
// A tap or a command counts ONLY when every one of these holds; each is enforced HERE or in the shared decision core
// (src/access/decision-core.ts, which every human-proof channel ends in) and each has a test that breaks it:
//   1. the webhook secret matched (routes.ts, before this file is reached);
//   2. the update came from a PRIVATE chat whose id equals the sender's user id (a group, a channel, a forwarded message: no);
//   3. that user id is the bound telegram_chat_id of an ACTIVE HUMAN member (an agent's own binding resolves to nobody);
//   4. the short id names a request the bot actually offered to THAT member, in THAT chat (approval_bot_deliveries);
//   5. the request is pending and inside its decision window, and nobody has decided it (one guarded UPDATE decides);
//   6. the member may decide this request on its scope (the same canDecideElevation predicate as every channel) and is not
//      the principal that made the request.
// Then the elevation is approved or denied with decided_by = the member and decided_via = 'approval_bot', a receipt is
// written, and the human gets the outcome. Nothing the agent wrote ever decides anything: its words are quoted, not parsed.
import type { Env } from '../types'
import { buildAuth, mintApproverSession } from '../access/identity'
import { decideElevation, type Outcome } from '../access/decision-core'
import { listActiveElevationGrants, loadElevationRequestById, type ElevationRequestRecord } from '../auth/elevation'
import { LoginIdentityNotLiveError } from '../auth/web-sessions'
import { resolveTelegramMember } from '../secure-moments/telegram-miniapp-binding'
import { approvalBotStatus } from './config'
import { botMayCarry, decisionBotLabel, parseRequestedActions, SHORT_ID_RE } from './policy'
import { answerCallback, editBotMessage, sendBotMessage, type FetchFn } from './telegram'

export type BotUpdateResult =
  | { kind: 'ignored'; reason: string }
  | { kind: 'refused'; reason: string }
  | { kind: 'approved' | 'denied' | 'revoked' | 'closed' }

export interface BotUpdateOpts {
  fetchFn?: FetchFn
  waitUntil?: (promise: Promise<unknown>) => void
}

/** Telegram ids are positive integers (a chat id equals the user id in a private chat). */
export function telegramId(raw: unknown, allowZero = false): string | null {
  const value = typeof raw === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(raw) ? Number(raw) : typeof raw === 'number' ? raw : NaN
  return Number.isSafeInteger(value) && value >= (allowZero ? 0 : 1) ? String(value) : null
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null // narrowed by the typeof/array checks on the line above
}

interface Parsed {
  kind: 'callback' | 'message'
  updateId: string | null
  fromId: string | null
  chatId: string | null
  chatType: string | null
  callbackId: string | null
  messageId: string | null
  text: string
  forwarded: boolean
}

function parseUpdate(update: unknown): Parsed | null {
  const u = obj(update)
  if (!u) return null
  const updateId = telegramId(u.update_id, true)
  const cq = obj(u.callback_query)
  if (cq) {
    const msg = obj(cq.message)
    const chat = obj(msg?.chat)
    return {
      kind: 'callback', updateId, fromId: telegramId(obj(cq.from)?.id), chatId: telegramId(chat?.id), chatType: typeof chat?.type === 'string' ? chat.type : null,
      callbackId: typeof cq.id === 'string' && cq.id.length > 0 && cq.id.length <= 128 ? cq.id : null,
      messageId: telegramId(msg?.message_id), text: typeof cq.data === 'string' ? cq.data.slice(0, 64) : '', forwarded: false,
    }
  }
  const m = obj(u.message)
  if (!m) return null
  const chat = obj(m.chat)
  return {
    kind: 'message', updateId, fromId: telegramId(obj(m.from)?.id), chatId: telegramId(chat?.id), chatType: typeof chat?.type === 'string' ? chat.type : null,
    callbackId: null, messageId: telegramId(m.message_id), text: typeof m.text === 'string' ? m.text.slice(0, 256) : '',
    forwarded: m.forward_origin !== undefined || m.forward_from !== undefined || m.forward_from_chat !== undefined || m.forward_date !== undefined,
  }
}

type Command = { op: 'approve' | 'deny' | 'revoke'; id: string | null } | { op: 'help' }

function parseCommand(p: Parsed, username: string): Command | null {
  if (p.kind === 'callback') {
    const m = /^(ea|ed):([a-z0-9]{1,16})$/.exec(p.text)
    return m ? { op: m[1] === 'ea' ? 'approve' : 'deny', id: m[2] } : null
  }
  const m = /^\/(muapprove|mudeny|murevoke|muhelp)(?:@([A-Za-z0-9_]+))?(?:\s+([A-Za-z0-9]{1,16}))?\s*$/.exec(p.text.trim())
  if (!m) return null
  // A command addressed to another bot (/muapprove@other_bot) is not ours.
  if (m[2] !== undefined && m[2].toLowerCase() !== username.toLowerCase()) return null
  if (m[1] === 'muhelp') return { op: 'help' }
  return { op: m[1] === 'muapprove' ? 'approve' : m[1] === 'mudeny' ? 'deny' : 'revoke', id: m[3] ?? null }
}

interface Delivery { member_id: string; chat_id: string; message_id: string | null; status: string }

/**
 * The login identity a bot approval's web session anchors to: one of the member's OWN live login identities (the sign-in they
 * already made), newest verified one first. The bot writes NOTHING into human_login_identities: a synthetic row there would count
 * as a login method (unlink guards, login lists) and could be unlinked or abused as one. The grant therefore also dies with that
 * identity (revoking it ends the session). No identity = this member has never signed in: nothing is approved.
 */
async function liveLoginIdentityOf(env: Env, memberId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT id FROM human_login_identities WHERE tenant = ?1 AND member_id = ?2 AND revoked_at IS NULL
      ORDER BY (verified_email IS NOT NULL) DESC, created_at DESC LIMIT 1`,
  ).bind(env.TENANT_SLUG, memberId).first<{ id: string }>()
  return row?.id ?? null
}

/** The approver session a grant binds to: a fresh web session on the member's own login identity; their role is the VERIFIED one. */
async function mintBotApproverSession(env: Env, memberId: string): Promise<{ auth: Awaited<ReturnType<typeof buildAuth>>; webSessionHash: string }> {
  const identityId = await liveLoginIdentityOf(env, memberId)
  if (!identityId) throw new Error('approval_identity_unavailable')
  const session = await mintApproverSession(env, { memberId, auth: await buildAuth(env, memberId, undefined, { verifiedRole: true }), identityId, verifiedRole: true })
  return { auth: session.approver.auth, webSessionHash: session.webSessionHash }
}

const HELP = 'Approval bot. When an agent asks for time-boxed access you get a message with Approve and Deny buttons. You can also reply /muapprove <id> or /mudeny <id>. The id is the request id from this message. Task decisions go to the decision bot. /murevoke ends every live approval you gave (or /murevoke <id> for one).'

/** A /muapprove, /mudeny or /murevoke (optional @bot) that did not parse: extra words, an over-long id, a bad @bot. */
const TRIED_DECISION_RE = /^\/(?:muapprove|mudeny|murevoke)(?:@\S+)?(?=\s|$)/

const ID_ONLY = 'Send the id only: /muapprove <id> or /mudeny <id>. Add any reason on the approval page.'
const START_WELCOME = 'This bot sends you approval requests. When one arrives, tap a button or reply /muapprove <id>.'

function isBareStart(text: string): boolean {
  return /^\/start(?:@[A-Za-z0-9_]+)?$/.test(text)
}

async function routingSentence(env: Env): Promise<string> {
  return `This chat is only for approval requests. Pairing codes and task decisions go to ${await decisionBotLabel(env)}.`
}

export async function handleApprovalBotUpdate(env: Env, update: unknown, opts: BotUpdateOpts = {}): Promise<BotUpdateResult> {
  const bot = approvalBotStatus(env)
  if (bot.state !== 'on') return { kind: 'ignored', reason: 'bot_off' }
  const p = parseUpdate(update)
  if (!p) return { kind: 'ignored', reason: 'not_a_message' }
  const tell = async (text: string, tellOpts: { editMessageId?: string } = {}): Promise<void> => {
    if (!p.chatId) return
    if (p.kind === 'callback' && p.callbackId) await answerCallback(bot, { callbackQueryId: p.callbackId, text }, opts.fetchFn)
    if (p.kind === 'callback' && tellOpts.editMessageId) await editBotMessage(bot, { chatId: p.chatId, messageId: tellOpts.editMessageId, text }, opts.fetchFn)
    else if (p.kind === 'message' || !p.callbackId) await sendBotMessage(bot, { chatId: p.chatId, text }, opts.fetchFn)
  }

  // 2. private chat, sender == chat, not forwarded. A group or channel message gets NO reply (nothing is said where others can read it).
  if (!p.fromId || !p.chatId || p.chatType !== 'private' || p.chatId !== p.fromId) {
    if (p.kind === 'callback' && p.callbackId) await answerCallback(bot, { callbackQueryId: p.callbackId, text: 'Decide in your private chat with this bot.' }, opts.fetchFn)
    return { kind: 'ignored', reason: 'not_private_chat' }
  }
  if (p.forwarded) {
    await tell('A forwarded message cannot decide anything. Type the command yourself.')
    return { kind: 'refused', reason: 'forwarded' }
  }
  const cmd = parseCommand(p, bot.username)
  if (!cmd) {
    if (p.kind === 'message' && p.text.trim().startsWith('/')) {
      const trimmed = p.text.trim()
      // Tried to decide here but the line did not parse. Do not send them to the decision bot.
      if (TRIED_DECISION_RE.test(trimmed)) {
        await tell(ID_ONLY)
        return { kind: 'ignored', reason: 'not_our_command' }
      }
      if (isBareStart(trimmed)) {
        await tell(START_WELCOME)
        return { kind: 'ignored', reason: 'not_our_command' }
      }
      await tell(await routingSentence(env))
      return { kind: 'ignored', reason: 'not_our_command' }
    }
    return { kind: 'ignored', reason: 'not_a_command' }
  }

  // 3. the bound member (unbound, suspended, archived and agent-welded all read the same).
  const who = await resolveTelegramMember(env, p.fromId)
  if (!who.ok) {
    await tell('This Telegram account is not linked to a member who can decide. Link it under My Account (Connect Telegram).')
    return { kind: 'refused', reason: 'not_bound' }
  }
  const memberId = who.memberId
  if (cmd.op === 'help') {
    await tell(HELP)
    return { kind: 'ignored', reason: 'help' }
  }

  if (cmd.op === 'revoke') {
    const requestKey = `approval-bot-revoke:${p.updateId ?? crypto.randomUUID()}:${memberId}`
    let scopeRequest: ElevationRequestRecord | null = null
    if (cmd.id !== null) {
      scopeRequest = SHORT_ID_RE.test(cmd.id) ? await loadByShortId(env, cmd.id) : null
      if (!scopeRequest) {
        await tell('No such request.')
        return { kind: 'refused', reason: 'unknown_request' }
      }
    }
    const revokedMessage = (n: number): string => (n === 0 ? 'Nothing to revoke: you have no live approvals.' : `Revoked ${n} live approval${n === 1 ? '' : 's'}. The agents lost that access now.`)
    // Telegram redelivers an update it did not see acknowledged. A redelivered /murevoke is the SAME revoke: answer what the first
    // run did (its receipt carries the count), and revoke nothing now, so a grant approved in between is never swept by a replay.
    const answerFromPrior = async (): Promise<boolean> => {
      const prior = await env.DB.prepare('SELECT evidence_json FROM mutation_audit_entries WHERE tenant = ?1 AND idempotency_key = ?2 LIMIT 1')
        .bind(env.TENANT_SLUG, requestKey).first<{ evidence_json: string | null }>().catch(() => null)
      if (!prior) return false
      let n = 0
      try { const e: unknown = JSON.parse(prior.evidence_json ?? '{}'); if (typeof e === 'object' && e !== null && typeof (e as { grants_revoked?: unknown }).grants_revoked === 'number') n = (e as { grants_revoked: number }).grants_revoked } catch { /* count stays 0 */ }
      await tell(revokedMessage(n))
      return true
    }
    if (p.updateId !== undefined && p.updateId !== null && (await answerFromPrior())) return { kind: 'revoked' }
    const live = await listActiveElevationGrants(env, env.TENANT_SLUG)
    const mine = live.filter((g) => g.approved_by_member_id === memberId && (scopeRequest === null || g.elevation_request_id === scopeRequest.id))
    // The sweep and immutable replay receipt share ONE transaction. The sweep refuses an existing replay key;
    // the immediately following INSERT records changes() from that single UPDATE, never the stale candidate count.
    // A failed receipt rolls back the sweep. Serialized competing deliveries see the winner's receipt and change nothing.
    const markerId = crypto.randomUUID()
    const nowIso = new Date().toISOString()
    const targetKind = scopeRequest ? 'elevation_request' : 'member'
    const targetId = scopeRequest?.id ?? memberId
    const evidence = JSON.stringify({ via: 'approval_bot', telegram_user_id: p.fromId, request_id: scopeRequest?.id ?? null })
    // JSON keeps the generation-bound candidate list below D1's 100-bind limit even for a large sweep.
    const candidates = JSON.stringify(mine.map((g) => ({ id: g.id, created_at: g.created_at })))
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE elevation_grants SET revoked_at = ?1, revoke_reason = 'revoked_via_approval_bot'
          WHERE tenant = ?2 AND revoked_at IS NULL
            AND EXISTS (SELECT 1 FROM json_each(?4) candidate
                         WHERE json_extract(candidate.value, '$.id') = elevation_grants.id
                           AND json_extract(candidate.value, '$.created_at') = elevation_grants.created_at)
            AND NOT EXISTS (SELECT 1 FROM mutation_audit_entries WHERE tenant = ?2 AND idempotency_key = ?3)`,
      ).bind(nowIso, env.TENANT_SLUG, requestKey, candidates),
      env.DB.prepare(
        `INSERT INTO mutation_audit_entries (
           id, tenant, principal_kind, principal_id, member_id, origin, handler, operation,
           target_kind, target_id, request_id, idempotency_key, evidence_json, recorded_at)
         VALUES (?1, ?2, 'member', ?3, ?3, 'admin_ui', 'approval_bot', 'elevation_revoke', ?4, ?5, ?6, ?6,
                 json_set(?7, '$.grants_revoked', changes()), ?8)
         ON CONFLICT DO NOTHING`,
      ).bind(markerId, env.TENANT_SLUG, memberId, targetKind, targetId, requestKey, evidence, nowIso),
    ])
    if (Number(results[1]?.meta?.changes ?? 0) !== 1) {
      if (await answerFromPrior()) return { kind: 'revoked' }
      throw new Error('revoke_marker_missing')
    }
    const revoked = Number(results[0]?.meta?.changes ?? 0)
    await tell(revokedMessage(revoked))
    return { kind: 'revoked' }
  }

  // 4. the request the bot offered to THIS member in THIS chat.
  if (cmd.id === null || !SHORT_ID_RE.test(cmd.id)) {
    await tell(`Name the request: /${cmd.op === 'approve' ? 'muapprove' : 'mudeny'} <id> (the id is in the request message).`)
    return { kind: 'refused', reason: 'id_missing' }
  }
  const req = await loadByShortId(env, cmd.id)
  const delivery = req ? await env.DB.prepare('SELECT member_id, chat_id, message_id, status FROM approval_bot_deliveries WHERE request_id = ?1 AND tenant = ?2 LIMIT 1').bind(req.id, env.TENANT_SLUG).first<Delivery>() : null
  if (!req || !delivery || delivery.status !== 'sent' || delivery.member_id !== memberId || delivery.chat_id !== p.fromId) {
    await tell('No such pending request for you.')
    return { kind: 'refused', reason: 'unknown_request' }
  }
  // A button belongs to the message that carries it: a callback from any other message is not this request's button.
  if (p.kind === 'callback' && delivery.message_id !== null && p.messageId !== delivery.message_id) {
    await tell('That button is not for this request.')
    return { kind: 'refused', reason: 'wrong_message' }
  }
  const editId = p.kind === 'callback' && delivery.message_id !== null ? delivery.message_id : undefined
  if (cmd.op === 'approve' && !botMayCarry(req)) {
    await tell('This request needs a stronger approval than a Telegram tap. Open the approval link instead.')
    return { kind: 'refused', reason: 'not_bot_approvable' }
  }

  // 5-6. the shared decision core re-checks window, status, authority, self-approval and writes the receipt. Its own guarded
  // UPDATE is the single decision: a replay, a second tap and a concurrent decision all lose there.
  if (!(await liveLoginIdentityOf(env, memberId))) {
    await tell('Sign in to the dashboard once (any login method) so your approvals have a session, then try again.', { editMessageId: editId })
    return { kind: 'refused', reason: 'no_login_identity' }
  }
  const auth = await buildAuth(env, memberId, undefined, { verifiedRole: true })
  let outcome: Outcome
  try {
    outcome = await decideElevation(env, {
      id: req.id, decision: cmd.op, selectedActions: parseRequestedActions(req), durationMinutes: undefined, auth,
      proof: { memberId, via: 'approval_bot', evidence: { telegram_user_id: p.fromId, chat_id: p.chatId, short_id: cmd.id, ...(p.updateId ? { update_id: p.updateId } : {}), ...(p.messageId ? { message_id: p.messageId } : {}) } },
      mintSession: () => mintBotApproverSession(env, memberId),
      waitUntil: opts.waitUntil,
    })
  } catch (err) {
    // The sign-in this approval anchors to was revoked after the check above and before the session could be written: nothing was
    // decided (the session insert is conditional on the identity being live), so say why instead of a generic failure (#2106).
    if (err instanceof LoginIdentityNotLiveError) {
      await tell('Sign in to the dashboard once (any login method) so your approvals have a session, then try again.', { editMessageId: editId })
      return { kind: 'refused', reason: 'no_login_identity' }
    }
    await tell('The decision could not be recorded. Nothing was changed.', { editMessageId: editId })
    return { kind: 'refused', reason: 'decision_error' }
  }
  if (outcome.status === 200) {
    await tell(`${cmd.op === 'approve' ? 'Approved' : 'Denied'} ${cmd.id}. ${outcome.message}`, { editMessageId: editId })
    return { kind: cmd.op === 'approve' ? 'approved' : 'denied' }
  }
  const closed = outcome.status === 410 || (outcome.status === 409 && outcome.title === 'Request closed')
  await tell(closed ? `Request ${cmd.id} is closed: ${outcome.message}` : `Not decided: ${outcome.message}`, closed ? { editMessageId: editId } : {})
  return closed ? { kind: 'closed' } : { kind: 'refused', reason: `core_${outcome.status}` }
}

async function loadByShortId(env: Env, shortId: string): Promise<ElevationRequestRecord | null> {
  const row = await env.DB.prepare('SELECT id FROM elevation_requests WHERE tenant = ?1 AND short_id = ?2 LIMIT 1').bind(env.TENANT_SLUG, shortId).first<{ id: string }>()
  return row ? loadElevationRequestById(env, env.TENANT_SLUG, row.id) : null
}

