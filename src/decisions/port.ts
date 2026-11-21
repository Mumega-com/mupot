// src/decisions/port.ts — types only. The decision-model port.
//
// THE RULE THAT SHAPES THIS DIRECTORY: a decision model may RANK or PROPOSE, never
// AUTHORIZE. Its output is data (probabilities, a score), never a permission. Nothing in
// this file — request, answer, result — carries an "authorize"/"allow"/"approved" field,
// and a test (tests/decisions-port.test.ts) pins that. Whatever acts on a proposal must
// obtain authority from a human or from the repo's existing gates, not from this port.
//
// Callers talk to `decide()` in ./decide.ts, never to an adapter directly.

export type DataClass = 'none' | 'metadata' | 'personal' | 'financial' | 'regulated'

/** Ascending sensitivity. A request may go to an adapter only if its class <= the adapter's max. */
export const DATA_CLASS_ORDER: readonly DataClass[] = ['none', 'metadata', 'personal', 'financial', 'regulated']

export interface NoulQuestion {
  readonly type: 'noul'
  readonly instructions: string
}

export interface ChoiceQuestion {
  readonly type: 'choice'
  readonly instructions: string
  /** option name -> what it means. The KEYS are the allowed options (>= 2). */
  readonly criteria: Readonly<Record<string, string>>
}

export interface ScoreQuestion {
  readonly type: 'score'
  readonly instructions: string
  readonly min?: number
  readonly max?: number
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion

export interface DecisionRequest {
  readonly useCase: string
  /** Bump when questions/criteria change; part of criteria_hash on every receipt. */
  readonly criteriaVersion: string
  /** Untrusted free text is fenced by decide() before it reaches an adapter. */
  readonly state: string
  readonly questions: Readonly<Record<string, DecisionQuestion>>
  readonly dataClass: DataClass
}

export type DecisionAnswer =
  | { readonly type: 'noul'; readonly probability: number }
  | { readonly type: 'choice'; readonly probabilities: Readonly<Record<string, number>>; readonly choice?: string }
  | { readonly type: 'score'; readonly score: number }

export type DecisionFailureReason =
  | 'deferred_to_human'
  | 'data_class_not_allowed'
  | 'invalid_request'
  | 'timeout'
  | 'adapter_error'
  | 'adapter_unavailable'
  | 'gateway_auth_required'
  | 'malformed_output'
  | 'receipt_write_failed'

export type DecisionResult =
  | {
      readonly ok: true
      readonly answers: Readonly<Record<string, DecisionAnswer>>
      readonly model: string
      /** The exact model id the provider RETURNED, never the alias we asked for. */
      readonly modelVersion: string
      readonly latencyMs: number
      readonly inputTokens?: number
    }
  | { readonly ok: false; readonly reason: DecisionFailureReason }

export interface AdapterDataPolicy {
  readonly maxDataClass: DataClass
  readonly residency: string
  readonly retention: string
}

export interface DecisionAdapter {
  readonly id: string
  readonly dataPolicy: AdapterDataPolicy
  /** Model ids that are aliases, not versions; a result whose modelVersion is one of these is malformed. */
  readonly aliases?: readonly string[]
  /** Must not throw for expected failures; decide() still treats a throw as adapter_error. */
  decide(request: DecisionRequest, signal: AbortSignal): Promise<DecisionResult>
}

export interface ConfidenceThreshold {
  /** Top probability must be >= this. */
  readonly minTopProbability: number
  /** Top minus runner-up (noul: top minus the complement) must be >= this. */
  readonly minMargin: number
}

export type DecisionOutcome = 'proposed' | 'declined_low_confidence' | 'failed' | 'deferred_to_human'

/** What decide() returns. `answers` is present for proposed and declined outcomes: data for a human to read. */
export type DecideResult =
  | {
      readonly outcome: 'proposed' | 'declined_low_confidence'
      readonly answers: Readonly<Record<string, DecisionAnswer>>
      readonly model: string
      readonly modelVersion: string
      readonly latencyMs: number
      readonly receiptId: string
      readonly reason?: string
    }
  | {
      readonly outcome: 'failed' | 'deferred_to_human'
      readonly reason: DecisionFailureReason
      readonly receiptId: string
    }
