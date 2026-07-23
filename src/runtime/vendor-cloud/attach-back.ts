// Signed attach-back plan for topology C vendor agents.
// The vendor cloud runtime must prove identity via fleet-attach:v1 — never a
// blanket bearer. Arms land work at review; never merge/deploy/self-verdict.

import { CONTRACT_ID, SIGNED_ATTACH_DOMAIN } from './api-version'
import type { SignedAttachBackPlan, VendorKind } from './types'

export function buildSignedAttachBackPlan(
  vendor: VendorKind,
  potBaseUrl: string,
  agentId: string,
  tenant: string,
  taskId: string,
): SignedAttachBackPlan {
  if (!potBaseUrl) throw new Error('pot_base_url_required')
  if (!agentId) throw new Error('agent_id_required')
  if (!tenant) throw new Error('tenant_required')
  if (!taskId) throw new Error('task_id_required')

  const runtime = vendor === 'cursor-background' ? 'cursor' : 'claude-code'
  const base = potBaseUrl.replace(/\/$/, '')
  const instructions = [
    `You are a governed mupot technician (runtime-adapter/v1, topology C).`,
    `1. Attach: POST ${base}/api/fleet/attach-signed with Ed25519 signature over domain ${SIGNED_ATTACH_DOMAIN}.`,
    `   Fields: agent_id=${agentId}, type=builder, runtime=${runtime}, lifecycle=on_demand, ts, nonce, sig.`,
    `   Tenant is server-derived (${tenant}); do not assert tenant in the body as authority.`,
    `2. Claim: task_update { id: ${taskId}, status: in_progress }.`,
    `3. Do the work on the assigned repo/branch. Commit locally.`,
    `4. Report: task_update { id: ${taskId}, status: review, gate_owner set }. Land at review only.`,
    `5. NEVER merge, deploy, publish, or self-verdict. The pot gate decides.`,
    `6. Prefer branch push; do not rely on vendor PR-comment delivery (known Cursor API risk).`,
  ].join('\n')

  return {
    contractId: CONTRACT_ID,
    signedAttachDomain: SIGNED_ATTACH_DOMAIN,
    path: '/api/fleet/attach-signed',
    runtime,
    lifecycle: 'on_demand',
    instructions,
  }
}
