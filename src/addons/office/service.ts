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
import { parseSiteConnectorConfig, isRootSiteUrl, MCPWP_API_KEY_AUTH } from './health'
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
  resolveEligibleActiveOfficeInstallationId,
  resolveOfficeConnectorBinding,
  resolveOfficeSiteOrigin,
  officeSiteUrlIsSubdirectory,
  officeConnectorSatisfiesRequirement,
  resolveOfficePublishRequiredCapability,
  type OfficeResult,
  type OfficeRefusalReason,
} from './freeze'

export type { OfficeResult, OfficeRefusalReason } from './freeze'
export { OFFICE_ADDON_KEY, OFFICE_GATE_OWNER, OFFICE_WORDPRESS_SLOT } from './freeze'

const OFFICE_DEPARTMENT_SLUG = 'office'
// mupot#1616: the office talks ONLY to MCPWP's own REST layer, authenticated
// with the MCPWP API key (X-API-Key). Contract source (read-only, plugin 3.11.1
// in /home/mumega/mcpwp; the live site ran 3.13.0 per the issue):
//   POST /wp-json/mcpwp/v1/posts            create — body {title, content, status,
//                                           slug, meta:{...}}; 201 + {id, url, status, ...}
//   GET  /wp-json/mcpwp/v1/posts            list — query search|status(any)|per_page;
//                                           200 + {posts:[{id,slug,status,url}], total}
//   GET  /wp-json/mcpwp/v1/post-meta/{id}   200 + {id, meta:{<key>: <value>}}
// There is NO query-by-meta route anywhere in the plugin, so "look the post up by
// meta" is: collect candidates by slug/title search, then read each candidate's
// post meta and compare. See lookupWordpressPostByMeta.
const MCPWP_POSTS_PATH = '/wp-json/mcpwp/v1/posts'
const MCPWP_POST_META_PATH = '/wp-json/mcpwp/v1/post-meta/'
// mupot-owned post meta. Lowercase on purpose (the plugin's single-key read path
// runs sanitize_key, which lowercases), no leading underscore (a post write's
// `meta` field refuses protected keys) and no credential-shaped stem (the plugin
// refuses those too).
export const OFFICE_IDEMPOTENCY_META_KEY = 'mupot_office_idem'
export const OFFICE_PAYLOAD_HASH_META_KEY = 'mupot_office_payload'
// The plugin masks any read-back value that "looks like a credential" to `***`,
// and a bare 64-char hex digest does (Mcpwp_Option_Access::looks_like_credential:
// >=32 chars, [A-Za-z0-9+/=_-], has a digit and a letter). A dash-structured value
// is explicitly exempted, so the digest is stored behind this prefix.
const OFFICE_PAYLOAD_HASH_META_PREFIX = 'sha256-'
// Reconcile never reads more than this many candidate posts' meta; a site with
// more matching posts than this is "can't verify all" = a candidate, never absence.
const WP_LOOKUP_MAX_CANDIDATES = 20
const WP_LOOKUP_PER_PAGE = 100
const WP_PUBLISH_TIMEOUT_MS = 8_000
const OFFICE_SLUG_PREFIX = 'mupot-office-'
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
//
// r3 P1-2 (kasra-review adversarial gate ROUND 2 on #1614 — the SECOND BLOCK on
// this class): `reason` here is an INTERNAL classification, never surfaced
// directly. It must never be confused with OfficeRefusalReason (the PUBLIC
// reason a definite failure returns) — the two used to be the same type, which
// is exactly how an ambiguous outcome was able to masquerade as a definite
// 'failed' before the r2 fix, and the r2 fix ITSELF still over-claimed
// "definite" for 401/403/3xx/4xx (this round's actual finding — see below).
interface WpPublishObservation extends OfficePublishPostOutcome {
  /** The status the SITE reports the post was created with (its own word, not
   *  what we asked for). */
  readonly createdStatus: string
}

interface WpPublishConnectorResult {
  readonly status: 'available' | 'unavailable' | 'failed'
  readonly observations: readonly [WpPublishObservation] | readonly []
  readonly reason?: string
}

// r3 P1-2 (kasra-review r2 adversarial gate, the finding that produced the
// scope cut): the r2 fix classified 401/403/3xx/every-other-4xx as DEFINITE
// non-delivery on the theory that WordPress "never reached post-creation
// logic" for those statuses. That is true of stock WordPress core. It is NOT
// true of the rest of the stack a real deploy sits behind or runs alongside:
//   - a RESPONSE-PHASE WAF (ModSecurity + OWASP CRS with
//     SecResponseBodyAccess On, common on cPanel WordPress hosts) can return
//     403 AFTER the origin has already committed the INSERT, specifically
//     when the response body itself trips a leakage rule (rule 953100 fires
//     on a PHP notice in the body — literally the r2 "unparseable 2xx" case,
//     now returned as a 403 instead of a 200).
//   - a plugin hooked on `save_post` can call `wp_redirect()` + `exit` AFTER
//     the post row exists, producing a 3xx.
//   - a plugin hooked on `rest_after_insert_post` can error AFTER the insert,
//     producing a 4xx (including one that isn't 401/403).
// This is GAMEABLE and REPEATABLE: the REST response echoes the post's own
// content under `context=edit`, so any post whose body happens to contain
// `<?php` or a SQL-error-shaped string (any PHP tutorial, any incident
// post-mortem) trips a WAF leakage rule on EVERY attempt — every human
// "retry" (reverse + re-approve) would then create ANOTHER live post if this
// were still classified as a definite, guard-clearing failure.
//
// FIX (the scope-cut this round required): only a PRE-SEND failure — the
// request was constructed and refused before ever reaching the network — is
// definite. The moment `authenticatedFetch` is actually called, EVERY
// possible outcome other than a cleanly parsed 2xx with a real post id/link
// is ambiguous: the thrown-before-response case (network/abort/timeout), and
// every response status (1xx/3xx/4xx including 401/403/5xx) and body shape
// that isn't that one success shape. There is no longer a numbered exception
// list to maintain or re-litigate — "not a parsed delivered 2xx" IS the
// definition of ambiguous.
export type WordpressPublishResult =
  | { readonly kind: 'delivered'; readonly value: OfficePublishPostOutcome; readonly createdStatus: string }
  | { readonly kind: 'definite_failure'; readonly reason: OfficeRefusalReason }
  | { readonly kind: 'ambiguous'; readonly hint?: string }

