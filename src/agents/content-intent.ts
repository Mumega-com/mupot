// mupot — content-intent detection: the seam that turns a chat/console/IM task
// into a GATED department content-write proposal instead of a freeform LLM
// answer (flight-1: "close the MVP loop so the agent actually does the work").
//
// Convention: a task whose TITLE starts with "publish:" (case-insensitive,
// colon optional) is a content-write REQUEST, not a question to answer in
// prose. This mirrors the colon-prefixed command convention already used
// elsewhere in this codebase — "task: <title>" (src/im/index.ts) — so an
// operator using IM `task:`, the console "Send a task" form, or a raw
// POST /api/tasks all reach this the same way: title text, no new UI, no new
// parsing infrastructure.
//
// The article body is task.body verbatim. An OPTIONAL first line of the body
// pins the publishing surface explicitly:
//   executor: inkwell-content
//   executor: mcpwp
// That line is stripped from the content sent to the CMS. Absent → defaults to
// 'inkwell-content' (mumega.com's own Inkwell pot — the OSS framework this
// runtime already has a live S4 executor for).
//
// Pure + synchronous — no model call, no I/O, no D1. detectContentIntent
// returning null means the caller (runTaskExecution) falls through to its
// normal LLM-answer path completely unchanged.

import type { Task } from '../types'

export type ContentExecutor = 'inkwell-content' | 'mcpwp'

export interface ContentIntent {
  executor: ContentExecutor
  title: string
  content: string
}

const TITLE_RE = /^publish\s*:\s*(.+)$/is
const EXECUTOR_LINE_RE = /^executor\s*:\s*(inkwell-content|mcpwp)\s*$/i

/**
 * Parse a task as a content-publish request, or return null when it is an
 * ordinary task (no "publish:" title prefix, or an empty title/body after
 * stripping the prefix — an empty request is not a content intent, it falls
 * through to the normal execution path rather than proposing a blank write).
 */
export function detectContentIntent(task: Pick<Task, 'title' | 'body'>): ContentIntent | null {
  const m = TITLE_RE.exec(task.title ?? '')
  if (!m) return null
  const title = m[1].trim()
  if (!title) return null

  const bodyLines = (task.body ?? '').split('\n')
  let executor: ContentExecutor = 'inkwell-content'
  let contentLines = bodyLines
  if (bodyLines.length > 0) {
    const first = EXECUTOR_LINE_RE.exec(bodyLines[0].trim())
    if (first) {
      // The `i` flag makes MATCHING case-insensitive but does not normalize the
      // captured text — "Executor: INKWELL-CONTENT" must still resolve to the
      // canonical lowercase enum value the kernel dispatches on (kernel.ts
      // compares executorHint === 'inkwell-content' / 'mcpwp' verbatim).
      executor = first[1].toLowerCase() as ContentExecutor
      contentLines = bodyLines.slice(1)
    }
  }
  const content = contentLines.join('\n').trim()
  if (!content) return null

  return { executor, title, content }
}
