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
// The FREEZE primitives (buildOfficePublishFreeze, persistOfficePublishFreeze,
// freezeOfficeTaskOnReviewEntry, officeTaskContentLocked, and every pure resolver
// they depend on) live in src/addons/office/freeze.ts, NOT here — that module has
// zero dependency on src/tasks/index.ts, so src/tasks/index.ts (the HTTP PATCH
// handler) can import it STATICALLY. This file imports FROM tasks/index.ts
// (evaluateVerdictGates, canActOnSquad), so it must never be imported back by
// tasks/index.ts — see freeze.ts's own header for the full story (mupot#1602 r1 P0:
// a dynamic import() here instead of that split bricked the bundled Worker).
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

import type { Env, AuthContext, Task, Capability, TaskVerdict } from '../../types'
import { hasCapability, isOrgAdmin } from '../../auth/capability'
import { useConnectorById, type ImmediateConnectorUse } from '../../connectors/service'
import { assertPublicHttpsUrl } from '../../lib/ssrf'
import { parseSiteConnectorConfig } from './health'
import { evaluateVerdictGates, canActOnSquad } from '../../tasks/index'
import {
  VerdictRaceError,
  buildVerdictStatements,
  assertVerdictWritable,
  emitVerdictBusEvent,
  type TaskActor,
  type WriteVerdictInput,
} from '../../tasks/service'
import { claimTimestamp } from '../../lib/claim-timestamp'
import {
  OFFICE_GATE_OWNER,
  resolveActiveOfficeInstallationId,
  resolveOfficeConnectorBinding,
  resolveOfficeSiteOrigin,
  officeConnectorSatisfiesRequirement,
  resolveOfficePublishRequiredCapability,
  type OfficeResult,
  type OfficeRefusalReason,
} from './freeze'

export type { OfficeResult, OfficeRefusalReason } from './freeze'
export { OFFICE_ADDON_KEY, OFFICE_GATE_OWNER, OFFICE_WORDPRESS_SLOT } from './freeze'

const OFFICE_DEPARTMENT_SLUG = 'office'
const WP_PUBLISH_TIMEOUT_MS = 8_000
const WP_POSTS_PATH = '/wp-json/wp/v2/posts'
// mupot#1602 r1 P3-3: a publish can legitimately still be in flight for up to
// WP_PUBLISH_TIMEOUT_MS — reconciling a claim as 'failed'/'done' mid-flight would
// clear the double-post guard while the original fetch could still land. Require
// the claim to be at least this much older than "just claimed" before an operator
// may reconcile it at all — a healthy margin above the fetch's own timeout.
const RECONCILE_MIN_STALENESS_MS = WP_PUBLISH_TIMEOUT_MS * 3

// ── shared authority checks ──────────────────────────────────────────────────────

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
  min: Capability,
): Promise<boolean> {
  if (isOrgAdmin(auth)) return true
  const departmentId = await resolveOfficeDepartmentId(env)
  if (!departmentId) return false
  return hasCapability(auth.capabilities ?? [], 'department', departmentId, min)
}

// ── office.list_pending_approvals ───────────────────────────────────────────────

export interface OfficePendingApproval {
  readonly id: string
  readonly title: string
  readonly body: string
  readonly created_at: string
  // mupot#1592 NEW-1: the hash of whatever was frozen when this task entered
  // review (src/addons/office/freeze.ts's freezeOfficeTaskOnReviewEntry) — the
  // EXACT value a caller must echo back as `expected_payload_sha256` to
  // office.review_approval for an 'approved' verdict to land. null when no freeze
  // exists yet (addon not active/bound at review-entry time, or the prior freeze
  // is unreconciled) — approving is refused in that state (office.review_approval's
  // own P2-2 fix), so this listing has nothing to protect either way.
  readonly payload_sha256: string | null
}

interface OfficePendingApprovalRow {
  id: string
  title: string
  body: string
  created_at: string
  squad_id: string
  payload_json: string | null
  payload_sha256: string | null
}

