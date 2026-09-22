// mupot — team_bootstrap (mupot#1498): "one call creates project-prj +
// squad-sqd + project bot + token claim + Hermes profile scaffold — new
// teams in one step."
//
// WHAT THIS REPLACES (Hadi, 2026-09-22, done by hand for Psychonom): six
// separate calls, three tools' individual quirks, one human who happened to
// know all of them — project_update refused with `no_writable_squad` until a
// squad edge existed; create_squad; project_squad_set; create_agent;
// mint_agent_token -> reveal -> write the token to a file by hand;
// update_squad had no slug field at all (a rename needed a raw D1 UPDATE);
// the Hermes profile was written separately, by hand, by Mubot.
//
// WHAT THIS IS: find-or-create `<slug_base>-prj` and `<slug_base>-sqd`
// (type-safe suffixes, mupot#1495), an ADMIN project<->squad edge, an
// optional `<slug_base>-bot` agent in that squad, plain-squad invites (0156
// shape) for each named human, and one append-only team_bootstrap_receipts
// row PER ATTEMPT (migration 0166). The bot's credential claim and the
// optional project_remember seed are NOT written here — see the doc comment
// below on why, and src/mcp/team-bootstrap.ts for where they happen.
//
// ═══════════════════════════════════════════════════════════════════════════
// THIS FILE IS THE SUCCESSOR TO PR #1510 (kasra-review adversarial round-2
// gate on 29728793a300970c4f351e7c5817e63daa01cfb3, 2026-09-22). Round 2's
// headline P0 — "find-or-create is create + explicit adopt" (Athena, round-2
// sharpening) — was applied to only ONE of this function's TWO find-or-
// creates. Two structural fixes over that shape:
//
// (A) PROVENANCE, NOT EMPTINESS, ON BOTH LIMBS. `projects.created_by_member_id`
//     and `squads.created_by_member_id` (migration 0166, additive, nullable —
//     every pre-existing row lands NULL) are stamped by every production
//     create path (project_create, create_squad, start-gate's
//     autoCreateWritableSquad, and this file's own two creates) via a
//     caller-only opts parameter — never a field on any request-body Input
//     interface (same discipline org/service.ts's `CreateOpts.kind` already
//     uses, for the identical reason: a raw `body as Input` cast must never
//     be able to spoof it). `squadIsAdoptable`'s old ground (b) — zero
//     `agents` rows, zero `capabilities` rows — is REMOVED, not widened:
//     `createSquad` grants its creator no capability row at all, so EVERY
//     freshly created squad satisfied that test, making the round-1 squat
//     trivially reproducible by a strictly lower principal than round-2
//     assumed (measured: a squad lead under a time-boxed elevation, no admin
//     anywhere). `findAdoptGround` below is the ONE adoptability check for
//     BOTH the project and the squad limb: adoptable iff (i) a PRIOR
//     team_bootstrap attempt already named this exact resource id for this
//     exact slug_base (checked against the append-only receipt trail, never
//     the resource's current, attacker-controllable state), OR (ii)
//     `created_by_member_id` on the row equals the calling actor, OR (iii)
//     the caller passes `adopt: true` AND is org:admin (isOrgAdmin, checked
//     HERE — an explicit, informed override, never trusted from a caller).
//     A pre-existing row with NULL `created_by_member_id` is adoptable only
//     via (iii).
//
// (B) RESOLVE BOTH NAMES BEFORE CREATING EITHER. Round 2 created the project
//     FIRST, then discovered the squad name was taken — an orphan project,
//     ZERO receipt, a permanent name reservation, no retry path. Both
//     `<slug_base>-prj` and `<slug_base>-sqd` are now FOUND (never created)
//     up front, and BOTH adoptability checks (plus the project-archived
//     check and the squad kind='home' fence) clear before either is ever
//     created. A refusal on either limb now writes a `'failed'` attempt
//     receipt (new `failed_step: 'name_resolution'`) instead of returning
//     silently — see migration 0166's header for the full shape, and for the
//     documented release-path alternative to a dedicated release tool
//     (`isSlugBaseReserved` stops counting a receipt once the project it
//     names no longer exists).
//
// HOME FENCE (P2-4): a resolved squad with `kind === 'home'` is refused
// unconditionally — `adopt: true` cannot override it. This was already
// latent-only (the canonical home slug `home-<8hex>` can never end in
// `-sqd`), but the fence no longer depends on that coincidence of naming.
//
// THE PER-HUMAN RANK CEILING IS GONE (P1-4 in round 2; kasra-review
// adversarial round-2 gate, finding 6, DELETED here rather than fixed).
// team_bootstrap's own floor (src/mcp/team-bootstrap.ts's ToolSpec:
// `min: 'admin'` PLUS an explicit `hasWorkspaceAdmin` re-check) means every
// caller that ever reaches this function is already org:admin — a rank that
// always dominates the 'observer'/'member' ranks the ceiling compared
// against. The guard could never fire through the tool; its only test proved
// this by calling `teamBootstrap()` directly with `capabilities: []`, a
// principal `invokeTool` itself refuses before reaching this function at all
// — precisely the defect class "no fixture may pre-state a precondition
// production cannot reach." If a lower-privilege path into this tool is ever
// added, a per-human rank ceiling belongs back here, made real against that
// path's floor and proven with a principal `invokeTool` actually admits.
// ═══════════════════════════════════════════════════════════════════════════
//
// ATOMICITY — NOT one giant transaction, deliberately (Athena round-1 gate on
// PR #1510, 2026-09-22, resumability requirement). Department resolution and
// the two name-resolution reads happen BEFORE any of the below; the write
// phase has THREE stages, in order:
//
//   1. ONE env.DB.batch(): the ADMIN project<->squad edge (only when no edge
//      exists yet — an existing edge below admin is NEVER silently raised,
//      see "THE EDGE IS NEVER SILENTLY RAISED" below) + the bot agent's two
//      prepareAgentCreate statements (only when a bot needs creating).
//      All-or-nothing — a failure here (a genuine D1 error, a trigger abort)
//      rolls back both, and neither is left half-wired.
//   2. Per-human invite inserts, ONE AT A TIME, not batched together. A
//      failure on invite N of M does NOT undo invites 1..N-1 — they already
//      committed as their own statements. The loop stops at the first
//      failure rather than skipping ahead, so a systemic fault (not a
//      one-off) does not spray partial state across every remaining human.
//   3. The team_bootstrap_receipts write — ALWAYS attempted, whether stage 1
//      or 2 succeeded or failed (migration 0166's `failed` disposition is
//      exactly for this). ONE INSERT per attempt (never an UPDATE — see
//      migration 0166's header for why the earlier update-in-place design
//      was falsifiable), so it is a separate write from whatever failed by
//      construction: it never shares a transaction with stage 1's batch or
//      any stage-2 insert, so it survives their failure.
//
// This means a genuinely partial, real state — project+squad+maybe-bot+
// SOME invites, with the composite call itself incomplete — is an EXPECTED
// resting state, not corruption. A retry with the same slug_base adopts
// every already-committed piece (project, an OWNED squad, bot, and each
// invite that already landed, via the SAME find-or-create reads every call
// already does) and only attempts what is left.
//
// THE EDGE IS NEVER SILENTLY RAISED (P1-2, PR #1510 round-1 gate): if a
// project<->squad edge already exists below 'admin' (a deliberate 'read' or
// 'write' link — see start-gate.ts's own doctrine on a deliberate
// non-writable edge), this call NEVER overwrites it to 'admin'. The
// response's `edge_kept` field names the level that was preserved (`null`
// when this call set, or found, a genuine admin edge).
//
// PROJECT STATUS IS CHECKED BEFORE ANY CREATE (P1-1, PR #1510 round-1 gate):
// an adopted project that turns out to be `archived` is refused
// `project_archived` immediately — before the squad is ever created — rather
// than burning a free-tier squad-entitlement slot on a project that cannot
// use it and discovering the problem only when the ADMIN-edge INSERT hits
// migration 0055's `validate_project_squad_access_insert` trigger.
//
// Two things are NOT written here at all because they are not D1 writes and
// each already owns its own atomic unit: mintAgentBoundToken
// (members/service.ts — its own D1 writes) and createMemory().remember()
// (D1 + Vectorize, two systems D1.batch() cannot span). Both run AFTER stage
// 3 commits, and only on full success — see src/mcp/team-bootstrap.ts.
//
// IDEMPOTENT ON slug_base: a second call with the same slug_base finds and
// (ownership-checked) adopts the existing project/squad/bot, sends no
// duplicate invite for an email that already has a live invite into this
// squad (and reports that invite's STORED capability, never the newly
// requested one — a replay does not silently change what was already
// granted), and mints no second bot.
//
// AUTHZ — NO AUTHZ INSIDE for the ADMIN gate itself, same doctrine as
// createDepartment/createSquad/createHomeForMember (src/org/service.ts's own
// file header): the caller (src/mcp/team-bootstrap.ts's ToolSpec) gates
// org-admin and refuses an agent-bound principal outright (grant tools never
// run as an agent — the same rule mint_agent_token/update_squad already
// enforce). The squad-adoption `adopt: true` override IS enforced here
// regardless, not left to the caller — defense in depth, same pattern
// project-invites.ts's POST /invites applies to the legacy plain-squad
// invite route: gated on isOrgAdmin here, never trusted from a caller whose
// own floor might one day be lowered.

