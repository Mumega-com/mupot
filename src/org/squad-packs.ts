// mupot — squad packs (#11): a reproducible "starter org unit" = one squad + its
// work-units, defined as repo config and instantiated through the OWNER product
// surface (never raw SQL). Extends the agent-template idea (#14) up to the squad
// level so a branded HQ can be seeded in one owner action.
//
// Dogfood discipline: seedSquadPack calls the SAME createSquad / createAgent
// service functions the dashboard + JSON API use — full validation, no D1 bypass.
// The dashboard route that calls it is owner/admin-gated like every other org write.

import type { Effort, Autonomy, Env, Squad, Agent } from '../types'
import { createSquad, createAgent } from './service'
import type { CreateResult } from './service'

// ── shapes ─────────────────────────────────────────────────────────────────────

export interface PackAgent {
  slug: string
  name: string
  role: string
  okr: string
  kpi_target: string
  effort: Effort
  autonomy: Autonomy
}

export interface SquadPack {
  key: string          // unique pack id (also the squad slug)
  name: string         // squad display name
  charter: string      // the squad's mandate + culture (its "book-as-charter")
  role: string         // squad-level accountability line
  okr: string
  kpi_target: string
  effort: Effort
  autonomy: Autonomy
  agents: PackAgent[]
  description: string  // one-line human explanation for the picker
}

// ── the packs ────────────────────────────────────────────────────────────────
//
// Shabrang (#11): the Persian-mythology media brand as a squad inside the house
// pot (Digidinc). The book (The Liquid Fortress) is the FREE, highly-processed
// charter/source; revenue is downstream media — bilingual children's books, 3D
// symbols/merch, NotebookLM/Suno media. Autonomy is conservative by default; the
// owner dials it up from the agent panel once each unit has been seen to run.
export const SQUAD_PACKS: SquadPack[] = [
  {
    key: 'shabrang',
    name: 'Shabrang',
    role: 'Brand HQ',
    charter:
      'Shabrang is a Persian-mythology media brand. The book "The Liquid Fortress" is ' +
      'free and highly processed — it is the source and the charter: decisions and ' +
      'creative work draw from its world. We do not sell the book; it is the fan engine. ' +
      'Revenue is downstream: bilingual children’s books, 3D symbols and merch, and ' +
      'processed media (video, audio). Tap Persian mythology with respect, build a universe.',
    okr: 'Grow the Shabrang universe and its audience without selling the book',
    kpi_target: '8 published media pieces / month',
    effort: 'standard',
    autonomy: 'draft',
    description: 'Persian-mythology media brand HQ — Oracle, story, media, and community units.',
    agents: [
      {
        slug: 'oracle-keeper',
        name: 'Oracle Keeper',
        role: 'Lore Oracle',
        okr: 'Keep the book’s world accessible — answer reader questions from the source',
        kpi_target: '20 reader questions answered / week',
        effort: 'low',
        autonomy: 'suggest',
      },
      {
        slug: 'story-weaver',
        name: 'Story Weaver',
        role: 'Children’s Author',
        okr: 'Turn Persian myth into bilingual children’s stories the brand can publish',
        kpi_target: '2 story drafts / month',
        effort: 'standard',
        autonomy: 'draft',
      },
      {
        slug: 'media-smith',
        name: 'Media Smith',
        role: 'Media Producer',
        okr: 'Process the world into media — video, audio, and 3D symbol briefs',
        kpi_target: '4 media pieces / month',
        effort: 'standard',
        autonomy: 'draft',
      },
      {
        slug: 'community-scout',
        name: 'Community Scout',
        role: 'Community',
        okr: 'Find and warm the Persian-niche audience so the universe has a home',
        kpi_target: '15 community opportunities / week',
        effort: 'low',
        autonomy: 'suggest',
      },
    ],
  },
]

/** Look up a pack by key. Returns undefined when not found. */
export function getSquadPack(key: string): SquadPack | undefined {
  return SQUAD_PACKS.find((p) => p.key === key)
}

// ── seeding ────────────────────────────────────────────────────────────────────

export interface SeedPackResult {
  ok: boolean
  error?: string
  squad?: Squad
  agents: Agent[]
  agentErrors: Array<{ slug: string; error: string }>
}

export interface SeedPackDeps {
  createSquad?: typeof createSquad
  createAgent?: typeof createAgent
}

/**
 * seedSquadPack — instantiate a pack (squad + its agents) under a department.
 *
 * Uses the canonical createSquad / createAgent service functions (validation +
 * defaults + UNIQUE handling), so this is identical to creating them by hand
 * through the dashboard — just batched. If the squad already exists (slug taken)
 * the whole seed is refused (idempotent-ish: re-running does not duplicate). An
 * individual agent slug collision is recorded in agentErrors and skipped, never
 * aborting the rest (so a partial re-run can fill in missing agents).
 */
export async function seedSquadPack(
  env: Env,
  departmentId: string,
  packKey: string,
  deps: SeedPackDeps = {},
): Promise<SeedPackResult> {
  const pack = getSquadPack(packKey)
  if (!pack) return { ok: false, error: 'unknown_pack', agents: [], agentErrors: [] }

  const doCreateSquad = deps.createSquad ?? createSquad
  const doCreateAgent = deps.createAgent ?? createAgent

  const squadResult: CreateResult<Squad> = await doCreateSquad(env, departmentId, {
    slug: pack.key,
    name: pack.name,
    charter: pack.charter,
    role: pack.role,
    okr: pack.okr,
    kpi_target: pack.kpi_target,
    effort: pack.effort,
    autonomy: pack.autonomy,
  })
  if (!squadResult.ok) {
    return { ok: false, error: squadResult.error, agents: [], agentErrors: [] }
  }

  const squad = squadResult.value
  const agents: Agent[] = []
  const agentErrors: Array<{ slug: string; error: string }> = []

  for (const a of pack.agents) {
    const r = await doCreateAgent(env, squad.id, {
      slug: a.slug,
      name: a.name,
      role: a.role,
      okr: a.okr,
      kpi_target: a.kpi_target,
      effort: a.effort,
      autonomy: a.autonomy,
    })
    if (r.ok) agents.push(r.value)
    else agentErrors.push({ slug: a.slug, error: r.error })
  }

  return { ok: true, squad, agents, agentErrors }
}
