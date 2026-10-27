// src/dashboard/changes.ts: /changes, "Recent changes" with a one-tap Undo for the reversible actions mupot already has an inverse for.
//
// NOTHING NEW IS RECORDED. Every row is read from a record the original action already wrote:
//   - archive_receipts  (archive_row / unarchive_row, src/hygiene/archive.ts): who, which table+id, when, prior status
//   - task_verdicts     (task_verdict, src/tasks/service.ts): who decided, when, the verdict, reversed_at
//   - verdict_reversals (task_verdict_reverse): the receipt a verdict undo leaves
//   - agent_audit       (move_agent_squad, update_agent): shown as a sentence only, never undoable here
//
// UNDO IS ONLY EVER OFFERED FOR (the allowlist in UNDOABLE below):
//   archive of a task / project / squad  -> unarchive_row          (tool floor + requireOperatorOrgAdmin)
//   a task verdict (approved / rejected) -> task_verdict_reverse   (tool floor + org owner/admin)
// and only while (a) that inverse exists, (b) the viewer can run it, (c) the target has not changed since the
// record was written. (c) uses the stamp the original change left behind: archived_at == the receipt's created_at
// (squads, projects, tasks_archive_state), tasks.updated_at == task_verdicts.decided_at (verdicts, written from one
// shared timestamp), and "this record is still the latest one for that target".
//
// THE WRITE IS NEVER MADE HERE. The POST re-derives the record from its id (the form carries only a record id,
// never a table or a target id, so a crafted form cannot name another table) and calls invokeTool on the existing
// inverse tool. That is the same chokepoint an agent or the MCP client goes through, so its floor, its own
// authority check and its own receipt apply unchanged. The button is hidden when the viewer lacks the authority
// (the same predicate), and a POST from them is refused twice: here, then by the tool.
//
// DELIBERATELY NOT UNDOABLE (shown as a sentence at most): member / agent archives (identity and credentials; a
// deactivated agent's tokens and keys are already revoked and cannot be restored), move_agent_squad and
// squad_member_add/remove (they grant or take capabilities: restoring means re-granting authority), verdicts on a
// gate:routines or gate:office task or one bound to a routine proposal (they release project access grants / a
// publish), and anything about money, tokens, keys, identity minting or deletes (none of those appear here at all).
//
// The POST needs the same bar as the original archive (board-cleanup): same-origin, a real web session of an
// active human, re-authenticated within the step-up window, no agent bearer.

import { Hono } from 'hono'
import { html } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import type { AuthContext, Env } from '../types'
import { hasWorkspaceAdmin } from '../auth/capability'
import { checkWebSession } from '../secure-moments/enrol-mint'
import { taskArchiveEnabled } from '../hygiene/archive'
import { hasDedicatedGatePredicate } from '../tasks/service'
import { invokeTool, isOrgOwnerAdmin } from '../mcp'
import {
  CHANGES_PAGE_SIZE, CHANGE_KINDS, ARCHIVE_TABLES, SEARCH_MAX_LENGTH,
  changeFilters, changeCursor, changesLink, changeSourceQuery,
  type ChangeFilters, type ChangeCursor,
} from './changes-query'
import { emptyState, pageHeader, pill, sectionPanel, type Html } from './ui'

type ShellFn = (
  env: Env,
  title: string,
  body: HtmlEscapedString | Promise<HtmlEscapedString>,
) => HtmlEscapedString | Promise<HtmlEscapedString>

type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } }

/** The tables whose archive has an inverse reachable from here. Everything else is a sentence only. */
const UNDOABLE_ARCHIVE_TABLES = ['tasks', 'projects', 'squads'] as const
type UndoableArchiveTable = (typeof UNDOABLE_ARCHIVE_TABLES)[number]
function isUndoableArchiveTable(v: string): v is UndoableArchiveTable {
  return (UNDOABLE_ARCHIVE_TABLES as readonly string[]).includes(v)
}

/** Gate namespaces whose approval releases an authority grant or a publish: never offered for undo. */
const NEVER_UNDO_GATES: readonly string[] = ['gate:routines']

