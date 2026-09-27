// mupot — mcpwp-office addon: the three office.* tools' domain logic (mupot#1580 T2).
//
// Thin MCP wrappers live in src/mcp/office.ts (arg schemas, error-status mapping) —
// this file holds the actual authority/lifecycle/verdict/SSRF logic, reusing EXISTING
// machinery end to end rather than inventing a parallel one:
//
//   - installation liveness: listAddonInstallations (src/addons/service.ts) — the SAME
//     reader the addon catalog/dashboard use, not a bespoke query.
//   - connector binding: listAddonBindings (src/addons/bindings.ts) + useConnectorById
//     (src/connectors/service.ts) — the SAME vault-mediated fetch path health.ts and
//     the marketing mcpwp adapter already use. Credentials never leave useConnectorById.
//   - department authority: hasCapability(..., 'department', ...) — the same predicate
//     org/index.ts, mcp/provision.ts, and routines/service.ts already gate department
//     writes with.
//   - the human gate on office.publish_post: task_verdicts, via the SAME
//     evaluateVerdictGates/writeVerdict/findLatestVerdict functions the task_verdict
//     MCP tool itself calls (src/tasks/index.ts, src/tasks/service.ts) — narrowed to
//     tasks whose gate_owner is exactly 'gate:office' (this addon's own gate
//     namespace, the same shape as the existing 'gate:loops' namespace), so an
//     office.review_approval-holder cannot decide an unrelated task's gate, and an
//     office.publish_post caller cannot launder an unrelated approved task into a
//     WordPress write. No new verdict machinery, no new approval table.
//
// KNOWN, REPORTED GAPS this file works AROUND rather than papers over (see the PR body
// for the full detail): mcpwp-office cannot reach an 'active' installation through the
// REAL install→configure→activate lifecycle today — a SEPARATE bug in
// src/addons/bindings.ts's preflightAddonBindings unconditionally refuses any
// connectorRequirements entry whose capability is 'write' (`capability_mismatch`),
// and office's one connector slot is capability:'write' (the only one in the codebase).
// This file does not touch that gate; it reads addon_installations/
// addon_binding_generations/addon_connector_bindings exactly as configureAddon/
// activateAddon WOULD have left them once that gate is fixed — the same "read the
// state a working lifecycle would produce" contract listAddonInstallations/
// listAddonBindings already expose to every other reader.
//
// "Every write emits an execution receipt": no generic per-tool-call receipts
// primitive exists in this codebase to reuse (addon_receipts is lifecycle-action-only,
// a closed CHECK enum with no 'publish'/'execute' value; flight-spine receipts are
// scoped to flight/objective dispatch, not addon tool calls). Task.result/completed_at
// ("execution output ... or a short failure note", src/types.ts) IS the existing,
// generic mechanism for "the durable outcome of a piece of work" — office.publish_post
// uses exactly that, guarded by an atomic `WHERE status = 'approved'` UPDATE, rather
// than inventing a new receipts table.
//
// "content.posts_published" metric: NOT wired here. The only existing producer of that
// metric key is the marketing-cro-monitor's PULL-based monitor run
// (src/addons/marketing/adapters/mcpwp.ts, bound to a DIFFERENT connector slot —
// 'content_surface' under the growth/agency/web-ops departments), a scheduled
// collector, not a synchronous emit path any tool call can invoke. Reported, not
// built around — see the PR body.

import type { Env, AuthContext, Task, Capability } from '../../types'
import { hasCapability, isOrgAdmin } from '../../auth/capability'
import { listAddonInstallations } from '../service'
import { listAddonBindings, type AddonBinding } from '../bindings'
import { getRegisteredAddon } from '../registry'
import {
  useConnectorById,
  resolveConnectorByIdWithMeta,
  type ImmediateConnectorUse,
} from '../../connectors/service'
import { assertPublicHttpsUrl } from '../../lib/ssrf'
import { parseSiteConnectorConfig } from './health'
import { evaluateVerdictGates, canActOnSquad } from '../../tasks/index'
import { writeVerdict, VerdictRaceError, type TaskActor } from '../../tasks/service'
import { canonicalJson, sha256Hex } from '../../lib/canonical-json'
import { claimTimestamp } from '../../lib/claim-timestamp'

