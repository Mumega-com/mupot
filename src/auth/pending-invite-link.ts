// mupot#1436 A2 — pending-invite → login-identity link (Athena-gated).
//
// The invite-landing page writes a short-lived KV pointer + cookie after
// accept. This module is the ONLY reader: /auth/login binds the pointer to
// OAuth state, and /auth/callback consumes it. Callback is LINK-ONLY — it
// calls linkLoginIdentity against the member id on the D1 invite row. It
// never calls findOrCreateHumanMember or resolveHumanMemberId.

import type { Env } from '../types'
import { linkLoginIdentity, type LinkLoginIdentityResult } from './login-identity'

export const PENDING_INVITE_COOKIE = 'mupot_pending_invite'
export const PENDING_INVITE_KV_PREFIX = 'pending_invite_link:'
export const PENDING_INVITE_TTL_SECONDS = 600

export interface PendingInviteMarker {
  invite_id: string
  member_id: string
  issued_at: string
}

export interface InviteLinkAuthority {
  invite_id: string
  email: string
  accepted_at: string
  member_id: string
  squad_name: string | null
}

export type InviteLinkDecision =
  | { action: 'skip' }
  | { action: 'link'; memberId: string }
  | {
      action: 'refuse'
      reason:
        | 'state_binding'
        | 'missing_marker'
        | 'd1_mismatch'
        | 'email_mismatch'
        | 'identity_conflict'
      orgName: string
      squadName: string | null
    }

/** Same normalization as idx_members_email_lower (0146). */
export function normalizeInviteEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function pendingInviteEmailsMatch(inviteEmail: string, idpEmail: string): boolean {
  return normalizeInviteEmail(inviteEmail) === normalizeInviteEmail(idpEmail)
}

/**
 * Extract the pending-invite id the login route bound into OAuth state.
 * A reauth payload or the ordinary literal '1' bind nothing.
 */
export function parsePendingInviteIdFromState(seen: string): string | null {
  if (seen === '1') return null
  try {
    const parsed = JSON.parse(seen) as { pending_invite?: unknown; reauth?: unknown }
    if (parsed.reauth === true) return null
    if (typeof parsed.pending_invite === 'string' && parsed.pending_invite.length > 0) {
      return parsed.pending_invite
    }
  } catch {
    // Unrecognised state payload — not an invite bind.
  }
  return null
}

export function parsePendingInviteMarker(raw: string): PendingInviteMarker | null {
  try {
    const parsed = JSON.parse(raw) as Partial<PendingInviteMarker>
    if (
      typeof parsed.invite_id === 'string'
      && parsed.invite_id.length > 0
      && typeof parsed.member_id === 'string'
      && parsed.member_id.length > 0
      && typeof parsed.issued_at === 'string'
      && parsed.issued_at.length > 0
    ) {
      return {
        invite_id: parsed.invite_id,
        member_id: parsed.member_id,
        issued_at: parsed.issued_at,
      }
    }
  } catch {
    /* malformed */
  }
  return null
}

/** Get-then-delete. The marker is single-use even when D1 later refuses. */
export async function consumePendingInviteMarker(
  env: Env,
  pendingId: string,
): Promise<PendingInviteMarker | null> {
  const key = `${PENDING_INVITE_KV_PREFIX}${pendingId}`
  const raw = await env.SESSIONS.get(key)
  await env.SESSIONS.delete(key)
  if (!raw) return null
  return parsePendingInviteMarker(raw)
}

export async function loadInviteLinkAuthority(
  env: Env,
  inviteId: string,
): Promise<InviteLinkAuthority | null> {
  const invite = await env.DB.prepare(
    `SELECT i.id AS invite_id, i.email, i.accepted_at, i.member_id, s.name AS squad_name
       FROM invites i
       LEFT JOIN squads s ON s.id = i.squad_id
      WHERE i.id = ?1
      LIMIT 1`,
  )
    .bind(inviteId)
    .first<{
      invite_id: string
      email: string
      accepted_at: string | null
      member_id: string | null
      squad_name: string | null
    }>()

  if (!invite || !invite.accepted_at || !invite.member_id) return null
  return {
    invite_id: invite.invite_id,
    email: invite.email,
    accepted_at: invite.accepted_at,
    member_id: invite.member_id,
    squad_name: invite.squad_name,
  }
}

/**
 * CSRF + D1 authority gate. Cookie must equal the id bound into OAuth state.
 * Member id for the eventual link comes from D1, never from the KV blob.
 */
export async function decidePendingInviteLink(input: {
  env: Env
  statePendingId: string | null
  cookiePendingId: string | undefined
  idpEmail: string | null
  orgName: string
}): Promise<InviteLinkDecision> {
  const orgName = input.orgName
  if (input.statePendingId === null) return { action: 'skip' }

  if (!input.cookiePendingId || input.cookiePendingId !== input.statePendingId) {
    return { action: 'refuse', reason: 'state_binding', orgName, squadName: null }
  }

  const marker = await consumePendingInviteMarker(input.env, input.statePendingId)
  if (!marker) {
    return { action: 'refuse', reason: 'missing_marker', orgName, squadName: null }
  }

  const authority = await loadInviteLinkAuthority(input.env, marker.invite_id)
  if (!authority) {
    return { action: 'refuse', reason: 'd1_mismatch', orgName, squadName: null }
  }

  if (!input.idpEmail || !pendingInviteEmailsMatch(authority.email, input.idpEmail)) {
    return {
      action: 'refuse',
      reason: 'email_mismatch',
      orgName,
      squadName: authority.squad_name,
    }
  }

  return { action: 'link', memberId: authority.member_id }
}

export async function linkAcceptedInviteIdentity(
  env: Env,
  input: {
    tenant: string
    provider: string
    providerSubject: string
    verifiedEmail: string
    memberId: string
  },
): Promise<LinkLoginIdentityResult> {
  return linkLoginIdentity(env, {
    tenant: input.tenant,
    provider: input.provider,
    providerSubject: input.providerSubject,
    verifiedEmail: input.verifiedEmail,
    memberId: input.memberId,
  })
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Refuse page: org/squad only. Never echoes invite.email or the IdP email. */
export function inviteLoginMismatchBody(
  brand: string,
  ctx: { orgName: string; squadName: string | null },
): string {
  const squadRow = ctx.squadName
    ? `<dt>Squad</dt><dd>${esc(ctx.squadName)}</dd>`
    : ''
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>Invite account mismatch · ${esc(brand)}</title>
    <style>
      :root { color-scheme: light dark; }
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
      p.muted { color: #7a827d; font-size: 13px; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>This invite is for a different account</h1>
      <dl class="kv">
        <dt>Organization</dt><dd>${esc(ctx.orgName)}</dd>
        ${squadRow}
      </dl>
      <p class="muted">Sign in with the account that received this invite, then accept again if you still need access. Ask an admin for a fresh invite if this one is already used.</p>
      <p><a href="/auth/login">Sign in with a different account →</a></p>
    </div>
  </body>
</html>`
}