function officePayloadHashMetaValue(payloadSha256: string): string {
  return `${OFFICE_PAYLOAD_HASH_META_PREFIX}${payloadSha256}`
}

async function wordpressPublish(
  env: Env,
  connectorId: string,
  title: string,
  content: string,
  slug: string,
  idempotencyKey: string,
  payloadSha256: string,
): Promise<WordpressPublishResult> {
  const result = await useConnectorById<WpPublishConnectorResult>(env, connectorId, 'mcpwp', async (connector: ImmediateConnectorUse) => {
    const config = parseSiteConnectorConfig(connector.meta)
    // Pre-send failure: WordPress never saw this request at all — definite.
    if (!config) return { status: 'unavailable', reason: 'invalid_site_config', observations: [] }

    let base: URL
    try {
      base = assertPublicHttpsUrl(config.siteUrl)
    } catch {
      // Pre-send failure: the SSRF guard refused before any fetch — definite.
      return { status: 'unavailable', reason: 'invalid_site_url', observations: [] }
    }
    // Subdirectory installs are refused (see isRootSiteUrl): pre-send, definite.
    if (!isRootSiteUrl(base)) return { status: 'unavailable', reason: 'invalid_site_url', observations: [] }

    const endpoint = new URL(MCPWP_POSTS_PATH, base.origin)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), WP_PUBLISH_TIMEOUT_MS)
    try {
      let response: Response
      try {
        response = await connector.authenticatedFetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': 'mupot-office-addon-publish/1.0' },
          redirect: 'manual',
          signal: controller.signal,
          // mupot#1610: `slug` is this claim's idempotency key (OFFICE_SLUG_PREFIX +
          // the value stamped onto office_publish_freezes.idempotency_key at claim
          // time) — WordPress assigns it as the post's own slug, which is what lets
          // reconcileStalledOfficePublish find this exact post later by a stable,
          // pre-agreed identifier rather than trusting a human's unverified say-so.
          // `meta` is applied by the plugin in the SAME create call (no second
          // request that could fail between "post exists" and "post is findable").
          // The mupot-owned meta, not the slug, is the identity: WordPress does not
          // make draft slugs unique (mupot#1616, observed live).
          body: JSON.stringify({
            title,
            content,
            status: config.publishStatus,
            slug,
            meta: {
              [OFFICE_IDEMPOTENCY_META_KEY]: idempotencyKey,
              [OFFICE_PAYLOAD_HASH_META_KEY]: officePayloadHashMetaValue(payloadSha256),
            },
          }),
        })
      } catch {
        // The request was SENT (dispatched over the network) and something broke
        // after that — abort, timeout, connection reset. WordPress may have
        // received and fully processed it before the connection broke. AMBIGUOUS.
        return { status: 'failed', reason: 'network_error', observations: [] }
      }
      // r3: EVERY response status other than a parsed 2xx success below is now
      // ambiguous — no more 401/403/3xx/4xx/5xx-specific "definite" branches.
      // The request reached the network (and very possibly WordPress's own
      // insert logic); the status code alone cannot prove it did not.
      if (!response.ok) {
        // The status code only picks the HINT; it never makes the outcome definite.
        return { status: 'failed', reason: `ambiguous_response_${response.status}`, observations: [] }
      }
      const body = (await response.json().catch(() => null)) as { id?: unknown; url?: unknown; status?: unknown } | null
      if (!body || typeof body.id !== 'number' || typeof body.url !== 'string' || !body.url) {
        // A 2xx with a body we cannot parse as a real post (a PHP
        // notice/warning prepended ahead of the JSON is the textbook case) means
        // the HTTP layer says success but we cannot read back what was created —
        // we cannot rule out that WordPress actually created the post. AMBIGUOUS.
        return { status: 'failed', reason: 'unparseable_response', observations: [] }
      }
      return {
        status: 'available',
        observations: [{
          postId: body.id,
          articleUrl: body.url,
          createdStatus: typeof body.status === 'string' ? body.status : config.publishStatus,
        }],
      }
    } finally {
      clearTimeout(timer)
    }
  }, MCPWP_API_KEY_AUTH)
  // Connector resolution itself failed (row missing/revoked, master key
  // absent, decrypt failed) — this happens entirely INSIDE useConnectorById,
  // BEFORE the callback (and so before any fetch) ever runs. Pre-send, definite.
  if (!result) return { kind: 'definite_failure', reason: 'connector_not_bound' }
  const delivered = result.status === 'available' ? result.observations[0] : undefined
  if (delivered) {
    return { kind: 'delivered', value: { postId: delivered.postId, articleUrl: delivered.articleUrl }, createdStatus: delivered.createdStatus }
  }
  // r3: an ALLOWLIST of definite (pre-send) reasons, not a denylist of
  // ambiguous ones — the safe default for any reason this function does not
  // explicitly recognize is AMBIGUOUS, never definite. Only the two pre-send
  // config/SSRF refusals above ever populate `reason` with anything else.
  const reason = result.reason ?? 'network_error'
  if (reason === 'invalid_site_config' || reason === 'invalid_site_url') {
    return { kind: 'definite_failure', reason }
  }
  return { kind: 'ambiguous', ...(publishRefusalHint(reason) ? { hint: publishRefusalHint(reason) } : {}) }
}

