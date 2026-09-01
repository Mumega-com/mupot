// src/dashboard/elevation.ts — Delivery Sequence step 5 ("UX convergence") for
// human-approved, session-bound agent elevation (mupot task f5fe1222,
// mumega-com#1173). Hadi, verbatim: "Fix the ability that I can make agents
// admin by a safe way and time limited. I will not give you token." Steps
// 1-4 built the ledger, the enforcement primitive, and a JSON API
// (src/auth/index.ts GET/POST /auth/elevation/*). There was still no page a
// human could open. This is that page — three views, no new authorization
// decision.
//
// SCOPE DISCIPLINE: this module is UI ONLY. Every mutation (approve, deny,
// revoke) is a same-origin, credentialed `fetch` to the EXISTING, already
// step-3/4-tested routes on authApp (POST /auth/elevation/requests/:id/decide,
// POST /auth/elevation/:id/revoke). Every read either reuses an exported
// elevation.ts function or runs a narrow, local, read-only SELECT for display
// labels (agent name, scope name, approver name) — exactly the pattern
// approvals.ts already uses for the gate queue. No new write path, no second
// copy of hasElevatedAction/decideElevationRequest's business logic.
//
// HUMAN-ONLY, STRUCTURALLY: this app is mounted onto dashboardApp
// (src/dashboard/index.ts), which is gated by `requireAuth` — a re-export of
// authApp's own `requireAuthMw()`. That middleware calls loadAuthFromCookie,
// which reads ONLY the `mupot_session` HttpOnly cookie
// (`getCookie(c, COOKIE_NAME)`) — there is no branch anywhere in that
// function that inspects an Authorization header or any bearer token. An
// agent-bound credential therefore has no argument channel to reach these
// routes at all: not "checked and rejected", but structurally absent from
// the code path, the same standard step 2's end_agent_session met for
// caller-supplied session ids. See tests/elevation-dashboard.test.ts for the
// adversarial proof (a request carrying a well-formed Authorization: Bearer
// header and no cookie is redirected to /auth/login exactly like an
// unauthenticated one).
//
// VISIBILITY MATCHES THE JSON API'S OWN GATE: a dashboard login only carries
// `auth.webSessionMemberId` when it is role==='member' AND bridged by
// verified email to a `members` row (see auth/index.ts's loadAuthFromCookie
// comment — this is deliberate: attaching a member-shaped capability set to
// a legacy owner/admin role would disable that role's own escape hatch). A
// caller without that bridge sees NOTHING here — same as the existing GET
// /auth/elevation/requests and /elevation/active JSON routes already
// enforce. Rather than a bare empty list (which would look identical to
// "nothing pending" and hide WHY), this module renders an explicit
// notBridgedBody() explanation. That is this surface's answer to the
// "explain, never omit" requirement below, at the account level.
//
// EXPLAIN, NEVER OMIT (defect #1162): the live bug this must not repeat is
// an ineligible agent going missing from a consent screen with no reason, so
// an operator cannot tell "not minted" from "does not exist" from "no
// capability" — one silence, three different remedies. This module's
// pending-requests and live-grants pages therefore NEVER silently filter a
// row the caller cannot act on: every request/grant outside the caller's own
// admin authority is still counted and named by scope in an "Outside your
// authority" panel, with the remedy ("ask an admin on <scope>") spelled out.
// What is deliberately NOT done: leaking the FULL detail (agent identity,
// reason text, exact actions) of an out-of-scope row to an operator who
// cannot act on it — that would trade one defect (silent absence) for
// another (over-disclosure across scopes within the same tenant). The
// aggregate (scope name + count) is the minimum that satisfies "never
// silently absent" without also being a new cross-scope information leak.
//
// THE FROZEN EFFECT (the single most important rendering rule in this
// module): elevation_grants.effect is a COPY of the action's
// reversible/revocable_if_recorded/irreversible classification taken at
// GRANT time (migration 0142's header comment, decideElevationRequest in
// ../auth/elevation.ts). The live-grants view renders `grant.effect` — the
// frozen column — and NEVER calls elevationActionEffect()/reads
// ELEVATION_ACTIONS[action].effect for an already-granted row. A future edit
// to the registry must not retroactively relabel what an approver already
// saw and clicked. The pending-request and approval-screen views, by
// contrast, have NO grant yet to freeze — there `ELEVATION_ACTIONS[key]` is
// the only value that exists, exactly like the existing JSON API's GET
// /auth/elevation/requests route already does. See
// tests/elevation-dashboard.test.ts for a mutation-style test that inserts a
// grant row whose stored `effect` deliberately disagrees with the registry's
// current classification for that action, and asserts the page renders the
// STORED value.

