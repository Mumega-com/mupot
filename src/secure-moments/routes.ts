// mupot — /m/*: secure moments. "The agent asks, the human decides on a page no chat or model ever sees."
// Contract: docs/architecture/secure-moments.md.
//
// FLOW OF TRUST (every request, GET and POST):
//   flag on + dedicated host (host-gate.ts already refused every other host/path) -> Host is the secure host
//   -> the one-time link token matches the stored sha256 of a LIVE moment -> [POST] same-origin + CSRF
//   bound to this link -> a single-use challenge bound to (moment, decision, parameter digest) is consumed
//   -> a WebAuthn assertion with user verification verifies against a live, unrevoked passkey of an ACTIVE
//   HUMAN member (never an agent's welded member row) -> that member's CURRENT authority is re-checked with
//   the existing predicates -> ONE guarded UPDATE consumes the moment -> the shared decision core runs.
// The link alone decides nothing. A passkey proves WHO, never WHAT. No cookie is ever set on this host.
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Env } from '../types'
import { secureMomentsStatus, secureOrigin } from './config'
import { approveUrl } from '../access/config'
import { issueBoundToken, verifyBoundToken } from '../access/csrf'
import { buildAuth, memberIsActiveHuman, mintApproverSession } from '../access/identity'
import { escapeHtml, messagePage, renderPage, untrustedBox } from '../access/page'
import { loadSeedRequest, seedRequestIsLive, type SeedRequestRow } from '../access/seed-request'
import {
  closedSeedOutcome, decideElevation, decideSeed, elevationIsLive, elevationViewInner, mayDecideSeed, seedViewInner,
  type HumanProof, type Outcome, type WaitUntil,
} from '../access/decision-core'
import { loadElevationRequestById, type ElevationRequestRecord } from '../auth/elevation'
import {
  advancePasskeyCounter, consumeDecideChallenge, consumeEnrolChallenge, consumeMoment, finishEnrolment, listMemberPasskeys,
  loadEnrolmentToken, loadMoment, loadPasskeyByCredential, mintDecideChallenge, mintEnrolChallenge, momentIsLive, momentLinkMatches,
  recordPasskeyAudit, tokenHash, type EnrolmentTokenRow, type MomentRow,
} from './store'
import { b64uDecode, b64uEncode, hex, sha256, verifyAssertion, verifyRegistration } from './webauthn'
import { DECIDE_SCRIPT, ENROL_SCRIPT } from './client'
import { secureDropStatus, DROP_ENC_BYTES, DROP_MAX_CIPHERTEXT_BYTES, DROP_MAX_PLAINTEXT_BYTES } from '../secure-drop/config'
import { decideDrop, decodeSealed, loadDrop, loadHostKeyById, loadHostKeyHistory, sealedDigest, type DropRow } from '../secure-drop/store'
import { loadAgent, mayGovernAgent } from '../secure-drop/authority'
import { credentialViewInner } from '../secure-drop/page'
import { CREDENTIAL_SCRIPT, HPKE_ASSET } from '../secure-drop/client'
import { HPKE_BUNDLE_JS } from '../secure-drop/hpke-bundle.generated'
import { groupFingerprint } from '../secure-drop/keys'
import { mountTelegramMiniapp } from './telegram-miniapp'
import { isAttachCeiling, type AttachCeiling } from '../auth/attached-ceiling'
import { loadSquadJoin, squadJoinIsPendingLive, squadJoinView, decideSquadJoin, type SquadJoinRow } from '../members/squad-join'
import { admissionIsPendingLive, admissionView, decideSeatAdmission, loadAdmission, seatAttachEnabled, type AdmissionRow } from '../members/seat-attach'

import {
  dashboardUrl, loadPresenceGrant, presenceGrantIsPending, presenceLinkMatches, satisfyPresenceGrant, type PresenceGrantRow,
} from '../approvals/human-presence'

type AppEnv = { Bindings: Env; Variables: { host: string; nonce: string } }

export const momentsApp = new Hono<AppEnv>()

/** The hosting request's waitUntil, when there is one (a bare `app.fetch(req, env)` in a test has no ExecutionContext). */
function waitUntilOf(c: Context<AppEnv>): WaitUntil | undefined {
  try {
    const ctx = c.executionCtx
    return (p) => ctx.waitUntil(p)
  } catch {
    return undefined
  }
}

const CSRF_INFO = 'mupot_secure_moment_csrf_v1'
const MAX_BODY_BYTES = 16 * 1024
/** A sealed credential (up to 8 KiB of secret) rides base64url twice, plus the assertion: larger than the other bodies. */
const MAX_DROP_BODY_BYTES = 48 * 1024
export const REFERRER_POLICY = 'same-origin' // the link token is in the path: never sent cross-site; same-origin keeps fetch's Origin header

function secure(c: Context<AppEnv>, withScript: boolean, withSelf = false): void {
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', REFERRER_POLICY)
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('Permissions-Policy', 'publickey-credentials-get=(self), publickey-credentials-create=(self)')
  // 'self' only on the credential page: it loads the vendored sealer from this very host (integrity-pinned, no CDN).
  const script = withScript ? `script-src ${withSelf ? "'self' " : ''}'nonce-${c.get('nonce')}'` : "script-src 'none'"
  c.header('Content-Security-Policy', `default-src 'none'; ${script}; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`)
}

type HttpStatus = 200 | 400 | 403 | 404 | 409 | 410 | 503

function page(c: Context<AppEnv>, status: HttpStatus, title: string, message: string, tone: 'ok' | 'warn' | 'bad' = 'bad'): Response {
  secure(c, false)
  return c.html(messagePage(title, message, tone), status)
}

const NOT_FOUND = (c: Context<AppEnv>): Response => page(c, 404, 'Not found', 'There is nothing here for you.')

function json(c: Context<AppEnv>, status: HttpStatus, body: Record<string, unknown>): Response {
  secure(c, false)
  return c.json(body, status)
}

const fail = (c: Context<AppEnv>, status: HttpStatus, message: string, title = 'Refused'): Response =>
  json(c, status, { ok: false, title, message })

const outcomeJson = (c: Context<AppEnv>, o: Outcome): Response => json(c, o.status, { ok: o.status === 200, title: o.title, message: o.message })

// ── gate: flag, config, host ────────────────────────────────────────────────────────────────────
momentsApp.use('*', async (c, next) => {
  const status = secureMomentsStatus(c.env)
  // Defence in depth behind host-gate.ts (the only way in): off, misconfigured, or not the secure host => not found.
  if (status.state !== 'on') return NOT_FOUND(c)
  const host = new URL(c.req.url).host.toLowerCase().replace(/\.(?=(:\d{1,5})?$)/, '')
  if (host !== status.host) return NOT_FOUND(c)
  c.set('host', status.host)
  c.set('nonce', b64uEncode(crypto.getRandomValues(new Uint8Array(16))))
  await next()
})

