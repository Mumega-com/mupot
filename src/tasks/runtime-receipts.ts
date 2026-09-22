import { canOnSquad, resolveCapabilities } from '../auth/capability'
import { TOKEN_LIVE_PREDICATE, nowSqlUtc } from '../auth/token-lifecycle'
import { canonicalJson, sha256Hex } from '../lib/canonical-json'
import type { AuthContext, Env } from '../types'
import { dispatchInboxRequestId } from '../bus/fleet-bridge'
import { MAX_LEASE_SECONDS, bearerFencePredicate, LEASE_LIVE_PREDICATE } from '../agents/messages'
import { resolveTaskAssignee } from './assignee'
import { verifyTaskArtifactShape } from './artifact-verification'
import { isValidGateOwnerForm } from './service'

export type TaskDispatchRuntimeStage = 'runtime_consumed' | 'completed' | 'failed'

/** mupot#1494 v4 (P1-a) — the wider set of values `task_dispatch_runtime_receipts.stage`
 *  can actually hold on disk. `TaskDispatchRuntimeStage` stays the narrow, caller-facing
 *  type accepted by `recordTaskDispatchRuntimeReceipt` (a normal runner settle can never
 *  submit `'reset_terminated'` — see `STAGES` below, which deliberately does NOT widen);
 *  this wider type is only for READING a row back (a public receipt or the timeline), where
 *  an operator-written `'reset_terminated'` marker is a real, expected value. */
export type TaskDispatchRuntimeReceiptStage = TaskDispatchRuntimeStage | 'reset_terminated'

export interface RecordTaskDispatchRuntimeReceiptInput {
  taskId: string
  dispatchReceiptId: string
  messageId: string
  stage: TaskDispatchRuntimeStage
  runtimeReceiptHash: string
  attempt: number
  artifactRefs?: string[]
  artifactSha256?: string | null
  result?: string | null
  reason?: string | null
}

export interface TaskDispatchRuntimeReceipt {
  id: string
  tenant: string
  dispatch_receipt_id: string
  task_id: string
  agent_id: string
  message_id: string
  member_id: string
  credential_id: string
  stage: TaskDispatchRuntimeReceiptStage
  attempt: number
  runtime_address: string
  runtime_receipt_hash: string
  request_digest: string
  artifact_refs: string[]
  artifact_sha256: string | null
  result: string | null
  reason: string | null
  audit_entry_id: string
  created_at: string
}

export interface PublicTaskDispatchRuntimeReceipt {
  stage: TaskDispatchRuntimeReceiptStage
  attempt: number
  runtime_address: string
  runtime_receipt_hash: string
  artifact_refs: string[]
  artifact_sha256: string | null
  result: string | null
  reason: string | null
  created_at: string
}

/** mupot#1494/#1502 — the LATEST task_dispatch_receipts row for a task, as exposed on
 *  task_list/task_board rows. A task_list-only runner has no other way to learn the
 *  dispatch_receipt_id it needs to settle via recordTaskDispatchRuntimeReceipt's
 *  {task_id, dispatch_receipt_id} correlator (P1-a); `delivered_via` closes #1502's read side
 *  — "never silent" means the routing decision must be READABLE, not just recorded. */
export interface LatestDispatchReceiptInfo {
  dispatch_receipt_id: string
  delivered_via: 'inbox' | 'in_worker' | null
}

/**
 * loadLatestDispatchReceiptsForTasks — one bounded query, the MOST RECENT
 * task_dispatch_receipts row per task_id (by created_at, tie-broken by rowid — the table has
 * no INTEGER PRIMARY KEY alias, but every SQLite table carries an implicit rowid unless
 * declared WITHOUT ROWID, and this one is not).
 *
 * mupot#1494 round 3 (P2-1, adversarial round 2) — NOW filters to a receipt whose
 * `dispatch.agent_id` still equals the task's CURRENT `assignee_agent_id`
 * (`d.agent_id = t.assignee_agent_id`). Round 2's own reasoning ("cannot be used to settle
 * as someone else, so exposing a stale receipt is harmless") was true for the SETTLE path
 * (`recordTaskDispatchRuntimeReceipt` does fail closed on a mismatch) but not for this READ
 * path: after a task is reassigned, the NEW assignee's own `task_list`/`task_board` row
 * (gated by `assignee_agent_id === auth.boundAgentId` at the call site, src/mcp/index.ts)
 * would still surface the OLD agent's `dispatch_receipt_id` — an identifier for a dispatch
 * that was never theirs, disclosed for no operational reason (the new assignee cannot
 * settle it; the ownership check inside `claimUnleasedForPairSettlement`'s ownership predicate
 * refuses it as it should). Filtering here means a reassigned task simply shows no
 * dispatch_receipt_id at all until the CURRENT assignee gets a fresh one of their own.
 */
export async function loadLatestDispatchReceiptsForTasks(
  env: Env,
  taskIds: readonly string[],
): Promise<Map<string, LatestDispatchReceiptInfo>> {
  const map = new Map<string, LatestDispatchReceiptInfo>()
  if (taskIds.length === 0) return map
  const placeholders = taskIds.map((_, i) => `?${i + 2}`).join(', ')
  const rows = await env.DB.prepare(`
    SELECT d.task_id AS task_id, d.id AS dispatch_receipt_id, d.delivered_via AS delivered_via
      FROM task_dispatch_receipts d
      JOIN tasks t ON t.id = d.task_id
     WHERE d.tenant = ?1 AND d.task_id IN (${placeholders})
       AND d.agent_id = t.assignee_agent_id
       AND NOT EXISTS (
         SELECT 1 FROM task_dispatch_receipts newer
          WHERE newer.tenant = d.tenant AND newer.task_id = d.task_id
            AND newer.agent_id = t.assignee_agent_id
            AND (newer.created_at > d.created_at
                 OR (newer.created_at = d.created_at AND newer.rowid > d.rowid))
       )
  `).bind(env.TENANT_SLUG, ...taskIds)
    .all<{ task_id: string; dispatch_receipt_id: string; delivered_via: string | null }>()
  for (const row of rows.results ?? []) {
    map.set(row.task_id, {
      dispatch_receipt_id: row.dispatch_receipt_id,
      delivered_via: row.delivered_via === 'inbox' || row.delivered_via === 'in_worker' ? row.delivered_via : null,
    })
  }
  return map
}

/** Terminal stages for `task_dispatch_runtime_receipts.stage` — a dispatch with a row in
 *  ANY of these is settled, one way or another, and no longer "in flight". Exported (and
 *  the only place the SQL `IN (...)` list below is written) so `hasInFlightDispatchReceipt`
 *  and any future reader of "is this stage terminal" can never drift apart. Fixed, literal
 *  values controlled entirely by this file — safe to inline into SQL directly, never bound
 *  as a parameter (D1 has no array bind for `IN`). */
export const TERMINAL_RUNTIME_RECEIPT_STAGES = ['completed', 'failed', 'reset_terminated'] as const
const TERMINAL_RUNTIME_RECEIPT_STAGES_SQL = TERMINAL_RUNTIME_RECEIPT_STAGES.map((s) => `'${s}'`).join(', ')

/**
 * hasInFlightDispatchReceipt — mupot#1494 round 3 (P2-5, adversarial round 2). True iff a
 * task's MOST RECENT dispatch has no terminal runtime receipt yet — i.e. it is genuinely
 * mid-flight: dispatched, possibly consumed, but not yet settled either way. Reassigning
 * `assignee_agent_id` while this is true orphans the dispatch: the OLD agent's in-flight
 * settle (`recordTaskDispatchRuntimeReceipt`) will fail `runtime_receipt_forbidden` the
 * moment `task.assignee_agent_id` no longer matches it (the ownership check both the direct
 * path and `claimUnleasedForPairSettlement`'s claim predicate enforce), and the NEW assignee
 * has no dispatch of their own to settle — the task is wedged until a fresh `task_dispatch`
 * (itself refused while the old one is still unsettled — see `toolTaskDispatch`'s own
 * `task_not_dispatchable` gate) or an operator intervenes. `task_update`'s reassignment path
 * refuses outright while this is true (`task_dispatch_in_flight`) rather than silently
 * creating the wedge.
 *
 * mupot#1494 v4 (P1-a, adversarial round 2) — `'completed'`/`'failed'` used to be the ONLY
 * terminal stages, and `adminResetDispatchLease`'s lease repair wrote NEITHER: a reset
 * (even `override:true`) left the dispatch looking permanently in-flight forever, so a
 * genuinely dead runner's task could be reset but never reassigned, unassigned, OR
 * re-dispatched through the normal `task_dispatch` door (which had no in-flight guard of its
 * own at all — PROVED: a fresh dispatch succeeded anyway, contradicting this function's own
 * doc comment). `'reset_terminated'` is the real terminal disposition `adminResetDispatchLease`
 * now writes for `terminate: true` — see its doc comment for the exact repair semantics.
 */
