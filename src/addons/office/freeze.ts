// mupot — mcpwp-office addon: the freeze primitives (mupot#1592 r2 adversarial
// follow-up on PR #1588, r1 adversarial gate on PR #1602, P0).
//
// EXTRACTED from src/addons/office/service.ts into its OWN leaf module for exactly
// one reason: service.ts imports `evaluateVerdictGates`/`canActOnSquad` FROM
// src/tasks/index.ts, so src/tasks/index.ts (the HTTP PATCH /:id handler) could
// never import service.ts back without a real circular dependency. The PR first
// tried to dodge that with `const office = await import('../addons/office/service')`
// inside the PATCH handler — kasra-review's adversarial gate on #1602 proved that
// bricks the bundled Worker outright: `wrangler dev` fails to boot with "Top-level
// await in module is unsettled", because esbuild's Workers-target bundle can't
// resolve a dynamic import() sitting in the same graph as a real cycle. vitest
// never bundles, so the unit suite was blind to it (lesson: vitest green ≠ Worker
// boots).
//
// This module has ZERO dependency on src/tasks/index.ts or src/tasks/service.ts —
// everything it needs (addon installation/binding/connector resolution, canonical
// JSON hashing) lives in leaf modules of its own. Every caller — src/mcp/index.ts,
// src/tasks/index.ts, src/addons/office/service.ts, src/agents/execute.ts,
// src/tasks/runtime-receipts.ts, src/integrations/github-execute.ts — imports this
// module STATICALLY. No dynamic import() of this addon anywhere in the codebase.

import type { Env, Task, Capability } from '../../types'
import { listAddonInstallations } from '../service'
import { listAddonBindings, type AddonBinding } from '../bindings'
import { getRegisteredAddon } from '../registry'
import { resolveConnectorByIdWithMeta } from '../../connectors/service'
import { assertPublicHttpsUrl } from '../../lib/ssrf'
import { parseSiteConnectorConfig } from './health'
import { canonicalJson, sha256Hex } from '../../lib/canonical-json'
import { claimTimestamp } from '../../lib/claim-timestamp'

export const OFFICE_ADDON_KEY = 'mcpwp-office'
export const OFFICE_GATE_OWNER = 'gate:office'
export const OFFICE_WORDPRESS_SLOT = 'wordpress_site'

export type OfficeRefusalReason =
  | 'addon_inactive'
  | 'connector_not_bound'
  | 'connector_capability_mismatch'
  | 'not_authorized'
  | 'department_not_active'
  | 'task_not_found'
  | 'wrong_gate'
  | 'not_in_review'
  | 'not_approved'
  | 'self_verdict'
  | 'agent_approval_forbidden'
  | 'payload_not_frozen'
  | 'expected_hash_required'
  | 'payload_mismatch'
  | 'unreconciled_prior_publish'
  | 'freeze_not_found'
  | 'already_reconciled'
  | 'binding_changed'
  | 'publish_claimed'
  | 'invalid_site_config'
  | 'invalid_site_url'
  | 'unreachable'
  | 'key_invalid'
  | 'redirect_blocked'
  | 'bad_response'
  | 'write_failed'
  | 'verdict_race'

export type OfficeResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: OfficeRefusalReason }

// P3-2 (kasra-review adversarial round 1, PR #1588): the ORIGINAL version of this
// function did `.find(row => row.addonKey === OFFICE_ADDON_KEY)` THEN checked
// state/trustClass on whatever row that found — the FIRST row for this addon key in
// listAddonInstallations' `ORDER BY installed_at ASC` order, not necessarily the
// active one. After an archive followed by a reinstall, the OLD archived row (older
// installed_at) sorts first, `.find` returns it, sees state !== 'active', and
// returns null forever — bricking every office.* tool even though a genuinely
// active reinstalled row exists later in the same array. Fixed by folding the
// state/trustClass check INTO the predicate, so `.find` locates the (or an) active
// row regardless of its position.
export async function resolveActiveOfficeInstallationId(env: Env): Promise<string | null> {
  const installations = await listAddonInstallations(env)
  const installation = installations.find(
    (row) => row.addonKey === OFFICE_ADDON_KEY && row.state === 'active' && row.trustClass === 'external_isolated',
  )
  return installation?.id ?? null
}

export interface OfficeConnectorBinding {
  readonly connectorId: string
  readonly capability: AddonBinding['capability']
}

export async function resolveOfficeConnectorBinding(env: Env, installationId: string): Promise<OfficeResult<OfficeConnectorBinding>> {
  const bindings = await listAddonBindings(env, installationId)
  const binding = bindings.find((row) => row.slot === OFFICE_WORDPRESS_SLOT && !row.revokedAt)
  if (!binding || !binding.connectorId) return { ok: false, reason: 'connector_not_bound' }
  return { ok: true, value: { connectorId: binding.connectorId, capability: binding.capability } }
}

