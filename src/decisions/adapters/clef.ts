// Clef adapter: Workers AI binding, two tiers.
//   1. env.AI.run('@cf/cloudflare/clef-flash', { model: 'clef-flash', state, questions })
//   2. if any answer's `confidence` < CLEF_ESCALATION_THRESHOLD (or clef-flash fails),
//      env.AI.run('@cf/cloudflare/clef', { model: 'clef', ... }) once.
// The `model` selector field in the input is REQUIRED by the binding (live-probed 2026-11-21).
// No gateway or credits are needed; DECISION_GATEWAY_ID is honoured as in workers-ai.ts.
// Output is data to rank/propose from; decide() still owns validation, thresholds and receipts.
import type { Env } from '../../types'
import { answersMatchSchema, DEFAULT_SUM_TOLERANCE } from '../decide'
import type { DecisionAdapter, DecisionProvenance, DecisionRequest, DecisionResult } from '../port'
import { minAnswerConfidence, parseSystemOneResponse } from './systemone-shape'

export const CLEF_FLASH_MODEL = '@cf/cloudflare/clef-flash'
export const CLEF_MODEL = '@cf/cloudflare/clef'
/** Escalate clef-flash -> clef when any answer's confidence is below this. */
export const CLEF_ESCALATION_THRESHOLD = 0.75

interface AiRunner {
  run(model: string, input: unknown, options?: unknown): Promise<unknown>
}

interface Tier {
  readonly id: string
  readonly selector: string
}
const FLASH: Tier = { id: CLEF_FLASH_MODEL, selector: 'clef-flash' }
const FULL: Tier = { id: CLEF_MODEL, selector: 'clef' }

export function createClefAdapter(env: Env): DecisionAdapter {
  return {
    id: 'clef',
    dataPolicy: { maxDataClass: 'metadata', residency: 'cloudflare-workers-ai', retention: 'per-provider-terms-unverified' },
    // Both the @cf ids and the bare selectors the provider echoes are aliases, never versions.
    // A body that only echoes the selector has no real version; the port then rejects it
    // (malformed_output). We do not fabricate one.
    aliases: [CLEF_FLASH_MODEL, CLEF_MODEL, FLASH.selector, FULL.selector],
    async decide(request: DecisionRequest, signal: AbortSignal): Promise<DecisionResult> {
      // env.AI is typed as the catalogue-typed `Ai`, which does not list the Clef ids;
      // narrow to a minimal structural runner for these calls.
      const ai = env.AI as unknown as AiRunner | undefined
      if (!ai || typeof ai.run !== 'function') return { ok: false, reason: 'adapter_unavailable' }
      const gatewayId = typeof env.DECISION_GATEWAY_ID === 'string' ? env.DECISION_GATEWAY_ID.trim() : ''
      const options = gatewayId ? { gateway: { id: gatewayId }, signal } : { signal }

      // One tier: null result = call threw. Never throws.
      const attempt = async (tier: Tier): Promise<{ result: DecisionResult; confidence: number }> => {
        const started = Date.now()
        try {
          const body = await ai.run(tier.id, { model: tier.selector, state: request.state, questions: request.questions }, options)
          return {
            result: parseSystemOneResponse(body, request, tier.id, Date.now() - started),
            confidence: minAnswerConfidence(body, request),
          }
        } catch {
          return { result: { ok: false, reason: 'adapter_error' }, confidence: 0 }
        }
      }

      const flash = await attempt(FLASH)
      // Escalate unless the flash answer is valid under the SAME schema the port applies
      // AND confident. An invalid answer must not mask a clef answer the port would accept.
      const flashValid = flash.result.ok && answersMatchSchema(request, flash.result.answers, DEFAULT_SUM_TOLERANCE)
      if (flash.result.ok && flashValid && flash.confidence >= CLEF_ESCALATION_THRESHOLD) {
        return withProvenance(flash.result, { tier: FLASH.id, path: 'direct', providerConfidence: flash.confidence })
      }
      if (signal.aborted) {
        if (flash.result.ok && flashValid) {
          return withProvenance(flash.result, { tier: FLASH.id, path: 'degraded', providerConfidence: flash.confidence })
        }
        return flash.result.ok ? { ok: false, reason: 'malformed_output' } : flash.result
      }

      const full = await attempt(FULL)
      if (full.result.ok) {
        return withProvenance(full.result, {
          tier: FULL.id,
          path: flash.result.ok && flashValid ? 'escalated' : 'fallback',
          providerConfidence: full.confidence,
        })
      }
      // clef failed: a valid (low-confidence) clef-flash answer beats nothing; decide()'s
      // thresholds still decline it. Otherwise report a failure.
      if (flash.result.ok && flashValid) {
        return withProvenance(flash.result, { tier: FLASH.id, path: 'degraded', providerConfidence: flash.confidence })
      }
      return flash.result.ok ? { ok: false, reason: 'malformed_output' } : full.result
    },
  }
}

function withProvenance(result: DecisionResult, provenance: DecisionProvenance): DecisionResult {
  return result.ok ? { ...result, provenance } : result
}
