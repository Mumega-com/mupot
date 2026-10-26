// mupot — claim link: the pending admission a chat filed (seat_attach), seen from the human's side as ONE link and ONE click.
//
// This module adds NO authority. A "claim" is the existing pending agent_seat_admissions row; claiming it is the existing
// decideAdmissionDirect (code check, designation re-check, squad-admin re-check, harness re-check, single promote batch).
// What it adds is the lookups the page needs, scoped to the signed-in member, and the checks that the link, the page and the
// write all name the SAME admission and the SAME agent:
//
//   * every lookup is scoped to human_member_id = the session member. Another member's code reads as not_found (no oracle).
//   * the code in the URL is passed to decideAdmissionDirect as the attach code, so the typed-code check is not bypassed on
//     the link path; the link IS the typed code.
//   * the confirm form carries the admission id and agent id the page SHOWED. The write re-resolves the code and refuses
//     (claim_changed) unless it still names that admission and that agent: a link can never claim an agent other than the
//     one displayed.
//   * single use and the TTL are the admission's own (status 'pending' + expires_at); nothing here extends either.
//
// The agent-page one-click (no code) is the same write; the server finds the member's own pending admission for THAT agent and
// supplies its stored code itself. The client asserts only an admission id, and it must be in the server-found set.

import type { Env } from '../types'
import { requiredCanonicalOrigin } from '../dashboard/connect'
import {
  admissionIsPendingLive,
  admissionView,
  decideAdmissionDirect,
  ensureAdmission,
  loadAdmission,
  seatAttachEnabled,
  type AdmissionRow,
} from './seat-attach'

export type ClaimState = 'pending' | 'already_claimed' | 'expired' | 'closed' | 'ambiguous' | 'not_found'

export interface ClaimView {
  admissionId: string
  agentId: string
  agentName: string
  agentSlug: string
  harnessName: string
  seatLabel: string | null
  /** The human whose sign-in the chat used (always the viewing member: lookups are scoped to them). */
  signedInAs: string
  requestedAt: string
  expiresAt: string | null
}

export type ClaimLookup =
  | { state: 'not_found' }
  | { state: 'ambiguous' }
  | { state: Exclude<ClaimState, 'not_found' | 'ambiguous'>; view: ClaimView; adm: AdmissionRow }

const CODE_RE = /^[A-Z0-9]{4}$/

/** 'ab-cd' / 'AB CD' / 'ABCD' -> 'ABCD'; anything else null. */
export function normalizeClaimCode(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 16) return null
  const n = raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return CODE_RE.test(n) ? n : null
}

/** The shareable link, or null when the pot has no usable pinned origin (the code alone still works on /connections). */
export function claimUrl(env: Env, code: string | null): string | null {
  const c = normalizeClaimCode(code)
  const origin = requiredCanonicalOrigin(env)
  if (!c || !origin.ok) return null
  return `${origin.origin}/claim/${c.slice(0, 2)}-${c.slice(2)}`
}

async function viewOf(env: Env, adm: AdmissionRow): Promise<ClaimView> {
  const v = await admissionView(env, adm)
  const m = await env.DB.prepare('SELECT display_name, email FROM members WHERE id = ?1 AND tenant = ?2 LIMIT 1')
    .bind(adm.human_member_id, env.TENANT_SLUG).first<{ display_name: string | null; email: string | null }>()
  return {
    admissionId: adm.id,
    agentId: adm.agent_id,
    agentName: v.agentName,
    agentSlug: v.agentSlug,
    harnessName: v.harnessName,
    seatLabel: v.seatLabel,
    signedInAs: [m?.display_name, m?.email].filter((x): x is string => !!x).join(' · ') || adm.human_member_id,
    requestedAt: adm.created_at,
    expiresAt: adm.expires_at,
  }
}

