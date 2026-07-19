import type { Env } from '../../types'
import type {
  ProjectProviderBinding,
  TaskBoardError,
  TaskBoardListResult,
  TaskBoardPort,
  TaskBoardSyncResult,
} from './port'

/**
 * Linear board adapter.
 * Credentials: connector type `linear` (vault). external_id = Linear team/project key.
 * v1 lists/syncs are wired; live GraphQL lands once a pot has a Linear connector bound.
 */
export function createLinearBoardPort(_env: Env): TaskBoardPort {
  return {
    provider: 'linear',
    async listItems(_binding: ProjectProviderBinding): Promise<TaskBoardListResult | TaskBoardError> {
      return { ok: false, error: 'linear_adapter_pending_credentials' }
    },
    async syncIntoProject(
      _binding: ProjectProviderBinding,
      _opts: { project_id: string; dryRun: boolean },
    ): Promise<TaskBoardSyncResult | TaskBoardError> {
      return { ok: false, error: 'linear_adapter_pending_credentials' }
    },
  }
}
