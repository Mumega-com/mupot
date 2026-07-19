import type { Env } from '../../types'
import { importProjectItems, parseProjectItems, PROJECT_ITEMS_QUERY } from '../../integrations/github-projects'
import type {
  ProjectProviderBinding,
  TaskBoardError,
  TaskBoardListResult,
  TaskBoardPort,
  TaskBoardSyncResult,
} from './port'
import { touchProjectBindingSync } from './bindings'

function parseExternalId(externalId: string): { owner: string; projectNumber: number } | null {
  const m = externalId.trim().match(/^([A-Za-z0-9-]{1,39})\/(\d{1,10})$/)
  if (!m) return null
  return { owner: m[1], projectNumber: Number(m[2]) }
}

function agentFieldFromMeta(metaJson: string): string {
  try {
    const meta = JSON.parse(metaJson) as { agent_field?: unknown }
    return typeof meta.agent_field === 'string' && meta.agent_field.trim() ? meta.agent_field.trim() : 'Agent'
  } catch {
    return 'Agent'
  }
}

export function createGitHubProjectsBoardPort(env: Env): TaskBoardPort {
  return {
    provider: 'github_projects',

    async listItems(binding: ProjectProviderBinding): Promise<TaskBoardListResult | TaskBoardError> {
      const parsed = parseExternalId(binding.external_id)
      if (!parsed) return { ok: false, error: 'invalid_external_id' }
      // Reuse sync importer in dry-run shape via GraphQL through importProjectItems dryRun.
      const res = await importProjectItems(
        env,
        {
          owner: parsed.owner,
          projectNumber: parsed.projectNumber,
          agentField: agentFieldFromMeta(binding.meta_json),
          dryRun: true,
          projectId: binding.project_id,
        },
      )
      if (!res.ok) return { ok: false, error: res.error ?? 'list_failed' }
      return {
        ok: true,
        items: res.items.map((item, index) => ({
          external_id: `${parsed.owner}/${parsed.projectNumber}#${index}`,
          title: item.title,
          url: null,
          status: item.status,
          assignee_hint: item.agent,
        })),
      }
    },

    async syncIntoProject(
      binding: ProjectProviderBinding,
      opts: { project_id: string; dryRun: boolean },
    ): Promise<TaskBoardSyncResult | TaskBoardError> {
      const parsed = parseExternalId(binding.external_id)
      if (!parsed) return { ok: false, error: 'invalid_external_id' }
      if (opts.project_id !== binding.project_id) return { ok: false, error: 'project_mismatch' }
      const res = await importProjectItems(
        env,
        {
          owner: parsed.owner,
          projectNumber: parsed.projectNumber,
          agentField: agentFieldFromMeta(binding.meta_json),
          dryRun: opts.dryRun,
          projectId: binding.project_id,
        },
      )
      if (!res.ok) return { ok: false, error: res.error ?? 'sync_failed' }
      if (!opts.dryRun) await touchProjectBindingSync(env, binding.project_id, 'github_projects')
      return {
        ok: true,
        imported: res.imported,
        skipped: res.skipped,
        items: res.items.map((item) => ({
          title: item.title,
          status: item.status,
          detail: item.agent ?? undefined,
        })),
      }
    },
  }
}

// Keep GraphQL symbols re-exported for adapter tests that want pure parsers.
export { parseProjectItems, PROJECT_ITEMS_QUERY }