import { Hono } from 'hono'
import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import type { AuthContext, CapabilityGrant, CapabilityScopeType, Env } from '../types'
import { hasCapability, resolveCapabilities } from '../auth/capability'
import {
  listPendingElevationRequests,
  loadElevationRequestById,
  listActiveElevationGrants,
  resolveScopeDepartmentId,
  type ElevationRequestRecord,
  type ElevationGrantRecord,
} from '../auth/elevation'
import {
  ELEVATION_ACTIONS,
  ELEVATION_DURATION_PRESETS_MINUTES,
  SENSITIVE_STEP_UP_ACTIONS,
  type ElevationActionEffect,
} from '../auth/elevation-actions'
import { hasRecentReauth, loadWebSessionByHash } from '../auth/web-sessions'
import { evaluateAgentSession, loadAgentSessionById, type AgentSessionRecord } from '../auth/agent-sessions'
import { pageHeader, sectionPanel, pill, statusDot, emptyState, type Html, type Tone } from './ui'

type ShellFn = (
  env: Env,
  title: string,
  body: HtmlEscapedString | Promise<HtmlEscapedString>,
) => HtmlEscapedString | Promise<HtmlEscapedString>

// ── small display-only data loaders (read-only, local — mirrors approvals.ts) ──

async function loadAgentLabel(env: Env, agentId: string): Promise<{ id: string; slug: string; name: string } | null> {
  const row = await env.DB.prepare(`SELECT id, slug, name FROM agents WHERE id = ?1`)
    .bind(agentId)
    .first<{ id: string; slug: string; name: string }>()
  return row ?? null
}

async function loadMemberLabel(env: Env, memberId: string): Promise<string> {
  const row = await env.DB.prepare(`SELECT display_name FROM members WHERE id = ?1`)
    .bind(memberId)
    .first<{ display_name: string }>()
  return row?.display_name ?? memberId
}

async function loadScopeLabel(env: Env, scopeType: CapabilityScopeType, scopeId: string): Promise<string> {
  if (scopeType === 'org') return 'Whole organization'
  if (!scopeId) return scopeType === 'department' ? 'Department (unspecified)' : 'Squad (unspecified)'
  if (scopeType === 'department') {
    const row = await env.DB.prepare(`SELECT name FROM departments WHERE id = ?1`).bind(scopeId).first<{ name: string }>()
    return row ? `Department: ${row.name}` : `Department ${scopeId}`
  }
  const row = await env.DB.prepare(
    `SELECT s.name AS squad_name, d.name AS dept_name FROM squads s LEFT JOIN departments d ON d.id = s.department_id WHERE s.id = ?1`,
  )
    .bind(scopeId)
    .first<{ squad_name: string; dept_name: string | null }>()
  return row ? `Squad: ${row.squad_name}${row.dept_name ? ` (${row.dept_name})` : ''}` : `Squad ${scopeId}`
}

function formatMinutes(min: number): string {
  if (min < 60) return `${String(min)} minute${min === 1 ? '' : 's'}`
  if (min % 60 === 0) {
    const hours = min / 60
    return `${String(hours)} hour${hours === 1 ? '' : 's'}`
  }
  // Not an exact hour multiple (e.g. Hadi's 1446-minute duration) — state
  // the real minute count and add a rounded, explicitly-approximate hour
  // count in parens rather than a decimal that reads as false precision.
  const approxHours = Math.round(min / 60)
  return `${String(min)} minutes (~${String(approxHours)} hours)`
}

function formatWhen(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ') + ' UTC'
}

// ── operator context: mirrors the exact gate GET /auth/elevation/* already
//    enforces (auth.webSessionMemberId only — see module header) ──────────

interface OperatorContext {
  memberId: string | null
  capabilities: CapabilityGrant[]
}