/** A plain-language reason for the two statuses an operator can actually act on.
 *  Fixed strings only: nothing from the response body or the credential is echoed. */
function publishRefusalHint(reason: string): string | undefined {
  if (reason === 'ambiguous_response_403') {
    return 'WordPress/MCPWP answered 403 to the create. The outcome is treated as unknown, so the claim stays locked and a retry cannot double-post. '
      + 'MCPWP 3.13.0+ requires an ADMIN-scope key to create a post with status publish, private or future: '
      + 'use connector meta publish_status:"draft" with a write-scope key, or use an admin-scope key. Check WordPress for a post before reconciling.'
  }
  if (reason === 'ambiguous_response_401') {
    return 'WordPress/MCPWP did not accept the connector key (401). The outcome is treated as unknown and the claim stays locked. Check the MCPWP API key in the connector, then check WordPress for a post before reconciling.'
  }
  return undefined
}

// mupot#1610, r3 (kasra-review adversarial gate ROUND 2 on #1614 — the SECOND
// BLOCK on this class, forcing this scope cut): office.reconcile_stalled_
// publish's own live WordPress check, called BEFORE the double-post guard is
// ever cleared. THE CLASS: "failing to find something is not evidence it's
// absent." r2's own fallback (title/time-window search, "absent" when
// genuinely empty everywhere) was proven NOT authoritative — WordPress has no
// query that can prove a negative across custom editorial statuses (workflow
// plugins), simultaneous slug+title edits, a `-term` in the title (WordPress's
// own search treats a leading `-` as an EXCLUSION), a switched post type, or
// ordinary clock skew on the `after=` window. Every one of those let a
// genuinely-live post read as "absent," the operator's plain `outcome:'failed'`
// got accepted, and reverse+reapprove produced a SECOND live post.
//
// FIX (this round's mandated scope cut — no more "prove absence" attempts):
// reconcile now has exactly TWO possible outcomes for a claim it cannot
// instantly finish as 'found':
//   - `reconcile_candidate_found` — SOME evidence exists (the exact idempotency
//     slug matched an element that's malformed, OR the title/time search
//     turned up ANY result at all, matched or not). NEVER overridable — a
//     human must look at the actual post (accept it as 'done', or delete it),
//     never attest "failed" over evidence that might be this exact post.
//   - `reconcile_check_unavailable` — every other case: a network/DNS/TLS
//     failure, OR the exact-slug queries AND the title/time search all came
//     back genuinely, cleanly empty. Both are the SAME epistemic state under
//     THE CLASS: "we could not obtain a positive answer," never "we proved a
//     negative." This is the ONLY reason the human override
//     (reconcileStalledOfficePublish's `overrideReason`) may ever accept, and
//     only once recorded attempts prove the check was retried, not just asked
//     once (see RECONCILE_RETRY_MIN_INTERVAL_MS below).
// The title/time fallback search still runs — but ONLY to detect a candidate
// worth refusing over, NEVER as a basis for declaring absence.
// mupot#1616: the lookup is by the mupot-owned POST META, not the slug. Outcomes:
//   - `found`     — a candidate's meta carries THIS claim's idempotency key AND the
//                   frozen payload's hash: this exact post exists (adopt it).
//   - `conflict`  — a post carries this claim's idempotency key but a DIFFERENT
//                   (or unreadable) payload hash: never adopted, never overwritten.
//   - `candidate` — some post matched the slug/title search but none could be
//                   proven to be ours (no meta, meta unreadable, or more matches
//                   than could be verified). Never overridable.
//   - `unavailable` — nothing found or the check itself failed. "Nothing found"
//                   is NOT proof of absence: the plugin has no query-by-meta, the
//                   search can't see trashed or custom-status posts, and the
//                   claim's own slug can be rewritten. Same epistemic state as a
//                   network failure; only the audited, retried human override
//                   may proceed from here.
type WordpressPostLookupResult =
  | { status: 'found'; postId: number; articleUrl: string; wpStatus: string }
  | { status: 'conflict' }
  | { status: 'candidate' }
  | { status: 'unavailable' }

interface WpLookupConnectorResult {
  readonly status: 'available' | 'unavailable' | 'failed'
  readonly observations: readonly [unknown] | readonly []
}

/** One GET request through the vaulted connector, returning the raw parsed JSON
 *  body. Exactly one `authenticatedFetch` call per `useConnectorById` use (the
 *  vault's own one-shot-per-access contract) — the lookup below calls this
 *  repeatedly, each a fresh, independent vault access. */
