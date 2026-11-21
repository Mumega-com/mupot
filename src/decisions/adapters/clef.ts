// Clef adapter: ONE call to ONE Workers AI model per decision.
//   env.AI.run(<model>, { model: <selector>, state, questions })
// Model = env.CLEF_MODEL when it is '@cf/cloudflare/clef-flash' or '@cf/cloudflare/clef';
// unset => clef-flash; any other value fails closed (adapter_unavailable).
// The `model` selector field in the input is REQUIRED by the binding (live-probed 2026-11-21).
// No gateway or credits are needed; DECISION_GATEWAY_ID is honoured as in workers-ai.ts.
// Version: the live provider only echoes the selector ('clef-flash' / 'clef'), which is an alias,
// so by itself every reply is rejected by decide() as malformed_output. An operator can pin a
// version with env.CLEF_MODEL_VERSION, a strict YYYY-MM-DD real calendar date = the day the operator
// verified the model's behaviour. When the provider body carries no real version (empty or an alias)
// and the pin is valid, modelVersion becomes `${model}@pin:${pin}` (never an alias; the `pin:`
// marker distinguishes it from a version the provider reported). The pin applies only when the
// provider version is empty/missing or is this request's own selector or @cf id (an echo of the
// OTHER tier's alias is left for decide() to reject). A provider-supplied real version always wins.
// The pin must also be plausible: not after today (UTC, at call time) and not before 2026-01-01.
// Unset or invalid pin => behaviour unchanged (no version, decide() rejects); no version is ever
// fabricated except the operator pin, marked @pin:. decide()'s validator is untouched.
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

const PIN_EARLIEST = '2026-01-01'

// Strict YYYY-MM-DD real calendar date within [2026-01-01, today UTC]. No trimming: padding or
// suffixes are invalid. `now` is read at call time.
export function isValidPinDate(value: unknown, now: Date = new Date()): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  if (!(date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d)) return false
  // Zero-padded ISO dates order lexicographically.
  return value >= PIN_EARLIEST && value <= now.toISOString().slice(0, 10)
}

export const CLEF_ALIASES: readonly string[] = Object.freeze([CLEF_FLASH_MODEL, CLEF_MODEL, 'clef-flash', 'clef'])

export function createClefAdapter(env: Env): DecisionAdapter {
  return {
    id: 'clef',
    dataPolicy: { maxDataClass: 'metadata', residency: 'cloudflare-workers-ai', retention: 'per-provider-terms-unverified' },
    // The @cf ids and the bare selectors the provider echoes are aliases, never versions.
    // A body that only echoes the selector has no real version; decide() then rejects it
    // (malformed_output). We do not fabricate one, except the operator pin, marked @pin:.
    aliases: CLEF_ALIASES,
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
        const parsed = parseSystemOneResponse(body, request, model, Date.now() - started)
        if (!parsed.ok) return parsed
        const provided = typeof parsed.modelVersion === 'string' ? parsed.modelVersion.trim() : ''
        // Pin only on an empty echo or this request's own selector / @cf id. A real version wins;
        // the other tier's alias is left for decide() to reject.
        const pinnable = provided === '' || provided === selector || provided === model
        if (!pinnable || !isValidPinDate(env.CLEF_MODEL_VERSION)) return parsed
        return { ...parsed, modelVersion: `${model}@pin:${env.CLEF_MODEL_VERSION}` }
      } catch {
        return { ok: false, reason: 'adapter_error' }
      }
    },
  }
}
