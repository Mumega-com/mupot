// src/dashboard/project-wiki.ts — mupot v0.50 goal item 4: "each project has
// a rendered wiki home, using the existing inkwell-api wiki store, readable
// under mupot's permissions."
//
// SCOPE DISCIPLINE (mirrors account.ts's module header): mupot is the
// PERMISSION AUTHORITY, Inkwell stays the STORE. Every load here runs
// mupot's OWN project-read check FIRST (getReadableProject — routes through
// dashboard/projects.ts's readableProjectWithAccess, the SAME predicate
// loadProjectDetail's GET /projects/:id uses — one chokepoint, not a copy)
// and ONLY THEN calls out to Inkwell's internal wiki service path
// (src/projects/wiki-client.ts, mumega.com PR #1278). A caller who fails the
// mupot read check never triggers an upstream call at all — there is
// nothing to "leak via timing" or "leak via error shape" because no request
// is made.
//
// PROJECT KEY: every call into wiki-client.ts passes `project.id`, never
// `project.slug` — see wiki-client.ts's file header for why (slug is
// mutable/reclaimable, id is not).
//
// A STORED ARTIFACT MUST NOT ENCODE THE WRITER'S VIEW (P2-A, adversarial
// gate round 2 follow-up): the project-card topic is written ONCE and read
// LATER by an unbounded set of viewers, each with their OWN squad-read
// scope — baking "squads visible to whoever clicked Create" into the stored
// body would show an org admin's card (every squad) to a read-only observer
// who could never see half of them on the project page itself, and vice
// versa depending on who happened to write it last. So the card carries
// ONLY the project's own columns (name/description/goal/status/live_url/
// repo_url) — no squad data at all — and the squad list rendered on the
// wiki PAGE is computed LIVE, per CURRENT VIEWER, at render time
// (liveReadableSquadNames), the same way the project detail page computes
// its own squad list live rather than baking one into a cache.
//
// XSS discipline: every topic title/description is interpolated through
// hono/html's auto-escaping `html` tagged template, NEVER `raw()`. The two
// places that DO use `raw()` (a topic slug used inside an `id="..."` /
// `href="#..."` attribute) go through escapeAttr() first — hardened to
// escape `&"'<>` (not just `&"`), and covered by its own attribute-injection
// test/mutation, since a slug rendered here is upstream-sourced data this
// module does not re-validate against Inkwell's own slug shape.
import { html, raw } from 'hono/html'
import type { AuthContext, Env, Project } from '../types'
import type { Html } from './ui'
import { emptyState, pageHeader, pill, sectionPanel } from './ui'
import { loadReadableSquads, projectAccess, projectTabs } from './projects'
import {
  getProjectWikiGraph,
  upsertProjectWikiTopic,
  WikiClientError,
  WikiConflictError,
  WikiRequestError,
  type WikiGraph,
  type WikiTopicUpsertInput,
  type WikiTopicUpsertResult,
} from '../projects/wiki-client'

/**
 * P1-1: Inkwell's wiki_topics.slug is UNIQUE PER TENANT, not per (tenant,
 * project) — a fixed 'project-card' slug would collide the instant a SECOND
 * project in this tenant tried to create its own card (the first write would
 * permanently own the slug; every other project's write would 409
 * topic_owned_by_other_project forever). Keying the slug on the project's
 * own id makes it unique by construction. `project.id` is a
 * `crypto.randomUUID()` (lowercase hex + hyphens), so
 * `project-card-<36 chars>` is 49 chars — safely under wiki-client.ts's
 * 63-char cap (see tests/dashboard-project-wiki.test.ts's length assertion).
 */
export function projectCardTopicSlug(projectId: string): string {
  // Inkwell's slug regex is lowercase-only — lowercase the id so a project
  // whose id happens to contain uppercase still gets a valid, findable slug
  // instead of a silent wiki-client rejection (mirrors the same
  // lowercase-first discipline wiki-client.ts applies to the `project` param).
  return `project-card-${projectId.toLowerCase()}`
}

/** null exactly when the upstream wiki service could not be reached/rejected the call (fail-closed). */
export type ProjectWikiStatus = 'ok' | 'unavailable' | 'rejected'

export interface ProjectWikiView {
  project: Project
  canManage: boolean
  /** Computed LIVE for the CURRENT viewer at render time — see file header. Never stored. */
  liveSquadNames: string[]
  status: ProjectWikiStatus
  /** Present only when status === 'ok'. */
  graph: WikiGraph | null
}

