// src/dashboard/mission-control-routes.ts — Mission Control Sub-Router for Mupot (#Flight-003C).
//
// Modular sub-app mounting:
//   - GET /radar (Unified Mission Control: ATC Radar, Fleet Presence, Topology, Departures)
//   - 301 Redirects: /fleet, /motherboard, /dashboard/motherboard, /coordination
//
// NOTE: `shell` is injected by index.ts via makeMissionControlApp() to break the
// circular import index.ts → mission-control-routes.ts → shell → index.ts that
// caused workerd's "Top-level await in module is unsettled" boot failure.

import { Hono } from 'hono'
import type { HtmlEscapedString } from 'hono/utils/html'
import type { Env, AuthContext } from '../types'
import { resolveAccessibleSquadIds } from '../projects/readable-squads'
import { loadFleetRadar } from './radar'
import { listFleetAgentRuntimeView } from '../fleet/registry'
import { listPresence } from '../fleet/presence'
import { loadMotherboardData } from './motherboard'
import { listJourneys, buildDepartureBoard } from '../coordination/journeys'
import { listRunners } from '../runners/service'
import { loadBrainPhysics } from './brain'
import type { PhysicsSnapshot } from './brain'
import { loadTodaySpendScalar } from './economy'
import { hostAgentsPanel, squadControlPanel } from './fleet-host'
import { missionControlBody } from './mission-control'

type ShellFn = (
  env: Env,
  title: string,
  body: HtmlEscapedString | Promise<HtmlEscapedString>,
  header?: { physics?: PhysicsSnapshot | null; costToday?: { configured: boolean; todayUsdMicro: number } | null },
) => HtmlEscapedString | Promise<HtmlEscapedString>

/** Factory — call once from index.ts with the local `shell` reference to avoid
 *  the circular import index → mission-control-routes → shell → index. */
export function makeMissionControlApp(shell: ShellFn) {
  const app = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>()

  // ── GET /radar — Unified Mission Control surface ─────────────────────────────
  app.get('/radar', async (c) => {
    const auth = c.get('auth')

    const tabParam = c.req.query('tab')
    const activeTab: 'radar' | 'fleet' | 'motherboard' | 'departures' | 'tentacles' =
      tabParam === 'fleet' || tabParam === 'motherboard' || tabParam === 'departures' || tabParam === 'tentacles'
        ? tabParam
        : 'radar'

    const squadIds = await resolveAccessibleSquadIds(c.env, auth)
    if (squadIds !== null && squadIds.length === 0) {
      return c.text('Forbidden: no squad capabilities', 403)
    }
    const tenant = c.req.query('tenant') ?? 'mumega.com'

    const [radar, hostAgents, presence, motherboard, journeys, physics, spend, runners] = await Promise.all([
      loadFleetRadar(c.env, Date.now(), squadIds),
      listFleetAgentRuntimeView(c.env, Date.now(), squadIds),
      listPresence(c.env, Date.now(), squadIds),
      loadMotherboardData(c.env, tenant, auth),
      listJourneys(c.env, { scope: 'live' }).catch(() => []),
      loadBrainPhysics(c.env),
      loadTodaySpendScalar(c.env),
      listRunners(c.env, { squad_ids: squadIds, limit: 100 }),
    ])

    const accept = c.req.header('accept') ?? ''
    const wantsJson = c.req.query('format') === 'json' || (accept.includes('application/json') && !accept.includes('text/html'))
    if (wantsJson) {
      if (activeTab === 'motherboard') return c.json(motherboard)
      if (activeTab === 'tentacles') return c.json({ runners })
      return c.json(radar)
    }

    const hostPanelOpts = {
      configured: !!c.env.FLEET_PANEL_SK && !!c.env.FLEET_CONSUMER_AGENT,
      canControl: auth.role === 'owner',
      flash: c.req.query('hc') ?? null,
    }
    const hostPanelHtml = hostAgentsPanel(hostAgents, hostPanelOpts)
    const squadPanelHtml = squadControlPanel(hostAgents, hostPanelOpts)
    const departures = buildDepartureBoard(journeys, Date.now())

    const body = missionControlBody({
      radar,
      presence,
      hostPanelHtml,
      squadPanelHtml,
      motherboard,
      departures,
      runners,
      activeTab,
    })

    return c.html(
      shell(c.env, 'Mission Control', body, {
        physics,
        costToday: { configured: spend.configured, todayUsdMicro: spend.today_usd_micro },
      }),
    )
  })

  // ── 301 backward-compatible redirects from legacy fleet views ────────────────
  app.get('/fleet', (c) => c.redirect('/radar?tab=fleet', 301))
  app.get('/motherboard', (c) => c.redirect('/radar?tab=motherboard', 301))
  app.get('/dashboard/motherboard', (c) => c.redirect('/radar?tab=motherboard', 301))
  app.get('/coordination', (c) => c.redirect('/radar?tab=departures', 301))
  app.get('/tentacles', (c) => c.redirect('/radar?tab=tentacles', 301))

  return app
}