async function loadOperatorContext(env: Env, auth: AuthContext): Promise<OperatorContext> {
  if (!auth.webSessionMemberId) return { memberId: null, capabilities: [] }
  const capabilities = auth.capabilities ?? (await resolveCapabilities(env, auth.webSessionMemberId))
  return { memberId: auth.webSessionMemberId, capabilities }
}

async function operatorIsAdminOnScope(
  env: Env,
  capabilities: CapabilityGrant[],
  scopeType: CapabilityScopeType,
  scopeId: string,
): Promise<boolean> {
  const deptId = await resolveScopeDepartmentId(env, scopeType, scopeId)
  return hasCapability(capabilities, scopeType, scopeId || null, 'admin', deptId)
}

function notBridgedBody(): Html {
  return html`
    ${pageHeader({
      crumbs: 'Overview / Elevation',
      title: 'Elevation',
      sub: 'Agents asking for temporary, named access.',
    })}
    ${emptyState({
      title: 'This login is not linked to a member identity',
      detail:
        'Elevation requests and grants are only shown to members holding an admin capability grant on the relevant scope. Your dashboard session has no linked member identity, so nothing can be shown or decided here — this is not the same as "nothing pending".',
      hint: 'Ask an existing admin to add your email as a member with an admin capability grant on the org, a department, or a squad, then sign in again.',
    })}`
}

// ── effect rendering (see module header — this is THE unmissable part) ─────

const EFFECT_TONE: Record<ElevationActionEffect, Tone> = {
  reversible: 'ok',
  revocable_if_recorded: 'warn',
  irreversible: 'danger',
}

const EFFECT_LABEL: Record<ElevationActionEffect, string> = {
  reversible: 'Reversible after expiry',
  revocable_if_recorded: 'Recoverable — only if recorded',
  irreversible: 'PERMANENT — cannot be undone',
}

function effectBadge(effect: ElevationActionEffect): Html {
  return pill(EFFECT_LABEL[effect], EFFECT_TONE[effect])
}

/** The banner every screen that can lead to a grant must show, worded from
 *  the effect(s) actually in play — NEVER a tooltip, always in the flow of
 *  the page. "A time limit on the grant is NOT a time limit on its
 *  consequences" is the literal requirement from the task brief. */
function expiryIsNotUndoBanner(hasIrreversible: boolean): Html {
  if (!hasIrreversible) {
    return html`<div class="card" style="border-left:3px solid var(--warn,#ca8a04);background:var(--surface2);padding:12px 16px;margin:14px 0;font-size:13.5px;">
      <strong>A time limit on this grant is not a time limit on its consequences.</strong>
      Everything done while it was active still happened after it expires — the clock only stops
      <em>future</em> access. What each action below leaves behind, and whether standing authority can
      undo it later, is noted per action.
    </div>`
  }
  return html`<div class="card" style="border-left:4px solid var(--danger,#c0392b);background:var(--surface2);padding:14px 18px;margin:14px 0;font-size:13.5px;">
    <strong style="color:var(--danger,#c0392b);">One or more of these actions is PERMANENT.</strong>
    A time limit on this grant is not a time limit on its consequences. When it expires, the agent's
    access ends — but an irreversible action already taken under it does not undo itself. This codebase
    has no key-rotation or migration-rollback primitive today; approving a permanent action here is
    final, no matter how short a duration you choose.
  </div>`
}

// ── "outside your authority" — the explain-never-omit panel shared by the
//    pending-requests and live-grants list pages ──────────────────────────

interface OutOfScopeGroup {
  label: string
  count: number
}

function outOfScopePanel(items: OutOfScopeGroup[], kind: string): Html {
  if (items.length === 0) return html``
  return sectionPanel({
    title: 'Outside your authority',
    body: html`
      <p style="color:var(--dim);font-size:13px;margin:0 0 10px;">
        These exist — they are not hidden from you because nothing is pending. You do not hold admin
        authority on their scope, so this page cannot show their detail or let you decide them.
      </p>
      <ul style="margin:0;padding-left:18px;">
        ${items.map(
          (i) =>
            html`<li>${String(i.count)} ${kind}${i.count === 1 ? '' : 's'} on <strong>${i.label}</strong> —
              ask an admin there.</li>`,
        )}
      </ul>`,
  })
}