export async function hasInFlightDispatchReceipt(env: Env, taskId: string): Promise<boolean> {
  const row = await env.DB.prepare(`
    SELECT 1
      FROM task_dispatch_receipts d
     WHERE d.tenant = ?1 AND d.task_id = ?2
       AND NOT EXISTS (
         SELECT 1 FROM task_dispatch_receipts newer
          WHERE newer.tenant = d.tenant AND newer.task_id = d.task_id
            AND (newer.created_at > d.created_at
                 OR (newer.created_at = d.created_at AND newer.rowid > d.rowid))
       )
       AND NOT EXISTS (
         SELECT 1 FROM task_dispatch_runtime_receipts r
          WHERE r.tenant = ?1 AND r.dispatch_receipt_id = d.id
            AND r.stage IN (${TERMINAL_RUNTIME_RECEIPT_STAGES_SQL})
       )
     LIMIT 1
  `).bind(env.TENANT_SLUG, taskId).first<{ 1: number }>()
  return row !== null
}

export type TaskDispatchRuntimeReceiptErrorCode =
  | 'agent_bound_workspace_credential_required'
  | 'runtime_receipt_invalid'
  | 'runtime_delivery_not_found'
  | 'runtime_delivery_stale'
  | 'runtime_receipt_forbidden'
  | 'runtime_receipt_conflict'
  | 'runtime_artifact_required'
  | 'runtime_gate_required'
  | 'runtime_receipt_transition_conflict'
  | 'runtime_receipt_persistence_conflict'

export class TaskDispatchRuntimeReceiptError extends Error {
  readonly name = 'TaskDispatchRuntimeReceiptError'

  constructor(readonly code: TaskDispatchRuntimeReceiptErrorCode) {
    super(code)
  }
}

interface DeliveryRow {
  dispatch_consumed_at: string | null
  dispatch_agent_id: string
  dispatch_squad_id: string
  dispatch_project_id: string | null
  task_status: string
  task_assignee_agent_id: string | null
  task_squad_id: string
  task_project_id: string | null
  task_done_when: string
  task_gate_owner: string | null
  agent_status: string
  message_to_agent: string
  message_from_agent: string
  message_request_id: string | null
  message_project_id: string | null
  message_body: string
  message_read_at: string | null
  message_delivery_attempts: number
  message_lease_expires_at: string | null
  message_dead_lettered_at: string | null
  /** mupot#1494 v4 (P0 successor) — computed in SQL via LEASE_LIVE_PREDICATE (julianday on
   *  both sides), NEVER re-derived by comparing `message_lease_expires_at` against a JS
   *  `now` string — see LEASE_LIVE_PREDICATE's doc comment (src/agents/messages.ts) for the
   *  exact format-split defect that JS comparison reintroduces. 1 iff live, 0 otherwise
   *  (SQLite has no boolean type; D1 returns the INTEGER as-is). */
  message_lease_live: number
}

interface ReceiptRow extends Omit<TaskDispatchRuntimeReceipt, 'artifact_refs'> {
  artifact_refs_json: string
}

const SHA256_RE = /^[0-9a-f]{64}$/
const STAGES = new Set<TaskDispatchRuntimeStage>(['runtime_consumed', 'completed', 'failed'])

export async function hasIndependentRuntimeGate(
  env: Env,
  gateOwner: string | null | undefined,
  assigneeAgentId: string,
  taskSquadId: string,
): Promise<boolean> {
  if (
    gateOwner === null || gateOwner === undefined
    || gateOwner === 'gate:agent-self-completion'
    || !isValidGateOwnerForm(gateOwner)
  ) return false
  const row = await env.DB.prepare(`
    SELECT 1 AS allowed
      FROM gate_grants grant_row
      JOIN agents gate_agent
        ON grant_row.principal_type = 'agent'
       AND gate_agent.id = grant_row.principal_id
       AND gate_agent.status = 'active'
      JOIN squads task_squad ON task_squad.id = ?4
     WHERE grant_row.capability = ?1
       AND gate_agent.id <> ?2
       AND EXISTS (
         SELECT 1
           FROM member_tokens t
           JOIN members gate_member
             ON gate_member.id = t.member_id AND gate_member.status = 'active'
          WHERE t.agent_id = gate_agent.id
            AND t.tenant = ?3
            AND ${TOKEN_LIVE_PREDICATE('?5')}
            AND (
              EXISTS (
                SELECT 1
                  FROM capabilities capability
                 WHERE capability.member_id = t.member_id
                   AND capability.capability IN ('member', 'lead', 'admin', 'owner')
                   AND (
                     capability.scope_type = 'org'
                     OR (capability.scope_type = 'squad' AND capability.scope_id = ?4)
                     OR (
                       capability.scope_type = 'department'
                       AND capability.scope_id = task_squad.department_id
                     )
                   )
              )
              OR EXISTS (
                SELECT 1
                  FROM channel_capability_grants channel_grant
                 WHERE channel_grant.member_id = t.member_id
                   AND channel_grant.squad_id = ?4
                   AND channel_grant.capability IN ('member', 'lead', 'admin', 'owner')
              )
            )
       )
     LIMIT 1
  `).bind(gateOwner, assigneeAgentId, env.TENANT_SLUG, taskSquadId, nowSqlUtc())
    .first<{ allowed: number }>()
  return row !== null
}

function text(value: unknown, maximum = 255): string {
  if (typeof value !== 'string') throw new TaskDispatchRuntimeReceiptError('runtime_receipt_invalid')
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new TaskDispatchRuntimeReceiptError('runtime_receipt_invalid')
  }
  return normalized
}

function optionalText(value: unknown, maximum: number): string | null {
  return value === undefined || value === null ? null : text(value, maximum)
}

function publicReceipt(row: ReceiptRow): TaskDispatchRuntimeReceipt {
  const refs = JSON.parse(row.artifact_refs_json) as unknown
  if (!Array.isArray(refs) || !refs.every((value) => typeof value === 'string')) {
    throw new TaskDispatchRuntimeReceiptError('runtime_receipt_persistence_conflict')
  }
  const { artifact_refs_json: _artifactRefsJson, ...receipt } = row
  return { ...receipt, artifact_refs: refs }
}

function publicTimelineReceipt(row: ReceiptRow): PublicTaskDispatchRuntimeReceipt {
  const receipt = publicReceipt(row)
  return {
    stage: receipt.stage,
    attempt: receipt.attempt,
    runtime_address: receipt.runtime_address,
    runtime_receipt_hash: receipt.runtime_receipt_hash,
    artifact_refs: receipt.artifact_refs,
    artifact_sha256: receipt.artifact_sha256,
    result: receipt.result,
    reason: receipt.reason,
    created_at: receipt.created_at,
  }
}

/**
 * resolveMessageId — mupot#1494: accept `{task_id, dispatch_receipt_id}` as an alternative
 * correlator to `message_id`. A runner that polls `task_list` (see the runner-onboarding
 * playbook) rather than `inbox`/`inbox_lease` never observes a raw `agent_messages.id` — only
 * the task and the receipt it was dispatched under — so `message_id` may be omitted and is
 * resolved here from the SAME convention `deliverDispatchToInbox` (src/bus/fleet-bridge.ts)
 * used to WRITE the message: `from_agent='mupot-dispatch'`, `request_id='dispatch-inbox:<receipt
 * id>'`. This is not a shortcut around validation — `validateEnvelope` below re-checks that
 * exact `message_request_id` invariant regardless of which path supplied the id, and the
 * subsequent JOIN in `loadDelivery` still requires the resolved message to belong to THIS
 * task_id/dispatch_receipt_id pair (a mismatched pair — a real receipt whose task_id disagrees
 * with the caller's — fails that JOIN and surfaces as `runtime_delivery_not_found`, same as
 * today). Same authz as today: this only changes how the delivery row is FOUND, never who may
 * call recordTaskDispatchRuntimeReceipt.
 */
