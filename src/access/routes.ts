// mupot — /approve/*: the human-verified approval page behind Cloudflare Access. "The agent prepares, the
// human taps once." Contract: docs/architecture/access-approve-page.md.
//
// FLOW OF TRUST (every request, GET and POST, runs the whole chain):
//   flag on -> config complete -> Host is the canonical host -> Access JWT verifies (RS256 / team JWKS /
//   iss / exact aud / exp / iat fresh) -> the Access identity resolves to an ACTIVE HUMAN member through
//   the existing human-identity path -> the member holds the authority the decision needs.
// POST adds: same-origin Origin header, and a CSRF token bound to this login. Nothing is decided over
// MCP, Telegram or any bearer: those channels only carry the link.
//
// DECISIONS reuse existing machinery, nothing parallel:
//   seed      -> applySeed (the human's Access-verified POST stands in for the dry-run accept_token; the
//                receipt records via: access_passkey) consumed by ONE guarded UPDATE on seed_attach_requests;
//   elevation -> decideElevationRequest, the fresh Access login counted as the step-up and the grant bound
//                to a web session minted for this login.
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Env } from '../types'
import { accessApproveEnabled, loadAccessApproveConfig, type AccessApproveConfig } from './config'
import { verifyAccessJwt, type AccessClaims, type AccessJwtFailure } from './jwt'
import { issueCsrfToken, verifyCsrfToken } from './csrf'
import { resolveApproverReadOnly, startApproverSession, type ApproverFailure } from './identity'
import { escapeHtml, messagePage, renderPage, untrustedBox } from './page'
import { claimSeedRequest, denySeedRequest, finishSeedRequest, loadSeedRequest, seedRequestIsLive, type SeedRequestRow, type StoredRequest } from './seed-request'
import { hasWorkspaceAdmin, resolveCapabilities } from '../auth/capability'
import { validateSeed } from '../seeds/validate'
import { keyRequests, applySeed } from '../seeds/apply'
import { renderRequest } from '../seeds/render'
import type { SeedRequest, SeedV1 } from '../seeds/contract'
import {
  canDecideElevation, decideElevationRequest, loadElevationRequestById, type ElevationRequestRecord,
} from '../auth/elevation'
import { ELEVATION_ACTIONS, ELEVATION_DURATION_PRESETS_MINUTES, SENSITIVE_STEP_UP_ACTIONS } from '../auth/elevation-actions'

interface Ctx {
  cfg: AccessApproveConfig
  claims: AccessClaims
}
type AppEnv = { Bindings: Env; Variables: { access: Ctx } }

export const approveApp = new Hono<AppEnv>()

const VIA = 'access_passkey'

function secure(c: Context<AppEnv>): void {
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')
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
  if (reason === 'stale') {
    return 'Your Access sign-in is older than the approval freshness window. Sign out of Access (/cdn-cgi/access/logout), then open the approval link again and approve right after signing in.'
  }
  return 'This request did not carry a valid Cloudflare Access sign-in.'
}

function approverMessage(reason: ApproverFailure, claims: AccessClaims): string {
  if (reason === 'not_linked') {
    return `This Access identity (subject ${claims.sub}) is not linked to a member of this workspace. Ask the workspace owner to link it once (see docs/architecture/access-approve-page.md).`
  }
  if (reason === 'link_refused') return 'This Access identity could not be linked to a member (another credential already controls that member).'
  return 'The member behind this Access identity cannot approve (not an active human member).'
}

