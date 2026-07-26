// mupot — Hermes surface panel registration (Port 5).
//
// Mounts the Hermes dashboard as a mupot panel at GET /surfaces/hermes.
// When HERMES_DASHBOARD_URL is set, the panel embeds it (read-through kernel
// cookie auth on the shell — Hermes never becomes a second control plane).
// Without the URL the panel still mounts and explains how to wire it.

import { registerSurfacePanel } from './port'

registerSurfacePanel({
  id: 'hermes',
  adapter: 'hermes',
  title: 'Hermes',
  path: '/surfaces/hermes',
  externalUrlEnvKey: 'HERMES_DASHBOARD_URL',
})