async function splitByOperatorScope<T>(
  env: Env,
  ctx: OperatorContext,
  rows: T[],
  scopeOf: (row: T) => { scopeType: CapabilityScopeType; scopeId: string },
): Promise<{ visible: T[]; outOfScope: OutOfScopeGroup[] }> {
  const visible: T[] = []
  const outOfScope: OutOfScopeGroup[] = []
  const indexByKey = new Map<string, number>()
  for (const row of rows) {
    const { scopeType, scopeId } = scopeOf(row)
    const ok = ctx.memberId ? await operatorIsAdminOnScope(env, ctx.capabilities, scopeType, scopeId) : false
    if (ok) {
      visible.push(row)
      continue
    }
    const key = `${scopeType}:${scopeId}`
    const existingIdx = indexByKey.get(key)
    if (existingIdx === undefined) {
      const label = await loadScopeLabel(env, scopeType, scopeId)
      indexByKey.set(key, outOfScope.length)
      outOfScope.push({ label, count: 1 })
    } else {
      outOfScope[existingIdx].count += 1
    }
  }
  return { visible, outOfScope }
}

// ── Screen 1: GET /elevation — pending requests ─────────────────────────────

async function renderPendingRequestCard(env: Env, r: ElevationRequestRecord): Promise<Html> {
  const [agent, scopeLabel, session] = await Promise.all([
    loadAgentLabel(env, r.agent_id),
    loadScopeLabel(env, r.requested_scope_type, r.requested_scope_id),
    loadAgentSessionById(env, env.TENANT_SLUG, r.agent_session_id),
  ])
  const sessionLive = session ? evaluateAgentSession(session).ok : false
  const actions: string[] = JSON.parse(r.requested_actions_json)
  const hasIrreversible = actions.some((a) => ELEVATION_ACTIONS[a]?.effect === 'irreversible')

  return sectionPanel({
    title: `${agent?.name ?? r.agent_id} — ${formatMinutes(r.requested_duration_minutes)} requested`,
    right: hasIrreversible ? pill('Includes a PERMANENT action', 'danger') : undefined,
    body: html`
      <div style="display:flex;flex-wrap:wrap;gap:14px;font-size:13px;color:var(--text2);margin-bottom:10px;">
        <span>${statusDot(sessionLive ? 'ok' : 'dim', sessionLive ? 'session live' : 'session not live')}</span>
        <span>Scope: ${scopeLabel}</span>
        <span>Asked ${formatWhen(r.created_at)}</span>
        <span>Decision window ends ${formatWhen(r.decision_expires_at)}</span>
      </div>
      <p style="margin:6px 0;"><strong>Reason given:</strong> ${r.reason}</p>
      <div style="margin:8px 0;">
        ${actions.map((a) => {
          const def = ELEVATION_ACTIONS[a]
          return html`<div style="margin:4px 0;">${def ? effectBadge(def.effect) : ''} <strong>${def?.label ?? a}</strong></div>`
        })}
      </div>
      <a class="btn" href="/elevation/${r.id}">Review this request</a>
    `,
  })
}

export async function pendingRequestsBody(env: Env, auth: AuthContext): Promise<Html> {
  const ctx = await loadOperatorContext(env, auth)
  if (!ctx.memberId) return notBridgedBody()

  const all = await listPendingElevationRequests(env, env.TENANT_SLUG)
  const { visible, outOfScope } = await splitByOperatorScope(env, ctx, all, (r) => ({
    scopeType: r.requested_scope_type,
    scopeId: r.requested_scope_id,
  }))
  const cards = await Promise.all(visible.map((r) => renderPendingRequestCard(env, r)))

  return html`
    ${pageHeader({
      crumbs: 'Overview / Elevation',
      title: 'Elevation requests',
      sub: 'An agent asked for named actions on a scope, for its exact current session, for a bounded time. Nothing is granted until you decide.',
      badge: visible.length ? `${String(visible.length)} awaiting your decision` : 'Nothing waiting',
      badgeTone: visible.length ? 'warn' : 'ok',
      right: html`<a class="btn secondary" href="/elevation/grants">Active elevations →</a>`,
    })}
    ${visible.length
      ? cards
      : html`<div class="card"><p class="empty">No pending elevation requests on scopes you administer.</p></div>`}
    ${outOfScopePanel(outOfScope, 'pending elevation request')}
  `
}

