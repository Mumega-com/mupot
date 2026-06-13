// mupot — GitHub repo-write actions (the pot's GitHub HANDS).
//
// Built on the App installation-token keystone (github-app.ts) and gated by the plan-tier
// capability registry (github-capabilities.ts). Two actions:
//
//   1. writeAgentDef  — write .github/agents/<name>.agent.md into a tenant repo, making the
//      pot the AUTHOR of that tenant's GitHub coding agents. (free tier: custom_agent_defs)
//   2. assignIssueToCopilot — hand a GitHub issue to the Copilot coding agent, which then
//      works it autonomously in GitHub's runners. (paid tier: coding_agent_assign)
//
// SECURITY SURFACE — external write under the pot's token. Discipline:
//   - Both actions gate on githubCan() FIRST (plan tier + enterprise kill switch).
//   - Token is the App installation token (short-lived), resolved App-first.
//   - agentName is strictly validated ([a-z0-9-]) — no path traversal into the repo tree.
//   - repo is validated as owner/repo — no host or path injection into the API URL.
//   - Every failure returns a typed { ok:false } (fail-closed); no token/detail leaks.

import type { Env } from '../types'
import { resolveOutboundGitHubToken } from './github-app'
import { githubCan } from './github-capabilities'

const GITHUB_API = 'https://api.github.com'

// ── validation ────────────────────────────────────────────────────────────────────

const AGENT_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
// owner/repo: each segment must START with an alnum/underscore/hyphen (not a dot) so a
// segment can never be '.' or '..'. Combined with the explicit '..' reject below, this
// forbids dot-segments that would repoint the REST URL path off /repos/{owner}/{repo}/.
const REPO_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/

export function isValidAgentName(name: string): boolean {
  return AGENT_NAME_RE.test(name)
}

export function isValidRepo(repo: string): boolean {
  if (repo.includes('..')) return false // no dot-segment path traversal in the API URL
  return REPO_RE.test(repo)
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'mupot',
    'Content-Type': 'application/json',
  }
}

// base64 of a UTF-8 string, Workers-safe.
function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] ?? 0)
  return btoa(bin)
}

// ── result types ─────────────────────────────────────────────────────────────────

export type WriteAgentDefResult =
  | { ok: true; commitUrl: string | null; updated: boolean }
  | { ok: false; error: string }

export type AssignCopilotResult =
  | { ok: true; assigned: true }
  | { ok: false; error: string }

interface ActionOpts {
  fetchImpl?: typeof fetch
}

// ── writeAgentDef ──────────────────────────────────────────────────────────────────

/**
 * Write (create or update) a `.github/agents/<agentName>.agent.md` file in `repo`.
 * Returns the commit URL. Update-safe: fetches the current blob SHA first so an existing
 * file is updated rather than rejected.
 */
export async function writeAgentDef(
  env: Env,
  params: { repo: string; agentName: string; content: string; message?: string },
  opts: ActionOpts = {},
): Promise<WriteAgentDefResult> {
  const { repo, agentName, content } = params
  if (!isValidRepo(repo)) return { ok: false, error: 'invalid_repo' }
  if (!isValidAgentName(agentName)) return { ok: false, error: 'invalid_agent_name' }
  if (typeof content !== 'string' || content.length === 0) return { ok: false, error: 'empty_content' }
  if (content.length > 30_000) return { ok: false, error: 'content_too_large' } // GitHub agent prompt cap

  if (!(await githubCan(env, 'custom_agent_defs'))) return { ok: false, error: 'capability_disabled' }

  const token = await resolveOutboundGitHubToken(env, opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : undefined)
  if (!token) return { ok: false, error: 'no_token' }

  const doFetch = opts.fetchImpl ?? fetch
  const path = `.github/agents/${agentName}.agent.md`
  const url = `${GITHUB_API}/repos/${repo}/contents/${path}`

  // Look up existing SHA (PUT requires it to update; absent → create).
  let sha: string | undefined
  try {
    const getRes = await doFetch(url, { headers: ghHeaders(token) })
    if (getRes.ok) {
      const body = (await getRes.json()) as { sha?: string }
      if (typeof body.sha === 'string') sha = body.sha
    } else if (getRes.status !== 404) {
      return { ok: false, error: `read_failed_${getRes.status}` }
    }
  } catch {
    return { ok: false, error: 'read_threw' }
  }

  try {
    const putRes = await doFetch(url, {
      method: 'PUT',
      headers: ghHeaders(token),
      body: JSON.stringify({
        message: params.message ?? `chore(agents): ${sha ? 'update' : 'add'} ${agentName} agent definition`,
        content: toBase64(content),
        ...(sha ? { sha } : {}),
      }),
    })
    if (!putRes.ok) return { ok: false, error: `write_failed_${putRes.status}` }
    const body = (await putRes.json()) as { commit?: { html_url?: string } }
    return { ok: true, commitUrl: body.commit?.html_url ?? null, updated: Boolean(sha) }
  } catch {
    return { ok: false, error: 'write_threw' }
  }
}