// Telegram Mini App adapter (W4): registered HERE, before every /m/:id/:token route (`/m/tg/<id>` is not moment "tg").
// Each of its handlers falls through untouched unless TELEGRAM_MINIAPP is on, so flag off changes nothing.
mountTelegramMiniapp(momentsApp)

// ── shared request guards ───────────────────────────────────────────────────────────────────────
type JsonBody = Record<string, unknown>

/** POST preconditions: same-origin (exact Origin), JSON body, bounded size. */
async function jsonGuard(c: Context<AppEnv>, maxBytes = MAX_BODY_BYTES): Promise<{ ok: true; body: JsonBody; size: number } | { ok: false; res: Response }> {
  const origin = c.req.header('origin')
  const site = c.req.header('sec-fetch-site')
  if (origin !== secureOrigin(c.get('host')) || (site !== undefined && site !== 'same-origin')) {
    return { ok: false, res: fail(c, 403, 'Cross-origin request refused.') }
  }
  if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return { ok: false, res: fail(c, 400, 'Expected a JSON body.', 'Bad request') }
  }
  const text = await c.req.text()
  if (text.length > maxBytes) return { ok: false, res: fail(c, 400, 'Body too large.', 'Bad request') }
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
    return { ok: true, body: parsed as JsonBody, size: text.length } // as: just narrowed to a plain object; every field is read as unknown below
  } catch {
    return { ok: false, res: fail(c, 400, 'Unreadable body.', 'Bad request') }
  }
}

const str = (v: unknown, max = 4096): string | undefined => (typeof v === 'string' && v.length <= max ? v : undefined)
const momentCsrfMessage = (id: string, linkHash: string): string => `mupot:secure-moment:v1|moment|${id}|${linkHash}`
const enrolCsrfMessage = (id: string, linkHash: string): string => `mupot:secure-moment:v1|enrol|${id}|${linkHash}`
const presenceCsrfMessage = (id: string, linkHash: string): string => `mupot:secure-moment:v1|presence|${id}|${linkHash}`

async function checkCsrf(c: Context<AppEnv>, message: string, token: unknown): Promise<Response | null> {
  const r = await verifyBoundToken(c.env, CSRF_INFO, message, token)
  if (r === 'unavailable') return fail(c, 503, 'This workspace has no server secret configured for secure moments.', 'Unavailable')
  if (r === 'invalid') return fail(c, 403, 'The form is stale or was not issued for this link. Reload the page and try again.')
  return null
}

/** The challenge string inside a clientDataJSON the browser sent (verification re-parses and re-checks it). */
function challengeOf(clientDataJSON: unknown): string | null {
  const raw = b64uDecode(clientDataJSON)
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(raw))
    if (typeof parsed === 'object' && parsed !== null && 'challenge' in parsed && typeof parsed.challenge === 'string') return parsed.challenge
  } catch {
    // fall through
  }
  return null
}

// ── moments: subject + parameters ───────────────────────────────────────────────────────────────
type Subject =
  | { kind: 'seed_attach'; row: SeedRequestRow }
  | { kind: 'elevation'; req: ElevationRequestRecord }
  | { kind: 'credential'; drop: DropRow }
  | { kind: 'seat_admit'; adm: AdmissionRow }
  | { kind: 'squad_join'; req: SquadJoinRow }

/** The request this moment stands for, only while IT is still live (a closed request is not decidable here). */
async function loadLiveSubject(env: Env, m: MomentRow, nowMs: number): Promise<Subject | null> {
  if (m.kind === 'credential') {
    // Secure drops (W2): a credential moment is decidable only while SECURE_DROP is on and the request is still open.
    if (secureDropStatus(env).state !== 'on') return null
    const drop = await loadDrop(env, m.subject_id)
    return drop && drop.status === 'requested' && drop.moment_id === m.id && Date.parse(drop.expires_at) > nowMs ? { kind: 'credential', drop } : null
  }
  if (m.kind === 'seat_admit') {
    // W2: decidable only while SEAT_ATTACH is on and the admission is still pending and unexpired.
    if (!seatAttachEnabled(env)) return null
    const adm = await loadAdmission(env, m.subject_id)
    return adm && admissionIsPendingLive(adm, nowMs) ? { kind: 'seat_admit', adm } : null
  }
  if (m.kind === 'squad_join') {
    const req = await loadSquadJoin(env, m.subject_id)
    return req && squadJoinIsPendingLive(req, nowMs) ? { kind: 'squad_join', req } : null
  }
  if (m.kind === 'seed_attach') {
    const row = await loadSeedRequest(env, m.subject_id)
    return row && seedRequestIsLive(row, nowMs) ? { kind: 'seed_attach', row } : null
  }
  const req = await loadElevationRequestById(env, env.TENANT_SLUG, m.subject_id)
  return req && elevationIsLive(req, nowMs) ? { kind: 'elevation', req } : null
}

/** The request behind a link is no longer live: a seed that was APPLIED reads as approved, never as "closed". */
async function closedSeed(env: Env, m: MomentRow): Promise<Outcome | null> {
  if (m.kind !== 'seed_attach') return null
  const row = await loadSeedRequest(env, m.subject_id)
  return row && row.status === 'applied' ? closedSeedOutcome(row) : null
}

async function closedSubjectPage(c: Context<AppEnv>, m: MomentRow): Promise<Response> {
  const o = await closedSeed(c.env, m)
  if (o) return page(c, o.status, o.title, o.message, o.tone)
  return page(c, 410, 'Request closed', 'The request behind this link is no longer pending.', 'warn')
}

async function closedSubjectJson(c: Context<AppEnv>, m: MomentRow): Promise<Response> {
  const o = await closedSeed(c.env, m)
  if (o) return outcomeJson(c, o)
  return fail(c, 409, 'The request behind this link is no longer pending.', 'Request closed')
}

interface Params {
  decision: 'approve' | 'deny' | 'provide'
  actions: string[]
  duration: number | undefined
  /** credential provide only: the sealed strings as submitted, validated and canonical. */
  sealed?: { encB64u: string; ctB64u: string; digestHex: string }
  /** seat_admit approve only: the ceiling the human chose (bound into the challenge digest). */
  ceiling?: AttachCeiling
  /** seat_admit approve only: the attach code the human typed (not bound into the digest; checked before the one-time gate). */
  attachCode?: string
  /** sha256 hex of the canonical decision: the digest the challenge is bound to. */
  payload: string
}