// ── Screen 2: GET /elevation/:id — the approval screen ──────────────────────

function agentSessionSummary(session: AgentSessionRecord | null): Html {
  if (!session) {
    return html`<p style="color:var(--dim);">No runtime session record found for this request — it may predate session tracking, or the migration is not applied on this environment.</p>`
  }
  const evalResult = evaluateAgentSession(session)
  const tone: Tone = evalResult.ok ? 'ok' : 'dim'
  const label = evalResult.ok ? 'live' : !evalResult.ok && 'reason' in evalResult ? evalResult.reason : 'not live'
  return html`
    <div style="display:flex;flex-wrap:wrap;gap:14px;font-size:13px;color:var(--text2);">
      <span>${statusDot(tone, String(label))}</span>
      <span>Auth kind: ${session.auth_kind}</span>
      ${session.seat ? html`<span>Seat: ${session.seat}</span>` : ''}
      <span>Session started ${formatWhen(session.created_at)}</span>
      <span>Last seen ${formatWhen(session.last_seen_at)}</span>
    </div>`
}

function actionChecklist(actions: string[]): Html {
  return html`
    <fieldset style="border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin:10px 0;">
      <legend style="padding:0 6px;font-size:12.5px;color:var(--dim);">
        Tick which of the REQUESTED actions to allow. You may remove any; you cannot add anything the agent
        did not ask for — there is no control for that on this page.
      </legend>
      ${actions.map((a) => {
        const def = ELEVATION_ACTIONS[a]
        return html`
          <label style="display:flex;gap:10px;align-items:flex-start;margin:10px 0;">
            <input type="checkbox" name="actions" value="${a}" checked style="margin-top:3px;" />
            <span>
              <strong>${def?.label ?? a}</strong> ${def ? effectBadge(def.effect) : ''}
              <div style="font-size:12.5px;color:var(--dim);">${def?.description ?? ''}</div>
              ${def ? html`<div style="font-size:12px;color:var(--text2);margin-top:2px;">${def.effectNote}</div>` : ''}
            </span>
          </label>`
      })}
    </fieldset>`
}

function decideScript(requestId: string): Html {
  return raw(`
    <script>
      (function () {
        var form = document.getElementById('decide-form');
        if (!form) return;
        var status = document.getElementById('decide-status');
        function setBusy(busy) {
          form.querySelectorAll('button').forEach(function (b) { b.disabled = busy; });
        }
        async function decide(decision) {
          var fd = new FormData(form);
          var body = { decision: decision };
          if (decision === 'approve') {
            body.actions = fd.getAll('actions');
            body.duration_minutes = Number(fd.get('duration_minutes'));
            if (!body.actions.length) {
              status.textContent = 'Select at least one action, or use Deny.';
              return;
            }
          }
          var note = String(fd.get('note') || '').trim();
          if (note) body.note = note;
          setBusy(true);
          status.textContent = decision === 'approve' ? 'Approving…' : 'Denying…';
          try {
            var res = await fetch('/auth/elevation/requests/${requestId}/decide', {
              method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body)
            });
            var data = await res.json().catch(function () { return {}; });
            if (res.ok && data.ok) {
              status.textContent = decision === 'approve'
                ? 'Approved. Access is live now for this exact agent session.'
                : 'Denied. No access was granted.';
              setBusy(true);
              setTimeout(function () { window.location.href = '/elevation'; }, 1200);
            } else if (data.reason === 'reauth_required') {
              status.innerHTML = 'Your identity check has expired — this includes a sensitive action. ' +
                '<a href="/auth/reauth">Step up now</a>, then come back to this page and try again.';
              setBusy(false);
            } else {
              status.textContent = 'Could not decide: ' + (data.reason || data.error || res.status);
              setBusy(false);
            }
          } catch (e) {
            status.textContent = 'Network error — try again.';
            setBusy(false);
          }
        }
        form.addEventListener('submit', function (e) { e.preventDefault(); decide('approve'); });
        var denyBtn = document.getElementById('deny-btn');
        if (denyBtn) denyBtn.addEventListener('click', function () { decide('deny'); });
      })();
    </script>`)
}

