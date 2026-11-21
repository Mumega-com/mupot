// Clef adapter: ONE call to ONE Workers AI model per decision.
//   env.AI.run(<model>, { model: <selector>, state, questions })
// Model = env.CLEF_MODEL when it is '@cf/cloudflare/clef-flash' or '@cf/cloudflare/clef';
// unset => clef-flash; any other value fails closed (adapter_unavailable).
// The `model` selector field in the input is REQUIRED by the binding (live-probed 2026-11-21).
// No gateway or credits are needed; DECISION_GATEWAY_ID is honoured as in workers-ai.ts.
// There is deliberately NO tier escalation or fallback here: decide() owns all validation
// (thresholds, sumTolerance, version rules). Escalation is deferred; if it returns it must
// reuse decide()'s validator end to end.
import type { Env } from '../../types'
import type { DecisionAdapter, DecisionRequest, DecisionResult } from '../port'
import { parseSystemOneResponse } from './systemone-shape'

export const CLEF_FLASH_MODEL = '@cf/cloudflare/clef-flash'
export const CLEF_MODEL = '@cf/cloudflare/clef'

interface AiRunner {
  run(model: string, input: unknown, options?: unknown): Promise<unknown>
}

const SELECTORS: Readonly<Record<string, string>> = {
  [CLEF_FLASH_MODEL]: 'clef-flash',
  [CLEF_MODEL]: 'clef',
}

export function createClefAdapter(env: Env): DecisionAdapter {
  return {
    id: 'clef',
    dataPolicy: { maxDataClass: 'metadata', residency: 'cloudflare-workers-ai', retention: 'per-provider-terms-unverified' },
    // The @cf ids and the bare selectors the provider echoes are aliases, never versions.
    // A body that only echoes the selector has no real version; decide() then rejects it
    // (malformed_output). We do not fabricate one.
    aliases: [CLEF_FLASH_MODEL, CLEF_MODEL, 'clef-flash', 'clef'],
    async decide(request: DecisionRequest, signal: AbortSignal): Promise<DecisionResult> {
      const configured = typeof env.CLEF_MODEL === 'string' ? env.CLEF_MODEL.trim() : ''
      const model = configured === '' ? CLEF_FLASH_MODEL : configured
      const selector = Object.hasOwn(SELECTORS, model) ? SELECTORS[model] : undefined
      if (selector === undefined) return { ok: false, reason: 'adapter_unavailable' }
      // env.AI is typed as the catalogue-typed `Ai`, which does not list the Clef ids;
      // narrow to a minimal structural runner for this one call.
      const ai = env.AI as unknown as AiRunner | undefined
      if (!ai || typeof ai.run !== 'function') return { ok: false, reason: 'adapter_unavailable' }
      const gatewayId = typeof env.DECISION_GATEWAY_ID === 'string' ? env.DECISION_GATEWAY_ID.trim() : ''
      const options = gatewayId ? { gateway: { id: gatewayId }, signal } : { signal }
      const started = Date.now()
      try {
        const body = await ai.run(model, { model: selector, state: request.state, questions: request.questions }, options)
        return parseSystemOneResponse(body, request, model, Date.now() - started)
      } catch {
        return { ok: false, reason: 'adapter_error' }
      }
    },
  }
}
