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
import { issueBoundToken, verifyBoundToken } from '../access/csrf'
import { buildAuth, memberIsActiveHuman, mintApproverSession } from '../access/identity'
import { escapeHtml, messagePage, renderPage } from '../access/page'
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

/** The request this moment stands for, only while IT is still live (a closed request is not decidable here). */
async function loadLiveSubject(env: Env, m: MomentRow, nowMs: number): Promise<Subject | null> {
  if (m.kind === 'credential') {
    // Secure drops (W2): a credential moment is decidable only while SECURE_DROP is on and the request is still open.
    if (secureDropStatus(env).state !== 'on') return null
    const drop = await loadDrop(env, m.subject_id)
    return drop && drop.status === 'requested' && drop.moment_id === m.id && Date.parse(drop.expires_at) > nowMs ? { kind: 'credential', drop } : null
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
        : 'This enrolment link was already used.'
    return fail(c, 409, msg, 'Not registered')
  }
  await recordPasskeyAudit(c.env, { operation: 'passkey_enrol', memberId: e.t.member_id, passkeyId: done.passkeyId, evidence: { login_identity_id: e.t.login_identity_id ?? '' } })
  return json(c, 200, { ok: true, title: 'Passkey registered', message: 'You can close this page. Approvals you are asked to confirm will use this passkey.' })
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
  if (subject.kind === 'seed_attach') {
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
<div id="status" role="status"></div>`
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