export async function listOfficePendingApprovals(
  env: Env,
  auth: AuthContext,
  limit = 50,
): Promise<OfficeResult<OfficePendingApproval[]>> {
  if (!(await hasOfficeCapability(env, auth, 'member'))) return { ok: false, reason: 'not_authorized' }

  const bounded = Number.isFinite(limit) && limit > 0 ? Math.min(Math.trunc(limit), 200) : 50
  // P3-1 (kasra-review adversarial round 1, PR #1588): squad-scoped, same as
  // before — see the long-form comment history in git blame for the original
  // cross-squad-leak finding this closed.
  //
  // mupot#1602 r1 adversarial gate P2-1: this used to select `t.title`/`t.body`
  // (the LIVE row) next to `f.payload_sha256` (the FROZEN hash) — two different
  // rows' worth of truth on one line. Any writer that moves a task through review
  // without going through the freeze hook (there were several — see freeze.ts's
  // header) could make the human-visible text and the hashed bytes diverge: human
  // approves what they see (benign), the hash silently binds something else
  // (evil), because "what they see" and "what got hashed" were two different
  // reads. Fixed BY CONSTRUCTION: when a live (non-voided) freeze exists, title/
  // body here are parsed OUT OF `payload_json` — the identical bytes the hash was
  // computed over and the identical bytes office.publish_post will one day send
  // to WordPress. There is no code path left where the human is shown something
  // different from what the hash protects. Falls back to the live row only when
  // NO freeze exists at all (nothing frozen to show instead) — office.
  // review_approval's own P2-2 fix refuses to approve in that state regardless.
  const candidates = await env.DB.prepare(`
    SELECT t.id as id, t.title as title, t.body as body, t.created_at as created_at, t.squad_id as squad_id,
           f.payload_json as payload_json, f.payload_sha256 as payload_sha256
      FROM tasks t
      LEFT JOIN office_publish_freezes f ON f.task_id = t.id AND f.voided_at IS NULL
     WHERE t.gate_owner = ?1 AND t.status = 'review'
     ORDER BY t.created_at ASC
     LIMIT ?2
  `).bind(OFFICE_GATE_OWNER, bounded).all<OfficePendingApprovalRow>()

  const rows = candidates.results ?? []
  const allowed = await Promise.all(rows.map((row) => canActOnSquad(env, auth, row.squad_id)))
  const value = rows
    .filter((_row, index) => allowed[index])
    .map((row): OfficePendingApproval => {
      if (row.payload_json) {
        try {
          const frozen = JSON.parse(row.payload_json) as { title?: unknown; content?: unknown }
          if (typeof frozen.title === 'string' && typeof frozen.content === 'string') {
            return { id: row.id, title: frozen.title, body: frozen.content, created_at: row.created_at, payload_sha256: row.payload_sha256 }
          }
        } catch {
          // Malformed payload_json should never happen (canonicalJson always
          // produces valid JSON) — fall through to the live row rather than 500.
        }
      }
      return { id: row.id, title: row.title, body: row.body, created_at: row.created_at, payload_sha256: null }
    })

  return { ok: true, value }
}

// ── office.review_approval ──────────────────────────────────────────────────────

export interface OfficeReviewApprovalInput {
  readonly task: Task
  readonly verdict: 'approved' | 'rejected'
  readonly note: string | null
  // mupot#1592 NEW-1: required for an 'approved' verdict — the payload_sha256 the
  // caller read off office.list_pending_approvals BEFORE deciding. Compared
  // against what is currently frozen; a mismatch means the row the human looked
  // at is not the row this call is about to bind, and is refused before any
  // state change. Ignored for 'rejected' — a rejection commits to no WordPress
  // write, so there is nothing for the hash to protect.
  readonly expectedPayloadSha256: string | null
}

export interface OfficeReviewApprovalOutcome {
  readonly task: Task
}

interface OfficeFreezeBindingRow {
  payload_sha256: string
  payload_json: string
  voided_at: string | null
}

