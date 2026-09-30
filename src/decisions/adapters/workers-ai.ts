// Workers AI adapter: env.AI.run('typesafe/jev', { state, questions }).
//
// Optional AI Gateway: env.DECISION_GATEWAY_ID => run(..., { gateway: { id } }).
//
// LIVE PROBE NOTE (2026-09): the Cloudflare REST path for this third-party model answered
// 403 code 2049 "Gateway authentication is required to use unified billing. Enable
// authentication on your gateway or provide your own API key (BYOK)". That is surfaced
// here as ok:false 'gateway_auth_required' instead of a throw. Whether the binding path
// (this file) behaves the same as REST was NOT verified live from this build.
import type { Env } from '../../types'
import type { DecisionAdapter, DecisionRequest, DecisionResult } from '../port'
import { parseSystemOneResponse } from './systemone-shape'

export const WORKERS_AI_MODEL = 'typesafe/jev'

interface AiRunner {
  run(model: string, input: unknown, options?: unknown): Promise<unknown>
}

const GATEWAY_AUTH = /gateway authentication is required|unified billing|\b2049\b/i

function isGatewayAuthError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    const code: unknown = Reflect.get(error, 'code')
    if (code === 2049 || code === '2049') return true
    const message: unknown = Reflect.get(error, 'message')
    if (typeof message === 'string') return GATEWAY_AUTH.test(message)
  }
  return typeof error === 'string' && GATEWAY_AUTH.test(error)
}

export function createWorkersAiAdapter(env: Env): DecisionAdapter {
  return {
    id: 'workers-ai',
    dataPolicy: { maxDataClass: 'metadata', residency: 'cloudflare-workers-ai', retention: 'per-provider-terms-unverified' },
    aliases: [WORKERS_AI_MODEL],
    async decide(request: DecisionRequest, signal: AbortSignal): Promise<DecisionResult> {
      // env.AI is typed as the catalogue-typed `Ai`, which does not list third-party
      // 'typesafe/jev'; narrow to a minimal structural runner for this one call.
      const ai = env.AI as unknown as AiRunner | undefined
      if (!ai || typeof ai.run !== 'function') return { ok: false, reason: 'adapter_unavailable' }
      const gatewayId = typeof env.DECISION_GATEWAY_ID === 'string' ? env.DECISION_GATEWAY_ID.trim() : ''
      const options = gatewayId ? { gateway: { id: gatewayId }, signal } : { signal }
      const started = Date.now()
      try {
        const body = await ai.run(WORKERS_AI_MODEL, { state: request.state, questions: request.questions }, options)
        return parseSystemOneResponse(body, request, WORKERS_AI_MODEL, Date.now() - started)
      } catch (error) {
        if (isGatewayAuthError(error)) return { ok: false, reason: 'gateway_auth_required' }
        return { ok: false, reason: 'adapter_error' }
      }
    },
  }
}
