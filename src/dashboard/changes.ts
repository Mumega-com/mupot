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
import { emptyState, pageHeader, pill, sectionPanel, type Html } from './ui'

type ShellFn = (
  env: Env,
  title: string,
  body: HtmlEscapedString | Promise<HtmlEscapedString>,
) => HtmlEscapedString | Promise<HtmlEscapedString>

type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } }

const PER_SOURCE_LIMIT = 100
const SHOWN_PER_GROUP = 50

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
   WHERE r.tenant = ?1`

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

export async function loadRecentChanges(env: Env, auth: AuthContext): Promise<RecentChange[]> {
  if (!auth.memberId) return []
  const me = new Set(viewerIds(auth))
  const org = seesOrg(auth)
  const out: RecentChange[] = []

  // 1. archives + restores
  const archives = await env.DB.prepare(
    `${ARCHIVE_SELECT}${org ? '' : ' AND r.actor_member_id = ?2'} ORDER BY r.created_at DESC, r.id DESC LIMIT ${PER_SOURCE_LIMIT}`,
  ).bind(...(org ? [env.TENANT_SLUG] : [env.TENANT_SLUG, auth.memberId])).all<ArchiveRecord>()
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
  const verdicts = await env.DB.prepare(
    `${VERDICT_SELECT}${org ? '' : ` WHERE v.decided_by IN (${[...me].map((_, i) => `?${i + 1}`).join(', ')})`}
      ORDER BY v.decided_at DESC, v.id DESC LIMIT ${PER_SOURCE_LIMIT}`,
  ).bind(...(org ? [] : [...me])).all<VerdictRecord>()
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
  const reversals = await env.DB.prepare(
    `SELECT vr.id, vr.task_id, vr.prior_verdict, vr.actor_id, vr.created_at, t.title, m.display_name AS actor_name
       FROM verdict_reversals vr
       LEFT JOIN tasks t ON t.id = vr.task_id
       LEFT JOIN members m ON m.id = vr.actor_id
      WHERE vr.tenant = ?1${org ? '' : ' AND vr.actor_id = ?2'}
      ORDER BY vr.seq DESC LIMIT ${PER_SOURCE_LIMIT}`,
  ).bind(...(org ? [env.TENANT_SLUG] : [env.TENANT_SLUG, auth.memberId])).all<{
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
  const audits = await env.DB.prepare(
    `SELECT a.id, a.agent_id, a.actor_id, a.action, a.created_at, g.name AS agent_name, u.display_name AS actor_name
       FROM agent_audit a
       LEFT JOIN agents g ON g.id = a.agent_id
       LEFT JOIN members u ON u.id = a.actor_id
      ${org ? '' : 'WHERE a.actor_id = ?1'}
      ORDER BY a.seq DESC LIMIT ${PER_SOURCE_LIMIT}`,
  ).bind(...(org ? [] : [auth.memberId])).all<{
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

  out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1))
  return out
}

/** Re-derive ONE record from its id and its current undo state (used by the POST; never trusts the page). */
export async function loadChange(env: Env, auth: AuthContext, changeId: string): Promise<{ change: RecentChange; run: UndoCall } | null> {
  if (!auth.memberId) return null
  const [kind, ...rest] = changeId.split(':')
  const recordId = rest.join(':')
  if (!recordId) return null
  const me = new Set(viewerIds(auth))
  if (kind === 'archive') {
    const r = await env.DB.prepare(`${ARCHIVE_SELECT} AND r.id = ?2`).bind(env.TENANT_SLUG, recordId).first<ArchiveRecord>()
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

export function changesBody(changes: RecentChange[], admin: boolean, extra: Html | '' = '', nowMs: number = Date.now()): Html {
  const mine = changes.filter((c) => c.mine).slice(0, SHOWN_PER_GROUP)
  const others = changes.filter((c) => !c.mine).slice(0, SHOWN_PER_GROUP)
  const header = pageHeader({
    crumbs: 'Workspace / Activity',
    title: 'Recent changes',
    sub: 'Nothing here is permanent. Where a change can be safely taken back, there is an Undo.',
  })
  if (changes.length === 0) {
    return html`${header}${extra}${emptyState({ title: 'No changes yet', detail: 'Changes you make will show up here.' })}`
  }
  const list = (rows: RecentChange[]): Html => html`<div class="ui-table">${rows.map((c) => changeRow(c, nowMs))}</div>`
  return html`${header}${extra}
    ${sectionPanel({ title: 'Your changes', body: mine.length ? list(mine) : html`<p class="ui-panel-sub">You have not changed anything recently.</p>` })}
    ${admin ? sectionPanel({ title: 'Changes by everyone else', body: others.length ? list(others) : html`<p class="ui-panel-sub">Nobody else has changed anything recently.</p>` }) : ''}`
}

function reauthNotice(): Html {
  return sectionPanel({
    body: html`<p>Confirm it is you before undoing. <a class="ui-link" href="/auth/reauth?return=/changes">Confirm it is you first</a>, then come back to this page and tap Undo again.</p>`,
  })
}

function notice(text: string): Html {
  return sectionPanel({ body: html`<p role="status">${text}</p>` })
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
    return c.html(shell(c.env, 'Recent changes', changesBody(await loadRecentChanges(c.env, auth), seesOrg(auth))))
  })

  app.post('/changes/undo', async (c) => {
    c.header('Cache-Control', 'no-store')
    const auth = c.get('auth')
    const page = async (status: 200 | 400 | 403 | 404, extra: Html) =>
      c.html(shell(c.env, 'Recent changes', changesBody(await loadRecentChanges(c.env, auth), seesOrg(auth), extra)), status)

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
