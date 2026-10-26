// mupot — Linear OUTBOUND writes (flight board-two-way, S3).
//
// THE RULE (evolved from linear-issues.ts's "propose, never authorize"): mupot writes to Linear only what
// mupot's own records prove. Concretely, and enforced HERE (defense in depth: the dispatcher in
// projects/board-writeback.ts also checks, and so do its tests):
//
//   - the only mutations in this codebase are `issueUpdate{stateId}` and `commentCreate`. There is no delete,
//     no archive, no assignee/label/team change, and no way to build one from a caller argument.
//   - a status move requires a TransitionReceipt, and maps ONLY: submitted -> in_review, approved -> done,
//     rejected -> in_progress. 'approved' and 'rejected' additionally require receipt.gate_owner (a gated
//     verdict). No receipt, or a verdict receipt without a gate, writes nothing.
//   - the issue must belong to the binding's team (re-read from Linear before any write), so a tampered link
//     cannot reach another team's issue.
//   - a human's Canceled state is never overridden, and 'done' only targets a state of type `completed`.
//   - the credential is the vault `linear` connector, used one call at a time inside useConnectorById. Nothing
//     here reads, returns, logs or stores it; errors are opaque codes, never response bodies.
//   - the per-binding state map lives in binding meta (`meta.stateMap`, names only). It never holds a secret.

import type { Env } from '../types'
import { useConnectorById } from '../connectors/service'
import type {
  BoardItemRef,
  BoardTaskRef,
  ProjectProviderBinding,
  TransitionReceipt,
  WritebackResult,
} from '../projects/providers/port'

const LINEAR_API = 'https://api.linear.app/graphql'
const LINEAR_TIMEOUT_MS = 8_000
const COMMENT_MAX = 1_000

export type StateKey = 'in_review' | 'in_progress' | 'done'

export const DEFAULT_STATE_NAMES: Readonly<Record<StateKey, string>> = Object.freeze({
  in_review: 'In Review',
  in_progress: 'In Progress',
  done: 'Done',
})

/** The ONLY transition -> state mapping. Closed on purpose: a provider config cannot add a transition. */
export function stateKeyForReceipt(receipt: TransitionReceipt): StateKey | null {
  switch (receipt.kind) {
    case 'submitted':
      return 'in_review'
    case 'approved':
      return 'done'
    case 'rejected':
      return 'in_progress'
    default:
      return null
  }
}

/** Names only, 1..64 chars, keys limited to StateKey. Anything else falls back to the default name. */
export function stateMapFromMeta(metaJson: string): Record<StateKey, string> {
  const out: Record<StateKey, string> = { ...DEFAULT_STATE_NAMES }
  try {
    const meta = JSON.parse(metaJson) as { stateMap?: Record<string, unknown> }
    const map = meta.stateMap
    if (map && typeof map === 'object') {
      for (const key of Object.keys(DEFAULT_STATE_NAMES) as StateKey[]) {
        const v = map[key]
        if (typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= 64) out[key] = v.trim()
      }
    }
  } catch {
    // keep defaults
  }
  return out
}

export const LINEAR_ISSUE_STATES_QUERY = `query($id: String!) {
  issue(id: $id) {
    id
    team { key states { nodes { id name type } } }
    state { id name type }
  }
}`

export const LINEAR_ISSUE_UPDATE_MUTATION = `mutation($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) { success }
}`

export const LINEAR_COMMENT_MUTATION = `mutation($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) { success }
}`

type GraphqlResult = { ok: true; data: Record<string, unknown> } | { ok: false; error: string }

/** One GraphQL call through the vault connector. The connector allows exactly one fetch per use. */
async function linearGraphql(
  env: Env,
  connectorId: string,
  query: string,
  variables: Record<string, string>,
): Promise<GraphqlResult> {
  const snapshot = await useConnectorById(env, connectorId, 'linear', async (connector) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), LINEAR_TIMEOUT_MS)
    try {
      const response = await connector.authenticatedFetch(LINEAR_API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        redirect: 'manual',
        signal: controller.signal,
      })
      const isRedirect = (response.type as string) === 'opaqueredirect' || (response.status >= 300 && response.status < 400)
      if (isRedirect || !response.ok) return { status: 'failed' as const, observations: [], reason: 'linear_unavailable' }
      const json = (await response.json()) as { data?: unknown; errors?: unknown }
      if (json.errors || !json.data || typeof json.data !== 'object') {
        return { status: 'failed' as const, observations: [], reason: 'linear_rejected' }
      }
      return { status: 'available' as const, observations: [json.data as unknown] }
    } catch {
      return { status: 'failed' as const, observations: [], reason: 'linear_unavailable' }
    } finally {
      clearTimeout(timer)
    }
  })
  if (!snapshot) return { ok: false, error: 'connector_unavailable' }
  if (snapshot.status !== 'available') return { ok: false, error: snapshot.reason ?? 'linear_unavailable' }
  return { ok: true, data: snapshot.observations[0] as Record<string, unknown> }
}

