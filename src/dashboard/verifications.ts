// src/dashboard/verifications.ts — latest verdict per task (gate receipt log).
//
// PURE READ + PRESENTATION (no mutation, no new write routes, no new authority).
//
// Visibility rule (Codex condition 3 — mirrors approvals.ts):
//   - owner / admin : every verdict
//   - everyone else : only verdicts on tasks where the caller is the assignee_agent_id
//                     OR has an explicit gate_grants row for the task's gate_owner
//
// Latest-verdict semantics: for each task_id, we keep only the row with the
// largest decided_at. A task whose timeline is approved → rejected shows as
// rejected.  We derive this with a correlated sub-select that picks MAX(decided_at)
// per task_id — SQLite has no DISTINCT ON; a window function via CTE is supported
// but the sub-select is simpler and indexed by (task_id).

import type { Env, AuthContext } from '../types'
import type { AthenaGateReceipt } from '../athena/webhook'
import {
  pageHeader,
  dataTable,
  pill,
  emptyState,
  sectionPanel,
  type Tone,
} from './ui'
import type { HtmlEscapedString } from 'hono/utils/html'
import { html } from 'hono/html'

// ── types ─────────────────────────────────────────────────────────────────────

export interface VerificationItem {
  /** task_verdicts.id of the latest verdict row */
  verdict_id: string
  task_id: string
  task_title: string
  squad_name: string | null
  verdict: 'approved' | 'rejected'
  decided_by: string
  decided_at: string
  note: string | null
}

// ── visibility helper ─────────────────────────────────────────────────────────

function isOwnerAdmin(auth: AuthContext): boolean {
  return auth.role === 'owner' || auth.role === 'admin'
}

// ── data loader ───────────────────────────────────────────────────────────────

/**
 * Load the LATEST verdict for each task the caller may see.
 *
 * Visibility:
 *   owner/admin → all tasks that have at least one verdict
 *   others      → only tasks where the caller is assignee_agent_id, OR
 *                 has a gate_grants row matching the task's gate_owner
 */
export async function loadVerifications(
  env: Env,
  auth: AuthContext,
): Promise<VerificationItem[]> {
  // Latest-verdict CTE: for each task_id pick the verdict whose decided_at is
  // the maximum.  Using a correlated sub-select that is covered by the existing
  // task_verdicts_task_id index.
  const LATEST_VERDICT_CTE = `
    WITH latest AS (
      SELECT v.*
        FROM task_verdicts v
       WHERE v.decided_at = (
         SELECT MAX(v2.decided_at)
           FROM task_verdicts v2
          WHERE v2.task_id = v.task_id
       )
    )`

  const BASE_SELECT = `
    ${LATEST_VERDICT_CTE}
    SELECT
      v.id          AS verdict_id,
      v.task_id,
      t.title       AS task_title,
      s.name        AS squad_name,
      v.verdict,
      v.decided_by,
      v.decided_at,
      v.note
    FROM latest v
    JOIN tasks t  ON t.id = v.task_id
    LEFT JOIN squads s ON s.id = t.squad_id`

  if (isOwnerAdmin(auth)) {
    const rs = await env.DB.prepare(
      `${BASE_SELECT} ORDER BY v.decided_at DESC`,
    ).all<VerificationItem>()
    return rs.results ?? []
  }

  // Non-admin: visibility mirrors approvals.ts gate_grants scoping.
  // The principal may be a member OR an agent-bound token.
  const principalId = auth.memberId ?? auth.userId
  const principalType: 'member' | 'agent' = auth.memberId ? 'member' : 'agent'
  if (!principalId) return []

  const rs = await env.DB.prepare(
    `${BASE_SELECT}
     WHERE (
       t.assignee_agent_id = ?1
       OR (
         t.gate_owner IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM gate_grants g
            WHERE g.capability     = t.gate_owner
              AND g.principal_type = ?2
              AND g.principal_id   = ?1
         )
       )
     )
     ORDER BY v.decided_at DESC`,
  )
    .bind(principalId, principalType)
    .all<VerificationItem>()
  return rs.results ?? []
}

// ── body renderer ─────────────────────────────────────────────────────────────

function fmtWhen(iso: string): string {
  // ISO-8601 → "YYYY-MM-DD HH:MM UTC" — safe for any input, fallback to raw
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    const y = d.getUTCFullYear()
    const mo = String(d.getUTCMonth() + 1).padStart(2, '0')
    const dy = String(d.getUTCDate()).padStart(2, '0')
    const h = String(d.getUTCHours()).padStart(2, '0')
    const m = String(d.getUTCMinutes()).padStart(2, '0')
    return `${y}-${mo}-${dy} ${h}:${m} UTC`
  } catch {
    return iso
  }
}

