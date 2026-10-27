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
import { SETTINGS_KEYS, getSetting, isValidBotUsername } from './settings'
import { pageHeader, sectionPanel, pill, emptyState, type Html } from './ui'
import { secureMomentsStatus } from '../secure-moments/config'
import { checkEnrolmentSession, mintEnrolmentLink } from '../secure-moments/enrol-mint'
import { presenceGateJson } from '../approvals/gate'
import { requestEnrolDelivery } from '../secure-moments/telegram-miniapp-enrol-delivery'
import { telegramMiniappStatus } from '../secure-moments/telegram-miniapp-config'
import { listMemberTgDevices, revokeOwnTgDevice } from '../secure-moments/telegram-miniapp-store'
import { changeTrustWindow, currentTrustWindow, listMemberTgDevicesPw, parseTrustWindow, pinWindowOn, TRUST_WINDOW_PRESETS } from '../secure-moments/telegram-miniapp-pin-window'
import { listMemberPasskeys, memberHasPasskeyHistory, revokeOwnPasskey } from '../secure-moments/store'
import { listLinkedSignIns } from '../auth/link-signin'

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

interface OriginBindReceiptRow {
  agent_id: string
  agent_name: string | null
  message_id: string
  created_at: string
}

/**
 * mupot#1425 round 3 (Athena): `telegram_origin_bind_receipts` (0155) was
 * write-only — a first-bind-by-origin (src/im/origin-verdict.ts, no invite,
 * no button) landed a real credential with nothing surfacing it to the
 * member it happened to. Minimal, display-only reader: the most recent
 * receipt for this member, if any, so a silent bind is visible on the SAME
 * page that already shows "Telegram is connected". The origin path no longer
 * binds a channel (a chat binds only via /account or pairing), so this now shows
 * historical receipts only. Org-admin members (who
 * can view another member's row through the admin surfaces this file does
 * NOT touch) are unaffected — this reads only the VIEWER's own member id,
 * same self-scoping as loadSelfMember above.
 */
