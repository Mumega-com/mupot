// src/dashboard/audit.ts — immutable audit log for the pot console.
//
// PURE READ + PRESENTATION (no mutation, no new write routes, no new authority).
//
// Visibility rule: OWNER / ADMIN ONLY.
//   loadAudit() returns { forbidden: true } for any non-admin caller;
//   the route layer should 403 on that.  auditBody() also short-circuits to
//   an emptyState when called with isAdmin=false so a mis-wired partial render
//   is still safe.
//
// Sources merged into one chronological log (descending):
//   1. connector_audit — connector add/rotate/revoke events scoped to this tenant
//   2. task_verdicts   — gate decisions (action = 'gate.approved' | 'gate.rejected')
//
// SECRETS INVARIANT: we SELECT only safe columns from both tables.
//   connectors.encrypted_secret is NEVER selected — only id, type, label.
//   connector_audit.detail is safe (action metadata, not credential material).
//
// The merged result set is capped at `limit` rows (default 100).

import type { Env, AuthContext } from '../types'
import {
  pageHeader,
  dataTable,
  emptyState,
} from './ui'
import type { HtmlEscapedString } from 'hono/utils/html'
import { html } from 'hono/html'

// ── types ─────────────────────────────────────────────────────────────────────

export interface AuditRow {
  recorded_at: string
  action: string
  actor_id: string
  artifact: string | null  // connector label or task title
  detail: string | null
}

export type AuditResult =
  | { forbidden: true }
  | { forbidden: false; rows: AuditRow[] }

// ── visibility helper ─────────────────────────────────────────────────────────

function isOwnerAdmin(auth: AuthContext): boolean {
  return auth.role === 'owner' || auth.role === 'admin'
}

// ── data loader ───────────────────────────────────────────────────────────────

/**
 * Load the audit log for this pot.
 *
 * Visibility: owner/admin ONLY.  Returns { forbidden: true } for all others.
 *
 * Merges:
 *   - connector_audit rows (connector add/rotate/revoke) with the connector's
 *     type + label as the artifact.
 *   - task_verdicts rows (gate decisions), with action = 'gate.<verdict>' and
 *     the task title as the artifact.
 *
 * Sorted by recorded_at DESC, capped at `limit` (default 100).
 *
 * SECRETS INVARIANT: encrypted_secret is never selected.
 */
export async function loadAudit(
  env: Env,
  auth: AuthContext,
  limit = 100,
): Promise<AuditResult> {
  if (!isOwnerAdmin(auth)) {
    return { forbidden: true }
  }

  // Connector events: join connectors for type+label (artifact), never secret.
  // actor_id is the member id stored in connector_audit.
  const connectorSql = `
    SELECT
      ca.recorded_at,
      ca.action,
      ca.actor_id,
      (c.type || ': ' || c.label) AS artifact,
      ca.detail
    FROM connector_audit ca
    LEFT JOIN connectors c ON c.id = ca.connector_id
    WHERE ca.tenant = ?1`

  // Gate events from task_verdicts: action = 'gate.approved' | 'gate.rejected'.
  // decided_by is the principal id (agent or member); task title is the artifact.
  const verdictSql = `
    SELECT
      v.decided_at  AS recorded_at,
      ('gate.' || v.verdict) AS action,
      v.decided_by  AS actor_id,
      t.title       AS artifact,
      v.note        AS detail
    FROM task_verdicts v
    JOIN tasks t ON t.id = v.task_id`

  // Merge in SQL with UNION ALL, sort desc, cap at limit.
  // D1 supports UNION ALL + ORDER BY + LIMIT.
  const sql = `
    SELECT recorded_at, action, actor_id, artifact, detail
    FROM (
      ${connectorSql}
      UNION ALL
      ${verdictSql}
    )
    ORDER BY recorded_at DESC
    LIMIT ?2`

  const rs = await env.DB.prepare(sql).bind(env.TENANT_SLUG, limit).all<AuditRow>()
  return { forbidden: false, rows: rs.results ?? [] }
}

// ── body renderer ─────────────────────────────────────────────────────────────

function fmtWhen(iso: string): string {
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
 * Render the Audit log page body.
 *
 * When isAdmin=false, renders a safe emptyState — the route layer should already
 * have gated this, but the renderer is independently safe.
 *
 * All string inputs pass through the `html` tagged template (auto-escaped).
 * We never pull encrypted_secret or raw credential material into any column.
 */
export function auditBody(result: AuditResult): HtmlEscapedString {
  const header = pageHeader({
    title: 'Audit log',
    sub: 'Immutable trail of connector changes and gate decisions. Owner / admin only.',
  })

  if (result.forbidden) {
    return html`${header}${emptyState({
      title: 'Access restricted',
      detail: 'Audit log is owner / admin only.',
    })}` as HtmlEscapedString
  }

  if (result.rows.length === 0) {
    return html`${header}${emptyState({
      title: 'No events yet',
      detail: 'Connector changes and gate decisions will appear here.',
    })}` as HtmlEscapedString
  }

  // Each cell is produced by `html` tagged template (sync, no async expressions).
  // Cast from `HtmlEscapedString | Promise<HtmlEscapedString>` to the sync type
  // because dataTable rows expect HtmlEscapedString[].
  const rows = result.rows.map((row): HtmlEscapedString[] => [
    html`${fmtWhen(row.recorded_at)}` as HtmlEscapedString,
    html`${row.action}` as HtmlEscapedString,
    html`${row.actor_id}` as HtmlEscapedString,
    (row.artifact
      ? html`${row.artifact}`
      : html`<span style="color:var(--dim)">—</span>`) as HtmlEscapedString,
    (row.detail
      ? html`${row.detail}`
      : html`<span style="color:var(--dim)">—</span>`) as HtmlEscapedString,
  ])

  const table = dataTable({
    cols: [
      { label: 'WHEN',     width: '180px' },
      { label: 'ACTION',   width: '160px' },
      { label: 'ACTOR',    width: '1fr' },
      { label: 'ARTIFACT', width: '2fr' },
      { label: 'DETAIL',   width: '2fr' },
    ],
    rows,
  })

  return html`${header}${table}` as HtmlEscapedString
}
