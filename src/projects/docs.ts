// Project docs surface — reads/writes the SAME store as project_remember /
// project_recall (engrams + Vectorize under projectMemoryScope). A doc write
// teaches the mubot; a project_remember lesson surfaces in the docs list.
// No second docs table (v0.24 single-source-of-truth).
//
// Slice 3: list/search is ALWAYS filtered through checkContentTier for the
// viewer’s claim set — items above the viewer’s tier are omitted from the
// payload (not merely CSS-hidden).

import type { AuthContext, Env } from '../types'
import {
  checkContentTier,
  claimsFromAgentToken,
  claimsFromHumanSession,
  type ContentTier,
  type ContentTierContext,
  type TierClaims,
} from '../docs/content-tier'
import { createMemory } from '../memory'
import type { ProjectReadAccess } from './access'
import { projectMemoryScope } from './memory-scope'

export interface ProjectDoc {
  id: string
  text: string
  concepts: string[] | null
  created_at: string
  scope: string
}

interface EngramListRow {
  id: string
  text: string
  concepts: string | null
  created_at: string
}

const CONTENT_TIERS: ReadonlySet<string> = new Set([
  'public',
  'squad',
  'project',
  'role',
  'entity',
  'private',
])

const TIER_PREFIX = 'tier:'
const ENTITY_PREFIX = 'entity_id:'
const CREATED_BY_PREFIX = 'created_by:'
const PERMITTED_ROLE_PREFIX = 'permitted_role:'

/** Scan ceiling before RBAC+search trim — avoids leaking denied rows via limit padding. */
const DOCS_SCAN_LIMIT = 500

function parseConcepts(raw: string | null): string[] | null {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    const concepts = parsed.filter((item): item is string => typeof item === 'string')
    return concepts.length > 0 ? concepts : null
  } catch {
    throw new Error('project docs: engram concepts JSON is invalid')
  }
}

function isContentTier(value: string): value is ContentTier {
  return CONTENT_TIERS.has(value)
}

function isReservedConcept(concept: string): boolean {
  return (
    concept.startsWith(TIER_PREFIX) ||
    concept.startsWith(ENTITY_PREFIX) ||
    concept.startsWith(CREATED_BY_PREFIX) ||
    concept.startsWith(PERMITTED_ROLE_PREFIX)
  )
}

/** Decode Inkwell-style tier fields stored as concept tags on the engram. */
export function tierContextFromConcepts(concepts: string[] | null): ContentTierContext {
  let tier: ContentTier = 'public'
  let entity_id: string | undefined
  let created_by: string | undefined
  const permitted_roles: string[] = []

  for (const concept of concepts ?? []) {
    if (concept.startsWith(TIER_PREFIX)) {
      const value = concept.slice(TIER_PREFIX.length)
      if (isContentTier(value)) tier = value
      continue
    }
    if (concept.startsWith(ENTITY_PREFIX)) {
      entity_id = concept.slice(ENTITY_PREFIX.length)
      continue
    }
    if (concept.startsWith(CREATED_BY_PREFIX)) {
      created_by = concept.slice(CREATED_BY_PREFIX.length)
      continue
    }
    if (concept.startsWith(PERMITTED_ROLE_PREFIX)) {
      const role = concept.slice(PERMITTED_ROLE_PREFIX.length)
      if (role.length > 0) permitted_roles.push(role)
    }
  }

  const ctx: ContentTierContext = { tier }
  if (entity_id !== undefined) ctx.entity_id = entity_id
  if (created_by !== undefined) ctx.created_by = created_by
  if (permitted_roles.length > 0) ctx.permitted_roles = permitted_roles
  return ctx
}

/** Encode tier fields into concept tags (strips any prior reserved tags). */
export function conceptsWithTiers(
  concepts: string[] | null,
  tier: ContentTierContext,
): string[] {
  const base = (concepts ?? []).filter((concept) => !isReservedConcept(concept))
  const encoded: string[] = [`${TIER_PREFIX}${tier.tier}`]
  if (tier.entity_id !== undefined && tier.entity_id.length > 0) {
    encoded.push(`${ENTITY_PREFIX}${tier.entity_id}`)
  }
  if (tier.created_by !== undefined && tier.created_by.length > 0) {
    encoded.push(`${CREATED_BY_PREFIX}${tier.created_by}`)
  }
  for (const role of tier.permitted_roles ?? []) {
    if (role.length > 0) encoded.push(`${PERMITTED_ROLE_PREFIX}${role}`)
  }
  return [...base, ...encoded]
}