import type { D1PreparedStatement } from '@cloudflare/workers-types'
import type { Agent, AuthContext, Capability, Env, Project, ProjectAccessLevel, Squad } from '../types'
import { isOrgAdmin } from '../auth/capability'
import { projectSelectSql } from '../projects/columns'
import { createProject } from '../projects/service'
import { assertBatchWritten, assertWritten } from '../lib/receipt'
import { createSquad, isValidSlug, isNonEmptyString, prepareAgentCreate } from './service'
import { resolveDepartmentRef } from './resolve'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PROJECT_SLUG_SUFFIX = '-prj'
const SQUAD_SLUG_SUFFIX = '-sqd'
const AGENT_SLUG_SUFFIX = '-bot'
// isValidSlug's own ceiling is 48 chars; every derived slug appends a 4-char
// suffix (`-prj`/`-sqd`/`-bot`, all exactly 4), so slug_base itself must
// leave room or the DERIVED slug silently fails createProject/createSquad/
// prepareAgentCreate's OWN validation with a confusing 'invalid_slug' for a
// string the caller never typed (P2-6, kasra-review adversarial round-1 gate
// on PR #1510).
const MAX_SLUG_BASE_LENGTH = 48 - 4
const MAX_NAME_LENGTH = 200

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message)
}

function isArchivedProjectTrigger(err: unknown): boolean {
  return err instanceof Error && /archived project/i.test(err.message)
}

/**
 * slug_base is the UNSUFFIXED root this tool appends `-prj`/`-sqd`/`-bot` to.
 * It must pass isValidSlug's own charset rules (lowercase alphanumeric +
 * single hyphens, 1-48 chars) AND must not already carry one of the three
 * kind suffixes — a caller passing `psychonom-prj` as slug_base would
 * otherwise mint `psychonom-prj-prj` — AND must be short enough that every
 * derived slug still fits isValidSlug's own 48-char ceiling.
 */
export function isValidSlugBase(v: unknown): v is string {
  if (!isValidSlug(v)) return false
  const s = v as string
  if (s.length > MAX_SLUG_BASE_LENGTH) return false
  return !s.endsWith(PROJECT_SLUG_SUFFIX) && !s.endsWith(SQUAD_SLUG_SUFFIX) && !s.endsWith(AGENT_SLUG_SUFFIX)
}

