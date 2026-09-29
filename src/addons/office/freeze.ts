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
// JSON hashing) lives in leaf modules of its own. Its actual callers today —
// src/mcp/index.ts's task_update, src/tasks/index.ts's PATCH /:id, and
// src/addons/office/service.ts — import it STATICALLY. No dynamic import() of
// this addon anywhere in the codebase.
//
// mupot#1602 r2 (2nd adversarial BLOCK on this class): an EARLIER version of this
// comment claimed freezeOfficeTaskOnReviewEntry/voidOfficeFreezeOnReviewExit were
// also wired into src/agents/execute.ts's finishTask, src/tasks/runtime-
// receipts.ts's 'completed' stage, src/integrations/github-execute.ts, and
// src/tasks/service.ts's syncCiResultToTask. That was never true — none of those
// four call this module at all, so a gate:office task moved through any of them
// keeps whatever freeze it already had, live and unvoided, regardless of what the
// task's title/body become afterward (R2/R3 below). Per Kasra-core's explicit
// ruling after the 2nd BLOCK: no more per-writer hooks. The fix is the ONE
// invariant at the actual write — see reviewOfficeApproval/
// writeOfficeVerdictAndBindFreeze in service.ts and officeTaskContentLocked below.

import type { Env, Task, Capability } from '../../types'
import { listAddonInstallations, externalIsolationViolation } from '../service'
import { listAddonBindings, type AddonBinding } from '../bindings'
import { getRegisteredAddon } from '../registry'
import { manifestSha256 } from '../contract'
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
  | 'payload_stale'
  | 'unreconciled_prior_publish'
  | 'freeze_not_found'
  | 'already_reconciled'
  // r3 (kasra-review adversarial gate ROUND 2 on #1614): 'reconcile_check_failed'
  // (r1/r2's single catch-all for "could not get an authoritative answer") is
  // SPLIT into two reasons with different overridability, per THE CLASS
  // ("failing to find something is not evidence it's absent"):
  //   - reconcile_candidate_found: SOME evidence exists (a malformed exact
  //     idempotency-slug match, or any title/time fallback hit) — NEVER
  //     overridable, a human must resolve the actual post directly.
  //   - reconcile_check_unavailable: no evidence either way — a network/DNS/
  //     TLS failure, a revoked connector, origin drift, OR every lookup came
  //     back genuinely, cleanly empty. THE ONLY reason the human override may
  //     ever accept, and only once retried (see reconcile_retry_required).
  | 'reconcile_candidate_found'
  | 'reconcile_check_unavailable'
  | 'reconcile_retry_required'
  | 'binding_changed'
  | 'publish_claimed'
  | 'invalid_site_config'
  | 'invalid_site_url'
  // r3 P1-2 (kasra-review ROUND 2 adversarial gate): 'key_invalid' (401/403),
  // 'redirect_blocked' (3xx) and 'validation_rejected' (every other 4xx) are
  // RETIRED as definite-failure reasons — wordpressPublish no longer produces
  // them. A response-phase WAF, a save_post redirect, or a rest_after_insert
  // validation error can all follow a real, already-committed WordPress
  // INSERT, so none of those statuses may definitively clear the guard
  // anymore (see wordpressPublish's own header). Any post-send outcome other
  // than a parsed 2xx success is 'publish_outcome_unknown' below.
  | 'publish_outcome_unknown'
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

