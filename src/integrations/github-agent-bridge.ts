// mupot — GitHub issue-comment ↔ agent-message bridge (closes the SOS-replacement gap).
//
// Inbound: When a GitHub issue_comment webhook fires on a task-mirrored issue,
// resolve the comment author to an agent identity and create an agent_message.
// Unmapped authors are ignored (human comments on GitHub are not agent messages).
//
// Outbound: When an agent sends a message targeting a task's project, post the
// message as a GitHub comment on that task's mirrored issue.
//
// Architecture: D1 is authoritative. GitHub carries (transport layer, human-visible).
// The bridge is idempotent (comment.id deduped, message.request_id deduped).

import type { Env } from '../types'
import { sendAgentMessage, type SendInput } from '../agents/messages'
import { resolveOutboundGitHubToken } from './github-app'

const GITHUB_MIRROR_TIMEOUT_MS = 5_000

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

function githubRepo(env: Env): string | null {
  const repo = (env as unknown as { GITHUB_REPO?: string }).GITHUB_REPO
  return isNonEmptyString(repo) ? repo.trim() : null
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'mupot',
    'Content-Type': 'application/json',
  }
}

async function requestGitHubIssue(
  url: string,
  init: Omit<RequestInit, 'signal'>,
): Promise<Record<string, unknown> | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), GITHUB_MIRROR_TIMEOUT_MS)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    if (!res.ok) return null
    return (await res.json()) as Record<string, unknown>
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ── inbound: GitHub comment → agent message ──────────────────────────────────

export interface GitHubCommentPayload {
  action?: string
  comment?: {
    id?: number
    body?: string
    user?: { login?: string }
    html_url?: string
  }
  issue?: {
    html_url?: string
    number?: number
    title?: string
  }
  repository?: {
    full_name?: string
  }
}

/**
 * Process an issue_comment webhook. Extract the comment author, find the mapped
 * agent, locate the task, and create an agent_message. Returns the agent message
 * id if created, or null if the comment was ignored (e.g., unmapped author).
 *
 * Idempotent: uses comment.id as the request_id to dedup retries.
 * D1 is authoritative; the GitHub comment is transport only.
 */
export async function processGitHubIssueComment(
  env: Env,
  payload: GitHubCommentPayload,
): Promise<{ messageId: string | null; reason?: string }> {
  // Only process creation events
  const action = payload.action?.trim()
  if (action !== 'created') {
    return { messageId: null, reason: `ignored_action_${action}` }
  }

  const comment = payload.comment
  const issue = payload.issue
  if (!comment || !issue) {
    return { messageId: null, reason: 'missing_comment_or_issue' }
  }

  const commentId = comment.id
  const commentBody = comment.body?.trim()
  const authorLogin = comment.user?.login?.trim()
  const issueUrl = issue.html_url?.trim()

  if (!commentId || !commentBody || !authorLogin || !issueUrl) {
    return { messageId: null, reason: 'missing_comment_fields' }
  }

  // Find the task by its GitHub issue URL
  const task = await env.DB.prepare(
    `SELECT id, squad_id, assignee_agent_id, project_id FROM tasks WHERE github_issue_url = ?1 LIMIT 1`,
  )
    .bind(issueUrl)
    .first<{ id: string; squad_id: string; assignee_agent_id: string | null; project_id: string | null }>()

  if (!task) {
    return { messageId: null, reason: 'task_not_found' }
  }

  // Resolve GitHub user to agent identity. Look up member_identities WHERE platform='github'
  // AND external_user_id=authorLogin, then find the associated agent.
  const agentIdentity = await env.DB.prepare(
    `SELECT m.id AS member_id, agents.id AS agent_id
       FROM member_identities mi
       JOIN members m ON m.id = mi.member_id
       LEFT JOIN agents ON agents.id = (
         SELECT agent_id FROM member_tokens WHERE member_id = m.id LIMIT 1
       )
      WHERE mi.platform = 'github' AND mi.external_user_id = ?1
      LIMIT 1`,
  )
    .bind(authorLogin)
    .first<{ member_id: string; agent_id: string | null }>()

  if (!agentIdentity) {
    // Author not mapped — ignore (human GitHub comments are not agent messages)
    return { messageId: null, reason: 'author_not_mapped' }
  }

  const fromAgentId = agentIdentity.agent_id
  const fromMemberId = agentIdentity.member_id

  if (!fromAgentId) {
    // Member exists but has no agent binding — ignore
    return { messageId: null, reason: 'member_has_no_agent' }
  }

  // Create agent message. Send to the task's assignee, or broadcast if no assignee.
  // Use comment.id as the request_id for idempotency (prevent duplicate messages on retry).
  const toAgentId = task.assignee_agent_id || (await getBroadcastAgentForSquad(env, task.squad_id))

  if (!toAgentId) {
    return { messageId: null, reason: 'no_recipient_agent' }
  }

  const input: SendInput = {
    fromAgent: fromAgentId,
    fromMember: fromMemberId,
    toAgent: toAgentId,
    body: commentBody,
    kind: 'message',
    requestId: `gh-comment-${commentId}`, // dedup key scoped to sender
    projectId: task.project_id || undefined,
  }

  // sendAgentMessage is already authorization-checked by its callers; this bridge
  // is system-internal and trusts its inputs.
  const result = await sendAgentMessage(env, input, { system: true, reason: 'github_comment_inbound' })

  if (!result.ok) {
    return { messageId: null, reason: `send_failed_${result.reason}` }
  }

  return { messageId: result.id, reason: undefined }
}

