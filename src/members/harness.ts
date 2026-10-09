// mupot#1794 W1 — harnesses: one row per (tenant, human member, OAuth client install).
//
// A harness is the OAuth client a human consented through (Cursor, ChatGPT, Claude, Grok ...).
// Its row exists so a later seat_select call can prove WHICH install it is acting for. It is a
// pointer plus display labels: client_name / kind are NEVER authority and never feed an
// authorization decision (src/members/seat-select.ts re-derives authority from the human's
// live grants).
//
// Everything here is behind SEAT_AUTO_ENROLL === '1' at the call sites. This module itself
// has no flag logic except the one shared predicate below.

import type { Env } from '../types'

/** The one definition of "is zero-touch seat enrolment on". Strict '1' — unset/anything else
 *  is off, so a typo'd or empty var can never enable an auth-adjacent write path. */
export function seatAutoEnrollEnabled(env: Pick<Env, 'SEAT_AUTO_ENROLL'>): boolean {
  return env.SEAT_AUTO_ENROLL === '1'
}

export interface HarnessRow {
  id: string
  tenant: string
  member_id: string
  oauth_client_id: string
  client_name: string
  kind: string
  created_at: string
}

// Label-only classifier. Unknown names fall to 'other'; this is display text, not policy.
const KIND_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['cursor', /cursor/i],
  ['chatgpt', /chatgpt|openai/i],
  ['claude', /claude|anthropic/i],
  ['grok', /grok|xai/i],
  ['codex', /codex/i],
  ['gemini', /gemini|antigravity/i],
]

export function classifyHarnessKind(clientName: string): string {
  for (const [kind, re] of KIND_PATTERNS) if (re.test(clientName)) return kind
  return 'other'
}

/** Strip control chars (incl. newlines), collapse whitespace, cap length. For labels only. */
export function sanitizeLabel(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return ''
  // eslint-disable-next-line no-control-regex -- deliberately stripping C0/C1 control characters
  const cleaned = raw.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned.slice(0, max)
}

/**
 * Find-or-create the harness row for (tenant, member, oauth_client_id) and return it. A
 * re-consent through the same client refreshes the display labels only. Returns null on any
 * failure — the caller treats the harness as best-effort (a session without a harness id simply
 * cannot call seat_select; it can never gain anything from a failed upsert).
 */
export async function upsertHarness(
  env: Env,
  memberId: string,
  oauthClientId: string,
  clientNameRaw: unknown,
): Promise<HarnessRow | null> {
  const clientId = typeof oauthClientId === 'string' ? oauthClientId.trim() : ''
  if (!clientId || clientId.length > 512) return null
  const clientName = sanitizeLabel(clientNameRaw, 120)
  const kind = classifyHarnessKind(clientName)
  await env.DB.prepare(
    `INSERT INTO harnesses (id, tenant, member_id, oauth_client_id, client_name, kind)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT (tenant, member_id, oauth_client_id)
     DO UPDATE SET client_name = excluded.client_name, kind = excluded.kind`,
  ).bind(crypto.randomUUID(), env.TENANT_SLUG, memberId, clientId, clientName, kind).run()
  return env.DB.prepare(
    `SELECT id, tenant, member_id, oauth_client_id, client_name, kind, created_at
       FROM harnesses
      WHERE tenant = ?1 AND member_id = ?2 AND oauth_client_id = ?3
      LIMIT 1`,
  ).bind(env.TENANT_SLUG, memberId, clientId).first<HarnessRow>()
}

/** Live re-read of a harness the session CLAIMS. Tenant + member + id must all match; a
 *  harness id belonging to another human (or tenant) reads as absent. */
export async function loadHarness(env: Env, memberId: string, harnessId: string): Promise<HarnessRow | null> {
  if (typeof harnessId !== 'string' || harnessId.length === 0) return null
  return env.DB.prepare(
    `SELECT id, tenant, member_id, oauth_client_id, client_name, kind, created_at
       FROM harnesses
      WHERE id = ?1 AND tenant = ?2 AND member_id = ?3
      LIMIT 1`,
  ).bind(harnessId, env.TENANT_SLUG, memberId).first<HarnessRow>()
}
