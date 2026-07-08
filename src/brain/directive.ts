// mupot — canonical human directive for the per-pot brain.
//
// The directive is a single tenant-local value under org_settings. It is not
// business content; it is substrate control state the brain reads before making
// the next decision. IM is one legitimate write path, but this helper keeps the
// storage/read shape shared by IM, the daemon API, and the dashboard.

import type { Env } from '../types'

export const HUMAN_DIRECTIVE_KEY = 'last_human_directive'
export const HUMAN_DIRECTIVE_MAX_CHARS = 2000

export interface HumanDirective {
  text: string
  by_member_id: string | null
  updated_at: string | null
  source: 'im' | 'host' | 'dashboard' | 'legacy'
}

export type HumanDirectiveAction = 'set' | 'clear'

export type HumanDirectiveValidation =
  | { ok: true; text: string }
  | { ok: false; reason: 'empty' | 'too_long' }

export function validateHumanDirectiveText(raw: string): HumanDirectiveValidation {
  const text = raw.trim()
  if (!text) return { ok: false, reason: 'empty' }
  if (text.length > HUMAN_DIRECTIVE_MAX_CHARS) return { ok: false, reason: 'too_long' }
  return { ok: true, text }
}

export function parseHumanDirectiveValue(raw: string | null): HumanDirective | null {
  if (raw === null) return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  try {
    const parsed = JSON.parse(trimmed) as Partial<HumanDirective>
    if (typeof parsed.text !== 'string' || parsed.text.trim().length === 0) return null
    return {
      text: parsed.text,
      by_member_id: typeof parsed.by_member_id === 'string' ? parsed.by_member_id : null,
      updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : null,
      source:
        parsed.source === 'im' || parsed.source === 'host' || parsed.source === 'dashboard'
          ? parsed.source
          : 'legacy',
    }
  } catch {
    return {
      text: trimmed,
      by_member_id: null,
      updated_at: null,
      source: 'legacy',
    }
  }
}

export async function getHumanDirective(env: Env): Promise<HumanDirective | null> {
  const row = await env.DB.prepare('SELECT value FROM org_settings WHERE key = ?1 LIMIT 1')
    .bind(HUMAN_DIRECTIVE_KEY)
    .first<{ value: string }>()
  return parseHumanDirectiveValue(row?.value ?? null)
}

export async function setHumanDirective(
  env: Env,
  input: {
    text: string
    byMemberId: string
    source?: HumanDirective['source']
    updatedAt?: string
  },
): Promise<HumanDirective> {
  const directive: HumanDirective = {
    text: input.text,
    by_member_id: input.byMemberId,
    updated_at: input.updatedAt ?? new Date().toISOString(),
    source: input.source ?? 'im',
  }

  await env.DB.prepare(
    `INSERT INTO org_settings (key, value, updated_at) VALUES (?1, ?2, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(HUMAN_DIRECTIVE_KEY, JSON.stringify(directive))
    .run()

  return directive
}

export async function clearHumanDirective(env: Env): Promise<void> {
  await env.DB.prepare('DELETE FROM org_settings WHERE key = ?1')
    .bind(HUMAN_DIRECTIVE_KEY)
    .run()
}