/** Resolve a typed/linked code for THIS member. */
export async function lookupClaim(env: Env, memberId: string, rawCode: unknown, nowMs: number = Date.now()): Promise<ClaimLookup> {
  const code = normalizeClaimCode(rawCode)
  if (!code) return { state: 'not_found' }
  const ids = (await env.DB.prepare(
    `SELECT id FROM agent_seat_admissions
      WHERE tenant = ?1 AND human_member_id = ?2 AND attach_code IS NOT NULL AND replace(attach_code, '-', '') = ?3
      ORDER BY created_at DESC, id DESC LIMIT 6`,
  ).bind(env.TENANT_SLUG, memberId, code).all<{ id: string }>()).results ?? []
  const rows: AdmissionRow[] = []
  for (const r of ids) {
    const a = await loadAdmission(env, r.id)
    if (a && a.human_member_id === memberId) rows.push(a)
  }
  if (rows.length === 0) return { state: 'not_found' }
  const livePending = rows.filter((a) => admissionIsPendingLive(a, nowMs))
  // Two simultaneously pending asks sharing one code (a 1-in-~900k event): refuse rather than guess which agent is meant.
  if (livePending.length > 1) return { state: 'ambiguous' }
  const adm = livePending[0] ?? rows[0]
  const state: ClaimState = admissionIsPendingLive(adm, nowMs)
    ? 'pending'
    : adm.status === 'live'
      ? 'already_claimed'
      : adm.status === 'expired' || (adm.status === 'pending' && !admissionIsPendingLive(adm, nowMs))
        ? 'expired'
        : 'closed'
  return { state, view: await viewOf(env, adm), adm }
}

/** Did the claim produce a live attachment for the asking chat? (promote can make the admission live with no attachment: seat_gone / seat_already_attached.) */
async function seatIsAttachedVia(env: Env, admissionId: string): Promise<boolean> {
  const r = await env.DB.prepare(
    'SELECT 1 AS x FROM agent_seat_attachments WHERE tenant = ?1 AND admission_id = ?2 AND detached_at IS NULL LIMIT 1',
  ).bind(env.TENANT_SLUG, admissionId).first<{ x: number }>()
  return r !== null
}

export type ConfirmClaimResult =
  /** attached=false: the admission went live but the asking chat could not be attached (seat gone, or already acting as another agent). */
  | { ok: true; agentId: string; attached: boolean }
  | { ok: false; error: 'seat_attach_disabled' | 'claim_not_found' | 'claim_not_pending' | 'claim_changed' | 'attach_refused' | 'attach_code_mismatch' }

/** Claim by link: the code, and the admission + agent the page showed, must still all name one live pending ask of this member. */
export async function confirmClaimByCode(
  env: Env,
  p: { memberId: string; code: unknown; shownAdmissionId: unknown; shownAgentId: unknown },
  nowMs: number = Date.now(),
): Promise<ConfirmClaimResult> {
  if (!seatAttachEnabled(env)) return { ok: false, error: 'seat_attach_disabled' }
  const found = await lookupClaim(env, p.memberId, p.code, nowMs)
  if (found.state === 'not_found' || found.state === 'ambiguous') return { ok: false, error: 'claim_not_found' }
  if (found.state !== 'pending') return { ok: false, error: 'claim_not_pending' }
  if (found.adm.id !== p.shownAdmissionId || found.adm.agent_id !== p.shownAgentId) return { ok: false, error: 'claim_changed' }
  const r = await decideAdmissionDirect(env, {
    admissionId: found.adm.id, humanMemberId: p.memberId, decision: 'approve', ceiling: 'member', attachCode: normalizeClaimCode(p.code),
  }, nowMs)
  if (!r.ok) {
    if (r.error === 'not_pending') return { ok: false, error: 'claim_not_pending' }
    if (r.error === 'admission_not_found') return { ok: false, error: 'claim_not_found' }
    return { ok: false, error: r.error }
  }
  return { ok: true, agentId: found.adm.agent_id, attached: await seatIsAttachedVia(env, found.adm.id) }
}