// r2 P3-2 (kasra-review adversarial gate on #1614): "nothing below the app
// enforces who may hold capability_v2='write' ... the publish path does not
// re-assert installationMayHoldWriteCapabilityBinding or the installation
// digest — resolveActiveOfficeInstallationId checks only state and trust
// class." Used ONLY by office.publish_post (the actual WordPress WRITE) —
// stricter than resolveActiveOfficeInstallationId above (which
// buildOfficePublishFreeze/the approval path still use: a human's content
// decision is deliberately independent of infra/manifest readiness, see this
// file's other comments). Re-derives, at the write itself, the SAME two
// invariants src/addons/bindings.ts's installationMayHoldWriteCapabilityBinding
// requires before a write binding may even be configured: the installation's
// OWN manifest_sha256 still matches what manifestSha256() computes for the
// CURRENTLY REGISTERED manifest (a stale/tampered installation row cannot
// coast on an identity check that ran once at configure time), and
// externalIsolationViolation still finds nothing. Neither call is free, but
// this runs once per publish attempt, never in a hot loop.
export async function resolveEligibleActiveOfficeInstallationId(env: Env): Promise<OfficeResult<string>> {
  const installationId = await resolveActiveOfficeInstallationId(env)
  if (!installationId) return { ok: false, reason: 'addon_inactive' }
  const entry = getRegisteredAddon(OFFICE_ADDON_KEY)
  if (!entry) return { ok: false, reason: 'addon_inactive' }
  const installations = await listAddonInstallations(env)
  const installation = installations.find((row) => row.id === installationId)
  if (!installation) return { ok: false, reason: 'addon_inactive' }
  if (installation.manifestSha256 !== await manifestSha256(entry.manifest)) {
    return { ok: false, reason: 'addon_inactive' }
  }
  if (externalIsolationViolation(entry.manifest) !== null) {
    return { ok: false, reason: 'addon_inactive' }
  }
  return { ok: true, value: installationId }
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
//
// r2 P2-1 (kasra-review adversarial gate on #1614): idempotency_key MUST also
// reset to NULL here. The ON CONFLICT clause previously omitted it entirely,
// so `COALESCE(idempotency_key, ?)` at claim time (src/addons/office/
// service.ts's publishOfficePost) kept GENERATION 1's key forever across every
// refreeze — the comment at the claim site claimed otherwise. Reproduced: an
// ambiguous publish leaves the row unclaimed-again after a rework loop, the
// SECOND claim reuses the FIRST generation's slug, WordPress stores it
// uniquified (`…-2`), and if generation 2 later stalls, reconcile's WordPress
// lookup finds GENERATION 1's post and force-writes 'done' with generation
// 1's URL — a false execution receipt for content that was never actually
// generation 2's. Resetting to NULL here means the next claim always mints a
// brand-new, generation-unique key (mirrors every other one-shot field this
// upsert already resets).
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
      idempotency_key = NULL,
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
// payload: the moment it ENTERS review via src/mcp/index.ts's task_update or
// src/tasks/index.ts's PATCH /:id (the only two callers — see this file's header).
// Best-effort by design: a human's decision to move content into review must
// never be blocked on WordPress infra readiness (addon inactive, no connector,
// bad site config) — when a freeze cannot be built, this silently leaves NO
// freeze row (or an unreconciled prior one untouched), and office.
// review_approval's own `payload_not_frozen`/`unreconciled_prior_publish`
// refusal then correctly, permanently blocks the actual WordPress write until a
// fresh review-entry CAN bind a real target. Callers must not surface this as a
// request failure — the write that triggered it already succeeded on its own
// terms.
//
// mupot#1602 r2 (2nd adversarial BLOCK on this class): this hook is NOT wired
// into every writer that can move a gate:office task into or out of review
// (src/agents/execute.ts's finishTask, src/tasks/runtime-receipts.ts,
// src/integrations/github-execute.ts, src/tasks/service.ts's
// syncCiResultToTask all bypass it entirely) — an earlier version of this file
// claimed otherwise and was wrong. That is now BY DESIGN, not a gap: r2's fix
// is the single write-time invariant in service.ts's
// writeOfficeVerdictAndBindFreeze (the freeze must still describe the task's
// LIVE content, re-checked at approval, regardless of which writer left the
// task in whatever state it is in) plus officeTaskContentLocked's
// freeze-existence-based lock below — neither depends on every writer
// remembering to call something.
export async function freezeOfficeTaskOnReviewEntry(env: Env, task: Task, requestedBy: string): Promise<void> {
  const built = await buildOfficePublishFreeze(env, task)
  if (built.ok) {
    await persistOfficePublishFreeze(env, task.id, requestedBy, built.value)
  }
}

// mupot#1602 r2 BLOCK P1 (2nd adversarial round on this class): the edit lock
// used to key on `task.gate_owner === 'gate:office' && task.status === 'review'`
// — both fields an ordinary org-admin action can flip independently of any
// freeze. Repro R3: an admin reassigns gate_owner AWAY from 'gate:office' (the
// lock now reads false regardless of status), the agent edits title/body
// freely, the admin reassigns gate_owner back to 'gate:office' — the STALE
// freeze from before the edit is still live (nothing voided it; reassigning
// gate_owner never touches office_publish_freezes) and still hash-matches
// itself, so a human approving what they now see would bind a freeze that no
// longer describes it. Fixed by keying the lock on the ACTUAL thing being
// protected — does a LIVE (non-voided) freeze exist for this task at all —
// instead of the two fields whose relationship to "a freeze exists" a caller
// can sever. A task with no freeze has nothing this lock protects and is left
// alone regardless of gate_owner/status; this is also why the value in a
// LIVE freeze existing is now checked directly rather than re-derived from
// gate_owner, matching writeOfficeVerdictAndBindFreeze's own live-content
// re-check (service.ts) as the SAME "check the thing itself, not a proxy for
// it" fix, at the two remaining places this addon makes a promise about a
// frozen payload.
export async function officeTaskContentLocked(env: Env, taskId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM office_publish_freezes WHERE task_id = ?1 AND voided_at IS NULL LIMIT 1`,
  ).bind(taskId).first()
  return row !== null
}