async function resolveMessageId(
  env: Env,
  dispatchReceiptId: string,
  providedMessageId: string,
): Promise<string> {
  if (providedMessageId) return providedMessageId
  const row = await env.DB.prepare(
    `SELECT id FROM agent_messages WHERE tenant = ?1 AND from_agent = 'mupot-dispatch' AND request_id = ?2 LIMIT 1`,
  ).bind(env.TENANT_SLUG, dispatchInboxRequestId(dispatchReceiptId)).first<{ id: string }>()
  if (!row) throw new TaskDispatchRuntimeReceiptError('runtime_delivery_not_found')
  return row.id
}

/**
 * claimUnleasedForPairSettlement — mupot#1494 round 2 (P1-a). A task_list-only runner never
 * calls `inbox_lease`, so its dispatch message is stuck at its pristine, never-touched state
 * (`delivery_attempts=0, lease_expires_at=NULL, read_at=NULL`) — which `validateEnvelope`
 * refuses outright (no live lease). Settling via the `{task_id, dispatch_receipt_id}` pair
 * performs the SAME hand-out `leaseAgentInbox` would have (bump `delivery_attempts` to 1 — the
 * "generation" a first delivery attempt always is — and stamp a `lease_expires_at` window),
 * atomically, gated on the row still being in that pristine state. The row this produces is
 * BYTE-IDENTICAL in shape to a resident agent's freshly-`inbox_lease`d message
 * (`read_at` still NULL, a live future lease) — `validateEnvelope`'s existing, UNCHANGED checks
 * pass through the ordinary (non-replay) branch, exactly as they do for a resident.
 *
 * Only fires for `attempt === 1` (caller-side gate, see the call site) — a task_list-only
 * runner has no lease to have retried, so any OTHER attempt number can only mean the row is
 * NOT pristine, and `validateEnvelope`'s `delivery_attempts !== attempt` check refuses it on
 * its own merits without this function's help.
 *
 * A second stage transition on the SAME message (e.g. `runtime_consumed` then `completed`)
 * finds the row already claimed (`delivery_attempts=1`, not `0`) — this function is a no-op
 * (0 rows changed) and the existing lease from the FIRST claim is what `validateEnvelope`
 * checks against; no special-casing needed. And because a later `inbox_lease` call requires
 * `read_at IS NULL AND lease_expires_at <= now` to hand a message out, this claim's live lease
 * blocks exactly that redelivery for its window (mirrors — not exceeds — the crash-recovery
 * property every resident lease already has: an abandoned settlement eventually becomes
 * re-leasable again, by design, the same as an abandoned resident lease does).
 *
 * mupot#1494 round 3 (P0, Athena's structural ruling) — the OWNERSHIP predicate (the claimed
 * message must belong to a dispatch whose `agent_id` AND the task's `assignee_agent_id` both
 * equal the CALLER's own agent id), the caller's own `active` status, and the SAME bearer
 * fence `leaseAgentInbox` enforces are now all INSIDE this one UPDATE's WHERE — not a
 * check-then-write. Round 2 called this function unconditionally once the token check passed,
 * relying ENTIRELY on `loadDelivery`'s later JOIN + the ownership check just after it to
 * refuse a mismatched caller — but by then the write had already landed on the VICTIM's row
 * (delivery_attempts 0->1, a live 1h lease), stranding the victim's own inbox_lease for the
 * window and permanently desynchronising its attempt counter. Embedding the predicate in the
 * WHERE makes a non-owner's (or inactive, or fenced-out) claim change ZERO rows atomically —
 * no side effect ever lands, regardless of what happens next in `recordTaskDispatchRuntimeReceipt`.
 */
async function claimUnleasedForPairSettlement(
  env: Env,
  input: { messageId: string; dispatchReceiptId: string; taskId: string; callerAgentId: string },
): Promise<boolean> {
  const leaseExpiresAt = new Date(Date.now() + MAX_LEASE_SECONDS * 1000).toISOString()
  const result = await env.DB.prepare(`
    UPDATE agent_messages
       SET delivery_attempts = 1, lease_expires_at = ?3
     WHERE tenant = ?1 AND id = ?2
       AND delivery_attempts = 0 AND lease_expires_at IS NULL AND read_at IS NULL AND dead_lettered_at IS NULL
       AND ${bearerFencePredicate('?1', '?4')}
       AND EXISTS (
         SELECT 1
           FROM task_dispatch_receipts dispatch
           JOIN tasks task ON task.id = dispatch.task_id
           JOIN agents caller ON caller.id = ?4 AND caller.status = 'active'
          WHERE dispatch.tenant = ?1 AND dispatch.id = ?5 AND dispatch.task_id = ?6
            AND dispatch.agent_id = ?4
            AND task.assignee_agent_id = ?4
       )
  `).bind(
    env.TENANT_SLUG, input.messageId, leaseExpiresAt, input.callerAgentId,
    input.dispatchReceiptId, input.taskId,
  ).run()
  return result.meta?.changes === 1
}

async function loadDelivery(
  env: Env,
  input: RecordTaskDispatchRuntimeReceiptInput,
  messageId: string,
  now: string,
): Promise<DeliveryRow> {
  const row = await env.DB.prepare(`
    SELECT
      dispatch.consumed_at AS dispatch_consumed_at,
      dispatch.agent_id AS dispatch_agent_id,
      dispatch.squad_id AS dispatch_squad_id,
      dispatch.project_id AS dispatch_project_id,
      task.status AS task_status,
      task.assignee_agent_id AS task_assignee_agent_id,
      task.squad_id AS task_squad_id,
      task.project_id AS task_project_id,
      task.done_when AS task_done_when,
      task.gate_owner AS task_gate_owner,
      agent.status AS agent_status,
      message.to_agent AS message_to_agent,
      message.from_agent AS message_from_agent,
      message.request_id AS message_request_id,
      message.project_id AS message_project_id,
      message.body AS message_body,
      message.read_at AS message_read_at,
      message.delivery_attempts AS message_delivery_attempts,
      message.lease_expires_at AS message_lease_expires_at,
      message.dead_lettered_at AS message_dead_lettered_at,
      CASE WHEN ${LEASE_LIVE_PREDICATE('message.lease_expires_at', '?5')} THEN 1 ELSE 0 END
        AS message_lease_live
    FROM task_dispatch_receipts dispatch
    JOIN tasks task ON task.id = dispatch.task_id
    JOIN agents agent ON agent.id = dispatch.agent_id
    JOIN agent_messages message ON message.id = ?1 AND message.tenant = dispatch.tenant
    WHERE dispatch.tenant = ?2 AND dispatch.id = ?3 AND dispatch.task_id = ?4
      AND dispatch.agent_id = task.assignee_agent_id
      AND dispatch.squad_id = task.squad_id
    LIMIT 1
  `).bind(messageId, env.TENANT_SLUG, input.dispatchReceiptId, input.taskId, now)
    .first<DeliveryRow>()
  if (!row) throw new TaskDispatchRuntimeReceiptError('runtime_delivery_not_found')
  return row
}

function validateEnvelope(
  row: DeliveryRow,
  input: RecordTaskDispatchRuntimeReceiptInput,
  allowAcknowledgedReplay: boolean,
): string {
  if (
    row.dispatch_consumed_at === null
    || row.agent_status !== 'active'
    || row.message_from_agent !== 'mupot-dispatch'
    || row.message_request_id !== `dispatch-inbox:${input.dispatchReceiptId}`
    || row.message_project_id !== row.task_project_id
    || row.dispatch_project_id !== row.task_project_id
    || row.message_dead_lettered_at !== null
    || row.message_delivery_attempts !== input.attempt
    // mupot#1494 v4 (P2, pre-existing at base 585f26cf:261-262) — this used to be a plain JS
    // `row.message_lease_expires_at <= now` string compare, the SAME fail-OPEN half of the
    // P0 defect class the reset tool's fail-CLOSED half was fixed for: `nowSqlUtc()`'s
    // space-separated `now` sorts BELOW an ISO `lease_expires_at` for any same-UTC-day
    // value, so an actually-expired lease read as still live and a stale settle went
    // through. `message_lease_live` is computed once, in SQL, via LEASE_LIVE_PREDICATE
    // (julianday both sides) in `loadDelivery` above — this function only reads the
    // already-correct answer.
    || (!allowAcknowledgedReplay && (
      row.message_read_at !== null
      || row.message_lease_live !== 1
    ))
  ) throw new TaskDispatchRuntimeReceiptError('runtime_delivery_stale')

  let parsed: unknown
  try { parsed = JSON.parse(row.message_body) } catch {
    throw new TaskDispatchRuntimeReceiptError('runtime_delivery_stale')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TaskDispatchRuntimeReceiptError('runtime_delivery_stale')
  }
  const body = parsed as Record<string, unknown>
  if (
    Object.keys(body).sort().join('\n') !== 'dispatch_receipt_id\nruntime_address\nsquad_id\ntask_id\ntype\nversion'
    || body.version !== 'runtime.dispatch/v1'
    || body.type !== 'task_dispatch'
    || body.task_id !== input.taskId
    || body.dispatch_receipt_id !== input.dispatchReceiptId
    || body.squad_id !== row.task_squad_id
    || body.runtime_address !== row.message_to_agent
  ) throw new TaskDispatchRuntimeReceiptError('runtime_delivery_stale')
  return row.message_to_agent
}

