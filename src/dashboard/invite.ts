// mupot — public web invite-landing page (mupot#1436 A1).
//
// GET/POST /invite/:id — the browser-facing counterpart to the JSON
// POST /api/members/invites/:id/accept. Unlike every route in dashboardApp
// this is deliberately UNAUTHENTICATED (no session, no cookie) — the invite id
// itself is the redemption secret, same reasoning as
// membersApp's own /invites/:id/accept (src/members/index.ts). For that
// reason inviteApp is its own tiny Hono app, mounted BEFORE the dashboardApp
// '/' catch-all in src/index.ts, so it never passes through dashboardApp's
// requireAuth / capability-floor middleware chain.
//
// Redemption itself calls the SAME acceptInvite(env, inviteId, displayName)
// the JSON API calls (src/members/index.ts) — one write path, not a second
// copy of the claim/mint/rollback SQL.
//
// mupot#1436 A2 (src/auth/pending-invite-link.ts + /auth/login + /auth/callback):
// after a successful accept this page sets a short-lived "pending invite"
// marker (KV + HttpOnly cookie). Login binds that pointer into OAuth state;
// callback is link-only against the D1 invite row.

import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import { html, raw as honoRaw } from 'hono/html'
import { setCookie } from 'hono/cookie'
import type { Env, Capability } from '../types'
import { acceptInvite, protectRawTokenResponse } from '../members'
import {
  PENDING_INVITE_COOKIE,
  PENDING_INVITE_KV_PREFIX,
  PENDING_INVITE_TTL_SECONDS,
} from '../auth/pending-invite-link'

type AppEnv = { Bindings: Env }

export { PENDING_INVITE_COOKIE, PENDING_INVITE_KV_PREFIX, PENDING_INVITE_TTL_SECONDS }

// ── view model ───────────────────────────────────────────────────────────────

export interface InviteLandingContext {
  inviteId: string
  orgName: string
  departmentName: string | null
  projectName: string | null
  squadName: string | null
  capability: Capability
  inviterName: string
}

export type InviteLandingView =
  | { kind: 'not_found' }
  | { kind: 'already_accepted' }
  | { kind: 'telegram_only'; ctx: InviteLandingContext }
  | { kind: 'ready'; ctx: InviteLandingContext }

interface InviteLandingRow {
  id: string
  department_id: string | null
  project_id: string | null
  squad_id: string | null
  pairing_hash: string | null
  pairing_expires_at: string | null
  capability: Capability
  invited_by: string | null
  accepted_at: string | null
}

/**
 * Best-effort human label for the inviter, for an UNAUTHENTICATED public
 * page. Tries the members table (network members carry a display_name),
 * otherwise falls back to a generic label.
 *
 * mupot#1436 round 2 P1-B: this used to also fall back to `users.email` —
 * an inviter's email, PII, rendered to any anonymous visitor holding the
 * invite link. Dropped entirely; there is no email rung. A missing
 * display_name (e.g. the legacy web `users` table has none) always renders
 * as "an admin", never the inviter's address.
 */
async function resolveInviterName(env: Env, invitedBy: string | null): Promise<string> {
  if (!invitedBy) return 'an admin'
  const member = await env.DB.prepare('SELECT display_name FROM members WHERE id = ?1 LIMIT 1')
    .bind(invitedBy)
    .first<{ display_name: string | null }>()
  if (member?.display_name) return member.display_name
  return 'an admin'
}