function isValidName(v: unknown): v is string {
  return isNonEmptyString(v) && (v as string).trim().length <= MAX_NAME_LENGTH
}

export interface TeamBootstrapHumanInput {
  email: string
  capability: 'observer' | 'member'
}

export interface TeamBootstrapBotInput {
  /** default true */
  enabled?: boolean
  name?: string
  role?: string
  model?: string
}

export interface TeamBootstrapInput {
  slug_base: string
  name: string
  /** department id or slug */
  department: string
  humans?: TeamBootstrapHumanInput[]
  bot?: TeamBootstrapBotInput
  seed_memory?: string
  /**
   * Explicit, informed override to adopt a pre-existing project or squad
   * that this caller did not create and no prior team_bootstrap attempt
   * named (P0, see file header). Ignored unless the caller is org:admin
   * (isOrgAdmin, checked here). Never overrides the kind='home' fence (P2-4).
   */
  adopt?: boolean
}

export interface TeamBootstrapInvite {
  id: string
  email: string
  capability: Capability
  /** false when this email already had a live (unaccepted) invite into this squad */
  created: boolean
}

export interface TeamBootstrapBotResult {
  agent: Agent
  /** false when an agent with this slug already existed in the squad */
  created: boolean
}

export interface TeamBootstrapProjectResult {
  project: Project
  created: boolean
}

export interface TeamBootstrapSquadResult {
  squad: Squad
  created: boolean
}

// 'created' fires ONLY when BOTH the project and the squad were newly
// created by this attempt. 'adopted' fires on EVERY OTHER path that used a
// pre-existing project or squad — a provenance-owned row, a prior
// team_bootstrap attempt's resource reused via a DIFFERENT attempt than the
// one that (re)creates the rest, a cross-department project reuse, a squad
// start-gate auto-created, or an org-admin's explicit `adopt: true`
// override — never folded into 'created' the way PR #1510 round-2 did for
// every ground except the override branch (kasra-review adversarial round-2
// gate, finding 7, 2026-09-22). 'existing' is reserved for the NARROWEST
// case: both resources were matched by a PRIOR team_bootstrap attempt naming
// this exact slug_base (a genuine resumed retry of THIS team's own prior
// work), and this call created no bot and sent no new invite either — a
// true no-op replay.
export type TeamBootstrapDisposition = 'created' | 'existing' | 'adopted'

export interface TeamBootstrapOk {
  ok: true
  disposition: TeamBootstrapDisposition
  project: TeamBootstrapProjectResult
  squad: TeamBootstrapSquadResult
  /** the access level a pre-existing, deliberately-below-admin edge was left
   *  at (P1-2) — null when this call set, or found, a genuine admin edge. */
  edge_kept: ProjectAccessLevel | null
  bot: TeamBootstrapBotResult | null
  invites: TeamBootstrapInvite[]
  /** lowercased emails that appeared more than once in this call's `humans`
   *  list — only the FIRST occurrence was used (P2-1). */
  duplicate_emails_in_request: string[]
  receipt_id: string
}

export type TeamBootstrapError =
  | 'invalid_slug_base'
  | 'invalid_name'
  | 'invalid_department'
  | 'actor_required'
  | 'department_not_found'
  | 'ambiguous_department'
  | 'invalid_human_email'
  | 'invalid_human_capability'
  | 'invalid_bot_name'
  | 'squad_limit_reached'
  | 'agent_limit_reached'
  | 'squad_slug_taken'
  | 'project_slug_taken'
  | 'cannot_adopt_home_squad'
  | 'project_archived'
  | 'provisioning_failed'

export type TeamBootstrapResult = TeamBootstrapOk | { ok: false; error: TeamBootstrapError; detail?: unknown }

async function findProjectBySlug(env: Env, slug: string): Promise<Project | null> {
  return env.DB.prepare(`SELECT ${projectSelectSql()} FROM projects WHERE slug = ?1 LIMIT 1`)
    .bind(slug)
    .first<Project>()
}

async function findSquadByDepartmentAndSlug(env: Env, departmentId: string, slug: string): Promise<Squad | null> {
  return env.DB.prepare(`SELECT * FROM squads WHERE department_id = ?1 AND slug = ?2 LIMIT 1`)
    .bind(departmentId, slug)
    .first<Squad>()
}

async function findAgentBySquadAndSlug(env: Env, squadId: string, slug: string): Promise<Agent | null> {
  return env.DB.prepare(`SELECT * FROM agents WHERE squad_id = ?1 AND slug = ?2 LIMIT 1`)
    .bind(squadId, slug)
    .first<Agent>()
}

/** The invite's id AND its STORED capability — P2-2: a replay that requests a
 *  DIFFERENT capability for an email with a live invite must report what was
 *  actually granted, never silently imply the request changed it. */
async function findLiveInvite(
  env: Env,
  squadId: string,
  email: string,
): Promise<{ id: string; capability: Capability } | null> {
  return env.DB.prepare(
    `SELECT id, capability FROM invites WHERE squad_id = ?1 AND lower(email) = lower(?2) AND accepted_at IS NULL LIMIT 1`,
  )
    .bind(squadId, email)
    .first<{ id: string; capability: Capability }>()
}

interface CapabilityHolder {
  member_id: string
  capability: Capability
}

/** Informational ONLY (since the provenance rewrite) — surfaced in a
 *  squad_slug_taken refusal's detail so an operator can see who currently
 *  holds standing on the squad they were refused, even though holding a
 *  capability no longer factors into the adoptability decision itself. */
async function listSquadCapabilityHolders(env: Env, squadId: string): Promise<CapabilityHolder[]> {
  const rows = await env.DB.prepare(
    `SELECT member_id, capability FROM capabilities WHERE scope_type = 'squad' AND scope_id = ?1`,
  )
    .bind(squadId)
    .all<CapabilityHolder>()
  return rows.results ?? []
}

type AdoptGround = 'prior_attempt' | 'provenance'

