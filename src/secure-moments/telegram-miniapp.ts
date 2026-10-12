// mupot — /m/tg/*: the Telegram Mini App adapter for secure moments (W4). Contract: docs/architecture/secure-moments.md.
//
// FLOW OF TRUST (every JSON request):
//   flag on + dedicated host (the host gate and routes.ts's gate already ran) -> same-origin JSON ->
//   `init_data` verified (Ed25519 third-party signature over "<our bot id>:WebAppData\n..."; no bot token is involved
//   in validation), fresh, private-chat -> the signed Telegram user id maps to an
//   ACTIVE HUMAN member through members.telegram_chat_id (never an agent's welded row; never bound here) ->
//   moment live + kind the Mini App may decide + that member's CURRENT authority re-derived -> step-up policy
//   (a sensitive elevation action needs a passkey, not Telegram) -> a single-use server nonce bound to
//   (moment, decision, parameters, member, Telegram user) -> the biometric-unlocked DEVICE SECRET of exactly that
//   member and Telegram user (verified BEFORE the nonce is spent; a retired secret revokes the device) -> ONE guarded consume
//   that also ROTATES the secret -> the shared decision core (via 'telegram_miniapp').
// The Mini App bot is DEDICATED and only the worker holds its token: the worker itself sends the button (telegram-miniapp-send.ts).
// initData alone decides nothing; the device secret alone decides nothing; the moment id is not a bearer.
// No cookie is ever set. No secret is ever taken from Telegram chat text (credential moments are refused here).
import type { Context, Next } from 'hono'
import type { Hono } from 'hono'
import type { AuthContext, Env } from '../types'
import { secureOrigin } from './config'
import { buildAuth, mintApproverSession } from '../access/identity'
import { escapeHtml, renderPage } from '../access/page'
import { loadSeedRequest, seedRequestIsLive, type SeedRequestRow } from '../access/seed-request'
import {
  closedSeedOutcome, decideElevation, decideSeed, elevationIsLive, elevationViewInner, mayDecideElevation, mayDecideSeed,
  seedViewInner, type HumanProof, type Outcome, type WaitUntil,
} from '../access/decision-core'
import { loadElevationRequestById, type ElevationRequestRecord } from '../auth/elevation'
import { ELEVATION_ACTIONS, SENSITIVE_STEP_UP_ACTIONS } from '../auth/elevation-actions'
import { loadMoment, momentIsLive, type MomentRow } from './store'
import { hex, sha256 } from './webauthn'
import { verifyInitData } from './telegram-initdata'
import {
  acceptedPublicKeys, miniappMaxAgeSeconds, telegramMiniappStatus, TELEGRAM_WEBAPP_SCRIPT_URL,
} from './telegram-miniapp-config'
import {
  confirmDeviceEnrolment, consumeMomentTelegram, consumeTgNonce, loadTgEnrolmentToken, memberHasActiveDevice, mintTgNonce, recordTgAudit,
  resolveDeviceForDecision, startDeviceEnrolment, tgEnrolmentTokenIsLive, type TgEnrolmentTokenRow,
} from './telegram-miniapp-store'
import { resolveTelegramMember } from './telegram-miniapp-binding'
import { TG_SCRIPT } from './telegram-miniapp-client'

// Structurally identical to routes.ts's AppEnv (not imported: routes.ts imports THIS module to mount it).
type AppEnv = { Bindings: Env; Variables: { host: string; nonce: string } }
type C = Context<AppEnv>

const MAX_BODY_BYTES = 16 * 1024
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
/** chat_type values that mean "a private chat with this user"; anything else (group, supergroup, channel) is refused. */
const PRIVATE_CHAT_TYPES: ReadonlySet<string> = new Set(['sender', 'private'])

type HttpStatus = 200 | 400 | 403 | 404 | 409 | 410 | 503

