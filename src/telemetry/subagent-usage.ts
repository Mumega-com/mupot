import type { D1Database } from '@cloudflare/workers-types'

export interface SubagentTokenUsageRecord {
  id: string
  subagent_id: string
  parent_agent_id: string
  model_substrate: string
  prompt_tokens: number
  completion_tokens: number
  task_id: string | null
  timestamp: string
}

export interface LogSubagentTokenUsageInput {
  id?: string
  subagentId: string
  parentAgentId?: string
  modelSubstrate: string
  promptTokens: number
  completionTokens: number
  taskId?: string | null
  timestamp?: string
}

export interface SubagentTokenMetricsFilter {
  subagentId?: string
  parentAgentId?: string
  taskId?: string
}

export interface SubagentTokenMetrics {
  totalPromptTokens: number
  totalCompletionTokens: number
  totalTokens: number
  recordCount: number
}

/**
 * Log subagent token usage into D1 table `subagent_token_usage`.
 * Fail-closed: errors propagate if D1 query execution fails.
 */
export async function logSubagentTokenUsage(
  db: D1Database,
  input: LogSubagentTokenUsageInput,
): Promise<SubagentTokenUsageRecord> {
  const id = input.id ?? crypto.randomUUID()
  const parentAgentId = input.parentAgentId ?? 'river'
  const taskId = input.taskId ?? null
  const timestamp = input.timestamp ?? new Date().toISOString()
  const promptTokens = Math.max(0, Math.floor(input.promptTokens))
  const completionTokens = Math.max(0, Math.floor(input.completionTokens))

  await db
    .prepare(
      `INSERT INTO subagent_token_usage (
        id, subagent_id, parent_agent_id, model_substrate, prompt_tokens, completion_tokens, task_id, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      input.subagentId,
      parentAgentId,
      input.modelSubstrate,
      promptTokens,
      completionTokens,
      taskId,
      timestamp,
    )
    .run()

  return {
    id,
    subagent_id: input.subagentId,
    parent_agent_id: parentAgentId,
    model_substrate: input.modelSubstrate,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    task_id: taskId,
    timestamp,
  }
}

/**
 * Calculate total token metrics for subagents from D1 table `subagent_token_usage`.
 * Supports optional filtering by subagentId, parentAgentId, or taskId.
 */
export async function calculateTotalTokenMetrics(
  db: D1Database,
  filter?: SubagentTokenMetricsFilter,
): Promise<SubagentTokenMetrics> {
  const conditions: string[] = []
  const bindings: unknown[] = []

  if (filter?.subagentId) {
    conditions.push('subagent_id = ?')
    bindings.push(filter.subagentId)
  }
  if (filter?.parentAgentId) {
    conditions.push('parent_agent_id = ?')
    bindings.push(filter.parentAgentId)
  }
  if (filter?.taskId) {
    conditions.push('task_id = ?')
    bindings.push(filter.taskId)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const query = `
    SELECT
      COALESCE(SUM(prompt_tokens), 0) AS total_prompt_tokens,
      COALESCE(SUM(completion_tokens), 0) AS total_completion_tokens,
      COUNT(*) AS record_count
    FROM subagent_token_usage
    ${whereClause}
  `

  const stmt = db.prepare(query)
  const result = bindings.length > 0
    ? await stmt.bind(...bindings).first<{
        total_prompt_tokens: number
        total_completion_tokens: number
        record_count: number
      }>()
    : await stmt.first<{
        total_prompt_tokens: number
        total_completion_tokens: number
        record_count: number
      }>()

  const totalPromptTokens = Number(result?.total_prompt_tokens ?? 0)
  const totalCompletionTokens = Number(result?.total_completion_tokens ?? 0)
  const recordCount = Number(result?.record_count ?? 0)

  return {
    totalPromptTokens,
    totalCompletionTokens,
    totalTokens: totalPromptTokens + totalCompletionTokens,
    recordCount,
  }
}

/**
 * Get token metrics for a specific subagent or all subagents.
 */
export async function getSubagentTokenMetrics(
  db: D1Database,
  subagentId?: string,
): Promise<SubagentTokenMetrics> {
  return calculateTotalTokenMetrics(db, subagentId ? { subagentId } : undefined)
}

/**
 * Query detailed subagent token usage records.
 */
export async function listSubagentTokenUsage(
  db: D1Database,
  filter?: { subagentId?: string; parentAgentId?: string; taskId?: string; limit?: number },
): Promise<SubagentTokenUsageRecord[]> {
  const conditions: string[] = []
  const bindings: unknown[] = []

  if (filter?.subagentId) {
    conditions.push('subagent_id = ?')
    bindings.push(filter.subagentId)
  }
  if (filter?.parentAgentId) {
    conditions.push('parent_agent_id = ?')
    bindings.push(filter.parentAgentId)
  }
  if (filter?.taskId) {
    conditions.push('task_id = ?')
    bindings.push(filter.taskId)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const limitClause = filter?.limit ? `LIMIT ${Math.max(1, Math.floor(filter.limit))}` : ''

  const query = `
    SELECT id, subagent_id, parent_agent_id, model_substrate, prompt_tokens, completion_tokens, task_id, timestamp
    FROM subagent_token_usage
    ${whereClause}
    ORDER BY timestamp DESC
    ${limitClause}
  `

  const stmt = db.prepare(query)
  const result = bindings.length > 0
    ? await stmt.bind(...bindings).all<SubagentTokenUsageRecord>()
    : await stmt.all<SubagentTokenUsageRecord>()

  return result.results ?? []
}
