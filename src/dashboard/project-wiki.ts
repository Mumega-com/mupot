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
  return `project-card-${projectId}`
}

export interface ProjectWikiSquadSummary {
  name: string
  access_level: string
}

export interface ProjectWikiView {
  project: Project
  canManage: boolean
  /** null exactly when the upstream wiki service could not be reached (fail-closed). */
  graph: WikiGraph | null
}

/**
 * Load the wiki view for an ALREADY-READ-CHECKED project (callers must run
 * getReadableProject / the equivalent read gate first — this function does
 * not re-check readability, only fetches the graph). Never throws: a
 * WikiClientError from the upstream collapses to `graph: null`, which the
 * route renders as an honest "wiki unavailable" state rather than a 500.
 */
export async function loadProjectWikiView(
  env: Env,
  project: Project,
  canManage: boolean,
): Promise<ProjectWikiView> {
  try {
    const graph = await getProjectWikiGraph(env, project.id)
    return { project, canManage, graph }
  } catch (e) {
    if (e instanceof WikiClientError) return { project, canManage, graph: null }
    throw e
  }
}

const MAX_DESCRIPTION = 500

/**
 * Build the `project-card-<id>` topic from the project's OWN fields only —
 * no free-text from any request body. This is the one write this surface
 * performs; it is a deterministic projection of columns the caller already
 * has read (or manage) access to, never attacker-suppliable content.
 *
 * SCHEMA NOTE confirmed against PR #1278 round 2: the internal-wiki PUT
 * route's own `cleanText` COLLAPSES ALL WHITESPACE (including newlines) to
 * single spaces before truncating at 500 chars — a multi-line `\n`-joined
 * description would be silently flattened server-side into one run-on line
 * regardless of what this function sends. So this builds a genuinely
 * SINGLE-LINE description itself (structured meta first, joined with " · ",
 * then the project's own free-text description), and puts the project's
 * status/squads into TAGS as well (structured, not prose) rather than
 * relying on newlines for structure. The description budget is reserved for
 * the short structured meta FIRST — the free-text project.description is
 * what gets trimmed if the combined length would exceed 500, never the
 * other way around (status/goal/links must never be the part silently cut).
 *
 * There is no structured `content_blocks` write path on this surface
 * (wiki_topics.content_blocks is always stored as `[]` by the create path
 * and left untouched by update) — if a future revision of the store adds
 * one, this is the one function that needs to change.
 */
export function buildProjectCardTopic(
  project: Project,
  squads: ProjectWikiSquadSummary[],
): WikiTopicUpsertInput {
  const metaParts: string[] = [`Status: ${project.status}`]
  if (project.goal) metaParts.push(`Goal: ${project.goal}`)
  if (project.live_url) metaParts.push(`Live: ${project.live_url}`)
  if (project.repo_url) metaParts.push(`Repo: ${project.repo_url}`)
  if (squads.length > 0) metaParts.push(`Squads: ${squads.map((s) => s.name).join(', ')}`)
  const meta = metaParts.join(' · ')

  const separator = project.description ? ' — ' : ''
  const budget = Math.max(0, MAX_DESCRIPTION - meta.length - separator.length)
  const desc =
    project.description.length > budget
      ? `${project.description.slice(0, Math.max(0, budget - 1)).trimEnd()}…`
      : project.description
  const description = `${desc}${desc ? separator : ''}${meta}`.slice(0, MAX_DESCRIPTION)

  const tags = ['project-card', project.status, ...squads.map((s) => s.name)].slice(0, 12)

  return {
    slug: projectCardTopicSlug(project.id),
    title: project.name,
    description,
    topic_type: 'project-card',
    tags,
  }
}

/**
 * projectSquadSummariesForWriter — the squads a project's card mentions.
 *
 * P1-2 fix: this is a STORED artifact later readable by anyone with the
 * project's own wiki-read access, not a live, viewer-scoped render — so it
 * must not leak squad-access information the CURRENT WRITER themselves
 * cannot see, and must NEVER include a home squad regardless of the
 * writer's own authority (home squads are members' personal squads;
 * resolveGrantedSquadIds' own org-grant path already excludes them from
 * broad "which squads can I see" answers for the same reason — see its doc
 * comment in src/projects/readable-squads.ts). Routes through
 * loadReadableSquads(env, projectId, projectAccess(env, auth)) — the EXACT
 * SAME read-access filter the project detail page itself uses for its own
 * squad list — rather than an unfiltered `project_squad_access JOIN squads`
 * query, then drops any row whose squad is `kind = 'home'`.
 */
export async function projectSquadSummariesForWriter(
  env: Env,
  auth: AuthContext,
  projectId: string,
): Promise<ProjectWikiSquadSummary[]> {
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

  return rows
    .filter((row) => kindBySquadId.get(row.squad_id) !== 'home')
    .map((row) => ({ name: row.squad_name, access_level: row.access_level }))
}

/**
 * The route's write action: build the deterministic project-card topic and
 * PUT it. Returns a discriminated outcome instead of throwing for the two
 * EXPECTED failure shapes (upstream unavailable, or a typed conflict) so the
 * caller (dashboardApp's POST route) can render an honest, specific status
 * instead of a 500 — an unexpected exception still propagates.
 */
export type CreateProjectCardOutcome =
  | { ok: true; result: WikiTopicUpsertResult }
  | { ok: false; status: 'wiki_unavailable' }
  | { ok: false; status: 'wiki_conflict'; code: string; existingProject?: string }

export async function createOrRefreshProjectCard(
  env: Env,
  project: Project,
  squads: ProjectWikiSquadSummary[],
): Promise<CreateProjectCardOutcome> {
  const topic = buildProjectCardTopic(project, squads)
  try {
    const result = await upsertProjectWikiTopic(env, project.id, topic)
    return { ok: true, result }
  } catch (e) {
    if (e instanceof WikiConflictError) {
      return { ok: false, status: 'wiki_conflict', code: e.code, existingProject: e.existingProject }
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

export function projectWikiBody(view: ProjectWikiView, statusResult?: string): Html {
  const { project, canManage, graph } = view
  const resultMessage = wikiResultMessage(statusResult)

  const header = pageHeader({
    crumbs: `Projects / ${project.name}`,
    title: 'Wiki',
    sub: `Rendered from the project's Inkwell wiki topics, under this project's mupot read permissions.`,
  })

  const banner = resultMessage
    ? html`<div class="ui-note" style="margin-bottom:10px;">${resultMessage}</div>`
    : ''

  if (graph === null) {
    return html`
      ${header}
      ${projectTabs(project.id)}
      ${banner}
      ${sectionPanel({
        title: 'Wiki',
        body: emptyState({
          title: 'Wiki unavailable',
          detail: 'The Inkwell wiki service could not be reached for this project. Try again shortly.',
        }),
      })}
    `
  }

  if (graph.nodes.length === 0) {
    return html`
      ${header}
      ${projectTabs(project.id)}
      ${banner}
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