/** What the human chose, canonicalised: a deny carries no parameters; an elevation approve carries the narrowed grant. */
async function readParams(m: MomentRow, body: JsonBody): Promise<Params | null> {
  const decision = body.decision
  if (m.kind === 'credential') {
    if (decision === 'deny') {
      const d = hex(await sha256(JSON.stringify({ v: 1, kind: m.kind, subject: m.subject_id, decision })))
      return { decision, actions: [], duration: undefined, payload: d }
    }
    if (decision !== 'provide') return null
    const parts = decodeSealed(body.enc, body.ct, { encBytes: DROP_ENC_BYTES, ctMin: 17, ctMax: DROP_MAX_CIPHERTEXT_BYTES })
    if (!parts) return null
    // The challenge is bound to sha256(enc || ciphertext): the digest of exactly the bytes that will be stored.
    const digestHex = await sealedDigest(parts.enc, parts.ct)
    return { decision, actions: [], duration: undefined, payload: digestHex, sealed: { encB64u: parts.encB64u, ctB64u: parts.ctB64u, digestHex } }
  }
  if (decision !== 'approve' && decision !== 'deny') return null // 'provide' belongs to credential moments only
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
  if (m.kind === 'seat_admit' && decision === 'approve') {
    // The admission CEILING is chosen at the tap and bound into the challenge: a challenge minted for `member` cannot
    // be replayed to approve `full`. Absent = the default; anything unknown is refused.
    const raw = body.ceiling
    const ceiling: AttachCeiling | null = raw === undefined || raw === null || raw === '' ? 'member' : isAttachCeiling(raw) ? raw : null
    if (ceiling === null) return null
    const d = hex(await sha256(JSON.stringify({ v: 1, kind: m.kind, subject: m.subject_id, decision, ceiling })))
    const attachCode = typeof body.attach_code === 'string' ? body.attach_code.slice(0, 32) : undefined
    return { decision, actions, duration, ceiling, attachCode, payload: d }
  }
  const digest = hex(await sha256(JSON.stringify({ v: 1, kind: m.kind, subject: m.subject_id, decision, actions, duration: duration ?? null })))
  return { decision, actions, duration, payload: digest }
}

interface ResolvedMoment { m: MomentRow; token: string; linkHash: string }

/** id + token -> a LIVE moment whose stored hash matches. Anything else is the same 404 (no oracle). */
async function resolveMoment(c: Context<AppEnv>, requireLive: boolean): Promise<{ ok: true; r: ResolvedMoment } | { ok: false; res: Response }> {
  const id = c.req.param('id') ?? ''
  const token = c.req.param('token') ?? ''
  const m = id.length <= 64 ? await loadMoment(c.env, id) : null
  if (!m || !(await momentLinkMatches(m, token))) return { ok: false, res: NOT_FOUND(c) }
  if (requireLive && !momentIsLive(m, Date.now())) {
    return { ok: false, res: c.req.method === 'GET'
      ? await closedMomentPage(c, m)
      : fail(c, 409, 'This link is no longer usable.', 'Link closed') }
  }
  return { ok: true, r: { m, token, linkHash: await tokenHash(token) } }
}

/** A consumed/expired link: a seed that was APPLIED through it reads as approved, anything else as closed. */
async function closedMomentPage(c: Context<AppEnv>, m: MomentRow): Promise<Response> {
  const o = await closedSeed(c.env, m)
  if (o) return page(c, o.status, o.title, o.message, o.tone)
  return page(c, 410, 'Link closed', m.status === 'pending' ? 'This link has expired.' : `This request is already ${m.status}.`, 'warn')
}

// ── enrolment ───────────────────────────────────────────────────────────────────────────────────
async function resolveEnrolment(c: Context<AppEnv>): Promise<{ ok: true; t: EnrolmentTokenRow; linkHash: string } | { ok: false; res: Response }> {
  const token = c.req.param('token') ?? ''
  const t = token.length <= 128 ? await loadEnrolmentToken(c.env, token) : null
  if (!t) return { ok: false, res: NOT_FOUND(c) }
  if (t.consumed_at !== null || Date.parse(t.expires_at) <= Date.now()) {
    return { ok: false, res: c.req.method === 'GET'
      ? page(c, 410, 'Link closed', 'This enrolment link was already used or has expired. Start again from your account page.', 'warn')
      : fail(c, 409, 'This enrolment link is no longer usable.', 'Link closed') }
  }
  if (!(await memberIsActiveHuman(c.env, t.member_id))) return { ok: false, res: NOT_FOUND(c) }
  return { ok: true, t, linkHash: await tokenHash(token) }
}

momentsApp.get('/m/enrol/:token', async (c) => {
  const e = await resolveEnrolment(c)
  if (!e.ok) return e.res
  const csrf = await issueBoundToken(c.env, CSRF_INFO, enrolCsrfMessage(e.t.id, e.linkHash))
  if (!csrf) return page(c, 503, 'Unavailable', 'This workspace has no server secret configured for secure moments.')
  const count = (await listMemberPasskeys(c.env, e.t.member_id)).length
  const body = `<h1>Add a passkey</h1>
<div class="card" id="enrol-box" data-csrf="${csrf}">
<p>A passkey lets you confirm approvals on this site with your fingerprint, face or device PIN.</p>
<p class="muted">It adds no permissions: it only proves it is you. You have ${escapeHtml(String(count))} passkey${count === 1 ? '' : 's'} registered.</p>
<div class="row"><button class="primary" id="enrol-btn" data-act="enrol" type="button">Register a passkey</button></div></div>
<div id="status" role="status" class="muted"></div>`
  secure(c, true)
  return c.html(renderPage('Add a passkey', body, { nonce: c.get('nonce'), code: ENROL_SCRIPT }))
})

momentsApp.post('/m/enrol/:token/options', async (c) => {
  const g = await jsonGuard(c)
  if (!g.ok) return g.res
  const e = await resolveEnrolment(c)
  if (!e.ok) return e.res
  const bad = await checkCsrf(c, enrolCsrfMessage(e.t.id, e.linkHash), g.body.csrf)
  if (bad) return bad
  const member = await c.env.DB.prepare('SELECT email, display_name FROM members WHERE id = ?1 AND tenant = ?2').bind(e.t.member_id, c.env.TENANT_SLUG)
    .first<{ email: string | null; display_name: string | null }>()
  const challenge = await mintEnrolChallenge(c.env, { memberId: e.t.member_id, enrolmentTokenId: e.t.id })
  const existing = await listMemberPasskeys(c.env, e.t.member_id)
  const label = member?.email || member?.display_name || 'member'
  return json(c, 200, {
    ok: true,
    publicKey: {
      rp: { id: c.get('host'), name: 'mupot' },
      user: { id: b64uEncode(await sha256(`${c.env.TENANT_SLUG}|${e.t.member_id}`)), name: label, displayName: member?.display_name || label },
      challenge,
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      timeout: 120000,
      attestation: 'none',
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      excludeCredentials: existing.map((p) => ({ type: 'public-key', id: p.credential_id })),
    },
  })
})

