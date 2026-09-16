// src/dashboard/account.ts — "My Account": the last blocker of the Telegram
// decision pilot (project telegram-decision-pilot). Before this page, binding
// a member's own Telegram identity required a raw POST /api/members/invites
// call from the browser console (mupot#1407/#1411 built the invite + redeem +
// unbind machinery; nothing rendered it for a human).
//
// SCOPE DISCIPLINE (mirrors src/dashboard/elevation.ts's module header): this
// module is UI ONLY, over EXISTING, already-gated routes:
//   - Connect  -> POST /api/members/invites            (src/members/index.ts)
//   - Disconnect -> DELETE /api/members/members/:id/telegram (src/members/index.ts)
// Both are same-origin, credentialed `fetch` calls from client-side script —
// no new write path, no second copy of createProjectInvite's or the unbind
// route's authorization logic. This file adds exactly ONE read-only view
// (loadConnectableSquads) to populate a picker from data the caller could
// already see through other admin surfaces.
//
// AUTHZ — NO NEW PREDICATE, and this is a real, load-bearing constraint, not
// a simplification: createProjectInvite's member-bind path (member_id set)
// requires the ACTOR to hold ORG-scope admin+ standing
// (actorRankOnScopeFor(env, auth, 'org', null) — see project-invites.ts's
// P0-1 comment). Self-exemption (exceedsTargetRankCeiling) only ever waives
// the TARGET ceiling for a self-bind, never that org-admin mint floor. So an
// ordinary member with no org-scope grant CANNOT self-connect Telegram via
// this route today, full stop — that is the existing design, not a bug this
// page works around. This page reflects that honestly: it renders the
// interactive Connect flow only once the viewer's own org rank already
// clears the mint floor, and otherwise shows a plain "ask an admin" state —
// never a button wired to a request the server is guaranteed to refuse. The
// self-only restriction on WHO the invite targets is a UI convenience, not
// the security boundary: the member_id sent is always the viewer's own
// server-rendered auth.memberId (never client-suppliable), but even a
// tampered request is still fully re-checked server-side by
// createProjectInvite's existing ceiling — this page adds no new trust.
//
// EXPLAIN, NEVER OMIT (defect #1162, same standard as elevation.ts): a
// member below the mint floor, a login with no bridged member row, and a
// pot with no active project/squad at all each get their OWN honest empty
// state — never a silently blank or crashing page.

import { Hono } from 'hono'
import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import type { AuthContext, Capability, Env } from '../types'
import { actorRankOnScopeFor, capabilityRank } from '../auth/capability'
import { MEMBER_BIND_MINT_FLOOR } from '../members/project-invites'
import { getTelegramBotUsername } from '../channels/adapters/telegram'
import { pageHeader, sectionPanel, pill, emptyState, type Html } from './ui'

type ShellFn = (
  env: Env,
  title: string,
  body: HtmlEscapedString | Promise<HtmlEscapedString>,
) => HtmlEscapedString | Promise<HtmlEscapedString>

type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } }

// v1 fixed expiry — matches the brief's default; not user-configurable yet.
const CONNECT_INVITE_EXPIRES_SECONDS = 24 * 60 * 60

// ── presentation-only rank <-> capability mapping ────────────────────────────
// NOT a new authorization rule: this only picks a sane DEFAULT capability to
// suggest in the request body. createProjectInvite independently re-derives
// and enforces its own ceiling server-side regardless of what value this page
// sends — see the module header. Mirrors auth/capability.ts's RANK ladder
// (owner=5 > admin=4 > lead=3 > member=2 > observer=1), which is not exported
// in reverse (rank -> name) form.
export function capabilityAtRank(rank: number): Capability {
  if (rank >= capabilityRank('owner')) return 'owner'
  if (rank >= capabilityRank('admin')) return 'admin'
  if (rank >= capabilityRank('lead')) return 'lead'
  if (rank >= capabilityRank('member')) return 'member'
  return 'observer'
}

function formatWhen(iso: string): string {
  return `${iso.slice(0, 16).replace('T', ' ')} UTC`
}

interface SelfMemberRow {
  id: string
  email: string | null
  display_name: string | null
  telegram_chat_id: string | null
  telegram_bound_at: string | null
  status: string
}

