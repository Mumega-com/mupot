import type { Env } from '../../types'
import type {
  ProjectProviderBinding,
  TaskBoardError,
  TaskBoardListResult,
  TaskBoardPort,
  TaskBoardSyncResult,
} from './port'

/**
 * Notion board adapter.
 * Credentials: connector type `notion` (vault). external_id = database id.
 * The v1 contract and registry surface are wired. Live database synchronization is not
 * implemented; both operations return `notion_adapter_pending_credentials`.
 */
export function createNotionBoardPort(_env: Env): TaskBoardPort {
  return {
    provider: 'notion',
    async listItems(_binding: ProjectProviderBinding): Promise<TaskBoardListResult | TaskBoardError> {
      return { ok: false, error: 'notion_adapter_pending_credentials' }
    },
    async syncIntoProject(
      _binding: ProjectProviderBinding,
      _opts: { project_id: string; dryRun: boolean },
    ): Promise<TaskBoardSyncResult | TaskBoardError> {
      return { ok: false, error: 'notion_adapter_pending_credentials' }
    },
  }
}
