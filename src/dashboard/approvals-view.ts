// /approvals view model — pure functions: filter parsing, filtering, sorting and
// filter options. Filters are applied IN MEMORY over the already RBAC-scoped
// result of loadApprovals (never interpolated into SQL), and every value is
// validated against an allowlist (priority/kind/gate) or against the viewer's own
// visible set (sender agent, project). Unknown values are dropped, never a 500.

import type { ApprovalItem, AskItem } from './approvals'

export const PRIORITY_VALUES = ['P0', 'P1', 'P2', 'P3', 'none'] as const
export type PriorityFilter = (typeof PRIORITY_VALUES)[number]
export const KIND_VALUES = ['verdict', 'publish', 'secret'] as const
export type KindFilter = (typeof KIND_VALUES)[number]

export interface ApprovalFilters {
  priority: PriorityFilter[]
  agent: string | null
  project: string | null
  kind: KindFilter[]
  gate: 'mine' | 'all'
}

export interface FilterOptions {
  agents: Array<{ id: string; name: string }>
  projects: Array<{ id: string; name: string }>
}

export interface RawFilterInput {
  p: string[]
  agent?: string
  project?: string
  kind: string[]
  gate?: string
  /** 'sent' => options derive from the viewer's own asks instead of the decision queue. */
  tab?: string
  asks?: AskItem[]
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)]
}

/** Gate scope the options are derived from: own decisions, or every actionable one. */
export function scopeItems(items: ApprovalItem[], gate: 'mine' | 'all'): ApprovalItem[] {
  return gate === 'all'
    ? items.filter((t) => t.can_verdict)
    : items.filter((t) => t.can_verdict && t.own_gate === true)
}

/** Options come ONLY from the viewer's visible set — no enumeration of agents/projects they can't see. */
export function filterOptions(visible: Array<Pick<ApprovalItem, 'assignee_agent_id' | 'agent_name' | 'project_id' | 'project_name'>>): FilterOptions {
  const agents = new Map<string, string>()
  const projects = new Map<string, string>()
  for (const t of visible) {
    if (t.assignee_agent_id) agents.set(t.assignee_agent_id, t.agent_name ?? t.assignee_agent_id)
    if (t.project_id) projects.set(t.project_id, t.project_name ?? t.project_id)
  }
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)
  return {
    agents: [...agents].map(([id, name]) => ({ id, name })).sort(byName),
    projects: [...projects].map(([id, name]) => ({ id, name })).sort(byName),
  }
}

export function parseFilters(raw: RawFilterInput, items: ApprovalItem[]): ApprovalFilters {
  const gate = raw.gate === 'all' ? 'all' : 'mine'
  const options = filterOptions(raw.tab === 'sent' ? (raw.asks ?? []) : scopeItems(items, gate))
  const priority = uniq(raw.p.filter((v): v is PriorityFilter => (PRIORITY_VALUES as readonly string[]).includes(v)))
  const kind = uniq(raw.kind.filter((v): v is KindFilter => (KIND_VALUES as readonly string[]).includes(v)))
  const agent = raw.agent && options.agents.some((a) => a.id === raw.agent) ? raw.agent : null
  const project = raw.project && options.projects.some((p) => p.id === raw.project) ? raw.project : null
  return { priority, agent, project, kind, gate }
}

export function activeFilterCount(f: ApprovalFilters): number {
  return (f.priority.length ? 1 : 0) + (f.agent ? 1 : 0) + (f.project ? 1 : 0) + (f.kind.length ? 1 : 0) + (f.gate === 'all' ? 1 : 0)
}

type Filterable = Pick<ApprovalItem, 'priority' | 'assignee_agent_id' | 'project_id'>

export function applyFilters<T extends Filterable>(visible: T[], f: ApprovalFilters): T[] {
  return visible.filter((t) => {
    if (f.priority.length && !f.priority.includes(t.priority ?? 'none')) return false
    if (f.agent && t.assignee_agent_id !== f.agent) return false
    if (f.project && t.project_id !== f.project) return false
    return true
  })
}

const PRIORITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 }

function enteredMs(t: ApprovalItem): number {
  const ms = Date.parse(t.review_entered_at ?? t.updated_at ?? t.created_at)
  return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER
}

/** Priority (P0 first, untriaged last), then oldest review entry first. */
export function sortApprovals(items: ApprovalItem[]): ApprovalItem[] {
  return [...items].sort((a, b) => {
    const ra = a.priority ? (PRIORITY_RANK[a.priority] ?? 4) : 4
    const rb = b.priority ? (PRIORITY_RANK[b.priority] ?? 4) : 4
    return ra - rb || enteredMs(a) - enteredMs(b) || a.id.localeCompare(b.id)
  })
}

/** Query string that reproduces the filters (shareable, bookmarkable). */
export function filterQuery(f: ApprovalFilters, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams()
  for (const v of f.priority) q.append('p', v)
  if (f.agent) q.set('agent', f.agent)
  if (f.project) q.set('project', f.project)
  for (const v of f.kind) q.append('kind', v)
  if (f.gate === 'all') q.set('gate', 'all')
  for (const [k, v] of Object.entries(extra)) q.set(k, v)
  const s = q.toString()
  return s ? `?${s}` : ''
}

/** "You asked": waiting first, then most recent. */
export function sortAsks(asks: AskItem[]): AskItem[] {
  return [...asks].sort((a, b) => {
    const wa = a.state === 'waiting' ? 0 : 1
    const wb = b.state === 'waiting' ? 0 : 1
    if (wa !== wb) return wa - wb
    return (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0) || a.id.localeCompare(b.id)
  })
}
