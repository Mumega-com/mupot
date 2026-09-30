export type SecretEnvRequestStatus = 'pending' | 'approved' | 'rejected'
export type SecretEnvBindingStatus = 'pending' | 'bound' | 'revoked'

export interface SecretEnvKeySpec {
  name: string
  purpose: string
}

export interface PublicSecretEnvRequest {
  id: string
  reason: string
  keys: SecretEnvKeySpec[]
  adapter_hint: string | null
  status: SecretEnvRequestStatus
  requested_by: string
  created_at: string
  /** Admin-queue enrichment (listPendingSecretEnvRequests only): who asked. */
  requester_email?: string | null
  requester_channel?: string | null
  /** Set when the requester is an agent's dedicated member: the agent's name and the humans behind it. */
  requester_agent_name?: string | null
  requester_owners?: { member_id: string; email: string | null; display_name: string }[]
}