export async function reviewOfficeApproval(
  env: Env,
  auth: AuthContext,
  input: OfficeReviewApprovalInput,
): Promise<OfficeResult<OfficeReviewApprovalOutcome>> {
  const { task, verdict, note, expectedPayloadSha256 } = input

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

  // mupot#1592 NEW-1, tightened by mupot#1602 r1 P2-2: an 'approved' verdict
  // REQUIRES a live (non-voided) freeze to exist and the caller's hash to match
  // it — no fetch, no state change, happens before any write. Round 1's original
  // design let approval succeed with NO freeze at all ("a human's decision to
  // approve content is independent of WordPress infra readiness"), on the theory
  // that publish would fail-closed regardless. The adversarial gate correctly
  // called that a success-shaped no-op on the addon's OWN main producer of
  // content (agents landing office tasks in review) — the tool's own description
  // already promised "a mismatch (or a missing/voided freeze) refuses the
  // approval", so make the code match it. A rejection needs no freeze/hash at
  // all: it authorizes no WordPress write.
  if (verdict === 'approved') {
    const freezeRow = await env.DB.prepare(
      `SELECT payload_sha256, payload_json, voided_at FROM office_publish_freezes WHERE task_id = ?1`,
    ).bind(task.id).first<OfficeFreezeBindingRow>()
    const hasLiveFreeze = freezeRow !== null && freezeRow.voided_at === null
    if (!hasLiveFreeze) return { ok: false, reason: 'payload_not_frozen' }
    if (!expectedPayloadSha256) return { ok: false, reason: 'expected_hash_required' }
    if (freezeRow.payload_sha256 !== expectedPayloadSha256) return { ok: false, reason: 'payload_mismatch' }

    // mupot#1602 r2 BLOCK P1 (2nd adversarial round on this class): a freeze
    // existing, unvoided, with a hash that matches what the human read is NOT
    // enough — it must also still describe the task's CURRENT content. Neither
    // "unvoided" nor "hash matches the human's own stale read" catches a freeze
    // that has quietly stopped describing the live task (R2: a CI failure exits
    // review with no void, because voidOfficeFreezeOnReviewExit was never wired
    // into anything, see freeze.ts's corrected header; R3: reassigning gate_owner
    // away disables the OLD edit lock, which was keyed on gate_owner, not on a
    // freeze existing). Re-derived here in JS as a fast, clear refusal — the
    // AUTHORITATIVE re-check is the SQL-level guard inside
    // writeOfficeVerdictAndBindFreeze below, re-read inside the SAME transaction
    // as the write, which is what actually closes both repros (this JS check can
    // itself race; the SQL one cannot).
    let frozen: { title?: unknown; content?: unknown }
    try {
      frozen = JSON.parse(freezeRow.payload_json) as { title?: unknown; content?: unknown }
    } catch {
      return { ok: false, reason: 'payload_stale' }
    }
    if (frozen.title !== task.title || frozen.content !== task.body) {
      return { ok: false, reason: 'payload_stale' }
    }
  }

  try {
    const written = await writeOfficeVerdictAndBindFreeze(
      env,
      task,
      verdict,
      note,
      gateResult.principal.id,
      expectedPayloadSha256,
      gateResult.principal.actor as TaskActor | undefined,
    )
    return { ok: true, value: { task: written.task } }
  } catch (error) {
    if (error instanceof VerdictRaceError) return { ok: false, reason: 'verdict_race' }
    throw error
  }
}

