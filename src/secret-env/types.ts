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
}
