// mupot — port for the dashboard's "move out of home" control.
//
// The dashboard must call the move_agent_squad tool so its gates and receipt run unchanged, but
// src/mcp/provision.ts cannot be imported from the dashboard: statically it cycles at load
// (PROVISION_TOOLS is read before provision finishes), and dynamically (`await import`) esbuild's
// Workers bundle wraps provision in an __esm closure and emits `await init_service8()` inside the
// synchronous init of src/addons/bindings.ts, so the worker fails to parse ("Unexpected reserved
// word"). vitest never bundles, so only the bundle-parse CI check saw it. This module is a
// dependency-free leaf (type-only imports): provision.ts registers the tool at load, the panel
// reads it at request time.
import type { ToolSpec } from '../mcp'

type MoveAgentSquadRun = ToolSpec['run']

let registered: MoveAgentSquadRun | null = null

export function registerMoveAgentSquad(run: MoveAgentSquadRun): void {
  registered = run
}

export function getMoveAgentSquad(): MoveAgentSquadRun | null {
  return registered
}