export const OFFICE_ADDON_KEY = 'mcpwp-office'
export const OFFICE_GATE_OWNER = 'gate:office'
export const OFFICE_WORDPRESS_SLOT = 'wordpress_site'
const OFFICE_DEPARTMENT_SLUG = 'office'
const WP_PUBLISH_TIMEOUT_MS = 8_000
const WP_POSTS_PATH = '/wp-json/wp/v2/posts'

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

// ── shared authority/lifecycle checks ───────────────────────────────────────────

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

async function resolveOfficeDepartmentId(env: Env): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT id FROM departments WHERE slug = ?1 LIMIT 1`,
  ).bind(OFFICE_DEPARTMENT_SLUG).first<{ id: string }>()
  return row?.id ?? null
}

/** True iff `auth` holds at least `min` capability on the office department (or org admin). */
export async function hasOfficeCapability(
  env: Env,
  auth: AuthContext,
  // Widened from 'member'|'lead' to the full Capability union so this can also be
  // called with a requiredCapability value read live from the registered manifest's
  // approvalPolicies (resolveOfficePublishRequiredCapability) rather than a
  // hardcoded literal — every existing caller still only ever passes 'member' or
  // 'lead', so this is behavior-identical for them.
  min: Capability,
): Promise<boolean> {
  if (isOrgAdmin(auth)) return true
  const departmentId = await resolveOfficeDepartmentId(env)
  if (!departmentId) return false
  return hasCapability(auth.capabilities ?? [], 'department', departmentId, min)
}

interface OfficeConnectorBinding {
  readonly connectorId: string
  readonly capability: AddonBinding['capability']
}

async function resolveOfficeConnectorBinding(env: Env, installationId: string): Promise<OfficeResult<OfficeConnectorBinding>> {
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
// 'write' as what a WordPress publish actually needs. Checked HERE, at publish
// time only (never at approval time — a human's decision to approve content is not
// itself a WordPress write and must not be blocked by a lifecycle/schema gap that
// is orthogonal to what was approved) — comparing against the REGISTERED
// manifest's declared capability, never a hardcoded 'write' literal (AddonBinding
// ['capability'] is itself typed as the literal 'read', so a literal 'write'
// comparison would not even compile), so this starts working with zero code change
// here the day T2b's schema/lifecycle gap is fixed and a 'write' binding becomes
// possible. Until then this correctly, permanently refuses every binding the real
// schema can produce.
function officeConnectorSatisfiesRequirement(capability: AddonBinding['capability']): boolean {
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
async function resolveOfficeSiteOrigin(env: Env, connectorId: string): Promise<string | null> {
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
function resolveOfficePublishRequiredCapability(): Capability {
  const policy = getRegisteredAddon(OFFICE_ADDON_KEY)?.manifest.approvalPolicies
    .find((entry) => entry.action === 'office.publish')
  // Defensive fallback only, never the primary source: validateAddonManifest's own
  // approval-policy invariant (src/addons/contract.ts) refuses registering this
  // manifest without an 'office.publish' entry, so the registered lookup above
  // always succeeds in practice.
  return policy?.requiredCapability ?? 'lead'
}

interface OfficePublishFreezeRecord {
  readonly installationId: string
  readonly connectorId: string
  readonly siteOrigin: string
  readonly payloadJson: string
  readonly payloadSha256: string
}

// P0-1 (kasra-review + Athena, PR #1588 round 1): computes the EXACT payload a
// human approval binds — task.title/task.body (this addon's only content fields;
// office.publish_post takes NO title/content from its caller, see src/mcp/office.ts)
// plus the currently active installation/connector/site — as canonical JSON + its
// sha256 (src/lib/canonical-json.ts, the same digest helper manifest hashing uses).
// Pure computation: no DB write. Called from reviewOfficeApproval BEFORE writeVerdict
// so an approval that cannot be bound to a live, resolvable target is refused rather
// than minted as 'approved' with nothing real behind it.
async function buildOfficePublishFreeze(env: Env, task: Task): Promise<OfficeResult<OfficePublishFreezeRecord>> {
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

// Persists (or REFRESHES, on a rework loop's second approval) the frozen payload.
// The upsert resets claimed_by/claimed_at/outcome/outcome_detail/completed_at to
// NULL on every fresh approval — a NEW approval always mints a NEW, unclaimed
// one-shot slot; it never revives a previously claimed/executed/failed one. Called
// ONLY after writeVerdict has actually landed the 'approved' status (see
// reviewOfficeApproval) — a verdict that lost its race never persists a freeze for
// a status change that didn't happen.
async function persistOfficePublishFreeze(
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
      claimed_by = NULL,
      claimed_at = NULL,
      outcome = NULL,
      outcome_detail = NULL,
      completed_at = NULL
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

// ── office.list_pending_approvals ───────────────────────────────────────────────

export interface OfficePendingApproval {
  readonly id: string
  readonly title: string
  readonly body: string
  readonly created_at: string
}

export async function listOfficePendingApprovals(
  env: Env,
  auth: AuthContext,
  limit = 50,
): Promise<OfficeResult<OfficePendingApproval[]>> {
  if (!(await hasOfficeCapability(env, auth, 'member'))) return { ok: false, reason: 'not_authorized' }

  const bounded = Number.isFinite(limit) && limit > 0 ? Math.min(Math.trunc(limit), 200) : 50
  // P3-1 (kasra-review adversarial round 1, PR #1588): this query used to select
  // EVERY gate:office task in 'review' across the ENTIRE tenant, with no squad or
  // department join at all — a task's own gate_owner string is not proof its squad
  // has anything to do with the office department, so a task attached to a
  // completely unrelated squad (any department) that happened to be gated
  // 'gate:office' was still returned, body included, to any office-department
  // member. hasOfficeCapability above is only the FLOOR (does this caller have
  // office access at all, department-wide or org-wide); it is not a per-row scope
  // check, so it does not by itself stop a cross-squad body leak. Filtered here,
  // per row, with the SAME canActOnSquad predicate task_verdict's own base guard
  // uses (src/tasks/index.ts) — no cross-squad body reaches the caller.
  const candidates = await env.DB.prepare(`
    SELECT id, title, body, created_at, squad_id
      FROM tasks
     WHERE gate_owner = ?1 AND status = 'review'
     ORDER BY created_at ASC
     LIMIT ?2
  `).bind(OFFICE_GATE_OWNER, bounded).all<OfficePendingApproval & { squad_id: string }>()

  const rows = candidates.results ?? []
  const allowed = await Promise.all(rows.map((row) => canActOnSquad(env, auth, row.squad_id)))
  const value = rows
    .filter((_row, index) => allowed[index])
    .map(({ id, title, body, created_at }) => ({ id, title, body, created_at }))

  return { ok: true, value }
}

// ── office.review_approval ──────────────────────────────────────────────────────

export interface OfficeReviewApprovalInput {
  readonly task: Task
  readonly verdict: 'approved' | 'rejected'
  readonly note: string | null
}

export interface OfficeReviewApprovalOutcome {
  readonly task: Task
}

export async function reviewOfficeApproval(
  env: Env,
  auth: AuthContext,
  input: OfficeReviewApprovalInput,
): Promise<OfficeResult<OfficeReviewApprovalOutcome>> {
  const { task, verdict, note } = input

  // Content-binding check: this tool may only decide tasks that are ACTUALLY gated
  // under this addon's own gate namespace — never an arbitrary task, even one the
  // caller otherwise has standing to verdict. Mirrors the department-namespace
  // discipline externalIsolationViolation enforces on the manifest itself.
  if (task.gate_owner !== OFFICE_GATE_OWNER) return { ok: false, reason: 'wrong_gate' }
  if (task.status !== 'review') return { ok: false, reason: 'not_in_review' }

  // P1-2 (kasra-review adversarial round 1, PR #1588): a HUMAN member must decide
  // this — never an agent, including an agent-bound bearer that carries its owner
  // MEMBER's capabilities (resolveCapabilities(c.env, row.member_id), src/mcp/
  // index.ts) and so can pass every capability/gate check below without a human
  // ever having been involved. A capability grant proves authority to act on the
  // department; it does not prove a human made THIS decision, which is the entire
  // point of a human-review gate in front of a public WordPress write.
  if (auth.boundAgentId) return { ok: false, reason: 'agent_approval_forbidden' }

  // The requester can never approve their own request. evaluateVerdictGates' own
  // self_verdict rule (below) only ever compares against task.assignee_agent_id —
  // office is the first surface where the DECIDER and the task's human OWNER
  // (assignee_member_id) can be the same principal, so that shared check alone
  // does not catch it here.
  const principalMemberId = auth.memberId ?? auth.userId
  if (task.assignee_member_id && task.assignee_member_id === principalMemberId) {
    return { ok: false, reason: 'self_verdict' }
  }

  // Squad scope — P2-2 (kasra-review adversarial round 1): this call used to skip
  // the base squad-membership guard task_verdict's own HTTP/MCP surfaces both run
  // BEFORE evaluateVerdictGates (canActOnSquad, src/tasks/index.ts) — a caller who
  // held a gate:office grant but belonged to a DIFFERENT squad only got 'ok' here
  // while task_verdict correctly 403s the identical task/caller pair. One task, one
  // verdict authority: this call site must never be looser than the generic one.
  if (!(await canActOnSquad(env, auth, task.squad_id))) {
    return { ok: false, reason: 'not_authorized' }
  }

  // The manifest's own approvalPolicies entry for 'office.publish'
  // (requiredCapability, selfApproval:false — src/addons/office/manifest.ts) was
  // declared but never actually read by this tool; a caller holding ONLY a
  // gate:office grant (no department capability at all) could approve. Read live
  // from the registered manifest, never hardcoded.
  const requiredCapability = resolveOfficePublishRequiredCapability()
  if (!(await hasOfficeCapability(env, auth, requiredCapability))) {
    return { ok: false, reason: 'not_authorized' }
  }

  const gateResult = await evaluateVerdictGates(
    env,
    auth,
    { squad_id: task.squad_id, gate_owner: task.gate_owner, assignee_agent_id: task.assignee_agent_id },
    verdict,
  )
  if (!gateResult.allowed) {
    if (gateResult.code === 'self_verdict') return { ok: false, reason: 'self_verdict' }
    return { ok: false, reason: 'not_authorized' }
  }

  // P0-1: freeze the exact publish target BEFORE writing the verdict — read-only
  // (no DB write yet), so an approval that cannot be bound to a live, resolvable
  // WordPress target is refused outright rather than minted as 'approved' with
  // nothing real behind it. Rejections need no freeze at all.
  // A human's decision to approve CONTENT is independent of whether a WordPress
  // target is currently resolvable (installed/active/bound) — refusing the
  // approval itself on infra state would block a human decision on operational
  // readiness, which this gate is not for. When no freeze can be built (addon
  // inactive, no connector, bad site config), the approval still lands, but
  // WITHOUT a frozen payload — office.publish_post's own `payload_not_frozen`
  // refusal then correctly, permanently blocks the actual WordPress write until a
  // fresh approval (reject + re-approve) CAN bind a real target. No security
  // property depends on refusing the verdict here: publish is fail-closed either way.
  let freeze: OfficePublishFreezeRecord | null = null
  if (verdict === 'approved') {
    const built = await buildOfficePublishFreeze(env, task)
    if (built.ok) freeze = built.value
  }

  try {
    const written = await writeVerdict(
      env,
      { task, verdict, note, decidedBy: gateResult.principal.id },
      gateResult.principal.actor as TaskActor | undefined,
    )
    // Persisted only once the verdict has ACTUALLY landed (writeVerdict throws
    // VerdictRaceError otherwise, caught below) — a verdict that lost its race
    // never leaves a freeze row behind for a status change that never happened.
    if (freeze) {
      await persistOfficePublishFreeze(env, task.id, gateResult.principal.id, freeze)
    }
    return { ok: true, value: { task: written.task } }
  } catch (error) {
    if (error instanceof VerdictRaceError) return { ok: false, reason: 'verdict_race' }
    throw error
  }
}

// ── office.publish_post ──────────────────────────────────────────────────────────

// P0-1 (kasra-review + Athena, PR #1588 round 1): title/content are NO LONGER part
// of this input — office.publish_post's MCP schema (src/mcp/office.ts) no longer
// accepts them from the caller at all. The only content this tool will ever publish
// is whatever office.review_approval froze at approval time (office_publish_freezes,
// keyed on task.id) — see buildOfficePublishFreeze/persistOfficePublishFreeze above.
export interface OfficePublishPostInput {
  readonly task: Task
}

export interface OfficePublishPostOutcome {
  readonly postId: number
  readonly articleUrl: string
}

function isRedirect(response: Response): boolean {
  return (response.type as string) === 'opaqueredirect'
    || (response.status >= 300 && response.status < 400)
}

/**
 * office.publish_post's actual WordPress write. SSRF-safe by construction — the
 * ONLY thing derived from the stored/attacker-influenced siteUrl is `base.origin`
 * (a plain string), never its pathname; the request path is the hardcoded literal
 * `/wp-json/wp/v2/posts`, exactly the pattern src/departments/executors/mcpwp.ts and
 * src/addons/marketing/adapters/mcpwp.ts already use. Unlike health.ts's probe, there
 * is no subdirectory-preservation logic here to re-validate — origin-only
 * construction cannot be steered by a `//`/`\\`-prefixed stored path in the first
 * place, so no second assertPublicHttpsUrl call is needed on the built endpoint (it
 * is never rebuilt from untrusted path text).
 */