/**
 * Self-read of the viewer's own member row — the same tenant-collapse SELECT
 * shape GET /members/:id already uses (src/members/index.ts), because this is
 * a READ (existence-oracle-safe), not the exact-tenant WRITE predicate the
 * bind/unbind statements enforce (MEMBER_BIND_ELIGIBLE_SQL).
 */
export async function loadSelfMember(env: Env, memberId: string): Promise<SelfMemberRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, email, display_name, telegram_chat_id, telegram_bound_at, status
       FROM members WHERE id = ?1 AND (tenant = ?2 OR tenant IS NULL) LIMIT 1`,
  ).bind(memberId, env.TENANT_SLUG).first<SelfMemberRow>()
  return row ?? null
}

export interface ConnectableSquad {
  project_id: string
  project_name: string
  squad_id: string
  squad_name: string
  capability: Capability
}

/**
 * Every active project + linked squad this viewer could mint a self-bind
 * Telegram invite for, paired with the capability this page will REQUEST
 * (this viewer's own effective rank on that squad, capped by their org rank
 * too — never a value createProjectInvite's own ceiling would refuse; see
 * the module header). Only ever called once the caller already clears the
 * member-bind mint floor (org rank >= admin), at which point an org grant
 * bubbles down to every squad — so "projects already accessible" is every
 * active project, the same population every other org-admin surface here
 * (e.g. /admin/members) already shows this viewer.
 *
 * kasra-review AMBER P1 (2026-09-16): the cap is ALSO clamped at 'admin',
 * never 'owner', regardless of how high squadRank/orgRank go. Redemption
 * writes the suggested capability as a REAL, durable squad capability row
 * (via MEMBER_BIND'S downstream capability grant) — a redeemed 'owner' row
 * makes targetMaxRankAcrossScopes for that member 5 FOREVER, independent of
 * whatever standing the minting org admin/owner later loses. An org owner
 * (rank 5) self-binding at 'owner' is fine the instant they do it (self-
 * exempt, and they still outrank everyone) — but if their OWN org-scope
 * standing is later reduced (role demoted, capability revoked) while this
 * squad-owner row survives, NO remaining org admin (rank 4) can ever suspend,
 * revoke a capability from, or unbind this now-uncontainable Telegram
 * principal (`exceedsTargetRankCeiling` refuses with `cannot_affect_higher_
 * rank` since target rank 5 > actor rank 4 forever). Capping the SUGGESTION
 * at admin means the worst a self-bind can ever leave behind is a rank-4
 * row, which every other org admin can still act on (4 is not > 4). See
 * tests/dashboard-account-telegram-connect.test.ts's offboarding-chain test
 * (mint -> redeem -> revoke org standing -> an org admin still gets 200 on
 * suspend/capability-revoke/unbind) for the proof, not merely the render.
 */
export async function loadConnectableSquads(
  env: Env,
  auth: AuthContext,
  orgRank: number,
): Promise<ConnectableSquad[]> {
  const rows = await env.DB.prepare(
    `SELECT p.id AS project_id, p.name AS project_name, s.id AS squad_id, s.name AS squad_name
       FROM project_squad_access a
       JOIN projects p ON p.id = a.project_id
       JOIN squads s ON s.id = a.squad_id
      WHERE p.status = 'active'
      ORDER BY p.name ASC, s.name ASC`,
  ).all<{ project_id: string; project_name: string; squad_id: string; squad_name: string }>()
  const out: ConnectableSquad[] = []
  for (const row of rows.results ?? []) {
    const squadRank = await actorRankOnScopeFor(env, auth, 'squad', row.squad_id)
    out.push({
      ...row,
      capability: capabilityAtRank(Math.min(squadRank, orgRank, capabilityRank(MEMBER_BIND_MINT_FLOOR))),
    })
  }
  return out
}

// membersApp applies hono/csrf() globally (src/members/index.ts). That
// middleware only gates the three CORS-simple content types
// (x-www-form-urlencoded / multipart / text-plain, defaulting to the latter
// when no content-type is sent at all) and otherwise relies on
// Origin/Sec-Fetch-Site — real browsers send those automatically, but a test
// harness or a non-browser caller might not. Sending an explicit
// application/json content-type (even on a bodyless DELETE) sidesteps that
// ambiguity entirely, the same way the Connect POST below already does.
function disconnectScript(): Html {
  return raw(`
    <script>
      (function () {
        var btn = document.getElementById('tg-disconnect');
        if (!btn) return;
        btn.addEventListener('click', async function () {
          if (!window.confirm('Disconnect Telegram? You will stop receiving approvals there until you reconnect.')) return;
          var status = document.getElementById('tg-status');
          var memberId = btn.getAttribute('data-member');
          btn.disabled = true;
          if (status) status.textContent = 'disconnecting…';
          try {
            var res = await fetch('/api/members/members/' + encodeURIComponent(memberId) + '/telegram', {
              method: 'DELETE', credentials: 'same-origin',
              headers: { 'content-type': 'application/json' }
            });
            var data = await res.json().catch(function () { return {}; });
            if (res.ok && data.telegram_unbound) {
              window.location.reload();
            } else {
              if (status) status.textContent = 'Disconnect failed (' + (data.error || res.status) + ').';
              btn.disabled = false;
            }
          } catch (e) {
            if (status) status.textContent = 'Network error — try again.';
            btn.disabled = false;
          }
        });
      })();
    </script>`)
}

function connectScript(): Html {
  return raw(`
    <script>
      (function () {
        var btn = document.getElementById('tg-connect');
        if (!btn) return;
        btn.addEventListener('click', async function () {
          var status = document.getElementById('tg-status');
          var result = document.getElementById('tg-result');
          var sel = document.getElementById('tg-scope');
          var scopeEl = sel ? sel.options[sel.selectedIndex] : document.getElementById('tg-scope-fixed');
          if (!scopeEl) return;
          var projectId = scopeEl.getAttribute('data-project');
          var squadId = scopeEl.getAttribute('data-squad');
          var capability = scopeEl.getAttribute('data-capability');
          btn.disabled = true;
          if (status) status.textContent = 'requesting…';
          try {
            var res = await fetch('/api/members/invites', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                member_id: btn.getAttribute('data-member-id'),
                project_id: projectId,
                squad_id: squadId,
                capability: capability,
                expires_in_seconds: ${String(CONNECT_INVITE_EXPIRES_SECONDS)}
              })
            });
            var data = await res.json().catch(function () { return {}; });
            if (res.ok && data.pairing_code) {
              if (status) status.textContent = '';
              btn.disabled = true;
              if (result) {
                var botUsername = btn.getAttribute('data-bot-username') || '';
                result.hidden = false;
                result.innerHTML = '';
                var codeP = document.createElement('p');
                codeP.textContent = 'Pairing code: ' + data.pairing_code;
                result.appendChild(codeP);
                if (botUsername) {
                  var link = 'https://t.me/' + botUsername + '?start=' + encodeURIComponent(data.pairing_code);
                  var a = document.createElement('a');
                  a.href = link; a.textContent = 'Open in Telegram →'; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.className = 'btn';
                  result.appendChild(a);
                } else {
                  var manual = document.createElement('p');
                  manual.textContent = 'Message the bot and send: /start ' + data.pairing_code;
                  result.appendChild(manual);
                }
                var expiresAt = data.invite && data.invite.pairing_expires_at;
                var expiryP = document.createElement('p');
                expiryP.className = 'ui-sub';
                expiryP.textContent = expiresAt ? ('Expires ' + expiresAt) : 'Expires in 24 hours.';
                result.appendChild(expiryP);
              }
            } else {
              if (status) status.textContent = 'Could not connect (' + (data.error || res.status) + ').';
              btn.disabled = false;
            }
          } catch (e) {
            if (status) status.textContent = 'Network error — try again.';
            btn.disabled = false;
          }
        });
      })();
    </script>`)
}

/**
 * The Telegram section of the account page — every reachable state rendered
 * explicitly (see module header, "EXPLAIN, NEVER OMIT"):
 *  1. no bridged member row -> explain, no controls
 *  2. member row missing/inactive -> explain, no controls
 *  3. already bound -> "Connected" + Disconnect (self-unbind needs no rank
 *     at all — src/members/index.ts's requireAdminOrSelfForTelegramUnbind)
 *  4. not bound, below the org-admin mint floor -> explain ("ask an admin"),
 *     no doomed-to-403 button
 *  5. not bound, no active project/squad exists -> explain
 *  6. not bound, eligible -> the real Connect form
 */
export async function telegramSectionBody(env: Env, auth: AuthContext): Promise<Html> {
  if (!auth.memberId) {
    return emptyState({
      title: 'No member profile linked',
      detail: "This login isn't linked to a member record yet, so there is nothing to bind a Telegram identity to.",
      hint: 'Ask an admin to check your account under People & Access.',
    })
  }

  const member = await loadSelfMember(env, auth.memberId)
  if (!member || member.status !== 'active') {
    return emptyState({
      title: 'Account not active',
      detail: 'Your member record is missing or inactive, so Telegram cannot be connected right now.',
    })
  }

  if (member.telegram_chat_id) {
    return html`
      <div data-state="bound">
        ${pill('Connected', 'ok')}
        <p class="ui-sub" style="margin-top:8px;">
          Telegram is connected${member.telegram_bound_at ? html` · bound ${formatWhen(member.telegram_bound_at)}` : ''}.
        </p>
        <button class="btn danger" id="tg-disconnect" data-member="${member.id}">Disconnect</button>
        <div class="status-line" id="tg-status"></div>
      </div>
      ${disconnectScript()}
    `
  }

  const orgRank = await actorRankOnScopeFor(env, auth, 'org', null)
  if (orgRank < capabilityRank(MEMBER_BIND_MINT_FLOOR)) {
    return emptyState({
      title: 'Telegram not connected',
      detail: 'Connecting your own Telegram currently needs org-admin standing.',
      hint: 'Ask an org admin to send you a Telegram connect invite.',
    })
  }

  const squads = await loadConnectableSquads(env, auth, orgRank)
  if (squads.length === 0) {
    return emptyState({
      title: 'Telegram not connected',
      detail: 'No active project is linked to a squad yet, so there is nothing to bind Telegram access to.',
    })
  }

  const botUsername = await getTelegramBotUsername(env)
  const scopePicker =
    squads.length > 1
      ? html`
          <label class="ui-sub" for="tg-scope" style="display:block;margin-top:8px;">Project / squad</label>
          <select id="tg-scope">
            ${squads.map(
              (s) => html`<option data-project="${s.project_id}" data-squad="${s.squad_id}" data-capability="${s.capability}">
                ${s.project_name} / ${s.squad_name} (${s.capability})
              </option>`,
            )}
          </select>
        `
      : html`
          <input type="hidden" id="tg-scope-fixed" data-project="${squads[0].project_id}" data-squad="${squads[0].squad_id}" data-capability="${squads[0].capability}" />
          <p class="ui-sub" style="margin-top:8px;">${squads[0].project_name} / ${squads[0].squad_name} (${squads[0].capability})</p>
        `

  return html`
    <div data-state="unbound">
      ${pill('Not connected', 'dim')}
      <p class="ui-sub" style="margin-top:8px;">Connect your Telegram to approve and be notified through chat.</p>
      ${scopePicker}
      <button class="btn" id="tg-connect" data-member-id="${member.id}" data-bot-username="${botUsername ?? ''}" style="margin-top:10px;">
        Connect Telegram
      </button>
      <div class="status-line" id="tg-status"></div>
      <div id="tg-result" hidden></div>
    </div>
    ${connectScript()}
  `
}

async function accountPageBody(env: Env, auth: AuthContext): Promise<Html> {
  return html`
    ${pageHeader({
      crumbs: 'Overview / My Account',
      title: 'My Account',
      sub: 'Your identity in this pot and the channels connected to it.',
    })}
    ${sectionPanel({ title: 'Telegram', body: await telegramSectionBody(env, auth) })}
  `
}

// ── Hono sub-app (factory to avoid the shell circular import — same pattern
//    as elevation.ts's makeElevationApp / mission-control-routes.ts) ────────
export function makeAccountApp(shell: ShellFn) {
  const app = new Hono<AppEnv>()

  app.get('/account', async (c) => {
    const body = await accountPageBody(c.env, c.get('auth'))
    return c.html(shell(c.env, 'My Account', body))
  })

  return app
}
