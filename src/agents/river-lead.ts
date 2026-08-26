// src/agents/river-lead.ts — River lead agent profile (D1 + Co-Pilot).
//
// The migration inserts this row only when squad-core already exists so the
// empty-schema test chain still leaves ZERO rows. Tests and local seed call
// ensureRiverLeadAgent() after creating squad-core.

import type { Env } from '../types'

export const RIVER_AGENT_ID = 'river'
export const RIVER_AGENT_SLUG = 'river'
export const RIVER_AGENT_NAME = 'River'
export const RIVER_AGENT_ROLE = 'lead'
export const RIVER_AGENT_MODEL = 'gemini-3.7-flash'
export const RIVER_SQUAD_ID = 'squad-core'
export const RIVER_AGENT_PURPOSE = 'Council Lead & Autonomous Fleet Steering'
export const RIVER_CURSOR_SEAT = 'river-cursor'

export const RIVER_LEAD_PROFILE = {
  id: RIVER_AGENT_ID,
  slug: RIVER_AGENT_SLUG,
  name: RIVER_AGENT_NAME,
  role: RIVER_AGENT_ROLE,
  model: RIVER_AGENT_MODEL,
  squad_id: RIVER_SQUAD_ID,
  purpose: RIVER_AGENT_PURPOSE,
} as const

const UPSERT_SQL = `
INSERT INTO agents (id, squad_id, slug, name, role, model, status, purpose)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7
WHERE EXISTS (SELECT 1 FROM squads WHERE id = ?2 OR slug = ?2)
ON CONFLICT(id) DO UPDATE SET
  squad_id = excluded.squad_id,
  slug = excluded.slug,
  name = excluded.name,
  role = excluded.role,
  model = excluded.model,
  status = 'active',
  purpose = excluded.purpose
`

export async function ensureRiverLeadAgent(
  env: Pick<Env, 'DB'>,
): Promise<{ ok: true; inserted: boolean; profile: typeof RIVER_LEAD_PROFILE } | { ok: false; reason: string }> {
  try {
    const result = await env.DB.prepare(UPSERT_SQL)
      .bind(
        RIVER_LEAD_PROFILE.id,
        RIVER_LEAD_PROFILE.squad_id,
        RIVER_LEAD_PROFILE.slug,
        RIVER_LEAD_PROFILE.name,
        RIVER_LEAD_PROFILE.role,
        RIVER_LEAD_PROFILE.model,
        RIVER_LEAD_PROFILE.purpose,
      )
      .run()
    return {
      ok: true,
      inserted: (result.meta?.changes ?? 0) > 0,
      profile: RIVER_LEAD_PROFILE,
    }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

export async function loadRiverLeadAgent(
  env: Pick<Env, 'DB'>,
): Promise<{
  id: string
  slug: string
  name: string
  role: string
  model: string
  squad_id: string
  purpose: string | null
} | null> {
  return env.DB.prepare(
    `SELECT id, squad_id, slug, name, role, model, purpose
       FROM agents WHERE id = ?1 OR slug = ?1 LIMIT 1`,
  )
    .bind(RIVER_AGENT_SLUG)
    .first()
}