// mupot#1592 NEW-2/NEW-4 (r2 adversarial follow-up on PR #1588), hardened by
// mupot#1602 r1 P1: writes the verdict AND binds (approved) or voids (rejected)
// the ALREADY-frozen payload in the SAME D1 batch, anchored on the verdict row's
// own id — the exact landed-PROOF pattern buildVerdictStatements' own two
// statements already use (src/tasks/service.ts), and the same extension point
// src/im/origin-verdict.ts's commitOriginDecision already uses to append ITS OWN
// statements to this same batch shape. Deliberately bypasses writeVerdict()
// (which now refuses 'gate:office' outright, NEW-2's own fix forcing every OTHER
// verdict surface through this one) rather than duplicating its logic —
// assertVerdictWritable/buildVerdictStatements/emitVerdictBusEvent are the SAME
// shared primitives writeVerdict itself is built from.
async function writeOfficeVerdictAndBindFreeze(
  env: Env,
  task: Task,
  verdict: 'approved' | 'rejected',
  note: string | null,
  decidedBy: string,
  expectedPayloadSha256: string | null,
  actor?: TaskActor,
): Promise<{ task: Task; verdict: TaskVerdict }> {
  await assertVerdictWritable(env, task)
  // gate:office tasks are never routine-created (resolveVerdictProposalId only
  // ever resolves for gate:routines) — passing null explicitly rather than paying
  // for the lookup writeVerdict's own auto-resolution would otherwise perform.
  const input: WriteVerdictInput = { task, verdict, note, decidedBy, proposalId: null }

  // mupot#1602 r1 P1 (check-then-write race, the SAME class NEW-3 already closed
  // on the publish claim): reviewOfficeApproval's hash compare above is a plain
  // SELECT — a TOCTOU window exists between it and this batch landing. In that
  // window, a rework loop (reverse/reject -> edit -> re-enter review) legitimately
  // mints a BRAND NEW freeze, and buildVerdictStatements' own guard only requires
  // `status = 'review'`, which the rework's re-entry restores — so the OLD hash
  // check passing does not mean THIS write is still approving the same bytes.
  // extraGuard makes the freeze's CURRENT state (re-read inside this very
  // transaction, not the earlier SELECT) part of the SAME WHERE that flips
  // task.status — if the freeze's live payload_sha256 no longer matches what the
  // human hashed, or it has already been bound/voided, the tasks UPDATE itself
  // matches 0 rows and the whole verdict is a no-op (VerdictRaceError), not just
  // the freeze-bind statement below.
  //
  // mupot#1602 r2 BLOCK P1 (2nd adversarial round, the actual fix for this
  // class): the guard above only re-checks the FREEZE row against itself
  // (unvoided, hash matches, unbound) — it never asked whether the freeze still
  // describes the TASK. R2/R3's repros both leave a freeze that is unvoided and
  // still hash-matches the human's stale read while the task's live title/body
  // have moved on (a CI failure exiting review with no void; an admin
  // reassigning gate_owner away and back, which disabled the OLD gate_owner-
  // keyed edit lock in between). `title = json_extract(payload_json, '$.title')
  // AND body = json_extract(payload_json, '$.content')` is a CORRELATED
  // comparison against the outer UPDATE's own `tasks` row (unqualified
  // title/body resolve outward here because office_publish_freezes has no such
  // columns) — the live content and the frozen content, read fresh inside this
  // same transaction, must be byte-identical or this whole verdict is a no-op.
  //
  // Chose a direct field comparison via SQLite's built-in json_extract() over
  // either hashing inside SQL or a separately-maintained "live content hash"
  // column: D1/SQLite ships no SHA-256 (or any cryptographic hash) function and
  // there is no way to invoke the Worker's crypto.subtle from a WHERE clause, so
  // "recompute the canonical hash inside SQL" is not actually available without
  // a compiled extension this project does not ship. A live-content hash column
  // on `tasks`, kept current by "every task write remembers to update it",
  // reintroduces EXACTLY the "trust every writer" failure class that already
  // produced two BLOCKs on this issue (the gate_owner-keyed edit lock and the
  // freeze-on-review-entry hook were both per-writer and both incomplete).
  // json_extract(payload_json, ...) vs tasks.title/tasks.body compares the SAME
  // two ground-truth values every other part of this addon already trusts — no
  // derived state, no new column, nothing for a future writer to forget to
  // maintain, re-evaluated fresh by every caller's own transaction.
  const extraGuard = verdict === 'approved'
    ? {
        sql: `EXISTS (
          SELECT 1 FROM office_publish_freezes f
           WHERE f.task_id = ? AND f.payload_sha256 = ? AND f.voided_at IS NULL AND f.verdict_id IS NULL
             AND title = json_extract(f.payload_json, '$.title')
             AND body = json_extract(f.payload_json, '$.content')
        )`,
        params: [task.id, expectedPayloadSha256],
      }
    : undefined
  const { statements, verdictRow, newStatus, now } = buildVerdictStatements(env, input, extraGuard)

  // Anchored on `verdictRow.id` — a value this call minted itself before the batch
  // ran (buildVerdictStatements' own crypto.randomUUID()), so `EXISTS (SELECT 1
  // FROM task_verdicts WHERE id = ?)` can only be true if the verdict INSERT two
  // statements above it in this SAME batch actually landed (its own EXISTS guard,
  // now including extraGuard, held) — never a leftover row from a different call.
  // `payload_sha256 = ?` is repeated here too (belt-and-suspenders with extraGuard
  // above, per the adversarial gate's explicit ask) — even if extraGuard were ever
  // refactored away, this statement alone still cannot bind a freeze whose current
  // hash differs from what was approved.
  if (verdict === 'approved') {
    statements.push(
      env.DB.prepare(
        `UPDATE office_publish_freezes SET verdict_id = ?1
          WHERE task_id = ?2 AND payload_sha256 = ?3 AND voided_at IS NULL AND verdict_id IS NULL
            AND EXISTS (SELECT 1 FROM task_verdicts WHERE id = ?4)
            AND EXISTS (
              SELECT 1 FROM tasks t
               WHERE t.id = office_publish_freezes.task_id
                 AND t.title = json_extract(office_publish_freezes.payload_json, '$.title')
                 AND t.body = json_extract(office_publish_freezes.payload_json, '$.content')
            )`,
      ).bind(verdictRow.id, task.id, expectedPayloadSha256, verdictRow.id),
    )
  } else {
    statements.push(
      env.DB.prepare(
        `UPDATE office_publish_freezes SET voided_at = ?1, voided_reason = 'rejected'
          WHERE task_id = ?2 AND voided_at IS NULL AND EXISTS (SELECT 1 FROM task_verdicts WHERE id = ?3)`,
      ).bind(now, task.id, verdictRow.id),
    )
  }

  const results = await env.DB.batch(statements)
  if (!results[0]?.meta?.changes) {
    // Race lost: EITHER the task is no longer 'review' OR (approved only) the
    // freeze extraGuard no longer holds. The verdict INSERT and the freeze
    // bind/void statement are both, by construction, no-ops in this same
    // transaction (their EXISTS guards cannot be satisfied) — nothing to roll back.
    throw new VerdictRaceError(task.id)
  }

  const updatedTask: Task = { ...task, status: newStatus, updated_at: now }
  await emitVerdictBusEvent(env, task, input, newStatus, now, actor)
  return { task: updatedTask, verdict: verdictRow }
}