/**
 * THE ONE adoptability check for BOTH the project limb and the squad limb
 * (kasra-review adversarial round-2 gate on PR #1510, P0, 2026-09-22: round-2
 * built this only for the squad, leaving the project limb with NO ownership
 * ground at all — measured, with the repo's own elevation fixture, a squad
 * lead's org-scoped `action:workspace_project` elevation planting `<x>-prj`,
 * silently adopted by the org-admin's later team_bootstrap). Two independent
 * grounds, either is sufficient:
 *   (i)  a PRIOR team_bootstrap attempt already named this exact resource id
 *        for this exact slug_base — a genuine resumed retry, checked against
 *        the append-only receipt trail, never against the resource's CURRENT
 *        state (which whoever controls it can freely change).
 *   (ii) `created_by_member_id` on the row equals the calling actor — they
 *        made it themselves, through whatever tool, before this call.
 * Neither holding means someone OTHER than this actor's own prior work put
 * this resource here — the caller above must then require an explicit
 * `adopt: true` + org:admin override, or refuse.
 *
 * "EMPTY" IS NOT A GROUND HERE, DELIBERATELY (P0(b), same gate). Round-2's
 * squad-only ground (b) — zero `agents` rows, zero `capabilities` rows —
 * is REMOVED, not carried forward: createSquad grants its creator no
 * capability row at all, so EVERY freshly created squad satisfied that test,
 * and the round-1 squat was reproducible by a strictly lower principal (a
 * squad lead under a time-boxed elevation, no admin anywhere) than round-2's
 * fix assumed. Provenance replaces it outright; a pre-existing row with NULL
 * `created_by_member_id` (everything created before migration 0166) is
 * adoptable only via the explicit override, never via emptiness.
 */
async function findAdoptGround(
  env: Env,
  tenant: string,
  slugBase: string,
  column: 'project_id' | 'squad_id',
  resourceId: string,
  createdByMemberId: string | null,
  actorMemberId: string,
): Promise<AdoptGround | null> {
  const priorAttempt = await env.DB.prepare(
    // disposition IN ('created','adopted') — kasra-review adversarial gate, P0,
    // 2026-09-22: a 'failed' receipt (in particular a 'name_resolution'
    // refusal) must NEVER itself become adoption ground on the next call —
    // "the refusal manufactures its own adoption ground." See migration
    // 0166's header for the full measured exploit and why a same-actor retry
    // after a genuine stage-1/stage-2 write failure is still covered (ground
    // (ii), provenance) without needing 'failed' rows counted here.
    `SELECT 1 FROM team_bootstrap_receipts
       WHERE tenant = ?1 AND slug_base = ?2 AND ${column} = ?3 AND disposition IN ('created', 'adopted')
       LIMIT 1`,
  )
    .bind(tenant, slugBase, resourceId)
    .first()
  if (priorAttempt) return 'prior_attempt'
  if (createdByMemberId !== null && createdByMemberId === actorMemberId) return 'provenance'
  return null
}

/**
 * Human-readable provenance summary for a slug_taken refusal's detail (Athena
 * ruling relayed 2026-09-22, mupot seq 5238): "created by member X under
 * elevation receipt Y" when the row was created under a bounded elevation,
 * "created by member X" otherwise, or a plain marker for a pre-migration row
 * with no recorded creator at all. Never throws on a NULL creator — an admin
 * adopting an ownerless row still gets a legible detail.
 */
function describeCreator(createdByMemberId: string | null, createdViaElevationGrant: string | null): string {
  if (createdByMemberId === null) return 'created before provenance tracking (no recorded creator)'
  return createdViaElevationGrant === null
    ? `created by member ${createdByMemberId}`
    : `created by member ${createdByMemberId} under elevation receipt ${createdViaElevationGrant}`
}

/**
 * P0(c) helper, consumed by src/mcp/provision.ts's update_squad — NOT called
 * from teamBootstrap itself. A rename INTO a `<x>-sqd` slug that some
 * OTHER project or team_bootstrap attempt has already claimed for `x` needs
 * the OLD create_squad floor (department:admin), not the ordinary squad:admin
 * update_squad otherwise runs at — see toolUpdateSquad's own comment for why.
 *
 * RELEASE PATH (P1-A, documented alternative to a dedicated release tool):
 * a receipt reserves `slug_base` only WHILE the project it names still
 * exists. A receipt with no live project behind it (deleted since, or a
 * `name_resolution` failure that never found/created one) does not reserve —
 * deleting the orphaned project IS the release action.
 */
export async function isSlugBaseReserved(env: Env, tenant: string, slugBase: string): Promise<boolean> {
  const project = await findProjectBySlug(env, `${slugBase}${PROJECT_SLUG_SUFFIX}`)
  if (project) return true
  const receipt = await env.DB.prepare(
    `SELECT 1 FROM team_bootstrap_receipts r
       WHERE r.tenant = ?1 AND r.slug_base = ?2
         AND r.project_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM projects p WHERE p.id = r.project_id)
       LIMIT 1`,
  )
    .bind(tenant, slugBase)
    .first()
  return receipt !== null
}

/** slugBase derived from a squad slug ending in `-sqd`, or null if it doesn't. */
export function slugBaseFromSquadSlug(slug: string): string | null {
  return slug.endsWith(SQUAD_SLUG_SUFFIX) ? slug.slice(0, -SQUAD_SLUG_SUFFIX.length) : null
}

/** Where the write phase stopped, for a 'failed' receipt row (migration 0166). */
export type TeamBootstrapFailedStep = 'edge_or_bot' | 'invite_insert' | 'name_resolution'
/** A short, STRUCTURAL classification — never the raw driver error text, never an
 *  email or other human PII (migration 0166's header explains why). */
export type TeamBootstrapFailureReason =
  | 'unique_violation'
  | 'write_failed'
  | 'archived_project'
  | 'project_slug_taken'
  | 'squad_slug_taken'

