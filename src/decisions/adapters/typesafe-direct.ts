// Direct TypeSafe System One adapter. Request shape copied from src/mcp/agent-lifecycle.ts
// (which is NOT changed by this PR). Uses optional env.TYPESAFE_API_KEY; absent =>
// ok:false 'adapter_unavailable' (never a guess).
import type { Env } from '../../types'
import type { DecisionAdapter, DecisionRequest, DecisionResult } from '../port'
import { parseSystemOneResponse } from './systemone-shape'

export const TYPESAFE_SYSTEMONE_URL = 'https://api.typesafe.ai/v1/systemone'
export const TYPESAFE_MODEL_ALIAS = 'jev-latest'

export function createTypesafeDirectAdapter(env: Env, fetchImpl: typeof fetch = fetch): DecisionAdapter {
  return {
    id: 'typesafe',
    dataPolicy: { maxDataClass: 'metadata', residency: 'typesafe-api', retention: 'per-provider-terms-unverified' },
    aliases: [TYPESAFE_MODEL_ALIAS],
    async decide(request: DecisionRequest, signal: AbortSignal): Promise<DecisionResult> {
      const key = typeof env.TYPESAFE_API_KEY === 'string' ? env.TYPESAFE_API_KEY.trim() : ''
      if (!key) return { ok: false, reason: 'adapter_unavailable' }
      const started = Date.now()
      try {
        const response = await fetchImpl(TYPESAFE_SYSTEMONE_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: TYPESAFE_MODEL_ALIAS, state: request.state, questions: request.questions }),
          signal,
        })
        if (!response.ok) return { ok: false, reason: 'adapter_error' }
        const body: unknown = await response.json()
        return parseSystemOneResponse(body, request, TYPESAFE_MODEL_ALIAS, Date.now() - started)
      } catch {
        return { ok: false, reason: 'adapter_error' }
      }
    },
  }
}