// ── office.publish_post ──────────────────────────────────────────────────────────

// P0-1 (kasra-review + Athena, PR #1588 round 1): title/content are NO LONGER part
// of this input — office.publish_post's MCP schema (src/mcp/office.ts) no longer
// accepts them from the caller at all. The only content this tool will ever publish
// is whatever was frozen at review-entry (office_publish_freezes, keyed on
// task.id) — see src/addons/office/freeze.ts.
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

interface OfficeFreezeRoutingRow {
  frozen_at: string
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

  // P3 (mupot#1592): publish_post had no squad check at all — a caller holding
  // office department capability org-wide/department-wide but with no standing on
  // THIS task's squad could still trigger its WordPress write. Same predicate
  // office.review_approval's own P2-2 fix already applies to the decision; the
  // execution deserves no less.
  if (!(await canActOnSquad(env, auth, task.squad_id))) {
    return { ok: false, reason: 'not_authorized' }
  }

  if (!(await hasOfficeCapability(env, auth, resolveOfficePublishRequiredCapability()))) {
    return { ok: false, reason: 'not_authorized' }
  }

  // mupot#1602 r1 P2-3: only READ routing metadata here (installation/connector/
  // site + the row's OWN generation stamp, `frozen_at`) — never `payload_json`.
  // No row means this approval was never frozen (e.g. a gate:office task approved
  // directly through the generic task_verdict tool, bypassing office.
  // review_approval entirely, which is itself refused since NEW-2 — fail closed
  // regardless) — fail closed.
  const freezeRow = await env.DB.prepare(`
    SELECT frozen_at, installation_id, connector_id, site_origin
      FROM office_publish_freezes WHERE task_id = ?1
  `).bind(task.id).first<OfficeFreezeRoutingRow>()
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
  // never at approval (see officeConnectorSatisfiesRequirement's doc comment in
  // freeze.ts). Every binding the real schema can produce today is 'read', so this
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
  // NO fetch, and this row is NEVER un-claimed by this addon (migrations/0182's
  // trigger backstops that in the DB itself): a failed or timed-out publish needs
  // office.reconcile_stalled_publish (an operator manually confirms the real
  // WordPress outcome) before a fresh review-entry can mint a brand new, unclaimed
  // row — see freeze.ts's unreconciledPriorFreezeExists guard. The recovery path
  // for an ERRANT approval (never claimed, or the human approved the wrong thing)
  // is an org owner/admin verdict reversal (task_update/PATCH status:'review' with
  // a reversal_reason) — src/tasks/service.ts's reverseTaskVerdict voids this
  // freeze and the resulting review-entry mints a fresh one, exactly like any
  // other rework loop. (Reject does NOT work as a recovery path here: it requires
  // status='review', and a claimed freeze only exists once the task is already
  // 'approved'.)
  //
  // mupot#1592 NEW-2/NEW-3, hardened by mupot#1602 r1 P2-3: the claim's OWN WHERE
  // clause PINS the exact freeze generation this function just read
  // (`frozen_at = ?`, the routing-metadata SELECT above) and returns ITS
  // `payload_json` via RETURNING — never a payload read separately, which could
  // belong to a DIFFERENT generation minted in the window between that read and
  // this UPDATE landing (the adversarial repro: an admin reversal + a fresh human
  // approval inside that exact window bound a NEW freeze while this call still
  // held the OLD one's content). If the row's generation changed AT ALL since the
  // read above — re-approved, voided, reversed, already claimed — this matches 0
  // rows and RETURNING yields nothing; there is no statement shape left that can
  // read stale content out of this call. The subquery guards (verdict_id bound to
  // the CURRENT unreversed approved verdict, task.status still 'approved') are
  // additional, independent defense-in-depth atop the generation pin, not a
  // substitute for it.
  const claimant = auth.boundAgentId ?? auth.memberId ?? auth.userId
  const claimed = await env.DB.prepare(`
    UPDATE office_publish_freezes SET claimed_by = ?1, claimed_at = ?2
     WHERE task_id = ?3
       AND frozen_at = ?4
       AND claimed_at IS NULL
       AND voided_at IS NULL
       AND verdict_id IS NOT NULL
       AND verdict_id = (
         SELECT id FROM task_verdicts
          WHERE task_id = ?3 AND verdict = 'approved' AND reversed_at IS NULL
          ORDER BY decided_at DESC, id DESC LIMIT 1
       )
       AND EXISTS (SELECT 1 FROM tasks WHERE id = ?3 AND status = 'approved')
    RETURNING payload_json
  `).bind(claimant, claimTimestamp(), task.id, freezeRow.frozen_at).first<{ payload_json: string }>()
  if (!claimed) return { ok: false, reason: 'publish_claimed' }