export async function recordTaskDispatchRuntimeReceipt(
  env: Env,
  auth: AuthContext,
  input: RecordTaskDispatchRuntimeReceiptInput,
  options: { origin?: 'mcp' | 'rest' } = {},
): Promise<{ receipt: PublicTaskDispatchRuntimeReceipt; task_status: string }> {
  const memberId = auth.memberId?.trim() ?? ''
  const credentialId = auth.tokenId?.trim() ?? ''
  const agentId = auth.boundAgentId?.trim() ?? ''
  if (
    auth.channel !== 'workspace' || auth.tenant !== env.TENANT_SLUG
    || memberId === '' || credentialId === '' || agentId === ''
  ) throw new TaskDispatchRuntimeReceiptError('agent_bound_workspace_credential_required')
  if (
    !STAGES.has(input.stage)
    || !Number.isInteger(input.attempt) || input.attempt < 1 || input.attempt > 5
    || !SHA256_RE.test(text(input.runtimeReceiptHash, 64))
  ) throw new TaskDispatchRuntimeReceiptError('runtime_receipt_invalid')
  text(input.taskId, 200); text(input.dispatchReceiptId, 200)
  // mupot#1494 round 2 (P1-a) — captured BEFORE resolution: true iff the caller used the
  // {task_id, dispatch_receipt_id} correlator (a task_list-only runner never has a raw
  // agent_messages id to pass — see resolveMessageId's doc comment).
  const usedPairCorrelator = !input.messageId
  // mupot#1494 — message_id is now OPTIONAL: a caller that only knows {task_id,
  // dispatch_receipt_id} (a task_list-polling runner — see resolveMessageId's doc comment)
  // resolves it here, once, and every use below (the delivery JOIN, the request digest, the
  // audit evidence, the stored receipt row) is consistent on the SAME resolved id regardless of
  // which correlator the caller actually supplied.
  const messageId = text(await resolveMessageId(env, input.dispatchReceiptId, input.messageId), 200)
  const artifactRefs = (input.artifactRefs ?? []).map((value) => text(value, 2000))
  if (artifactRefs.length > 20 || new Set(artifactRefs).size !== artifactRefs.length) {
    throw new TaskDispatchRuntimeReceiptError('runtime_receipt_invalid')
  }
  const artifactSha256 = optionalText(input.artifactSha256, 64)
  if (artifactSha256 !== null && !SHA256_RE.test(artifactSha256)) {
    throw new TaskDispatchRuntimeReceiptError('runtime_receipt_invalid')
  }
  const result = optionalText(input.result, 20_000)
  const reason = optionalText(input.reason, 2_000)
  if ((input.stage === 'completed' && result === null) || (input.stage === 'failed' && reason === null)) {
    throw new TaskDispatchRuntimeReceiptError('runtime_receipt_invalid')
  }
  const requestJson = canonicalJson({
    task_id: input.taskId,
    dispatch_receipt_id: input.dispatchReceiptId,
    message_id: messageId,
    stage: input.stage,
    runtime_receipt_hash: input.runtimeReceiptHash,
    attempt: input.attempt,
    artifact_refs: artifactRefs,
    artifact_sha256: artifactSha256,
    result,
    reason,
  })
  const requestDigest = await sha256Hex(requestJson)
  const replay = await env.DB.prepare(`
    SELECT * FROM task_dispatch_runtime_receipts
     WHERE tenant = ?1 AND dispatch_receipt_id = ?2 AND stage = ?3 AND attempt = ?4
  `).bind(env.TENANT_SLUG, input.dispatchReceiptId, input.stage, input.attempt).first<ReceiptRow>()

  // 0099: this is a credential gate on a WRITE path, so it consumes the one shared
  // liveness export rather than a hand-written copy. The copy this replaces compared
  // `expires_at > ?5` as TEXT against an ISO-shaped `now`, while member_tokens holds
  // BOTH 'YYYY-MM-DD HH:MM:SS' and ISO rows. 'T' (0x54) sorts above ' ' (0x20), so a
  // space-format token expiring later today compared as already dead — fail-closed,
  // but only by accident: harmonizing `now` to nowSqlUtc() (the obvious tidy-up)
  // would have flipped the same expression to fail-OPEN. TOKEN_LIVE_PREDICATE uses
  // julianday() on both sides and has no such orientation.
  const now = nowSqlUtc()
  const token = await env.DB.prepare(`
    SELECT t.id FROM member_tokens t
     WHERE t.id = ?1 AND t.member_id = ?2 AND t.agent_id = ?3 AND t.tenant = ?4
       AND t.channel = 'workspace'
       AND ${TOKEN_LIVE_PREDICATE('?5')}
  `).bind(credentialId, memberId, agentId, env.TENANT_SLUG, now).first<{ id: string }>()
  if (!token) throw new TaskDispatchRuntimeReceiptError('agent_bound_workspace_credential_required')

  // mupot#1494 round 2 (P1-a) — a task_list-only runner's message has never been leased; give
  // it the lease-equivalent atomically, once, so validateEnvelope below sees exactly the shape
  // a resident agent's inbox_lease() would have produced. See claimUnleasedForPairSettlement's
  // doc comment. Credential-gated: this runs only after the token check above succeeds.
  if (usedPairCorrelator && input.attempt === 1) {
    await claimUnleasedForPairSettlement(env, {
      messageId,
      dispatchReceiptId: input.dispatchReceiptId,
      taskId: input.taskId,
      callerAgentId: agentId,
    })
  }

  const delivery = await loadDelivery(env, input, messageId, now)
  if (delivery.dispatch_agent_id !== agentId || delivery.task_assignee_agent_id !== agentId) {
    throw new TaskDispatchRuntimeReceiptError('runtime_receipt_forbidden')
  }
  const grants = await resolveCapabilities(env, memberId)
  const assignee = await resolveTaskAssignee(env, agentId, delivery.task_squad_id)
  if (!(await canOnSquad(env, grants, delivery.task_squad_id, 'member')) || assignee.value !== agentId) {
    throw new TaskDispatchRuntimeReceiptError('runtime_receipt_forbidden')
  }
  const runtimeAddress = validateEnvelope(delivery, input, replay !== null)
  if (input.stage === 'completed' && !(await hasIndependentRuntimeGate(
    env,
    delivery.task_gate_owner,
    agentId,
    delivery.task_squad_id,
  ))) {
    throw new TaskDispatchRuntimeReceiptError('runtime_gate_required')
  }
  if (
    input.stage === 'completed'
    && (/Artifact:/i.test(delivery.task_done_when) || /SHA256:/i.test(delivery.task_done_when))
  ) {
    const verified = verifyTaskArtifactShape(result)
    if (
      !verified.verified
      || !artifactRefs.includes(verified.path)
      || artifactSha256 !== verified.sha256Claimed
    ) {
      throw new TaskDispatchRuntimeReceiptError('runtime_artifact_required')
    }
  }
  if (replay) {
    if (replay.request_digest !== requestDigest) {
      throw new TaskDispatchRuntimeReceiptError('runtime_receipt_conflict')
    }
    const task = await env.DB.prepare('SELECT status FROM tasks WHERE id = ?1')
      .bind(input.taskId).first<{ status: string }>()
    if (!task) throw new TaskDispatchRuntimeReceiptError('runtime_delivery_not_found')
    return { receipt: publicTimelineReceipt(replay), task_status: task.status }
  }

  const receiptId = crypto.randomUUID()
  const auditId = crypto.randomUUID()
  const requestId = `task-runtime-receipt:${input.dispatchReceiptId}:${input.stage}:${input.attempt}`
  const evidence = canonicalJson({
    dispatch_receipt_id: input.dispatchReceiptId,
    message_id: messageId,
    stage: input.stage,
    attempt: input.attempt,
    request_digest: requestDigest,
  })
  try {
    const mutation = input.stage === 'runtime_consumed'
      ? env.DB.prepare(`
          UPDATE tasks SET status = 'in_progress', execution_receipt_id = ?1,
            execution_claim_expires_at = NULL, updated_at = ?2
           WHERE id = ?3 AND assignee_agent_id = ?4
             AND status IN ('open', 'blocked', 'rejected')
             AND (execution_receipt_id IS NULL OR execution_receipt_id = ?1)
             AND NOT EXISTS (
               SELECT 1 FROM task_dispatch_runtime_receipts failed
                WHERE failed.tenant = ?5
                  AND failed.dispatch_receipt_id = ?1
                  AND failed.stage = 'failed'
             )
          RETURNING status
        `).bind(input.dispatchReceiptId, now, input.taskId, agentId, env.TENANT_SLUG)
      : input.stage === 'completed'
        ? env.DB.prepare(`
            UPDATE tasks SET status = 'review', result = ?1, updated_at = ?2
             WHERE id = ?3 AND assignee_agent_id = ?4
               AND status = 'in_progress' AND execution_receipt_id = ?5
               AND gate_owner IS NOT NULL
               AND gate_owner <> 'gate:agent-self-completion'
               AND EXISTS (
                 SELECT 1
                   FROM gate_grants grant_row
                   JOIN agents gate_agent
                     ON grant_row.principal_type = 'agent'
                    AND gate_agent.id = grant_row.principal_id
                    AND gate_agent.status = 'active'
                  WHERE grant_row.capability = tasks.gate_owner
                    AND gate_agent.id <> tasks.assignee_agent_id
                    AND EXISTS (
                      SELECT 1
                        FROM member_tokens t
                        JOIN members gate_member
                          ON gate_member.id = t.member_id AND gate_member.status = 'active'
                       WHERE t.agent_id = gate_agent.id
                         AND t.tenant = ?6
                         AND ${TOKEN_LIVE_PREDICATE('?8')}
                         AND (
                           EXISTS (
                             SELECT 1
                               FROM capabilities capability
                              WHERE capability.member_id = t.member_id
                                AND capability.capability IN ('member', 'lead', 'admin', 'owner')
                                AND (
                                  capability.scope_type = 'org'
                                  OR (
                                    capability.scope_type = 'squad'
                                    AND capability.scope_id = tasks.squad_id
                                  )
                                  OR (
                                    capability.scope_type = 'department'
                                    AND capability.scope_id = (
                                      SELECT task_squad.department_id
                                        FROM squads task_squad
                                       WHERE task_squad.id = tasks.squad_id
                                    )
                                  )
                                )
                           )
                           OR EXISTS (
                             SELECT 1
                               FROM channel_capability_grants channel_grant
                              WHERE channel_grant.member_id = t.member_id
                                AND channel_grant.squad_id = tasks.squad_id
                                AND channel_grant.capability IN ('member', 'lead', 'admin', 'owner')
                           )
                         )
                    )
               )
               AND EXISTS (
                 SELECT 1 FROM task_dispatch_runtime_receipts consumed
                  WHERE consumed.tenant = ?6
                    AND consumed.dispatch_receipt_id = ?5
                    AND consumed.stage = 'runtime_consumed'
                    AND consumed.attempt = ?7
               )
            RETURNING status
          `).bind(result, now, input.taskId, agentId, input.dispatchReceiptId,
            env.TENANT_SLUG, input.attempt, nowSqlUtc())
        : env.DB.prepare(`
            UPDATE tasks SET status = 'blocked', result = ?1, updated_at = ?2
             WHERE id = ?3 AND assignee_agent_id = ?4
               AND status IN ('open', 'in_progress', 'blocked', 'rejected')
               AND (execution_receipt_id IS NULL OR execution_receipt_id = ?5)
            RETURNING status
          `).bind(reason, now, input.taskId, agentId, input.dispatchReceiptId)
    await env.DB.batch([
      mutation,
      env.DB.prepare(`
        INSERT INTO mutation_audit_entries (
          id, tenant, principal_kind, principal_id, member_id, agent_id,
          credential_id, origin, handler, operation, target_kind, target_id,
          task_id, request_id, idempotency_key, evidence_json, recorded_at
        ) VALUES (
          ?1, ?2,
          CASE WHEN changes() = 1 THEN 'agent' ELSE 'invalid_runtime_receipt_transition' END,
          ?3, ?4, ?3, ?5, ?6, 'task_dispatch_runtime_receipt',
          ?7, 'task', ?8, ?8, ?9, ?9, ?10, ?11
        )
      `).bind(auditId, env.TENANT_SLUG, agentId, memberId, credentialId,
        options.origin ?? 'mcp', input.stage, input.taskId, requestId, evidence, now),
      env.DB.prepare(`
        INSERT INTO task_dispatch_runtime_receipts (
          id, tenant, dispatch_receipt_id, task_id, agent_id, message_id,
          member_id, credential_id, stage, attempt, runtime_address,
          runtime_receipt_hash, request_digest, artifact_refs_json,
          artifact_sha256, result, reason, audit_entry_id, created_at
        ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)
      `).bind(receiptId, env.TENANT_SLUG, input.dispatchReceiptId, input.taskId,
        agentId, messageId, memberId, credentialId, input.stage, input.attempt,
        runtimeAddress, input.runtimeReceiptHash, requestDigest, JSON.stringify(artifactRefs),
        artifactSha256, result, reason, auditId, now),
    ])
  } catch {
    throw new TaskDispatchRuntimeReceiptError('runtime_receipt_transition_conflict')
  }

  const persisted = await env.DB.prepare('SELECT * FROM task_dispatch_runtime_receipts WHERE id = ?1')
    .bind(receiptId).first<ReceiptRow>()
  const task = await env.DB.prepare('SELECT status FROM tasks WHERE id = ?1')
    .bind(input.taskId).first<{ status: string }>()
  if (!persisted || !task) throw new TaskDispatchRuntimeReceiptError('runtime_receipt_persistence_conflict')
  return { receipt: publicTimelineReceipt(persisted), task_status: task.status }
}