function waitUntilOf(c: C): WaitUntil | undefined {
  try {
    const ctx = c.executionCtx
    return (p) => ctx.waitUntil(p)
  } catch {
    return undefined
  }
}

/** Headers for the two Mini App PAGES. script-src is the nonce plus Telegram's ONE script URL: no other page gets it. */
function pageHeaders(c: C): void {
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'same-origin')
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('Content-Security-Policy',
    `default-src 'none'; script-src 'nonce-${c.get('nonce')}' ${TELEGRAM_WEBAPP_SCRIPT_URL}; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`)
}

function jsonOut(c: C, status: HttpStatus, body: Record<string, unknown>): Response {
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'same-origin')
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
  return c.json(body, status)
}

const fail = (c: C, status: HttpStatus, message: string, title = 'Refused', extra: Record<string, unknown> = {}): Response =>
  jsonOut(c, status, { ok: false, title, message, ...extra })
const notFound = (c: C): Response => fail(c, 404, 'There is nothing here for you.', 'Not found')
const outcomeJson = (c: C, o: Outcome): Response => jsonOut(c, o.status, { ok: o.status === 200, title: o.title, message: o.message })

type JsonBody = Record<string, unknown>

/** POST preconditions: same-origin (exact Origin), JSON body, bounded size. (No cookie exists here, so this is hygiene, not the auth.) */
async function jsonGuard(c: C): Promise<{ ok: true; body: JsonBody } | { ok: false; res: Response }> {
  const origin = c.req.header('origin')
  const site = c.req.header('sec-fetch-site')
  if (origin !== secureOrigin(c.get('host')) || (site !== undefined && site !== 'same-origin')) {
    return { ok: false, res: fail(c, 403, 'Cross-origin request refused.') }
  }
  if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return { ok: false, res: fail(c, 400, 'Expected a JSON body.', 'Bad request') }
  }
  const text = await c.req.text()
  if (text.length > MAX_BODY_BYTES) return { ok: false, res: fail(c, 400, 'Body too large.', 'Bad request') }
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
    return { ok: true, body: parsed as JsonBody } // as: just narrowed to a plain object; every field is read as unknown below
  } catch {
    return { ok: false, res: fail(c, 400, 'Unreadable body.', 'Bad request') }
  }
}

// ── identity: initData -> Telegram user -> member ───────────────────────────────────────────────────
interface TgIdentity {
  memberId: string
  telegramUserId: string
  startParam: string | null
  method: 'ed25519'
}

const INITDATA_MESSAGES: Record<string, string> = {
  stale: 'This Telegram session is too old. Close this page and open it again from the bot.',
  future: 'This Telegram session is dated in the future. Check your device clock, then open it again from the bot.',
  signature_required: 'This Telegram client did not sign the launch data (it needs Telegram with Bot API 8.0 or newer). Update Telegram and open this page again from the bot.',
}

/** Verify the signed launch data and resolve the member; the ONLY door to every other handler. */
async function authenticateTelegram(c: C, body: JsonBody): Promise<{ ok: true; id: TgIdentity } | { ok: false; res: Response }> {
  const status = telegramMiniappStatus(c.env)
  if (status.state !== 'on') return { ok: false, res: notFound(c) }
  const v = await verifyInitData(body.init_data, {
    botId: status.botId,
    publicKeysHex: acceptedPublicKeys(c.env),
    nowMs: Date.now(),
    maxAgeSeconds: miniappMaxAgeSeconds(c.env),
  })
  if (!v.ok) {
    return { ok: false, res: fail(c, 403, INITDATA_MESSAGES[v.reason] ?? `Telegram's signed data could not be verified (${v.reason}). Close this page and open it again from the bot.`, 'Telegram sign-in failed') }
  }
  // Private-chat semantics (the #1425 fence): a launch from a group or channel is refused, whoever signed it.
  if (v.data.chatType !== null && !PRIVATE_CHAT_TYPES.has(v.data.chatType)) {
    return { ok: false, res: fail(c, 403, 'Open this from your private chat with the bot, not from a group or channel.', 'Private chat only') }
  }
  const member = await resolveTelegramMember(c.env, v.data.userId)
  if (!member.ok) {
    return {
      ok: false,
      res: member.reason === 'unbound'
        ? fail(c, 403, 'This Telegram account is not linked to a member of this workspace. Sign in to the dashboard, open My Account, use Connect Telegram, then open this page again.', 'Telegram account not linked')
        : fail(c, 403, 'The member linked to this Telegram account cannot decide requests.', 'Not eligible'),
    }
  }
  return { ok: true, id: { memberId: member.memberId, telegramUserId: v.data.userId, startParam: v.data.startParam, method: v.data.method } }
}

