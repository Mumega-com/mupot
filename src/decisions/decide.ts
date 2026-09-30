// src/decisions/decide.ts — the ONLY entry point to a decision model.
//
// Guarantees, in order, for every call:
//   (0) request shape + per-question thresholds are validated (fail closed: invalid_request)
//   (i) data-class gate: request.dataClass must be <= adapter.dataPolicy.maxDataClass
//  (ii) hard timeout, enforced by racing the adapter (an adapter that ignores the signal
//       still cannot hold the caller past timeoutMs)
// (iii) adapter output is schema-validated against THIS request (malformed_output)
//  (iv) per-question confidence thresholds; below => 'declined_low_confidence'
//   (v) untrusted state text is fenced (defence in depth, see fence.ts)
//  (vi) exactly ONE decision_receipts row is written per call, success or failure,
//       BEFORE returning. If that write fails the caller gets ok-less 'failed' with
//       'receipt_write_failed', never a proposal.
//
// The result is a PROPOSAL: data for a human or an existing gate to read. Nothing here
// grants anything.
import type { Env } from '../types'
import { canonicalJson, sha256Hex } from '../lib/canonical-json'
import type {
  ConfidenceThreshold,
  DecideResult,
  DecisionAdapter,
  DecisionAnswer,
  DecisionFailureReason,
  DecisionOutcome,
  DecisionRequest,
  DecisionResult,
} from './port'
import { DATA_CLASS_ORDER } from './port'
import { DEFAULT_MAX_STATE_CHARS, fenceUntrustedText } from './fence'
import { selectAdapter } from './registry'

export const DEFAULT_TIMEOUT_MS = 2000
export const DEFAULT_SUM_TOLERANCE = 0.02

export interface DecideConfig {
  /** Required for every noul and choice question; a missing entry is invalid_request, not a default. */
  readonly thresholds: Readonly<Record<string, ConfidenceThreshold>>
  readonly tenant?: string
  readonly timeoutMs?: number
  readonly maxStateChars?: number
  readonly sumTolerance?: number
  /** Override registry selection (tests, or a caller pinning an adapter). */
  readonly adapter?: DecisionAdapter
}

class Timeout extends Error {}

function dataClassRank(value: string): number {
  return DATA_CLASS_ORDER.findIndex((candidate) => candidate === value) // unknown => -1, handled by callers
}

function validateRequest(request: DecisionRequest, config: DecideConfig): boolean {
  if (!request.useCase.trim() || !request.criteriaVersion.trim()) return false
  if (dataClassRank(request.dataClass) < 0) return false
  const entries = Object.entries(request.questions)
  if (entries.length === 0) return false
  for (const [name, question] of entries) {
    if (!name) return false
    if (question.type === 'choice') {
      if (Object.keys(question.criteria).length < 2) return false
    }
    if (question.type === 'score') {
      if (question.min !== undefined && !Number.isFinite(question.min)) return false
      if (question.max !== undefined && !Number.isFinite(question.max)) return false
    }
    if (question.type !== 'score') {
      const t = config.thresholds[name]
      if (!t || !Number.isFinite(t.minTopProbability) || !Number.isFinite(t.minMargin)) return false
    }
  }
  return true
}

function validProbability(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1
}

/** True iff every answer matches its question's schema. */
export function answersMatchSchema(
  request: DecisionRequest,
  answers: Readonly<Record<string, DecisionAnswer>>,
  sumTolerance: number,
): boolean {
  const questionNames = Object.keys(request.questions)
  const answerNames = Object.keys(answers)
  if (answerNames.length !== questionNames.length) return false
  for (const name of questionNames) {
    const question = request.questions[name]
    const answer = Object.hasOwn(answers, name) ? answers[name] : undefined
    if (!question || !answer || answer.type !== question.type) return false
    if (question.type === 'noul' && answer.type === 'noul') {
      if (!validProbability(answer.probability)) return false
    } else if (question.type === 'score' && answer.type === 'score') {
      if (!Number.isFinite(answer.score)) return false
      if (question.min !== undefined && answer.score < question.min) return false
      if (question.max !== undefined && answer.score > question.max) return false
    } else if (question.type === 'choice' && answer.type === 'choice') {
      const allowed = new Set(Object.keys(question.criteria))
      const keys = Object.keys(answer.probabilities)
      if (keys.length === 0) return false
      let sum = 0
      for (const key of keys) {
        if (!allowed.has(key)) return false
        const p = answer.probabilities[key]
        if (p === undefined || !validProbability(p)) return false
        sum += p
      }
      if (Math.abs(sum - 1) > sumTolerance) return false
      if (answer.choice !== undefined && !allowed.has(answer.choice)) return false
    } else {
      return false
    }
  }
  return true
}

/** Name of the first question below its threshold, or null. Score questions have no threshold. */
function firstBelowThreshold(
  request: DecisionRequest,
  answers: Readonly<Record<string, DecisionAnswer>>,
  thresholds: Readonly<Record<string, ConfidenceThreshold>>,
): string | null {
  for (const name of Object.keys(request.questions)) {
    const answer = answers[name]
    const threshold = thresholds[name]
    if (!answer || !threshold) continue
    let top: number
    let margin: number
    if (answer.type === 'noul') {
      top = Math.max(answer.probability, 1 - answer.probability)
      margin = top - (1 - top)
    } else if (answer.type === 'choice') {
      const sorted = Object.values(answer.probabilities).sort((a, b) => b - a)
      top = sorted[0] ?? 0
      margin = top - (sorted[1] ?? 0)
    } else {
      continue
    }
    if (top < threshold.minTopProbability || margin < threshold.minMargin) return name
  }
  return null
}