/**
 * liveReadableSquadNames — the squad names a project's wiki page shows,
 * computed LIVE for `auth` at render time (never stored — see file header's
 * P2-A note). Routes through loadReadableSquads(env, projectId,
 * projectAccess(env, auth)) — the EXACT SAME read-access filter the project
 * detail page itself uses for its own squad list — rather than an
 * unfiltered `project_squad_access JOIN squads` query, then drops any row
 * whose squad is `kind = 'home'` (home squads are members' personal
 * squads; resolveGrantedSquadIds' own org-grant path already excludes them
 * from broad "which squads can I see" answers for the same reason — see its
 * doc comment in src/projects/readable-squads.ts).
 */
export async function liveReadableSquadNames(
  env: Env,
  auth: AuthContext,
  projectId: string,
): Promise<string[]> {
  const access = await projectAccess(env, auth)
  const { rows } = await loadReadableSquads(env, projectId, access)
  if (rows.length === 0) return []

  const squadIds = [...new Set(rows.map((r) => r.squad_id))]
  const { results } = await env.DB.prepare(
    `SELECT id, kind FROM squads WHERE id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`,
  )
    .bind(JSON.stringify(squadIds))
    .all<{ id: string; kind: string }>()
  const kindBySquadId = new Map((results ?? []).map((row) => [row.id, row.kind]))

  return rows.filter((row) => kindBySquadId.get(row.squad_id) !== 'home').map((row) => row.squad_name)
}

/**
 * Load the wiki view for an ALREADY-READ-CHECKED project (callers must run
 * getReadableProject / the equivalent read gate first — this function does
 * not re-check readability, only fetches the graph + the viewer's live
 * squad list). Never throws: a WikiClientError from the upstream collapses
 * to status 'unavailable'; a WikiRequestError (a well-formed call the
 * upstream rejected) collapses to status 'rejected' — both render an honest
 * empty state rather than crashing to a 500, and NEITHER ever carries the
 * raw upstream error body into the view.
 */
export async function loadProjectWikiView(
  env: Env,
  project: Project,
  auth: AuthContext,
  canManage: boolean,
): Promise<ProjectWikiView> {
  const liveSquadNames = await liveReadableSquadNames(env, auth, project.id)
  try {
    const graph = await getProjectWikiGraph(env, project.id)
    return { project, canManage, liveSquadNames, status: 'ok', graph }
  } catch (e) {
    if (e instanceof WikiRequestError) return { project, canManage, liveSquadNames, status: 'rejected', graph: null }
    if (e instanceof WikiClientError) return { project, canManage, liveSquadNames, status: 'unavailable', graph: null }
    throw e
  }
}

const MAX_DESCRIPTION = 500

/**
 * Build the `project-card-<id>` topic from the project's OWN fields only —
 * no free-text from any request body, and (P2-A) no squad data, which is a
 * per-VIEWER live render, never part of the stored artifact. This is the
 * one write this surface performs; it is a deterministic projection of
 * columns the caller already has read (or manage) access to, never
 * attacker-suppliable content.
 *
 * SCHEMA NOTE confirmed against PR #1278 round 2: the internal-wiki PUT
 * route's own `cleanText` COLLAPSES ALL WHITESPACE (including newlines) to
 * single spaces before truncating at 500 chars — a multi-line `\n`-joined
 * description would be silently flattened server-side into one run-on line
 * regardless of what this function sends. So this builds a genuinely
 * SINGLE-LINE description itself (structured meta first, joined with " · ",
 * then the project's own free-text description). The description budget is
 * reserved for the short structured meta FIRST — the free-text
 * project.description is what gets trimmed if the combined length would
 * exceed 500, never the other way around (status/goal/links must never be
 * the part silently cut).
 *
 * There is no structured `content_blocks` write path on this surface
 * (wiki_topics.content_blocks is always stored as `[]` by the create path
 * and left untouched by update) — if a future revision of the store adds
 * one, this is the one function that needs to change.
 */
