// mupot — /approve/*: the human-verified approval page behind Cloudflare Access. "The agent prepares, the
// human taps once." Contract: docs/architecture/access-approve-page.md.
//
// FLOW OF TRUST (every request, GET and POST, runs the whole chain):
//   flag on -> config complete + dedicated host (host-gate.ts already refused every other host/path) -> Host is the canonical host -> Access JWT verifies (RS256 / team JWKS /
//   iss / exact aud / exp / iat fresh [/ amr]) -> the Access identity resolves, via an EXISTING explicit
//   human_login_identities row (never auto-linked), to an ACTIVE HUMAN member -> the member holds the
//   authority the decision needs -> only then is any session/row written.
// POST adds: same-origin Origin header, and a CSRF token bound to this login. Nothing is decided over
// MCP, Telegram or any bearer: those channels only carry the link.
//
// DECISIONS live in decision-core.ts (shared with secure moments; this file only establishes the human proof):
//   seed      -> applySeed (the human's Access-verified POST stands in for the dry-run accept_token; the
//                receipt records via: access_passkey) consumed by ONE guarded UPDATE on seed_attach_requests;
//   elevation -> decideElevationRequest, the fresh Access login counted as the step-up and the grant bound
//                to a web session minted for this login.
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Env } from '../types'
import { accessApproveStatus, colonyHostnames, type AccessApproveConfig } from './config'
import { verifyAccessJwt, type AccessClaims, type AccessJwtFailure } from './jwt'
import { issueCsrfToken, verifyCsrfToken } from './csrf'
import { resolveApprover, mintApproverSession, type ApproverFailure } from './identity'
import { escapeHtml, messagePage, renderPage } from './page'
import { loadSeedRequest, seedRequestIsLive } from './seed-request'
import { loadElevationRequestById } from '../auth/elevation'
import {
  decideElevation, decideSeed, elevationIsLive, elevationViewInner, mayDecideElevation, mayDecideSeed,
  NOT_FOUND_OUTCOME, seedViewInner, type HumanProof, type Outcome,
} from './decision-core'

interface Ctx {
  cfg: AccessApproveConfig
  claims: AccessClaims
}
type AppEnv = { Bindings: Env; Variables: { access: Ctx } }

export const approveApp = new Hono<AppEnv>()

const VIA = 'access_passkey'
// same-origin, NOT no-referrer: under no-referrer browsers send `Origin: null` on form POSTs, which the POST guard
// (rightly) refuses, so every real tap would fail. same-origin sends the page's own origin to itself and nothing cross-site.
export const REFERRER_POLICY = 'same-origin'

function secure(c: Context<AppEnv>): void {
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', REFERRER_POLICY)
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
}

function page(c: Context<AppEnv>, status: 200 | 400 | 403 | 404 | 409 | 410 | 503, title: string, message: string, tone: 'ok' | 'warn' | 'bad' = 'bad'): Response {
  secure(c)
  return c.html(messagePage(title, message, tone), status)
}

const NOT_FOUND = (c: Context<AppEnv>): Response => page(c, 404, 'Not found', 'There is nothing here for you.')

function jwtMessage(reason: AccessJwtFailure): string {
  if (reason === 'amr_required') {
    return 'This sign-in did not carry the required authentication method. Sign out of Access and sign in again with the required method.'
  }
  if (reason === 'stale') {
    return 'Your Access sign-in is older than the approval freshness window. Sign out of Access (/cdn-cgi/access/logout), then open the approval link again and approve right after signing in.'
  }
  return 'This request did not carry a valid Cloudflare Access sign-in.'
}

function approverMessage(reason: ApproverFailure, claims: AccessClaims): string {
  if (reason === 'not_linked') {
    return `This Access identity (subject ${claims.sub}) is not linked to a member of this workspace. Nothing is linked automatically: ask the workspace owner to link it explicitly (see docs/architecture/access-approve-page.md).`
  }
  return 'The member behind this Access identity cannot approve (not an active human member).'
}

