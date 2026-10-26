// src/mcp/pages.ts — project_wiki_upsert / project_wiki_get: thin MCP wrappers over the PagesPort
// (src/pages/). Auth lives HERE (who may write); content rules + envelope stamping live in
// src/pages/service.ts; the store is whatever PagesPort adapter is configured (Inkwell wiki by default).
//
// Write gate = project_remember's, verbatim: project READ (404 project_not_found, no wrong-id vs
// no-access oracle) THEN project WRITE (org-admin, or write/admin on the project via one of the
// caller's squads). An ATTACHED chat reaches this through the same clamp every identity-keyed path
// uses (src/auth/attached-ceiling.ts: authority = min(human standing, agent grant, admission
// ceiling)): its capabilities are already clamped at the source, so readAccess(auth).squadIds only
// carries squads the attachment may act in. We never widen from the bound agent's own standing.

import { done, fail, str, type ToolSpec } from './index'
import { readAccess, readableProject } from './projects'
import { callerCanWriteProject, callerHasSquadAccessToProject } from '../projects/access'
import { createInkwellPagesPort } from '../pages/inkwell-adapter'
import { filterBacklinks, readPage, validatePageWrite, writePage } from '../pages/service'
import { isReservedSlug, PAGE_SLUG_RE, PagesPortError, type PagesPort } from '../pages/port'
import type { AuthContext } from '../types'

const STRING_SCHEMA = { type: 'string' }

/** Test seam: the adapter factory. Production = Inkwell wiki. */
export const pagesPortFactory: { create: (env: Parameters<typeof createInkwellPagesPort>[0]) => PagesPort } = {
  create: (env) => createInkwellPagesPort(env),
}

/** The envelope stamps are tags and the store silently slices a tag at 48 chars. `owner:` is the longest
 *  prefix (6), so an id that could overflow is replaced by a stable 39-char digest rather than truncated. */
export async function stampableId(id: string): Promise<string> {
  if (id.length <= 40) return id
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id))
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `sha256-${hex.slice(0, 32)}`
}

async function writerId(auth: AuthContext): Promise<string> {
  return stampableId(auth.boundAgentId ?? auth.memberId ?? auth.userId)
}

const toolProjectWikiUpsert: ToolSpec = {
  name: 'project_wiki_upsert',
  scope: "project wiki (write). tier 'squad' pages are readable and writable only by members of a squad with access to the project (org admins too); tier 'project' pages are visible to every project reader. Optional markdown body (<=65536 bytes; refused over the cap, never truncated; a store that cannot hold bodies answers 501 body_unsupported). Links are additive (never removed; relation change adds a second link). Text is whitespace-collapsed; summary is 500 chars max",
  min: 'member',
  args:
    '{ project_id: string, slug: string, title: string, summary: string(<=500), body?: string(markdown, <=65536 bytes), purpose: string, tier: "project"|"squad", tags?: string[], links?: [{to_slug, relation?}] }',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: STRING_SCHEMA,
      slug: STRING_SCHEMA,
      title: STRING_SCHEMA,
      summary: STRING_SCHEMA,
      body: STRING_SCHEMA,
      purpose: STRING_SCHEMA,
      tier: { type: 'string', enum: ['project', 'squad'] },
      tags: { type: 'array', items: STRING_SCHEMA },
      links: {
        type: 'array',
        items: {
          type: 'object',
          properties: { to_slug: STRING_SCHEMA, relation: STRING_SCHEMA },
          required: ['to_slug'],
          additionalProperties: false,
        },
      },
    },
    required: ['project_id', 'slug', 'title', 'summary', 'purpose', 'tier'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const projectId = str(args.project_id)
    if (!projectId) return fail(400, 'invalid_args', 'project_id required')
    const checked = validatePageWrite({
      slug: args.slug, title: args.title, summary: args.summary, body: args.body, purpose: args.purpose,
      tier: args.tier, tags: args.tags, links: args.links,
    })
    if (!checked.ok) return fail(checked.status, checked.error, checked.detail)

    const project = await readableProject(env, projectId, readAccess(auth))
    if (!project) return fail(404, 'project_not_found')
    if (!(await callerCanWriteProject(env, auth, project.id))) {
      return fail(403, 'forbidden', { need: 'project_write', scope: 'project' })
    }

    const out = await writePage(env, pagesPortFactory.create(env), {
      projectId: project.id,
      writer: await writerId(auth),
      input: checked.value,
      canSeeSquadPages: await callerHasSquadAccessToProject(env, readAccess(auth), project.id),
    })
    if (!out.ok) return fail(out.status, out.error, out.detail)
    return done({
      project_id: project.id,
      slug: out.slug,
      result: out.created ? 'created' : 'updated',
      version: out.version,
      owner: out.envelope.owner,
      writer: out.envelope.writer,
      tier: out.envelope.tier,
      written_at: out.envelope.writtenAt,
      links_written: out.linksWritten,
      url: `/projects/${encodeURIComponent(project.id)}/wiki#wiki-topic-${out.slug}`,
    })
  },
}

const toolProjectWikiGet: ToolSpec = {
  name: 'project_wiki_get',
  scope: "visible workspace project; squad-tier pages are returned only to members of a squad with access to the project. Returns the markdown body (null when none) and the pages linking to this slug",
  min: 'observer',
  args: '{ project_id: string, slug: string }',
  inputSchema: {
    type: 'object',
    properties: { project_id: STRING_SCHEMA, slug: STRING_SCHEMA },
    required: ['project_id', 'slug'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const projectId = str(args.project_id)
    if (!projectId) return fail(400, 'invalid_args', 'project_id required')
    const slug = str(args.slug)
    if (!slug || !PAGE_SLUG_RE.test(slug)) return fail(400, 'invalid_args', 'slug must be lowercase kebab, 3-63 chars')
    const project = await readableProject(env, projectId, readAccess(auth))
    if (!project) return fail(404, 'project_not_found')
    try {
      const port = pagesPortFactory.create(env)
      // Squad-tier visibility is decided in the service BEFORE anything is returned; a hidden page is page_not_found.
      const canSeeSquadPages = await callerHasSquadAccessToProject(env, readAccess(auth), project.id)
      const page = await readPage(port, { projectId: project.id, slug, canSeeSquadPages })
      if (!page) return fail(404, 'page_not_found')
      const backlinks = filterBacklinks(await port.listBacklinks(project.id, slug), canSeeSquadPages)
      return done({
        project_id: project.id,
        page: {
          slug: page.slug,
          title: page.title,
          summary: page.summary,
          body: page.body ?? null,
          tags: page.tags,
          links: page.links.map((l) => ({ to_slug: l.toSlug, relation: l.relation })),
          envelope: page.envelope,
          reserved: isReservedSlug(page.slug),
          backlinks: backlinks.map((b) => ({ slug: b.slug, title: b.title, relation: b.relation, tier: b.tier })),
        },
      })
    } catch (e) {
      if (e instanceof PagesPortError) return fail(e.kind === 'unavailable' ? 503 : 502, e.kind === 'unavailable' ? 'wiki_unavailable' : 'wiki_request_rejected')
      throw e
    }
  },
}

export const PAGES_TOOLS: ToolSpec[] = [toolProjectWikiUpsert, toolProjectWikiGet]