// ── moments: what is decidable, by whom ─────────────────────────────────────────────────────────────
export type Subject =
  | { kind: 'seed_attach'; row: SeedRequestRow }
  | { kind: 'elevation'; req: ElevationRequestRecord }

export async function loadLiveSubject(env: Env, m: MomentRow, nowMs: number): Promise<Subject | null> {
  if (m.kind === 'seed_attach') {
    const row = await loadSeedRequest(env, m.subject_id)
    return row && seedRequestIsLive(row, nowMs) ? { kind: 'seed_attach', row } : null
  }
  if (m.kind === 'elevation') {
    const req = await loadElevationRequestById(env, env.TENANT_SLUG, m.subject_id)
    return req && elevationIsLive(req, nowMs) ? { kind: 'elevation', req } : null
  }
  return null
}

async function closedResponse(c: C, m: MomentRow): Promise<Response> {
  if (m.kind === 'seed_attach') {
    const row = await loadSeedRequest(c.env, m.subject_id)
    if (row && row.status === 'applied') return outcomeJson(c, closedSeedOutcome(row))
  }
  return fail(c, 409, 'This request is no longer pending.', 'Request closed')
}

const CREDENTIAL_REFUSAL = 'This request carries a secret. Never send one through Telegram: open it on a browser with a passkey.'

interface Decidable { m: MomentRow; subject: Subject; auth: AuthContext }

/**
 * The moment, only while IT and its request are live, of a kind the Mini App may decide, addressed to this member (or
 * to anyone), and one whose decision THIS member has the authority for right now. Unknown and out-of-authority read
 * identically (404). A credential moment is refused with its own message.
 */
async function loadDecidable(c: C, memberId: string, momentId: unknown): Promise<{ ok: true; d: Decidable } | { ok: false; res: Response }> {
  if (typeof momentId !== 'string' || !UUID_RE.test(momentId)) return { ok: false, res: notFound(c) }
  const m = await loadMoment(c.env, momentId)
  if (!m) return { ok: false, res: notFound(c) }
  if (m.kind !== 'seed_attach' && m.kind !== 'elevation') return { ok: false, res: fail(c, 409, CREDENTIAL_REFUSAL, 'Use a passkey') }
  if (m.decider_member_id !== null && m.decider_member_id !== memberId) return { ok: false, res: notFound(c) }
  const now = Date.now()
  if (!momentIsLive(m, now)) return { ok: false, res: await closedResponse(c, m) }
  const subject = await loadLiveSubject(c.env, m, now)
  if (!subject) return { ok: false, res: await closedResponse(c, m) }
  const auth = await buildAuth(c.env, memberId)
  const allowed = subject.kind === 'seed_attach' ? mayDecideSeed(auth) : await mayDecideElevation(c.env, auth, subject.req)
  if (!allowed) return { ok: false, res: notFound(c) }
  return { ok: true, d: { m, subject, auth } }
}

// ── parameters + step-up policy ─────────────────────────────────────────────────────────────────────
interface Params {
  decision: 'approve' | 'deny'
  actions: string[]
  duration: number | undefined
}

