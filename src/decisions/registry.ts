// src/decisions/registry.ts — pick the adapter from env.DECISION_ADAPTER.
// Default 'human'. An unknown value falls back to human-defer; it never throws.
import type { Env } from '../types'
import type { DecisionAdapter } from './port'
import { humanDeferAdapter } from './adapters/human-defer'
import { createTypesafeDirectAdapter } from './adapters/typesafe-direct'
import { createWorkersAiAdapter } from './adapters/workers-ai'

export function selectAdapter(env: Env): DecisionAdapter {
  const name = typeof env.DECISION_ADAPTER === 'string' ? env.DECISION_ADAPTER.trim().toLowerCase() : ''
  switch (name) {
    case 'workers-ai':
      return createWorkersAiAdapter(env)
    case 'typesafe':
      return createTypesafeDirectAdapter(env)
    default:
      return humanDeferAdapter
  }
}