async function runWithTimeout(
  adapter: DecisionAdapter,
  request: DecisionRequest,
  timeoutMs: number,
): Promise<DecisionResult> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Timeout('decision_timeout'))
    }, timeoutMs)
  })
  try {
    return await Promise.race([adapter.decide(request, controller.signal), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

interface ReceiptFields {
  readonly tenant: string | null
  readonly useCase: string
  readonly dataClass: string
  readonly adapterId: string
  readonly model: string | null
  readonly modelVersion: string | null
  readonly criteriaHash: string
  readonly inputHash: string
  readonly answersJson: string | null
  readonly thresholdJson: string
  readonly outcome: DecisionOutcome
  readonly reason: string | null
  readonly latencyMs: number
  readonly inputTokens: number | null
}

async function writeReceipt(env: Env, fields: ReceiptFields): Promise<string | null> {
  const id = crypto.randomUUID()
  try {
    await env.DB.prepare(
      `INSERT INTO decision_receipts
         (id, tenant, use_case, data_class, adapter_id, model, model_version, criteria_hash, input_hash,
          answers_json, threshold_json, outcome, reason, latency_ms, input_tokens)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
    )
      .bind(
        id, fields.tenant, fields.useCase, fields.dataClass, fields.adapterId, fields.model, fields.modelVersion,
        fields.criteriaHash, fields.inputHash, fields.answersJson, fields.thresholdJson, fields.outcome,
        fields.reason, fields.latencyMs, fields.inputTokens,
      )
      .run()
    return id
  } catch {
    return null
  }
}

async function safeHash(value: unknown): Promise<string> {
  try {
    return await sha256Hex(canonicalJson(value))
  } catch {
    return 'unhashable'
  }
}

export async function decide(env: Env, request: DecisionRequest, config: DecideConfig): Promise<DecideResult> {
  const adapter = config.adapter ?? selectAdapter(env)
  const started = Date.now()
  const fencedState = fenceUntrustedText(String(request.state), config.maxStateChars ?? DEFAULT_MAX_STATE_CHARS)
  // Only hashes of what was sent are stored, never the text itself.
  const inputHash = await safeHash({ useCase: request.useCase, dataClass: request.dataClass, state: fencedState })
  const criteriaHash = await safeHash({ criteriaVersion: request.criteriaVersion, questions: request.questions })
  const thresholdJson = await (async () => {
    try { return canonicalJson(config.thresholds) } catch { return '{}' }
  })()

  const base = {
    tenant: config.tenant ?? null,
    useCase: request.useCase,
    dataClass: request.dataClass,
    adapterId: adapter.id,
    criteriaHash,
    inputHash,
    thresholdJson,
  }

  const finish = async (
    outcome: DecisionOutcome,
    reason: string | null,
    extra: Partial<Pick<ReceiptFields, 'model' | 'modelVersion' | 'answersJson' | 'inputTokens'>>,
  ): Promise<string | null> =>
    writeReceipt(env, {
      ...base,
      model: extra.model ?? null,
      modelVersion: extra.modelVersion ?? null,
      answersJson: extra.answersJson ?? null,
      inputTokens: extra.inputTokens ?? null,
      outcome,
      reason,
      latencyMs: Date.now() - started,
    })

  const fail = async (reason: DecisionFailureReason): Promise<DecideResult> => {
    const outcome: DecisionOutcome = reason === 'deferred_to_human' ? 'deferred_to_human' : 'failed'
    const receiptId = await finish(outcome, reason, {})
    if (receiptId === null) return { outcome: 'failed', reason: 'receipt_write_failed', receiptId: '' }
    return { outcome: reason === 'deferred_to_human' ? 'deferred_to_human' : 'failed', reason, receiptId }
  }

  let validShape = false
  try {
    validShape = validateRequest(request, config)
  } catch {
    validShape = false
  }
  if (!validShape) return fail('invalid_request')

  if (dataClassRank(request.dataClass) > dataClassRank(adapter.dataPolicy.maxDataClass)) {
    return fail('data_class_not_allowed')
  }

  const fencedRequest: DecisionRequest = { ...request, state: fencedState }
  let result: DecisionResult
  try {
    result = await runWithTimeout(adapter, fencedRequest, config.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  } catch (error) {
    return fail(error instanceof Timeout ? 'timeout' : 'adapter_error')
  }
  if (!result.ok) return fail(result.reason)

  const modelVersion = typeof result.modelVersion === 'string' ? result.modelVersion.trim() : ''
  const aliasReturned = modelVersion !== '' && (adapter.aliases ?? []).includes(modelVersion)
  if (
    !modelVersion || aliasReturned || typeof result.model !== 'string' || !result.model ||
    !answersMatchSchema(request, result.answers, config.sumTolerance ?? DEFAULT_SUM_TOLERANCE)
  ) {
    return fail('malformed_output')
  }

  const below = firstBelowThreshold(request, result.answers, config.thresholds)
  const outcome: DecisionOutcome = below === null ? 'proposed' : 'declined_low_confidence'
  const reason = below === null ? null : `low_confidence:${below}`
  const receiptId = await finish(outcome, reason, {
    model: result.model,
    modelVersion,
    answersJson: canonicalJson(result.answers),
    inputTokens: typeof result.inputTokens === 'number' && Number.isFinite(result.inputTokens) ? result.inputTokens : null,
  })
  if (receiptId === null) return { outcome: 'failed', reason: 'receipt_write_failed', receiptId: '' }
  return {
    outcome: outcome === 'proposed' ? 'proposed' : 'declined_low_confidence',
    answers: result.answers,
    model: result.model,
    modelVersion,
    latencyMs: Date.now() - started,
    receiptId,
    ...(reason === null ? {} : { reason }),
  }
}
