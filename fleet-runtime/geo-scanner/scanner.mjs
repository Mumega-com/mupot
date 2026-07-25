import { randomUUID } from 'node:crypto'

import {
  GEO_EVENT_SCHEMA,
  GEO_RECEIPT_SCHEMA,
} from './contract.mjs'
import { claimGroundedQuery } from './budget.mjs'
import { readWorkloadIdentityToken, runGroundedQuery } from './vertex.mjs'
import { captureGeoEvent, sendMupotReceipt } from './sinks.mjs'

const INPUT_USD_PER_MILLION_TOKENS = 0.30
const OUTPUT_USD_PER_MILLION_TOKENS = 2.50
const MODEL_RATE_CARD = 'vertex-gemini-2.5-flash-2026-07-25'

function isoNow(now) {
  const value = now()
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error('invalid_scanner_time')
  return date.toISOString()
}

function emptyEvidence() {
  return {
    answerText: '',
    webSearchQueries: [],
    citations: [],
    usage: { promptTokens: 0, candidateTokens: 0, totalTokens: 0 },
  }
}

function canonicalDomain(value) {
  return String(value ?? '').toLowerCase().replace(/^www\./, '').replace(/\.$/, '')
}

function estimatedModelCostMicroUsd(usage) {
  return Math.round(
    usage.promptTokens * INPUT_USD_PER_MILLION_TOKENS
    + usage.candidateTokens * OUTPUT_USD_PER_MILLION_TOKENS,
  )
}

function trackedNames(answerText, competitors) {
  const answer = answerText.toLocaleLowerCase('en-US')
  return competitors.filter((name) => answer.includes(name.toLocaleLowerCase('en-US')))
}

function eventFor({
  eventUuid,
  scanId,
  config,
  profile,
  prompt,
  observedAt,
  outcome,
}) {
  const usage = outcome.usage ?? emptyEvidence().usage
  const citedDomains = [...new Set(
    (outcome.citations ?? []).map((citation) => canonicalDomain(citation.domain)).filter(Boolean),
  )]
  const hasGroundedAnswer = outcome.status === 'ok'
  return {
    schema: GEO_EVENT_SCHEMA,
    event_uuid: eventUuid,
    scan_id: scanId,
    project_id: config.projectId,
    profile_id: profile.id,
    prompt_id: prompt.id,
    market: profile.market,
    observed_at: observedAt,
    status: outcome.status,
    ...(outcome.reason ? { reason: String(outcome.reason).slice(0, 128) } : {}),
    target_domain: profile.targetDomain,
    target_cited: hasGroundedAnswer
      ? citedDomains.includes(canonicalDomain(profile.targetDomain))
      : null,
    answer_text: outcome.answerText ?? '',
    web_search_queries: outcome.webSearchQueries ?? [],
    cited_domains: citedDomains,
    citations: outcome.citations ?? [],
    tracked_competitors_named: hasGroundedAnswer
      ? trackedNames(outcome.answerText ?? '', profile.trackedCompetitors)
      : [],
    prompt_tokens: usage.promptTokens,
    candidate_tokens: usage.candidateTokens,
    total_tokens: usage.totalTokens,
    estimated_model_cost_micro_usd: estimatedModelCostMicroUsd(usage),
    grounding_cost_micro_usd: null,
    cost_status: 'billing_unreconciled',
    model_rate_card: MODEL_RATE_CARD,
    model: config.model,
  }
}

function addEventToReceipt(receipt, event, captured) {
  if (Object.hasOwn(receipt.counts, event.status)) receipt.counts[event.status]++
  else receipt.counts.failed++
  if (!captured.ok) receipt.counts.sink_failed++
  else receipt.event_uuids.push(event.event_uuid)
  receipt.prompt_tokens += event.prompt_tokens
  receipt.candidate_tokens += event.candidate_tokens
  receipt.total_tokens += event.total_tokens
  receipt.estimated_model_cost_micro_usd += event.estimated_model_cost_micro_usd
}

export async function runGeoScan(config, options = {}) {
  if (!config || typeof config !== 'object' || !Array.isArray(config.profiles)) {
    throw new TypeError('invalid_scanner_config')
  }
  const now = options.now ?? (() => new Date())
  const uuid = options.uuid ?? randomUUID
  const claimQuery = options.claimQuery ?? claimGroundedQuery
  const getGoogleToken = options.getGoogleToken ?? readWorkloadIdentityToken
  const runQuery = options.runQuery ?? runGroundedQuery
  const captureEvent = options.captureEvent ?? captureGeoEvent
  const sendReceipt = options.sendReceipt ?? sendMupotReceipt
  const scanId = uuid()
  const startedAt = isoNow(now)
  const googleToken = await getGoogleToken()
  const receipt = {
    schema: GEO_RECEIPT_SCHEMA,
    scan_id: scanId,
    project_id: config.projectId,
    profiles: config.profiles.map((profile) => profile.id),
    counts: { ok: 0, empty: 0, failed: 0, budget_denied: 0, sink_failed: 0 },
    prompt_tokens: 0,
    candidate_tokens: 0,
    total_tokens: 0,
    estimated_model_cost_micro_usd: 0,
    grounding_cost_micro_usd: null,
    cost_status: 'billing_unreconciled',
    model_rate_card: MODEL_RATE_CARD,
    event_uuids: [],
    started_at: startedAt,
    completed_at: startedAt,
  }

  scan: for (const profile of config.profiles) {
    for (const prompt of profile.prompts) {
      const observedAt = isoNow(now)
      const budget = await claimQuery({
        stateFile: config.stateFile,
        dailyQueryCap: config.dailyQueryCap,
        now: observedAt,
      })
      let outcome
      if (!budget.ok) {
        outcome = {
          status: 'budget_denied',
          reason: budget.reason,
          ...emptyEvidence(),
        }
      } else {
        outcome = await runQuery({
          accessToken: googleToken,
          googleProjectId: config.googleProjectId,
          location: config.location,
          model: config.model,
          prompt: prompt.text,
        })
      }
      const event = eventFor({
        eventUuid: uuid(),
        scanId,
        config,
        profile,
        prompt,
        observedAt,
        outcome,
      })
      const captured = await captureEvent({
        posthogHost: config.posthogHost,
        token: options.posthogToken,
        event,
      })
      addEventToReceipt(receipt, event, captured)
      if (!captured.ok) break scan
    }
  }

  receipt.completed_at = isoNow(now)
  const receiptResult = await sendReceipt({
    baseUrl: config.mupot.baseUrl,
    token: options.mupotToken,
    receiptTo: config.mupot.receiptTo,
    projectId: config.projectId,
    receipt,
  })
  return {
    ok: receipt.counts.sink_failed === 0 && receiptResult.ok,
    scanId,
    counts: { ...receipt.counts },
    costStatus: receipt.cost_status,
    receipt: receiptResult,
  }
}