export function buildProjectCardTopic(project: Project): WikiTopicUpsertInput {
  const metaParts: string[] = [`Status: ${project.status}`]
  if (project.goal) metaParts.push(`Goal: ${project.goal}`)
  if (project.live_url) metaParts.push(`Live: ${project.live_url}`)
  if (project.repo_url) metaParts.push(`Repo: ${project.repo_url}`)
  const meta = metaParts.join(' · ')

  const separator = project.description ? ' — ' : ''
  const budget = Math.max(0, MAX_DESCRIPTION - meta.length - separator.length)
  const desc =
    project.description.length > budget
      ? `${project.description.slice(0, Math.max(0, budget - 1)).trimEnd()}…`
      : project.description
  const description = `${desc}${desc ? separator : ''}${meta}`.slice(0, MAX_DESCRIPTION)

  return {
    slug: projectCardTopicSlug(project.id),
    title: project.name,
    description,
    topic_type: 'project-card',
    tags: ['project-card', project.status],
  }
}

/**
 * The route's write action: build the deterministic project-card topic and
 * PUT it. Returns a discriminated outcome instead of throwing for the
 * EXPECTED failure shapes (upstream unavailable, a typed conflict, or a
 * typed request rejection) so the caller (dashboardApp's POST route) can
 * render an honest, specific status instead of a 500 — an unexpected
 * exception still propagates.
 */
export type CreateProjectCardOutcome =
  | { ok: true; result: WikiTopicUpsertResult }
  | { ok: false; status: 'wiki_unavailable' }
  | { ok: false; status: 'wiki_conflict'; code: string; existingProject?: string }
  | { ok: false; status: 'wiki_request_rejected'; code: string }

export async function createOrRefreshProjectCard(
  env: Env,
  project: Project,
): Promise<CreateProjectCardOutcome> {
  const topic = buildProjectCardTopic(project)
  try {
    const result = await upsertProjectWikiTopic(env, project.id, topic)
    return { ok: true, result }
  } catch (e) {
    if (e instanceof WikiConflictError) {
      return { ok: false, status: 'wiki_conflict', code: e.code, existingProject: e.existingProject }
    }
    if (e instanceof WikiRequestError) {
      return { ok: false, status: 'wiki_request_rejected', code: e.code }
    }
    if (e instanceof WikiClientError) return { ok: false, status: 'wiki_unavailable' }
    throw e
  }
}

/**
 * escapeAttr — hardened beyond the minimum a double-quoted attribute
 * strictly needs (only `&`/`"` would suffice to prevent attribute
 * breakout): also escapes `'`, `<`, `>` for defense in depth, because the
 * value passed here (a topic/edge slug) is UPSTREAM-SOURCED data this
 * module does not re-validate against Inkwell's own slug shape before
 * rendering — a compromised or buggy upstream response is the realistic
 * threat model, not a well-formed slug (which could never contain any of
 * these characters in the first place). See the attribute-injection test in
 * tests/dashboard-project-wiki.test.ts, and its paired mutation (reducing
 * this function to `return value` must turn that test red).
 */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

const WIKI_RESULT_MESSAGES: Readonly<Record<string, string>> = {
  card_saved: 'Project card saved.',
  wiki_unavailable: 'The wiki service is unavailable right now — nothing was saved.',
  // P2-B: a FIXED message — the upstream's `error` string is deliberately
  // NOT carried in the redirect (it is upstream-controlled text, and the
  // status query param is reflectable by anyone who crafts the URL).
  wiki_request_rejected: 'The wiki service rejected this request — nothing was saved.',
}

function wikiResultMessage(statusResult: string | undefined): string | null {
  if (!statusResult) return null
  if (Object.hasOwn(WIKI_RESULT_MESSAGES, statusResult)) return WIKI_RESULT_MESSAGES[statusResult]
  // Conflict codes are open-ended (see WikiConflictError's doc comment) — a
  // status of the shape `wiki_conflict_<code>` always gets a message, even
  // for a code this file has never seen before, rather than silently
  // showing nothing.
  const conflictPrefix = 'wiki_conflict_'
  if (statusResult.startsWith(conflictPrefix)) {
    const code = statusResult.slice(conflictPrefix.length)
    return `Another write conflicted with this one (${code}) — nothing was saved. Try again.`
  }
  return null
}

function createCardButton(projectId: string): Html {
  return html`<form method="post" action="/projects/${encodeURIComponent(projectId)}/wiki/card" style="display:inline">
    <button class="btn primary sm" type="submit">Create project card</button>
  </form>`
}