// ── assignIssueToCopilot ────────────────────────────────────────────────────────────

// The header that opts a request into the Copilot issue-assignment GraphQL surface.
const COPILOT_ASSIGN_FEATURE = 'issues_copilot_assignment_api_support'
const COPILOT_BOT_LOGIN = 'copilot-swe-agent'

async function graphql(
  doFetch: typeof fetch,
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<{ data?: Record<string, unknown>; errors?: unknown } | null> {
  try {
    const res = await doFetch(`${GITHUB_API}/graphql`, {
      method: 'POST',
      headers: {
        ...ghHeaders(token),
        // Opt into the Copilot-assignment GraphQL feature.
        'GraphQL-Features': COPILOT_ASSIGN_FEATURE,
      },
      body: JSON.stringify({ query, variables }),
    })
    if (!res.ok) return null
    return (await res.json()) as { data?: Record<string, unknown>; errors?: unknown }
  } catch {
    return null
  }
}

/**
 * Assign an issue to the Copilot coding agent. Resolves the issue node id + the Copilot bot
 * actor id (via suggestedActors), then replaceActorsForAssignable with actorIds=[botId].
 * Returns { ok:false, error:'copilot_unavailable' } if the bot is not assignable (Copilot
 * not enabled for the repo/plan) — fail-closed, never throws.
 */
export async function assignIssueToCopilot(
  env: Env,
  params: { repo: string; issueNumber: number },
  opts: ActionOpts = {},
): Promise<AssignCopilotResult> {
  const { repo, issueNumber } = params
  if (!isValidRepo(repo)) return { ok: false, error: 'invalid_repo' }
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) return { ok: false, error: 'invalid_issue' }

  if (!(await githubCan(env, 'coding_agent_assign'))) return { ok: false, error: 'capability_disabled' }

  const token = await resolveOutboundGitHubToken(env, opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : undefined)
  if (!token) return { ok: false, error: 'no_token' }

  const doFetch = opts.fetchImpl ?? fetch
  const [owner, name] = repo.split('/')

  // 1. Resolve issue node id + the Copilot bot actor id (first suggestedActor with the
  //    copilot-swe-agent login). suggestedActors only lists copilot when it is assignable.
  const lookup = await graphql(
    doFetch,
    token,
    `query($owner:String!,$name:String!,$number:Int!){
       repository(owner:$owner,name:$name){
         issue(number:$number){ id }
         suggestedActors(capabilities:[CAN_BE_ASSIGNED], first:100){
           nodes{ login __typename ... on Bot { id } ... on User { id } }
         }
       }
     }`,
    { owner, name, number: issueNumber },
  )

  const repoNode = (lookup?.data?.repository ?? null) as
    | { issue?: { id?: string }; suggestedActors?: { nodes?: Array<{ login?: string; id?: string }> } }
    | null
  const issueId = repoNode?.issue?.id
  const bot = repoNode?.suggestedActors?.nodes?.find((n) => n.login === COPILOT_BOT_LOGIN)
  if (!issueId) return { ok: false, error: 'issue_not_found' }
  if (!bot?.id) return { ok: false, error: 'copilot_unavailable' }

  // 2. Replace actors → assign Copilot. NOTE: the field is actorIds (not assigneeIds).
  const assign = await graphql(
    doFetch,
    token,
    `mutation($assignableId:ID!,$actorIds:[ID!]!){
       replaceActorsForAssignable(input:{assignableId:$assignableId, actorIds:$actorIds}){
         assignable { __typename }
       }
     }`,
    { assignableId: issueId, actorIds: [bot.id] },
  )
  if (!assign || assign.errors) return { ok: false, error: 'assign_failed' }
  return { ok: true, assigned: true }
}
