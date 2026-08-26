// src/ai/cache-context.ts — frozen-prefix prompt layout for warm model caches.
//
// Gemini 3.7 Flash and Claude cache on a byte-stable prefix. Anything that
// changes per turn (clock, recalls, the operator's message) MUST sit after a
// stable marker so the prefix hashes identically across requests. This module
// is the only place that assembles that split.

export const CACHE_PREFIX_MARKER = '--- FROZEN STATIC PREFIX ---'
export const CACHE_DYNAMIC_MARKER = '--- DYNAMIC CONTEXT ---'

/** Refresh before the ~5 minute provider cache TTL cools. */
export const CACHE_TTL_MS = 4 * 60 * 1000
export const CACHE_HEARTBEAT_INTERVAL_MS = 3 * 60 * 1000

export const MUPOT_CORE_CHARTER = [
  'Mupot Core Charter.',
  'Mupot is a sovereign AI agent control plane: departments, squads, agents, and human members.',
  'The pot is the tenancy boundary. Projects organize goals, tasks, flights, and evidence.',
  'GitHub is the source of truth. The channel is the squad. Receipts beat grades.',
  'No fake green. Nobody merges or deploys alone. Kasra gates; Athena runs the adversarial pass.',
  'Read state before you act. Rest when there is no defect.',
].join(' ')

export const MUPOT_ARCHITECTURE = [
  'Architecture.',
  'Runtime: Cloudflare Workers + D1 + Vectorize + Queues + KV + R2 + Durable Objects + Workflows.',
  'Identity is token-bound. Capability floors are deny-by-default. Admin tools stay gated.',
  'Co-Pilot surfaces: GET /copilot, the global slide-over drawer, and /projects/:id sandbox studio.',
  'Model calls share one frozen prefix so Gemini 3.7 Flash and Claude keep ~90% cache hits.',
].join(' ')

export const MUPOT_TOOL_SCHEMAS = [
  'Tool Schemas.',
  'studio chat: POST /api/studio/chat { message, recipient, messages[] } → SSE text chunks.',
  'studio dispatch: POST /api/studio/dispatch { name, repo_url, prompt } (admin).',
  'task_create / task_update / cursor_dispatch / loop_control are admin-gated mutations.',
  'check_in records 7-axis presence: seat, harness, machine, model, provider, effort, flight_id.',
  'Member-tier callers may brief and draft. They must not claim a mutation ran.',
].join(' ')

export const RIVER_GOVERNANCE = [
  'River Governance.',
  'River (@river) is Council Lead & Verification Lead.',
  'River holds continuity, high-coherence steering, evidence rigor, and multi-squad direction.',
  'River coordinates builder agents toward verified outcomes and refuses unverified green lights.',
  'Land gate remains Athena (adversarial review) plus Kasra (merge). River steers; the gate still lands.',
].join(' ')

/**
 * Byte-stable prefix. Do not interpolate dates, recalls, tenant names, or the
 * user turn into this string — that would force a cache miss on every request.
 */
export const FROZEN_STATIC_PREFIX = [
  CACHE_PREFIX_MARKER,
  MUPOT_CORE_CHARTER,
  MUPOT_ARCHITECTURE,
  MUPOT_TOOL_SCHEMAS,
  RIVER_GOVERNANCE,
].join('\n')

export interface CachePromptDynamic {
  userMessage: string
  timestamp?: string
  recalls?: readonly string[]
  recipient?: string
  persona?: string
  operator?: string
  operatorRole?: string
  tenant?: string
  squads?: readonly string[]
}

export interface CachedPrompt {
  prefix: string
  suffix: string
  prompt: string
}

export function buildFrozenStaticPrefix(): string {
  return FROZEN_STATIC_PREFIX
}

export function formatDynamicSuffix(dynamic: CachePromptDynamic): string {
  const recalls = (dynamic.recalls ?? []).filter((row) => row.trim())
  const squads = (dynamic.squads ?? []).filter((row) => row.trim())
  const lines = [
    CACHE_DYNAMIC_MARKER,
    dynamic.timestamp ? `Timestamp: ${dynamic.timestamp}` : null,
    dynamic.tenant ? `Tenant: ${dynamic.tenant}` : null,
    dynamic.operator ? `Operator: ${dynamic.operator}${dynamic.operatorRole ? ` (${dynamic.operatorRole})` : ''}` : null,
    dynamic.recipient ? `Recipient: ${dynamic.recipient}` : null,
    squads.length ? `Active squads: ${squads.join(', ')}` : null,
    recalls.length ? `Recent memory recalls:\n${recalls.map((row) => `- ${row}`).join('\n')}` : 'Recent memory recalls: (none)',
    `User message: ${dynamic.userMessage}`,
  ]
  return lines.filter((line): line is string => line !== null).join('\n')
}

export function formatCachedPrompt(dynamic: CachePromptDynamic): CachedPrompt {
  const persona = (dynamic.persona ?? '').trim()
  const prefix = persona ? `${FROZEN_STATIC_PREFIX}\n${persona}` : FROZEN_STATIC_PREFIX
  const suffix = formatDynamicSuffix(dynamic)
  return { prefix, suffix, prompt: `${prefix}\n\n${suffix}` }
}

export function splitCachedPrompt(prompt: string): { prefix: string; suffix: string } {
  const idx = prompt.indexOf(CACHE_DYNAMIC_MARKER)
  if (idx < 0) return { prefix: prompt, suffix: '' }
  return { prefix: prompt.slice(0, idx).trimEnd(), suffix: prompt.slice(idx) }
}

export function promptPrefixIsFrozen(prompt: string): boolean {
  const { prefix } = splitCachedPrompt(prompt)
  return prefix.startsWith(CACHE_PREFIX_MARKER) && prefix.includes(FROZEN_STATIC_PREFIX)
}

export interface CacheSessionHeartbeat {
  refreshed: boolean
  sessionId: string
  lastHeartbeatAt: number
  nextRefreshAt: number
  stale: boolean
}

const warmSessions = new Map<string, number>()

export function cacheHeartbeatDue(lastHeartbeatAt: number, now = Date.now()): boolean {
  return now - lastHeartbeatAt >= CACHE_HEARTBEAT_INTERVAL_MS
}

export function cacheSessionStale(lastHeartbeatAt: number, now = Date.now()): boolean {
  return now - lastHeartbeatAt >= CACHE_TTL_MS
}

/**
 * Lightweight keep-alive for an active cached prefix session. Calling this
 * before the provider TTL expires keeps the warm cache from cooling.
 */
export function keepAliveCacheSession(sessionId: string, now = Date.now()): CacheSessionHeartbeat {
  const key = sessionId.trim() || 'default'
  const previous = warmSessions.get(key)
  const due = previous === undefined || cacheHeartbeatDue(previous, now)
  const lastHeartbeatAt = due ? now : (previous as number)
  if (due) warmSessions.set(key, now)
  return {
    refreshed: due,
    sessionId: key,
    lastHeartbeatAt,
    nextRefreshAt: lastHeartbeatAt + CACHE_HEARTBEAT_INTERVAL_MS,
    stale: cacheSessionStale(lastHeartbeatAt, now),
  }
}

export function readCacheSession(sessionId: string): number | undefined {
  return warmSessions.get(sessionId.trim() || 'default')
}

export function dropCacheSession(sessionId: string): void {
  warmSessions.delete(sessionId.trim() || 'default')
}

export function resetCacheSessions(): void {
  warmSessions.clear()
}