/**
 * Normalize AuthContext → TierClaims for a project docs viewer.
 * Human and agent principals share one path; principal kind is discarded.
 * `project_id` is set because the caller already passed project read access.
 */
export function viewerClaimsForProject(
  auth: AuthContext,
  projectId: string,
  access: ProjectReadAccess,
): TierClaims {
  const squad_id = access.squadIds[0]
  if (auth.boundAgentId) {
    return claimsFromAgentToken({
      agent_id: auth.boundAgentId,
      user_id: auth.userId,
      role: auth.role,
      project_id: projectId,
      squad_id: squad_id,
      capabilities: (auth.capabilities ?? []).map(
        (grant) => `${grant.scope_type}:${grant.capability}`,
      ),
    })
  }
  return claimsFromHumanSession({
    identityId: auth.userId,
    user_id: auth.memberId ?? auth.userId,
    role: auth.role,
    project_id: projectId,
    squad_id: squad_id,
  })
}

/** Server-side RBAC filter — denied docs are dropped from the array. */
export function filterDocsForViewer(
  docs: readonly ProjectDoc[],
  claims: TierClaims | null,
): ProjectDoc[] {
  const visible: ProjectDoc[] = []
  for (const doc of docs) {
    const result = checkContentTier(tierContextFromConcepts(doc.concepts), claims)
    if (!result.allowed) continue
    visible.push(doc)
  }
  return visible
}

function docMatchesSearch(doc: ProjectDoc, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return true
  if (doc.text.toLowerCase().includes(needle)) return true
  for (const concept of doc.concepts ?? []) {
    if (concept.toLowerCase().includes(needle)) return true
  }
  return false
}

export async function writeProjectDoc(
  env: Env,
  projectId: string,
  text: string,
  concepts: string[] | null,
  tier: ContentTierContext | null,
): Promise<ProjectDoc> {
  const scope = projectMemoryScope(projectId)
  const storedConcepts =
    tier === null ? concepts : conceptsWithTiers(concepts, tier)
  const id = await createMemory(env).remember(
    scope,
    text,
    storedConcepts === null || storedConcepts.length === 0 ? undefined : storedConcepts,
  )
  const row = await env.DB.prepare(
    `SELECT id, text, concepts, created_at
       FROM engrams
      WHERE id = ? AND agent_id = ?`,
  )
    .bind(id, scope)
    .first<EngramListRow>()
  if (!row) {
    throw new Error('project docs: engram missing after remember')
  }
  return {
    id: row.id,
    text: row.text,
    concepts: parseConcepts(row.concepts),
    created_at: row.created_at,
    scope,
  }
}

export async function listProjectDocs(
  env: Env,
  projectId: string,
  limit: number,
): Promise<{ docs: ProjectDoc[]; scope: string }> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('project docs: limit must be a positive integer')
  }
  const scope = projectMemoryScope(projectId)
  const rows = await env.DB.prepare(
    `SELECT id, text, concepts, created_at
       FROM engrams
      WHERE agent_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
  )
    .bind(scope, limit)
    .all<EngramListRow>()

  const docs: ProjectDoc[] = []
  for (const row of rows.results ?? []) {
    docs.push({
      id: row.id,
      text: row.text,
      concepts: parseConcepts(row.concepts),
      created_at: row.created_at,
      scope,
    })
  }
  return { docs, scope }
}

/**
 * List + search project docs visible to the viewer’s claim set.
 * RBAC runs before the response is built — denied items are never returned.
 */
export async function listVisibleProjectDocs(
  env: Env,
  projectId: string,
  claims: TierClaims | null,
  limit: number,
  query: string,
): Promise<{ docs: ProjectDoc[]; scope: string }> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('project docs: limit must be a positive integer')
  }
  const listed = await listProjectDocs(env, projectId, DOCS_SCAN_LIMIT)
  const visible: ProjectDoc[] = []
  for (const doc of filterDocsForViewer(listed.docs, claims)) {
    if (!docMatchesSearch(doc, query)) continue
    visible.push(doc)
    if (visible.length >= limit) break
  }
  return { docs: visible, scope: listed.scope }
}