async function wpReconcileGet(
  env: Env,
  connectorId: string,
  buildEndpoint: (base: URL) => URL,
): Promise<{ ok: true; body: unknown } | { ok: false }> {
  const result = await useConnectorById<WpLookupConnectorResult>(env, connectorId, 'mcpwp', async (connector: ImmediateConnectorUse) => {
    const config = parseSiteConnectorConfig(connector.meta)
    if (!config) return { status: 'unavailable', observations: [] }
    let base: URL
    try {
      base = assertPublicHttpsUrl(config.siteUrl)
    } catch {
      return { status: 'unavailable', observations: [] }
    }
    if (!isRootSiteUrl(base)) return { status: 'unavailable', observations: [] }
    const endpoint = buildEndpoint(base)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), WP_PUBLISH_TIMEOUT_MS)
    try {
      const response = await connector.authenticatedFetch(endpoint, {
        method: 'GET',
        headers: { 'user-agent': 'mupot-office-addon-reconcile/1.0' },
        redirect: 'manual',
        signal: controller.signal,
      })
      if (isRedirect(response) || !response.ok) return { status: 'failed', observations: [] }
      const body = await response.json().catch(() => null)
      if (body === null) return { status: 'failed', observations: [] }
      return { status: 'available', observations: [body] }
    } catch {
      return { status: 'failed', observations: [] }
    } finally {
      clearTimeout(timer)
    }
  }, MCPWP_API_KEY_AUTH)
  if (!result || result.status !== 'available') return { ok: false }
  const body = result.observations[0]
  return body === undefined ? { ok: false } : { ok: true, body }
}

interface WpCandidate {
  readonly postId: number
  readonly articleUrl: string
  readonly wpStatus: string
}

/** Parses MCPWP's list envelope `{posts:[...], total}`. `null` = unreadable.
 *  `unreadable` counts elements that could not be read as a post (an element we
 *  cannot identify is a candidate we cannot verify, never "nothing"). */
function parseMcpwpPostList(body: unknown): { candidates: WpCandidate[]; unreadable: number; incomplete: boolean } | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const envelope = body as { posts?: unknown; total?: unknown }
  if (!Array.isArray(envelope.posts)) return null
  const candidates: WpCandidate[] = []
  let unreadable = 0
  for (const raw of envelope.posts) {
    const post = typeof raw === 'object' && raw !== null ? (raw as { id?: unknown; url?: unknown; status?: unknown }) : null
    if (!post || typeof post.id !== 'number' || typeof post.url !== 'string' || !post.url) {
      unreadable += 1
      continue
    }
    candidates.push({ postId: post.id, articleUrl: post.url, wpStatus: typeof post.status === 'string' ? post.status : 'unknown' })
  }
  const incomplete = typeof envelope.total === 'number' && envelope.total > envelope.posts.length
  return { candidates, unreadable, incomplete }
}

/** Reads one meta value out of MCPWP's `{id, meta:{key: value}}` envelope.
 *  `undefined` = key absent; `null` = envelope unreadable. A multi-valued key
 *  reads as an array, which is never equal to the expected string. */
function readMcpwpMetaValue(body: unknown, key: string): string | undefined | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const meta = (body as { meta?: unknown }).meta
  // PHP serialises an empty array as `[]` — a post with no meta at all.
  if (Array.isArray(meta) && meta.length === 0) return undefined
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return null
  if (!(key in meta)) return undefined
  const value = (meta as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : ''
}

async function lookupWordpressPostByMeta(
  env: Env,
  connectorId: string,
  idempotencyKey: string,
  payloadSha256: string,
  slug: string,
  title: string,
): Promise<WordpressPostLookupResult> {
  const byId = new Map<number, WpCandidate>()
  let unreadable = 0
  let incomplete = false
  for (const term of [slug, title]) {
    const listed = await wpReconcileGet(env, connectorId, (base) => {
      const endpoint = new URL(MCPWP_POSTS_PATH, base.origin)
      endpoint.searchParams.set('search', term)
      endpoint.searchParams.set('status', 'any')
      endpoint.searchParams.set('per_page', String(WP_LOOKUP_PER_PAGE))
      return endpoint
    })
    if (!listed.ok) return { status: 'unavailable' }
    const parsed = parseMcpwpPostList(listed.body)
    if (!parsed) return { status: 'unavailable' }
    unreadable += parsed.unreadable
    incomplete = incomplete || parsed.incomplete
    for (const candidate of parsed.candidates) byId.set(candidate.postId, candidate)
  }

  const expectedHash = officePayloadHashMetaValue(payloadSha256)
  let found: WpCandidate | null = null
  let matches = 0
  let conflict = false
  let unverified = unreadable > 0 || incomplete
  let checked = 0
  for (const candidate of byId.values()) {
    if (checked >= WP_LOOKUP_MAX_CANDIDATES) {
      unverified = true
      break
    }
    checked += 1
    const metaRead = await wpReconcileGet(env, connectorId, (base) => new URL(`${MCPWP_POST_META_PATH}${candidate.postId}`, base.origin))
    if (!metaRead.ok) {
      unverified = true
      continue
    }
    const idem = readMcpwpMetaValue(metaRead.body, OFFICE_IDEMPOTENCY_META_KEY)
    if (idem === null) {
      unverified = true
      continue
    }
    if (idem !== idempotencyKey) continue // not ours (absent, or another claim's key)
    const hash = readMcpwpMetaValue(metaRead.body, OFFICE_PAYLOAD_HASH_META_KEY)
    if (hash === expectedHash) {
      matches += 1
      found = found ?? candidate
    } else conflict = true
  }
  // A conflict outranks a find: a post under our key with different content means
  // the identity is ambiguous, and ambiguity must refuse, not adopt.
  // Two or more posts carrying the same key AND hash is also a conflict: a WordPress
  // author can copy custom fields onto their own post, so "first match wins" would
  // let a copy be adopted as ours.
  if (conflict || matches > 1) return { status: 'conflict' }
  if (found) return { status: 'found', ...found }
  if (byId.size > 0 || unverified) return { status: 'candidate' }
  return { status: 'unavailable' }
}

