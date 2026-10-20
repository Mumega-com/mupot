// mupot — the channel-neutral decision core shared by every human-proof channel.
//
// The Access approve page (src/access/routes.ts, proof = a verified Cloudflare Access login) and secure
// moments (src/secure-moments/routes.ts, proof = a user-verified WebAuthn assertion) both end here. The
// channel's only job is to establish WHO the human is (a HumanProof) and to hand over the member's current
// AuthContext; this core then re-checks WHAT that member may do with the existing predicates (org admin for a
// seed apply, canDecideElevation for an elevation) and calls the existing decision machinery. A proof never
// grants authority.
//
// `gate` is the channel's own single-use consume (the secure moment's guarded UPDATE). RULE: nothing that can be
// refused may be checked after the gate. Every refusable check runs BEFORE it, using the SAME predicates the
// downstream transaction uses (findElevationDecisionRefusal is exported from auth/elevation.ts and is what
// decideElevationRequest itself runs), so a refused decision never burns the one-time link or records an
// approve; only a genuine race (another channel deciding in the same instant) can still lose after the gate.
//
// DURABILITY: everything from the gate to the final status write runs as ONE promise handed to `waitUntil`
// (and still awaited), so a client that reloads or disconnects mid-decision cannot strand a request in
// 'applying' or a moment consumed with nothing applied. A lazy reconcile (reconcileSeedRequest) repairs the
// remaining crash window on the next read.
import type { AuthContext, Env } from '../types'
import { hasWorkspaceAdmin, resolveCapabilities } from '../auth/capability'
import { validateSeed } from '../seeds/validate'
import { keyRequests, applySeed } from '../seeds/apply'
import { renderRequest } from '../seeds/render'
import type { SeedRequest, SeedV1 } from '../seeds/contract'
import {
  canDecideElevationRequest, deciderMemberIdOf, decideElevationRequest, requestIsFromAttachedChat, findElevationDecisionRefusal, loadElevationRequestById,
  type DecideElevationInput, type DecideElevationResult, type ElevationRequestRecord,
} from '../auth/elevation'
import { revokeWebSession } from '../auth/web-sessions'
import { isValidSlugBase } from '../org/team-bootstrap'
import { BOT_STEP_UP_ACTIONS, ELEVATION_ACTIONS, ELEVATION_DURATION_PRESETS_MINUTES, SENSITIVE_STEP_UP_ACTIONS } from '../auth/elevation-actions'
import { escapeHtml, untrustedBox } from './page'
import { exactCallLine } from '../auth/owner-sudo-args'
import {
  claimSeedRequest, denySeedRequest, finishSeedRequest, receiptHandlerFor, type DecisionVia, type SeedRequestRow, type StoredRequest,
} from './seed-request'

/** Who decided and over which channel. `evidence` lands verbatim in the receipts (e.g. access_sub, moment_id). */
export interface HumanProof {
  memberId: string
  via: DecisionVia
  evidence: Record<string, string>
}

/** An elevation decision may also arrive over the approval bot (a Telegram tap in the bound private chat). It is NOT a seed channel:
 *  seed decisions keep DecisionVia (their table's CHECK does not know it), and it is never passkey-class. */
export type ElevationVia = DecisionVia | 'approval_bot'
export interface ElevationProof {
  memberId: string
  via: ElevationVia
  evidence: Record<string, string>
}

/** The channels whose proof is a genuine passkey / fresh-login step-up. An ALLOW-list on purpose: a channel added to DecisionVia later
 *  gets no sudo-approval power until it is named here. */
const PASSKEY_CLASS_VIA: ReadonlySet<ElevationVia> = new Set<ElevationVia>(['webauthn', 'access_passkey'])

export interface Outcome {
  status: 200 | 400 | 403 | 404 | 409 | 410 | 503
  title: string
  message: string
  tone: 'ok' | 'warn' | 'bad'
}

export const NOT_FOUND_OUTCOME: Outcome = { status: 404, title: 'Not found', message: 'There is nothing here for you.', tone: 'bad' }
const CLOSED: Outcome = { status: 409, title: 'Request closed', message: 'This request is no longer pending.', tone: 'warn' }

/** `ctx.waitUntil` of the hosting request, when there is one (tests and some callers have none). */
export type WaitUntil = (p: Promise<unknown>) => void

/**
 * Run `fn` to completion even if the client goes away: the promise is registered with waitUntil (errors swallowed
 * THERE, not in the returned promise) and the caller still awaits it for the response.
 */