function classifyWriteFailure(err: unknown): TeamBootstrapFailureReason {
  if (isUniqueViolation(err)) return 'unique_violation'
  if (isArchivedProjectTrigger(err)) return 'archived_project'
  return 'write_failed'
}

interface WriteReceiptInput {
  tenant: string
  actorMemberId: string
  slugBase: string
  // ALWAYS null on a 'name_resolution' failure (P0 fix, migration 0166) —
  // the refused resource goes in refused* below instead, never here. Always
  // non-null for every other disposition.
  projectId: string | null
  squadId: string | null
  // Set ONLY on a 'name_resolution' failure — the resource(s) that were
  // found and refused. NEVER read by findAdoptGround or any adoptability
  // check; purely an audit trail (P0 fix, migration 0166).
  refusedProjectId?: string | null
  refusedSquadId?: string | null
  botAgentId: string | null
  disposition: TeamBootstrapDisposition | 'failed' | 'released'
  invitedCount: number
  failedStep: TeamBootstrapFailedStep | null
  failureReason: TeamBootstrapFailureReason | null
}

/**
 * ONE INSERT per team_bootstrap ATTEMPT — never an UPDATE (P1-3, kasra-review
 * adversarial round-1 gate on PR #1510: the prior update-in-place design was
 * falsifiable three separate ways — see migration 0166's header). Called on
 * success AND on any write-phase or name-resolution failure (migration
 * 0166's `failed` disposition). Always its own statement, never sharing a
 * transaction with the thing that may have just failed — see this file's
 * ATOMICITY doc comment.
 */
async function writeReceipt(env: Env, input: WriteReceiptInput): Promise<string> {
  const attemptRow = await env.DB.prepare(
    `SELECT COALESCE(MAX(attempt_no), 0) AS max_attempt
       FROM team_bootstrap_receipts WHERE tenant = ?1 AND slug_base = ?2`,
  )
    .bind(input.tenant, input.slugBase)
    .first<{ max_attempt: number }>()
  const attemptNo = (attemptRow?.max_attempt ?? 0) + 1

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO team_bootstrap_receipts
      (id, tenant, actor_member_id, slug_base, attempt_no, project_id, squad_id,
       refused_project_id, refused_squad_id, bot_agent_id,
       disposition, invited_count, failed_step, failure_reason, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
  )
    .bind(
      id,
      input.tenant,
      input.actorMemberId,
      input.slugBase,
      attemptNo,
      input.projectId,
      input.squadId,
      input.refusedProjectId ?? null,
      input.refusedSquadId ?? null,
      input.botAgentId,
      input.disposition,
      input.invitedCount,
      input.failedStep,
      input.failureReason,
      now,
    )
    .run()
  return id
}