export async function approvalBody(env: Env, auth: AuthContext, requestId: string): Promise<Html> {
  const ctx = await loadOperatorContext(env, auth)
  if (!ctx.memberId) return notBridgedBody()

  const request = await loadElevationRequestById(env, env.TENANT_SLUG, requestId)
  if (!request) {
    return html`
      ${pageHeader({ crumbs: 'Overview / Elevation', title: 'Request not found' })}
      ${emptyState({
        title: 'Not found',
        detail: 'This elevation request does not exist, is on a different tenant, or its decision window already lapsed and it was cleared.',
      })}
      <p><a href="/elevation">← Back to pending requests</a></p>`
  }

  const eligible = await operatorIsAdminOnScope(env, ctx.capabilities, request.requested_scope_type, request.requested_scope_id)
  const scopeLabel = await loadScopeLabel(env, request.requested_scope_type, request.requested_scope_id)

  if (!eligible) {
    return html`
      ${pageHeader({ crumbs: 'Overview / Elevation', title: 'Outside your authority' })}
      ${emptyState({
        title: 'You do not hold admin authority on this scope',
        detail: `This request exists — it is not hidden because there is nothing pending — but its scope (${scopeLabel}) is outside what you administer, so this page will not show its detail.`,
        hint: 'Ask an admin on that scope to review it, or ask them to grant you admin there.',
      })}
      <p><a href="/elevation">← Back to pending requests</a></p>`
  }

  if (request.status !== 'pending') {
    return html`
      ${pageHeader({ crumbs: 'Overview / Elevation', title: 'Already decided' })}
      ${emptyState({
        title: `This request is ${request.status}`,
        detail: request.decided_at
          ? `Decided ${formatWhen(request.decided_at)}${request.decision_note ? ` — note: ${request.decision_note}` : ''}.`
          : 'No further action is possible on this request.',
        hint: 'Live grants are on the Active elevations page.',
      })}
      <p><a href="/elevation">← Back to pending requests</a> · <a href="/elevation/grants">Active elevations →</a></p>`
  }

  const [agent, session] = await Promise.all([
    loadAgentLabel(env, request.agent_id),
    loadAgentSessionById(env, env.TENANT_SLUG, request.agent_session_id),
  ])
  const actions: string[] = JSON.parse(request.requested_actions_json)
  const hasIrreversible = actions.some((a) => ELEVATION_ACTIONS[a]?.effect === 'irreversible')
  const needsStepUp = actions.some((a) => SENSITIVE_STEP_UP_ACTIONS.has(a))
  const durationOptions = ELEVATION_DURATION_PRESETS_MINUTES.filter((m) => m <= request.requested_duration_minutes)

  let reauthOk = false
  if (auth.webSessionIdHash) {
    const webSession = await loadWebSessionByHash(env, env.TENANT_SLUG, auth.webSessionIdHash)
    reauthOk = webSession ? hasRecentReauth(webSession) : false
  }

  return html`
    ${pageHeader({
      crumbs: 'Overview / Elevation',
      title: `Review — ${agent?.name ?? request.agent_id}`,
      sub: 'Approving may only remove actions or shorten the duration below. There is no control anywhere on this page to add anything, extend the time, or change the scope.',
    })}
    ${expiryIsNotUndoBanner(hasIrreversible)}

    ${sectionPanel({
      title: '1–2. Tenant and exact agent session',
      body: html`
        <p style="margin:4px 0;font-size:13px;color:var(--text2);">Tenant: <strong>${env.TENANT_SLUG}</strong></p>
        <p style="margin:4px 0;">Agent: <strong>${agent?.name ?? request.agent_id}</strong>${agent?.slug ? html` <span style="color:var(--dim);">(${agent.slug})</span>` : ''}</p>
        ${agentSessionSummary(session)}
      `,
    })}

    ${sectionPanel({
      title: '3. What it is asking, and why',
      body: html`
        <p style="margin:4px 0;"><strong>Reason given:</strong> ${request.reason}</p>
        ${actionChecklist(actions)}
      `,
    })}

    ${sectionPanel({
      title: '4. Narrowest scope and duration',
      body: html`
        <p style="margin:4px 0;">Scope (fixed — cannot be widened or changed here): <strong>${scopeLabel}</strong></p>
        <label style="display:block;margin:10px 0;">Duration — may only be shortened, never extended past what was requested (${formatMinutes(request.requested_duration_minutes)})
          <select name="duration_minutes" form="decide-form" style="display:block;margin-top:4px;">
            ${durationOptions.map(
              (m) => html`<option value="${String(m)}"${m === request.requested_duration_minutes ? raw(' selected') : ''}>${formatMinutes(m)}</option>`,
            )}
          </select>
        </label>
      `,
    })}

    ${sectionPanel({
      title: '5. What ends the access',
      body: html`
        <p style="margin:4px 0;font-size:13px;color:var(--text2);">
          Whichever comes first: the duration you choose below expires; this exact agent session ends or is
          revoked; you sign out or revoke this grant from the Active elevations page; or you lose admin
          authority on this scope. Closing a browser tab is not one of these — it does nothing on its own.
        </p>
      `,
    })}

    ${needsStepUp
      ? html`<div class="card" style="border-left:3px solid ${raw(reauthOk ? 'var(--ok,#16a34a)' : 'var(--warn,#ca8a04)')};padding:10px 14px;margin:12px 0;font-size:13px;">
          ${reauthOk
            ? html`Identity recently verified — you may approve the sensitive action(s) in this request.`
            : html`This request includes a sensitive action. Approving it needs a fresh identity check.
                <a href="/auth/reauth">Step up now</a>, then return to this page.`}
        </div>`
      : ''}

    <form id="decide-form" class="adminform">
      <label>Note (optional — recorded on the decision)
        <textarea name="note" rows="2" style="width:100%;"></textarea>
      </label>
      <div class="modal-actions" style="margin-top:10px;display:flex;gap:10px;">
        <button type="submit" class="btn">Approve narrowed access</button>
        <button type="button" class="btn secondary" id="deny-btn">Deny</button>
      </div>
      <div id="decide-status" class="status-line" style="margin-top:8px;"></div>
    </form>
    ${decideScript(request.id)}
    <p><a href="/elevation">← Back to pending requests</a></p>
  `
}