export function durably<T>(waitUntil: WaitUntil | undefined, fn: () => Promise<T>): Promise<T> {
  const p = fn()
  if (waitUntil) waitUntil(p.then(() => undefined, () => undefined))
  return p
}

/** What a human sees for a seed request that is not pending any more. 'applied' is success, never "closed". */
export function closedSeedOutcome(row: SeedRequestRow): Outcome {
  if (row.status === 'applied') {
    return { status: 200, title: 'Approved', message: 'This request was already approved and the project was created. Nothing was granted: every request in the seed is still pending.', tone: 'ok' }
  }
  if (row.status === 'applying') {
    return { status: 409, title: 'Applying', message: 'This request is being applied right now. Reload in a moment.', tone: 'warn' }
  }
  return { status: 409, title: 'Request closed', message: row.status === 'pending' ? 'This request has expired.' : `This request is already ${row.status}.`, tone: 'warn' }
}

/** A single-use consume supplied by the channel; true iff THIS call consumed it. */
export type Gate = () => Promise<boolean>

export async function agentName(env: Env, agentId: string | null): Promise<string | null> {
  if (!agentId) return null
  const row = await env.DB.prepare('SELECT name FROM agents WHERE id = ?1').bind(agentId).first<{ name: string }>()
  return row?.name ?? null
}

// ── seed ────────────────────────────────────────────────────────────────────────────────────────

/** Accepting a seed's requests is an org-admin act (the same floor as seed_attach apply). */
export function mayDecideSeed(auth: AuthContext): boolean {
  return hasWorkspaceAdmin(auth)
}

function storedKeys(row: SeedRequestRow): string[] {
  try {
    const parsed: unknown = JSON.parse(row.requests_json)
    return Array.isArray(parsed) ? parsed.map((r: StoredRequest) => r.key).sort() : []
  } catch {
    return []
  }
}

/** The page body (inside the form) a human is shown for a seed request, or an outcome when the stored seed no longer validates. */
export async function seedViewInner(env: Env, row: SeedRequestRow): Promise<{ ok: true; inner: string } | { ok: false; outcome: Outcome }> {
  const v = await validateSeed(row.canonical_json)
  if (!v.ok) return { ok: false, outcome: { status: 409, title: 'Invalid request', message: 'The stored seed no longer validates.', tone: 'bad' } }
  const requests = await keyRequests(v.requests)
  const s: SeedV1 = v.seed
  const requester = await agentName(env, row.requester_agent_id)
  const items = requests.map((r) => `<li><code>${escapeHtml(r.key)}</code>: ${escapeHtml(renderRequest(r as SeedRequest))}</li>`).join('')
  const info = `<dl><dt>Project slug</dt><dd><code>${escapeHtml(s.slug)}</code></dd><dt>Kind</dt><dd>${escapeHtml(s.kind)}</dd>
<dt>Repo</dt><dd>${s.repo ? `<code>${escapeHtml(s.repo)}</code>` : 'none'}</dd><dt>Live URL</dt><dd>${s.live ? `<code>${escapeHtml(s.live)}</code>` : 'none'}</dd>
<dt>Seats requested</dt><dd>${s.wants?.seats ? escapeHtml(String(s.wants.seats.max)) : 'none'}</dd>
<dt>Filed by</dt><dd>${requester ? escapeHtml(requester) : 'a member'} (<code>${escapeHtml(row.requester_member_id)}</code>)</dd>
<dt>Expires</dt><dd>${escapeHtml(row.expires_at)}</dd><dt>Digest</dt><dd><code>${escapeHtml(row.seed_sha256)}</code></dd></dl>`
  const inner = `${info}<h2>What approving does</h2><p>Creates the project, its squad and seat cap. It <strong>grants nothing</strong>: every request below stays pending a separate human step.</p>
<h2>Requests the seed makes (${requests.length})</h2>${requests.length ? `<ul>${items}</ul>` : '<p class="muted">None.</p>'}
<h2>Written by the agent</h2>${untrustedBox('Project name', s.name)}${untrustedBox('Goal', s.goal)}`
  return { ok: true, inner }
}