/** Cap applied to a rendered receipt text field. Matches the max length
 *  enforced at redemption time for a Telegram-onboarded display name
 *  (src/members/project-invites.ts's `isNonEmptyString` call for
 *  `input.display_name`), but that is not the only mint-time path into a
 *  field this function sanitizes — `members/index.ts`'s own
 *  `isNonEmptyString` helper (~line 87, used at its display_name check
 *  ~line 194) enforces no length cap at all, and a verdict `note` has no
 *  mint-time cap anywhere. This cap CAN and does truncate a value that was
 *  accepted as valid at mint time; it exists to bound what a single receipt
 *  can render, not to promise round-tripping of arbitrary mint-time input. */
const RECEIPT_TEXT_MAX_LENGTH = 200

/**
 * P2/WARN-2/WARN-3: `decided_by_display` (which can resolve to
 * `member.display_name`) and `verdict.note` can both be cosmetic,
 * user-supplied text with no server-side content validation — a
 * Telegram-onboarded member's own first_name/username threaded through by
 * redeemTelegramProjectInvite, or free-text typed by whoever decided a gate.
 * Both reach this receipt via a plain SQL projection with no escaping of
 * their own. Strip:
 *  - C0/C1 control characters (newlines, tabs, etc.) so a crafted value
 *    cannot inject fake extra lines/fields into any plain-text or
 *    line-oriented rendering of this receipt downstream (a dashboard
 *    summary, a forwarded Telegram message, a log line).
 *  - Unicode bidi control characters (U+202A-U+202E embedding/override,
 *    U+2066-U+2069 isolates), which can visually reorder or mask rendered
 *    text without changing its underlying characters.
 *  - Zero-width characters (U+200B-U+200F, U+2060 word joiner, U+FEFF
 *    BOM/ZWNBSP) and soft hyphen (U+00AD), which render as nothing (or as
 *    nothing until a line break) and can hide content or defeat exact-text
 *    matching between visible characters.
 * Combining marks are deliberately left untouched — they render as intended
 * accents/diacritics on the preceding character, not as an injection
 * vector. Applied here, at the render site, rather than at mint time, so it
 * covers every existing row regardless of when it was written.
 */
