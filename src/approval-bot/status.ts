// Read/notice companion for elevation cards. It decides nothing and grants no authority.
import type { Env } from '../types'
import type { ElevationRequestRecord } from '../auth/elevation'
import { SWEEPER_SENDER } from '../agents/system-senders'

export const APPROVAL_NOTICE_BATCH_LIMIT = 25
export const APPROVAL_NOTICE_LOOKBACK_MS = 24 * 60 * 60 * 1000

export function effectiveApprovalStatus(req: ElevationRequestRecord, nowMs = Date.now()): ElevationRequestRecord['status'] {
  return req.status === 'pending' && Date.parse(req.decision_expires_at) <= nowMs ? 'expired' : req.status
}

/** Target comes only from the canonical, tenant-scoped request, never Telegram text. */
export async function notifyApprovalRequester(env: Env, req: ElevationRequestRecord, event: string, nowMs = Date.now()): Promise<boolean> {
  if (req.tenant !== env.TENANT_SLUG) return false
  const deadline = Date.parse(req.decision_expires_at)
  if (event === 'expired' && (!Number.isFinite(deadline) || deadline < nowMs - APPROVAL_NOTICE_LOOKBACK_MS || deadline > nowMs)) return true
  try {
    const offered = await env.DB.prepare('SELECT 1 AS offered FROM approval_bot_deliveries WHERE request_id = ?1 AND tenant = ?2 LIMIT 1').bind(req.id, req.tenant).first()
    if (!offered) return true // Not an approval-bot request: other channels keep their own notices.
    const notice = event === 'expired'
      ? 'This elevation request expired without a decision. No approval was granted. File a new request if it is still needed.'
      : event === 'denied'
        ? 'The human denied this elevation request. No approval was granted.'
        : 'The approval bot could not apply this tap or command. Check elevation_status for the current request state and ask the intended approver to retry if needed.'
    // Lazy import keeps the common elevation read path out of the messaging/bus initialization cycle.
    const { sendAgentMessage } = await import('../agents/messages')
    const sent = await sendAgentMessage(env, {
      fromAgent: SWEEPER_SENDER, fromMember: 'system:approval-bot', toAgent: req.agent_id,
      kind: 'message', requestId: `approval-bot:${req.id}:${event}`,
      body: JSON.stringify({ type: 'elevation_approval_bot', request_id: req.id, event, notice }),
    }, { system: true, reason: 'informational status for the requester agent read from the tenant-scoped elevation row' })
    return sent.ok
  } catch {
    return false // A read remains truthful; a later read/tap retries the durable notice.
  }
}

/** Repair the stored pending state before returning it. The second read observes a competing decision/renewal. */
export async function reconcileApprovalBotRequestRead(env: Env, req: ElevationRequestRecord, nowMs = Date.now()): Promise<ElevationRequestRecord | null> {
  let current = req
  if (req.status === 'pending' && effectiveApprovalStatus(req, nowMs) === 'expired') {
    try {
      await env.DB.prepare(`UPDATE elevation_requests SET status = 'expired'
        WHERE id = ?1 AND tenant = ?2 AND status = 'pending' AND decision_expires_at <= ?3`)
        .bind(req.id, req.tenant, new Date(nowMs).toISOString()).run()
    } catch { /* read-only callers still get the effective state below */ }
    const latest = await env.DB.prepare(`SELECT status, decision_expires_at, decided_at, decided_by_member_id, decided_by_web_session_hash, decision_note
      FROM elevation_requests WHERE id = ?1 AND tenant = ?2 LIMIT 1`).bind(req.id, req.tenant).first<Pick<ElevationRequestRecord, 'status' | 'decision_expires_at' | 'decided_at' | 'decided_by_member_id' | 'decided_by_web_session_hash' | 'decision_note'>>()
    if (!latest) return null
    current = { ...req, ...latest }
  }
  const view = { ...current, status: effectiveApprovalStatus(current, nowMs) }
  if (view.status === 'expired' && view.decided_at === null) await notifyApprovalRequester(env, view, 'expired', nowMs)
  return view
}

/** Existing expiry reads provide a bounded, replay-safe notification opportunity; no new cron. */
export async function notifyLapsedApprovalBotRequests(env: Env, tenant: string, nowMs = Date.now()): Promise<number> {
  if (tenant !== env.TENANT_SLUG) return 0
  try {
    const rows = await env.DB.prepare(`SELECT r.* FROM elevation_requests r
      WHERE r.tenant = ?1 AND r.status = 'expired' AND r.decided_at IS NULL AND r.decision_expires_at <= ?2 AND r.decision_expires_at >= ?5
        AND EXISTS (SELECT 1 FROM approval_bot_deliveries d WHERE d.request_id = r.id AND d.tenant = r.tenant)
        AND NOT EXISTS (SELECT 1 FROM agent_messages m WHERE m.tenant = r.tenant AND m.from_agent = ?3 AND m.request_id = 'approval-bot:' || r.id || ':expired')
      ORDER BY r.decision_expires_at, r.id LIMIT ?4`)
      .bind(tenant, new Date(nowMs).toISOString(), SWEEPER_SENDER, APPROVAL_NOTICE_BATCH_LIMIT, new Date(nowMs - APPROVAL_NOTICE_LOOKBACK_MS).toISOString()).all<ElevationRequestRecord>()
    let sent = 0
    for (const req of rows.results ?? []) if (await notifyApprovalRequester(env, req, 'expired', nowMs)) sent++
    return sent
  } catch {
    return 0
  }
}
