// mupot — external task-board port for project providers.
//
// Pot-native projects own identity + RBAC. Linear / GitHub Projects / Notion
// implement this port as adapters. They never become columns on `projects`.

export type ProjectBoardProvider = 'github_projects' | 'linear' | 'notion'

export const PROJECT_BOARD_PROVIDERS: readonly ProjectBoardProvider[] = [
  'github_projects',
  'linear',
  'notion',
]

export function isProjectBoardProvider(value: unknown): value is ProjectBoardProvider {
  return typeof value === 'string' && (PROJECT_BOARD_PROVIDERS as readonly string[]).includes(value)
}

export interface BoardItem {
  external_id: string
  title: string
  url: string | null
  status: string | null
  assignee_hint: string | null
}

export interface ProjectProviderBinding {
  project_id: string
  provider: ProjectBoardProvider
  external_id: string
  connector_id: string | null
  meta_json: string
  synced_at: string | null
  created_at: string
  updated_at: string
}

export interface TaskBoardListResult {
  ok: true
  items: BoardItem[]
}

export interface TaskBoardSyncResult {
  ok: true
  imported: number
  skipped: number
  items: Array<{ title: string; status: 'created' | 'skipped' | 'no_agent' | 'unknown_agent' | 'error'; detail?: string }>
}

export interface TaskBoardError {
  ok: false
  error: string
}

/** Adapter contract — one implementation per provider. */
export interface TaskBoardPort {
  readonly provider: ProjectBoardProvider
  listItems(binding: ProjectProviderBinding): Promise<TaskBoardListResult | TaskBoardError>
  syncIntoProject(
    binding: ProjectProviderBinding,
    opts: { project_id: string; dryRun: boolean },
  ): Promise<TaskBoardSyncResult | TaskBoardError>
}