/**
 * Outbound: post an agent message to GitHub as an issue comment.
 * Called from sendAgentMessage when projectId is set and points to a task
 * with a github_issue_url.
 *
 * Returns the comment URL if posted, null if skipped (e.g., no GitHub token).
 * Errors are logged but don't fail the message send (best-effort mirror).
 */
export async function postAgentMessageToGitHub(
  env: Env,
  agentName: string,
  messageBody: string,
  projectId: string | undefined,
): Promise<{ url: string | null }> {
  if (!projectId) {
    return { url: null }
  }

  // Resolve projectId to a task (it might be a project or task id)
  const task = await env.DB.prepare(
    `SELECT github_issue_url FROM tasks WHERE id = ?1 OR project_id = ?1 LIMIT 1`,
  )
    .bind(projectId)
    .first<{ github_issue_url: string | null }>()

  if (!task?.github_issue_url) {
    return { url: null }
  }

  const repo = githubRepo(env)
  const token = await resolveOutboundGitHubToken(env)
  if (!repo || !token) {
    return { url: null }
  }

  // Extract issue number from the URL
  const issueMatch = task.github_issue_url.match(/\/issues\/(\d+)/)
  if (!issueMatch) {
    return { url: null }
  }

  const issueNumber = parseInt(issueMatch[1], 10)
  const commentText = `**Agent: ${agentName}**\n\n${messageBody}`

  try {
    const response = await requestGitHubIssue(
      `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`,
      {
        method: 'POST',
        headers: githubHeaders(token),
        body: JSON.stringify({ body: commentText }),
      },
    )

    if (response && 'html_url' in response) {
      const url = response.html_url
      if (typeof url === 'string') return { url }
    }
  } catch {
    // Best-effort — don't fail the message send if GitHub is down
  }

  return { url: null }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Find a broadcast agent for a squad (used when a task has no assignee).
 * Returns the squad owner/lead agent, or the oldest member.
 */
async function getBroadcastAgentForSquad(env: Env, squadId: string): Promise<string | null> {
  // Try owner or lead first
  const lead = await env.DB.prepare(
    `SELECT agent_id FROM memberships WHERE squad_id = ?1 AND capability IN ('owner', 'lead') LIMIT 1`,
  )
    .bind(squadId)
    .first<{ agent_id: string }>()

  if (lead) return lead.agent_id

  // Fallback to oldest member
  const member = await env.DB.prepare(
    `SELECT agent_id FROM memberships WHERE squad_id = ?1 ORDER BY (SELECT created_at FROM agents WHERE id = agent_id) ASC LIMIT 1`,
  )
    .bind(squadId)
    .first<{ agent_id: string }>()

  return member?.agent_id ?? null
}