function sanitizeReceiptText(value: string): string {
  const stripped = value
    // eslint-disable-next-line no-control-regex -- deliberately stripping C0/C1 control chars, incl. newlines/tabs.
    .replace(/[\x00-\x1F\x7F-\x9F]/g, ' ')
    // Bidi embedding/override (U+202A-U+202E) and isolate (U+2066-U+2069)
    // controls, plus zero-width characters (U+200B-U+200F, U+2060 word
    // joiner, U+FEFF BOM/ZWNBSP) and soft hyphen (U+00AD). Written as
    // explicit \u escapes, never as literal glyphs, so the source stays
    // reviewable and can't itself be corrupted by the very characters it
    // strips.
    .replace(/[\u200B-\u200F\u2060\uFEFF\u00AD\u202A-\u202E\u2066-\u2069]/g, '')
    .trim()
  const collapsed = stripped.replace(/\s+/g, ' ')
  return collapsed.length > RECEIPT_TEXT_MAX_LENGTH
    ? collapsed.slice(0, RECEIPT_TEXT_MAX_LENGTH)
    : collapsed
}

export interface TaskDispatchReceiptTimeline {
  transport: Array<{
    agent_slug: string
    agent_name: string
    dispatched_at: string
    transport_delivered_at: string | null
  }>
  runtime: PublicTaskDispatchRuntimeReceipt[]
  gate: Array<{
    verdict: 'approved' | 'rejected'
    note: string | null
    decided_by_display: string
    decided_at: string
    // decided_via / origin_agent_display (0155, mupot#1425 P2-7,
    // kasra-review: "decided_via/origin_agent_id have no reader... an
    // operator reviewing history sees the member approved it, with nothing
    // saying an agent's harness asserted it"). Both null for every ordinary
    // verdict; set only for a harness-attested-origin decision
    // (src/im/origin-verdict.ts) — decided_via names the write path,
    // origin_agent_display names the CALLING agent whose harness vouched
    // for the origin (which may differ from decided_by, the member).
    decided_via: 'agent_attested_origin' | null
    origin_agent_display: string | null
  }>
  task_status: string
}

export async function listTaskDispatchReceiptTimeline(
  env: Env,
  taskId: string,
  limit = 20,
): Promise<TaskDispatchReceiptTimeline> {
  const boundedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 20
  const task = await env.DB.prepare('SELECT status FROM tasks WHERE id = ?1 LIMIT 1')
    .bind(taskId).first<{ status: string }>()
  if (!task) throw new TaskDispatchRuntimeReceiptError('runtime_delivery_not_found')
  const transport = await env.DB.prepare(`
    SELECT agent.slug AS agent_slug, agent.name AS agent_name,
           dispatch.created_at AS dispatched_at,
           dispatch.consumed_at AS transport_delivered_at
      FROM task_dispatch_receipts dispatch
      JOIN agents agent ON agent.id = dispatch.agent_id
     WHERE dispatch.tenant = ?1 AND dispatch.task_id = ?2
     ORDER BY dispatch.created_at, dispatch.id
     LIMIT ?3
  `).bind(env.TENANT_SLUG, taskId, boundedLimit).all<{
    agent_slug: string
    agent_name: string
    dispatched_at: string
    transport_delivered_at: string | null
  }>()
  const runtime = await env.DB.prepare(`
    SELECT * FROM task_dispatch_runtime_receipts
     WHERE tenant = ?1 AND task_id = ?2
     ORDER BY created_at,
       CASE stage WHEN 'runtime_consumed' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END,
       id
     LIMIT ?3
  `).bind(env.TENANT_SLUG, taskId, boundedLimit).all<ReceiptRow>()
  const gate = await env.DB.prepare(`
    SELECT verdict.verdict, verdict.note,
           COALESCE(NULLIF(agent.name, ''), NULLIF(member.display_name, ''), 'Independent gate')
             AS decided_by_display,
           verdict.decided_at,
           verdict.decided_via,
           NULLIF(origin_agent.name, '') AS origin_agent_display
      FROM task_verdicts verdict
      LEFT JOIN agents agent ON agent.id = verdict.decided_by
      LEFT JOIN members member ON member.id = verdict.decided_by
      LEFT JOIN agents origin_agent ON origin_agent.id = verdict.origin_agent_id
     WHERE verdict.task_id = ?1
     ORDER BY verdict.decided_at, verdict.id
     LIMIT ?2
  `).bind(taskId, boundedLimit).all<{
    verdict: 'approved' | 'rejected'
    note: string | null
    decided_by_display: string
    decided_at: string
    decided_via: 'agent_attested_origin' | null
    origin_agent_display: string | null
  }>()
  return {
    transport: transport.results ?? [],
    runtime: (runtime.results ?? []).map(publicTimelineReceipt),
    gate: (gate.results ?? []).map((row) => ({
      ...row,
      note: row.note === null ? null : sanitizeReceiptText(row.note),
      decided_by_display: sanitizeReceiptText(row.decided_by_display),
      origin_agent_display: row.origin_agent_display === null ? null : sanitizeReceiptText(row.origin_agent_display),
    })),
    task_status: task.status,
  }
}

// ── operator lease repair (mupot#1494 round 3 — Athena's RECORD INTEGRITY ruling) ──────────
//
// The P0 fix above (claimUnleasedForPairSettlement) makes the round-2 wedge attack impossible
// going forward: a non-owner's claim now changes zero rows. This section is the RECOVERY path
// for the shape of damage that attack (or any other cause of a stuck lease / desynchronised
// delivery_attempts counter) leaves behind — a receipted, org-admin-only repair, never a
// silent DB patch.

export type AdminResetDispatchLeaseCode =
  | 'reset'
  | 'reset_refused_terminal'
  | 'reset_not_found'
  | 'reset_refused_lease_live'
  | 'reset_refused_task_mismatch'
  // mupot#1494 v4 (P1-a) — `terminate: true` needs a real member_tokens-bound credential to
  // anchor the new task_dispatch_runtime_receipts row to (NOT NULL, FK'd). A directory-OAuth
  // org-admin session with no live bearer token (auth.tokenId absent) can still perform an
  // ordinary reset, but not a terminating one — refused outright, receipted, zero side
  // effects, rather than silently downgrading `terminate: true` to a no-op or crashing on
  // the FK at insert time.
  | 'reset_refused_credential_required'

export interface AdminResetDispatchLeaseResult {
  /** True iff the row was reset to pristine. False means "not found", "refused" (already
   *  consumed or dead-lettered, a live lease with no override, a task_id mismatch, or
   *  `terminate: true` with no usable credential) — never a side effect either way when
   *  false. */
  reset: boolean
  code: AdminResetDispatchLeaseCode
  message_id: string | null
  audit_id: string
  /** True iff this reset stole a LIVE, unexpired lease under an explicit `override`. The
   *  prior holder's state is in the audit receipt's `override_of`, never lost. */
  overrode: boolean
  /** Present only when `code === 'reset_refused_lease_live'` — who holds it and until when. */
  lease_live?: { holder: string; lease_expires_at: string; delivery_attempts: number }
  /** mupot#1494 v4 (P1-a) — true iff, after this call, a TERMINAL task_dispatch_runtime_receipts
   *  row (`hasInFlightDispatchReceipt`'s own terminal set) exists for this dispatch — either
   *  because this call just wrote one (`terminate: true` on a successful reset) or because one
   *  already existed (idempotent: a second `terminate: true` call never writes a duplicate).
   *  Always false when `terminate` was not requested or the reset itself did not happen. */
  terminated: boolean
}