/**
 * The ONE place a 'done' outcome is committed: the freeze row's outcome and the
 * task's done receipt (Task.result/completed_at are the existing generic fields;
 * see the file header for why no receipts table was built) land in ONE D1 batch
 * (a transaction). If either statement throws, neither lands, `outcome` stays NULL
 * and the claim stays open, so office.reconcile_stalled_publish can still adopt
 * the post. Writing them as two statements left `outcome = 'done'` on a task still
 * 'approved' when the second failed, which reconcile refuses as already_reconciled:
 * a live post with no receipt and no way back (mupot#1616, publish AND reconcile).
 *
 * All-or-nothing in BOTH directions (a D1 batch does not roll back on a zero-row
 * UPDATE, so each half is conditional on the other's precondition): the freeze
 * UPDATE needs the task still 'approved', and the task UPDATE needs the freeze
 * UPDATE to have landed. A zero-row on either side leaves BOTH unchanged and the
 * claim open.
 *  - 'already_reconciled': the freeze row was not open (someone else resolved it).
 *  - 'task_not_approved': a post EXISTS on WordPress, the claim is still open, and
 *    the task is no longer 'approved'. Callers must say so plainly.
 * Throws if the batch itself fails; callers map that to a refusal that leaves the
 * claim open.
 */
/** What an operator must be told when 'task_not_approved' happens: a bare
 *  "verdict_race" reads as "nothing happened", but a post exists. */
function postExistsUnreconciledHint(post: { postId: number; articleUrl: string }): string {
  return `A post EXISTS on WordPress (id ${post.postId}, ${post.articleUrl}) but the task is no longer approved, so no receipt was written and the claim stays open. `
    + 'Do NOT re-approve or republish. Resolve it with office.reconcile_stalled_publish (it adopts the post by its stamp).'
}