// ── gate: flag, config, host, JWT ───────────────────────────────────────────────────────────────
approveApp.use('*', async (c, next) => {
  // Flag off: the route does not exist. Nothing else (config, JWT, host) is even looked at.
  if (!accessApproveEnabled(c.env)) return NOT_FOUND(c)
  const cfg = loadAccessApproveConfig(c.env)
  if (!cfg) return page(c, 503, 'Not configured', 'The approval page is enabled but not fully configured.')
  if (new URL(c.req.url).host.toLowerCase() !== cfg.canonicalHost) {
    return page(c, 403, 'Wrong host', 'This page answers only on its canonical host.')
  }
  const verified = await verifyAccessJwt(c.req.header('cf-access-jwt-assertion'), {
    teamHost: cfg.teamHost, aud: cfg.aud, maxAgeSeconds: cfg.maxJwtAgeSeconds,
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

async function agentName(env: Env, agentId: string | null): Promise<string | null> {
  if (!agentId) return null
  const row = await env.DB.prepare('SELECT name FROM agents WHERE id = ?1').bind(agentId).first<{ name: string }>()
  return row?.name ?? null
}

// ── seed ────────────────────────────────────────────────────────────────────────────────────────

async function seedActor(c: Context<AppEnv>): Promise<{ ok: true; memberId: string; auth: import('../types').AuthContext } | { ok: false; res: Response }> {
  const { claims } = c.get('access')
  const who = await resolveApproverReadOnly(c.env, claims)
  if (!who.ok) return { ok: false, res: page(c, 403, 'Not allowed', approverMessage(who.reason, claims)) }
  // Accepting a seed's requests is an org-admin act (the same floor as seed_attach apply).
  if (!hasWorkspaceAdmin(who.approver.auth)) return { ok: false, res: NOT_FOUND(c) }
  return { ok: true, memberId: who.approver.memberId, auth: who.approver.auth }
}

function storedKeys(row: SeedRequestRow): string[] {
  try {
    const parsed: unknown = JSON.parse(row.requests_json)
    return Array.isArray(parsed) ? parsed.map((r: StoredRequest) => r.key).sort() : []
  } catch {
    return []
  }
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
  const v = await validateSeed(row.canonical_json)
  if (!v.ok) return page(c, 409, 'Invalid request', 'The stored seed no longer validates.')
  const requests = await keyRequests(v.requests)
  const s: SeedV1 = v.seed
  const requester = await agentName(c.env, row.requester_agent_id)
  const items = requests.map((r) => `<li><code>${escapeHtml(r.key)}</code>: ${escapeHtml(renderRequest(r as SeedRequest))}</li>`).join('')
  const info = `<dl><dt>Project slug</dt><dd><code>${escapeHtml(s.slug)}</code></dd><dt>Kind</dt><dd>${escapeHtml(s.kind)}</dd>
<dt>Repo</dt><dd>${s.repo ? `<code>${escapeHtml(s.repo)}</code>` : 'none'}</dd><dt>Live URL</dt><dd>${s.live ? `<code>${escapeHtml(s.live)}</code>` : 'none'}</dd>
<dt>Seats requested</dt><dd>${s.wants?.seats ? escapeHtml(String(s.wants.seats.max)) : 'none'}</dd>
<dt>Filed by</dt><dd>${requester ? escapeHtml(requester) : 'a member'} (<code>${escapeHtml(row.requester_member_id)}</code>)</dd>
<dt>Expires</dt><dd>${escapeHtml(row.expires_at)}</dd><dt>Digest</dt><dd><code>${escapeHtml(row.seed_sha256)}</code></dd></dl>`
  const inner = `${info}<h2>What approving does</h2><p>Creates the project, its squad and seat cap. It <strong>grants nothing</strong>: every request below stays pending a separate human step.</p>
<h2>Requests the seed makes (${requests.length})</h2>${requests.length ? `<ul>${items}</ul>` : '<p class="muted">None.</p>'}
<h2>Written by the agent</h2>${untrustedBox('Project name', s.name)}${untrustedBox('Goal', s.goal)}`
  const form = await formHtml(c, 'seed', row.id, inner, 'Approve and create')
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

  if (decision === 'deny') {
    const denied = await denySeedRequest(c.env, row, actor.memberId, claims.sub, now)
    return denied ? page(c, 200, 'Denied', 'The request was denied. Nothing was created.', 'ok') : page(c, 409, 'Request closed', 'This request is no longer pending.', 'warn')
  }

  // Re-validate BEFORE consuming: the row must still be exactly what the human was shown.
  const v = await validateSeed(row.canonical_json)
  if (!v.ok || v.seedSha256 !== row.seed_sha256) return page(c, 409, 'Invalid request', 'The stored seed no longer matches its digest.')
  const keyed = await keyRequests(v.requests)
  const keys = keyed.map((r) => r.key).sort()
  const stored = storedKeys(row)
  if (keys.length !== stored.length || keys.some((k, i) => k !== stored[i])) {
    return page(c, 409, 'Invalid request', 'The seed no longer produces the requests that were shown.')
  }

  // The ONE consuming UPDATE. Losing it means another tab/tap decided first.
  if (!(await claimSeedRequest(c.env, row.id, actor.memberId, now))) {
    return page(c, 409, 'Request closed', 'This request is no longer pending.', 'warn')
  }
  const outcome = await applySeed(
    c.env, actor.auth, actor.memberId,
    { seed: v.seed, canonical: v.canonical, seedSha256: v.seedSha256, requests: keyed },
    keyed.map((r) => r.key), undefined,
    { via: VIA, requestId: row.id, accessSub: claims.sub },
  )
  await finishSeedRequest(c.env, row.id, outcome.ok ? { ok: true } : { ok: false, error: outcome.error })
  if (!outcome.ok) return page(c, 409, 'Not applied', `The seed could not be applied (${outcome.error}). The request is closed; ask the agent to file a new one.`)
  return page(c, 200, 'Approved', 'The project was created. Nothing was granted: every request in the seed is still pending.', 'ok')
})

// ── elevation ───────────────────────────────────────────────────────────────────────────────────

function parseActions(req: ElevationRequestRecord): string[] {
  try {
    const parsed: unknown = JSON.parse(req.requested_actions_json)
    return Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === 'string') : []
  } catch {
    return []
  }
}

approveApp.get('/elevation/:id', async (c) => {
  const { claims } = c.get('access')
  const who = await resolveApproverReadOnly(c.env, claims)
  if (!who.ok) return page(c, 403, 'Not allowed', approverMessage(who.reason, claims))
  const req = await loadElevationRequestById(c.env, c.env.TENANT_SLUG, c.req.param('id'))
  // Unknown id and out-of-authority read identically.
  if (!req || !(await canDecideElevation(c.env, who.approver.auth, who.approver.auth.capabilities, req.requested_scope_type, req.requested_scope_id))) {
    return NOT_FOUND(c)
  }
  if (req.status !== 'pending' || Date.parse(req.decision_expires_at) <= Date.now()) {
    return page(c, 410, 'Request closed', req.status === 'pending' ? 'This request has expired.' : `This request is already ${req.status}.`, 'warn')
  }
  const agent = await agentName(c.env, req.agent_id)
  const actions = parseActions(req)
  const boxes = actions.map((a) => {
    const def = ELEVATION_ACTIONS[a]
    const label = def?.label ?? a
    const note = def ? `${escapeHtml(def.description)} <span class="muted">(effect: ${escapeHtml(def.effect)}. ${escapeHtml(def.effectNote)})</span>` : ''
    return `<li><label><input type="checkbox" name="actions" value="${escapeHtml(a)}" checked> <strong>${escapeHtml(label)}</strong>${SENSITIVE_STEP_UP_ACTIONS.has(a) ? ' (sensitive)' : ''}<br>${note}</label></li>`
  }).join('')
  const durations = ELEVATION_DURATION_PRESETS_MINUTES.filter((m) => m <= req.requested_duration_minutes)
    .map((m) => `<option value="${m}"${m === req.requested_duration_minutes ? ' selected' : ''}>${m} minutes</option>`).join('')
  const inner = `<dl><dt>Agent</dt><dd>${agent ? escapeHtml(agent) : '<span class="muted">unknown</span>'} (<code>${escapeHtml(req.agent_id)}</code>)</dd>
<dt>Scope</dt><dd>${escapeHtml(req.requested_scope_type)} <code>${escapeHtml(req.requested_scope_id || 'org-wide')}</code> (cannot be widened or changed here)</dd>
<dt>Decide by</dt><dd>${escapeHtml(req.decision_expires_at)}</dd></dl>
<h2>Actions (untick to narrow)</h2><ul style="list-style:none;padding-left:0">${boxes}</ul>
<h2>Duration (you can only shorten)</h2><select name="duration_minutes">${durations}</select>
<h2>Why the agent says it needs this</h2>${untrustedBox('Reason', req.reason)}
<p class="muted">Approving counts as your fresh step-up. The grant is bound to a session created for this sign-in and ends when it does.</p>`
  const form = await formHtml(c, 'elevation', req.id, inner, 'Approve selected')
  if (!form) return page(c, 503, 'Unavailable', 'This workspace has no server secret configured for approvals.')
  secure(c)
  return c.html(renderPage('Approve elevation', `<h1>Approve elevation</h1>${form}`))
})

async function writeElevationReceipt(env: Env, memberId: string, requestId: string, operation: string, evidence: Record<string, unknown>): Promise<boolean> {
  try {
    const nowIso = new Date().toISOString()
    await env.DB.prepare(
      `INSERT INTO mutation_audit_entries (
         id, tenant, principal_kind, principal_id, member_id, origin, handler, operation,
         target_kind, target_id, request_id, idempotency_key, evidence_json, recorded_at)
       VALUES (?1, ?2, 'member', ?3, ?3, 'admin_ui', 'access_approve', ?4, 'elevation_request', ?5, ?6, ?6, ?7, ?8)
       ON CONFLICT DO NOTHING`,
    ).bind(crypto.randomUUID(), env.TENANT_SLUG, memberId, operation, requestId, `access-elevation:${requestId}`, JSON.stringify({ via: VIA, ...evidence }), nowIso).run()
    return true
  } catch {
    return false
  }
}

approveApp.post('/elevation/:id', async (c) => {
  const id = c.req.param('id')
  const guard = await postGuard(c, 'elevation', id)
  if (!guard.ok) return guard.res
  const decision = one(guard.form.decision)
  if (decision !== 'approve' && decision !== 'deny') return page(c, 400, 'Bad request', 'decision must be approve or deny.')
  const { claims } = c.get('access')
  const session = await startApproverSession(c.env, claims)
  if (!session.ok) return page(c, 403, 'Not allowed', approverMessage(session.reason, claims))
  const { approver } = session

  const rawActions = guard.form.actions
  const selected = (Array.isArray(rawActions) ? rawActions : rawActions === undefined ? [] : [rawActions]).filter((a): a is string => typeof a === 'string')
  const durationRaw = one(guard.form.duration_minutes)
  const duration = durationRaw !== undefined && /^\d{1,5}$/.test(durationRaw) ? Number(durationRaw) : undefined

  const result = await decideElevationRequest(c.env, {
    tenant: c.env.TENANT_SLUG,
    requestId: id,
    decision,
    selectedActions: decision === 'approve' ? selected : undefined,
    durationMinutes: decision === 'approve' ? duration : undefined,
    decidedByMemberId: approver.memberId,
    decidedByCapabilities: approver.auth.capabilities ?? (await resolveCapabilities(c.env, approver.memberId)),
    decidedByIsOrgAdmin: hasWorkspaceAdmin(approver.auth),
    decidedByWebSessionHash: session.webSessionHash,
    // The Access login just completed IS the step-up (verified fresh by iat above).
    recentReauthOk: true,
    note: `via:${VIA}`,
  })
  if (!result.ok) {
    const missing = result.reason === 'not_found' || result.reason === 'forbidden'
    if (missing) return NOT_FOUND(c)
    const detail = 'detail' in result ? ` (${result.detail})` : ''
    return page(c, 409, 'Not decided', `The decision was not recorded: ${result.reason}${detail}.`, 'warn')
  }
  const receipted = await writeElevationReceipt(c.env, approver.memberId, id, decision === 'approve' ? 'elevation_approve' : 'elevation_deny', {
    request_id: id, access_sub: claims.sub, decision,
    actions: result.grants.map((g) => g.action), scope_type: result.request.requested_scope_type, scope_id: result.request.requested_scope_id,
    expires_at: result.grants[0]?.expires_at ?? null,
  })
  const tail = receipted ? '' : ' The decision stands, but its audit receipt could not be written; tell the operator.'
  return decision === 'approve'
    ? page(c, 200, 'Approved', `Granted ${result.grants.length} action${result.grants.length === 1 ? '' : 's'} until ${result.grants[0]?.expires_at ?? ''}.${tail}`, 'ok')
    : page(c, 200, 'Denied', `The request was denied.${tail}`, 'ok')
})

// Anything else under /approve is not a page.
approveApp.all('*', (c) => NOT_FOUND(c))
