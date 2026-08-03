// mupot — Linear ↔ pot bridge (flight-20260803-linear-posthog).
//
// STRUCTURAL SAFETY CONTRACT — read this before touching this file:
//
// A PRIORITY SURFACE MUST NEVER BE AN AUTHORIZATION SURFACE. Linear state may PROPOSE
// mupot work; it must NEVER wake an agent, authorize execution, dispatch a task, or
// carry an approval. Unlike src/integrations/github-projects.ts (which resolves a
// GitHub Project field value to a specific pot AGENT and lets task.created wake that
// agent's squad), this file:
//
//   1. NEVER maps any Linear field (assignee, label, state, etc.) to a mupot agent.
//      `assigneeHint` below is carried for DISPLAY ONLY (see it in BoardItem.assignee_hint)
//      and is never read by importLinearIssues to select who does the work.
//   2. Routes every imported task to a squad chosen by a mupot ADMIN at bind time
//      (binding.meta_json.defaultSquadId — set via the existing project-binding admin
//      route, never derived from Linear data), never to an individual agent
//      (assignee_agent_id is always null).
//   3. Creates tasks with `skipEvent: true` — no `task.created` bus event, so
//      bus/consumer.ts's dispatchSquad() (the actual "wake" mechanism, see its
//      `case 'task.created'` handler) never fires for a Linear-origin task. The task
//      lands on the board in 'open' status — inert until a human or the existing
//      squad-ceremony/gate flow picks it up through the SAME path any manually filed
//      task goes through. That is the entire meaning of "propose, never authorize."
//   4. Creates tasks with `skipMirror: true` — never writes a GitHub issue mirror from
//      Linear-sourced (external, less-trusted) title/body text, for the same reason
//      GitHub webhook-origin tasks skip the mirror (src/tasks/service.ts).
//   5. Issues ONLY read (query) GraphQL operations against Linear — LINEAR_ISSUES_QUERY
//      below contains no `mutation`. The vault connector type 'linear' has no write-back
//      caller anywhere in the codebase; there is no tool that could turn a resolved
//      Linear credential into a write against Linear.
//
// Credentials: connector type 'linear' (vault, src/connectors/service.ts). The
// decrypted key is used only inside useConnectorById's one-shot authenticatedFetch
// capability — this file never sees the plaintext secret.

import type { Env } from '../types'
import { useConnectorById } from '../connectors/service'
import { createTask } from '../tasks/service'

const LINEAR_API = 'https://api.linear.app/graphql'
const LINEAR_TIMEOUT_MS = 8_000

// Linear team keys are short identifiers (e.g. "ENG"); accept 1-10 alphanumerics.
const TEAM_KEY_RE = /^[A-Za-z0-9]{1,10}$/

export interface LinearIssueItem {
  readonly id: string
  readonly identifier: string // e.g. "ENG-123"
  readonly title: string
  readonly url: string | null
  readonly state: string | null
  /** Display-only. NEVER used to resolve a mupot agent — see file header. */
  readonly assigneeHint: string | null
}

export type LinearImportResult = {
  ok: boolean
  imported: number
  skipped: number
  items: Array<{ title: string; status: 'created' | 'skipped' | 'no_squad' | 'error' }>
  error?: string
}

interface LinearMetaEnv {
  SESSIONS?: { get(k: string): Promise<string | null>; put(k: string, v: string, o?: { expirationTtl?: number }): Promise<void> }
}

// ── GraphQL — READ ONLY. No `mutation` keyword may ever appear in this file. ────────

export const LINEAR_ISSUES_QUERY = `query($key: String!) {
  teams(filter: { key: { eq: $key } }) {
    nodes {
      id
      name
      issues(first: 100) {
        nodes {
          id
          identifier
          title
          url
          state { name }
          assignee { name }
        }
      }
    }
  }
}`

/** Pure parser — exported for tests. */
export function parseLinearIssues(data: unknown): LinearIssueItem[] {
  const teamNodes = ((data as { teams?: { nodes?: unknown[] } })?.teams?.nodes ?? []) as Array<Record<string, unknown>>
  const team = teamNodes[0]
  if (!team) return []
  const issueNodes = ((team.issues as { nodes?: unknown[] } | undefined)?.nodes ?? []) as Array<Record<string, unknown>>
  const out: LinearIssueItem[] = []
  for (const n of issueNodes) {
    const id = typeof n.id === 'string' ? n.id : ''
    if (!id) continue
    const state = (n.state as { name?: unknown } | undefined)?.name
    const assignee = (n.assignee as { name?: unknown } | undefined)?.name
    out.push({
      id,
      identifier: typeof n.identifier === 'string' ? n.identifier : '(unknown)',
      title: typeof n.title === 'string' ? n.title.slice(0, 200) : '(untitled)',
      url: typeof n.url === 'string' ? n.url : null,
      state: typeof state === 'string' ? state : null,
      assigneeHint: typeof assignee === 'string' ? assignee : null,
    })
  }
  return out
}