// ── Screen 3: GET /elevation/grants — live grants + usage + revoke ──────────

function grantsScript(): Html {
  return raw(`
    <script>
      (function () {
        document.querySelectorAll('[data-action="revoke"]').forEach(function (btn) {
          btn.addEventListener('click', async function () {
            var id = btn.getAttribute('data-grant');
            var status = document.getElementById('status-' + id);
            btn.disabled = true;
            if (status) status.textContent = 'revoking…';
            try {
              var res = await fetch('/auth/elevation/' + encodeURIComponent(id) + '/revoke', {
                method: 'POST', credentials: 'same-origin'
              });
              var data = await res.json().catch(function () { return {}; });
              if (res.ok && data.revoked) {
                if (status) status.textContent = 'Revoked. This session lost the access immediately.';
                var panel = document.getElementById('grant-' + id);
                if (panel) panel.style.opacity = '0.55';
              } else {
                if (status) status.textContent = 'Revoke failed (' + (data.error || res.status) + ').';
                btn.disabled = false;
              }
            } catch (e) {
              if (status) status.textContent = 'Network error — try again.';
              btn.disabled = false;
            }
          });
        });
        document.querySelectorAll('[data-action="usage"]').forEach(function (btn) {
          btn.addEventListener('click', async function () {
            var id = btn.getAttribute('data-grant');
            var panel = document.getElementById('usage-' + id);
            if (!panel) return;
            if (!panel.hidden) { panel.hidden = true; return; }
            panel.hidden = false;
            panel.textContent = 'loading…';
            try {
              var res = await fetch('/auth/elevation/' + encodeURIComponent(id) + '/usage', { credentials: 'same-origin' });
              var data = await res.json().catch(function () { return { usage: [] }; });
              panel.textContent = '';
              var list = data.usage || [];
              if (!list.length) { panel.textContent = 'No recorded usage yet.'; return; }
              var ul = document.createElement('ul');
              list.forEach(function (u) {
                var li = document.createElement('li');
                var bits = [(u.occurred_at || ''), (u.tool_name || u.action || '')];
                if (u.detail) { try { bits.push(JSON.stringify(u.detail)); } catch (e) {} }
                li.textContent = bits.join(' — ');
                ul.appendChild(li);
              });
              panel.appendChild(ul);
            } catch (e) { panel.textContent = 'failed to load usage'; }
          });
        });
      })();
    </script>`)
}

