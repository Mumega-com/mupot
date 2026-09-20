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
// mupot#1436 A2 (gated by Athena, NOT built here): after a successful accept
// this page sets a short-lived "pending invite" marker (KV + HttpOnly cookie)
// but does NOT touch /auth/callback to consume it. Until A2 lands, the marker
// simply expires unused after 10 minutes — this page's own behaviour (mint
// member + capability + token, then send the human to log in) is correct and
// complete on its own; A2 only wires the LOGIN side to notice the marker.

import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import { html, raw as honoRaw } from 'hono/html'
import { setCookie } from 'hono/cookie'
import type { Env, Capability } from '../types'
import { acceptInvite } from '../members'

type AppEnv = { Bindings: Env }

export const PENDING_INVITE_COOKIE = 'mupot_pending_invite'
export const PENDING_INVITE_KV_PREFIX = 'pending_invite_link:'
export const PENDING_INVITE_TTL_SECONDS = 600

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
  capability: Capability
  invited_by: string | null
  accepted_at: string | null
}

/**
 * Best-effort human label for the inviter. Tries the members table first
 * (network members carry a display_name), falls back to the legacy web
 * users table (email only — no display_name column), and finally to a
 * generic label rather than leaking "member_not_found"-shaped detail to an
 * unauthenticated visitor.
 */
async function resolveInviterName(env: Env, invitedBy: string | null): Promise<string> {
  if (!invitedBy) return 'an admin'
  const member = await env.DB.prepare('SELECT display_name FROM members WHERE id = ?1 LIMIT 1')
    .bind(invitedBy)
    .first<{ display_name: string | null }>()
  if (member?.display_name) return member.display_name
  const user = await env.DB.prepare('SELECT email FROM users WHERE id = ?1 LIMIT 1')
    .bind(invitedBy)
    .first<{ email: string | null }>()
  if (user?.email) return user.email
  return 'an admin'
}

export async function loadInviteLanding(env: Env, inviteId: string): Promise<InviteLandingView> {
  const invite = await env.DB.prepare(
    `SELECT id, department_id, project_id, squad_id, pairing_hash, capability,
            invited_by, accepted_at
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

  // 0152's trigger keeps project_id/squad_id/pairing_hash jointly null or all
  // set, so pairing_hash alone is the reliable "this is a Telegram/project
  // invite" signal — it is redeemed ONLY through the authenticated Hermes
  // webhook (redeemTelegramProjectInvite, ../members/project-invites.ts).
  return invite.pairing_hash !== null
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

  const result = await acceptInvite(c.env, inviteId, displayName)
  if (!result.ok) {
    if (result.error === 'invite_not_found') return c.html(inviteNotFoundBody(c.env.BRAND), 404)
    if (result.error === 'invite_already_accepted') return c.html(inviteAlreadyAcceptedBody(c.env.BRAND), 409)
    if (result.error === 'project_invite_requires_telegram') {
      return c.html(inviteTelegramOnlyBody(c.env.BRAND, view.ctx), 409)
    }
    // member_already_exists
    return c.html(
      invitePageBody(c.env.BRAND, view.ctx, 'An account already exists for this email. Sign in instead.'),
      409,
    )
  }

  // mupot#1436 A2 (gated, not built here): stash a short-lived pointer to the
  // just-minted member so a follow-on login can link the two — WITHOUT ever
  // handing the raw workspace token to the browser. The raw token minted
  // inside acceptInvite is intentionally DISCARDED here (never read out of
  // `result.value.token.raw`, never logged): a web visitor authenticates by
  // logging in (OAuth/session), not by holding a bearer token, and the token
  // API redemption path is the one that DOES need to hand it back once. The
  // callback itself is not touched here; until A2 wires it up, this marker
  // simply expires unused after PENDING_INVITE_TTL_SECONDS.
  const pendingId = randomHex(24)
  await c.env.SESSIONS.put(
    `${PENDING_INVITE_KV_PREFIX}${pendingId}`,
    JSON.stringify({
      invite_id: inviteId,
      member_id: result.value.member_id,
      email: result.value.email,
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