/** Parse `defaultSquadId` out of a project_provider_bindings.meta_json blob. Admin-set only. */
export function defaultSquadIdFromMeta(metaJson: string): string | null {
  try {
    const meta = JSON.parse(metaJson) as { defaultSquadId?: unknown }
    return typeof meta.defaultSquadId === 'string' && meta.defaultSquadId.trim() ? meta.defaultSquadId.trim() : null
  } catch {
    return null
  }
}

/**
 * Read a Linear team's issues through the vault connector. Read-only: the only
 * outbound call is a `query` GraphQL POST. Fail-closed on any credential, network,
 * or shape problem — never a fabricated list.
 */
export async function fetchLinearIssues(
  env: Env,
  connectorId: string,
  teamKey: string,
): Promise<{ ok: true; items: LinearIssueItem[] } | { ok: false; error: string }> {
  const key = teamKey.trim()
  if (!TEAM_KEY_RE.test(key)) return { ok: false, error: 'invalid_external_id' }

  const snapshot = await useConnectorById(env, connectorId, 'linear', async (connector) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), LINEAR_TIMEOUT_MS)
    try {
      const response = await connector.authenticatedFetch(LINEAR_API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: LINEAR_ISSUES_QUERY, variables: { key } }),
        redirect: 'manual',
        signal: controller.signal,
      })
      const isRedirect = (response.type as string) === 'opaqueredirect' || (response.status >= 300 && response.status < 400)
      if (isRedirect || !response.ok) {
        return { status: 'failed' as const, observations: [], reason: 'linear_unavailable' }
      }
      const json = (await response.json()) as { data?: unknown; errors?: unknown }
      if (json.errors || !json.data) {
        return { status: 'failed' as const, observations: [], reason: 'linear_unavailable' }
      }
      return { status: 'available' as const, observations: [json.data as unknown] }
    } catch {
      return { status: 'failed' as const, observations: [], reason: 'linear_unavailable' }
    } finally {
      clearTimeout(timer)
    }
  })

  if (!snapshot) return { ok: false, error: 'connector_unavailable' } // no vault credential / revoked / wrong tenant
  if (snapshot.status !== 'available') return { ok: false, error: snapshot.reason ?? 'linear_unavailable' }
  return { ok: true, items: parseLinearIssues(snapshot.observations[0]) }
}

/**
 * Import a Linear team's issues as UNASSIGNED mupot tasks on the ADMIN-configured
 * squad (never an agent — see file header). `dryRun` reports without writing.
 * Idempotent via KV dedup (`linearitem:<issueId>`), same shape as the GitHub bridge.
 */
export async function importLinearIssues(
  env: Env,
  params: {
    connectorId: string
    teamKey: string
    defaultSquadId: string | null
    dryRun?: boolean
    projectId?: string | null
  },
): Promise<LinearImportResult> {
  const empty: LinearImportResult = { ok: false, imported: 0, skipped: 0, items: [] }
  const fetched = await fetchLinearIssues(env, params.connectorId, params.teamKey)
  if (!fetched.ok) return { ...empty, error: fetched.error }

  if (!params.defaultSquadId) {
    // No admin-configured squad to route to — every item is reported, none imported.
    // This is the fail-closed default: absent explicit mupot-side configuration, Linear
    // data creates NOTHING. It never falls back to reading an assignee off the issue.
    return {
      ok: true,
      imported: 0,
      skipped: 0,
      items: fetched.items.map((it) => ({ title: it.title, status: 'no_squad' as const })),
    }
  }

  const kv = (env as unknown as LinearMetaEnv).SESSIONS
  const result: LinearImportResult = { ok: true, imported: 0, skipped: 0, items: [] }

  for (const it of fetched.items) {
    const dedupKey = `linearitem:${it.id}`
    if (kv) {
      try {
        if (await kv.get(dedupKey)) {
          result.skipped++
          result.items.push({ title: it.title, status: 'skipped' })
          continue
        }
      } catch {
        // ignore — proceed to import (best-effort dedup, same as GitHub bridge)
      }
    }
    if (!params.dryRun) {
      try {
        await createTask(
          env,
          {
            squad_id: params.defaultSquadId,
            project_id: params.projectId ?? null,
            title: it.title,
            body: [it.url, `from Linear (${it.identifier})`].filter(Boolean).join('\n'),
            done_when: `Linear issue ${it.identifier} resolved`,
            status: 'open',
            // Structural enforcement, not a default: NEVER set from Linear data.
            assignee_agent_id: null,
          },
          {
            // No task.created bus event → bus/consumer.ts dispatchSquad() never runs
            // for a Linear-origin task. No GitHub issue mirror of external text either.
            skipEvent: true,
            skipMirror: true,
          },
        )
      } catch {
        result.items.push({ title: it.title, status: 'error' })
        continue
      }
      if (kv) {
        try {
          await kv.put(dedupKey, '1', { expirationTtl: 60 * 60 * 24 * 30 })
        } catch {
          // ignore
        }
      }
    }
    result.imported++
    result.items.push({ title: it.title, status: 'created' })
  }
  return result
}
