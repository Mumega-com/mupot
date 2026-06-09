// mupot — one-click outreach seeder (P5, #36).
//
// Creates the Outreach squad + a gated outreach Loop in one owner action — the dogfood
// path to a live loop (never raw SQL). The loop is GATED (every send human-approved),
// reads the prospect queue, and sends via the GHL act pipeline (keyed by act.tool on the
// gated path, so no channel ResourceRef is needed). Uses the canonical createSquad /
// createLoop services (full validation incl. the CASL backstop).

import type { Env, Squad } from '../types'
import { createSquad } from '../org/service'
import { createLoop } from './service'
import type { LoopManifest } from './manifest'

export interface SeedOutreachDeps {
  createSquad?: typeof createSquad
  createLoop?: typeof createLoop
  resolveDepartmentId?: (env: Env) => Promise<string | null>
}

export interface SeedOutreachResult {
  ok: boolean
  error?: string
  squad?: Squad
  loop?: LoopManifest
}

export async function seedOutreachLoop(env: Env, deps: SeedOutreachDeps = {}): Promise<SeedOutreachResult> {
  const doCreateSquad = deps.createSquad ?? createSquad
  const doCreateLoop = deps.createLoop ?? createLoop
  const resolveDept = deps.resolveDepartmentId ?? defaultResolveDepartmentId

  const departmentId = await resolveDept(env)
  if (!departmentId) return { ok: false, error: 'no_department' }

  const OKR = 'Book qualified meetings via compliant grant-diagnostic outreach'

  const squadRes = await doCreateSquad(env, departmentId, {
    slug: 'outreach',
    name: 'Outreach',
    charter:
      'Grant-diagnostic outreach to qualified, published B2B prospects. Every send is ' +
      'human-approved (CASL). We measure positive replies, not emails sent.',
    role: 'Outreach',
    okr: OKR,
    kpi_target: '5 positive replies / week',
    effort: 'standard',
    autonomy: 'execute_with_approval',
  })
  if (!squadRes.ok) return { ok: false, error: squadRes.error }
  const squad = squadRes.value

  const loopRes = await doCreateLoop(env, {
    squad_id: squad.id,
    agent_id: null,
    okr: OKR,
    kpi: { signal: 'positive_replies', target: 5 },
    sources: [{ kind: 'queue' }], // the prospect queue
    channels: [], // send goes through the gated GHL act pipeline, not a loop channel
    gate: { require_approval: true }, // every send is human-gated
    budget: { cap_micro_usd: 5_000_000, window: 'week', effort: 'standard' },
    cadence: { heartbeat: true, on_event: true },
    stop: { dry_rounds_max: 5 },
  })
  if (!loopRes.ok) return { ok: false, error: loopRes.error, squad }

  return { ok: true, squad, loop: loopRes.value }
}

/** First department in the pot (the loop + squad live under it). */
async function defaultResolveDepartmentId(env: Env): Promise<string | null> {
  const row = await env.DB.prepare('SELECT id FROM departments ORDER BY created_at ASC LIMIT 1').first<{ id: string }>()
  return row?.id ?? null
}