momentsApp.post('/m/enrol/:token/finish', async (c) => {
  const g = await jsonGuard(c)
  if (!g.ok) return g.res
  const e = await resolveEnrolment(c)
  if (!e.ok) return e.res
  const bad = await checkCsrf(c, enrolCsrfMessage(e.t.id, e.linkHash), g.body.csrf)
  if (bad) return bad
  const cred = g.body.credential
  if (typeof cred !== 'object' || cred === null) return fail(c, 400, 'Missing credential.', 'Bad request')
  const rawId = 'rawId' in cred ? str(cred.rawId, 2048) : undefined
  const resp = 'response' in cred ? cred.response : undefined
  if (!rawId || typeof resp !== 'object' || resp === null) return fail(c, 400, 'Malformed credential.', 'Bad request')
  const clientDataJSON = 'clientDataJSON' in resp ? resp.clientDataJSON : undefined
  const attestationObject = 'attestationObject' in resp ? resp.attestationObject : undefined
  const challenge = challengeOf(clientDataJSON)
  if (!challenge) return fail(c, 400, 'Malformed credential.', 'Bad request')
  const now = Date.now()
  // Single use, bound to this member + this enrolment link. A mismatch consumes nothing.
  if (!(await consumeEnrolChallenge(c.env, challenge, { memberId: e.t.member_id, enrolmentTokenId: e.t.id }, now))) {
    return fail(c, 403, 'The registration challenge is invalid, expired or already used. Start again.')
  }
  const host = c.get('host')
  const v = await verifyRegistration({ clientDataJSON, attestationObject }, { challenge, origin: secureOrigin(host), rpId: host })
  if (!v.ok) return fail(c, 403, `The passkey could not be verified (${v.reason}).`)
  if (v.registration.credentialId !== rawId) return fail(c, 403, 'The passkey could not be verified (id_mismatch).')
  const transports = 'transports' in resp && Array.isArray(resp.transports)
    ? resp.transports.filter((t): t is string => typeof t === 'string' && /^[a-z-]{1,16}$/.test(t)).slice(0, 8).join(',') || null
    : null
  const done = await finishEnrolment(c.env, {
    tokenId: e.t.id, memberId: e.t.member_id, loginIdentityId: e.t.login_identity_id,
    credentialId: v.registration.credentialId, publicKey: v.registration.publicKeySpki, signCount: v.registration.signCount,
    aaguid: v.registration.aaguid, transports,
  }, now)
  if (!done.ok) {
    const msg = done.reason === 'duplicate_credential' ? 'This passkey is already registered.'
      : done.reason === 'too_many_passkeys' ? 'You have the maximum number of passkeys. Remove one first.'
        : done.reason === 'enrolment_state_changed' ? 'Your account already has passkey history. Start again from My Account and confirm with an existing passkey.'
        : 'This enrolment link was already used.'
    return fail(c, 409, msg, 'Not registered')
  }
  await recordPasskeyAudit(c.env, { operation: 'passkey_enrol', memberId: e.t.member_id, passkeyId: done.passkeyId, evidence: { login_identity_id: e.t.login_identity_id ?? '' } })
  return json(c, 200, { ok: true, title: 'Passkey registered', message: 'You can close this page. Approvals you are asked to confirm will use this passkey.' })
})

// ── presence grants: one dashboard decision that widens authority, confirmed by a UV passkey assertion ──
// The assertion's challenge is bound to (grant id, 'approve', sha256 of the canonical decision). The verifier, the
// challenge store, the counter rule and the live-identity rule are the SAME ones the moments above use. The grant only
// becomes `satisfied`; the dashboard route that performs the decision consumes it (src/approvals/human-presence.ts).
async function resolvePresence(c: Context<AppEnv>): Promise<{ ok: true; g: PresenceGrantRow; token: string; linkHash: string } | { ok: false; res: Response }> {
  const id = c.req.param('id') ?? ''
  const token = c.req.param('token') ?? ''
  const g = id.length <= 64 ? await loadPresenceGrant(c.env, id) : null
  if (!g || !(await presenceLinkMatches(g, token))) return { ok: false, res: NOT_FOUND(c) }
  if (!presenceGrantIsPending(g, Date.now())) {
    return { ok: false, res: c.req.method === 'GET'
      ? page(c, 410, 'Link closed', g.status === 'satisfied' ? 'Your passkey already confirmed this. Go back to the dashboard to apply it.' : 'This approval link has expired or was already used.', 'warn')
      : fail(c, 409, 'This link is no longer usable.', 'Link closed') }
  }
  return { ok: true, g, token, linkHash: await tokenHash(token) }
}

momentsApp.get('/m/presence/:id/:token', async (c) => {
  const r = await resolvePresence(c)
  if (!r.ok) return r.res
  const csrf = await issueBoundToken(c.env, CSRF_INFO, presenceCsrfMessage(r.g.id, r.linkHash))
  if (!csrf) return page(c, 503, 'Unavailable', 'This workspace has no server secret configured for secure moments.')
  // Dashboard decisions are applied from the dashboard's return page; the Access page's own Approve button is pressed again where it was.
  const accessKind = r.g.kind === 'access_seed_approve' ? 'seed' : r.g.kind === 'access_elevation_approve' ? 'elevation' : null
  // OAuth consent uses its own nonce cookie rather than a dashboard web
  // session. Return its satisfied grant to the OAuth reapply page, which will
  // preserve and re-check that nonce before it consumes the grant.
  const back = r.g.kind === 'oauth_consent'
    ? dashboardUrl(c.env, `/oauth/consent?presence_grant=${encodeURIComponent(r.g.id)}`)
    : accessKind
    ? ((base) => (base ? `${base}?presence_grant=${encodeURIComponent(r.g.id)}` : null))(approveUrl(c.env, accessKind, r.g.subject_id))
    : dashboardUrl(c.env, `/presence/${encodeURIComponent(r.g.id)}`)
  const body = `<h1>Confirm with your passkey</h1>
<form id="decision-form" data-csrf="${csrf}"><div class="card"><p><strong>${escapeHtml(r.g.summary)}</strong></p>
<p class="muted">This gives an agent or a chat more reach. Deciding needs your passkey; opening this page decided nothing. Expires ${escapeHtml(r.g.expires_at.slice(0, 16).replace('T', ' '))} UTC.</p></div>
<div class="row"><button class="primary" type="button" data-act="approve">Approve with passkey</button></div></form>
<div id="status" role="status"></div>
${back ? `<p class="muted">After it says confirmed, <a href="${escapeHtml(back)}" rel="noopener">go back to the dashboard</a> and apply it.</p>` : ''}
${decideHelpBlock(c.env)}`
  secure(c, true)
  return c.html(renderPage('Confirm with your passkey', body, { nonce: c.get('nonce'), code: DECIDE_SCRIPT }))
})

