import type { Env } from '../../types'
import { defaultSquadIdFromMeta, fetchLinearIssues, importLinearIssues } from '../../integrations/linear-issues'
import type {
  ProjectProviderBinding,
  TaskBoardError,
  TaskBoardListResult,
  TaskBoardPort,
  TaskBoardSyncResult,
} from './port'
import { touchProjectBindingSync } from './bindings'

/**
 * Linear board adapter.
 * Credentials: connector type `linear` (vault), resolved by binding.connector_id — a
 * connector-less binding (no vault credential attached) fails closed with
 * 'connector_required', it never falls back to any env credential.
 * external_id = Linear team key (e.g. "ENG").
 *
 * READ-ONLY toward Linear (query only, see src/integrations/linear-issues.ts) and
 * toward mupot agents: syncIntoProject imports issues as UNASSIGNED tasks routed to
 * the admin-configured `defaultSquadId` in binding.meta_json — never to an agent, and
 * without emitting the task.created wake event. See linear-issues.ts's file header
 * for the full structural argument. This intentionally does NOT mirror
 * src/projects/providers/github.ts's agent-field-to-assignee resolution — that part
 * of the GitHub pattern is exactly what the binding constraint on this flight forbids
 * for a priority-surface-only source like Linear.
 */
export function createLinearBoardPort(env: Env): TaskBoardPort {
  return {
    provider: 'linear',

    async listItems(binding: ProjectProviderBinding): Promise<TaskBoardListResult | TaskBoardError> {
      if (!binding.connector_id) return { ok: false, error: 'connector_required' }
      const res = await fetchLinearIssues(env, binding.connector_id, binding.external_id)
      if (!res.ok) return { ok: false, error: res.error }
      return {
        ok: true,
        items: res.items.map((item) => ({
          external_id: item.identifier,
          title: item.title,
          url: item.url,
          status: item.state,
          // Display only — never fed back into agent selection. See file header.
          assignee_hint: item.assigneeHint,
        })),
      }
    },

    async syncIntoProject(
      binding: ProjectProviderBinding,
      opts: { project_id: string; dryRun: boolean },
    ): Promise<TaskBoardSyncResult | TaskBoardError> {
      if (!binding.connector_id) return { ok: false, error: 'connector_required' }
      if (opts.project_id !== binding.project_id) return { ok: false, error: 'project_mismatch' }
      const res = await importLinearIssues(env, {
        connectorId: binding.connector_id,
        teamKey: binding.external_id,
        defaultSquadId: defaultSquadIdFromMeta(binding.meta_json),
        dryRun: opts.dryRun,
        projectId: binding.project_id,
      })
      if (!res.ok) return { ok: false, error: res.error ?? 'sync_failed' }
      if (!opts.dryRun) await touchProjectBindingSync(env, binding.project_id, 'linear')
      return {
        ok: true,
        imported: res.imported,
        skipped: res.skipped,
        items: res.items.map((item) => ({ title: item.title, status: item.status })),
      }
    },
  }
}
