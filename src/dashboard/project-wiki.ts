// src/dashboard/project-wiki.ts — mupot v0.50 goal item 4: "each project has
// a rendered wiki home, using the existing inkwell-api wiki store, readable
// under mupot's permissions."
//
// SCOPE DISCIPLINE (mirrors account.ts's module header): mupot is the
// PERMISSION AUTHORITY, Inkwell stays the STORE. Every load here runs
// mupot's OWN project-read check FIRST (getReadableProject — the exact same
// predicate src/dashboard/index.ts's GET /projects/:id uses via
// loadProjectDetail) and ONLY THEN calls out to Inkwell's internal wiki
// service path (src/projects/wiki-client.ts, mumega.com PR #1278). A caller
// who fails the mupot read check never triggers an upstream call at all —
// there is nothing to "leak via timing" or "leak via error shape" because no
// request is made.
//
// XSS discipline: every topic title/description is interpolated through
// hono/html's auto-escaping `html` tagged template, NEVER `raw()`. A topic
// body containing `<script>` renders as inert escaped text.
import { html, raw } from 'hono/html'
import type { Env, Project } from '../types'
import type { Html } from './ui'
import { emptyState, pageHeader, pill, sectionPanel } from './ui'
import { projectTabs } from './projects'
import {
  getProjectWikiGraph,
  upsertProjectWikiTopic,
  WikiClientError,
  WikiConflictError,
  type WikiGraph,
  type WikiTopicUpsertInput,
  type WikiTopicUpsertResult,
} from '../projects/wiki-client'

export const PROJECT_CARD_TOPIC_SLUG = 'project-card'

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
    const graph = await getProjectWikiGraph(env, project.slug)
    return { project, canManage, graph }
  } catch (e) {
    if (e instanceof WikiClientError) return { project, canManage, graph: null }
    throw e
  }
}

/**
 * Build the `project-card` topic from the project's OWN fields only — no
 * free-text from any request body. This is the one write this surface
 * performs; it is a deterministic projection of columns the caller already
 * has read (or manage) access to, never attacker-suppliable content.
 *
 * SCHEMA NOTE / assumption made against PR #1278: the internal-wiki PUT route
 * accepts title/description/topic_type/tags/edges — there is no structured
 * `content_blocks` write path on this surface (wiki_topics.content_blocks is
 * always stored as `[]` by insertWikiTopicRow and left untouched by
 * updateWikiTopicRow). So goal/live_url/repo_url/status/squads are folded
 * into the plain-text `description` field (server-side truncated to 500
 * chars by internal-wiki.ts's cleanText) rather than given individual
 * structured slots. If a future revision of the store adds a structured
 * card shape, this is the one function that needs to change.
 */
export function buildProjectCardTopic(
  project: Project,
  squads: ProjectWikiSquadSummary[],
): WikiTopicUpsertInput {
  const lines: string[] = []
  if (project.goal) lines.push(`Goal: ${project.goal}`)
  lines.push(`Status: ${project.status}`)
  if (project.live_url) lines.push(`Live: ${project.live_url}`)
  if (project.repo_url) lines.push(`Repo: ${project.repo_url}`)
  if (squads.length > 0) {
    lines.push(`Squads: ${squads.map((s) => `${s.name} (${s.access_level})`).join(', ')}`)
  }
  const description = [project.description, '', ...lines].filter((l) => l !== undefined).join('\n').trim()

  return {
    slug: PROJECT_CARD_TOPIC_SLUG,
    title: project.name,
    description,
    topic_type: 'project-card',
    tags: ['project-card', project.status],
  }
}

/**
 * projectSquadSummaries — squad name + access_level for a project's
 * project_squad_access rows (mirrors project_squad_list's join, unfiltered by
 * viewer read-scope: this is the PROJECT's own authoritative metadata used to
 * compose its OWN card, gated at the route by canManageProject, not by
 * per-squad read visibility).
 */
export async function projectSquadSummaries(env: Env, projectId: string): Promise<ProjectWikiSquadSummary[]> {
  const { results } = await env.DB.prepare(
    `SELECT s.name AS name, psa.access_level AS access_level
       FROM project_squad_access psa
       JOIN squads s ON s.id = psa.squad_id
      WHERE psa.project_id = ?
      ORDER BY s.name`,
  ).bind(projectId).all<ProjectWikiSquadSummary>()
  return results ?? []
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
  | { ok: false; status: 'wiki_conflict'; code: WikiConflictError['code']; existingProject?: string }

export async function createOrRefreshProjectCard(
  env: Env,
  project: Project,
  squads: ProjectWikiSquadSummary[],
): Promise<CreateProjectCardOutcome> {
  const topic = buildProjectCardTopic(project, squads)
  try {
    const result = await upsertProjectWikiTopic(env, project.slug, topic)
    return { ok: true, result }
  } catch (e) {
    if (e instanceof WikiConflictError) {
      return { ok: false, status: 'wiki_conflict', code: e.code, existingProject: e.existingProject }
    }
    if (e instanceof WikiClientError) return { ok: false, status: 'wiki_unavailable' }
    throw e
  }
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

const WIKI_RESULT_MESSAGES: Readonly<Record<string, string>> = {
  card_saved: 'Project card saved.',
  wiki_unavailable: 'The wiki service is unavailable right now — nothing was saved.',
  wiki_conflict_topic_owned_by_other_project:
    'The "project-card" wiki slug is already owned by a different project — nothing was saved.',
  wiki_conflict_topic_is_keychain_gated:
    'This project already has a restricted (keychain-gated) wiki page at this slug — nothing was saved.',
  wiki_conflict_topic_write_conflict:
    'Another write raced this one — nothing was saved. Try again.',
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
  const resultMessage = statusResult && Object.hasOwn(WIKI_RESULT_MESSAGES, statusResult)
    ? WIKI_RESULT_MESSAGES[statusResult]
    : null

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