momentsApp.post('/m/presence/:id/:token/challenge', async (c) => {
  const g = await jsonGuard(c)
  if (!g.ok) return g.res
  const r = await resolvePresence(c)
  if (!r.ok) return r.res
  const bad = await checkCsrf(c, presenceCsrfMessage(r.g.id, r.linkHash), g.body.csrf)
  if (bad) return bad
  const challenge = await mintDecideChallenge(c.env, { momentId: r.g.id, decision: 'approve', payloadSha256: r.g.params_sha256 })
  if (!challenge) return fail(c, 409, 'Too many unfinished attempts on this link. Wait a few minutes.', 'Try later')
  const allow = (await listMemberPasskeys(c.env, r.g.member_id)).map((k) => ({ type: 'public-key' as const, id: k.credential_id }))
  return json(c, 200, { ok: true, publicKey: { challenge, rpId: c.get('host'), timeout: 120000, userVerification: 'required', allowCredentials: allow } })
})

momentsApp.post('/m/presence/:id/:token/decide', async (c) => {
  const g = await jsonGuard(c)
  if (!g.ok) return g.res
  const r = await resolvePresence(c)
  if (!r.ok) return r.res
  const bad = await checkCsrf(c, presenceCsrfMessage(r.g.id, r.linkHash), g.body.csrf)
  if (bad) return bad
  const cred = g.body.credential
  if (typeof cred !== 'object' || cred === null) return fail(c, 400, 'Missing credential.', 'Bad request')
  const rawId = 'rawId' in cred ? str(cred.rawId, 2048) : undefined
  const resp = 'response' in cred ? cred.response : undefined
  if (!rawId || typeof resp !== 'object' || resp === null) return fail(c, 400, 'Malformed credential.', 'Bad request')
  const clientDataJSON = 'clientDataJSON' in resp ? resp.clientDataJSON : undefined
  const authenticatorData = 'authenticatorData' in resp ? resp.authenticatorData : undefined
  const signature = 'signature' in resp ? resp.signature : undefined
  const challenge = challengeOf(clientDataJSON)
  if (!challenge) return fail(c, 400, 'Malformed credential.', 'Bad request')
  const now = Date.now()
  // 1. Single-use challenge bound to THIS grant and THIS decision's parameter digest; a challenge minted for any other
  //    grant (so any other decision) consumes nothing here.
  if (!(await consumeDecideChallenge(c.env, challenge, { momentId: r.g.id, decision: 'approve', payloadSha256: r.g.params_sha256 }, now))) {
    return fail(c, 403, 'The passkey challenge is invalid, expired, already used, or was issued for a different decision. Reload and try again.')
  }
  // 2. Whose credential: it must be the passkey of the member the decision belongs to.
  const passkey = await loadPasskeyByCredential(c.env, rawId)
  if (!passkey || passkey.revoked_at !== null || passkey.member_id !== r.g.member_id) return fail(c, 403, 'This passkey is not recognised.')
  // 3. The assertion: origin, RP ID, user presence AND user verification, signature over the exact challenge.
  const host = c.get('host')
  const v = await verifyAssertion({ clientDataJSON, authenticatorData, signature }, { challenge, origin: secureOrigin(host), rpId: host }, passkey.public_key)
  if (!v.ok) return fail(c, 403, `The passkey could not be verified (${v.reason}).`)
  if (!(await memberIsActiveHuman(c.env, passkey.member_id))) return fail(c, 403, 'This passkey is not recognised.')
  if (!(await advancePasskeyCounter(c.env, passkey.id, v.signCount, now))) {
    return fail(c, 403, 'This passkey reported a counter that did not advance. It may have been cloned; remove it and register again.')
  }
  if (!(await liveIdentityFor(c.env, passkey.member_id, passkey.login_identity_id))) {
    return fail(c, 409, 'This passkey is not bound to a live login identity, so it cannot decide. Sign in and add a passkey again.', 'Not decided')
  }
  if (!(await satisfyPresenceGrant(c.env, { id: r.g.id, token: r.token, memberId: passkey.member_id, passkeyId: passkey.id }, Date.now()))) {
    return fail(c, 409, 'This approval was already confirmed, closed, or could not be completed.', 'Not confirmed')
  }
  return json(c, 200, { ok: true, title: 'Confirmed', message: 'Your passkey confirmed this decision. Go back to the dashboard and apply it; it is valid for a few minutes.' })
})

// ── the vendored sealer (secure drops) ──────────────────────────────────────────────────────────
// ONE pinned pre-bundled file served from this host itself: the credential page loads it under script-src 'self'
// plus a nonce and a subresource-integrity hash. Registered BEFORE /m/:id/:token (which would otherwise match it).
// Off (SECURE_DROP unset) it is a 404 like every other drop surface.
momentsApp.get(HPKE_ASSET.src, (c) => {
  if (secureDropStatus(c.env).state !== 'on') return NOT_FOUND(c)
  // The literal spelling only (the router decodes %-escapes; the secure host serves nothing under another spelling).
  if (new URL(c.req.url).pathname !== HPKE_ASSET.src) return NOT_FOUND(c)
  return new Response(HPKE_BUNDLE_JS, {
    status: 200,
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
  })
})