/**
 * adminResetDispatchLease — reset a wedged agent_messages row's delivery bookkeeping
 * (`delivery_attempts`, `lease_expires_at`, `lease_attempt_id`) back to PRISTINE
 * (`0`/`NULL`/`NULL`) — the exact state a fresh, never-delivered dispatch starts in — so the
 * assignee's next `attempt: 1` settle (via `inbox_lease` OR the `{task_id,
 * dispatch_receipt_id}` pair correlator) proceeds exactly as if the message had just been
 * delivered. Refuses (0 rows, `reset: false`) once the row is `read_at` (already consumed) or
 * `dead_lettered_at` (already terminally failed) — this is a lease/attempt REPAIR, never an
 * un-delete or a bypass of a genuine terminal state.
 *
 * mupot#1494 v4 (P0 successor, adversarial round 2 on PR #1514) — the LIVENESS check above
 * used to be `message.lease_expires_at > now` with `now = nowSqlUtc()` ('YYYY-MM-DD HH:MM:SS',
 * no `T`, no ms) compared as a JS STRING against `lease_expires_at`, which every writer
 * (`src/agents/messages.ts`) stamps as `new Date().toISOString()`. `'T'` (0x54) sorts above
 * `' '` (0x20), so for ANY same-UTC-day value the ISO string always compared greater — every
 * same-day EXPIRED lease read as LIVE. PROVED: an expired-60s-ago lease refused with
 * `reset_refused_lease_live` naming a holder that held nothing; the only workaround
 * (`override: true`) then wrote a FALSE `override_of` audit record. This file warned about
 * exactly this hazard 400 lines above (`TOKEN_LIVE_PREDICATE`'s doc comment) before round 2
 * reintroduced the same pattern in the same file. Fixed: liveness is now computed by
 * `LEASE_LIVE_PREDICATE` (`julianday()` on both sides, src/agents/messages.ts) — ONE
 * predicate, format-agnostic, shared with `validateEnvelope` and `leaseAvailableClause`.
 *
 * mupot#1494 round 3 (P1-A, adversarial round 2) — a row can ALSO be wedged while a
 * legitimate resident holds a genuinely LIVE, unexpired lease on it (mid-flight, not stuck
 * at all from that holder's point of view). Resetting THAT unconditionally is its own new
 * defect: the row goes pristine, a second `inbox_lease` hands the same dispatch to a
 * DIFFERENT consumer, and the original holder's eventual settle fails
 * `runtime_delivery_stale` — the repair tool would have manufactured the exact
 * double-processing wedge it exists to fix. So: a live, unexpired lease (not already
 * consumed/dead-lettered) refuses by default with a typed `reset_refused_lease_live`,
 * carrying the current holder (`to_agent`) and its expiry — an operator who has confirmed
 * the holder is actually gone (crashed, never going to settle) can pass `override: true` to
 * proceed anyway; the PRIOR lease state (holder, attempts, expiry, attempt id) is written
 * into the audit receipt's `override_of` as an explicit, visible override, never silently
 * discarded.
 *
 * mupot#1494 v4 (P2, adversarial round 2) — the WRITE itself now re-checks liveness FRESH,
 * INSIDE the UPDATE's own `WHERE`, via two mutually exclusive, individually-guarded attempts
 * (`NOT (live)` first; only on its failure, and only under `override`, `(live)`) rather than
 * trusting the earlier SELECT's snapshot. Before this, a legitimate consumer could lease the
 * row in the window between the liveness check and the write, and a non-override reset would
 * silently wipe that genuinely-live lease anyway. Each attempt's own success is therefore
 * PROOF of which case actually held at write time — `overrode` is never a guess.
 *
 * mupot#1494 v4 (P1-a, Athena's ruling) — `terminate: true` additionally writes a REAL
 * terminal disposition (`task_dispatch_runtime_receipts.stage = 'reset_terminated'`,
 * carrying the prior lease state + the acting principal) alongside a successful reset, so
 * `hasInFlightDispatchReceipt` sees the dispatch as settled — without this, a reset (even
 * `override: true`) left `task_update`'s reassignment guard AND `task_dispatch`'s own
 * in-flight guard believing the dispatch was still mid-flight forever: reassignment refused
 * 409, unassignment refused 409, and (PROVED) a FRESH `task_dispatch` succeeded anyway,
 * contradicting `toolTaskDispatch`'s own documented `task_not_dispatchable` guard and
 * reopening the exact orphaned-dispatch class P2-5 exists to close. Idempotent: a dispatch
 * that already carries ANY terminal receipt (`completed`/`failed`/`reset_terminated`) gets
 * no duplicate row (`INSERT ... WHERE NOT EXISTS`), so calling `terminate: true` twice, or
 * on a dispatch a runner already genuinely completed, is always a safe no-op on that count.
 *
 * mupot#1494 round 3 (P2-4) — `input.taskId` is validated against the dispatch receipt's
 * OWN `task_id` before anything else: a mismatch is refused (`reset_refused_task_mismatch`,
 * receipted, zero side effects) rather than silently resetting a lease under the wrong
 * task's authority. The audit receipt's `principal_kind`/`agent_id` reflect the ACTUAL
 * calling principal (an agent-bound token shows as `'agent'` with its real `agent_id`) —
 * never hardcoded to `'member'` regardless of who really called. Every call — found or not,
 * reset or refused, override or not — writes exactly one `mutation_audit_entries` row.
 *
 * Callers MUST have already verified authority (see `toolTaskDispatchLeaseReset`'s
 * org:admin + operator-principal checks) — this function does not re-check authority, only
 * records who acted.
 */