async function renderGrantCard(env: Env, g: ElevationGrantRecord): Promise<Html> {
  const session = await loadAgentSessionById(env, env.TENANT_SLUG, g.agent_session_id)
  const [agent, approver, scopeLabel] = await Promise.all([
    session ? loadAgentLabel(env, session.agent_id) : Promise.resolve(null),
    loadMemberLabel(env, g.approved_by_member_id),
    loadScopeLabel(env, g.scope_type, g.scope_id),
  ])
  const def = ELEVATION_ACTIONS[g.action]
  const remainingMs = Date.parse(g.expires_at) - Date.now()
  const remaining = remainingMs > 0 ? formatMinutes(Math.max(1, Math.round(remainingMs / 60000))) : 'expiring'

  return html`<div id="grant-${g.id}">
    ${sectionPanel({
      title: `${agent?.name ?? '(agent)'} — ${def?.label ?? g.action}`,
      // FROZEN effect — g.effect is the column written at grant time
      // (decideElevationRequest), never ELEVATION_ACTIONS[g.action].effect.
      // See module header "THE FROZEN EFFECT".
      right: effectBadge(g.effect),
      body: html`
        <div style="display:flex;flex-wrap:wrap;gap:14px;font-size:13px;color:var(--text2);margin-bottom:8px;">
          <span>Scope: ${scopeLabel}</span>
          <span>Approved by ${approver} at ${formatWhen(g.created_at)}</span>
          <span>Expires ${formatWhen(g.expires_at)} (${remaining} remaining)</span>
        </div>
        <button class="btn danger" data-grant="${g.id}" data-action="revoke">Revoke now</button>
        <button class="btn secondary" data-grant="${g.id}" data-action="usage">View usage</button>
        <div class="status-line" id="status-${g.id}"></div>
        <div id="usage-${g.id}" hidden style="margin-top:8px;font-size:12.5px;color:var(--text2);"></div>
      `,
    })}
  </div>`
}

export async function activeGrantsBody(env: Env, auth: AuthContext): Promise<Html> {
  const ctx = await loadOperatorContext(env, auth)
  if (!ctx.memberId) return notBridgedBody()

  const all = await listActiveElevationGrants(env, env.TENANT_SLUG)
  const { visible, outOfScope } = await splitByOperatorScope(env, ctx, all, (g) => ({
    scopeType: g.scope_type,
    scopeId: g.scope_id,
  }))
  const cards = await Promise.all(visible.map((g) => renderGrantCard(env, g)))

  return html`
    ${pageHeader({
      crumbs: 'Overview / Elevation',
      title: 'Active elevations',
      sub: 'Every currently-live temporary grant on scopes you administer. Revoking here ends access on this exact agent session immediately.',
      badge: visible.length ? `${String(visible.length)} live` : 'None live',
      badgeTone: visible.length ? 'warn' : 'ok',
      right: html`<a class="btn secondary" href="/elevation">Pending requests →</a>`,
    })}
    ${visible.length ? cards : html`<div class="card"><p class="empty">No active elevations on scopes you administer.</p></div>`}
    ${outOfScopePanel(outOfScope, 'active elevation grant')}
    ${visible.length ? grantsScript() : ''}
  `
}

// ── Hono sub-app (factory to avoid the shell circular import — same pattern
//    as mission-control-routes.ts's makeMissionControlApp) ──────────────────

export function makeElevationApp(shell: ShellFn) {
  const app = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>()

  app.get('/elevation/grants', async (c) => {
    const body = await activeGrantsBody(c.env, c.get('auth'))
    return c.html(shell(c.env, 'Active elevations', body))
  })

  app.get('/elevation', async (c) => {
    const body = await pendingRequestsBody(c.env, c.get('auth'))
    return c.html(shell(c.env, 'Elevation requests', body))
  })

  app.get('/elevation/:id', async (c) => {
    const body = await approvalBody(c.env, c.get('auth'), c.req.param('id'))
    return c.html(shell(c.env, 'Review elevation request', body))
  })

  return app
}