/**
 * Render the Verifications page body.
 *
 * Uses only ui.ts primitives — all string inputs are auto-escaped by the `html`
 * tagged template.  pill() receives literal strings only.
 */
export function verificationsBody(items: VerificationItem[]): HtmlEscapedString {
  const header = pageHeader({
    title: 'Verifications',
    sub: 'Latest gate decision per task, plus recent Athena PR gate audits.',
  })

  if (items.length === 0) {
    return html`${header}${emptyState({
      title: 'No verdicts yet',
      detail: 'Gate decisions will appear here once a task has been approved or rejected.',
    })}` as HtmlEscapedString
  }

  // Each cell is produced by `html` tagged template or a ui.ts primitive. Both
  // return HtmlEscapedString synchronously (no async template expressions here),
  // but Hono's type signature is `HtmlEscapedString | Promise<HtmlEscapedString>`.
  // We cast — these are always sync (no await in the expressions).
  const rows = items.map((item): HtmlEscapedString[] => [
    // TASK column: title + optional squad
    (item.squad_name
      ? html`<span>${item.task_title}</span><br /><small style="color:var(--dim)">${item.squad_name}</small>`
      : html`<span>${item.task_title}</span>`) as HtmlEscapedString,
    // VERDICT: pill coloured by tone (pill() is sync; cast away Promise union)
    pill(
      item.verdict === 'approved' ? 'approved' : 'rejected',
      item.verdict === 'approved' ? 'ok' : 'danger',
    ) as HtmlEscapedString,
    // DECIDED BY
    html`${item.decided_by}` as HtmlEscapedString,
    // WHEN
    html`${fmtWhen(item.decided_at)}` as HtmlEscapedString,
    // NOTE
    (item.note
      ? html`${item.note}`
      : html`<span style="color:var(--dim)">—</span>`) as HtmlEscapedString,
  ])

  const table = dataTable({
    cols: [
      { label: 'TASK',       width: '2fr' },
      { label: 'VERDICT',    width: '120px' },
      { label: 'DECIDED BY', width: '1fr' },
      { label: 'WHEN',       width: '180px' },
      { label: 'NOTE',       width: '2fr' },
    ],
    rows,
  })

  return html`${header}${table}` as HtmlEscapedString
}

function verdictTone(verdict: string): Tone {
  if (verdict === 'APPROVED') return 'ok'
  if (verdict === 'BLOCKED') return 'danger'
  return 'warn'
}

function shortSha(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha
}

export interface AthenaCheckBadge {
  name: string
  passed: boolean
}

export function parseAthenaGateChecks(raw: string): AthenaCheckBadge[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
      .map((item) => ({
        name:
          typeof item.name === 'string' && item.name.trim()
            ? item.name
            : typeof item.id === 'string'
              ? item.id
              : 'check',
        passed: item.passed === true,
      }))
  } catch {
    return []
  }
}

function checkBadges(checksJson: string): HtmlEscapedString {
  const checks = parseAthenaGateChecks(checksJson)
  if (!checks.length) {
    return html`<span style="color:var(--dim)">—</span>` as HtmlEscapedString
  }
  return html`<span style="display:flex;flex-wrap:wrap;gap:6px;">${checks.map((check) =>
    pill(check.passed ? `✓ ${check.name}` : `✗ ${check.name}`, check.passed ? 'ok' : 'danger'),
  )}</span>` as HtmlEscapedString
}

/**
 * Recent Athena GitHub webhook gate receipts — append-only audit of
 * `POST /api/webhooks/github` verdicts.
 */
export function athenaGateReceiptsBody(receipts: AthenaGateReceipt[]): HtmlEscapedString {
  const rows = receipts.map((item): HtmlEscapedString[] => [
    html`<span>${item.repo}</span><br /><small style="color:var(--dim)">#${String(item.pr_number)} @ ${shortSha(item.commit_sha)}</small>` as HtmlEscapedString,
    pill(item.verdict, verdictTone(item.verdict)) as HtmlEscapedString,
    checkBadges(item.checks_json),
    html`${item.summary}` as HtmlEscapedString,
    html`${fmtWhen(item.created_at)}` as HtmlEscapedString,
  ])

  const table = dataTable({
    cols: [
      { label: 'PR', width: '1.4fr' },
      { label: 'VERDICT', width: '140px' },
      { label: 'CHECKS', width: '1.6fr' },
      { label: 'SUMMARY', width: '2fr' },
      { label: 'WHEN', width: '180px' },
    ],
    rows,
    empty: 'No Athena PR gate audits yet. Opened, synchronized, and reopened pull requests land here.',
  })

  return html`${sectionPanel({
    title: 'Athena PR gate audits',
    body: table,
  })}` as HtmlEscapedString
}