export type UndoState =
  | { kind: 'available' }
  | { kind: 'changed' }
  | { kind: 'done' }
  | { kind: 'none' }
  | { kind: 'no_authority' }

export interface RecentChange {
  /** 'archive:<receipt id>' | 'verdict:<verdict id>' | 'info:<source>:<id>' */
  id: string
  at: string
  actorId: string
  actorName: string
  sentence: string
  mine: boolean
  undo: UndoState
}

// ── authority (mirrors each inverse's own chokepoint; the tool re-checks on the POST) ─────────────────────────────

/** unarchive_row: requireOperatorOrgAdmin in src/mcp/archive.ts. */
function mayRunUnarchive(auth: AuthContext): boolean {
  return !auth.boundAgentId && hasWorkspaceAdmin(auth) && Boolean(auth.memberId)
}
/** task_verdict_reverse -> task_update's reversal branch: isOrgOwnerAdmin. */
function mayReverseVerdict(auth: AuthContext): boolean {
  return !auth.boundAgentId && isOrgOwnerAdmin(auth) && Boolean(auth.memberId)
}

// ── record readers ───────────────────────────────────────────────────────────────────────────────────────────────

interface ArchiveRecord {
  id: string
  entity_table: string
  entity_id: string
  action: 'archive' | 'unarchive'
  reason: string
  actor_member_id: string
  created_at: string
  actor_name: string | null
  target_name: string | null
}

const ARCHIVE_SELECT = `
  SELECT r.id, r.entity_table, r.entity_id, r.action, r.reason, r.actor_member_id, r.created_at,
         m.display_name AS actor_name,
         CASE r.entity_table
           WHEN 'tasks' THEN (SELECT title FROM tasks WHERE id = r.entity_id)
           WHEN 'projects' THEN (SELECT name FROM projects WHERE id = r.entity_id)
           WHEN 'squads' THEN (SELECT name FROM squads WHERE id = r.entity_id)
           WHEN 'agents' THEN (SELECT name FROM agents WHERE id = r.entity_id)
           WHEN 'members' THEN (SELECT display_name FROM members WHERE id = r.entity_id)
         END AS target_name
    FROM archive_receipts r
    LEFT JOIN members m ON m.id = r.actor_member_id
`

interface VerdictRecord {
  id: string
  task_id: string
  verdict: 'approved' | 'rejected'
  decided_by: string
  decided_at: string
  proposal_id: string | null
  reversed_at: string | null
  title: string | null
  task_status: string | null
  task_updated_at: string | null
  gate_owner: string | null
  latest_verdict_id: string | null
  archived: number
  actor_name: string | null
}

const VERDICT_SELECT = `
  SELECT v.id, v.task_id, v.verdict, v.decided_by, v.decided_at, v.proposal_id, v.reversed_at,
         t.title, t.status AS task_status, t.updated_at AS task_updated_at, t.gate_owner,
         (SELECT id FROM task_verdicts WHERE task_id = v.task_id ORDER BY decided_at DESC, id DESC LIMIT 1) AS latest_verdict_id,
         EXISTS (SELECT 1 FROM tasks_archive_state s WHERE s.task_id = v.task_id) AS archived,
         COALESCE(m.display_name, a.name) AS actor_name
    FROM task_verdicts v
    LEFT JOIN tasks t ON t.id = v.task_id
    LEFT JOIN members m ON m.id = v.decided_by
    LEFT JOIN agents a ON a.id = v.decided_by`

// ── classification ───────────────────────────────────────────────────────────────────────────────────────────────

