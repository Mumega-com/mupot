// src/dashboard/mission-control-routes.ts — Mission Control Sub-Router for Mupot (#Flight-003C).
//
// Modular sub-app mounting:
//   - GET /radar (Unified Mission Control: ATC Radar, Fleet Presence, Topology, Departures)
//   - 301 Redirects: /fleet, /motherboard, /dashboard/motherboard, /coordination

import { Hono } from 'hono'
import type { Env, AuthContext } from '../types'
import { isOrgAdmin } from '../auth/capability'
import { resolveAccessibleSquadIds } from '../projects/readable-squads'
import { loadFleetRadar } from './radar'
import { listFleetAgentRuntimeView } from '../fleet/registry'
import { listPresence } from '../fleet/presence'
import { loadMotherboardData } from './motherboard'
import { listJourneys, buildDepartureBoard } from '../coordination/journeys'
import { loadBrainPhysics } from './brain'
import { loadTodaySpendScalar } from './economy'
import { hostAgentsPanel, squadControlPanel } from './fleet-host'
import { shell, errorBody } from './index'
import { missionControlBody } from './mission-control'

export const missionControlApp = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>()

// ── GET /radar — Unified Mission Control surface ─────────────────────────────
missionControlApp.get('/radar', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) {
    return c.html(shell(c.env, 'Mission Control', errorBody('Mission Control requires owner or admin.')), 403)
  }

  const tabParam = c.req.query('tab')
  const activeTab: 'radar' | 'fleet' | 'motherboard' | 'departures' =
    tabParam === 'fleet' || tabParam === 'motherboard' || tabParam === 'departures'
      ? tabParam
      : 'radar'

  const squadIds = await resolveAccessibleSquadIds(c.env, auth)
  const tenant = c.req.query('tenant') ?? 'mumega.com'

  const [radar, hostAgents, presence, motherboard, journeys, physics, spend] = await Promise.all([
    loadFleetRadar(c.env),
    listFleetAgentRuntimeView(c.env, Date.now(), squadIds),
    listPresence(c.env, Date.now(), squadIds),
    loadMotherboardData(c.env, tenant, auth),
    listJourneys(c.env, { scope: 'live' }).catch(() => []),
    loadBrainPhysics(c.env),
    loadTodaySpendScalar(c.env),
  ])

  const accept = c.req.header('accept') ?? ''
  const wantsJson = c.req.query('format') === 'json' || (accept.includes('application/json') && !accept.includes('text/html'))
  if (wantsJson) {
    if (activeTab === 'motherboard') return c.json(motherboard)
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
    activeTab,
  })

  return c.html(
    shell(c.env, 'Mission Control', body, {
      physics,
      costToday: { configured: spend.configured, todayUsdMicro: spend.today_usd_micro },
    }),
  )
})

// ── 301 / 302 backward-compatible redirects from legacy fleet views ─────────
missionControlApp.get('/fleet', (c) => c.redirect('/radar?tab=fleet', 301))
missionControlApp.get('/motherboard', (c) => c.redirect('/radar?tab=motherboard', 301))
missionControlApp.get('/dashboard/motherboard', (c) => c.redirect('/radar?tab=motherboard', 301))
missionControlApp.get('/coordination', (c) => c.redirect('/radar?tab=departures', 301))