export async function loadInviteLanding(env: Env, inviteId: string): Promise<InviteLandingView> {
  const invite = await env.DB.prepare(
    `SELECT id, department_id, project_id, squad_id, pairing_hash, pairing_expires_at,
            capability, invited_by, accepted_at
       FROM invites WHERE id = ?1 LIMIT 1`,
  )
    .bind(inviteId)
    .first<InviteLandingRow>()

  if (!invite) return { kind: 'not_found' }
  if (invite.accepted_at) return { kind: 'already_accepted' }

  const [dept, project, squad, inviterName] = await Promise.all([
    invite.department_id
      ? env.DB.prepare('SELECT name FROM departments WHERE id = ?1 LIMIT 1')
          .bind(invite.department_id)
          .first<{ name: string }>()
      : Promise.resolve(null),
    invite.project_id
      ? env.DB.prepare('SELECT name FROM projects WHERE id = ?1 LIMIT 1')
          .bind(invite.project_id)
          .first<{ name: string }>()
      : Promise.resolve(null),
    invite.squad_id
      ? env.DB.prepare('SELECT name FROM squads WHERE id = ?1 LIMIT 1')
          .bind(invite.squad_id)
          .first<{ name: string }>()
      : Promise.resolve(null),
    resolveInviterName(env, invite.invited_by),
  ])

  const ctx: InviteLandingContext = {
    inviteId,
    orgName: env.BRAND,
    departmentName: dept?.name ?? null,
    projectName: project?.name ?? null,
    squadName: squad?.name ?? null,
    capability: invite.capability,
    inviterName,
  }

  // A3: pairing_hash OR pairing_expires_at is the Telegram door (unchanged
  // 409). A plain squad invite (squad_id set, pairing columns NULL) is a
  // web accept — 0156 legalized that shape.
  return invite.pairing_hash !== null || invite.pairing_expires_at !== null
    ? { kind: 'telegram_only', ctx }
    : { kind: 'ready', ctx }
}

// ── HTML ─────────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Minimal self-contained shell — this page is unauthenticated and never
 *  shares dashboardApp's shell() (which renders the signed-in sidebar/nav). */