async function commitOfficeDoneReceipt(
  env: Env,
  taskId: string,
  freezeOutcomeDetail: string,
  result: { postId: number; articleUrl: string; note?: string },
): Promise<'ok' | 'already_reconciled' | 'task_not_approved'> {
  const now = new Date().toISOString()
  const [freezeUpdate, taskUpdate] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE office_publish_freezes SET outcome = 'done', outcome_detail = ?1, completed_at = ?2
        WHERE task_id = ?3 AND outcome IS NULL AND claimed_at IS NOT NULL
          AND EXISTS (SELECT 1 FROM tasks WHERE id = ?3 AND status = 'approved')`,
    ).bind(freezeOutcomeDetail, now, taskId),
    env.DB.prepare(
      `UPDATE tasks SET status = 'done', result = ?1, completed_at = ?2, updated_at = ?2
        WHERE id = ?3 AND status = 'approved'
          AND EXISTS (SELECT 1 FROM office_publish_freezes WHERE task_id = ?3 AND outcome = 'done' AND completed_at = ?2)`,
    ).bind(JSON.stringify(result), now, taskId),
  ])
  if ((freezeUpdate?.meta?.changes ?? 0) === 0) {
    // Neither half landed (the task UPDATE is conditional on the freeze one). Tell
    // "someone already resolved this claim" from "the task left 'approved' while a
    // post exists": the latter leaves the claim OPEN, never a half commit.
    const open = await env.DB.prepare(
      `SELECT 1 AS open FROM office_publish_freezes WHERE task_id = ?1 AND outcome IS NULL AND claimed_at IS NOT NULL`,
    ).bind(taskId).first<{ open: number }>()
    return open ? 'task_not_approved' : 'already_reconciled'
  }
  // Both statements ran in one transaction and the task one is conditional on the
  // freeze one, so the freeze landing and the task not is not a reachable state.
  if ((taskUpdate?.meta?.changes ?? 0) === 0) throw new Error('office_receipt_half_commit')
  return 'ok'
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
  // r2 P3-2: the stricter resolver — re-proves the installation's manifest
  // digest still matches the registered manifest and that no external-isolation
  // invariant is violated, not merely state+trustClass (see its own doc comment).
  const eligibleInstallation = await resolveEligibleActiveOfficeInstallationId(env)
  if (!eligibleInstallation.ok) return eligibleInstallation
  const installationId = eligibleInstallation.value
  const bindingResult = await resolveOfficeConnectorBinding(env, installationId)
  if (!bindingResult.ok) return bindingResult
  const siteOrigin = await resolveOfficeSiteOrigin(env, bindingResult.value.connectorId)
  if (!siteOrigin) {
    return { ok: false, reason: (await officeSiteUrlIsSubdirectory(env, bindingResult.value.connectorId)) ? 'unsupported_site_path' : 'invalid_site_config' }
  }
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
  // mupot#1610: mints a fresh idempotency key candidate on every call, but
  // COALESCE means only the WINNING claimant's value is ever actually stored —
  // the same one-shot-claim discipline as claimed_by/claimed_at themselves.
  // Never overwritten once set: a row can only be claimed once per generation
  // (this same UPDATE's own WHERE), and a fresh generation (rework loop) always
  // INSERTs a brand-new row via persistOfficePublishFreeze's upsert, never
  // reuses an old idempotency_key.
  const idempotencyKeyCandidate = crypto.randomUUID()
  const claimed = await env.DB.prepare(`
    UPDATE office_publish_freezes SET claimed_by = ?1, claimed_at = ?2,
           idempotency_key = COALESCE(idempotency_key, ?5)
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
    RETURNING payload_json, payload_sha256, idempotency_key
  `).bind(claimant, claimTimestamp(), task.id, freezeRow.frozen_at, idempotencyKeyCandidate)
    .first<{ payload_json: string; payload_sha256: string; idempotency_key: string }>()
  if (!claimed) return { ok: false, reason: 'publish_claimed' }

  const frozenPayload = JSON.parse(claimed.payload_json) as { title: string; content: string }
  const slug = `${OFFICE_SLUG_PREFIX}${claimed.idempotency_key}`
  const published = await wordpressPublish(
    env, bindingResult.value.connectorId, frozenPayload.title, frozenPayload.content, slug, claimed.idempotency_key, claimed.payload_sha256,
  )
  const now = new Date().toISOString()

  // r2 P1-1: an AMBIGUOUS outcome writes NOTHING to office_publish_freezes —
  // `outcome` stays NULL, exactly as it was the instant this call claimed the
  // row. unreconciledPriorFreezeExists (freeze.ts) and office.
  // reconcile_stalled_publish's own guard (`outcome IS NULL`) both key on that
  // column being untouched, which is what forces reconcile's live WordPress
  // check to run before any rework loop can mint a fresh, unclaimed freeze —
  // see this function's own header and reconcileStalledOfficePublish's header
  // for the full reasoning. The row stays claimed forever until an operator
  // reconciles it; there is no automatic retry.
  if (published.kind === 'ambiguous') {
    return { ok: false, reason: 'publish_outcome_unknown', ...(published.hint ? { hint: published.hint } : {}) }
  }

  if (published.kind === 'definite_failure') {
    await env.DB.prepare(
      `UPDATE office_publish_freezes SET outcome = 'failed', outcome_detail = ?1, completed_at = ?2 WHERE task_id = ?3`,
    ).bind(published.reason, now, task.id).run()
    return { ok: false, reason: published.reason }
  }

  // The post EXISTS on WordPress from here on: both receipt writes in one batch
  // (see commitOfficeDoneReceipt). A failure leaves the claim open for reconcile.
  // A draft (or any non-public status the SITE reports) is recorded as such so a
  // reader never assumes "live" by omission.
  const note = published.createdStatus === 'publish' ? undefined : `created on WordPress with status "${published.createdStatus}" — not public`
  let committed: Awaited<ReturnType<typeof commitOfficeDoneReceipt>>
  try {
    committed = await commitOfficeDoneReceipt(env, task.id, JSON.stringify(published.value), { ...published.value, ...(note ? { note } : {}) })
  } catch {
    return { ok: false, reason: 'publish_outcome_unknown' }
  }
  if (committed === 'task_not_approved') return { ok: false, reason: 'publish_unreconciled', hint: postExistsUnreconciledHint(published.value) }
  if (committed === 'already_reconciled') return { ok: false, reason: 'already_reconciled' }

  return { ok: true, value: published.value }
}

// ── office.reconcile_stalled_publish ──────────────────────────────────────────────
//
// mupot#1592 P3 ("a documented recovery path that actually works... reconcile-
// before-reapprove against WordPress"): the ONE way out of the "claimed but
// outcome unknown" state freeze.ts's unreconciledPriorFreezeExists guard refuses to
// freeze over. Org owner/admin only, by design.
//
// r3 (kasra-review adversarial gate ROUND 2 on #1614 — the SECOND BLOCK on this
// class; this shape is the mandated scope cut, not a third attempt at "prove
// absence"). THE CLASS: "when the outcome is unknown it must never be recorded
// as a failure, and failing to find something is not evidence it's absent."
// r1 wrote an ambiguous publish outcome as a definite 'failed'; r2 fixed that
// but then let reconcile's own "absent" inference (a title/time fallback
// search finding nothing) auto-clear the guard on the operator's plain
// `outcome:'failed'` — proven NOT authoritative (custom editorial statuses,
// simultaneous slug+title edits, a `-term` title WordPress's own search
// treats as an exclusion, a switched post type, ordinary clock skew). There is
// now NO inferred-absence path left at all:
//   - `found` (an EXACT idempotency-slug match — `<slug>` or `<slug>__trashed`
//     — parsed, with a real id and link): the ONLY way reconcile ever marks
//     the task 'done' on its own authority. A `trash` status is recorded
//     honestly (never `verifiedLiveOnWordpress`) — the post EXISTS (this
//     addon's own exact slug proves WordPress received this exact claim's
//     POST), it just is not currently public; the receipt says so.
//   - `reconcile_candidate_found`: SOME evidence exists that isn't a clean
//     `found` — the exact-slug match was malformed (an id with no link — this
//     IS our post), or the title/time fallback search turned up ANY result at
//     all. NEVER overridable: a human must look at the actual post (accept it
//     as done, or delete it) — attesting "failed" over evidence that might be
//     this exact post is exactly the gap r2 exploited.
//   - `reconcile_check_unavailable`: everything else — a network/DNS/TLS
//     failure, the connector revoked, the connector's origin has drifted from
//     the frozen one, OR the exact-slug queries AND the fallback search all
//     came back genuinely, cleanly empty. THE CLASS treats "checked
//     everywhere, found nothing" and "could not check at all" as the SAME
//     epistemic state — neither is a negative proof. This is the ONLY reason
//     the human override may ever accept, and only once the SAME task has
//     recorded at least 2 unavailable attempts spaced >=
//     RECONCILE_RETRY_MIN_INTERVAL_MS apart (r2 P2-1: a single transient blip
//     must never be override-eligible) — otherwise the refusal is
//     `reconcile_retry_required`, telling the caller to try again rather than
//     reach for the override on the first ask. Attempt timestamps are tracked
//     in `outcome_detail` while `outcome` stays NULL (no schema change needed
//     — that column is nullable and untouched by anything else while the
//     claim is still open).
// A row with no idempotency_key (only possible for a claim made before
// migrations/0185 — see that file's header) has nothing to look up at all;
// falls back to the pre-existing, purely-manual-attestation behavior for that
// one row only (unchanged from r2).
//
// The override (`overrideReason`, a non-empty audited string) is human-only
// (never an agent-bound bearer, checked below), and is recorded in
// `outcome_detail` — this addon's own established receipt mechanism (see this
// file's header) — with the reason, who invoked it, and the full attempt
// history. It can NEVER accept a `found` or `reconcile_candidate_found` result.
export interface OfficeReconcileInput {
  readonly task: Task
  readonly outcome: 'done' | 'failed'
  readonly detail: string | null
  // Only meaningful (and required) when outcome === 'done' — what the operator
  // found actually live on WordPress after checking by hand. Ignored (and may be
  // omitted) whenever the live WordPress check below finds the post itself —
  // the discovered postId/articleUrl are used instead.
  readonly postId: number | null
  readonly articleUrl: string | null
  // r3: a non-empty, explicit, audited reason to accept the operator's own
  // outcome — accepted ONLY when the automated check is `reconcile_check_
  // unavailable` AND has been retried at least once with sufficient spacing
  // (see the file header). Never bypasses `found` or `reconcile_candidate_found`.
  readonly overrideReason: string | null
}

