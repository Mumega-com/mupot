// mupot — Workflow port (Module Kernel Port 5).
//
// Cloudflare Workflows = DEFAULT adapter (native TASK_WORKFLOW + loop engine).
// n8n / zapier / make = optional adapters behind the SAME port.
// Direction: inbound = signed source-only ingress; outbound = gated act → receipt.
// External managers never hold the approval — the kernel gate does.
//
// Design: docs/architecture/mupot-module-kernel.md §2.

export const WORKFLOW_PORT_VERSION = 1 as const

export type WorkflowAdapterKind = 'cf' | 'n8n' | 'zapier' | 'make'

export const WORKFLOW_ADAPTERS: readonly WorkflowAdapterKind[] = [
  'cf',
  'n8n',
  'zapier',
  'make',
]

export function isWorkflowAdapterKind(value: unknown): value is WorkflowAdapterKind {
  return typeof value === 'string' && (WORKFLOW_ADAPTERS as readonly string[]).includes(value)
}

/** Tools a gated loop may propose that queue a workflow_act (not a GHL outbound). */
export const WORKFLOW_ACT_TOOLS: ReadonlySet<string> = new Set([
  'run_workflow',
  'n8n_run_workflow',
])

export function isWorkflowActTool(tool: string): boolean {
  return WORKFLOW_ACT_TOOLS.has(tool)
}

/**
 * Resolve which adapter a proposed act targets.
 * `n8n_run_workflow` always pins n8n; `run_workflow` reads args.adapter (default n8n
 * for the marketing proving ground — CF remains the pot-native default via the
 * existing /pipeline path, not this external-act queue).
 */
export function resolveWorkflowAdapter(
  tool: string,
  args: Record<string, unknown>,
): WorkflowAdapterKind {
  if (tool === 'n8n_run_workflow') return 'n8n'
  const raw = args.adapter
  if (isWorkflowAdapterKind(raw) && raw !== 'cf') return raw
  // External act queue defaults to n8n (marketing proving ground). The CF default
  // lives on POST /api/tasks/:id/pipeline — not this queue.
  return 'n8n'
}

/** Payload persisted on workflow_acts.payload (JSON). Never store secrets here. */
export interface WorkflowActPayload {
  /** Optional per-act webhook override (SSRF-guarded at fire time). Prefer env. */
  webhook_url?: string
  /** Opaque body forwarded to the external manager (no secrets). */
  body?: Record<string, unknown>
  /** Human-readable label for receipts / evidence. */
  label?: string
}

export interface WorkflowRunInput {
  taskId: string
  actId: string
  adapter: WorkflowAdapterKind
  payload: WorkflowActPayload
}

export interface WorkflowRunResult {
  ok: boolean
  status: 'ok' | 'failed' | 'not_configured'
  detail: string
  /** External execution id when the manager returns one. */
  externalRef?: string
}