export interface AgentClaims {
  pending: ClaimView[]
  /** An expired ask from a chat whose thread still exists: the human may issue a fresh one. */
  expired: ClaimView | null
}

/** This member's own claims on THIS agent (never another member's). */
export async function claimsForAgent(env: Env, memberId: string, agentId: string, nowMs: number = Date.now()): Promise<AgentClaims> {
  if (!seatAttachEnabled(env)) return { pending: [], expired: null }
  const ids = (await env.DB.prepare(
    `SELECT id FROM agent_seat_admissions
      WHERE tenant = ?1 AND human_member_id = ?2 AND agent_id = ?3 AND status IN ('pending', 'expired') AND requested_seat_id IS NOT NULL
      ORDER BY created_at DESC, id DESC LIMIT 10`,
  ).bind(env.TENANT_SLUG, memberId, agentId).all<{ id: string }>()).results ?? []
  const pending: ClaimView[] = []
  let expired: ClaimView | null = null
  for (const r of ids) {
    const a = await loadAdmission(env, r.id)
    if (!a || a.human_member_id !== memberId || a.agent_id !== agentId) continue
    if (admissionIsPendingLive(a, nowMs)) pending.push(await viewOf(env, a))
    else if (expired === null && (await reissueSeat(env, a))) expired = await viewOf(env, a)
  }
  // A live pending ask supersedes an expired one.
  return { pending, expired: pending.length > 0 ? null : expired }
}

/** The seat that asked, if it still exists, is this member's, is not retired and is not already attached. */
async function reissueSeat(env: Env, adm: AdmissionRow): Promise<{ seatId: string; seatAgentId: string } | null> {
  if (!adm.requested_seat_id) return null
  const seat = await env.DB.prepare(
    `SELECT s.id AS id, s.agent_id AS agent_id FROM agent_seats s
      WHERE s.id = ?1 AND s.tenant = ?2 AND s.member_id = ?3 AND s.harness_id = ?4 AND s.retired_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM agent_seat_attachments t WHERE t.seat_id = s.id AND t.detached_at IS NULL)
      LIMIT 1`,
  ).bind(adm.requested_seat_id, env.TENANT_SLUG, adm.human_member_id, adm.harness_id).first<{ id: string; agent_id: string }>()
  return seat ? { seatId: seat.id, seatAgentId: seat.agent_id } : null
}

/**
 * Agent-page one-click (no code). The member is the SESSION member; the admission must be in the set the server finds for
 * (this member, this agent) and still pending. The stored code is supplied by the server, deliberately: the page displayed the
 * asking chat (app, thread, time) to the signed-in owner in place of the typed code.
 */
export async function confirmClaimOnAgentPage(
  env: Env,
  p: { memberId: string; agentId: string; shownAdmissionId: unknown },
  nowMs: number = Date.now(),
): Promise<ConfirmClaimResult> {
  if (!seatAttachEnabled(env)) return { ok: false, error: 'seat_attach_disabled' }
  const mine = await claimsForAgent(env, p.memberId, p.agentId, nowMs)
  const hit = mine.pending.find((c) => c.admissionId === p.shownAdmissionId)
  if (!hit) return { ok: false, error: mine.pending.length > 0 ? 'claim_changed' : 'claim_not_found' }
  const adm = await loadAdmission(env, hit.admissionId)
  if (!adm || adm.human_member_id !== p.memberId || adm.agent_id !== p.agentId) return { ok: false, error: 'claim_changed' }
  const r = await decideAdmissionDirect(env, {
    admissionId: adm.id, humanMemberId: p.memberId, decision: 'approve', ceiling: 'member', attachCode: adm.attach_code ?? undefined,
  }, nowMs)
  if (!r.ok) {
    if (r.error === 'not_pending') return { ok: false, error: 'claim_not_pending' }
    if (r.error === 'admission_not_found') return { ok: false, error: 'claim_not_found' }
    return { ok: false, error: r.error }
  }
  return { ok: true, agentId: p.agentId, attached: await seatIsAttachedVia(env, adm.id) }
}