/** The caller has already established liveness and that `auth` may decide seeds. */
export async function decideSeed(
  env: Env,
  input: { row: SeedRequestRow; decision: 'approve' | 'deny'; auth: AuthContext; proof: HumanProof; gate?: Gate; waitUntil?: WaitUntil },
  nowMs: number,
): Promise<Outcome> {
  const { row, decision, auth, proof } = input
  const consume = input.gate ?? (async () => true)
  if (decision === 'deny') {
    return durably(input.waitUntil, async () => {
      if (!(await consume())) return CLOSED
      const denied = await denySeedRequest(env, row, proof.memberId, proof.via, proof.evidence, nowMs)
      return denied
        ? { status: 200, title: 'Denied', message: 'The request was denied. Nothing was created.', tone: 'ok' } satisfies Outcome
        : CLOSED
    })
  }

  // Re-validate BEFORE consuming: the row must still be exactly what the human was shown.
  const v = await validateSeed(row.canonical_json)
  if (!v.ok || v.seedSha256 !== row.seed_sha256) {
    return { status: 409, title: 'Invalid request', message: 'The stored seed no longer matches its digest.', tone: 'bad' }
  }
  const keyed = await keyRequests(v.requests)
  const keys = keyed.map((r) => r.key).sort()
  const stored = storedKeys(row)
  if (keys.length !== stored.length || keys.some((k, i) => k !== stored[i])) {
    return { status: 409, title: 'Invalid request', message: 'The seed no longer produces the requests that were shown.', tone: 'bad' }
  }
  // The pure refusal applySeed would otherwise raise AFTER the claim (same predicate): a seed whose slug can never
  // be applied must not burn the link or close the request.
  if (!isValidSlugBase(v.seed.slug)) {
    return { status: 409, title: 'Not applied', message: 'This seed cannot be applied (seed_slug_not_applicable). Nothing was consumed; ask the agent to file a corrected seed.', tone: 'bad' }
  }

  return durably(input.waitUntil, async (): Promise<Outcome> => {
    if (!(await consume())) return CLOSED
    // The ONE consuming UPDATE on the request row. Losing it means another tab/tap/channel decided first.
    if (!(await claimSeedRequest(env, row.id, proof.memberId, nowMs, proof.via))) return CLOSED
    let outcome: Awaited<ReturnType<typeof applySeed>>
    try {
      outcome = await applySeed(
        env, auth, proof.memberId,
        { seed: v.seed, canonical: v.canonical, seedSha256: v.seedSha256, requests: keyed },
        keyed.map((r) => r.key), undefined,
        { via: proof.via, requestId: row.id, accessSub: proof.evidence.access_sub, momentId: proof.evidence.moment_id },
      )
    } catch {
      // Claimed but the apply threw: the row must not sit in 'applying' forever. Guarded UPDATE status='applying' -> 'failed'.
      await finishSeedRequest(env, row.id, { ok: false, error: 'apply_threw' })
      return { status: 409, title: 'Not applied', message: 'The seed could not be applied (apply_threw). The request is closed; ask the agent to file a new one.', tone: 'bad' }
    }
    try {
      await finishSeedRequest(env, row.id, outcome.ok ? { ok: true } : { ok: false, error: outcome.error })
    } catch {
      // The apply is done and receipted; only the status write failed. reconcileSeedRequest closes it on the next read.
    }
    if (!outcome.ok) {
      return { status: 409, title: 'Not applied', message: `The seed could not be applied (${outcome.error}). The request is closed; ask the agent to file a new one.`, tone: 'bad' }
    }
    if (outcome.result.replay === true) {
      return { status: 200, title: 'Already applied', message: 'This seed had already been applied earlier; nothing new was created. Nothing was granted: every request in the seed is still pending.', tone: 'ok' }
    }
    return { status: 200, title: 'Approved', message: 'The project was created. Nothing was granted: every request in the seed is still pending.', tone: 'ok' }
  })
}

// ── elevation ───────────────────────────────────────────────────────────────────────────────────

function parseActions(req: ElevationRequestRecord): string[] {
  try {
    const parsed: unknown = JSON.parse(req.requested_actions_json)
    return Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === 'string') : []
  } catch {
    return []
  }
}

export function elevationIsLive(req: ElevationRequestRecord, nowMs: number): boolean {
  return req.status === 'pending' && Date.parse(req.decision_expires_at) > nowMs
}

/** Does this member hold the authority to decide THIS request (scope-local, the existing predicate). */
export async function mayDecideElevation(env: Env, auth: AuthContext, req: ElevationRequestRecord): Promise<boolean> {
  // canDecideElevationRequest = the scope predicate PLUS "a request from an attached chat is decided by the human who attached it".
  return canDecideElevationRequest(env, auth, auth.capabilities, req, deciderMemberIdOf(auth))
}

