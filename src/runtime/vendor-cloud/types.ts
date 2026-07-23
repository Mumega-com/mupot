// Topology C (vendor-cloud) shared types — runtime-adapter/v1.
// Pure data shapes only. External HTTP lives in *-client.ts connectors.

export type VendorKind = 'cursor-background' | 'claude-managed'

export type CompletionKind = 'webhook' | 'poll_sse'

export type TerminalStatus = 'FINISHED' | 'ERROR'

export interface CompletionEvent {
  vendor: VendorKind
  vendorRunId: string
  status: TerminalStatus
  summary: string | null
  branchName: string | null
  prUrl: string | null
  raw: unknown
}

export interface LandAtReviewIntent {
  status: 'review'
  gateOwner: string
  vendorRunId: string
  branchName: string | null
  prUrl: string | null
  summary: string | null
  /** Adapters never merge/deploy/publish/self-verdict. */
  forbidden: readonly ['merge', 'deploy', 'publish', 'self_verdict']
}

export interface CursorLaunchInput {
  apiKey: string
  promptText: string
  repositoryUrl: string
  startingRef: string
  modelId: string | null
  autoCreatePr: boolean
  /** When using webhook completion, pass the pot callback + shared secret. */
  webhookUrl: string | null
  webhookSecret: string | null
  /** Optional env for the cloud VM (e.g. attach key material pointers). */
  envVars: Record<string, string> | null
  fetchImpl: typeof fetch
}

export interface CursorLaunchResult {
  apiVersion: 'v1'
  agentId: string
  runId: string | null
  status: string
  raw: unknown
}

export interface ClaudeManagedLaunchInput {
  apiKey: string
  /** Anthropic beta header value — live-verified constant. */
  betaHeader: string
  model: string
  systemPrompt: string
  userMessage: string
  fetchImpl: typeof fetch
}

export interface ClaudeManagedLaunchResult {
  agentId: string
  environmentId: string
  sessionId: string
  raw: unknown
}

export interface SignedAttachBackPlan {
  contractId: 'runtime-adapter/v1'
  signedAttachDomain: 'fleet-attach:v1'
  path: '/api/fleet/attach-signed'
  runtime: 'cursor' | 'claude-code'
  lifecycle: 'on_demand'
  /** Prompt fragment the vendor agent must follow to attach + claim + report. */
  instructions: string
}
