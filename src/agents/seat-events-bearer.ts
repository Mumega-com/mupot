/** Private Worker→DO observer descriptor. Never accept this from a public caller. */
export interface BearerSubscription {
  kind: 'bearer'
  tenant: string
  agent: string
  seat: string | null
  credential_id: string
  member_id: string
  not_after: number
}
export const BEARER_MAX_POT = 256
export const BEARER_MAX_AGENT = 4
export const BEARER_MAX_CREDENTIAL = 2
export const BEARER_LIFETIME_MS = 15 * 60_000

export function decodeBearerSubscription(raw: unknown, tenant: string, now: number): BearerSubscription | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.kind !== 'bearer' || r.tenant !== tenant || !tenant) return null
  for (const key of ['agent', 'credential_id', 'member_id']) {
    if (typeof r[key] !== 'string' || !(r[key] as string).length || (r[key] as string).length > 256) return null
  }
  if (r.seat !== null && (typeof r.seat !== 'string' || !r.seat.length || r.seat.length > 512)) return null
  if (typeof r.not_after !== 'number' || !Number.isSafeInteger(r.not_after) || r.not_after <= now || r.not_after > now + BEARER_LIFETIME_MS) return null
  return { kind: 'bearer', tenant, agent: r.agent as string, seat: r.seat as string | null,
    credential_id: r.credential_id as string, member_id: r.member_id as string, not_after: r.not_after }
}

export function bearerHintVisible(sub: BearerSubscription, hint: { to_agent: string; target_seat: string | null }, now: number): boolean {
  return now < sub.not_after && hint.to_agent === sub.agent && (hint.target_seat === null || hint.target_seat === sub.seat)
}

export function bearerAcceptRefusal(sub: BearerSubscription, observers: readonly BearerSubscription[], hostHoldsAgent: boolean): string | null {
  if (hostHoldsAgent) return 'notify_owned_by_fleet_host'
  if (observers.length >= BEARER_MAX_POT) return 'bearer_pot_capacity'
  if (observers.filter(s => s.agent === sub.agent).length >= BEARER_MAX_AGENT) return 'bearer_agent_capacity'
  if (observers.filter(s => s.credential_id === sub.credential_id).length >= BEARER_MAX_CREDENTIAL) return 'bearer_credential_capacity'
  return null
}