/** What the human chose, canonicalised: a deny carries no parameters; an elevation approve carries the narrowed grant. */
function readParams(m: MomentRow, body: JsonBody): Params | null {
  const decision = body.decision
  if (decision !== 'approve' && decision !== 'deny') return null
  let actions: string[] = []
  let duration: number | undefined
  if (m.kind === 'elevation' && decision === 'approve') {
    const raw = body.actions
    if (!Array.isArray(raw) || raw.length > 32 || !raw.every((a) => typeof a === 'string' && a.length > 0 && a.length <= 100)) return null
    actions = [...new Set(raw as string[])].sort() // as: every element was just checked to be a string
    const d = body.duration_minutes
    if (typeof d === 'number' && Number.isInteger(d) && d > 0 && d < 100000) duration = d
    else if (typeof d === 'string' && /^\d{1,5}$/.test(d) && Number(d) > 0) duration = Number(d)
    else if (d !== undefined && d !== null) return null
  }
  return { decision, actions, duration }
}

export const PASSKEY_REQUIRED_MESSAGE = 'Granting a sensitive action needs a passkey, which is stronger than Telegram. Untick the sensitive actions here, or open this request on a browser with a passkey.'

/**
 * Telegram's OWN additions to the passkey-only list, beside SENSITIVE_STEP_UP_ACTIONS (which the dashboard uses for its
 * recent-reauth rule and which this channel must not redefine). `action:home_access` reaches a member's private home
 * squad: the dashboard does not demand a fresh reauth for it, but a client-attested device secret is too weak a proof
 * for it, so the Mini App refuses it and sends the human to a passkey.
 */
export const TELEGRAM_PASSKEY_ONLY_EXTRA: ReadonlySet<string> = new Set(['action:home_access'])

/** True when this action must NOT be granted through Telegram: sensitive, Telegram-extra, or not a known action at all. */
function passkeyOnly(action: string): boolean {
  return !Object.prototype.hasOwnProperty.call(ELEVATION_ACTIONS, action) || SENSITIVE_STEP_UP_ACTIONS.has(action) || TELEGRAM_PASSKEY_ONLY_EXTRA.has(action)
}

/**
 * THE step-up policy. Telegram's biometric-unlocked device secret is attested only by the Telegram client, so it is
 * accepted for a seed attach, for any DENY, and for an elevation APPROVE whose every selected action is KNOWN and not
 * in SENSITIVE_STEP_UP_ACTIONS (the existing sensitivity classification). An unknown action is refused here too
 * (an allowlist, not a denylist). Returns the refusal message, or null when Telegram may carry this decision.
 */
export function telegramPolicyRefusal(kind: MomentRow['kind'], p: Params): string | null {
  if (kind === 'seed_attach' || p.decision === 'deny') return null
  if (p.actions.length === 0) return 'Select at least one action to grant.'
  for (const a of p.actions) {
    if (passkeyOnly(a)) return PASSKEY_REQUIRED_MESSAGE
  }
  return null
}

/** sha256 hex of the canonical decision: the digest the nonce is bound to (member and Telegram user included). */
async function bindingDigest(d: Decidable, p: Params, tg: TgIdentity): Promise<string> {
  const subjectId = d.subject.kind === 'seed_attach' ? d.subject.row.id : d.subject.req.id
  return hex(await sha256(JSON.stringify({
    v: 'tg1', kind: d.m.kind, subject: subjectId, decision: p.decision, actions: p.actions, duration: p.duration ?? null,
    member: tg.memberId, tg_user: tg.telegramUserId,
  })))
}

// ── routes ──────────────────────────────────────────────────────────────────────────────────────────
function shell(c: C, mode: 'launch' | 'moment' | 'enrol', ref: string): Response {
  const title = mode === 'enrol' ? 'Set up this device' : 'Review request'
  const body = `<script src="${TELEGRAM_WEBAPP_SCRIPT_URL}"></script>
<h1>${escapeHtml(title)}</h1>
<div id="app" class="card" data-mode="${mode}" data-ref="${escapeHtml(ref)}"><p class="muted">Checking with Telegram…</p></div>
<div id="status" role="status" class="muted"></div>`
  pageHeaders(c)
  return c.html(renderPage(title, body, { nonce: c.get('nonce'), code: TG_SCRIPT }))
}

