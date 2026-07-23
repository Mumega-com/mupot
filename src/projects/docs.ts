// Project docs surface — reads/writes the SAME store as project_remember /
// project_recall (engrams + Vectorize under projectMemoryScope). A doc write
// teaches the mubot; a project_remember lesson surfaces in the docs list.
// No second docs table (v0.24 single-source-of-truth).

import type { Env } from '../types'
import { createMemory } from '../memory'
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

export async function writeProjectDoc(
  env: Env,
  projectId: string,
  text: string,
  concepts: string[] | null,
): Promise<ProjectDoc> {
  const scope = projectMemoryScope(projectId)
  const id = await createMemory(env).remember(
    scope,
    text,
    concepts === null ? undefined : concepts,
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
