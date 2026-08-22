// mupot — Stripe execution metering receipt formatter (commercialization slice 4).
//
// Converts completed Mupot flight/task execution records into tamper-evident
// billing line items for Stripe invoice items and client statement reporting.

export interface ExecutionReceiptInput {
  tenantSlug: string
  clientName: string
  taskId: string
  flightId?: string
  servicePackage: string
  executorSeat: string
  costMicroUsd: number
  modelTokens?: {
    input: number
    output: number
  }
  completedAt?: string
  rateMultiplier?: number
}

export interface StripeMeteringReceipt {
  receiptId: string
  payloadSha256: string
  tenantSlug: string
  clientName: string
  taskId: string
  flightId: string | null
  servicePackage: string
  executorSeat: string
  rawComputeCostUsd: string
  billedAmountCents: number
  billedAmountFormatted: string
  tokenUsageSummary: string
  completedAt: string
  lineItemDescription: string
}

export async function computeReceiptSha256(canonicalPayload: string): Promise<string> {
  const enc = new TextEncoder()
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(canonicalPayload))
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function formatStripeMeteringReceipt(input: ExecutionReceiptInput): Promise<StripeMeteringReceipt> {
  const multiplier = input.rateMultiplier && input.rateMultiplier > 0 ? input.rateMultiplier : 2.5 // standard commercial margin
  const rawCostUsd = input.costMicroUsd / 1_000_000
  const billedCostUsd = rawCostUsd * multiplier
  const billedAmountCents = Math.max(50, Math.round(billedCostUsd * 100)) // minimum 50 cents per execution
  const completedAt = input.completedAt ?? new Date().toISOString()

  const tokens = input.modelTokens
    ? `${(input.modelTokens.input + input.modelTokens.output).toLocaleString()} tokens (${input.modelTokens.input.toLocaleString()} in / ${input.modelTokens.output.toLocaleString()} out)`
    : 'Metered Edge Flight'

  const lineItemDescription = `[Mumega Autonomous Service] ${input.servicePackage.toUpperCase()} - Task ${input.taskId.slice(0, 8)} (${tokens})`

  const canonicalPayload = JSON.stringify({
    tenantSlug: input.tenantSlug,
    clientName: input.clientName,
    taskId: input.taskId,
    flightId: input.flightId ?? null,
    servicePackage: input.servicePackage,
    executorSeat: input.executorSeat,
    costMicroUsd: input.costMicroUsd,
    billedAmountCents,
    completedAt,
  })

  const payloadSha256 = await computeReceiptSha256(canonicalPayload)
  const receiptId = `rcpt_${input.taskId.slice(0, 8)}_${payloadSha256.slice(0, 12)}`

  return {
    receiptId,
    payloadSha256,
    tenantSlug: input.tenantSlug,
    clientName: input.clientName,
    taskId: input.taskId,
    flightId: input.flightId ?? null,
    servicePackage: input.servicePackage,
    executorSeat: input.executorSeat,
    rawComputeCostUsd: `$${rawCostUsd.toFixed(4)}`,
    billedAmountCents,
    billedAmountFormatted: `$${(billedAmountCents / 100).toFixed(2)}`,
    tokenUsageSummary: tokens,
    completedAt,
    lineItemDescription,
  }
}
