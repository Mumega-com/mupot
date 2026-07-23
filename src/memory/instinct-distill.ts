// Port 4 — cheap-model distill (ECC continuous-learning-v2 observer / Haiku path).
//
// Observations → cheap chat model → InstinctCandidate[]. Persistence is separate
// (instinct-service). Injectable chat keeps unit tests offline.

import type { Env, ModelMessage } from '../types'
import { createModel } from '../model'
import {
  INSTINCT_DISTILL_MIN_OBSERVATIONS,
  parseInstinctDistillOutput,
  type InstinctCandidate,
} from './instinct'
import type { StoredObservation } from './instinct-service'

export type InstinctChat = (
  messages: ModelMessage[],
  opts: { model: string; maxTokens: number },
) => Promise<string>

/** Prefer Anthropic Haiku when gateway is wired; Workers AI otherwise. */
export const INSTINCT_DISTILL_MODEL_GATEWAY = 'claude-haiku-4-5'
export const INSTINCT_DISTILL_MODEL_WORKERS = '@cf/meta/llama-3.1-8b-instruct'

const DISTILL_SYSTEM = [
  'You distill session observations into atomic instincts for an AI coding agent.',
  'Return ONLY a JSON array. Each item:',
  '{"id":"kebab-case","trigger":"...","action":"...","confidence":0.3-0.9,"domain":"...","evidence":["..."]}',
  'Rules: one trigger → one action; project-specific patterns only; no raw code dumps;',
  'confidence 0.3 tentative … 0.9 near-certain; empty array if nothing solid.',
].join(' ')

export function buildDistillUserPrompt(
  projectId: string,
  observations: readonly StoredObservation[],
): string {
  const lines = [
    `Project: ${projectId}`,
    `Observations (${observations.length}):`,
    '',
  ]
  for (const obs of observations) {
    lines.push(
      `- [${obs.createdAt}] ${obs.event} ${JSON.stringify(obs.payload)}`,
    )
  }
  lines.push('', 'Distill into instincts JSON array:')
  return lines.join('\n')
}

export interface DistillInstinctsInput {
  projectId: string
  observations: readonly StoredObservation[]
  minObservations: number
  chat: InstinctChat
  model: string
}

export interface DistillInstinctsResult {
  candidates: InstinctCandidate[]
  skipped: boolean
  reason: string | null
}

export async function distillInstinctsFromObservations(
  input: DistillInstinctsInput,
): Promise<DistillInstinctsResult> {
  if (input.observations.length < input.minObservations) {
    return {
      candidates: [],
      skipped: true,
      reason: `need_more_observations:${input.observations.length}/${input.minObservations}`,
    }
  }

  const messages: ModelMessage[] = [
    { role: 'system', content: DISTILL_SYSTEM },
    { role: 'user', content: buildDistillUserPrompt(input.projectId, input.observations) },
  ]
  const raw = await input.chat(messages, { model: input.model, maxTokens: 1024 })
  return {
    candidates: parseInstinctDistillOutput(raw),
    skipped: false,
    reason: null,
  }
}

export function defaultInstinctChat(env: Env): InstinctChat {
  const model = createModel(env)
  return async (messages, opts) => model.chat(messages, opts)
}

export function defaultDistillModel(preferGatewayHaiku: boolean): string {
  return preferGatewayHaiku ? INSTINCT_DISTILL_MODEL_GATEWAY : INSTINCT_DISTILL_MODEL_WORKERS
}

export function defaultMinObservations(): number {
  return INSTINCT_DISTILL_MIN_OBSERVATIONS
}
