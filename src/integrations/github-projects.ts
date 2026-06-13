// mupot — GitHub Projects v2 ↔ pot bridge (#22).
//
// You manage work on a familiar GitHub Project board; the pot reads it and routes each item
// to the named agent it's assigned to. GitHub App bots can't be REST assignees, so an item is
// "assigned to an agent" via a single-select/text project field (default name "Agent") whose
// value matches a pot agent's slug or name. The pot imports such items as tasks, assigned to
// that agent — then the own-fleet executor (executeTaskAsPR) ships the work, authored as that
// agent (#21), and links the PR back. The pot is the bridge: Project ↔ pot tasks ↔ agents.
//
// Requires the App to have Projects: read. Without it the GraphQL errors → projects_unavailable
// (fail-closed). Read-only against GitHub; the only writes are pot tasks (this tenant's D1).
// Dedup: each imported item id is recorded in KV so re-running the import is idempotent.

import type { Env } from '../types'
import { resolveOutboundGitHubToken } from './github-app'
import { createTask } from '../tasks/service'

const GITHUB_API = 'https://api.github.com'

const LOGIN_RE = /^[A-Za-z0-9-]{1,39}$/ // GitHub org/user login

export interface ProjectImportItem {
  itemId: string
  number: number | null
  title: string
  url: string | null
  agentValue: string | null // the "Agent" field value, or null
}

export type ProjectImportResult = {
  ok: boolean
  imported: number
  skipped: number
  items: Array<{ title: string; agent: string | null; status: 'created' | 'skipped' | 'no_agent' | 'unknown_agent' }>
  error?: string
}

interface ProjectsEnv {
  SESSIONS?: { get(k: string): Promise<string | null>; put(k: string, v: string, o?: { expirationTtl?: number }): Promise<void> }
}

// ── GraphQL query (exported for tests) ──────────────────────────────────────────────

export const PROJECT_ITEMS_QUERY = `query($owner:String!,$number:Int!){
  organization(login:$owner){
    projectV2(number:$number){
      items(first:50){
        nodes{
          id
          content{
            __typename
            ... on Issue { number title url }
            ... on PullRequest { number title url }
          }
          fieldValues(first:20){
            nodes{
              __typename
              ... on ProjectV2ItemFieldSingleSelectValue { name field{ ... on ProjectV2FieldCommon { name } } }
              ... on ProjectV2ItemFieldTextValue { text field{ ... on ProjectV2FieldCommon { name } } }
            }
          }
        }
      }
    }
  }
}`

/**
 * Parse a Projects v2 GraphQL response into flat import items, pulling the value of the
 * field named `agentField` (case-insensitive). Pure — exported for tests.
 */
export function parseProjectItems(data: unknown, agentField: string): ProjectImportItem[] {
  const nodes =
    ((data as { organization?: { projectV2?: { items?: { nodes?: unknown[] } } } })?.organization?.projectV2?.items
      ?.nodes ?? []) as Array<Record<string, unknown>>
  const want = agentField.trim().toLowerCase()
  const out: ProjectImportItem[] = []
  for (const n of nodes) {
    const id = typeof n.id === 'string' ? n.id : ''
    if (!id) continue
    const content = (n.content ?? {}) as { number?: number; title?: string; url?: string }
    const fvNodes = ((n.fieldValues as { nodes?: unknown[] })?.nodes ?? []) as Array<Record<string, unknown>>
    let agentValue: string | null = null
    for (const fv of fvNodes) {
      const fname = ((fv.field as { name?: string })?.name ?? '').trim().toLowerCase()
      if (fname !== want) continue
      const v = typeof fv.name === 'string' ? fv.name : typeof fv.text === 'string' ? fv.text : null
      if (v) agentValue = v.trim()
    }
    out.push({
      itemId: id,
      number: Number.isInteger(content.number) ? (content.number as number) : null,
      title: typeof content.title === 'string' ? content.title.slice(0, 200) : '(untitled)',
      url: typeof content.url === 'string' ? content.url : null,
      agentValue,
    })
  }
  return out
}

// ── agent resolution ──────────────────────────────────────────────────────────────

/** Resolve an Agent-field value to a pot agent {id, squad_id} by slug or name (case-insensitive). */
async function resolveAgentByValue(env: Env, value: string): Promise<{ id: string; squad_id: string | null } | null> {
  const v = value.trim().toLowerCase()
  if (!v) return null
  const row = await env.DB.prepare(
    `SELECT id, squad_id FROM agents WHERE LOWER(slug) = ?1 OR LOWER(name) = ?1 LIMIT 1`,
  )
    .bind(v)
    .first<{ id: string; squad_id: string | null }>()
  return row ?? null
}

// ── scheduled / webhook sync entry ────────────────────────────────────────────────

interface SyncEnv {
  GITHUB_SYNC_PROJECT?: string // "owner/number" — the board this pot auto-syncs
}

