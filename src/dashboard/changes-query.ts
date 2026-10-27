// Query state for the server-rendered Recent changes feed. Cursors are positions,
// never authority: every request rebuilds the visibility predicate before filters.
export const CHANGES_PAGE_SIZE = 50
export const CHANGE_KINDS = ['all', 'archive', 'unarchive', 'verdict', 'verdict_reversal', 'agent_change'] as const
export const ARCHIVE_TABLES = ['all', 'projects', 'squads', 'tasks', 'agents', 'members'] as const
export const SEARCH_MAX_LENGTH = 100

export interface ChangeFilters {
  kind: (typeof CHANGE_KINDS)[number]
  table: (typeof ARCHIVE_TABLES)[number]
  actor: 'me' | 'anyone'
  q: string
  from: string
  to: string
  undoable: boolean
}
export interface ChangeCursor {
  at: string
  id: string
  position: number
  direction: 'next' | 'previous'
}

function date(value: string | null): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return ''
  const ms = Date.parse(value)
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? value : ''
}

export function changeFilters(params = new URLSearchParams()): ChangeFilters {
  const kind = params.get('kind') as ChangeFilters['kind']
  const table = params.get('table') as ChangeFilters['table']
  return {
    kind: CHANGE_KINDS.includes(kind) ? kind : 'all',
    table: ARCHIVE_TABLES.includes(table) ? table : 'all',
    actor: params.get('actor') === 'me' ? 'me' : 'anyone',
    q: (params.get('q') ?? '').trim().slice(0, SEARCH_MAX_LENGTH),
    from: date(params.get('from')), to: date(params.get('to')),
    undoable: params.get('undoable') === '1',
  }
}

function filterKey(filters: ChangeFilters): string {
  return JSON.stringify(filters)
}

export function changeCursor(params: URLSearchParams, filters: ChangeFilters): ChangeCursor | null {
  const raw = params.get('cursor')
  if (!raw || raw.length > 2000) return null
  try {
    const [at, id, position, direction, key] = JSON.parse(raw)
    if (typeof at !== 'string' || at.length > 40 || !Number.isFinite(Date.parse(at))
      || typeof id !== 'string' || id.length > 250 || !/^(archive:|verdict:|info:reversal:|info:agent_audit:).+/.test(id)
      || !Number.isSafeInteger(position) || position < 0 || position > 1_000_000_000
      || (direction !== 'next' && direction !== 'previous') || key !== filterKey(filters)) return null
    return { at, id, position, direction }
  } catch { return null }
}

export function changesLink(filters: ChangeFilters, cursor?: ChangeCursor): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (key === 'undoable') { if (value) params.set(key, '1') }
    else if (value && value !== 'all' && value !== 'anyone') params.set(key, String(value))
  }
  if (cursor) params.set('cursor', JSON.stringify([cursor.at, cursor.id, cursor.position, cursor.direction, filterKey(filters)]))
  return `/changes${params.size ? `?${params}` : ''}`
}

/** Literal substring search, including literal backslashes, percent and underscore. */
export function changeSearch(q: string): string {
  return `%${q.replace(/[\\%_]/g, '\\$&')}%`
}

/**
 * Each source contributes at most page-size + 1 candidates. Predicates arrive
 * with the original visibility first; all user filters are appended afterwards.
 * Only fixed source metadata is interpolated. Values always use D1 bindings.
 */
export function changeSourceQuery(options: {
  select: string
  visibility: string[]
  values: string[]
  filters: ChangeFilters
  cursor: ChangeCursor | null
  prefix: string
  at: string
  id: string
  search: string[]
  extra?: string[]
}): { sql: string; values: string[] } {
  const { filters, cursor, at, id, prefix } = options
  const values = [...options.values]
  const bind = (value: string): string => { values.push(value); return `?${values.length}` }
  const where = [...options.visibility, ...(options.extra ?? [])]
  if (filters.from) where.push(`${at} >= ${bind(filters.from)}`)
  // Exclusive next-day boundary includes both SQLite and ISO stamps on the last day.
  if (filters.to) {
    const nextDay = new Date(Date.parse(filters.to) + 86400000).toISOString().slice(0, 10)
    where.push(`${at} < ${bind(nextDay)}`)
  }
  if (filters.q) {
    const pattern = bind(changeSearch(filters.q))
    where.push(`(${options.search.map((column) => `${column} LIKE ${pattern} ESCAPE '\\'`).join(' OR ')})`)
  }
  const ascending = cursor?.direction === 'previous'
  if (cursor) {
    const op = ascending ? '>' : '<'
    const stamp = bind(cursor.at)
    // Across sources the namespaced id determines ties; within one source the
    // native id does. Keep functions/concatenation off the indexed source keys.
    if (cursor.id.startsWith(prefix)) {
      where.push(`(${at}, ${id}) ${op} (${stamp}, ${bind(cursor.id.slice(prefix.length))})`)
    } else {
      const includeEqual = ascending ? prefix > cursor.id : prefix < cursor.id
      where.push(`${at} ${op}${includeEqual ? '=' : ''} ${stamp}`)
    }
  }
  const order = ascending ? 'ASC' : 'DESC'
  return {
    sql: `${options.select} WHERE ${where.length ? where.join(' AND ') : '1 = 1'} ORDER BY ${at} ${order}, ${id} ${order} LIMIT ${CHANGES_PAGE_SIZE + 1}`,
    values,
  }
}