export async function elevationViewInner(env: Env, req: ElevationRequestRecord): Promise<string> {
  const agent = await agentName(env, req.agent_id)
  const fromChat = await requestIsFromAttachedChat(env, req)
  const actions = parseActions(req)
  const boxes = actions.map((a) => {
    const def = ELEVATION_ACTIONS[a]
    const label = def?.label ?? a
    const note = def ? `${escapeHtml(def.description)} <span class="muted">(effect: ${escapeHtml(def.effect)}. ${escapeHtml(def.effectNote)})</span>` : ''
    return `<li><label class="choice"><input type="checkbox" name="actions" value="${escapeHtml(a)}" checked><span><strong>${escapeHtml(label)}</strong>${SENSITIVE_STEP_UP_ACTIONS.has(a) ? ' (sensitive)' : ''}<br>${note}</span></label></li>`
  }).join('')
  const durations = ELEVATION_DURATION_PRESETS_MINUTES.filter((m) => m <= req.requested_duration_minutes)
    .map((m) => `<option value="${m}"${m === req.requested_duration_minutes ? ' selected' : ''}>${m} minutes</option>`).join('')
  const exact = await exactCallLine(env, req)
  return `<dl><dt>Agent</dt><dd>${agent ? escapeHtml(agent) : '<span class="muted">unknown</span>'} (<code>${escapeHtml(req.agent_id)}</code>)</dd>
${fromChat ? `<dt>Requested from</dt><dd><strong>a CHAT attached to ${agent ? escapeHtml(agent) : 'this agent'}</strong> (sudo: only you, who attached it, can approve)</dd>` : ''}<dt>Scope</dt><dd>${escapeHtml(req.requested_scope_type)} <code>${escapeHtml(req.requested_scope_id || 'org-wide')}</code> (cannot be widened or changed here)</dd>
${exact ? `<dt>Exact call</dt><dd><strong>${escapeHtml(exact)}</strong></dd>` : ''}<dt>Decide by</dt><dd>${escapeHtml(req.decision_expires_at)}</dd></dl>
<h2>Actions (untick to narrow)</h2><ul class="choices">${boxes}</ul>
<h2>Duration (you can only shorten)</h2><select name="duration_minutes">${durations}</select>
<h2>Why the agent says it needs this</h2>${untrustedBox('Reason', req.reason)}`
}

async function writeElevationReceipt(
  env: Env, proof: ElevationProof, requestId: string, operation: string, evidence: Record<string, unknown>,
): Promise<boolean> {
  try {
    const nowIso = new Date().toISOString()
    await env.DB.prepare(
      `INSERT INTO mutation_audit_entries (
         id, tenant, principal_kind, principal_id, member_id, origin, handler, operation,
         target_kind, target_id, request_id, idempotency_key, evidence_json, recorded_at)
       VALUES (?1, ?2, 'member', ?3, ?3, 'admin_ui', ?9, ?4, 'elevation_request', ?5, ?6, ?6, ?7, ?8)
       ON CONFLICT DO NOTHING`,
    ).bind(
      crypto.randomUUID(), env.TENANT_SLUG, proof.memberId, operation, requestId, `access-elevation:${requestId}`,
      JSON.stringify({ via: proof.via, ...proof.evidence, ...evidence }), nowIso,
      proof.via === 'approval_bot' ? 'approval_bot' : receiptHandlerFor(proof.via),
    ).run()
    return true
  } catch {
    return false
  }
}

/** The approver's web session: the grant binds to it and ends when it does. */
export interface ApproverSession {
  auth: AuthContext
  webSessionHash: string
}

function refusalOutcome(result: Exclude<DecideElevationResult, { ok: true }>): Outcome {
  if (result.reason === 'not_found' || result.reason === 'forbidden') return NOT_FOUND_OUTCOME
  const detail = 'detail' in result ? ` (${result.detail})` : ''
  return { status: 409, title: 'Not decided', message: `The decision was not recorded: ${result.reason}${detail}.`, tone: 'warn' }
}