/**
 * Parse GITHUB_SYNC_PROJECT ("owner/number") into its parts, or null if unset/invalid.
 */
export function parseSyncProject(raw: unknown): { owner: string; projectNumber: number } | null {
  if (typeof raw !== 'string') return null
  const m = raw.trim().match(/^([A-Za-z0-9-]{1,39})\/(\d{1,10})$/)
  if (!m) return null
  return { owner: m[1], projectNumber: Number(m[2]) }
}

/**
 * Cron / webhook sync entry (#23): reconcile the configured GitHub Project board → pot tasks.
 * No-op (ok:false, reason) when no board is configured — so the cron stays cheap on pots that
 * don't use GitHub Projects. Idempotent (importProjectItems is KV-deduped).
 */
export async function syncGitHubProject(
  env: Env,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<{ ok: boolean; reason?: string; imported?: number; skipped?: number }> {
  const cfg = parseSyncProject((env as unknown as SyncEnv).GITHUB_SYNC_PROJECT)
  if (!cfg) return { ok: false, reason: 'not_configured' }
  const res = await importProjectItems(env, { owner: cfg.owner, projectNumber: cfg.projectNumber }, opts)
  if (!res.ok) return { ok: false, reason: res.error }
  return { ok: true, imported: res.imported, skipped: res.skipped }
}

// ── the import ───────────────────────────────────────────────────────────────────────

/**
 * Read a GitHub org Project v2 board and import each item assigned to a known pot agent as a
 * task routed to that agent. Idempotent (KV-deduped per item id). `dryRun` reports without
 * creating tasks. Fail-closed if Projects read is unavailable.
 */
export async function importProjectItems(
  env: Env,
  params: { owner: string; projectNumber: number; agentField?: string; dryRun?: boolean },
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<ProjectImportResult> {
  const agentField = params.agentField?.trim() || 'Agent'
  const empty: ProjectImportResult = { ok: false, imported: 0, skipped: 0, items: [] }
  if (!LOGIN_RE.test(params.owner)) return { ...empty, error: 'invalid_owner' }
  if (!Number.isInteger(params.projectNumber) || params.projectNumber <= 0) return { ...empty, error: 'invalid_project' }

  const token = await resolveOutboundGitHubToken(env, opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : undefined)
  if (!token) return { ...empty, error: 'no_token' }
  const doFetch = opts.fetchImpl ?? fetch

  let data: unknown
  try {
    const res = await doFetch(`${GITHUB_API}/graphql`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'mupot',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: PROJECT_ITEMS_QUERY, variables: { owner: params.owner, number: params.projectNumber } }),
    })
    if (!res.ok) return { ...empty, error: res.status === 403 || res.status === 401 ? 'projects_unavailable' : `query_failed_${res.status}` }
    const json = (await res.json()) as { data?: unknown; errors?: unknown }
    if (json.errors || !json.data) return { ...empty, error: 'projects_unavailable' }
    data = json.data
  } catch {
    return { ...empty, error: 'query_threw' }
  }

  const items = parseProjectItems(data, agentField)
  const kv = (env as unknown as ProjectsEnv).SESSIONS
  const result: ProjectImportResult = { ok: true, imported: 0, skipped: 0, items: [] }

  for (const it of items) {
    if (!it.agentValue) {
      result.items.push({ title: it.title, agent: null, status: 'no_agent' })
      continue
    }
    const agent = await resolveAgentByValue(env, it.agentValue)
    if (!agent) {
      result.items.push({ title: it.title, agent: it.agentValue, status: 'unknown_agent' })
      continue
    }
    // dedup: skip items already imported (best-effort; KV outage → import)
    const dedupKey = `ghitem:${it.itemId}`
    if (kv) {
      try {
        if (await kv.get(dedupKey)) {
          result.skipped++
          result.items.push({ title: it.title, agent: it.agentValue, status: 'skipped' })
          continue
        }
      } catch {
        // ignore — proceed to import
      }
    }
    if (!agent.squad_id) {
      result.items.push({ title: it.title, agent: it.agentValue, status: 'unknown_agent' })
      continue
    }
    if (!params.dryRun) {
      await createTask(
        env,
        {
          squad_id: agent.squad_id,
          title: it.title,
          body: [it.url, `from GitHub Project (item ${it.itemId})`].filter(Boolean).join('\n'),
          // #142: GitHub Project sync — predicate is the GH issue itself closing.
          done_when: `GitHub Project item ${it.itemId} closed`,
          status: 'open',
          assignee_agent_id: agent.id,
        },
        { skipMirror: true },
      )
      if (kv) {
        try {
          await kv.put(dedupKey, '1', { expirationTtl: 60 * 60 * 24 * 30 })
        } catch {
          // ignore
        }
      }
    }
    result.imported++
    result.items.push({ title: it.title, agent: it.agentValue, status: 'created' })
  }
  return result
}