// useConnectorById's callback must return an ImmediateConnectorResult-shaped value
// (status/observations/reason?) — the same contract health.ts's probe and the
// marketing mcpwp adapter already conform to (safeImmediateResult's secret-scrubbing
// walk depends on this shape). The publish outcome rides in `observations[0]` on
// success; there is no secret in it (postId/articleUrl are WordPress-assigned, public).
interface WpPublishConnectorResult {
  readonly status: 'available' | 'unavailable' | 'failed'
  readonly observations: readonly [OfficePublishPostOutcome] | readonly []
  readonly reason?: OfficeRefusalReason
}

async function wordpressPublish(
  env: Env,
  connectorId: string,
  title: string,
  content: string,
): Promise<OfficeResult<OfficePublishPostOutcome>> {
  const result = await useConnectorById<WpPublishConnectorResult>(env, connectorId, 'mcpwp', async (connector: ImmediateConnectorUse) => {
    const config = parseSiteConnectorConfig(connector.meta)
    if (!config) return { status: 'unavailable', reason: 'invalid_site_config', observations: [] }

    let base: URL
    try {
      base = assertPublicHttpsUrl(config.siteUrl)
    } catch {
      return { status: 'unavailable', reason: 'invalid_site_url', observations: [] }
    }

    const endpoint = new URL(WP_POSTS_PATH, base.origin)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), WP_PUBLISH_TIMEOUT_MS)
    try {
      const response = await connector.authenticatedFetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'mupot-office-addon-publish/1.0' },
        redirect: 'manual',
        signal: controller.signal,
        body: JSON.stringify({ title, content, status: 'publish' }),
      })
      if (response.status === 401 || response.status === 403) {
        return { status: 'failed', reason: 'key_invalid', observations: [] }
      }
      if (isRedirect(response)) return { status: 'failed', reason: 'redirect_blocked', observations: [] }
      if (!response.ok) return { status: 'failed', reason: 'unreachable', observations: [] }
      const body = (await response.json().catch(() => null)) as { id?: number; link?: string } | null
      if (!body || typeof body.id !== 'number' || typeof body.link !== 'string' || !body.link) {
        return { status: 'failed', reason: 'bad_response', observations: [] }
      }
      return { status: 'available', observations: [{ postId: body.id, articleUrl: body.link }] }
    } catch {
      return { status: 'failed', reason: 'unreachable', observations: [] }
    } finally {
      clearTimeout(timer)
    }
  })
  if (!result) return { ok: false, reason: 'connector_not_bound' }
  if (result.status === 'available' && result.observations[0]) return { ok: true, value: result.observations[0] }
  return { ok: false, reason: result.reason ?? 'unreachable' }
}