function pageShell(brand: string, title: string, body: string) {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title} · ${brand}</title>
    <style>
      :root { color-scheme: light dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
        background: #f6f7f6; color: #171b19; font-family: system-ui, -apple-system, sans-serif;
        padding: 24px;
      }
      @media (prefers-color-scheme: dark) { body { background: #0e1116; color: #e6edf3; } }
      .card {
        max-width: 480px; width: 100%; background: #fff; border: 1px solid #e7e9e7;
        border-radius: 12px; padding: 28px 32px;
      }
      @media (prefers-color-scheme: dark) { .card { background: #161b22; border-color: #2a3140; } }
      h1 { font-size: 20px; margin: 0 0 14px; }
      dl.kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 14px; margin: 0 0 18px; }
      dl.kv dt { color: #7a827d; }
      label { display: block; font-size: 14px; margin-bottom: 14px; }
      input[type="text"] { width: 100%; margin-top: 6px; padding: 8px 10px; font-size: 14px;
        border: 1px solid #e7e9e7; border-radius: 8px; }
      button.btn { padding: 10px 18px; font-size: 14px; font-weight: 600; border-radius: 8px;
        border: none; background: #96780A; color: #fff; cursor: pointer; }
      p.muted { color: #7a827d; font-size: 13px; }
      .warn { background: #fef3cd; border: 1px solid #f2d675; border-radius: 8px; padding: 10px 12px; font-size: 13px; margin-bottom: 16px; }
    </style>
  </head>
  <body><div class="card">${honoRaw(body)}</div></body>
</html>`
}

function inviteFacts(ctx: InviteLandingContext): string {
  const rows: string[] = [
    `<dt>Organization</dt><dd>${esc(ctx.orgName)}</dd>`,
  ]
  if (ctx.departmentName) rows.push(`<dt>Department</dt><dd>${esc(ctx.departmentName)}</dd>`)
  if (ctx.projectName) rows.push(`<dt>Project</dt><dd>${esc(ctx.projectName)}</dd>`)
  if (ctx.squadName) rows.push(`<dt>Squad</dt><dd>${esc(ctx.squadName)}</dd>`)
  rows.push(`<dt>Access</dt><dd><code>${esc(ctx.capability)}</code></dd>`)
  rows.push(`<dt>Invited by</dt><dd>${esc(ctx.inviterName)}</dd>`)
  return `<dl class="kv">${rows.join('')}</dl>`
}

export function inviteNotFoundBody(brand: string) {
  return pageShell(brand, 'Invite not found', `
    <h1>Invite not found</h1>
    <p class="muted">This invite link is invalid or has been removed. Ask the person who
    invited you for a fresh link.</p>`)
}

export function inviteAlreadyAcceptedBody(brand: string) {
  return pageShell(brand, 'Invite already used', `
    <h1>This invite has already been used</h1>
    <p class="muted">If this was you, sign in instead.</p>
    <p><a href="/auth/login">Go to sign in →</a></p>`)
}

export function inviteTelegramOnlyBody(brand: string, ctx: InviteLandingContext) {
  return pageShell(brand, 'Telegram invite', `
    <h1>This invite is redeemed in Telegram</h1>
    ${inviteFacts(ctx)}
    <p class="muted">This invite was created for a Telegram-connected project and can only be
    accepted by messaging the bot with the pairing code you were given — not from this page.</p>`)
}

export function invitePageBody(brand: string, ctx: InviteLandingContext, error?: string) {
  const errorHtml = error ? `<div class="warn"><strong>${esc(error)}</strong></div>` : ''
  return pageShell(brand, 'Accept invite', `
    <h1>You've been invited to ${esc(ctx.orgName)}</h1>
    ${inviteFacts(ctx)}
    ${errorHtml}
    <form method="post" action="/invite/${encodeURIComponent(ctx.inviteId)}" autocomplete="off">
      <label>Your name
        <input type="text" name="display_name" required maxlength="120" placeholder="Jane Doe" />
      </label>
      <button type="submit" class="btn">Accept invite</button>
    </form>`)
}

// ── app ──────────────────────────────────────────────────────────────────────

export const inviteApp = new Hono<AppEnv>()

// Same library/pattern as every other mutating dashboard surface
// (dashboardApp.use('*', csrf()), membersApp.use('*', csrf())) — this is a
// browser-only HTML-form target, so the Origin check applies even though
// there is no session to protect: it stops a cross-site page from silently
// minting a member + token pair and planting the pending-invite cookie in a
// visitor's browser.
inviteApp.use('*', csrf())

inviteApp.get('/:id', async (c) => {
  // WARN-A: same no-store/no-referrer floor as the JSON token-mint routes
  // (src/members/index.ts) — set once, before any branch, so it lands on
  // every response this handler can return (Hono's c.header() carries
  // through into c.html() regardless of which branch/status runs).
  protectRawTokenResponse(c)
  const inviteId = c.req.param('id')
  const view = await loadInviteLanding(c.env, inviteId)
  if (view.kind === 'not_found') return c.html(inviteNotFoundBody(c.env.BRAND), 404)
  if (view.kind === 'already_accepted') return c.html(inviteAlreadyAcceptedBody(c.env.BRAND), 409)
  if (view.kind === 'telegram_only') return c.html(inviteTelegramOnlyBody(c.env.BRAND, view.ctx))
  return c.html(invitePageBody(c.env.BRAND, view.ctx))
})

interface AcceptInviteForm {
  display_name?: string | string[]
}

inviteApp.post('/:id', async (c) => {
  // WARN-A: see the GET handler above — same headers, every response this
  // handler can return (error pages AND the success redirect).
  protectRawTokenResponse(c)
  const inviteId = c.req.param('id')

  // Re-check state before minting: a stale form re-submitted after the invite
  // was already accepted/removed elsewhere must not fall through to
  // acceptInvite and rely on ITS error mapping alone — the human-facing page
  // wants the same not-found/already-used/telegram-only copy the GET renders.
  const view = await loadInviteLanding(c.env, inviteId)
  if (view.kind === 'not_found') return c.html(inviteNotFoundBody(c.env.BRAND), 404)
  if (view.kind === 'already_accepted') return c.html(inviteAlreadyAcceptedBody(c.env.BRAND), 409)
  if (view.kind === 'telegram_only') return c.html(inviteTelegramOnlyBody(c.env.BRAND, view.ctx), 409)

  const form = (await c.req.parseBody()) as AcceptInviteForm
  const raw = form.display_name
  const displayName = (typeof raw === 'string' ? raw : '').trim()
  if (!displayName) {
    return c.html(invitePageBody(c.env.BRAND, view.ctx, 'Enter your name to continue.'), 400)
  }

  // LOAD-BEARING: the public JSON accept mints a token but writes no KV
  // marker; the web path writes the marker but mints no token; flipping
  // this to true lets a JSON-accepted invite be linked to a victim's
  // Google identity (adversarial gate #1458).
  const result = await acceptInvite(c.env, inviteId, displayName, { mintToken: false })
  if (!result.ok) {
    if (result.error === 'invite_not_found') return c.html(inviteNotFoundBody(c.env.BRAND), 404)
    if (result.error === 'invite_already_accepted') return c.html(inviteAlreadyAcceptedBody(c.env.BRAND), 409)
    if (result.error === 'project_invite_requires_telegram') {
      return c.html(inviteTelegramOnlyBody(c.env.BRAND, view.ctx), 409)
    }
    if (result.error === 'invalid_display_name') {
      return c.html(
        invitePageBody(c.env.BRAND, view.ctx, 'Enter a name up to 120 characters long.'),
        400,
      )
    }
    // member_already_exists
    return c.html(
      invitePageBody(c.env.BRAND, view.ctx, 'An account already exists for this email. Sign in instead.'),
      409,
    )
  }

  // mupot#1436 A2 (gated, not built here): stash a short-lived pointer to the
  // just-minted member so a follow-on login can link the two.
  //
  // mupot#1436 round 2 P1-D, contract per Athena's design ruling — the A2
  // SECURITY CONTRACT this marker's future reader (the /auth/callback
  // handler, NOT built here) MUST honor:
  //
  //   1. CALLBACK IS LINK-ONLY. On a valid marker, callback calls
  //      linkLoginIdentity(memberIdFromInviteRow, ...) — the member id comes
  //      from the D1 invite row (step 2), never from the marker being
  //      trusted blind. It MUST NOT call findOrCreateHumanMember(...) or
  //      resolveHumanMemberId(email) for this flow: those are the ordinary
  //      no-invite login path, and running them here would let the callback
  //      silently create or attach to a DIFFERENT member than the one this
  //      invite minted.
  //   2. D1 IS THE AUTHORITY, KV IS ONLY A POINTER. The callback re-reads
  //      the invite row by marker.invite_id and requires BOTH: accepted_at
  //      IS NOT NULL (this exact accept happened), AND the IdP-verified
  //      email from the OAuth response equals invite.email, compared
  //      case-normalized (lower-cased, matching idx_members_email_lower's
  //      own normalization). The KV blob (invite_id/member_id/issued_at) is
  //      never itself sufficient to link — it is a lookup key, not a claim.
  //   3. KV IS SINGLE-USE VIA ATOMIC DELETE ON FIRST READ. The callback
  //      must delete the KV key in the same step it reads it (get-then-
  //      delete, no window where a replayed callback can read it twice).
  //      TTL at write time is 600–900s — long enough for a real OAuth
  //      round-trip, short enough that an abandoned marker is not a
  //      standing liability.
  //   4. THE MARKER MUST BE BOUND TO THE OAUTH STATE the callback already
  //      validates for CSRF (auth/index.ts's existing state check) — one
  //      state value links AT MOST ONE invite. A foreign or replayed state
  //      arriving with a stale/foreign marker cookie links NOTHING; the
  //      binding must be checked before step 1 runs, not after.
  //   5. THE REFUSAL PAGE NAMES ORG/SQUAD ONLY, NEVER AN EMAIL — if the
  //      email-equality check in (2) fails, or the state binding in (4)
  //      fails, the human-facing failure copy may say which org/squad the
  //      invite was for, but must never echo invite.email or the IdP email
  //      back into the page (same PII discipline as P1-B on this page).
  //
  // A2's reader is src/auth/pending-invite-link.ts (via /auth/login +
  // /auth/callback). The KV payload deliberately carries NO email (data
  // minimization — D1's invite row is the source of truth per (2)).
  const pendingId = randomHex(24)
  await c.env.SESSIONS.put(
    `${PENDING_INVITE_KV_PREFIX}${pendingId}`,
    JSON.stringify({
      invite_id: inviteId,
      member_id: result.value.member_id,
      issued_at: new Date().toISOString(),
    }),
    { expirationTtl: PENDING_INVITE_TTL_SECONDS },
  )
  setCookie(c, PENDING_INVITE_COOKIE, pendingId, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: PENDING_INVITE_TTL_SECONDS,
  })

  return c.redirect('/auth/login')
})

/** Cryptographically-random opaque id (hex). Local copy of the same shape
 *  auth/index.ts's randomId uses — not exported from there, and small enough
 *  not to be worth a cross-module dependency for one helper. */
function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  let s = ''
  for (const b of buf) s += b.toString(16).padStart(2, '0')
  return s
}