/** Undo state of one ARCHIVE record. (c) "changed since" is decided here from what the archive itself stamped. */
async function classifyArchive(env: Env, auth: AuthContext, r: ArchiveRecord): Promise<UndoState> {
  if (r.action !== 'archive' || !isUndoableArchiveTable(r.entity_table)) return { kind: 'none' }
  if (r.entity_table === 'tasks' && !taskArchiveEnabled(env)) return { kind: 'none' }
  if (!mayRunUnarchive(auth)) return { kind: 'no_authority' }

  // Still the latest word on this target? A later unarchive means it was already restored; a later archive means it moved on.
  const latest = await env.DB.prepare(
    `SELECT id, action FROM archive_receipts WHERE tenant = ?1 AND entity_table = ?2 AND entity_id = ?3
      ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).bind(env.TENANT_SLUG, r.entity_table, r.entity_id).first<{ id: string; action: string }>()
  if (!latest) return { kind: 'changed' }
  if (latest.id !== r.id) return latest.action === 'unarchive' ? { kind: 'done' } : { kind: 'changed' }

  if (r.entity_table === 'tasks') {
    const row = await env.DB.prepare(
      `SELECT s.archived_at AS archived_at, t.updated_at AS updated_at
         FROM tasks_archive_state s JOIN tasks t ON t.id = s.task_id WHERE s.task_id = ?1`,
    ).bind(r.entity_id).first<{ archived_at: string; updated_at: string }>()
    if (!row) return { kind: 'changed' }
    if (row.archived_at !== r.created_at || row.updated_at > r.created_at) return { kind: 'changed' }
    return { kind: 'available' }
  }
  const table = r.entity_table // 'projects' | 'squads': fixed by isUndoableArchiveTable above, never user input
  const row = await env.DB.prepare(`SELECT status, archived_at FROM ${table} WHERE id = ?1`)
    .bind(r.entity_id).first<{ status: string; archived_at: string | null }>()
  if (!row || row.status !== 'archived' || row.archived_at !== r.created_at) return { kind: 'changed' }
  return { kind: 'available' }
}

/** Undo state of one VERDICT record. */
function classifyVerdict(auth: AuthContext, v: VerdictRecord): UndoState {
  if (v.reversed_at) return { kind: 'done' }
  if (v.proposal_id !== null || hasDedicatedGatePredicate(v.gate_owner) || (v.gate_owner !== null && NEVER_UNDO_GATES.includes(v.gate_owner))) {
    return { kind: 'none' }
  }
  if (!mayReverseVerdict(auth)) return { kind: 'no_authority' }
  // Not the latest verdict, task moved on from the status the verdict set, touched since, or archived.
  if (v.latest_verdict_id !== v.id) return { kind: 'changed' }
  if (v.task_status !== v.verdict || v.task_updated_at !== v.decided_at || v.archived) return { kind: 'changed' }
  return { kind: 'available' }
}

// ── sentences ────────────────────────────────────────────────────────────────────────────────────────────────────

const TABLE_NOUN: Record<string, string> = { tasks: 'task', projects: 'project', squads: 'squad', agents: 'agent', members: 'member' }

function quoted(name: string | null, fallback: string): string {
  return `"${name && name.trim() ? name.trim() : fallback}"`
}

function archiveSentence(r: ArchiveRecord, actor: string): string {
  const noun = TABLE_NOUN[r.entity_table] ?? r.entity_table
  const verb = r.action === 'archive' ? 'archived' : 'restored'
  return `${actor} ${verb} the ${noun} ${quoted(r.target_name, r.entity_id)}`
}

function verdictSentence(v: VerdictRecord, actor: string): string {
  return `${actor} ${v.verdict === 'approved' ? 'approved' : 'rejected'} the task ${quoted(v.title, v.task_id)}`
}

function actorLabel(name: string | null, id: string, mine: boolean): string {
  if (mine) return 'You'
  return name && name.trim() ? name.trim() : id
}

// ── the feed ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Whether the viewer sees the whole org's changes (org admins) or only their own. */
function seesOrg(auth: AuthContext): boolean {
  return hasWorkspaceAdmin(auth)
}

function viewerIds(auth: AuthContext): string[] {
  return [auth.memberId, auth.boundAgentId].filter((x): x is string => typeof x === 'string' && x.length > 0)
}

async function recentCandidates(env: Env, auth: AuthContext, filters: ChangeFilters, cursor: ChangeCursor | null): Promise<RecentChange[]> {
  if (!auth.memberId) return []
  const me = new Set(viewerIds(auth))
  const org = seesOrg(auth) && filters.actor !== 'me'
  const out: RecentChange[] = []

  // 1. archives + restores. Visibility is always the first predicate, before search.
  const archiveExtra: string[] = []
  const archiveValues = org ? [env.TENANT_SLUG] : [env.TENANT_SLUG, auth.memberId]
  if (filters.kind !== 'all') {
    archiveExtra.push(['archive', 'unarchive'].includes(filters.kind) ? `r.action = ?${archiveValues.push(filters.kind)}` : '0')
  }
  if (filters.table !== 'all') archiveExtra.push(`r.entity_table = ?${archiveValues.push(filters.table)}`)
  if (filters.undoable) {
    // Mirrors classifyArchive; the classifier still determines the displayed state.
    archiveExtra.push(mayRunUnarchive(auth) ? `r.action = 'archive'
      AND r.id = (SELECT id FROM archive_receipts latest
        WHERE latest.tenant = r.tenant AND latest.entity_table = r.entity_table AND latest.entity_id = r.entity_id
        ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1)
      AND ((r.entity_table = 'projects' AND EXISTS (SELECT 1 FROM projects p WHERE p.id = r.entity_id AND p.status = 'archived' AND p.archived_at = r.created_at))
        OR (r.entity_table = 'squads' AND EXISTS (SELECT 1 FROM squads s WHERE s.id = r.entity_id AND s.status = 'archived' AND s.archived_at = r.created_at))
        ${taskArchiveEnabled(env) ? "OR (r.entity_table = 'tasks' AND EXISTS (SELECT 1 FROM tasks_archive_state s JOIN tasks t ON t.id = s.task_id WHERE s.task_id = r.entity_id AND s.archived_at = r.created_at AND t.updated_at <= r.created_at))" : ''})` : '0')
  }
  const archiveQuery = changeSourceQuery({
    select: ARCHIVE_SELECT, visibility: ['r.tenant = ?1', ...(org ? [] : ['r.actor_member_id = ?2'])],
    values: archiveValues, filters, cursor, prefix: 'archive:', at: 'r.created_at', id: 'r.id', extra: archiveExtra,
    search: ['r.entity_id', 'target_name', `CASE r.entity_table
      WHEN 'projects' THEN (SELECT slug FROM projects WHERE id = r.entity_id)
      WHEN 'squads' THEN (SELECT slug FROM squads WHERE id = r.entity_id)
      WHEN 'agents' THEN (SELECT slug FROM agents WHERE id = r.entity_id) END`],
  })
  const archives = await env.DB.prepare(archiveQuery.sql).bind(...archiveQuery.values).all<ArchiveRecord>()
  for (const r of archives.results ?? []) {
    const mine = me.has(r.actor_member_id)
    out.push({
      id: `archive:${r.id}`,
      at: r.created_at,
      actorId: r.actor_member_id,
      actorName: actorLabel(r.actor_name, r.actor_member_id, mine),
      sentence: archiveSentence(r, actorLabel(r.actor_name, r.actor_member_id, mine)),
      mine,
      undo: await classifyArchive(env, auth, r),
    })
  }

  // 2. verdicts
  const verdictExtra = filters.kind === 'all' || filters.kind === 'verdict' ? [] : ['0']
  if (filters.undoable) {
    // Same state checks as classifyVerdict, including the dedicated gate exclusions.
    verdictExtra.push(mayReverseVerdict(auth) ? `v.reversed_at IS NULL AND v.proposal_id IS NULL
      AND (t.gate_owner IS NULL OR t.gate_owner NOT IN ('gate:office', 'gate:routines'))
      AND v.id = (SELECT id FROM task_verdicts latest WHERE latest.task_id = v.task_id ORDER BY latest.decided_at DESC, latest.id DESC LIMIT 1)
      AND t.status = v.verdict AND t.updated_at = v.decided_at
      AND NOT EXISTS (SELECT 1 FROM tasks_archive_state s WHERE s.task_id = v.task_id)` : '0')
  }
  const verdictQuery = changeSourceQuery({
    select: VERDICT_SELECT, visibility: org ? [] : [`v.decided_by IN (${[...me].map((_, i) => `?${i + 1}`).join(', ')})`],
    values: org ? [] : [...me], filters, cursor, prefix: 'verdict:', at: 'v.decided_at', id: 'v.id',
    search: ['v.task_id', 't.title'], extra: verdictExtra,
  })
  const verdicts = await env.DB.prepare(verdictQuery.sql).bind(...verdictQuery.values).all<VerdictRecord>()
  for (const v of verdicts.results ?? []) {
    const mine = me.has(v.decided_by)
    out.push({
      id: `verdict:${v.id}`,
      at: v.decided_at,
      actorId: v.decided_by,
      actorName: actorLabel(v.actor_name, v.decided_by, mine),
      sentence: verdictSentence(v, actorLabel(v.actor_name, v.decided_by, mine)),
      mine,
      undo: classifyVerdict(auth, v),
    })
  }

  // 3. verdict undo receipts (information only)
  const reversalQuery = changeSourceQuery({
    select: `SELECT vr.id, vr.task_id, vr.prior_verdict, vr.actor_id, vr.created_at, t.title, m.display_name AS actor_name
       FROM verdict_reversals vr
       LEFT JOIN tasks t ON t.id = vr.task_id
       LEFT JOIN members m ON m.id = vr.actor_id`,
    visibility: ['vr.tenant = ?1', ...(org ? [] : ['vr.actor_id = ?2'])],
    values: org ? [env.TENANT_SLUG] : [env.TENANT_SLUG, auth.memberId],
    filters, cursor, prefix: 'info:reversal:', at: 'vr.created_at', id: 'vr.id', search: ['vr.task_id', 't.title'],
    extra: filters.undoable || !['all', 'verdict_reversal'].includes(filters.kind) ? ['0'] : [],
  })
  const reversals = await env.DB.prepare(reversalQuery.sql).bind(...reversalQuery.values).all<{
    id: string; task_id: string; prior_verdict: string | null; actor_id: string; created_at: string; title: string | null; actor_name: string | null
  }>()
  for (const r of reversals.results ?? []) {
    const mine = me.has(r.actor_id)
    const who = actorLabel(r.actor_name, r.actor_id, mine)
    out.push({
      id: `info:reversal:${r.id}`,
      at: r.created_at,
      actorId: r.actor_id,
      actorName: who,
      sentence: `${who} took back the ${r.prior_verdict ?? ''} verdict on the task ${quoted(r.title, r.task_id)}`.replace('  ', ' '),
      mine,
      undo: { kind: 'none' },
    })
  }

  // 4. agent audit: a sentence only, nothing here can be undone
  const auditQuery = changeSourceQuery({
    select: `SELECT a.id, a.agent_id, a.actor_id, a.action, a.created_at, g.name AS agent_name, u.display_name AS actor_name
       FROM agent_audit a
       LEFT JOIN agents g ON g.id = a.agent_id
       LEFT JOIN members u ON u.id = a.actor_id`,
    visibility: org ? [] : ['a.actor_id = ?1'], values: org ? [] : [auth.memberId],
    filters, cursor, prefix: 'info:agent_audit:', at: 'a.created_at', id: 'a.id', search: ['a.agent_id', 'g.name', 'g.slug'],
    extra: filters.undoable || !['all', 'agent_change'].includes(filters.kind) ? ['0'] : [],
  })
  const audits = await env.DB.prepare(auditQuery.sql).bind(...auditQuery.values).all<{
    id: string; agent_id: string; actor_id: string; action: string; created_at: string; agent_name: string | null; actor_name: string | null
  }>()
  for (const r of audits.results ?? []) {
    const mine = me.has(r.actor_id)
    const who = actorLabel(r.actor_name, r.actor_id, mine)
    const what = r.action === 'move_agent_squad' ? 'moved the agent' : 'changed the agent'
    out.push({
      id: `info:agent_audit:${r.id}`,
      at: r.created_at,
      actorId: r.actor_id,
      actorName: who,
      sentence: `${who} ${what} ${quoted(r.agent_name, r.agent_id)}`,
      mine,
      undo: { kind: 'none' },
    })
  }

  out.sort((a, b) => compareChanges(a, b) * (cursor?.direction === 'previous' ? -1 : 1))
  return out
}

function compareChanges(a: RecentChange, b: RecentChange): number {
  return a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

export interface RecentChangesPage {
  changes: RecentChange[]
  filters: ChangeFilters
  start: number
  previous?: string
  next?: string
}

export async function loadRecentChangesPage(env: Env, auth: AuthContext, params = new URLSearchParams()): Promise<RecentChangesPage> {
  const filters = changeFilters(params)
  const cursor = changeCursor(params, filters)
  const candidates = await recentCandidates(env, auth, filters, cursor)
  const more = candidates.length > CHANGES_PAGE_SIZE
  const changes = candidates.slice(0, CHANGES_PAGE_SIZE)
  if (cursor?.direction === 'previous') changes.reverse()
  const start = cursor ? (cursor.direction === 'previous' ? Math.max(0, cursor.position - changes.length) : cursor.position) : 0
  const first = changes[0]
  const last = changes[changes.length - 1]
  return {
    changes, filters, start,
    previous: first && (cursor?.direction === 'previous' ? more : Boolean(cursor))
      ? changesLink(filters, { at: first.at, id: first.id, position: start, direction: 'previous' }) : undefined,
    next: last && (cursor?.direction === 'previous' ? true : more)
      ? changesLink(filters, { at: last.at, id: last.id, position: start + changes.length, direction: 'next' }) : undefined,
  }
}

export async function loadRecentChanges(env: Env, auth: AuthContext): Promise<RecentChange[]> {
  return (await loadRecentChangesPage(env, auth)).changes
}

/** Re-derive ONE record from its id and its current undo state (used by the POST; never trusts the page). */
export async function loadChange(env: Env, auth: AuthContext, changeId: string): Promise<{ change: RecentChange; run: UndoCall } | null> {
  if (!auth.memberId) return null
  const [kind, ...rest] = changeId.split(':')
  const recordId = rest.join(':')
  if (!recordId) return null
  const me = new Set(viewerIds(auth))
  if (kind === 'archive') {
    const r = await env.DB.prepare(`${ARCHIVE_SELECT} WHERE r.tenant = ?1 AND r.id = ?2`).bind(env.TENANT_SLUG, recordId).first<ArchiveRecord>()
    if (!r || !isUndoableArchiveTable(r.entity_table)) return null
    const mine = me.has(r.actor_member_id)
    // A non-admin only ever sees (and so may only name) their own records.
    if (!seesOrg(auth) && !mine) return null
    return {
      change: {
        id: changeId, at: r.created_at, actorId: r.actor_member_id,
        actorName: actorLabel(r.actor_name, r.actor_member_id, mine),
        sentence: archiveSentence(r, actorLabel(r.actor_name, r.actor_member_id, mine)),
        mine, undo: await classifyArchive(env, auth, r),
      },
      run: { tool: 'unarchive_row', args: { table: r.entity_table, id: r.entity_id, reason: `Undo from Recent changes of ${changeId}` } },
    }
  }
  if (kind === 'verdict') {
    const v = await env.DB.prepare(`${VERDICT_SELECT} WHERE v.id = ?1`).bind(recordId).first<VerdictRecord>()
    if (!v) return null
    const mine = me.has(v.decided_by)
    if (!seesOrg(auth) && !mine) return null
    return {
      change: {
        id: changeId, at: v.decided_at, actorId: v.decided_by,
        actorName: actorLabel(v.actor_name, v.decided_by, mine),
        sentence: verdictSentence(v, actorLabel(v.actor_name, v.decided_by, mine)),
        mine, undo: classifyVerdict(auth, v),
      },
      run: { tool: 'task_verdict_reverse', args: { task_id: v.task_id, reason: `Undo from Recent changes of ${changeId}` } },
    }
  }
  return null
}

export interface UndoCall {
  tool: 'unarchive_row' | 'task_verdict_reverse'
  args: Record<string, unknown>
}

// ── rendering ────────────────────────────────────────────────────────────────────────────────────────────────────

function ago(iso: string, nowMs: number): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const s = Math.max(0, Math.round((nowMs - t) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}

function changeRow(c: RecentChange, nowMs: number): Html {
  let action: Html | string = ''
  if (c.undo.kind === 'available') {
    action = html`<form method="post" action="/changes/undo" data-undo-form>
      <input type="hidden" name="change" value="${c.id}">
      <button class="btn" type="submit">Undo</button>
    </form>`
  } else if (c.undo.kind === 'changed') {
    action = html`<span class="ui-panel-sub">Changed since — can't undo safely</span>`
  } else if (c.undo.kind === 'done') {
    action = pill('Undone', 'primary')
  }
  return html`<div class="ui-tr ui-row" style="grid-template-columns:1fr auto">
    <div class="ui-td" style="overflow-wrap:anywhere">${c.sentence}<span class="ui-panel-sub" title="${c.at}">${ago(c.at, nowMs)}</span></div>
    <div class="ui-td">${action}</div>
  </div>`
}

