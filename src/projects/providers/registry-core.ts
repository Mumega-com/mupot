// mupot — board provider self-registration (the open replacement for the closed switch that lived in registry.ts).
//
// Each provider file calls registerBoardProvider() once at module load, the same shape as addons/registry.ts.
// This file imports NO provider, so a provider can import it without a cycle. registry.ts is what imports the
// providers (for their registration side effect) and re-exports this API; callers import registry.ts.

import type { Env } from '../../types'
import type { ProjectBoardProvider, TaskBoardPort } from './port'

type PortFactory = (env: Env) => TaskBoardPort

const factories = new Map<ProjectBoardProvider, PortFactory>()

// Provider names appear in D1 rows and URL paths; keep them to a small safe charset.
const PROVIDER_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/

export function registerBoardProvider(provider: ProjectBoardProvider, factory: PortFactory): void {
  if (!PROVIDER_NAME_RE.test(provider)) throw new Error(`invalid board provider name: ${provider}`)
  const existing = factories.get(provider)
  // Re-registering the SAME factory (module re-evaluation in tests) is a no-op; a different one is a collision.
  if (existing && existing !== factory) throw new Error(`board provider already registered: ${provider}`)
  factories.set(provider, factory)
}

export function isProjectBoardProvider(value: unknown): value is ProjectBoardProvider {
  return typeof value === 'string' && factories.has(value)
}

export function listBoardProviders(): ProjectBoardProvider[] {
  return [...factories.keys()].sort()
}

export function getTaskBoardPort(env: Env, provider: ProjectBoardProvider): TaskBoardPort {
  const factory = factories.get(provider)
  if (!factory) throw new Error(`unknown project board provider: ${provider}`)
  return factory(env)
}