export type ReissueResult =
  | { ok: true; claimUrl: string | null; code: string | null; expiresAt: string | null }
  | { ok: false; error: 'seat_attach_disabled' | 'nothing_to_reissue' | 'attach_refused' | 'too_many_pending_admissions' | 'approval_bound_to_other_chat' | 'attach_code_mismatch' }

/**
 * "Issue a new claim link": a fresh pending ask for the SAME agent, SAME member, SAME harness and SAME thread as the expired one.
 * It goes through ensureAdmission's 'tool' path, i.e. every guard a chat's own seat_attach has (designation, pending cap, agent
 * active, unique open slot). It cannot name a different agent or thread than the expired row; it grants nothing (still pending).
 */
export async function reissueClaim(env: Env, p: { memberId: string; agentId: string }, nowMs: number = Date.now()): Promise<ReissueResult> {
  if (!seatAttachEnabled(env)) return { ok: false, error: 'seat_attach_disabled' }
  const mine = await claimsForAgent(env, p.memberId, p.agentId, nowMs)
  if (!mine.expired) return { ok: false, error: 'nothing_to_reissue' }
  const old = await loadAdmission(env, mine.expired.admissionId)
  if (!old || old.human_member_id !== p.memberId || old.agent_id !== p.agentId) return { ok: false, error: 'nothing_to_reissue' }
  const seat = await reissueSeat(env, old)
  if (!seat) return { ok: false, error: 'nothing_to_reissue' }
  const r = await ensureAdmission(env, {
    agentId: p.agentId, humanMemberId: p.memberId, harnessId: old.harness_id, seatId: seat.seatId, via: 'tool', requesterAgentId: seat.seatAgentId,
  }, nowMs)
  if (!r.ok) return { ok: false, error: r.error }
  if (r.state !== 'pending') return { ok: false, error: 'nothing_to_reissue' }
  return { ok: true, claimUrl: claimUrl(env, r.admission.attach_code), code: r.admission.attach_code, expiresAt: r.admission.expires_at }
}

/**
 * What a seat session's boot_context shows: the pending claim THIS seat filed (never another seat's), with its link. Server-derived
 * from the seat binding; the code is also what the chat already received from seat_attach.
 */
export async function pendingClaimForSeat(
  env: Env,
  seat: { seatId: string; humanMemberId: string },
  nowMs: number = Date.now(),
): Promise<{ claim_url: string | null; attach_code: string; agent: string; expires_at: string } | null> {
  if (!seatAttachEnabled(env)) return null
  const row = await env.DB.prepare(
    `SELECT d.id AS id FROM agent_seat_admissions d
      WHERE d.tenant = ?1 AND d.human_member_id = ?2 AND d.requested_seat_id = ?3 AND d.status = 'pending' AND d.attach_code IS NOT NULL AND d.expires_at > ?4
      ORDER BY d.created_at DESC LIMIT 1`,
  ).bind(env.TENANT_SLUG, seat.humanMemberId, seat.seatId, new Date(nowMs).toISOString()).first<{ id: string }>()
  if (!row) return null
  const adm = await loadAdmission(env, row.id)
  if (!adm || !adm.attach_code || !adm.expires_at || adm.requested_seat_id !== seat.seatId) return null
  const a = await env.DB.prepare('SELECT name, slug FROM agents WHERE id = ?1 LIMIT 1').bind(adm.agent_id).first<{ name: string; slug: string }>()
  return { claim_url: claimUrl(env, adm.attach_code), attach_code: adm.attach_code, agent: a?.slug || a?.name || adm.agent_id, expires_at: adm.expires_at }
}
