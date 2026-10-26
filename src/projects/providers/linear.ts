import type { Env } from '../../types'
import { defaultSquadIdFromMeta, fetchLinearIssues, importLinearIssues } from '../../integrations/linear-issues'
import type {
  BoardCapability,
  ProjectProviderBinding,
  TaskBoardError,
  TaskBoardListResult,
  TaskBoardPort,
  TaskBoardSyncResult,
} from './port'
import { touchProjectBindingSync } from './bindings'
import { registerBoardProvider } from './registry-core'
import { linearLinkArtifact, linearPostComment, linearPushStatus } from '../../integrations/linear-writeback'
import { handleLinearWebhook, parseLinearWebhook, verifyLinearWebhook } from '../../integrations/linear-webhook'

/**
 * Linear board adapter.
 * Credentials: connector type `linear` (vault), resolved by binding.connector_id — a
 * connector-less binding (no vault credential attached) fails closed with
 * 'connector_required', it never falls back to any env credential.
 * external_id = Linear team key (e.g. "ENG").
 *
 * Import/list are READ-ONLY toward Linear (query only, src/integrations/linear-issues.ts); write-back is
 * receipt-bound and flag-gated (src/integrations/linear-writeback.ts). Toward mupot agents: syncIntoProject imports issues as UNASSIGNED tasks routed to
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
    capabilities: new Set<BoardCapability>(['pushStatus', 'postComment', 'linkArtifact', 'webhook']),

    // Outbound: receipt-bound writes, see integrations/linear-writeback.ts. The dispatcher (board-writeback.ts)
    // applies the BOARD_WRITEBACK flag and the per-binding meta.writeback opt-in before calling any of these.
    pushStatus: (binding, task, receipt) => linearPushStatus(env, binding, task, receipt),
    postComment: (binding, item, text) => linearPostComment(env, binding, item, text),
    linkArtifact: (binding, item, url) => linearLinkArtifact(env, binding, item, url),

    // Inbound: see integrations/linear-webhook.ts.
    verifyWebhook: (e, rawBody, headers) => verifyLinearWebhook(e, rawBody, headers),
    parseWebhook: (rawBody) => parseLinearWebhook(rawBody),
    webhook: (binding, event) => handleLinearWebhook(env, binding, event),

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
      // PR #659 P0 gate, Low finding: importLinearIssues returns ok:true with imported:0
      // when defaultSquadId is unset — every item reports 'no_squad' and NOTHING is
      // written (see its file header). That is a correctly fail-closed IMPORT, but it is
      // not a successful SYNC: touching synced_at here would tell an operator "this
      // binding synced fine" while hiding the actual problem (no admin-configured squad).
      // Only stamp synced_at when the import attempt actually resolved past that
      // misconfiguration — i.e. not every reported item is 'no_squad'. An empty team
      // (zero Linear issues, res.items.length === 0) is a real, successful sync of
      // nothing and still gets the touch.
      const isSquadMisconfigured = res.items.length > 0 && res.items.every((item) => item.status === 'no_squad')
      if (!opts.dryRun && !isSquadMisconfigured) await touchProjectBindingSync(env, binding.project_id, 'linear')
      return {
        ok: true,
        imported: res.imported,
        skipped: res.skipped,
        items: res.items.map((item) => ({ title: item.title, status: item.status })),
      }
    },
  }
}

registerBoardProvider('linear', createLinearBoardPort)