function filterForm(filters: ChangeFilters): Html {
  const labels: Record<string, string> = { all: 'All', archive: 'Archive', unarchive: 'Unarchive', verdict: 'Verdict', verdict_reversal: 'Verdict reversal', agent_change: 'Agent change' }
  return sectionPanel({ body: html`<form method="get" action="/changes" style="display:flex;flex-wrap:wrap;gap:var(--s3,12px);align-items:end">
    <label>Kind <select name="kind">${CHANGE_KINDS.map((kind) => html`<option value="${kind}" ${kind === filters.kind ? html`selected` : ''}>${labels[kind]}</option>`)}</select></label>
    <label>Archive table <select name="table">${ARCHIVE_TABLES.map((table) => html`<option value="${table}" ${table === filters.table ? html`selected` : ''}>${table === 'all' ? 'All' : table}</option>`)}</select></label>
    <label>Actor <select name="actor"><option value="anyone" ${filters.actor === 'anyone' ? html`selected` : ''}>Anyone</option><option value="me" ${filters.actor === 'me' ? html`selected` : ''}>Me</option></select></label>
    <label>Search <input type="search" name="q" value="${filters.q}" maxlength="${SEARCH_MAX_LENGTH}" placeholder="Target id, slug or name"></label>
    <label>From <input type="date" name="from" value="${filters.from}"></label>
    <label>To <input type="date" name="to" value="${filters.to}"></label>
    <label><input type="checkbox" name="undoable" value="1" ${filters.undoable ? html`checked` : ''}> Undoable only</label>
    <button class="btn" type="submit">Apply filters</button><a class="ui-link" href="/changes">Clear filters</a>
    <span class="ui-panel-sub">Apply filters to find changes; clear them to see recent activity.</span>
  </form>` })
}