// P3-2 (kasra-review adversarial round 1, PR #1588): the ORIGINAL resolver picked
// any non-revoked binding on this slot without ever checking its capability — the
// shipped test fixture published through a binding whose capability is 'read' (the
// ONLY value addon_connector_bindings.capability can ever hold today, migrations/
// 0052's CHECK constraint — the exact T2b gap the "known lifecycle gap" regression
// test above pins) even though this manifest's own connectorRequirements declares
// 'write' as what a WordPress publish actually needs. Checked at publish time only
// (never at approval/freeze time — infra readiness is orthogonal to what a human
// approved) — comparing against the REGISTERED manifest's declared capability,
// never a hardcoded 'write' literal.
export function officeConnectorSatisfiesRequirement(capability: AddonBinding['capability']): boolean {
  const requirement = getRegisteredAddon(OFFICE_ADDON_KEY)?.manifest.connectorRequirements
    .find((entry) => entry.slot === OFFICE_WORDPRESS_SLOT)
  return requirement !== undefined && capability === requirement.capability
}

/** Non-secret site origin for the office WordPress connector — resolved from the
 *  connector's `meta` only (resolveConnectorByIdWithMeta never selects the encrypted
 *  secret), the same non-secret metadata health.ts's probe reads via
 *  parseSiteConnectorConfig. Used both to freeze the approved target (review time)
 *  and to re-verify it has not drifted (publish time) — no credential is touched
 *  by either call. */
export async function resolveOfficeSiteOrigin(env: Env, connectorId: string): Promise<string | null> {
  const connector = await resolveConnectorByIdWithMeta(env, connectorId)
  if (!connector) return null
  const config = parseSiteConnectorConfig(connector.meta)
  if (!config) return null
  try {
    return assertPublicHttpsUrl(config.siteUrl).origin
  } catch {
    return null
  }
}

// P1-2 / office.publish's approvalPolicies entry (src/addons/office/manifest.ts) —
// read from the REGISTERED manifest, never hardcoded, so an edit to the manifest's
// declared requiredCapability is the only place this can ever drift. Shared by both
// reviewOfficeApproval (the human decision) and publishOfficePost (the write itself)
// — the SAME policy entry names both, per the manifest's own comment.
export function resolveOfficePublishRequiredCapability(): Capability {
  const policy = getRegisteredAddon(OFFICE_ADDON_KEY)?.manifest.approvalPolicies
    .find((entry) => entry.action === 'office.publish')
  // Defensive fallback only, never the primary source: validateAddonManifest's own
  // approval-policy invariant (src/addons/contract.ts) refuses registering this
  // manifest without an 'office.publish' entry, so the registered lookup above
  // always succeeds in practice.
  return policy?.requiredCapability ?? 'lead'
}

export interface OfficePublishFreezeRecord {
  readonly installationId: string
  readonly connectorId: string
  readonly siteOrigin: string
  readonly payloadJson: string
  readonly payloadSha256: string
}

interface PriorOfficeFreezeRow {
  claimed_at: string | null
  outcome: string | null
}