interface StateNode { id: string; name: string; type: string }

function parseIssueStates(data: Record<string, unknown>): {
  teamKey: string
  states: StateNode[]
  current: StateNode | null
} | null {
  const issue = data.issue as { team?: { key?: unknown; states?: { nodes?: unknown[] } }; state?: unknown } | null | undefined
  if (!issue || typeof issue !== 'object') return null
  const teamKey = issue.team?.key
  if (typeof teamKey !== 'string') return null
  const asNode = (n: unknown): StateNode | null => {
    const o = n as { id?: unknown; name?: unknown; type?: unknown } | null
    return o && typeof o.id === 'string' && typeof o.name === 'string' && typeof o.type === 'string'
      ? { id: o.id, name: o.name, type: o.type }
      : null
  }
  const states = (issue.team?.states?.nodes ?? []).map(asNode).filter((n): n is StateNode => n !== null)
  return { teamKey, states, current: asNode(issue.state) }
}

export function sanitizeComment(text: string): string {
  // No control characters; bounded. Markdown is allowed by Linear, so the text is composed by mupot only.
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, COMMENT_MAX)
}

export function isHttpsUrl(url: string): boolean {
  if (url.length > 500) return false
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.username === '' && u.password === ''
  } catch {
    return false
  }
}

export async function linearPushStatus(
  env: Env,
  binding: ProjectProviderBinding,
  task: BoardTaskRef,
  receipt: TransitionReceipt,
): Promise<WritebackResult> {
  if (!binding.connector_id) return { ok: false, error: 'connector_required' }
  // Receipt gate. These are the provider's own refusals, independent of whatever the dispatcher checked.
  if (!receipt || typeof receipt.receipt_id !== 'string' || receipt.receipt_id.length === 0) {
    return { ok: false, error: 'receipt_required' }
  }
  const key = stateKeyForReceipt(receipt)
  if (!key) return { ok: false, error: 'unmapped_transition' }
  if ((receipt.kind === 'approved' || receipt.kind === 'rejected') && !receipt.gate_owner) {
    return { ok: false, error: 'gated_verdict_required' }
  }

  const lookup = await linearGraphql(env, binding.connector_id, LINEAR_ISSUE_STATES_QUERY, { id: task.item.native_id })
  if (!lookup.ok) return { ok: false, error: lookup.error }
  const parsed = parseIssueStates(lookup.data)
  if (!parsed) return { ok: false, error: 'issue_not_found' }
  if (parsed.teamKey.toLowerCase() !== binding.external_id.trim().toLowerCase()) {
    return { ok: false, error: 'team_mismatch' }
  }
  if (parsed.current?.type === 'canceled') return { ok: true, applied: false, detail: 'human_canceled' }

  const wanted = stateMapFromMeta(binding.meta_json)[key].toLowerCase()
  const target = parsed.states.find((s) => s.name.toLowerCase() === wanted)
  if (!target) return { ok: false, error: 'state_not_found' }
  // Done only ever lands on a completed-type state; the other two must not land on a terminal one.
  if (key === 'done' && target.type !== 'completed') return { ok: false, error: 'state_type_mismatch' }
  if (key !== 'done' && (target.type === 'completed' || target.type === 'canceled')) {
    return { ok: false, error: 'state_type_mismatch' }
  }
  if (parsed.current?.id === target.id) return { ok: true, applied: false, detail: 'already_in_state' }

  const res = await linearGraphql(env, binding.connector_id, LINEAR_ISSUE_UPDATE_MUTATION, {
    id: task.item.native_id,
    stateId: target.id,
  })
  if (!res.ok) return { ok: false, error: res.error }
  const success = (res.data.issueUpdate as { success?: unknown } | undefined)?.success
  return success === true ? { ok: true, applied: true } : { ok: false, error: 'linear_rejected' }
}

export async function linearPostComment(
  env: Env,
  binding: ProjectProviderBinding,
  item: BoardItemRef,
  text: string,
): Promise<WritebackResult> {
  if (!binding.connector_id) return { ok: false, error: 'connector_required' }
  const body = sanitizeComment(text)
  if (!body) return { ok: false, error: 'empty_comment' }
  const res = await linearGraphql(env, binding.connector_id, LINEAR_COMMENT_MUTATION, { issueId: item.native_id, body })
  if (!res.ok) return { ok: false, error: res.error }
  const success = (res.data.commentCreate as { success?: unknown } | undefined)?.success
  return success === true ? { ok: true, applied: true } : { ok: false, error: 'linear_rejected' }
}

/** The PR/artifact link goes in as a comment (https only). */
export async function linearLinkArtifact(
  env: Env,
  binding: ProjectProviderBinding,
  item: BoardItemRef,
  url: string,
): Promise<WritebackResult> {
  if (!isHttpsUrl(url)) return { ok: false, error: 'invalid_url' }
  return linearPostComment(env, binding, item, `mupot artifact: ${url}`)
}
