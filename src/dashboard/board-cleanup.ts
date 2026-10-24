// src/dashboard/board-cleanup.ts: /board/cleanup, the one human page where agent archive proposals are decided.
//
// Agents PROPOSE (archive_propose, src/mcp/archive.ts); this page lets a human org admin archive in one click.
// Archiving goes through decideProposals -> archiveRow (src/hygiene/archive.ts): the same chokepoint archive_row
// uses, so expected_status drift and every refusal (live execution claim, in-air flight, in-flight dispatch) are
// archiveRow's own. This module adds only the gate on the POST, in order:
//   1. same-origin (hono csrf() on dashboardApp for form posts, plus an explicit Origin check here: a missing Origin refuses);
//   2. a REAL dashboard web session of an active human member, re-authenticated within five minutes
//      (checkWebSession fresh:true, the dashboard's existing step-up freshness rule; there is no passkey step-up
//      helper for dashboard actions today, same as /operators). Agent, bearer and OAuth callers have no web session;
//   3. org-admin standing (hasWorkspaceAdmin).

import { Hono } from 'hono'
import { html } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import type { AuthContext, Env } from '../types'
import { hasWorkspaceAdmin } from '../auth/capability'
import { checkWebSession } from '../secure-moments/enrol-mint'
import { decideProposals, listPendingProposals, type DecideRowResult, type PendingProposal } from '../hygiene/archive-proposals'
import { emptyState, pageHeader, pill, sectionPanel, type Html } from './ui'

type ShellFn = (
  env: Env,
  title: string,
  body: HtmlEscapedString | Promise<HtmlEscapedString>,
) => HtmlEscapedString | Promise<HtmlEscapedString>

type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } }

const MAX_FORM_IDS = 500

function groupByAgent(rows: PendingProposal[]): Map<string, PendingProposal[]> {
  const groups = new Map<string, PendingProposal[]>()
  for (const row of rows) {
    const key = `${row.agent_id}\u0000${row.proposed_by}`
    const group = groups.get(key)
    if (group) group.push(row)
    else groups.set(key, [row])
  }
  return groups
}

function resultsPanel(results: DecideRowResult[]): Html {
  const archived = results.filter((r) => r.result === 'archived').length
  const refused = results.filter((r) => r.result === 'refused')
  return sectionPanel({
    title: 'Result',
    body: html`<p>${archived} archived, ${refused.length} refused.</p>
      ${refused.length
        ? html`<ul>${refused.map((r) => html`<li><code>${r.task_id || r.proposal_id}</code>: ${r.error ?? 'refused'}</li>`)}</ul>`
        : ''}`,
  })
}

function reauthNotice(): Html {
  return sectionPanel({
    body: html`<p>Confirm it is you before archiving. <a class="ui-link" href="/auth/reauth?return=/board/cleanup">Confirm it is you first</a>, then come back to this page and try again.</p>`,
  })
}

export function boardCleanupBody(rows: PendingProposal[], extra: Html | '' = ''): Html {
  if (rows.length === 0) {
    return html`${pageHeader({ crumbs: 'Workspace / Board', title: 'Board cleanup', sub: 'Archive proposals from agents.' })}
      ${extra}
      ${emptyState({ title: 'Nothing to review', detail: 'No agent has proposed archiving a task, or every proposal is decided.' })}`
  }
  const groups = Array.from(groupByAgent(rows).values())
  return html`${pageHeader({
      crumbs: 'Workspace / Board',
      title: 'Board cleanup',
      sub: `${rows.length} pending archive proposal${rows.length === 1 ? '' : 's'}. Archiving is reversible with unarchive_row.`,
    })}
    ${extra}
    <form method="post" action="/board/cleanup/archive" data-board-cleanup-form>
      ${rows.map((p) => html`<input type="hidden" name="rendered_id" value="${p.id}">`)}
      ${groups.map((items) => sectionPanel({
        title: `Proposed by ${items[0]?.proposed_by ?? ''} (${items.length})`,
        body: html`<div class="ui-table">
          ${items.map((p) => html`<div class="ui-tr ui-row" style="grid-template-columns:auto 1fr auto">
            <div class="ui-td"><input type="checkbox" name="proposal_id" value="${p.id}" aria-label="Select ${p.title ?? p.task_id}"></div>
            <div class="ui-td" style="overflow-wrap:anywhere">
              <strong>${p.title ?? p.task_id}</strong>
              <span class="ui-panel-sub">${[p.squad, p.project].filter(Boolean).join(' / ') || 'No squad or project'}</span>
              <span class="ui-panel-sub">Agent's note: ${p.reason}. Evidence: ${p.evidence || 'none given'}.</span>
            </div>
            <div class="ui-td">${pill(p.current_status ?? 'missing', p.current_status === p.status_at_proposal ? 'primary' : 'warn')}${p.current_status !== p.status_at_proposal ? html`<span class="ui-panel-sub">was ${p.status_at_proposal}</span>` : ''}</div>
          </div>`)}
        </div>`,
      }))}
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn danger" type="submit" name="mode" value="selected">Archive selected</button>
        <button class="btn danger" type="submit" name="mode" value="all">Archive all (${rows.length})</button>
      </div>
    </form>`
}

export function makeBoardCleanupApp(shell: ShellFn) {
  const app = new Hono<AppEnv>()

  app.get('/board/cleanup', async (c) => {
    const auth = c.get('auth')
    if (!hasWorkspaceAdmin(auth)) {
      return c.html(shell(c.env, 'Board cleanup', sectionPanel({ body: html`<p>Board cleanup is for org admins.</p>` })), 403)
    }
    return c.html(shell(c.env, 'Board cleanup', boardCleanupBody(await listPendingProposals(c.env))))
  })

  app.post('/board/cleanup/archive', async (c) => {
    c.header('Cache-Control', 'no-store')
    const refuse = (status: 403, body: Html) => c.html(shell(c.env, 'Board cleanup', body), status)
    if (c.req.header('origin') !== new URL(c.req.url).origin) {
      return refuse(403, sectionPanel({ body: html`<p>Cross-origin request refused.</p>` }))
    }
    const auth = c.get('auth')
    const session = await checkWebSession(c.env, auth, { fresh: true })
    if (!session.ok) {
      return refuse(403, session.error === 'reauth_required'
        ? reauthNotice()
        : sectionPanel({ body: html`<p>Archiving needs a signed-in human session (${session.error}).</p>` }))
    }
    if (auth.boundAgentId || !hasWorkspaceAdmin(auth)) {
      return refuse(403, sectionPanel({ body: html`<p>Only an org admin can archive.</p>` }))
    }
    const form = await c.req.formData()
    const mode = form.get('mode')
    let ids: string[]
    // Only the ids the page RENDERED are ever archived: "all" means every rendered id, never a fresh read, so a
    // proposal that arrived after the page loaded is not archived unseen. decideProposals also requires each to
    // still be pending.
    if (mode === 'all') {
      ids = form.getAll('rendered_id').filter((v): v is string => typeof v === 'string').slice(0, MAX_FORM_IDS)
    } else {
      ids = form.getAll('proposal_id').filter((v): v is string => typeof v === 'string').slice(0, MAX_FORM_IDS)
    }
    const results = await decideProposals(c.env, auth, session.memberId, ids)
    return c.html(shell(c.env, 'Board cleanup', boardCleanupBody(await listPendingProposals(c.env), resultsPanel(results))))
  })

  return app
}