export async function loadLatestOriginBindReceipt(env: Env, memberId: string): Promise<OriginBindReceiptRow | null> {
  const row = await env.DB.prepare(
    `SELECT r.agent_id, a.name AS agent_name, r.message_id, r.created_at
       FROM telegram_origin_bind_receipts r
       LEFT JOIN agents a ON a.id = r.agent_id
      WHERE r.tenant = ?1 AND r.member_id = ?2
      ORDER BY r.created_at DESC
      LIMIT 1`,
  ).bind(env.TENANT_SLUG, memberId).first<OriginBindReceiptRow>()
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
                  var then = document.createElement('p');
                  then.className = 'ui-sub';
                  then.textContent = 'Tap Start in Telegram. Once the bot confirms the link, send /muneeds to see what is waiting for you, then /muapprove <task id> or /mureject <task id> <reason>.';
                  result.appendChild(then);
                } else {
                  var manual = document.createElement('p');
                  manual.textContent = 'Message the bot and send: /start ' + data.pairing_code;
                  result.appendChild(manual);
                  var askOwner = document.createElement('p');
                  askOwner.className = 'ui-sub';
                  askOwner.textContent = 'Ask your owner to set the decision bot username so this page can link you straight there.';
                  result.appendChild(askOwner);
                }
                var expiresAt = data.invite && data.invite.pairing_expires_at;
                var expiryP = document.createElement('p');
                expiryP.className = 'ui-sub';
                expiryP.textContent = expiresAt ? ('Expires ' + expiresAt) : 'Expires in 24 hours.';
                result.appendChild(expiryP);
              }
            } else if (data.error === 'human_presence_required' && typeof data.approve_url === 'string') {
              window.location.assign(data.approve_url);
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
    const originReceipt = await loadLatestOriginBindReceipt(env, member.id)
    return html`
      <div data-state="bound">
        ${pill('Connected', 'ok')}
        <p class="ui-sub" style="margin-top:8px;">
          Telegram is connected${member.telegram_bound_at ? html` · bound ${formatWhen(member.telegram_bound_at)}` : ''}.
        </p>
        ${originReceipt
          ? html`
            <p class="ui-sub" style="margin-top:4px;">
              Bound via agent ${originReceipt.agent_name ?? originReceipt.agent_id} on
              ${formatWhen(originReceipt.created_at)}, from message ${originReceipt.message_id}.
            </p>
          `
          : ''}
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

  // im_bot_username (org_settings) is the DECISION-CHANNEL bot's @username —
  // an explicit, non-secret, owner-configured display value (see
  // SETTINGS_KEYS.imBotUsername's docstring in ./settings.ts and the
  // src/types.ts TELEGRAM_BOT_TOKEN incident note). It is NEVER derived from
  // TELEGRAM_BOT_TOKEN or any getMe call: that token authenticates a
  // DIFFERENT bot (the notification bridge, src/telegram-bridge/bus_notify.ts)
  // and deriving a username from it once rendered a deep link to the wrong
  // bot in production (mupot#1420). Absent setting -> no link, ever; the
  // fallback below is the only honest rendering.
  // Re-validated on read, not just trusted from the write path (defense in
  // depth — see SETTINGS_KEYS.imBotUsername): a malformed stored value
  // degrades to the same "not configured" fallback as an unset setting,
  // never a broken or unsafe link.
  const rawBotUsername = await getSetting(env, SETTINGS_KEYS.imBotUsername)
  const botUsername = isValidBotUsername(rawBotUsername) ? rawBotUsername : null
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

function passkeyScript(): Html {
  return raw(`
    <script>
      (function () {
        var add = document.getElementById('pk-add');
        var status = document.getElementById('pk-status');
        if (add) add.addEventListener('click', async function () {
          add.disabled = true;
          if (status) status.textContent = 'preparing…';
          try {
            var res = await fetch('/account/passkey/enrol', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' } });
            var data = await res.json().catch(function () { return {}; });
            if (res.ok && data.url) { window.location.assign(data.url); return; }
            if (data.error === 'human_presence_required' && data.approve_url) { if (status) status.textContent = 'Adding another passkey needs one you already have. Opening the passkey page…'; window.location.assign(data.approve_url); return; }
            if (data.error === 'human_presence_unavailable' || data.error === 'presence_grant_invalid' || data.error === 'too_many_pending') { if (status) status.textContent = data.message || 'This needs your passkey.'; }
            else if (data.error === 'reauth_required') {
              if (status) { status.textContent = ''; var a = document.createElement('a'); a.href = '/auth/reauth?return=/account'; a.textContent = 'Confirm it is you first'; status.appendChild(a); status.appendChild(document.createTextNode(', then come back and try again.')); }
            } else if (status) { status.textContent = 'Could not start (' + (data.error || res.status) + ').'; }
          } catch (e) { if (status) status.textContent = 'Network error — try again.'; }
          add.disabled = false;
        });
        var rm = document.querySelectorAll('button[data-pk-revoke]');
        for (var i = 0; i < rm.length; i++) rm[i].addEventListener('click', async function (ev) {
          if (!window.confirm('Remove this passkey? You will no longer be able to approve with it.')) return;
          var id = ev.currentTarget.getAttribute('data-pk-revoke');
          var res = await fetch('/account/passkey/' + encodeURIComponent(id) + '/revoke', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' } });
          if (res.ok) window.location.reload(); else if (status) status.textContent = 'Could not remove (' + res.status + ').';
        });
      })();
    </script>`)
}

/** The Passkeys section: only while secure moments are on; adds no authority (docs/architecture/secure-moments.md). */
export async function passkeySectionBody(env: Env, auth: AuthContext): Promise<Html | null> {
  if (secureMomentsStatus(env).state !== 'on') return null
  if (!auth.memberId) return null
  const keys = await listMemberPasskeys(env, auth.memberId)
  return html`
    <p class="ui-sub">A passkey lets you confirm approvals on a separate secure page with your fingerprint, face or device PIN. It adds no permissions: it only proves it is you.</p>
    ${keys.length === 0
      ? html`<p class="ui-sub" style="margin-top:8px;">${pill('None registered', 'dim')}</p>`
      : html`<ul style="margin-top:8px;">${keys.map((k) => html`<li>Registered ${formatWhen(k.created_at)}${k.last_used_at ? html` · last used ${formatWhen(k.last_used_at)}` : ''}
          <button class="btn danger" data-pk-revoke="${k.id}">Remove</button></li>`)}</ul>`}
    <button class="btn" id="pk-add" style="margin-top:10px;">Add passkey</button>
    <div class="status-line" id="pk-status"></div>
    ${passkeyScript()}
  `
}

function telegramDeviceScript(): Html {
  return raw(`
    <script>
      (function () {
        var add = document.getElementById('tgd-add');
        var status = document.getElementById('tgd-status');
        if (add) add.addEventListener('click', async function () {
          add.disabled = true;
          if (status) status.textContent = 'sending…';
          try {
            var res = await fetch('/account/telegram-device/enrol', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' } });
            var data = await res.json().catch(function () { return {}; });
            if (res.ok && data.sent) { if (status) status.textContent = 'Sent. Open the new message from the approvals bot in Telegram on your phone and tap the button (it is valid for 10 minutes).'; }
            else if (data.error === 'reauth_required') {
              if (status) { status.textContent = ''; var a = document.createElement('a'); a.href = '/auth/reauth?return=/account'; a.textContent = 'Confirm it is you first'; status.appendChild(a); status.appendChild(document.createTextNode(', then come back and try again.')); }
            } else if (data.error === 'telegram_not_bound') { if (status) status.textContent = 'Connect Telegram in the section above first; the setup button is sent to that private chat.'; }
            else if (data.error === 'rate_limited') { if (status) status.textContent = 'Too many messages just now. Wait a few minutes.'; }
            else if (data.error === 'chat_unreachable') { if (status) status.textContent = 'Telegram would not deliver it: open the approvals bot in Telegram and press Start once, then try again.'; }
            else if (status) { status.textContent = 'Could not send (' + (data.error || res.status) + ').'; }
          } catch (e) { if (status) status.textContent = 'Network error — try again.'; }
          add.disabled = false;
        });
        var rm = document.querySelectorAll('button[data-tgd-revoke]');
        for (var i = 0; i < rm.length; i++) rm[i].addEventListener('click', async function (ev) {
          if (!window.confirm('Remove this phone? Decisions from it will stop working until you set it up again.')) return;
          var id = ev.currentTarget.getAttribute('data-tgd-revoke');
          var res = await fetch('/account/telegram-device/' + encodeURIComponent(id) + '/revoke', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' } });
          if (res.ok) window.location.reload(); else if (status) status.textContent = 'Could not remove (' + res.status + ').';
        });
      })();
    </script>`)
}

function telegramDeviceWindowScript(): Html {
  return raw(`
    <script>
      (function () {
        var status = document.getElementById('tgd-status');
        var sv = document.querySelectorAll('button[data-tgd-window-save]');
        for (var i = 0; i < sv.length; i++) sv[i].addEventListener('click', async function (ev) {
          var id = ev.currentTarget.getAttribute('data-tgd-window-save');
          var sel = document.querySelector('select[data-tgd-window="' + id + '"]');
          if (!sel) return;
          if (status) status.textContent = 'saving…';
          try {
            var res = await fetch('/account/telegram-device/' + encodeURIComponent(id) + '/window', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seconds: parseInt(sel.value, 10) }) });
            var data = await res.json().catch(function () { return {}; });
            if (res.ok) { if (status) status.textContent = 'Saved. A shorter time takes effect immediately.'; }
            else if (data.error === 'reauth_required') {
              if (status) { status.textContent = ''; var a = document.createElement('a'); a.href = '/auth/reauth?return=/account'; a.textContent = 'Confirm it is you first'; status.appendChild(a); status.appendChild(document.createTextNode(', then come back and save again.')); }
            } else if (status) { status.textContent = 'Could not save (' + (data.error || res.status) + ').'; }
          } catch (e) { if (status) status.textContent = 'Network error — try again.'; }
        });
      })();
    </script>`)
}

/** The Telegram device section: only while the Mini App channel is on; adds no authority (docs/architecture/secure-moments.md, W4). */
export async function telegramDeviceSectionBody(env: Env, auth: AuthContext): Promise<Html | null> {
  if (telegramMiniappStatus(env).state !== 'on') return null
  if (!auth.memberId) return null
  // W4.2 sub-flag: each phone also shows how it unlocks and its trusted-device window, which its owner can change here.
  if (pinWindowOn(env)) {
    const pwDevices = await listMemberTgDevicesPw(env, auth.memberId)
    return html`
    <p class="ui-sub">A set-up phone lets you approve requests inside Telegram with your fingerprint, face or a 6-digit PIN. After you confirm, the phone stays trusted for the time you choose, so routine approvals do not nag you. It is weaker than a passkey, so sensitive grants always need a passkey. It adds no permissions: it only proves it is you.</p>
    ${pwDevices.length === 0
      ? html`<p class="ui-sub" style="margin-top:8px;">${pill('No phone set up', 'dim')}</p>`
      : html`<ul style="margin-top:8px;">${pwDevices.map((d) => html`<li>Set up ${formatWhen(d.confirmed_at ?? d.created_at)} · ${d.unlock_mode === 'pin' ? 'PIN' : 'fingerprint or face'}${d.last_used_at ? html` · last used ${formatWhen(d.last_used_at)}` : ''}
          <label>Trusted for
            <select data-tgd-window="${d.id}">${TRUST_WINDOW_PRESETS.map((w) => html`<option value="${String(w.seconds)}" ${w.seconds === d.trust_window_seconds ? raw('selected') : ''}>${w.label}</option>`)}</select></label>
          <button class="btn" data-tgd-window-save="${d.id}">Save</button>
          <button class="btn danger" data-tgd-revoke="${d.id}">Remove</button></li>`)}</ul>`}
    <button class="btn" id="tgd-add" style="margin-top:10px;">Set up this phone</button>
    <div class="status-line" id="tgd-status"></div>
    ${telegramDeviceScript()}
    ${telegramDeviceWindowScript()}
  `
  }
  const devices = await listMemberTgDevices(env, auth.memberId)
  return html`
    <p class="ui-sub">A set-up phone lets you approve requests inside Telegram with your fingerprint or face. It is weaker than a passkey, so sensitive grants still need a passkey. It adds no permissions: it only proves it is you.</p>
    ${devices.length === 0
      ? html`<p class="ui-sub" style="margin-top:8px;">${pill('No phone set up', 'dim')}</p>`
      : html`<ul style="margin-top:8px;">${devices.map((d) => html`<li>Set up ${formatWhen(d.confirmed_at ?? d.created_at)}${d.last_used_at ? html` · last used ${formatWhen(d.last_used_at)}` : ''}
          <button class="btn danger" data-tgd-revoke="${d.id}">Remove</button></li>`)}</ul>`}
    <button class="btn" id="tgd-add" style="margin-top:10px;">Set up this phone</button>
    <div class="status-line" id="tgd-status"></div>
    ${telegramDeviceScript()}
  `
}

async function telegramDevicePanel(env: Env, auth: AuthContext): Promise<Html> {
  const body = await telegramDeviceSectionBody(env, auth)
  return body ? sectionPanel({ title: 'Telegram device', body }) : html``
}

async function passkeyPanel(env: Env, auth: AuthContext): Promise<Html> {
  const body = await passkeySectionBody(env, auth)
  return body ? sectionPanel({ title: 'Passkeys', body }) : html``
}

// mupot#1022: outcome codes the auth routes put in ?signin=. A fixed map: the query value is only ever a lookup key, never echoed.
const SIGNIN_NOTICES: Record<string, string> = {
  linked: 'Google account linked. You can now sign in with it and land here.',
  moved: 'Google account linked. Sign-in for it now lands in this account; the old member was left as-is for an admin to archive.',
  reactivated: 'Google account linked again.',
  already_yours: 'That Google account is already linked to this account.',
  unlinked: 'Sign-in unlinked.',
  already_linked: 'That Google account belongs to another member and cannot be moved from here. Ask an org admin.',
  identity_revoked: 'That Google account was unlinked from another member before and is not linked again automatically. Ask an org admin.',
  last_identity: 'You cannot unlink your last sign-in: you would lose access.',
  not_found: 'That sign-in was not found.',
  stale_google_signin: 'Google did not ask you to sign in again just now. Start again and complete the Google sign-in.',
  reauth_stale: "Google didn't confirm a fresh sign-in, so nothing was unlocked. Try again.",
  reauth_required: 'Please confirm it is you again, then start linking from here.',
  expired: 'That link request expired. Start again.',
  changed: 'That Google account changed while you were confirming. Start again.',
  unverified: 'That Google account has no verified email, so it cannot be linked.',
  competing_control: 'That sign-in could not be linked right now.',
  service_error: 'Something went wrong. Try again in a moment.',
  not_a_human_session: 'Only a signed-in person can link sign-ins.',
}

export async function linkedSignInsSectionBody(env: Env, auth: AuthContext, notice: string | null): Promise<Html> {
  if (!auth.memberId || !auth.webSessionIdHash) {
    return html`<p class="ui-sub">Linked sign-ins are available once you are signed in with a registered web session.</p>`
  }
  const identities = await listLinkedSignIns(env, auth.memberId)
  const note = notice && SIGNIN_NOTICES[notice] ? html`<p class="notice" role="status">${SIGNIN_NOTICES[notice]}</p>` : html``
  const rows = identities.map((i) => html`
    <li>
      <span>${i.provider}</span> <span class="ui-sub">${i.maskedEmail ?? 'no email'}</span>
      ${identities.length > 1
        ? html`<form method="post" action="/auth/link-signin/${i.id}/unlink"><button type="submit">Unlink</button></form>`
        : html`<span class="ui-sub">(your only sign-in)</span>`}
    </li>`)
  return html`
    ${note}
    <p>The accounts that sign you in to this member. Link your other Google account so signing in with it lands here instead of creating a separate, empty member.</p>
    ${identities.length === 0 ? html`<p class="ui-sub">No linked sign-ins.</p>` : html`<ul>${rows}</ul>`}
    <form method="post" action="/auth/link-signin/start"><button type="submit">Link another Google account</button></form>
    <p class="ui-sub">You will be asked to confirm it is you, then to pick the Google account to link.</p>`
}

async function accountPageBody(env: Env, auth: AuthContext, signinNotice: string | null = null): Promise<Html> {
  return html`
    ${pageHeader({
      crumbs: 'Overview / My Account',
      title: 'My Account',
      sub: 'Your identity in this pot and the channels connected to it.',
    })}
    ${sectionPanel({ title: 'Linked sign-ins', body: await linkedSignInsSectionBody(env, auth, signinNotice) })}
    ${sectionPanel({ title: 'Telegram', body: await telegramSectionBody(env, auth) })}
    ${await passkeyPanel(env, auth)}
    ${await telegramDevicePanel(env, auth)}
  `
}

// ── Hono sub-app (factory to avoid the shell circular import — same pattern
//    as elevation.ts's makeElevationApp / mission-control-routes.ts) ────────
export function makeAccountApp(shell: ShellFn) {
  const app = new Hono<AppEnv>()

  app.get('/account', async (c) => {
    const body = await accountPageBody(c.env, c.get('auth'), c.req.query('signin') ?? null)
    return c.html(shell(c.env, 'My Account', body))
  })

  // "Add passkey": mints a single-use enrolment link (secure moments). Same-origin only; a real, freshly
  // re-authenticated web session only; adds no authority.
  app.post('/account/passkey/enrol', async (c) => {
    if (c.req.header('origin') !== new URL(c.req.url).origin) return c.json({ error: 'cross_origin' }, 403)
    const enrolAuth = c.get('auth')
    // The FIRST passkey can only rest on the real, freshly re-authenticated session. Every later enrolment needs a
    // passkey confirmation; revoked credentials remain durable history and never reopen the first-enrol exception.
    const sess = await checkEnrolmentSession(c.env, enrolAuth)
    if (sess.ok && await memberHasPasskeyHistory(c.env, sess.memberId)) {
      if ((await listMemberPasskeys(c.env, sess.memberId)).length === 0) return c.json({ error: 'last_passkey_recovery_required', message: 'Ask an organization owner to start recovery.' }, 409)
      const denied = await presenceGateJson(c, sess.memberId, {
        kind: 'passkey_enrol', subjectId: sess.memberId, params: { action: 'enrol' }, summary: 'Add another passkey to your account',
        actionPath: '/account/passkey/enrol', encoding: 'json', returnPath: '/account',
      })
      if (denied) return denied
    }
    const r = await mintEnrolmentLink(c.env, enrolAuth)
    c.header('Cache-Control', 'no-store')
    return r.ok ? c.json({ url: r.url, expires_at: r.expiresAt }) : c.json({ error: r.error }, r.status)
  })

  // "Set up this phone" (secure moments W4, flag TELEGRAM_MINIAPP): the SAME session rules as the passkey link
  // (checkEnrolmentSession). The WORKER mints the single-use link and sends it as a web_app button to this member's own bound
  // private chat; no link or URL is ever returned here. Same-origin only.
  app.post('/account/telegram-device/enrol', async (c) => {
    if (c.req.header('origin') !== new URL(c.req.url).origin) return c.json({ error: 'cross_origin' }, 403)
    const auth = c.get('auth')
    const session = await checkEnrolmentSession(c.env, auth)
    if (!session.ok) return c.json({ error: session.error }, session.status)
    const denied = await presenceGateJson(c, session.memberId, {
      kind: 'telegram_device_enrol', subjectId: session.memberId, params: { action: 'enrol' },
      summary: 'Set up a Telegram approval device', actionPath: '/account/telegram-device/enrol', encoding: 'json', returnPath: '/account',
    })
    if (denied) return denied
    const r = await requestEnrolDelivery(c.env, auth)
    c.header('Cache-Control', 'no-store')
    return r.ok ? c.json({ sent: true, delivery_id: r.delivery_id, sent_at: r.sent_at }) : c.json({ error: r.error }, r.status)
  })

  app.post('/account/telegram-device/:id/revoke', async (c) => {
    if (c.req.header('origin') !== new URL(c.req.url).origin) return c.json({ error: 'cross_origin' }, 403)
    const auth = c.get('auth')
    if (telegramMiniappStatus(c.env).state !== 'on') return c.json({ error: 'not_enabled' }, 404)
    // Self only: the member behind THIS web session, never a member id from the request.
    if (!auth.webSessionIdHash || !auth.webSessionMemberId || auth.webSessionMemberId !== auth.memberId || !auth.memberId) {
      return c.json({ error: 'not_a_web_session' }, 403)
    }
    return (await revokeOwnTgDevice(c.env, auth.memberId, c.req.param('id')))
      ? c.json({ revoked: true })
      : c.json({ error: 'not_found' }, 404)
  })

  // Change a phone's trusted-device window (W4.2, flag TELEGRAM_MINIAPP_PIN_WINDOW). LENGTHENING (or re-saving the same value) is
  // an enrolment-grade change: a real web session re-authenticated within the step-up window (checkEnrolmentSession, the ONE shared
  // rule). SHORTENING only reduces trust, so any real web session of the owner may do it (the revoke-device bar), with no
  // fresh re-auth: a stolen session cookie can only make the phone ask more often. The value must be a preset.
  app.post('/account/telegram-device/:id/window', async (c) => {
    if (c.req.header('origin') !== new URL(c.req.url).origin) return c.json({ error: 'cross_origin' }, 403)
    c.header('Cache-Control', 'no-store')
    if (!pinWindowOn(c.env)) return c.json({ error: 'not_enabled' }, 404)
    let seconds: unknown
    try {
      const body: unknown = await c.req.json()
      seconds = typeof body === 'object' && body !== null ? (body as { seconds?: unknown }).seconds : undefined // as: just narrowed to an object; the one field is validated as a preset below
    } catch {
      return c.json({ error: 'bad_request' }, 400)
    }
    const to = parseTrustWindow(seconds)
    if (to === null) return c.json({ error: 'bad_window' }, 400)
    const auth = c.get('auth')
    // Self only: the member behind THIS web session, never a member id from the request.
    if (!auth.webSessionIdHash || !auth.webSessionMemberId || !auth.memberId || auth.webSessionMemberId !== auth.memberId) {
      return c.json({ error: 'not_a_web_session' }, 403)
    }
    const current = await currentTrustWindow(c.env, auth.memberId, c.req.param('id'))
    if (current === null) return c.json({ error: 'not_found' }, 404)
    if (to >= current) {
      const session = await checkEnrolmentSession(c.env, auth)
      if (!session.ok) return c.json({ error: session.error }, session.status)
      const denied = await presenceGateJson(c, session.memberId, {
        kind: 'telegram_device_window', subjectId: c.req.param('id'), params: { device_id: c.req.param('id'), seconds: to },
        summary: `Lengthen this Telegram device trust window to ${to} seconds`, actionPath: `/account/telegram-device/${encodeURIComponent(c.req.param('id'))}/window`, encoding: 'json', returnPath: '/account',
      })
      if (denied) return denied
    }
    const r = await changeTrustWindow(c.env, auth.memberId, c.req.param('id'), to)
    if (!r.ok) return r.reason === 'bad_window' ? c.json({ error: 'bad_window' }, 400) : c.json({ error: 'not_found' }, 404)
    return c.json({ saved: true, seconds: r.to })
  })

  app.post('/account/passkey/:id/revoke', async (c) => {
    if (c.req.header('origin') !== new URL(c.req.url).origin) return c.json({ error: 'cross_origin' }, 403)
    const auth = c.get('auth')
    if (secureMomentsStatus(c.env).state !== 'on') return c.json({ error: 'not_enabled' }, 404)
    // Self only: the member behind THIS web session, never a member id from the request.
    if (!auth.webSessionIdHash || !auth.webSessionMemberId || auth.webSessionMemberId !== auth.memberId || !auth.memberId) {
      return c.json({ error: 'not_a_web_session' }, 403)
    }
    const passkeyId = c.req.param('id')
    const live = await listMemberPasskeys(c.env, auth.memberId)
    if (!live.some((p) => p.id === passkeyId)) return c.json({ error: 'not_found' }, 404)
    if (live.length < 2) return c.json({ error: 'last_passkey_recovery_required', message: 'The last passkey cannot be removed here. Ask an organization owner to start recovery.' }, 409)
    const denied = await presenceGateJson(c, auth.memberId, {
      kind: 'passkey_revoke', subjectId: passkeyId, params: { action: 'revoke', passkey_id: passkeyId },
      summary: 'Remove this passkey using another registered passkey', actionPath: `/account/passkey/${encodeURIComponent(passkeyId)}/revoke`, encoding: 'json', returnPath: '/account',
    })
    if (denied) return denied
    return (await revokeOwnPasskey(c.env, auth.memberId, passkeyId, c.req.query('presence_grant')))
      ? c.json({ revoked: true })
      : c.json({ error: 'last_passkey_recovery_required', message: 'The last passkey cannot be removed here. Ask an organization owner to start recovery.' }, 409)
  })

  return app
}