interface OfficeFreezeReconcileRow {
  claimed_at: string | null
  outcome: string | null
  outcome_detail: string | null
  connector_id: string
  idempotency_key: string | null
  site_origin: string
  payload_json: string
  payload_sha256: string
}

// r3 P2-1 (kasra-review r2 adversarial gate): a SINGLE transient lookup blip
// (one thrown fetch) must never make the override eligible — the check could
// simply be retried. Require at least 2 recorded `reconcile_check_unavailable`
// attempts on THIS claim, with the span between the first and the latest at
// least this long, before `overrideReason` is honoured.
const RECONCILE_RETRY_MIN_INTERVAL_MS = 30_000

interface ReconcileAttemptLog {
  readonly reconcileAttempts: readonly string[]
}

function parseReconcileAttemptLog(outcomeDetail: string | null): readonly string[] {
  if (!outcomeDetail) return []
  try {
    const parsed = JSON.parse(outcomeDetail) as Partial<ReconcileAttemptLog>
    return Array.isArray(parsed.reconcileAttempts) ? parsed.reconcileAttempts.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

export async function reconcileStalledOfficePublish(
  env: Env,
  auth: AuthContext,
  input: OfficeReconcileInput,
): Promise<OfficeResult<{ task: Task }>> {
  const { task, outcome: requestedOutcome, detail, postId: requestedPostId, articleUrl: requestedArticleUrl } = input
  const overrideReason = input.overrideReason?.trim() ? input.overrideReason.trim() : null

  if (task.gate_owner !== OFFICE_GATE_OWNER) return { ok: false, reason: 'wrong_gate' }
  // mupot#1602 r1 P2-4: `isOrgAdmin(auth)` alone is satisfiable by an agent-bound
  // bearer carrying its owner member's org-admin capabilities — the SAME class r1's
  // own P1-3 finding on PR #1588 closed for the archive door
  // (operator_principal_required, src/addons/archive.ts). This tool OVERRIDES an
  // automated double-post guard on an operator's manual say-so; the say-so must
  // come from a human, never an agent forging one with its owner's caps.
  if (auth.boundAgentId) return { ok: false, reason: 'not_authorized' }
  if (!isOrgAdmin(auth)) return { ok: false, reason: 'not_authorized' }
  if (requestedOutcome === 'done' && (requestedPostId === null || requestedArticleUrl === null)) {
    return { ok: false, reason: 'invalid_site_config' }
  }

  const row = await env.DB.prepare(
    `SELECT claimed_at, outcome, outcome_detail, connector_id, idempotency_key, site_origin, payload_json, payload_sha256 FROM office_publish_freezes WHERE task_id = ?1`,
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

  // No idempotency key: a claim made before migrations/0185 — nothing to look
  // up. Falls back to pre-existing pure manual attestation, unchanged.
  if (!row.idempotency_key) {
    return applyReconcileOutcome(env, task, auth, requestedOutcome, requestedPostId, requestedArticleUrl, detail, {})
  }

  // r3 P2-2 (kept from r2): the connector's CURRENT origin must still equal
  // the FROZEN site_origin this exact claim targeted — never trust whatever
  // the connector happens to point at NOW. Origin drift is folded into the
  // SAME `reconcile_check_unavailable` / retry-throttled-override bucket as
  // every other "could not obtain a positive answer" case.
  const currentOrigin = await resolveOfficeSiteOrigin(env, row.connector_id)
  const originDrifted = currentOrigin !== row.site_origin

  const frozen = JSON.parse(row.payload_json) as { title: string }
  const slug = `${OFFICE_SLUG_PREFIX}${row.idempotency_key}`
  const lookup = originDrifted
    ? ({ status: 'unavailable' } as const)
    : await lookupWordpressPostByMeta(env, row.connector_id, row.idempotency_key, row.payload_sha256, slug, frozen.title)

  if (lookup.status === 'found') {
    // NEVER overridable — live evidence wins outright regardless of what the
    // operator asked for or attested. A trashed find is recorded honestly.
    const isLive = lookup.wpStatus === 'publish'
    // What adoption proves: the post carries THIS claim's idempotency key and the
    // approved payload hash, stamped at create. It does NOT prove the post's
    // CURRENT content still matches (it could have been edited since), so the
    // receipt says "stamp verified", never "content verified".
    return applyReconcileOutcome(env, task, auth, 'done', lookup.postId, lookup.articleUrl, detail, {
      adoptedByPostMeta: true,
      postMetaStampVerified: true,
      contentReverified: false,
      wordpressStatus: lookup.wpStatus,
    }, `adopted: the post carries this claim's idempotency stamp and approved-payload hash (stamp verified; its current content was NOT re-verified)${isLive ? '' : `; found with status "${lookup.wpStatus}" — not currently live`}`)
  }

  if (lookup.status === 'conflict') {
    // NEVER overridable, never adopted, never overwritten: a post carries this
    // claim's idempotency key with different content than the human approved.
    return { ok: false, reason: 'reconcile_conflict' }
  }

  if (lookup.status === 'candidate') {
    // NEVER overridable — some evidence exists; a human must resolve it
    // directly (accept it as done, or delete the post first).
    return { ok: false, reason: 'reconcile_candidate_found' }
  }

  // `unavailable` (network/DNS/TLS failure, revoked connector, origin drift,
  // or a clean-empty result from every avenue this addon knows how to query)
  // — THE CLASS: none of these is proof of absence. Track the attempt; the
  // override is eligible only once retried with sufficient spacing.
  const attempts = [...parseReconcileAttemptLog(row.outcome_detail), new Date().toISOString()]
  const retryEligible = attempts.length >= 2
    && (Date.parse(attempts[attempts.length - 1]) - Date.parse(attempts[0])) >= RECONCILE_RETRY_MIN_INTERVAL_MS

  if (!overrideReason) {
    await env.DB.prepare(
      `UPDATE office_publish_freezes SET outcome_detail = ?1 WHERE task_id = ?2 AND outcome IS NULL`,
    ).bind(JSON.stringify({ reconcileAttempts: attempts }), task.id).run()
    return { ok: false, reason: 'reconcile_check_unavailable' }
  }
  if (!retryEligible) {
    await env.DB.prepare(
      `UPDATE office_publish_freezes SET outcome_detail = ?1 WHERE task_id = ?2 AND outcome IS NULL`,
    ).bind(JSON.stringify({ reconcileAttempts: attempts }), task.id).run()
    return { ok: false, reason: 'reconcile_retry_required' }
  }

  return applyReconcileOutcome(env, task, auth, requestedOutcome, requestedPostId, requestedArticleUrl, detail, {
    overridden: true,
    overrideReason,
    reconcileAttempts: attempts,
  })
}

/** The single write path for a terminal reconcile outcome ('done' or
 *  'failed') — shared by the no-idempotency-key fallback, the `found` branch,
 *  and the retry-eligible override branch, so the TOCTOU-safe UPDATE and the
 *  commitOfficeDoneReceipt call are never duplicated. */
async function applyReconcileOutcome(
  env: Env,
  task: Task,
  auth: AuthContext,
  outcome: 'done' | 'failed',
  postId: number | null,
  articleUrl: string | null,
  detail: string | null,
  extra: Record<string, unknown>,
  doneNote?: string,
): Promise<OfficeResult<{ task: Task }>> {
  const now = new Date().toISOString()
  // Non-overridden, non-extra 'failed' stays a PLAIN STRING, exactly as
  // before r2 (existing callers/tests read outcome_detail as free text in
  // that case) — extra fields only change the shape of the rarer paths.
  const outcomeDetail = outcome === 'done'
    ? JSON.stringify({ postId, articleUrl, reconciledBy: auth.memberId ?? auth.userId, note: detail, ...extra })
    : Object.keys(extra).length === 0
      ? (detail?.trim() ? detail.trim() : 'reconciled_failed')
      : JSON.stringify({ note: detail?.trim() ? detail.trim() : 'reconciled_failed', reconciledBy: auth.memberId ?? auth.userId, ...extra })

  // mupot#1602 r1 P3-3: guard the WRITE itself on `outcome IS NULL` (not only
  // the earlier SELECT) — closes the TOCTOU between that read and this UPDATE
  // (two concurrent reconcile calls, or this exact publish's own outcome
  // write landing in between).
  if (outcome === 'done' && postId !== null && articleUrl !== null) {
    // Adoption is the main recovery path, so it gets the same all-or-nothing
    // receipt as the publish itself: a throw leaves the claim open to retry.
    let committed: Awaited<ReturnType<typeof commitOfficeDoneReceipt>>
    try {
      committed = await commitOfficeDoneReceipt(env, task.id, outcomeDetail, { postId, articleUrl, ...(doneNote ? { note: doneNote } : {}) })
    } catch {
      return { ok: false, reason: 'write_failed' }
    }
    if (committed === 'already_reconciled') return { ok: false, reason: 'already_reconciled' }
    if (committed === 'task_not_approved') return { ok: false, reason: 'publish_unreconciled', hint: postExistsUnreconciledHint({ postId, articleUrl }) }
    return { ok: true, value: { task } }
  }

  const reconciled = await env.DB.prepare(
    `UPDATE office_publish_freezes SET outcome = ?1, outcome_detail = ?2, completed_at = ?3
      WHERE task_id = ?4 AND outcome IS NULL AND claimed_at IS NOT NULL`,
  ).bind(outcome, outcomeDetail, now, task.id).run()
  if ((reconciled.meta?.changes ?? 0) === 0) return { ok: false, reason: 'already_reconciled' }

  return { ok: true, value: { task } }
}