export async function adminResetDispatchLease(
  env: Env,
  auth: AuthContext,
  input: { taskId: string; dispatchReceiptId: string; reason: string; override?: boolean; terminate?: boolean },
): Promise<AdminResetDispatchLeaseResult> {
  const memberId = auth.memberId?.trim() ?? ''
  const credentialId = auth.tokenId?.trim() ?? ''
  // P2-4: actor-faithful — an agent-bound token is receipted as the agent that actually
  // acted, never masked as a bare member action.
  const agentId = auth.boundAgentId?.trim() || null
  const override = input.override === true
  const terminate = input.terminate === true
  const auditId = crypto.randomUUID()
  const now = nowSqlUtc()

  const evidence = (extra: Record<string, unknown> = {}): string => canonicalJson({
    task_id: input.taskId,
    dispatch_receipt_id: input.dispatchReceiptId,
    // P2 (sanitized before evidence_json — same class this file's own WARN-3 tests pin for
    // display_name/verdict.note; an operator-supplied `reason` is free text with no
    // server-side content validation upstream of this write).
    reason: sanitizeReceiptText(text(input.reason, 500)),
    override,
    terminate,
    ...extra,
  })

  const writeAudit = async (operation: string, targetKind: string, targetId: string, evidenceJson: string): Promise<void> => {
    await env.DB.prepare(`
      INSERT INTO mutation_audit_entries (
        id, tenant, principal_kind, principal_id, member_id, agent_id,
        credential_id, origin, handler, operation, target_kind, target_id,
        task_id, request_id, idempotency_key, evidence_json, recorded_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6,
        ?7, 'mcp', 'task_dispatch_lease_reset', ?8, ?9, ?10,
        ?11, ?12, ?12, ?13, ?14
      )
    `).bind(
      auditId, env.TENANT_SLUG,
      agentId ? 'agent' : 'member', agentId ?? memberId, memberId, agentId,
      credentialId, operation, targetKind, targetId,
      input.taskId, `lease-reset:${input.dispatchReceiptId}:${auditId}`, evidenceJson, now,
    ).run()
  }

  // P2-4: taskId must match the dispatch's OWN task before any read/write on the message.
  // Also fetches `agent_id` now — needed only for `terminate: true`'s receipt row, but
  // cheap to carry from this same SELECT rather than a second round trip later.
  const dispatch = await env.DB.prepare(
    `SELECT task_id, agent_id FROM task_dispatch_receipts WHERE tenant = ?1 AND id = ?2 LIMIT 1`,
  ).bind(env.TENANT_SLUG, input.dispatchReceiptId).first<{ task_id: string; agent_id: string }>()
  if (!dispatch) {
    await writeAudit('reset_not_found', 'dispatch_receipt', input.dispatchReceiptId, evidence())
    return { reset: false, code: 'reset_not_found', message_id: null, audit_id: auditId, overrode: false, terminated: false }
  }
  if (dispatch.task_id !== input.taskId) {
    await writeAudit(
      'reset_refused_task_mismatch', 'dispatch_receipt', input.dispatchReceiptId,
      evidence({ actual_task_id: dispatch.task_id }),
    )
    return {
      reset: false, code: 'reset_refused_task_mismatch', message_id: null, audit_id: auditId,
      overrode: false, terminated: false,
    }
  }

  // mupot#1494 v4 (P1-a) — `terminate: true` needs a real credential to anchor the new
  // task_dispatch_runtime_receipts row to (NOT NULL, FK'd to member_tokens). Refused
  // up front, before any read/write on the message, so this is zero-side-effect like every
  // other refusal here.
  if (terminate && credentialId === '') {
    await writeAudit('reset_refused_credential_required', 'dispatch_receipt', input.dispatchReceiptId, evidence())
    return {
      reset: false, code: 'reset_refused_credential_required', message_id: null, audit_id: auditId,
      overrode: false, terminated: false,
    }
  }

  interface MessageRow {
    id: string
    delivery_attempts: number
    lease_expires_at: string | null
    lease_attempt_id: string | null
    read_at: string | null
    dead_lettered_at: string | null
    to_agent: string
    lease_live: number
  }
  const loadMessage = (): Promise<MessageRow | null> => env.DB.prepare(`
    SELECT id, delivery_attempts, lease_expires_at, lease_attempt_id, read_at, dead_lettered_at, to_agent,
           CASE WHEN read_at IS NULL AND dead_lettered_at IS NULL
                     AND ${LEASE_LIVE_PREDICATE('lease_expires_at', '?3')}
                THEN 1 ELSE 0 END AS lease_live
      FROM agent_messages WHERE tenant = ?1 AND from_agent = 'mupot-dispatch' AND request_id = ?2 LIMIT 1
  `).bind(env.TENANT_SLUG, dispatchInboxRequestId(input.dispatchReceiptId), now).first<MessageRow>()

  const message = await loadMessage()
  if (!message) {
    await writeAudit('reset_not_found', 'dispatch_receipt', input.dispatchReceiptId, evidence())
    return { reset: false, code: 'reset_not_found', message_id: null, audit_id: auditId, overrode: false, terminated: false }
  }

  // P1-A / P0 successor: a LIVE, unexpired lease (julianday-computed — see doc comment
  // above) on a row that is neither consumed nor dead-lettered is a genuinely in-flight
  // hand-out, not a wedge — refuse unless explicitly overridden.
  if (message.lease_live === 1 && !override) {
    await writeAudit('reset_refused_lease_live', 'agent_message', message.id, evidence({
      holder: message.to_agent,
      lease_expires_at: message.lease_expires_at,
      delivery_attempts: message.delivery_attempts,
    }))
    return {
      reset: false, code: 'reset_refused_lease_live', message_id: message.id, audit_id: auditId,
      overrode: false, terminated: false,
      lease_live: {
        holder: message.to_agent,
        lease_expires_at: message.lease_expires_at as string,
        delivery_attempts: message.delivery_attempts,
      },
    }
  }

  // mupot#1494 v4 (P2) — attempt 1: succeeds ONLY if the lease is NOT live, freshly
  // re-evaluated at write time (not the earlier SELECT's snapshot). Its success is proof the
  // row was not live — `overrode` can never be wrongly true out of this branch.
  const notLiveAttempt = await env.DB.prepare(`
    UPDATE agent_messages
       SET delivery_attempts = 0, lease_expires_at = NULL, lease_attempt_id = NULL
     WHERE tenant = ?1 AND id = ?2 AND read_at IS NULL AND dead_lettered_at IS NULL
       AND NOT (${LEASE_LIVE_PREDICATE('lease_expires_at', '?3')})
  `).bind(env.TENANT_SLUG, message.id, now).run()

  let reset = notLiveAttempt.meta?.changes === 1
  let overrode = false
  let overriddenHolder: { to_agent: string; delivery_attempts: number; lease_expires_at: string | null; lease_attempt_id: string | null } | null = null

  if (!reset && override) {
    // Re-read immediately before the override attempt — narrows (does not fully eliminate;
    // no plain UPDATE can see its own pre-image for columns it overwrites) the window
    // between "what override_of describes" and "what was actually overridden". The WRITE
    // itself is still fully race-safe: attempt 2's own WHERE re-checks liveness fresh.
    const fresh = await loadMessage()
    if (fresh && fresh.read_at === null && fresh.dead_lettered_at === null) {
      // Attempt 2: succeeds ONLY if the lease IS live, freshly re-evaluated at write time.
      // Its success is proof the row WAS live — override_of never names a holder that held
      // nothing, because this branch cannot fire unless the guard just proved otherwise.
      const liveOverrideAttempt = await env.DB.prepare(`
        UPDATE agent_messages
           SET delivery_attempts = 0, lease_expires_at = NULL, lease_attempt_id = NULL
         WHERE tenant = ?1 AND id = ?2 AND read_at IS NULL AND dead_lettered_at IS NULL
           AND ${LEASE_LIVE_PREDICATE('lease_expires_at', '?3')}
      `).bind(env.TENANT_SLUG, message.id, now).run()
      reset = liveOverrideAttempt.meta?.changes === 1
      overrode = reset
      if (reset) {
        overriddenHolder = {
          to_agent: fresh.to_agent,
          delivery_attempts: fresh.delivery_attempts,
          lease_expires_at: fresh.lease_expires_at,
          lease_attempt_id: fresh.lease_attempt_id,
        }
      }
    }
  }

  await writeAudit(
    reset ? (overrode ? 'reset_override' : 'reset') : 'reset_refused_terminal',
    'agent_message',
    message.id,
    overrode && overriddenHolder
      ? evidence({
          override_of: {
            holder: overriddenHolder.to_agent,
            delivery_attempts: overriddenHolder.delivery_attempts,
            lease_expires_at: overriddenHolder.lease_expires_at,
            lease_attempt_id: overriddenHolder.lease_attempt_id,
          },
        })
      : evidence(),
  )

  let terminated = false
  if (reset && terminate) {
    // mupot#1494 v4 (P1-a) — idempotent: WHERE NOT EXISTS means a dispatch that already
    // carries ANY terminal receipt (a genuine completed/failed settle, or an earlier
    // `terminate: true` call) gets no duplicate row.
    const terminateReceiptId = crypto.randomUUID()
    const runtimeReceiptHash = await sha256Hex(canonicalJson({ kind: 'reset_terminated', audit_id: auditId, message_id: message.id }))
    const requestDigest = await sha256Hex(canonicalJson({
      operation: 'reset_terminated', dispatch_receipt_id: input.dispatchReceiptId, audit_id: auditId,
    }))
    const attempt = Math.min(5, Math.max(1, message.delivery_attempts || 1))
    await env.DB.prepare(`
      INSERT INTO task_dispatch_runtime_receipts (
        id, tenant, dispatch_receipt_id, task_id, agent_id, message_id,
        member_id, credential_id, stage, attempt, runtime_address,
        runtime_receipt_hash, request_digest, artifact_refs_json,
        artifact_sha256, result, reason, audit_entry_id, created_at
      )
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'reset_terminated', ?9, ?10, ?11, ?12, '[]', NULL, NULL, ?13, ?14, ?15
       WHERE NOT EXISTS (
         SELECT 1 FROM task_dispatch_runtime_receipts existing
          WHERE existing.tenant = ?2 AND existing.dispatch_receipt_id = ?3
            AND existing.stage IN (${TERMINAL_RUNTIME_RECEIPT_STAGES_SQL})
       )
    `).bind(
      terminateReceiptId, env.TENANT_SLUG, input.dispatchReceiptId, input.taskId, dispatch.agent_id, message.id,
      memberId, credentialId, attempt, message.to_agent, runtimeReceiptHash, requestDigest,
      sanitizeReceiptText(text(input.reason, 500)), auditId, now,
    ).run()
    terminated = true
  } else if (terminate) {
    // reset did not happen — check whether the dispatch is ALREADY terminal for some other
    // reason (e.g. a runner genuinely completed/failed it), so the caller isn't told
    // "not terminated" about a dispatch that plainly is.
    const existingTerminal = await env.DB.prepare(`
      SELECT 1 FROM task_dispatch_runtime_receipts
       WHERE tenant = ?1 AND dispatch_receipt_id = ?2 AND stage IN (${TERMINAL_RUNTIME_RECEIPT_STAGES_SQL})
       LIMIT 1
    `).bind(env.TENANT_SLUG, input.dispatchReceiptId).first<{ 1: number }>()
    terminated = existingTerminal !== null
  }

  return {
    reset,
    code: reset ? 'reset' : 'reset_refused_terminal',
    message_id: message.id,
    audit_id: auditId,
    overrode,
    terminated,
  }
}