function topicCard(topic: WikiGraph['nodes'][number], edges: WikiGraph['edges']): Html {
  const outgoing = edges.filter((e) => e.from_slug === topic.slug)
  const incoming = edges.filter((e) => e.to_slug === topic.slug && e.from_slug !== topic.slug)
  return html`
    <div class="ui-panel" style="padding:14px;margin-bottom:10px;" id="wiki-topic-${raw(escapeAttr(topic.slug))}">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline;">
        <h3 style="margin:0;font-size:15px;">${topic.title}</h3>
        ${pill(topic.topic_type, 'dim')}
      </div>
      ${topic.description
        ? html`<div style="white-space:pre-wrap;color:var(--muted,#666);margin-top:6px;font-size:13px;">${topic.description}</div>`
        : ''}
      ${topic.tags.length
        ? html`<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;">${topic.tags.map((t) => pill(t, 'accent2'))}</div>`
        : ''}
      ${outgoing.length || incoming.length
        ? html`<div style="margin-top:8px;font-size:12px;color:var(--muted,#666);">
            ${outgoing.length
              ? html`<div>Links to: ${outgoing.map((e) => html`<a href="#wiki-topic-${raw(escapeAttr(e.to_slug))}">${e.to_slug}</a>`)}</div>`
              : ''}
            ${incoming.length
              ? html`<div>Linked from: ${incoming.map((e) => html`<a href="#wiki-topic-${raw(escapeAttr(e.from_slug))}">${e.from_slug}</a>`)}</div>`
              : ''}
          </div>`
        : ''}
    </div>`
}

/**
 * Live squad summary line (P2-A) — computed fresh for THIS request's viewer,
 * never read from the stored card. Rendered separately from the topic list
 * on every state (unavailable/rejected/empty/filled) since it depends only
 * on mupot's own project_squad_access + the viewer's grants, not on Inkwell.
 */
function liveSquadsLine(names: string[]): Html {
  if (names.length === 0) return html``
  return html`<div class="ui-note" style="margin-bottom:10px;">Squads you can see on this project: ${names.join(', ')}</div>`
}

export function projectWikiBody(view: ProjectWikiView, statusResult?: string): Html {
  const { project, canManage, liveSquadNames, status, graph } = view
  const resultMessage = wikiResultMessage(statusResult)

  const header = pageHeader({
    crumbs: `Projects / ${project.name}`,
    title: 'Wiki',
    sub: `Rendered from the project's Inkwell wiki topics, under this project's mupot read permissions.`,
  })

  const banner = resultMessage
    ? html`<div class="ui-note" style="margin-bottom:10px;">${resultMessage}</div>`
    : ''
  const squadsLine = liveSquadsLine(liveSquadNames)

  if (status === 'unavailable') {
    return html`
      ${header}
      ${projectTabs(project.id)}
      ${banner}
      ${squadsLine}
      ${sectionPanel({
        title: 'Wiki',
        body: emptyState({
          title: 'Wiki unavailable',
          detail: 'The Inkwell wiki service could not be reached for this project. Try again shortly.',
        }),
      })}
    `
  }

  if (status === 'rejected') {
    return html`
      ${header}
      ${projectTabs(project.id)}
      ${banner}
      ${squadsLine}
      ${sectionPanel({
        title: 'Wiki',
        body: emptyState({
          title: 'Wiki request rejected',
          detail: 'The Inkwell wiki service rejected this request. Try again, or contact an admin if this persists.',
        }),
      })}
    `
  }

  if (graph === null || graph.nodes.length === 0) {
    return html`
      ${header}
      ${projectTabs(project.id)}
      ${banner}
      ${squadsLine}
      ${sectionPanel({
        title: 'Wiki',
        right: canManage ? createCardButton(project.id) : undefined,
        body: emptyState({
          title: 'No wiki pages yet',
          detail: canManage
            ? 'Create a project card to give this project a wiki home.'
            : 'This project has no wiki pages yet.',
        }),
      })}
    `
  }

  return html`
    ${header}
    ${projectTabs(project.id)}
    ${banner}
    ${squadsLine}
    ${sectionPanel({
      title: `Wiki (${graph.nodes.length})`,
      right: canManage ? createCardButton(project.id) : undefined,
      body: html`${graph.nodes.map((topic) => topicCard(topic, graph.edges))}`,
    })}
  `
}

export function projectWikiUnauthorizedBody(): Html {
  return emptyState({
    title: 'Project not found',
    detail: 'This project does not exist, or you do not have access to it.',
  })
}