// ── gate: flag, config, host, JWT ───────────────────────────────────────────────────────────────
approveApp.use('*', async (c, next) => {
  const status = accessApproveStatus(c.env)
  // Flag off: the route does not exist. Nothing else (config, JWT, host) is even looked at.
  if (status.state === 'off') return NOT_FOUND(c)
  const host = new URL(c.req.url).host.toLowerCase()
  // Defence in depth behind host-gate.ts: a host that is not the dedicated approval host (or is a colony host) is not found.
  if (status.state === 'misconfigured') {
    return colonyHostnames(c.env).has(host.replace(/:\d{1,5}$/, '')) ? NOT_FOUND(c) : page(c, 503, 'Not configured', 'The approval page is enabled but not fully configured.')
  }
  const cfg = status.cfg
  if (host !== cfg.canonicalHost) return NOT_FOUND(c)
  const verified = await verifyAccessJwt(c.req.header('cf-access-jwt-assertion'), {
    teamHost: cfg.teamHost, aud: cfg.aud, maxAgeSeconds: cfg.maxJwtAgeSeconds, requiredAmr: cfg.requiredAmr,
  })
  if (!verified.ok) return page(c, 403, 'Access denied', jwtMessage(verified.reason))
  c.set('access', { cfg, claims: verified.claims })
  await next()
})

/** POST preconditions: same-origin, form body, CSRF token for (kind, id) bound to this login. */
async function postGuard(c: Context<AppEnv>, kind: string, id: string): Promise<{ ok: true; form: Record<string, string | string[]> } | { ok: false; res: Response }> {
  const { cfg, claims } = c.get('access')
  const origin = c.req.header('origin')
  const site = c.req.header('sec-fetch-site')
  if (origin !== `https://${cfg.canonicalHost}` || (site !== undefined && site !== 'same-origin')) {
    return { ok: false, res: page(c, 403, 'Refused', 'Cross-origin request refused.') }
  }
  let form: Record<string, string | string[]>
  try {
    form = await c.req.parseBody({ all: true }) as Record<string, string | string[]> // as: parseBody returns string|File values; files are rejected by the type checks below
  } catch {
    return { ok: false, res: page(c, 400, 'Bad request', 'Unreadable form.') }
  }
  const csrf = await verifyCsrfToken(c.env, kind, id, claims.sub, claims.iat, form.csrf)
  if (csrf === 'unavailable') return { ok: false, res: page(c, 503, 'Unavailable', 'This workspace has no server secret configured for approvals.') }
  if (csrf === 'invalid') return { ok: false, res: page(c, 403, 'Refused', 'The approval form is stale or was not issued to this sign-in. Reload the page and try again.') }
  return { ok: true, form }
}

const one = (v: string | string[] | undefined): string | undefined => (typeof v === 'string' ? v : undefined)

async function formHtml(c: Context<AppEnv>, kind: string, id: string, inner: string, approveLabel: string): Promise<string | null> {
  const { claims } = c.get('access')
  const csrf = await issueCsrfToken(c.env, kind, id, claims.sub, claims.iat)
  if (!csrf) return null
  return `<form method="post" action="/approve/${kind}/${encodeURIComponent(id)}">
<input type="hidden" name="csrf" value="${csrf}">${inner}
<div class="row"><button class="primary" type="submit" name="decision" value="approve">${escapeHtml(approveLabel)}</button>
<button class="danger" type="submit" name="decision" value="deny">Deny</button></div></form>`
}

// ── seed ────────────────────────────────────────────────────────────────────────────────────────

function outcomePage(c: Context<AppEnv>, o: Outcome): Response {
  return page(c, o.status, o.title, o.message, o.tone)
}

async function seedActor(c: Context<AppEnv>): Promise<{ ok: true; memberId: string; auth: import('../types').AuthContext } | { ok: false; res: Response }> {
  const { claims } = c.get('access')
  const who = await resolveApprover(c.env, claims)
  if (!who.ok) return { ok: false, res: page(c, 403, 'Not allowed', approverMessage(who.reason, claims)) }
  if (!mayDecideSeed(who.approver.auth)) return { ok: false, res: NOT_FOUND(c) }
  return { ok: true, memberId: who.approver.memberId, auth: who.approver.auth }
}

approveApp.get('/seed/:id', async (c) => {
  const actor = await seedActor(c)
  if (!actor.ok) return actor.res
  const row = await loadSeedRequest(c.env, c.req.param('id'))
  if (!row) return NOT_FOUND(c)
  const now = Date.now()
  if (!seedRequestIsLive(row, now)) {
    return page(c, 410, 'Request closed', row.status === 'pending' ? 'This request has expired.' : `This request is already ${row.status}.`, 'warn')
  }
  const view = await seedViewInner(c.env, row)
  if (!view.ok) return outcomePage(c, view.outcome)
  const form = await formHtml(c, 'seed', row.id, view.inner, 'Approve and create')
  if (!form) return page(c, 503, 'Unavailable', 'This workspace has no server secret configured for approvals.')
  secure(c)
  return c.html(renderPage('Approve project seed', `<h1>Approve project seed</h1>${form}`))
})