export async function teamBootstrap(
  env: Env,
  auth: AuthContext,
  input: TeamBootstrapInput,
): Promise<TeamBootstrapResult> {
  // ── boundary guards, before any read or write (P2-3) ──────────────────────
  if (!auth.memberId) return { ok: false, error: 'actor_required' }
  const actorMemberId = auth.memberId
  if (!isValidSlugBase(input.slug_base)) return { ok: false, error: 'invalid_slug_base' }
  if (!isValidName(input.name)) return { ok: false, error: 'invalid_name' }
  const slugBase = input.slug_base
  const name = input.name.trim()
  // Tenant is environment-derived, never from the caller's own claimed
  // AuthContext.tenant (P2-7 — same doctrine src/mcp/index.ts's file header
  // states for every MCP tool: "Tenant is environment-derived
  // (env.TENANT_SLUG), never client-supplied").
  const tenant = env.TENANT_SLUG

  if (!isNonEmptyString(input.department)) return { ok: false, error: 'invalid_department' }
  const deptResult = await resolveDepartmentRef(env, input.department)
  if (!deptResult.ok) {
    return { ok: false, error: deptResult.reason === 'ambiguous' ? 'ambiguous_department' : 'department_not_found' }
  }
  const departmentId = deptResult.value.id

  // ── validate + dedupe humans BEFORE any write (P2-1) ──────────────────────
  // A bad email/capability, or a duplicate email, must not leave the
  // project/squad half-provisioned, and must not attempt two invite inserts
  // for the same address in one call.
  const rawHumans = input.humans ?? []
  const seenEmails = new Set<string>()
  const duplicateEmails = new Set<string>()
  const humans: TeamBootstrapHumanInput[] = []
  for (const h of rawHumans) {
    if (!isNonEmptyString(h.email) || !EMAIL_RE.test(h.email.trim())) return { ok: false, error: 'invalid_human_email' }
    if (h.capability !== 'observer' && h.capability !== 'member') return { ok: false, error: 'invalid_human_capability' }
    const lower = h.email.trim().toLowerCase()
    if (seenEmails.has(lower)) {
      duplicateEmails.add(lower)
      continue // first occurrence wins
    }
    seenEmails.add(lower)
    humans.push(h)
  }

  const botEnabled = input.bot?.enabled !== false
  if (input.bot?.name !== undefined && !isNonEmptyString(input.bot.name)) {
    return { ok: false, error: 'invalid_bot_name' }
  }

  const projectSlug = `${slugBase}${PROJECT_SLUG_SUFFIX}`
  const squadSlug = `${slugBase}${SQUAD_SLUG_SUFFIX}`
  const agentSlug = `${slugBase}${AGENT_SLUG_SUFFIX}`

  // ── resolve BOTH names — READ ONLY, before any create (P1-A) ──────────────
  // The round-2 shape created the project, THEN discovered the squad name
  // was taken — an orphan project, no receipt, a permanent reservation with
  // no retry path (kasra-review adversarial round-2 gate, finding 4,
  // 2026-09-22). Both find-or-create targets are resolved (found, never
  // created) and BOTH adoptability checks clear before either is created.
  const existingProject = await findProjectBySlug(env, projectSlug)

  // ── project status checked BEFORE the squad is ever created (P1-1) ───────
  if (existingProject && existingProject.status === 'archived') {
    // P2 (kasra-review adversarial gate, 2026-09-22): this refusal used to
    // return with ZERO receipt — the only refusal in this function that
    // didn't. Receipted now, same as every other name_resolution refusal.
    const receiptId = await writeReceipt(env, {
      tenant,
      actorMemberId,
      slugBase,
      projectId: null,
      squadId: null,
      refusedProjectId: existingProject.id,
      refusedSquadId: null,
      botAgentId: null,
      disposition: 'failed',
      invitedCount: 0,
      failedStep: 'name_resolution',
      failureReason: 'archived_project',
    })
    return { ok: false, error: 'project_archived', detail: { project_id: existingProject.id, receipt_id: receiptId } }
  }

  let projectGround: AdoptGround | null = null
  if (existingProject) {
    projectGround = await findAdoptGround(
      env,
      tenant,
      slugBase,
      'project_id',
      existingProject.id,
      existingProject.created_by_member_id,
      actorMemberId,
    )
    if (!projectGround) {
      if (input.adopt === true && isOrgAdmin(auth)) {
        // Explicit, informed override — fall through and adopt. Not folded
        // into `projectGround` (which means "adoptable without an override")
        // so the disposition computed below still counts this as 'adopted',
        // never 'existing'.
      } else {
        const receiptId = await writeReceipt(env, {
          tenant,
          actorMemberId,
          slugBase,
          // P0 fix: NEVER the refused project's id — see migration 0166's
          // header. The refused resource goes in refusedProjectId only.
          projectId: null,
          squadId: null,
          refusedProjectId: existingProject.id,
          refusedSquadId: null,
          botAgentId: null,
          disposition: 'failed',
          invitedCount: 0,
          failedStep: 'name_resolution',
          failureReason: 'project_slug_taken',
        })
        return {
          ok: false,
          error: 'project_slug_taken',
          detail: {
            project_id: existingProject.id,
            created_by_member_id: existingProject.created_by_member_id,
            created_via_elevation_grant: existingProject.created_via_elevation_grant,
            worker_name: existingProject.worker_name,
            summary: describeCreator(existingProject.created_by_member_id, existingProject.created_via_elevation_grant),
            receipt_id: receiptId,
          },
        }
      }
    }
  }

  const existingSquad = await findSquadByDepartmentAndSlug(env, departmentId, squadSlug)

  // ── HOME FENCE (P2-4): never adopt a home squad, even with adopt:true ────
  if (existingSquad && existingSquad.kind === 'home') {
    const receiptId = await writeReceipt(env, {
      tenant,
      actorMemberId,
      slugBase,
      projectId: null,
      squadId: null,
      refusedProjectId: existingProject?.id ?? null,
      refusedSquadId: existingSquad.id,
      botAgentId: null,
      disposition: 'failed',
      invitedCount: 0,
      failedStep: 'name_resolution',
      failureReason: 'squad_slug_taken',
    })
    return { ok: false, error: 'cannot_adopt_home_squad', detail: { squad_id: existingSquad.id, receipt_id: receiptId } }
  }

  let squadGround: AdoptGround | null = null
  if (existingSquad) {
    squadGround = await findAdoptGround(
      env,
      tenant,
      slugBase,
      'squad_id',
      existingSquad.id,
      existingSquad.created_by_member_id,
      actorMemberId,
    )
    if (!squadGround) {
      // Athena, round-2 sharpening on PR #1510: "find-or-create is create +
      // explicit adopt" — an org-admin's `adopt: true` override is an
      // AUDITED operator decision, receipted as its own disposition
      // ('adopted', below) rather than silently folded into 'existing'. Not
      // folded into `squadGround` for the same reason as the project limb
      // above.
      if (input.adopt === true && isOrgAdmin(auth)) {
        // fall through and adopt
      } else {
        const owners = await listSquadCapabilityHolders(env, existingSquad.id)
        const receiptId = await writeReceipt(env, {
          tenant,
          actorMemberId,
          slugBase,
          projectId: null,
          squadId: null,
          refusedProjectId: existingProject?.id ?? null,
          refusedSquadId: existingSquad.id,
          botAgentId: null,
          disposition: 'failed',
          invitedCount: 0,
          failedStep: 'name_resolution',
          failureReason: 'squad_slug_taken',
        })
        return {
          ok: false,
          error: 'squad_slug_taken',
          detail: {
            squad_id: existingSquad.id,
            department_id: departmentId,
            created_by_member_id: existingSquad.created_by_member_id,
            created_via_elevation_grant: existingSquad.created_via_elevation_grant,
            summary: describeCreator(existingSquad.created_by_member_id, existingSquad.created_via_elevation_grant),
            owners,
            receipt_id: receiptId,
          },
        }
      }
    }
  }

  // ── resolve-or-create PROJECT — its own commit, its own entitlement gate ──
  let project = existingProject
  let projectCreated = false
  if (!project) {
    const created = await createProject(env, { slug: projectSlug, name }, { createdByMemberId: actorMemberId })
    if (created.ok) {
      project = created.value
      projectCreated = true
    } else if (created.error === 'slug_taken') {
      // Race: a concurrent identical call (or an unrelated create using the
      // same derived slug) won between our read and this insert. Adopt it —
      // this is the SAME narrow race window round-1 already accepted; the
      // adoptability check above ran against a row that did not exist yet,
      // so it cannot apply retroactively here.
      const raced = await findProjectBySlug(env, projectSlug)
      if (!raced) return { ok: false, error: 'provisioning_failed', detail: { stage: 'project', reason: created.error } }
      project = raced
    } else {
      return { ok: false, error: 'provisioning_failed', detail: { stage: 'project', reason: created.error } }
    }
  }

  // Archived check repeated for the narrow race-adopted branch above — the
  // upfront check already covers the common `existingProject` path.
  if (project.status === 'archived') {
    const receiptId = await writeReceipt(env, {
      tenant,
      actorMemberId,
      slugBase,
      projectId: null,
      squadId: null,
      refusedProjectId: project.id,
      refusedSquadId: null,
      botAgentId: null,
      disposition: 'failed',
      invitedCount: 0,
      failedStep: 'name_resolution',
      failureReason: 'archived_project',
    })
    return { ok: false, error: 'project_archived', detail: { project_id: project.id, receipt_id: receiptId } }
  }

  // ── resolve-or-create SQUAD — its own commit, its own entitlement gate ────
  let squad = existingSquad
  let squadCreated = false
  if (!squad) {
    const created = await createSquad(env, departmentId, { slug: squadSlug, name }, { createdByMemberId: actorMemberId })
    if (created.ok) {
      squad = created.value
      squadCreated = true
    } else if (created.error === 'slug_taken') {
      const raced = await findSquadByDepartmentAndSlug(env, departmentId, squadSlug)
      if (!raced) return { ok: false, error: 'provisioning_failed', detail: { stage: 'squad', reason: created.error } }
      squad = raced
    } else {
      const mapped = created.error === 'squad_limit_reached' ? 'squad_limit_reached' : 'provisioning_failed'
      return { ok: false, error: mapped, detail: { stage: 'squad', reason: created.error } }
    }
  }

  // ── which humans still need a fresh invite (idempotency), reporting the
  //    STORED capability for one that already exists (P2-2) ────────────────
  const inviteRows: TeamBootstrapInvite[] = []
  const invitesToInsert: { id: string; email: string; capability: Capability }[] = []
  for (const h of humans) {
    const email = h.email.trim()
    const existing = await findLiveInvite(env, squad.id, email)
    if (existing) {
      inviteRows.push({ id: existing.id, email, capability: existing.capability, created: false })
    } else {
      const id = crypto.randomUUID()
      invitesToInsert.push({ id, email, capability: h.capability })
      inviteRows.push({ id, email, capability: h.capability, created: true })
    }
  }

  // ── bot: find existing, or prepare statements to add to the batch ─────────
  let existingAgent: Agent | null = null
  let preparedAgent: { agent: Agent; statements: [D1PreparedStatement, D1PreparedStatement] } | null = null
  if (botEnabled) {
    existingAgent = await findAgentBySquadAndSlug(env, squad.id, agentSlug)
    if (!existingAgent) {
      const prepared = await prepareAgentCreate(env, squad.id, {
        slug: agentSlug,
        name: input.bot?.name?.trim() || `${name} Bot`,
        role: input.bot?.role,
        model: input.bot?.model,
      })
      if (!prepared.ok) {
        const mapped = prepared.error === 'agent_limit_reached' ? 'agent_limit_reached' : 'provisioning_failed'
        return { ok: false, error: mapped, detail: { stage: 'bot', reason: prepared.error } }
      }
      preparedAgent = prepared.value
    }
  }

  // ── the ADMIN edge is never silently raised (P1-2) ────────────────────────
  const existingEdge = await env.DB.prepare(
    `SELECT access_level FROM project_squad_access WHERE project_id = ?1 AND squad_id = ?2`,
  )
    .bind(project.id, squad.id)
    .first<{ access_level: ProjectAccessLevel }>()
  const edgeKept: ProjectAccessLevel | null =
    existingEdge && existingEdge.access_level !== 'admin' ? existingEdge.access_level : null
  const needsEdgeInsert = !existingEdge

  const now = new Date().toISOString()

  // ── stage 1: ONE atomic batch — the ADMIN edge (if needed) + the bot ─────
  const structuralStatements: D1PreparedStatement[] = []
  if (needsEdgeInsert) {
    structuralStatements.push(
      env.DB.prepare(
        `INSERT INTO project_squad_access (project_id, squad_id, access_level, granted_at)
         VALUES (?1, ?2, 'admin', ?3)
         ON CONFLICT(project_id, squad_id) DO NOTHING`,
      ).bind(project.id, squad.id, now),
    )
  }
  if (preparedAgent) {
    structuralStatements.push(preparedAgent.statements[0], preparedAgent.statements[1])
  }

  if (structuralStatements.length > 0) {
    try {
      const results = await env.DB.batch(structuralStatements)
      assertBatchWritten(results, 'team_bootstrap.structural', 1)
    } catch (err) {
      // Stage 1 failed — the ADMIN edge and/or the bot did not land. Nothing
      // from stage 2 (invites) has run yet. Receipt the failure as its own,
      // separate write (never inside the batch that just rolled back) so a
      // retry — and any operator watching this table — sees it.
      await writeReceipt(env, {
        tenant,
        actorMemberId,
        slugBase,
        projectId: project.id,
        squadId: squad.id,
        botAgentId: existingAgent?.id ?? null,
        disposition: 'failed',
        invitedCount: 0,
        failedStep: 'edge_or_bot',
        failureReason: classifyWriteFailure(err),
      })
      return { ok: false, error: 'provisioning_failed', detail: { stage: 'edge_or_bot', reason: classifyWriteFailure(err) } }
    }
  }

  const botAgentId = preparedAgent?.agent.id ?? existingAgent?.id ?? null

  // ── stage 2: per-human invite inserts, ONE AT A TIME (never batched) ──────
  // A failure on invite N does not touch invites 1..N-1 — they are already
  // separate, already-committed statements. Stop at the first failure rather
  // than skipping ahead: a systemic fault should not scatter partial state
  // across every remaining human.
  let insertedInviteCount = 0
  let inviteFailure: unknown = null
  for (const invite of invitesToInsert) {
    try {
      const result = await env.DB.prepare(
        `INSERT INTO invites (id, email, department_id, squad_id, capability, invited_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
        .bind(invite.id, invite.email, departmentId, squad.id, invite.capability, actorMemberId, now)
        .run()
      assertWritten(result, 'team_bootstrap.invite_insert', 1)
      insertedInviteCount += 1
    } catch (err) {
      inviteFailure = err
      break
    }
  }

  if (inviteFailure) {
    const receiptId = await writeReceipt(env, {
      tenant,
      actorMemberId,
      slugBase,
      projectId: project.id,
      squadId: squad.id,
      botAgentId,
      disposition: 'failed',
      invitedCount: insertedInviteCount,
      failedStep: 'invite_insert',
      failureReason: classifyWriteFailure(inviteFailure),
    })
    return {
      ok: false,
      error: 'provisioning_failed',
      detail: { stage: 'invite_insert', reason: classifyWriteFailure(inviteFailure), receipt_id: receiptId },
    }
  }

  // ── stage 3: the success receipt — one INSERT, this attempt only ─────────
  // disposition (P2-1, kasra-review adversarial round-2 gate, finding 7):
  // 'created' fires ONLY when BOTH project and squad were newly created this
  // call. 'existing' is the narrowest bucket — both resources matched a
  // PRIOR team_bootstrap attempt (a genuine resumed retry) AND this call
  // created no bot and sent no new invite. Every other combination —
  // provenance-owned adoption, an explicit adopt:true override, a mixed
  // create-one/adopt-the-other attempt, a cross-department project reuse, a
  // start-gate auto-created squad found by slug — is 'adopted'.
  const pureResumedRetry =
    !projectCreated &&
    !squadCreated &&
    projectGround === 'prior_attempt' &&
    squadGround === 'prior_attempt' &&
    preparedAgent === null &&
    invitesToInsert.length === 0
  const disposition: TeamBootstrapDisposition =
    projectCreated && squadCreated ? 'created' : pureResumedRetry ? 'existing' : 'adopted'
  const receiptId = await writeReceipt(env, {
    tenant,
    actorMemberId,
    slugBase,
    projectId: project.id,
    squadId: squad.id,
    botAgentId,
    disposition,
    invitedCount: insertedInviteCount,
    failedStep: null,
    failureReason: null,
  })

  const botResult: TeamBootstrapBotResult | null = preparedAgent
    ? { agent: preparedAgent.agent, created: true }
    : existingAgent
      ? { agent: existingAgent, created: false }
      : null

  return {
    ok: true,
    disposition,
    project: { project, created: projectCreated },
    squad: { squad, created: squadCreated },
    edge_kept: edgeKept,
    bot: botResult,
    invites: inviteRows,
    duplicate_emails_in_request: [...duplicateEmails],
    receipt_id: receiptId,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// team_bootstrap_release (P1-1, promoted from a documented alternative to a
// real receipted tool — Athena's own upgrade on PR #1516's sibling successor,
// 2026-09-22). The ONLY way to release a `slug_base` reservation once
// `isSlugBaseReserved` is holding it against a genuinely orphaned project —
// see migration 0166's header for how this composes with that function
// without any special-casing. Deliberately NARROW: releases the PROJECT
// reservation only (a squad, if any exists under this slug_base, is
// untouched — team_bootstrap itself always resolves the squad independently
// by department+slug, so a released project does not orphan a squad the way
// the reverse could). Refuses outright if the project has ANY
// project_squad_access edge: a project actually wired to a squad is in use,
// never a candidate for release regardless of how it got there.
// ═══════════════════════════════════════════════════════════════════════════

export type TeamBootstrapReleaseError =
  | 'invalid_slug_base'
  | 'actor_required'
  | 'project_not_found'
  | 'project_has_edges'
  | 'release_failed'

export type TeamBootstrapReleaseResult =
  | { ok: true; released_project_id: string; receipt_id: string }
  | { ok: false; error: TeamBootstrapReleaseError; detail?: unknown }

/**
 * Core function — NO authz inside for the org-admin gate itself (same
 * doctrine as teamBootstrap's own file header: the caller, src/mcp/
 * team-bootstrap.ts's ToolSpec, gates org-admin and refuses an agent-bound
 * principal). Boundary guards run here regardless, before any read or write.
 */
export async function releaseTeamBootstrapSlugBase(
  env: Env,
  auth: AuthContext,
  slugBase: unknown,
): Promise<TeamBootstrapReleaseResult> {
  if (!auth.memberId) return { ok: false, error: 'actor_required' }
  if (!isValidSlugBase(slugBase)) return { ok: false, error: 'invalid_slug_base' }
  const tenant = env.TENANT_SLUG

  const project = await findProjectBySlug(env, `${slugBase}${PROJECT_SLUG_SUFFIX}`)
  if (!project) return { ok: false, error: 'project_not_found' }

  const edgeCount = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM project_squad_access WHERE project_id = ?1`,
  )
    .bind(project.id)
    .first<{ n: number }>()
  if ((edgeCount?.n ?? 0) > 0) {
    return {
      ok: false,
      error: 'project_has_edges',
      detail: { project_id: project.id, edge_count: edgeCount?.n ?? 0 },
    }
  }

  try {
    const result = await env.DB.prepare(`DELETE FROM projects WHERE id = ?1`).bind(project.id).run()
    assertWritten(result, 'team_bootstrap_release.delete_project', 1)
  } catch (err) {
    return {
      ok: false,
      error: 'release_failed',
      detail: { reason: err instanceof Error ? err.message : String(err) },
    }
  }

  // The 'released' row names the NOW-DELETED project's id — deliberately: it
  // is the audit trail of what was released, and (per migration 0166's
  // header) isSlugBaseReserved's own EXISTS join means this row, like every
  // other receipt that named this project, stops reserving the name the
  // instant the DELETE above commits. No special-casing needed.
  const receiptId = await writeReceipt(env, {
    tenant,
    actorMemberId: auth.memberId,
    slugBase,
    projectId: project.id,
    squadId: null,
    botAgentId: null,
    disposition: 'released',
    invitedCount: 0,
    failedStep: null,
    failureReason: null,
  })

  return { ok: true, released_project_id: project.id, receipt_id: receiptId }
}