/** Routing is static, so the flag is checked per request: anything but 'on' falls through to the pre-W4 routing untouched (a true no-op). */
const guarded = (handler: (c: C) => Promise<Response> | Response) => async (c: C, next: Next): Promise<Response | void> => {
  if (telegramMiniappStatus(c.env).state !== 'on') return next()
  return handler(c)
}

/**
 * Mount the Mini App routes on the secure-moments app. Called ONCE from routes.ts, after its host/flag gate and BEFORE
 * its generic /m/:id/:token routes (`/m/tg/<id>` would otherwise be read as moment "tg").
 */
export function mountTelegramMiniapp(app: Hono<AppEnv>): void {
  app.get('/m/tg', guarded((c) => shell(c, 'launch', '')))
  app.get('/m/tg/enrol/:token', guarded((c) => {
    const token = c.req.param('token') ?? ''
    return TOKEN_RE.test(token) ? shell(c, 'enrol', token) : c.html('', 404)
  }))
  app.get('/m/tg/:id', guarded((c) => {
    const id = c.req.param('id') ?? ''
    return UUID_RE.test(id) ? shell(c, 'moment', id) : c.html('', 404)
  }))

  // view: what is being asked, rendered by the same decision-core views the other channels use.
  app.post('/m/tg/view', guarded(async (c) => {
    const g = await jsonGuard(c)
    if (!g.ok) return g.res
    const a = await authenticateTelegram(c, g.body)
    if (!a.ok) return a.res
    const hasDevice = await memberHasActiveDevice(c.env, a.id.memberId, a.id.telegramUserId)
    const momentId = g.body.moment_id
    if (momentId === undefined) {
      return jsonOut(c, 200, { ok: true, state: 'idle', title: 'Nothing to decide', message: 'No request is attached to this launch.', device_enrolled: hasDevice })
    }
    const l = await loadDecidable(c, a.id.memberId, momentId)
    if (!l.ok) return l.res
    const { subject } = l.d
    let inner: string
    let title: string
    let approveLabel: string
    let sensitive: string[] = []
    if (subject.kind === 'seed_attach') {
      const view = await seedViewInner(c.env, subject.row)
      if (!view.ok) return outcomeJson(c, view.outcome)
      inner = view.inner
      title = 'Approve project seed'
      approveLabel = 'Approve and create'
    } else {
      inner = await elevationViewInner(c.env, subject.req)
      title = 'Approve elevation'
      approveLabel = 'Approve selected'
      try {
        const parsed: unknown = JSON.parse(subject.req.requested_actions_json)
        sensitive = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string' && passkeyOnly(x)) : []
      } catch {
        sensitive = []
      }
    }
    return jsonOut(c, 200, {
      ok: true, state: 'moment', kind: subject.kind, moment_id: l.d.m.id, title, approve_label: approveLabel, view_html: inner,
      device_enrolled: hasDevice, passkey_only_actions: sensitive,
    })
  }))

  // challenge: the single-use nonce for exactly this decision by exactly this member from exactly this Telegram user.
  app.post('/m/tg/challenge', guarded(async (c) => {
    const g = await jsonGuard(c)
    if (!g.ok) return g.res
    const a = await authenticateTelegram(c, g.body)
    if (!a.ok) return a.res
    const l = await loadDecidable(c, a.id.memberId, g.body.moment_id)
    if (!l.ok) return l.res
    const p = readParams(l.d.m, g.body)
    if (!p) return fail(c, 400, 'Invalid decision parameters.', 'Bad request')
    const policy = telegramPolicyRefusal(l.d.m.kind, p)
    if (policy) return fail(c, 403, policy, 'Use a passkey')
    if (!(await memberHasActiveDevice(c.env, a.id.memberId, a.id.telegramUserId))) {
      return fail(c, 409, 'This device is not set up for decisions yet. Set up this phone from My Account (Telegram device) on the dashboard.', 'Set up this device', { needs_enrol: true })
    }
    const nonce = await mintTgNonce(c.env, { momentId: l.d.m.id, memberId: a.id.memberId, telegramUserId: a.id.telegramUserId, decision: p.decision, payloadSha256: await bindingDigest(l.d, p, a.id) })
    if (!nonce) return fail(c, 409, 'Too many unfinished attempts on this request. Wait a few minutes.', 'Try later')
    return jsonOut(c, 200, { ok: true, nonce })
  }))

  // decide: nonce + device secret + a fresh initData, then the one consume, then the shared decision core.
  app.post('/m/tg/decide', guarded(async (c) => {
    const g = await jsonGuard(c)
    if (!g.ok) return g.res
    const a = await authenticateTelegram(c, g.body)
    if (!a.ok) return a.res
    const l = await loadDecidable(c, a.id.memberId, g.body.moment_id)
    if (!l.ok) return l.res
    const { m, subject, auth } = l.d
    const p = readParams(m, g.body)
    if (!p) return fail(c, 400, 'Invalid decision parameters.', 'Bad request')
    const policy = telegramPolicyRefusal(m.kind, p)
    if (policy) return fail(c, 403, policy, 'Use a passkey')
    const nonce = g.body.nonce
    if (typeof nonce !== 'string' || !TOKEN_RE.test(nonce)) return fail(c, 400, 'Missing nonce.', 'Bad request')
    // 1. The step-up FIRST (read-only): the biometric-unlocked device secret of exactly this member and Telegram user, on a
    //    live identity. A bad secret therefore never burns the nonce. A RETIRED secret (a copy of one a rotation replaced)
    //    revokes the device and is reported as such.
    const resolved = await resolveDeviceForDecision(c.env, g.body.device_token, { memberId: a.id.memberId, telegramUserId: a.id.telegramUserId })
    if (resolved.kind === 'stale') {
      return fail(c, 403, 'This device presented an out-of-date secret, so it was removed for your safety. Set it up again (My Account, Telegram device).', 'Device removed')
    }
    if (resolved.kind !== 'ok' || !resolved.device.login_identity_id) {
      return fail(c, 403, 'This device is not recognised for decisions. Set it up again from My Account (Telegram device) on the dashboard.', 'Device not recognised')
    }
    const device = resolved.device
    const identityId = resolved.device.login_identity_id
    // 2. The nonce: single use, live, bound to THIS moment + decision + parameters + member + Telegram user.
    if (!(await consumeTgNonce(c.env, nonce, { momentId: m.id, memberId: a.id.memberId, telegramUserId: a.id.telegramUserId, decision: p.decision, payloadSha256: await bindingDigest(l.d, p, a.id) }, Date.now()))) {
      return fail(c, 403, 'The confirmation is invalid, expired, already used, or was issued for a different decision. Reopen the request and try again.')
    }
    // 3. The core, under the channel's single-use gate (every refusable check already ran above or inside the core, before it).
    const proof: HumanProof = {
      memberId: a.id.memberId, via: 'telegram_miniapp',
      evidence: { moment_id: m.id, telegram_user_id: a.id.telegramUserId, tg_device_id: device.id, tg_auth_method: a.id.method },
    }
    // The consume ROTATES the device secret in the same batch; whatever the core then does, if the consume won the client must
    // receive the next secret (the old one is retired), so it rides on every response after a won gate.
    let nextDeviceToken: string | null = null
    const gate = async (): Promise<boolean> => {
      const r = await consumeMomentTelegram(c.env, {
        momentId: m.id, decision: p.decision, memberId: a.id.memberId, telegramUserId: a.id.telegramUserId,
        deviceId: device.id, secretSha256: device.secret_sha256,
      }, Date.now())
      nextDeviceToken = r.nextDeviceToken
      return r.won
    }
    const waitUntil = waitUntilOf(c)
    const now = Date.now()
    const withRotation = (o: Outcome): Response => jsonOut(c, o.status, {
      ok: o.status === 200, title: o.title, message: o.message, ...(nextDeviceToken ? { device_token_next: nextDeviceToken } : {}),
    })
    if (subject.kind === 'seed_attach') {
      return withRotation(await decideSeed(c.env, { row: subject.row, decision: p.decision, auth, proof, gate, waitUntil }, now))
    }
    return withRotation(await decideElevation(c.env, {
      id: subject.req.id, decision: p.decision, selectedActions: p.actions, durationMinutes: p.duration, auth, proof, gate, waitUntil,
      mintSession: async () => {
        const s = await mintApproverSession(c.env, { memberId: a.id.memberId, auth, identityId })
        return { auth: s.approver.auth, webSessionHash: s.webSessionHash }
      },
    }))
  }))

  // device enrolment: needs a fresh initData of the member the link names AND the link itself.
  async function enrolContext(c: C): Promise<{ ok: true; body: JsonBody; id: TgIdentity; token: TgEnrolmentTokenRow } | { ok: false; res: Response }> {
    const g = await jsonGuard(c)
    if (!g.ok) return g
    const a = await authenticateTelegram(c, g.body)
    if (!a.ok) return a
    const raw = c.req.param('token') ?? ''
    const token = TOKEN_RE.test(raw) ? await loadTgEnrolmentToken(c.env, raw) : null
    if (!token) return { ok: false, res: notFound(c) }
    if (!tgEnrolmentTokenIsLive(token, Date.now())) return { ok: false, res: fail(c, 409, 'This setup link was already used or has expired. Send a new one from My Account (Telegram device).', 'Link closed') }
    if (token.member_id !== a.id.memberId) {
      return { ok: false, res: fail(c, 403, 'This setup link was made for a different account.', 'Wrong account') }
    }
    return { ok: true, body: g.body, id: a.id, token }
  }

  app.post('/m/tg/enrol/:token/start', guarded(async (c) => {
    const e = await enrolContext(c)
    if (!e.ok) return e.res
    const r = await startDeviceEnrolment(c.env, { token: e.token, telegramUserId: e.id.telegramUserId }, Date.now())
    if (!r.ok) {
      const msg = r.reason === 'too_many_devices' ? 'You already have the maximum number of devices. Remove one from My Account (Telegram device) first.'
        : r.reason === 'token_spent' ? 'This setup link was already used or has expired.' : 'Could not start setup. Try again.'
      return fail(c, 409, msg, 'Not started')
    }
    return jsonOut(c, 200, { ok: true, device_token: r.deviceToken })
  }))

  app.post('/m/tg/enrol/:token/confirm', guarded(async (c) => {
    const e = await enrolContext(c)
    if (!e.ok) return e.res
    const r = await confirmDeviceEnrolment(c.env, { token: e.token, deviceToken: String(e.body.device_token ?? ''), telegramUserId: e.id.telegramUserId }, Date.now())
    if (!r.ok) {
      return fail(c, 409, r.reason === 'token_spent' ? 'This setup link was already used.' : 'The device could not be confirmed. Start again from the link.', 'Not set up')
    }
    await recordTgAudit(c.env, { operation: 'tg_device_enrol', memberId: e.id.memberId, deviceId: r.deviceId, evidence: { telegram_user_id: e.id.telegramUserId, login_identity_id: e.token.login_identity_id ?? '' } })
    return jsonOut(c, 200, { ok: true, title: 'Device set up', message: 'Decisions on this phone now need your fingerprint or face. You can close this page.' })
  }))
}
