// mupot — Surface port (Module Kernel Port 5 / build-order item 4).
//
// Dashboards mount as panels. A surface is read-through the kernel's auth; it
// never becomes a second control plane. Hermes web UI is the first panel.
//
// Design: docs/architecture/mupot-module-kernel.md §3 (Surface port).

export const SURFACE_PORT_VERSION = 1 as const

export type SurfaceAdapterKind = 'hermes' | 'custom'

export interface SurfacePanel {
  readonly id: string
  readonly adapter: SurfaceAdapterKind
  readonly title: string
  /** Dashboard path where the panel is mounted (cookie-auth shell). */
  readonly path: string
  /** Optional external dashboard URL (iframe). Env may override. */
  readonly externalUrlEnvKey?: string
}

const _panels = new Map<string, SurfacePanel>()

export function registerSurfacePanel(panel: SurfacePanel): void {
  if (_panels.has(panel.id)) {
    throw new Error(`[surface_panel_duplicate] Surface panel '${panel.id}' is already registered.`)
  }
  _panels.set(panel.id, panel)
}

export function getSurfacePanel(id: string): SurfacePanel | undefined {
  return _panels.get(id)
}

export function listSurfacePanels(): SurfacePanel[] {
  return [..._panels.values()]
}