/**
 * Marks the task done with the WordPress write's result — the "execution receipt"
 * (Task.result/completed_at are the existing, generic fields for this; see the file
 * header for why no new receipts table was built). Guarded atomically on
 * `status = 'approved'`: a concurrent second publish attempt (or a task that somehow
 * left 'approved' between the verdict check and here) gets zero rows changed, which
 * the caller treats as a race/already-executed refusal rather than a silent
 * double-write.
 */
async function markOfficeTaskPublished(
  env: Env,
  taskId: string,
  outcome: OfficePublishPostOutcome,
): Promise<boolean> {
  const now = new Date().toISOString()
  const result = await env.DB.prepare(`
    UPDATE tasks
       SET status = 'done', result = ?1, completed_at = ?2, updated_at = ?2
     WHERE id = ?3 AND status = 'approved'
  `).bind(JSON.stringify({ postId: outcome.postId, articleUrl: outcome.articleUrl }), now, taskId).run()
  return (result.meta?.changes ?? 0) > 0
}

interface OfficePublishFreezeRow {
  payload_json: string
  installation_id: string
  connector_id: string
  site_origin: string
}

export async function publishOfficePost(
  env: Env,
  auth: AuthContext,
  input: OfficePublishPostInput,
): Promise<OfficeResult<OfficePublishPostOutcome>> {
  const { task } = input

  // Content-binding: the approved task must ACTUALLY be an office-gated task — never
  // an unrelated approved task laundered in to authorize a WordPress write.
  if (task.gate_owner !== OFFICE_GATE_OWNER) return { ok: false, reason: 'wrong_gate' }
  // Tied directly to reviewOfficeApproval's postcondition (writeVerdict sets status to
  // 'approved' on an approved verdict) — a task that never reached 'approved' has, by
  // construction, either no verdict yet or a rejected/reversed one. No fetch either way.
  if (task.status !== 'approved') return { ok: false, reason: 'not_approved' }

  if (!(await hasOfficeCapability(env, auth, resolveOfficePublishRequiredCapability()))) {
    return { ok: false, reason: 'not_authorized' }
  }

  // P0-1: the ONLY source of title/content is what office.review_approval froze —
  // never this call's caller (there is no caller-supplied title/content anymore at
  // all, see OfficePublishPostInput above). No row here means this approval was
  // never frozen (e.g. a gate:office task approved directly through the generic
  // task_verdict tool, bypassing office.review_approval entirely) — fail closed.
  const freezeRow = await env.DB.prepare(`
    SELECT payload_json, installation_id, connector_id, site_origin
      FROM office_publish_freezes WHERE task_id = ?1
  `).bind(task.id).first<OfficePublishFreezeRow>()
  if (!freezeRow) return { ok: false, reason: 'payload_not_frozen' }

  // Re-resolve the CURRENTLY active target and refuse if it has drifted since
  // approval (an install/connector/site rebind after a human approved THIS content
  // must never silently redirect the write — the other half of P0-1's binding).
  const installationId = await resolveActiveOfficeInstallationId(env)
  if (!installationId) return { ok: false, reason: 'addon_inactive' }
  const bindingResult = await resolveOfficeConnectorBinding(env, installationId)
  if (!bindingResult.ok) return bindingResult
  const siteOrigin = await resolveOfficeSiteOrigin(env, bindingResult.value.connectorId)
  if (!siteOrigin) return { ok: false, reason: 'invalid_site_config' }
  if (
    installationId !== freezeRow.installation_id ||
    bindingResult.value.connectorId !== freezeRow.connector_id ||
    siteOrigin !== freezeRow.site_origin
  ) {
    return { ok: false, reason: 'binding_changed' }
  }

  // P3-2: the binding must actually satisfy what this manifest declares the
  // 'wordpress_site' slot needs ('write') — checked here, at the write itself,
  // never at approval (see officeConnectorSatisfiesRequirement's doc comment
  // above). Every binding the real schema can produce today is 'read', so this
  // permanently refuses until T2b's schema/lifecycle gap is fixed elsewhere.
  if (!officeConnectorSatisfiesRequirement(bindingResult.value.capability)) {
    return { ok: false, reason: 'connector_capability_mismatch' }
  }

  // One-shot claim, BEFORE any credential read or fetch (P1-1: the ORIGINAL guard
  // — `WHERE status = 'approved'` on the task's OWN status flip — ran AFTER the
  // fetch, so it could only decide which concurrent WRITE got recorded, never stop
  // a second WordPress POST from actually happening; proven live by the
  // adversarial gate, 3 concurrent calls -> 3 fetches, 3 live posts). 0 rows
  // changed means someone else already claimed this exact approval — refused with
  // NO fetch, and this row is NEVER un-claimed by this addon: a failed or timed-out
  // publish (P3-3) needs a fresh human approval (reject + re-approve mints a brand
  // new, unclaimed row via persistOfficePublishFreeze's upsert), never an automatic
  // retry against the same claim.
  const claimant = auth.boundAgentId ?? auth.memberId ?? auth.userId
  const claim = await env.DB.prepare(`
    UPDATE office_publish_freezes SET claimed_by = ?1, claimed_at = ?2
     WHERE task_id = ?3 AND claimed_at IS NULL
  `).bind(claimant, claimTimestamp(), task.id).run()
  if ((claim.meta?.changes ?? 0) === 0) return { ok: false, reason: 'publish_claimed' }

  const frozenPayload = JSON.parse(freezeRow.payload_json) as { title: string; content: string }
  const published = await wordpressPublish(env, bindingResult.value.connectorId, frozenPayload.title, frozenPayload.content)
  const now = new Date().toISOString()

  if (!published.ok) {
    await env.DB.prepare(
      `UPDATE office_publish_freezes SET outcome = 'failed', outcome_detail = ?1, completed_at = ?2 WHERE task_id = ?3`,
    ).bind(published.reason, now, task.id).run()
    return published
  }

  await env.DB.prepare(
    `UPDATE office_publish_freezes SET outcome = 'done', outcome_detail = ?1, completed_at = ?2 WHERE task_id = ?3`,
  ).bind(JSON.stringify(published.value), now, task.id).run()

  const marked = await markOfficeTaskPublished(env, task.id, published.value)
  if (!marked) return { ok: false, reason: 'verdict_race' }

  return published
}