function pageLinks(page: RecentChangesPage): Html {
  const end = page.start + page.changes.length
  return html`<nav aria-label="Recent changes pages" style="display:flex;gap:var(--s3,12px);align-items:center">
    <span role="status">Showing ${page.changes.length ? page.start + 1 : 0}–${end}${page.next ? ' · More changes exist' : ' · No more older changes'}</span>
    ${page.previous ? html`<a class="btn" rel="prev" href="${page.previous}">Previous</a>` : ''}
    ${page.next ? html`<a class="btn" rel="next" href="${page.next}">Next</a>` : ''}
  </nav>`
}

export function changesBody(changes: RecentChange[], admin: boolean, extra: Html | '' = '', nowMs: number = Date.now(), page?: RecentChangesPage): Html {
  const mine = changes.filter((c) => c.mine)
  const others = changes.filter((c) => !c.mine)
  const filters = filterForm(page?.filters ?? changeFilters())
  const paging = page ? pageLinks(page) : ''
  const header = pageHeader({
    crumbs: 'Workspace / Activity',
    title: 'Recent changes',
    sub: 'Nothing here is permanent. Where a change can be safely taken back, there is an Undo.',
  })
  if (changes.length === 0) {
    return html`${header}${extra}${filters}${emptyState({ title: 'No changes found', detail: 'No visible changes match these filters.', hint: 'Clear filters or widen the date range to try again.' })}<a class="ui-link" href="/changes">Clear filters</a>`
  }
  const list = (rows: RecentChange[]): Html => html`<div class="ui-table">${rows.map((c) => changeRow(c, nowMs))}</div>`
  return html`${header}${extra}${filters}${paging}
    ${sectionPanel({ title: 'Your changes', body: mine.length ? list(mine) : html`<p class="ui-panel-sub">You have not changed anything recently.</p>` })}
    ${admin ? sectionPanel({ title: 'Changes by everyone else', body: others.length ? list(others) : html`<p class="ui-panel-sub">Nobody else has changed anything recently.</p>` }) : ''}${paging}`
}