// ── moments ─────────────────────────────────────────────────────────────────────────────────────
momentsApp.get('/m/:id/:token', async (c) => {
  const r = await resolveMoment(c, true)
  if (!r.ok) return r.res
  const subject = await loadLiveSubject(c.env, r.r.m, Date.now())
  if (!subject) return closedSubjectPage(c, r.r.m)
  if (subject.kind === 'credential') {
    const hostKey = await loadHostKeyById(c.env, subject.drop.host_key_id)
    const agent = await loadAgent(c.env, subject.drop.agent_id)
    if (!hostKey || hostKey.revoked_at !== null || hostKey.agent_id !== subject.drop.agent_id || !agent || agent.status !== 'active') {
      return page(c, 410, 'Request closed', "The agent's host key changed after this request was made. Ask the agent to request the credential again.", 'warn')
    }
    const csrf = await issueBoundToken(c.env, CSRF_INFO, momentCsrfMessage(r.r.m.id, r.r.linkHash))
    if (!csrf) return page(c, 503, 'Unavailable', 'This workspace has no server secret configured for secure moments.')
    secure(c, true, true)
    return c.html(renderPage('Provide a credential', `${credentialViewInner({ drop: subject.drop, agent, hostKey, history: await loadHostKeyHistory(c.env, subject.drop.agent_id), nowMs: Date.now(), csrf, maxBytes: DROP_MAX_PLAINTEXT_BYTES })}`,
      { nonce: c.get('nonce'), code: CREDENTIAL_SCRIPT, srcs: [HPKE_ASSET] }))
  }
  let inner: string
  let title: string
  let approveLabel: string
  let promptBlock = ''
  if (subject.kind === 'seat_admit') {
    const v = await admissionView(c.env, subject.adm)
    const codeBlock = subject.adm.attach_code
      ? `<h2>Attach code</h2><p>The chat that asked was told to show you a short code. Type the code that chat showed you; it is not printed here, so it proves you are looking at that chat.</p><label>Attach code <input name="attach_code" autocomplete="off" maxlength="12" size="8" required></label>`
      : ''
    inner = `${codeBlock}<dl><dt>Agent</dt><dd>${escapeHtml(v.agentName)} <code>${escapeHtml(v.agentSlug)}</code></dd>
<dt>App</dt><dd>${untrustedBox('Connected app', `${v.harnessName} (${v.harnessKind})`)}</dd>
<dt>Asked from chat</dt><dd>${escapeHtml(v.seatLabel ?? 'a chat')}${v.seatFirstSeen ? ` (first seen ${escapeHtml(v.seatFirstSeen.slice(0, 16).replace('T', ' '))} UTC)` : ''}</dd>
<dt>Expires</dt><dd>${escapeHtml(subject.adm.expires_at ?? '')}</dd></dl>
<h2>How much may ${escapeHtml(v.agentName)} do in your chats?</h2>
<label class="choice"><input type="radio" name="ceiling" value="member" checked><span><strong>Member</strong>: everyday work (the default)</span></label>
<label class="choice"><input type="radio" name="ceiling" value="lead"><span><strong>Lead</strong>: also lead-level work on what the agent leads</span></label>
${subject.adm.scope === 'harness' ? '' : '<label class="choice"><input type="radio" name="ceiling" value="full"><span><strong>Full</strong>: everything this agent itself may do, never more than you may</span></label>'}
${subject.adm.scope === 'harness'
  ? `<h2>Scope: every chat of this app</h2><p>This one approval covers <strong>every chat, now and later, that comes through this same connection of this app</strong>. Each new chat still has to ask to become ${escapeHtml(v.agentName)} by name, and nothing else is opened: other agents need their own approval, and the Full level is not offered here. It stops for all chats at once when you revoke it or disconnect the app.</p>`
  : '<h2>Scope: the chat that asked</h2><p>This approval is for the one chat shown above. A later chat needs its own approval.</p>'}
<h2>What approving does</h2><p>Lets ${subject.adm.scope === 'harness' ? 'chats of <strong>this connected app</strong>' : 'the chat that asked'} act as <strong>${escapeHtml(v.agentName)}</strong>, until you revoke it on your Connections page. If this agent holds a review gate, approving also lets these chats review (give approve or reject verdicts) on its behalf, never on work that is yours or the agent's own, and detaching a chat or revoking this ends that. They never hold more than you yourself may do. To change the level later you revoke and approve again.</p>`
    title = `Let ${v.agentName} work in your chat`
    approveLabel = 'Admit'
    promptBlock = agentPromptBlock({ agentName: v.agentName, agentSlug: v.agentSlug, agentId: subject.adm.agent_id })
  } else if (subject.kind === 'squad_join') {
    const v = await squadJoinView(c.env, subject.req)
    const sq = v.squad
    const where = sq
      ? `<strong>${escapeHtml(sq.name)}</strong> <code>${escapeHtml(sq.slug)}</code>${sq.kind === 'home' ? ' <em>(a home squad: it cannot be joined by request)</em>' : ''}${sq.archived ? ' <em>(archived)</em>' : ''}`
      : `<em>no squad matches</em> ${untrustedBox('Squad name the agent typed', subject.req.squad_ref)}`
    inner = `<p><strong>${escapeHtml(v.agentName)}</strong> <code>${escapeHtml(v.agentSlug)}</code> wants to join ${where} as <strong>${escapeHtml(subject.req.capability)}</strong>.</p>
<dl><dt>Reason</dt><dd>${untrustedBox('Reason', subject.req.reason ?? '(none given)')}</dd>
<dt>Expires</dt><dd>${escapeHtml(subject.req.expires_at)}</dd></dl>
<h2>What approving does</h2><p>Adds this agent to the squad as ${escapeHtml(subject.req.capability)}, the same as an admin running squad_member_add. It never grants more than member, never an approval gate, and it never lowers access the agent already has. You must be an admin of that squad to approve. Deny, or close this page, to refuse.</p>`
    title = `${v.agentName} wants to join a squad`
    approveLabel = 'Approve'
  } else if (subject.kind === 'seed_attach') {
    const view = await seedViewInner(c.env, subject.row)
    if (!view.ok) return page(c, view.outcome.status, view.outcome.title, view.outcome.message, view.outcome.tone)
    inner = view.inner
    title = 'Approve project seed'
    approveLabel = 'Approve and create'
  } else {
    inner = `${await elevationViewInner(c.env, subject.req)}
<p class="muted">Approving counts as your fresh step-up. The grant is bound to a session created for this decision and ends when it does.</p>`
    title = 'Approve elevation'
    approveLabel = 'Approve selected'
  }
  const csrf = await issueBoundToken(c.env, CSRF_INFO, momentCsrfMessage(r.r.m.id, r.r.linkHash))
  if (!csrf) return page(c, 503, 'Unavailable', 'This workspace has no server secret configured for secure moments.')
  const body = `<h1>${escapeHtml(title)}</h1>
<form id="decision-form" data-csrf="${csrf}">${inner}
<p class="muted">Deciding needs your passkey. Opening this page decided nothing.</p>
<div class="row"><button class="primary" type="button" data-act="approve">${escapeHtml(approveLabel)} with passkey</button>
<button class="danger" type="button" data-act="deny">Deny with passkey</button></div></form>
<div id="status" role="status"></div>
${promptBlock}
${decideHelpBlock(c.env)}`
  secure(c, true)
  return c.html(renderPage(title, body, { nonce: c.get('nonce'), code: DECIDE_SCRIPT }))
})