// mupot#1592 P3 ("reconcile-before-reapprove against WordPress"): a freeze that was
// CLAIMED (office.publish_post committed to exactly one WordPress fetch) but never
// reached an outcome (the worker died mid-fetch, or the fetch itself timed out) is
// AMBIGUOUS — the post may or may not actually exist on the WordPress site. Minting
// a brand-new freeze over it (the ordinary rework-loop refreeze) would let a second
// approval authorize a second fetch against content that may already be live,
// double-posting. Refused here, at the one chokepoint every fresh freeze (review-
// entry AND rework re-entry) goes through, until an operator manually confirms the
// real outcome via office.reconcile_stalled_publish.
export async function unreconciledPriorFreezeExists(env: Env, taskId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT claimed_at, outcome FROM office_publish_freezes WHERE task_id = ?1`,
  ).bind(taskId).first<PriorOfficeFreezeRow>()
  return row !== null && row.claimed_at !== null && row.outcome === null
}

// mupot#1592 NEW-1 (r2 adversarial follow-up on PR #1588): computes the EXACT
// payload a human approval will bind — task.title/task.body (this addon's only
// content fields; office.publish_post takes NO title/content from its caller, see
// src/mcp/office.ts) plus the currently active installation/connector/site — as
// canonical JSON + its sha256 (src/lib/canonical-json.ts, the same digest helper
// manifest hashing uses). Pure computation: no DB write.
export async function buildOfficePublishFreeze(env: Env, task: Task): Promise<OfficeResult<OfficePublishFreezeRecord>> {
  if (await unreconciledPriorFreezeExists(env, task.id)) {
    return { ok: false, reason: 'unreconciled_prior_publish' }
  }

  const installationId = await resolveActiveOfficeInstallationId(env)
  if (!installationId) return { ok: false, reason: 'addon_inactive' }

  const bindingResult = await resolveOfficeConnectorBinding(env, installationId)
  if (!bindingResult.ok) return bindingResult

  const siteOrigin = await resolveOfficeSiteOrigin(env, bindingResult.value.connectorId)
  if (!siteOrigin) return { ok: false, reason: 'invalid_site_config' }

  const payload = {
    task_id: task.id,
    title: task.title,
    content: task.body,
    installation_id: installationId,
    connector_id: bindingResult.value.connectorId,
    site_origin: siteOrigin,
  }
  const payloadJson = canonicalJson(payload)
  const payloadSha256 = await sha256Hex(payloadJson)

  return {
    ok: true,
    value: { installationId, connectorId: bindingResult.value.connectorId, siteOrigin, payloadJson, payloadSha256 },
  }
}

// Persists (or REFRESHES, on a rework loop's re-entry into review) the frozen
// payload. The upsert resets claimed_by/claimed_at/outcome/outcome_detail/
// completed_at AND verdict_id/voided_at/voided_reason to NULL on every fresh
// freeze — a NEW review-entry always mints a NEW, unclaimed, unbound, unvoided
// one-shot slot; it never revives a previously claimed/executed/failed/voided one.
export async function persistOfficePublishFreeze(
  env: Env,
  taskId: string,
  frozenBy: string,
  freeze: OfficePublishFreezeRecord,
): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO office_publish_freezes (
      task_id, payload_json, payload_sha256, installation_id, connector_id, site_origin, frozen_by, frozen_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    ON CONFLICT(task_id) DO UPDATE SET
      payload_json = excluded.payload_json,
      payload_sha256 = excluded.payload_sha256,
      installation_id = excluded.installation_id,
      connector_id = excluded.connector_id,
      site_origin = excluded.site_origin,
      frozen_by = excluded.frozen_by,
      frozen_at = excluded.frozen_at,
      verdict_id = NULL,
      voided_at = NULL,
      voided_reason = NULL,
      claimed_by = NULL,
      claimed_at = NULL,
      outcome = NULL,
      outcome_detail = NULL,
      completed_at = NULL,
      generation = office_publish_freezes.generation + 1
  `).bind(
    taskId,
    freeze.payloadJson,
    freeze.payloadSha256,
    freeze.installationId,
    freeze.connectorId,
    freeze.siteOrigin,
    frozenBy,
    claimTimestamp(),
  ).run()
}

// mupot#1592 NEW-1 — the ONE call site that freezes a gate:office task's publish
// payload: the moment it ENTERS review. Wired into EVERY writer that can move a
// gate:office task into review (mupot#1602 r1 P2-1's "enumerate every writer"
// finding): src/mcp/index.ts's task_update, src/tasks/index.ts's PATCH, and — since
// office is meant to be the MAIN agent-authored content flow (r1 P2-2) —
// src/agents/execute.ts's finishTask, src/tasks/runtime-receipts.ts's 'completed'
// stage, and src/integrations/github-execute.ts's PR-linking write. Best-effort by
// design: a human's decision (or an agent's completion) must never be blocked on
// WordPress infra readiness (addon inactive, no connector, bad site config) — when
// a freeze cannot be built, this silently leaves NO freeze row (or an unreconciled
// prior one untouched), and office.review_approval's own `payload_not_frozen`/
// `unreconciled_prior_publish` refusal then correctly, permanently blocks the
// actual WordPress write until a fresh review-entry CAN bind a real target.
// Callers must not surface this as a request failure — the write that triggered it
// already succeeded on its own terms.
export async function freezeOfficeTaskOnReviewEntry(env: Env, task: Task, requestedBy: string): Promise<void> {
  const built = await buildOfficePublishFreeze(env, task)
  if (built.ok) {
    await persistOfficePublishFreeze(env, task.id, requestedBy, built.value)
  }
}

// mupot#1602 r1 P2-1 ("void the freeze on every exit from review, not only reject
// and reversal"): src/tasks/service.ts's syncCiResultToTask moves a task back to
// 'in_progress' on a failing CI run — an exit from review this addon's own edit-
// lock (officeTaskContentLocked below) never sees, because it is not a task_update/
// PATCH call at all. Idempotent (voided_at IS NULL guard); safe to call on a
// non-office task (no-op via the caller's own gate_owner check, not enforced here)
// or a task with no freeze row at all (0 rows, no error).
export async function voidOfficeFreezeOnReviewExit(env: Env, taskId: string, reason: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE office_publish_freezes SET voided_at = ?1, voided_reason = ?2 WHERE task_id = ?3 AND voided_at IS NULL`,
  ).bind(new Date().toISOString(), reason, taskId).run()
}

// mupot#1592 NEW-1 — the shared edit-lock predicate src/mcp/index.ts's task_update
// and src/tasks/index.ts's PATCH both call before applying a title/body/note/reason
// change: once a gate:office task is in 'review', a human is actively looking at
// (or about to look at) a payload whose hash is already frozen — the row must not
// change under them at all. One predicate, reused by both write surfaces.
export function officeTaskContentLocked(task: Pick<Task, 'gate_owner' | 'status'>): boolean {
  return task.gate_owner === OFFICE_GATE_OWNER && task.status === 'review'
}
