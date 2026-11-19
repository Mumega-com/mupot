// mupot#980005ac stage 1 — Helper/Full authority level + absolute expiry for attached seats.
//
// THIS IS NOT THE CAPABILITY CEILING (member|lead|full in attached-ceiling.ts). That ceiling still
// clamps rank. This module is the human's deliberate per-attachment MODE:
//   helper = today's attached behaviour (unchanged)
//   full   = recorded + expiry-bound; stage 1 MUST NOT widen any action beyond helper
//
// Authority is never inferred from harness, model, directory name, label or tool result.

export const ATTACH_AUTHORITY_LEVELS = ['helper', 'full'] as const
export type AttachAuthorityLevel = (typeof ATTACH_AUTHORITY_LEVELS)[number]

/** Absolute default and hard max for a new authority decision (days). Shorter is allowed. */
export const ATTACH_AUTHORITY_DEFAULT_DAYS = 7
export const ATTACH_AUTHORITY_MAX_DAYS = 7

export function isAttachAuthorityLevel(v: unknown): v is AttachAuthorityLevel {
  return typeof v === 'string' && (ATTACH_AUTHORITY_LEVELS as readonly string[]).includes(v)
}

/**
 * Parse the human's Helper/Full choice from a form/JSON body.
 * Missing / empty / unknown → helper. Full is NEVER the default and NEVER inferred.
 */
export function parseAttachAuthorityLevel(raw: unknown): AttachAuthorityLevel {
  if (typeof raw !== 'string') return 'helper'
  const v = raw.trim().toLowerCase()
  return v === 'full' ? 'full' : 'helper'
}

/**
 * Parse a human-selected duration in whole days. Default 7. Cap at 7. Refuse non-integers,
 * zero, negatives and values above the max by clamping down to the max (never lengthen).
 * Returns null only when the input is explicitly unusable AND we must refuse the write
 * (non-finite / non-integer when present as a number-like string that is not empty).
 */
export function parseAttachAuthorityDays(raw: unknown): { ok: true; days: number } | { ok: false; error: 'invalid_authority_days' } {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, days: ATTACH_AUTHORITY_DEFAULT_DAYS }
  }
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    return { ok: false, error: 'invalid_authority_days' }
  }
  return { ok: true, days: Math.min(n, ATTACH_AUTHORITY_MAX_DAYS) }
}

/** Absolute UTC expiry for a new decision (SQLite-friendly, same shape as nowSqlUtc). */
export function authorityExpiresAtIso(days: number, nowMs: number = Date.now()): string {
  const d = Math.min(Math.max(1, Math.floor(days)), ATTACH_AUTHORITY_MAX_DAYS)
  return new Date(nowMs + d * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
}

/** Shared absolute-expiry rule. NULL is a pre-migration grandfathered decision; malformed dates fail closed. */
export function authorityLiveSql(alias: string, now: string): string {
  return `(${alias}.authority_expires_at IS NULL OR julianday(${alias}.authority_expires_at) > julianday(${now}))`
}