momentsApp.post('/m/:id/:token/challenge', async (c) => {
  const g = await jsonGuard(c, MAX_DROP_BODY_BYTES)
  if (!g.ok) return g.res
  const r = await resolveMoment(c, true)
  if (!r.ok) return r.res
  if (r.r.m.kind !== 'credential' && g.size > MAX_BODY_BYTES) return fail(c, 400, 'Body too large.', 'Bad request')
  const bad = await checkCsrf(c, momentCsrfMessage(r.r.m.id, r.r.linkHash), g.body.csrf)
  if (bad) return bad
  const p = await readParams(r.r.m, g.body)
  if (!p) return fail(c, 400, 'Invalid decision parameters.', 'Bad request')
  const live = await loadLiveSubject(c.env, r.r.m, Date.now())
  if (!live) return fail(c, 409, 'The request behind this link is no longer pending.', 'Request closed')
  if (live.kind === 'credential' && p.decision === 'provide') {
    // Nothing is sealed to a key that is gone: refuse before a passkey prompt is even shown.
    const hk = await loadHostKeyById(c.env, live.drop.host_key_id)
    if (!hk || hk.revoked_at !== null || hk.agent_id !== live.drop.agent_id) {
      return fail(c, 409, "The agent's host key changed after this request was made. Ask the agent to request the credential again.", 'Request closed')
    }
  }
  const challenge = await mintDecideChallenge(c.env, { momentId: r.r.m.id, decision: p.decision, payloadSha256: p.payload })
  if (!challenge) return fail(c, 409, 'Too many unfinished attempts on this link. Wait a few minutes.', 'Try later')
  let allow: Array<{ type: 'public-key'; id: string }> = []
  if (r.r.m.decider_member_id) {
    allow = (await listMemberPasskeys(c.env, r.r.m.decider_member_id)).map((k) => ({ type: 'public-key', id: k.credential_id }))
  }
  return json(c, 200, {
    ok: true,
    publicKey: { challenge, rpId: c.get('host'), timeout: 120000, userVerification: 'required', allowCredentials: allow },
  })
})

/** After approving an admission the human pastes this into the chat that asked, so the chat attaches to THE AGENT BY NAME and
 *  introduces itself. Plain text, no secret and no authority (the agent id is not a credential: seat_attach still needs the
 *  admission just approved). Name/slug are admin-set text: escaped here, written to a textarea. */
function agentPromptBlock(raw: { agentName: string; agentSlug: string; agentId: string }): string {
  // The pasted text goes to an LLM: keep the admin-set name to ONE short plain line so it can neither carry instructions on extra
  // lines nor grow the message (the page-level escaping below protects the HTML; this protects the model).
  const oneLine = (v: string, max: number): string => v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
  const a = { agentName: oneLine(raw.agentName, 60) || 'there', agentSlug: oneLine(raw.agentSlug, 60), agentId: raw.agentId }
  const who = a.agentSlug ? `${a.agentName} (${a.agentSlug})` : a.agentName
  const text = [
    `Message from mupot for ${a.agentName}. Your user approved your request to act as ${a.agentName} in this chat.`,
    `Attach now: call seat_attach { agent: "${a.agentId}" }.`,
    `- If it says attached: call boot_context, then orient, and tell your user in two or three lines who you are, which squad you are in, and what you can do for them.`,
    `- If it says pending_admission, already_pending or returns an error: stop and show your user the exact response. Do not try other routes, and do not ask for tokens or extra access.`,
  ].join('\n')
  return `<section id="agent-prompt-box" data-agent="${escapeHtml(a.agentName)}"><h2>Then tell ${escapeHtml(who)}</h2>
<p class="muted">Approve above, then copy this message and paste it into the chat that asked. It is a message from mupot to ${escapeHtml(a.agentName)}, addressed by name, and holds no secret.</p>
<textarea id="agent-prompt" readonly rows="7" style="width:100%;box-sizing:border-box">${escapeHtml(text)}</textarea>
<div class="row"><button type="button" id="copy-prompt">Copy message</button></div></section>`
}

/** "No passkey prompt on this device?" help under the decide buttons. The link goes to the signed-in dashboard My Account (never to an
 *  enrolment from THIS page: the approve link is a bearer link, and adding a passkey from it would let whoever holds the link plant their own
 *  proof method; the account page requires a real, freshly re-authenticated web session). Null-safe when PUBLIC_ORIGIN is unset. */
function decideHelpBlock(env: Env): string {
  let account = ''
  try {
    // Path-routed tenant pots carry a prefix in PUBLIC_ORIGIN (https://host/t/<tenant>): keep it, or the link lands on the colony's
    // account and a passkey added there belongs to the wrong tenant database.
    const u = new URL(env.PUBLIC_ORIGIN ?? '')
    if (u.protocol === 'https:') account = `${u.origin}${u.pathname.replace(/\/+$/, '')}/account`
  } catch { /* no usable dashboard origin: leave the link out */ }
  const addPhone = account ? ` Or <a href="${escapeHtml(account)}" target="_blank" rel="noopener">add this phone as a passkey</a> in My Account (you sign in there first), then come back to this link.` : ''
  return `<p class="muted" id="decide-help">No passkey prompt on this phone, or it did not come back? Open this link in Safari or Chrome itself, not inside another app's built-in browser (in the corner menu choose Open in Safari), and tap once.${addPhone}</p>`
}