approveApp.post('/seed/:id', async (c) => {
  const id = c.req.param('id')
  const guard = await postGuard(c, 'seed', id)
  if (!guard.ok) return guard.res
  const decision = one(guard.form.decision)
  if (decision !== 'approve' && decision !== 'deny') return page(c, 400, 'Bad request', 'decision must be approve or deny.')
  const { claims } = c.get('access')
  const actor = await seedActor(c)
  if (!actor.ok) return actor.res
  const row = await loadSeedRequest(c.env, id)
  if (!row) return NOT_FOUND(c)
  const now = Date.now()
  if (!seedRequestIsLive(row, now)) return page(c, 409, 'Request closed', 'This request is no longer pending.', 'warn')
  const proof: HumanProof = { memberId: actor.memberId, via: VIA, evidence: { access_sub: claims.sub } }
  return outcomePage(c, await decideSeed(c.env, { row, decision, auth: actor.auth, proof }, now))
})

// ── elevation ───────────────────────────────────────────────────────────────────────────────────

approveApp.get('/elevation/:id', async (c) => {
  const { claims } = c.get('access')
  const who = await resolveApprover(c.env, claims)
  if (!who.ok) return page(c, 403, 'Not allowed', approverMessage(who.reason, claims))
  const req = await loadElevationRequestById(c.env, c.env.TENANT_SLUG, c.req.param('id'))
  // Unknown id and out-of-authority read identically.
  if (!req || !(await mayDecideElevation(c.env, who.approver.auth, req))) return NOT_FOUND(c)
  if (!elevationIsLive(req, Date.now())) {
    return page(c, 410, 'Request closed', req.status === 'pending' ? 'This request has expired.' : `This request is already ${req.status}.`, 'warn')
  }
  const inner = `${await elevationViewInner(c.env, req)}
<p class="muted">Approving counts as your fresh step-up. The grant is bound to a session created for this sign-in and ends when it does.</p>`
  const form = await formHtml(c, 'elevation', req.id, inner, 'Approve selected')
  if (!form) return page(c, 503, 'Unavailable', 'This workspace has no server secret configured for approvals.')
  secure(c)
  return c.html(renderPage('Approve elevation', `<h1>Approve elevation</h1>${form}`))
})

approveApp.post('/elevation/:id', async (c) => {
  const id = c.req.param('id')
  const guard = await postGuard(c, 'elevation', id)
  if (!guard.ok) return guard.res
  const decision = one(guard.form.decision)
  if (decision !== 'approve' && decision !== 'deny') return page(c, 400, 'Bad request', 'decision must be approve or deny.')
  const { claims } = c.get('access')
  const who = await resolveApprover(c.env, claims)
  if (!who.ok) return page(c, 403, 'Not allowed', approverMessage(who.reason, claims))

  const rawActions = guard.form.actions
  const selected = (Array.isArray(rawActions) ? rawActions : rawActions === undefined ? [] : [rawActions]).filter((a): a is string => typeof a === 'string')
  const durationRaw = one(guard.form.duration_minutes)
  const duration = durationRaw !== undefined && /^\d{1,5}$/.test(durationRaw) ? Number(durationRaw) : undefined
  const proof: HumanProof = { memberId: who.approver.memberId, via: VIA, evidence: { access_sub: claims.sub } }
  const outcome = await decideElevation(c.env, {
    id, decision, selectedActions: selected, durationMinutes: duration, auth: who.approver.auth, proof,
    // The grant binds to a web session for this login: minted by the core only after its checks passed.
    mintSession: async () => {
      const session = await mintApproverSession(c.env, who.approver)
      return { auth: session.approver.auth, webSessionHash: session.webSessionHash }
    },
  })
  return outcome.status === 404 && outcome === NOT_FOUND_OUTCOME ? NOT_FOUND(c) : outcomePage(c, outcome)
})

// Anything else under /approve is not a page.
approveApp.all('*', (c) => NOT_FOUND(c))