  const frozenPayload = JSON.parse(claimed.payload_json) as { title: string; content: string }
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

// ── office.reconcile_stalled_publish ──────────────────────────────────────────────
//
// mupot#1592 P3 ("a documented recovery path that actually works... reconcile-
// before-reapprove against WordPress"): the ONE way out of the "claimed but
// outcome unknown" state freeze.ts's unreconciledPriorFreezeExists guard refuses to
// freeze over. Org owner/admin only, by design — this tool asks the operator to
// state what they found on the LIVE WordPress site by hand (there is no automated
// WordPress-side reconciliation call in this addon; see the file header's "known,
// reported gaps" — building one is future work, not fabricated here), and records
// exactly that, nothing inferred. Only after this lands can a fresh review-entry
// mint a new, unclaimed freeze for this task again.
export interface OfficeReconcileInput {
  readonly task: Task
  readonly outcome: 'done' | 'failed'
  readonly detail: string | null
  // Only meaningful (and required) when outcome === 'done' — what the operator
  // found actually live on WordPress after checking by hand.
  readonly postId: number | null
  readonly articleUrl: string | null
}

interface OfficeFreezeReconcileRow {
  claimed_at: string | null
  outcome: string | null
}

export async function reconcileStalledOfficePublish(
  env: Env,
  auth: AuthContext,
  input: OfficeReconcileInput,
): Promise<OfficeResult<{ task: Task }>> {
  const { task, outcome, detail, postId, articleUrl } = input

  if (task.gate_owner !== OFFICE_GATE_OWNER) return { ok: false, reason: 'wrong_gate' }
  // mupot#1602 r1 P2-4: `isOrgAdmin(auth)` alone is satisfiable by an agent-bound
  // bearer carrying its owner member's org-admin capabilities — the SAME class r1's
  // own P1-3 finding on PR #1588 closed for the archive door
  // (operator_principal_required, src/addons/archive.ts). This tool OVERRIDES an
  // automated double-post guard on an operator's manual say-so; the say-so must
  // come from a human, never an agent forging one with its owner's caps.
  if (auth.boundAgentId) return { ok: false, reason: 'not_authorized' }
  if (!isOrgAdmin(auth)) return { ok: false, reason: 'not_authorized' }
  if (outcome === 'done' && (postId === null || articleUrl === null)) {
    return { ok: false, reason: 'invalid_site_config' }
  }

  const row = await env.DB.prepare(
    `SELECT claimed_at, outcome FROM office_publish_freezes WHERE task_id = ?1`,
  ).bind(task.id).first<OfficeFreezeReconcileRow>()
  if (!row) return { ok: false, reason: 'freeze_not_found' }
  if (row.claimed_at === null || row.outcome !== null) return { ok: false, reason: 'already_reconciled' }

  // mupot#1602 r1 P3-3: a publish can legitimately still be in flight for up to
  // WP_PUBLISH_TIMEOUT_MS — reconciling it (either outcome) while the fetch could
  // still land would clear the double-post guard early, letting a fresh freeze
  // authorize a second POST against content that may still go live moments later.
  const claimedAtMs = Date.parse(row.claimed_at)
  if (!Number.isNaN(claimedAtMs) && Date.now() - claimedAtMs < RECONCILE_MIN_STALENESS_MS) {
    return { ok: false, reason: 'publish_claimed' }
  }

  const now = new Date().toISOString()
  const outcomeDetail = outcome === 'done'
    ? JSON.stringify({ postId, articleUrl, reconciledBy: auth.memberId ?? auth.userId, note: detail })
    : (detail?.trim() ? detail.trim() : 'reconciled_failed')

  // mupot#1602 r1 P3-3: guard the WRITE itself on `outcome IS NULL` (not only the
  // SELECT above) — closes the TOCTOU between that read and this UPDATE (two
  // concurrent reconcile calls, or this exact publish's own outcome write landing
  // in between).
  const reconciled = await env.DB.prepare(
    `UPDATE office_publish_freezes SET outcome = ?1, outcome_detail = ?2, completed_at = ?3
      WHERE task_id = ?4 AND outcome IS NULL AND claimed_at IS NOT NULL`,
  ).bind(outcome, outcomeDetail, now, task.id).run()
  if ((reconciled.meta?.changes ?? 0) === 0) return { ok: false, reason: 'already_reconciled' }

  if (outcome === 'done' && postId !== null && articleUrl !== null) {
    const marked = await markOfficeTaskPublished(env, task.id, { postId, articleUrl })
    if (!marked) return { ok: false, reason: 'verdict_race' }
  }

  return { ok: true, value: { task } }
}
