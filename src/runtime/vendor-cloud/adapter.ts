// Vendor-cloud adapter (topology C) — launch on vendor API, attach back over
// fleet-attach:v1, complete via a PLUGGABLE completion port (webhook | poll/SSE).
// Conforms to runtime-adapter/v1. Never merges/deploys/self-verdicts.

import { buildSignedAttachBackPlan } from './attach-back'
import { createClaudeManagedAgentsClient, type ClaudeManagedAgentsClient } from './claude-managed-client'
import {
  createPollSseCompletionPort,
  createWebhookCompletionPort,
  landAtReviewIntent,
  selectCompletionPort,
  type AnyCompletionPort,
} from './completion-port'
import { createCursorCloudClient, type CursorCloudClient } from './cursor-client'
import { interpretPollSnapshot, pollUntilComplete } from './poll-sse-listener'
import type {
  ClaudeManagedLaunchResult,
  CompletionEvent,
  CursorLaunchResult,
  LandAtReviewIntent,
  SignedAttachBackPlan,
  VendorKind,
} from './types'

export interface VendorCloudAdapterDeps {
  cursorClient: CursorCloudClient
  claudeClient: ClaudeManagedAgentsClient
  fetchImpl: typeof fetch
  sleepFn: (ms: number) => Promise<void>
}

export interface LaunchCursorCloudWorkInput {
  apiKey: string
  promptText: string
  repositoryUrl: string
  startingRef: string
  modelId: string | null
  autoCreatePr: boolean
  potBaseUrl: string
  agentId: string
  tenant: string
  taskId: string
  gateOwner: string
  webhookUrl: string | null
  webhookSecret: string | null
  pollIntervalMs: number
  timeoutMs: number
  envVars: Record<string, string> | null
}

export interface LaunchClaudeManagedWorkInput {
  apiKey: string
  model: string
  systemPrompt: string
  userMessage: string
  potBaseUrl: string
  agentId: string
  tenant: string
  taskId: string
  gateOwner: string
  pollIntervalMs: number
  timeoutMs: number
}

export interface VendorCloudLaunchBundle {
  vendor: VendorKind
  launch: CursorLaunchResult | ClaudeManagedLaunchResult
  attachPlan: SignedAttachBackPlan
  completionPort: AnyCompletionPort
  gateOwner: string
}

export function createVendorCloudAdapterDeps(
  fetchImpl: typeof fetch,
  sleepFn: (ms: number) => Promise<void>,
): VendorCloudAdapterDeps {
  return {
    cursorClient: createCursorCloudClient(),
    claudeClient: createClaudeManagedAgentsClient(),
    fetchImpl,
    sleepFn,
  }
}

export async function launchCursorBackgroundWork(
  deps: VendorCloudAdapterDeps,
  input: LaunchCursorCloudWorkInput,
): Promise<VendorCloudLaunchBundle> {
  const attachPlan = buildSignedAttachBackPlan(
    'cursor-background',
    input.potBaseUrl,
    input.agentId,
    input.tenant,
    input.taskId,
  )
  const promptText = `${input.promptText}\n\n---\n${attachPlan.instructions}`
  const completionPort = selectCompletionPort(
    'cursor-background',
    input.webhookSecret,
    input.pollIntervalMs,
    input.timeoutMs,
  )
  const launch = await deps.cursorClient.launchAgent({
    apiKey: input.apiKey,
    promptText,
    repositoryUrl: input.repositoryUrl,
    startingRef: input.startingRef,
    modelId: input.modelId,
    autoCreatePr: input.autoCreatePr,
    webhookUrl: completionPort.kind === 'webhook' ? input.webhookUrl : null,
    webhookSecret: completionPort.kind === 'webhook' ? input.webhookSecret : null,
    envVars: input.envVars,
    fetchImpl: deps.fetchImpl,
  })
  return {
    vendor: 'cursor-background',
    launch,
    attachPlan,
    completionPort,
    gateOwner: input.gateOwner,
  }
}

export async function launchClaudeManagedWork(
  deps: VendorCloudAdapterDeps,
  input: LaunchClaudeManagedWorkInput,
): Promise<VendorCloudLaunchBundle> {
  const attachPlan = buildSignedAttachBackPlan(
    'claude-managed',
    input.potBaseUrl,
    input.agentId,
    input.tenant,
    input.taskId,
  )
  // CMA has NO webhook — completion port is always poll/SSE.
  const completionPort = createPollSseCompletionPort(
    'claude-managed',
    input.pollIntervalMs,
    input.timeoutMs,
  )
  const systemPrompt = `${input.systemPrompt}\n\n${attachPlan.instructions}`
  const launch = await deps.claudeClient.launchSession({
    apiKey: input.apiKey,
    betaHeader: deps.claudeClient.betaHeader,
    model: input.model,
    systemPrompt,
    userMessage: input.userMessage,
    fetchImpl: deps.fetchImpl,
  })
  return {
    vendor: 'claude-managed',
    launch,
    attachPlan,
    completionPort,
    gateOwner: input.gateOwner,
  }
}

export async function awaitPollSseCompletion(
  deps: VendorCloudAdapterDeps,
  bundle: VendorCloudLaunchBundle,
  apiKey: string,
): Promise<{ event: CompletionEvent; land: LandAtReviewIntent }> {
  if (bundle.completionPort.kind !== 'poll_sse') {
    throw new Error('await_poll_sse_requires_poll_sse_port')
  }
  const port = bundle.completionPort
  if (bundle.vendor === 'cursor-background') {
    const launch = bundle.launch as CursorLaunchResult
    const event = await pollUntilComplete(
      'cursor-background',
      async () => {
        const got = await deps.cursorClient.getAgent(apiKey, launch.agentId, deps.fetchImpl)
        // Map Cursor ACTIVE→non-terminal; FINISHED/ERROR when present on agent or nested run.
        const raw = got.raw as Record<string, unknown>
        const run = raw.run as Record<string, unknown> | undefined
        const runStatus = typeof run?.status === 'string' ? run.status : null
        const status = runStatus ?? mapCursorAgentStatus(got.status)
        return {
          id: got.id,
          status,
          summary: null,
          branchName: null,
          prUrl: null,
          raw: got.raw,
        }
      },
      port.pollIntervalMs,
      port.timeoutMs,
      deps.sleepFn,
    )
    return { event, land: landAtReviewIntent(event, bundle.gateOwner) }
  }

  const launch = bundle.launch as ClaudeManagedLaunchResult
  const event = await pollUntilComplete(
    'claude-managed',
    async () => {
      const got = await deps.claudeClient.getSession(apiKey, launch.sessionId, deps.fetchImpl)
      return {
        id: got.id,
        status: got.status,
        summary: null,
        branchName: null,
        prUrl: null,
        raw: got.raw,
      }
    },
    port.pollIntervalMs,
    port.timeoutMs,
    deps.sleepFn,
  )
  return { event, land: landAtReviewIntent(event, bundle.gateOwner) }
}

function mapCursorAgentStatus(status: string): string {
  const upper = status.toUpperCase()
  if (upper === 'FINISHED' || upper === 'COMPLETED' || upper === 'DONE') return 'FINISHED'
  if (upper === 'ERROR' || upper === 'FAILED') return 'ERROR'
  return status
}

/** Re-export port factories for callers that wire completion explicitly. */
export {
  createPollSseCompletionPort,
  createWebhookCompletionPort,
  interpretPollSnapshot,
  landAtReviewIntent,
  selectCompletionPort,
}
