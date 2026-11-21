// Shared parser for the TypeSafe System One response shape, used by both the Workers AI
// and the direct adapters. The `choice` shape is copied from src/mcp/agent-lifecycle.ts
// (live-verified there). The `noul` ({probability}) and `score` ({score}) shapes are
// ASSUMED from the port's own types and NOT verified against a live provider response.
//
// This parser never validates ranges: non-numeric values become NaN so decide()'s schema
// validation (the single authority) rejects them as malformed_output.
import type { DecisionAnswer, DecisionRequest, DecisionResult } from '../port'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number.NaN
}

export function parseSystemOneResponse(
  body: unknown,
  request: DecisionRequest,
  modelFallback: string,
  latencyMs: number,
): DecisionResult {
  if (!isRecord(body) || !isRecord(body.answers)) return { ok: false, reason: 'malformed_output' }
  const answers: Record<string, DecisionAnswer> = {}
  for (const [name, question] of Object.entries(request.questions)) {
    const raw = body.answers[name]
    if (!isRecord(raw)) return { ok: false, reason: 'malformed_output' }
    if (question.type === 'noul') {
      answers[name] = { type: 'noul', probability: num(raw.probability) }
    } else if (question.type === 'score') {
      answers[name] = { type: 'score', score: num(raw.score) }
    } else {
      if (!isRecord(raw.probabilities)) return { ok: false, reason: 'malformed_output' }
      const probabilities: Record<string, number> = {}
      for (const [option, value] of Object.entries(raw.probabilities)) probabilities[option] = num(value)
      answers[name] = typeof raw.choice === 'string'
        ? { type: 'choice', probabilities, choice: raw.choice }
        : { type: 'choice', probabilities }
    }
  }
  // The exact id the provider returned. Absent => empty string => rejected by decide().
  const modelVersion = typeof body.model === 'string' ? body.model : ''
  const usage = isRecord(body.usage) ? body.usage : undefined
  const inputTokens = usage && typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined
  return {
    ok: true,
    answers,
    model: modelFallback,
    modelVersion,
    latencyMs,
    ...(inputTokens === undefined ? {} : { inputTokens }),
  }
}
