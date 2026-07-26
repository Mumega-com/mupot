// mupot — marketing-loop proving ground for the workflow port (Port 5).
//
// The marketing / CRO loop proposes gated acts. When the act tool is
// `n8n_run_workflow`, wireGatedAct queues a workflow_act; an approved verdict
// fires the n8n webhook and writes a workflow_receipts row. This helper builds
// that ProposedAct shape so the marketing driver (or tests) can exercise the
// full gated path without inventing a new LoopKind.

import type { ProposedAct } from '../loops/runtime'

export interface MarketingN8nActInput {
  /** Short operator-visible summary (becomes the review-task title). */
  summary: string
  /** Optional label stored on the workflow act / receipt. */
  label: string
  /** Body forwarded to n8n after approval (no secrets). */
  body: Record<string, unknown>
  /** Optional per-act webhook override (SSRF-guarded at fire time). Prefer env. */
  webhook_url?: string
}

/**
 * Build a gated `n8n_run_workflow` act for the marketing proving ground.
 * channel_index:-1 — internal proposal, not a loop channel send.
 */
export function marketingN8nWorkflowAct(input: MarketingN8nActInput): ProposedAct {
  const args: Record<string, unknown> = {
    adapter: 'n8n',
    label: input.label,
    body: input.body,
  }
  if (typeof input.webhook_url === 'string' && input.webhook_url.trim().length > 0) {
    args.webhook_url = input.webhook_url.trim()
  }
  return {
    channel_index: -1,
    tool: 'n8n_run_workflow',
    args,
    summary: input.summary.slice(0, 200),
  }
}