export async function decideElevation(
  env: Env,
  input: {
    id: string
    decision: 'approve' | 'deny'
    selectedActions: string[]
    durationMinutes: number | undefined
    auth: AuthContext
    proof: ElevationProof
    /** Mints the approver's web session. Called ONLY after the gate, so no session exists for a refused decision. */
    mintSession: () => Promise<ApproverSession>
    gate?: Gate
    waitUntil?: WaitUntil
  },
): Promise<Outcome> {
  const { id, decision, proof } = input
  // Authority BEFORE any write: unknown id and out-of-authority read identically, and a closed request is refused,
  // all before an approver web session exists. (decideElevationRequest re-checks everything atomically.)
  const pre = await loadElevationRequestById(env, env.TENANT_SLUG, id)
  if (!pre || !(await mayDecideElevation(env, input.auth, pre))) return NOT_FOUND_OUTCOME
  if (!elevationIsLive(pre, Date.now())) return CLOSED
  // sudo for attached chats: an APPROVE of a request from an attached chat needs a genuine passkey-class proof. Telegram's
  // device secret is attested only by the Telegram client and its channel proof is not a fresh passkey/reauth, so it may
  // DENY but never approve one (the channel adapters refuse earlier; this is the shared-core backstop).
  if (decision === 'approve' && !PASSKEY_CLASS_VIA.has(proof.via) && (await requestIsFromAttachedChat(env, pre))) {
    return { status: 403, title: 'Use a passkey', message: 'A request from an attached chat is approved with a passkey, not from Telegram. Open the approval link in your browser.', tone: 'warn' }
  }

  // Every refusable check, BEFORE the gate, through the very function decideElevationRequest runs. The session
  // hash is a placeholder here (the real one does not exist yet and no refusal reads it).
  const capabilities = input.auth.capabilities ?? (await resolveCapabilities(env, proof.memberId))
  const decideInput = (webSessionHash: string, caps: DecideElevationInput['decidedByCapabilities'], admin: boolean): DecideElevationInput => ({
    tenant: env.TENANT_SLUG,
    requestId: id,
    decision,
    selectedActions: decision === 'approve' ? input.selectedActions : undefined,
    durationMinutes: decision === 'approve' ? input.durationMinutes : undefined,
    decidedByMemberId: proof.memberId,
    decidedByCapabilities: caps,
    decidedByIsOrgAdmin: admin,
    decidedByWebSessionHash: webSessionHash,
    // The channel's fresh human proof (a just-completed Access login, a just-completed UV assertion) IS the step-up. The approval bot
    // is the one exception: a tap is NOT a fresh reauth in general, so it satisfies the step-up only for BOT_STEP_UP_ACTIONS.
    recentReauthOk: proof.via === 'approval_bot' ? input.selectedActions.every((a) => BOT_STEP_UP_ACTIONS.includes(a)) : true,
    decidedViaPasskey: PASSKEY_CLASS_VIA.has(proof.via),
    decidedViaAccess: proof.via === 'access_passkey',
    note: `via:${proof.via}`,
  })
  const refusal = await findElevationDecisionRefusal(env, decideInput('', capabilities, hasWorkspaceAdmin(input.auth)), pre)
  if (refusal) return refusalOutcome(refusal)

  return durably(input.waitUntil, async (): Promise<Outcome> => {
    if (input.gate && !(await input.gate())) return CLOSED
    // The grant (and the decision row) binds to a web session for this proof, minted now (after the gate; the
    // refusals are already cleared) for approve and deny alike.
    const session = await input.mintSession()
    const result = await decideElevationRequest(
      env, decideInput(session.webSessionHash, session.auth.capabilities ?? (await resolveCapabilities(env, proof.memberId)), hasWorkspaceAdmin(session.auth)),
    )
    if (!result.ok) {
      // Only a genuine race lands here (another channel decided between the checks and the write). The session
      // minted for it must not outlive a decision that never happened.
      await revokeWebSession(env, env.TENANT_SLUG, proof.memberId, session.webSessionHash, 'decision_not_recorded').catch(() => undefined)
      return refusalOutcome(result)
    }
    const receipted = await writeElevationReceipt(env, proof, id, decision === 'approve' ? 'elevation_approve' : 'elevation_deny', {
      request_id: id, decision,
      actions: result.grants.map((g) => g.action), scope_type: result.request.requested_scope_type, scope_id: result.request.requested_scope_id,
      expires_at: result.grants[0]?.expires_at ?? null,
    })
    const tail = receipted ? '' : ' The decision stands, but its audit receipt could not be written; tell the operator.'
    return decision === 'approve'
      ? { status: 200, title: 'Approved', message: `Granted ${result.grants.length} action${result.grants.length === 1 ? '' : 's'} until ${result.grants[0]?.expires_at ?? ''}.${tail}`, tone: 'ok' }
      : { status: 200, title: 'Denied', message: `The request was denied.${tail}`, tone: 'ok' }
  })
}