function reauthNotice(): Html {
  return sectionPanel({
    body: html`<p>Confirm it is you before undoing. <a class="ui-link" href="/auth/reauth?return=/changes">Confirm it is you first</a>, then come back to this page and tap Undo again.</p>`,
  })
}

function notice(text: string): Html {
  return sectionPanel({ body: html`<p role="status">${text}</p><p class="ui-panel-sub">Review the changes below or adjust the filters to continue.</p>` })
}

function undoFailureText(error: string): string {
  switch (error) {
    case 'parent_archived': return "Can't undo: the squad or project this belongs to is archived. Restore that first."
    case 'task_archived': return "Can't undo: the task is archived."
    case 'office_publish_unresolved': return "Can't undo: a publish is still in progress."
    case 'cannot_affect_higher_rank': return "Can't undo: you don't have the standing for this one."
    case 'forbidden':
    case 'operator_principal_required': return "You don't have permission to undo this."
    default: return `Could not undo (${error}). Nothing was changed.`
  }
}

// ── routes ───────────────────────────────────────────────────────────────────────────────────────────────────────

export function makeChangesApp(shell: ShellFn) {
  const app = new Hono<AppEnv>()

  app.get('/changes', async (c) => {
    c.header('Cache-Control', 'no-store')
    const auth = c.get('auth')
    const page = await loadRecentChangesPage(c.env, auth, new URL(c.req.url).searchParams)
    return c.html(shell(c.env, 'Recent changes', changesBody(page.changes, seesOrg(auth), '', Date.now(), page)))
  })

  app.post('/changes/undo', async (c) => {
    c.header('Cache-Control', 'no-store')
    const auth = c.get('auth')
    const page = async (status: 200 | 400 | 403 | 404, extra: Html) => {
      const result = await loadRecentChangesPage(c.env, auth)
      return c.html(shell(c.env, 'Recent changes', changesBody(result.changes, seesOrg(auth), extra, Date.now(), result)), status)
    }

    if (c.req.header('origin') !== new URL(c.req.url).origin) {
      return c.html(shell(c.env, 'Recent changes', notice('Cross-origin request refused.')), 403)
    }
    const session = await checkWebSession(c.env, auth, { fresh: true })
    if (!session.ok) {
      return session.error === 'reauth_required'
        ? page(403, reauthNotice())
        : page(403, notice(`Undo needs a signed-in human session (${session.error}).`))
    }
    if (auth.boundAgentId) return page(403, notice('Only a signed-in person can undo a change.'))

    const form = await c.req.formData()
    const changeId = form.get('change')
    if (typeof changeId !== 'string' || changeId.length === 0 || changeId.length > 200) return page(400, notice('Nothing to undo.'))

    // Re-derived from the record, never from the page the viewer saw.
    const found = await loadChange(c.env, auth, changeId)
    if (!found) return page(404, notice('That change was not found.'))
    switch (found.change.undo.kind) {
      case 'available': break
      case 'done': return page(200, notice('Already undone. Nothing more to do.'))
      case 'changed': return page(200, notice("Changed since — can't undo safely. Nothing was changed."))
      case 'no_authority': return page(403, notice("You don't have permission to undo this."))
      case 'none': return page(403, notice("This kind of change can't be undone here."))
    }

    // THE existing inverse, through the same chokepoint as every other caller. This module never writes rows.
    const outcome = await invokeTool(auth, c.env, found.run.tool, found.run.args, new URL(c.req.url).origin)
    if (!outcome.ok) return page(outcome.status === 403 ? 403 : 200, notice(undoFailureText(outcome.error)))
    return page(200, notice(`Undone: ${found.change.sentence}.`))
  })

  return app
}