momentsApp.post('/m/:id/:token/decide', async (c) => {
  const g = await jsonGuard(c, MAX_DROP_BODY_BYTES)
  if (!g.ok) return g.res
  const r = await resolveMoment(c, true)
  if (!r.ok) return r.res
  const { m, token } = r.r
  if (m.kind !== 'credential' && g.size > MAX_BODY_BYTES) return fail(c, 400, 'Body too large.', 'Bad request')
  const bad = await checkCsrf(c, momentCsrfMessage(m.id, r.r.linkHash), g.body.csrf)
  if (bad) return bad
  const p = await readParams(m, g.body)
  if (!p) return fail(c, 400, 'Invalid decision parameters.', 'Bad request')

  const cred = g.body.credential
  if (typeof cred !== 'object' || cred === null) return fail(c, 400, 'Missing credential.', 'Bad request')
  const rawId = 'rawId' in cred ? str(cred.rawId, 2048) : undefined
  const resp = 'response' in cred ? cred.response : undefined
  if (!rawId || typeof resp !== 'object' || resp === null) return fail(c, 400, 'Malformed credential.', 'Bad request')
  const clientDataJSON = 'clientDataJSON' in resp ? resp.clientDataJSON : undefined
  const authenticatorData = 'authenticatorData' in resp ? resp.authenticatorData : undefined
  const signature = 'signature' in resp ? resp.signature : undefined
  const challenge = challengeOf(clientDataJSON)
  if (!challenge) return fail(c, 400, 'Malformed credential.', 'Bad request')

  const now = Date.now()
  // 1. The challenge: single use, live, bound to THIS moment + THIS decision + THESE parameters. A challenge minted
  //    for another decision/moment/parameter set consumes nothing here.
  if (!(await consumeDecideChallenge(c.env, challenge, { momentId: m.id, decision: p.decision, payloadSha256: p.payload }, now))) {
    return fail(c, 403, 'The passkey challenge is invalid, expired, already used, or was issued for a different decision. Reload and try again.')
  }
  // 2. Whose credential: this tenant, not revoked. Unknown and revoked read identically.
  const passkey = await loadPasskeyByCredential(c.env, rawId)
  if (!passkey || passkey.revoked_at !== null) return fail(c, 403, 'This passkey is not recognised.')
  if (m.decider_member_id && passkey.member_id !== m.decider_member_id) return fail(c, 403, 'This passkey is not recognised.')
  // 3. The assertion itself: origin, RP ID, UP + UV, signature over the exact challenge.
  const host = c.get('host')
  const v = await verifyAssertion({ clientDataJSON, authenticatorData, signature }, { challenge, origin: secureOrigin(host), rpId: host }, passkey.public_key)
  if (!v.ok) return fail(c, 403, `The passkey could not be verified (${v.reason}).`)
  // 4. The member is still an active HUMAN (an agent's welded member row can never decide).
  if (!(await memberIsActiveHuman(c.env, passkey.member_id))) return fail(c, 403, 'This passkey is not recognised.')
  // 5. Counter: forward only, in one guarded UPDATE (a non-zero regression or replay is a clone and wins nothing).
  if (!(await advancePasskeyCounter(c.env, passkey.id, v.signCount, now))) {
    return fail(c, 403, 'This passkey reported a counter that did not advance. It may have been cloned; remove it and register again.')
  }
  // 6. Authority, re-derived NOW from the member's own current standing (the proof above is only identity).
  const auth = await buildAuth(c.env, passkey.member_id)
  const proof: HumanProof = { memberId: passkey.member_id, via: 'webauthn', evidence: { moment_id: m.id, passkey_id: passkey.id } }
  // A credential moment decides 'provide' or 'deny' (handled in decideCredential); the shared cores only know approve/deny.
  const classic: 'approve' | 'deny' = p.decision === 'deny' ? 'deny' : 'approve'
  const gate = (): Promise<boolean> => consumeMoment(c.env, { id: m.id, token, decision: classic, memberId: passkey.member_id, passkeyId: passkey.id }, Date.now())
  const subject = await loadLiveSubject(c.env, m, now)
  if (!subject) return closedSubjectJson(c, m)
  // EVERY decision (seed or elevation, approve or deny) needs the login identity the passkey was enrolled under to
  // be live: revoking the identity cuts the passkey off. Checked here, before the gate (a refusal never burns the
  // link), and again inside consumeMoment's own WHERE (a revoke between here and the gate still refuses).
  const identityId = await liveIdentityFor(c.env, passkey.member_id, passkey.login_identity_id)
  if (!identityId) {
    return fail(c, 409, 'This passkey is not bound to a live login identity, so it cannot decide. Sign in and add a passkey again.', 'Not decided')
  }
  const waitUntil = waitUntilOf(c)

  if (subject.kind === 'credential') return decideCredential(c, { m, token, p, subject: subject.drop, auth, passkeyId: passkey.id, memberId: passkey.member_id })
  if (p.decision === 'provide') return fail(c, 400, 'Invalid decision parameters.', 'Bad request') // provide exists only for credential moments
  if (subject.kind === 'seat_admit') {
    return outcomeJson(c, await decideSeatAdmission(c.env, { adm: subject.adm, decision: p.decision, proof, gate, waitUntil, ceiling: p.ceiling, attachCode: p.attachCode }, now))
  }
  if (subject.kind === 'squad_join') {
    return outcomeJson(c, await decideSquadJoin(c.env, { req: subject.req, decision: p.decision, proof, gate, waitUntil }, now))
  }
  if (subject.kind === 'seed_attach') {
    if (!mayDecideSeed(auth)) return fail(c, 403, 'This passkey belongs to a member who may not decide this request.', 'Not allowed')
    return outcomeJson(c, await decideSeed(c.env, { row: subject.row, decision: p.decision, auth, proof, gate, waitUntil }, now))
  }
  return outcomeJson(c, await decideElevation(c.env, {
    id: subject.req.id, decision: p.decision, selectedActions: p.actions, durationMinutes: p.duration, auth, proof, gate, waitUntil,
    mintSession: async () => {
      const s = await mintApproverSession(c.env, { memberId: passkey.member_id, auth, identityId })
      return { auth: s.approver.auth, webSessionHash: s.webSessionHash }
    },
  }))
})

/**
 * A credential moment decided with a verified passkey. EVERY refusal happens before the one batch that consumes the
 * moment and stores the ciphertext (a refusal never burns the link): the decider must hold authority over THIS agent
 * (admin on its squad, or org admin), the request must still be open, and for a provide the host key must still be
 * the live one. The server stores ciphertext only; there is no code here that could open it.
 */
async function decideCredential(
  c: Context<AppEnv>,
  i: { m: MomentRow; token: string; p: Params; subject: DropRow; auth: Awaited<ReturnType<typeof buildAuth>>; passkeyId: string; memberId: string },
): Promise<Response> {
  const agent = await loadAgent(c.env, i.subject.agent_id)
  if (!agent) return fail(c, 409, 'The agent behind this request no longer exists.', 'Request closed')
  if (agent.status !== 'active') return fail(c, 409, 'The agent behind this request is not active.', 'Request closed')
  if (!(await mayGovernAgent(c.env, i.auth, agent))) return fail(c, 403, 'This passkey belongs to a member who may not decide this request.', 'Not allowed')
  const hostKey = await loadHostKeyById(c.env, i.subject.host_key_id)
  if (i.p.decision === 'provide' && (!hostKey || hostKey.revoked_at !== null || hostKey.agent_id !== i.subject.agent_id)) {
    return fail(c, 409, "The agent's host key changed after this request was made. Ask the agent to request the credential again.", 'Request closed')
  }
  if (!hostKey) return fail(c, 409, 'The host key behind this request no longer exists.', 'Request closed')
  const decision = i.p.decision === 'provide' ? 'provide' : 'deny'
  if (decision === 'provide' && !i.p.sealed) return fail(c, 400, 'Invalid decision parameters.', 'Bad request')
  const landed = await decideDrop(c.env, {
    momentId: i.m.id, token: i.token, drop: i.subject, decision, memberId: i.memberId, passkeyId: i.passkeyId,
    sealed: i.p.sealed, fingerprint: hostKey.fingerprint,
  }, Date.now())
  if (!landed) return fail(c, 409, 'This request was already decided, closed, or could not be completed. Nothing was stored.', 'Not sent')
  return decision === 'provide'
    ? json(c, 200, { ok: true, title: 'Credential sealed and sent', message: `Stored encrypted for the host with key ${groupFingerprint(hostKey.fingerprint)}. Only that host can open it, and it is deleted from here once the host collects it.` })
    : json(c, 200, { ok: true, title: 'Request denied', message: 'The agent will not receive this credential.' })
}

async function liveIdentityFor(env: Env, memberId: string, identityId: string | null): Promise<string | null> {
  if (!identityId) return null
  const row = await env.DB.prepare(
    `SELECT id FROM human_login_identities WHERE id = ?1 AND tenant = ?2 AND member_id = ?3 AND revoked_at IS NULL`,
  ).bind(identityId, env.TENANT_SLUG, memberId).first<{ id: string }>()
  return row?.id ?? null
}

// Anything else under /m is not a page.
momentsApp.all('*', (c) => NOT_FOUND(c))
