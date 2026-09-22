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
// SQUAD ADOPTION IS NOT FREE (kasra-review adversarial round-1 gate on PR
// #1510, P0, 2026-09-22 — "adoption without ownership", the same class as
// #1507's P0-4). Finding an existing squad by (department_id, slug) and
// wiring it an ADMIN edge onto a NEW project — plus placing a mintable bot
// inside it — is a PRIVILEGE GRANT to whoever already controls that squad.
// Before adopting any pre-existing squad, squadIsAdoptable (below) requires
// EITHER (a) a prior team_bootstrap attempt already named this exact
// squad_id for this exact slug_base (a genuine resumed retry — checked
// against team_bootstrap_receipts, never against the squad's CURRENT state,
// which an attacker controls), OR (b) the squad is genuinely EMPTY — zero
// agents, zero capability grants — so adopting it hands nobody standing they
// did not already have. Neither holding: refused `squad_slug_taken` (with
// the squad's current capability holders in the detail) UNLESS the caller
// passes `adopt: true` AND is org:admin (isOrgAdmin, checked HERE — an
// explicit, informed override, never implicit).
//
// ATOMICITY — NOT one giant transaction, deliberately (Athena round-1 gate on
// PR #1510, 2026-09-22, resumability requirement). Department/project/squad
// resolution happens BEFORE any of the below (each is its OWN independently
// committing, entitlement-gated create — createProject/createSquad already
// own that discipline and this function does not fork it). After that, the
// write phase has THREE stages, in order:
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
// THE EDGE IS NEVER SILENTLY RAISED (P1-2, same gate): if a project<->squad
// edge already exists below 'admin' (a deliberate 'read' or 'write' link —
// see start-gate.ts's own doctrine on a deliberate non-writable edge), this
// call NEVER overwrites it to 'admin'. The response's `edge_kept` field
// names the level that was preserved (`null` when this call set, or found,
// a genuine admin edge).
//
// PROJECT STATUS IS CHECKED BEFORE ANY CREATE (P1-1, same gate): an adopted
// project that turns out to be `archived` is refused `project_archived`
// immediately — before the squad is ever created — rather than burning a
// free-tier squad-entitlement slot on a project that cannot use it and
// discovering the problem only when the ADMIN-edge INSERT hits migration
// 0055's `validate_project_squad_access_insert` trigger.
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
// enforce). Two checks below ARE enforced here regardless, not left to the
// caller — defense in depth, same pattern project-invites.ts's POST
// /invites applies to the legacy plain-squad invite route:
//   - the PER-HUMAN rank ceiling, run BEFORE project/squad are created
//     (P1-4, same gate — it used to run after, wasting a create on a call
//     that was always going to be refused);
//   - the squad-adoption `adopt: true` override, gated on isOrgAdmin here,
//     never trusted from a caller whose own floor might one day be lowered.

import type { D1PreparedStatement } from '@cloudflare/workers-types'
import type { Agent, AuthContext, Capability, Env, Project, ProjectAccessLevel, Squad } from '../types'
import { actorRankOnScopeFor, capabilityRank, isOrgAdmin } from '../auth/capability'
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
   * Explicit, informed override to adopt a pre-existing, non-empty squad
   * that a prior team_bootstrap attempt did NOT name (P0, see file header).
   * Ignored unless the caller is org:admin (isOrgAdmin, checked here).
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

// 'adopted' (Athena, round-2 sharpening on PR #1510, 2026-09-22): "find-or-
// create is create + explicit adopt" — claiming a pre-existing, non-empty
// squad via `adopt: true` is an AUDITED operator decision, not an ordinary
// idempotent replay. It gets its own disposition rather than folding into
// 'created' so the receipt trail can never conflate "I made something new"
// with "I claimed something someone else already built."
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
  | 'cannot_invite_above_own_rank'
  | 'invalid_bot_name'
  | 'squad_limit_reached'
  | 'agent_limit_reached'
  | 'squad_slug_taken'
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

async function listSquadCapabilityHolders(env: Env, squadId: string): Promise<CapabilityHolder[]> {
  const rows = await env.DB.prepare(
    `SELECT member_id, capability FROM capabilities WHERE scope_type = 'squad' AND scope_id = ?1`,
  )
    .bind(squadId)
    .all<CapabilityHolder>()
  return rows.results ?? []
}

/**
 * P0 (kasra-review adversarial round-1 gate on PR #1510): true when it is
 * safe to wire an ADMIN project edge onto this pre-existing squad and place
 * a mintable bot inside it. Two independent grounds, either is sufficient:
 *   (a) a PRIOR team_bootstrap attempt already named this exact squad_id for
 *       this exact slug_base — a genuine resumed retry, checked against the
 *       append-only receipt trail, never against the squad's CURRENT state
 *       (which whoever controls the squad can freely change).
 *   (b) the squad is genuinely EMPTY right now — zero agents, zero
 *       capability grants — so adopting it hands nobody standing they did
 *       not already have.
 * Neither holding means someone OTHER than a prior bootstrap of this exact
 * team put this squad here — refuse unless the caller explicitly overrides.
 */
async function squadIsAdoptable(env: Env, squadId: string, tenant: string, slugBase: string): Promise<boolean> {
  const priorAttempt = await env.DB.prepare(
    `SELECT 1 FROM team_bootstrap_receipts WHERE tenant = ?1 AND squad_id = ?2 AND slug_base = ?3 LIMIT 1`,
  )
    .bind(tenant, squadId, slugBase)
    .first()
  if (priorAttempt) return true

  const hasAgent = await env.DB.prepare(`SELECT 1 FROM agents WHERE squad_id = ?1 LIMIT 1`).bind(squadId).first()
  if (hasAgent) return false
  const hasCapabilityRow = await env.DB.prepare(
    `SELECT 1 FROM capabilities WHERE scope_type = 'squad' AND scope_id = ?1 LIMIT 1`,
  )
    .bind(squadId)
    .first()
  return !hasCapabilityRow
}

/**
 * P0(c) helper, consumed by src/mcp/provision.ts's update_squad — NOT called
 * from teamBootstrap itself. A rename INTO a `<x>-sqd` slug that some
 * OTHER project or team_bootstrap attempt has already claimed for `x` needs
 * the OLD create_squad floor (department:admin), not the ordinary squad:admin
 * update_squad otherwise runs at — see toolUpdateSquad's own comment for why.
 */
export async function isSlugBaseReserved(env: Env, tenant: string, slugBase: string): Promise<boolean> {
  const project = await findProjectBySlug(env, `${slugBase}${PROJECT_SLUG_SUFFIX}`)
  if (project) return true
  const receipt = await env.DB.prepare(
    `SELECT 1 FROM team_bootstrap_receipts WHERE tenant = ?1 AND slug_base = ?2 LIMIT 1`,
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
export type TeamBootstrapFailedStep = 'edge_or_bot' | 'invite_insert'
/** A short, STRUCTURAL classification — never the raw driver error text, never an
 *  email or other human PII (migration 0166's header explains why). */
export type TeamBootstrapFailureReason = 'unique_violation' | 'write_failed' | 'archived_project'

function classifyWriteFailure(err: unknown): TeamBootstrapFailureReason {
  if (isUniqueViolation(err)) return 'unique_violation'
  if (isArchivedProjectTrigger(err)) return 'archived_project'
  return 'write_failed'
}

interface WriteReceiptInput {
  tenant: string
  actorMemberId: string
  slugBase: string
  projectId: string
  squadId: string
  botAgentId: string | null
  disposition: TeamBootstrapDisposition | 'failed'
  invitedCount: number
  failedStep: TeamBootstrapFailedStep | null
  failureReason: TeamBootstrapFailureReason | null
}

/**
 * ONE INSERT per team_bootstrap ATTEMPT — never an UPDATE (P1-3, kasra-review
 * adversarial round-1 gate on PR #1510: the prior update-in-place design was
 * falsifiable three separate ways — see migration 0166's header). Called on
 * success AND on a stage-1/stage-2 write-phase failure (migration 0166's
 * `failed` disposition). Always its own statement, never sharing a
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
      (id, tenant, actor_member_id, slug_base, attempt_no, project_id, squad_id, bot_agent_id,
       disposition, invited_count, failed_step, failure_reason, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
  )
    .bind(
      id,
      input.tenant,
      input.actorMemberId,
      input.slugBase,
      attemptNo,
      input.projectId,
      input.squadId,
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

  // ── rank ceiling, BEFORE any create (P1-4) ────────────────────────────────
  // Department scope, not squad — the squad may not exist yet, and an
  // org/department grant inherits down to it regardless (capability.ts's own
  // invariant). Running this before createProject/createSquad means a call
  // that was always going to be refused never burns an entitlement slot on
  // a squad/project nobody gets to keep.
  if (humans.length > 0) {
    const actorRank = await actorRankOnScopeFor(env, auth, 'department', departmentId)
    for (const h of humans) {
      if (capabilityRank(h.capability) > actorRank) {
        return { ok: false, error: 'cannot_invite_above_own_rank', detail: { email: h.email, capability: h.capability } }
      }
    }
  }

  const projectSlug = `${slugBase}${PROJECT_SLUG_SUFFIX}`
  const squadSlug = `${slugBase}${SQUAD_SLUG_SUFFIX}`
  const agentSlug = `${slugBase}${AGENT_SLUG_SUFFIX}`

  // ── resolve-or-create PROJECT — its own commit, its own entitlement gate ──
  let project = await findProjectBySlug(env, projectSlug)
  let projectCreated = false
  if (!project) {
    const created = await createProject(env, { slug: projectSlug, name })
    if (created.ok) {
      project = created.value
      projectCreated = true
    } else if (created.error === 'slug_taken') {
      // Race: a concurrent identical call (or an unrelated create using the
      // same derived slug) won between our read and this insert. Adopt it.
      const raced = await findProjectBySlug(env, projectSlug)
      if (!raced) return { ok: false, error: 'provisioning_failed', detail: { stage: 'project', reason: created.error } }
      project = raced
    } else {
      return { ok: false, error: 'provisioning_failed', detail: { stage: 'project', reason: created.error } }
    }
  }

  // ── project status checked BEFORE the squad is ever created (P1-1) ───────
  // An adopted, archived project can never take an ADMIN edge (migration
  // 0055's validate_project_squad_access_insert trigger) — refuse NOW,
  // before spending a free-tier squad-entitlement slot on a squad this call
  // could never finish wiring.
  if (project.status === 'archived') {
    return { ok: false, error: 'project_archived', detail: { project_id: project.id } }
  }

  // ── resolve-or-create SQUAD — its own commit, its own entitlement gate,
  //    ownership-checked before adoption (P0) ───────────────────────────────
  let squad = await findSquadByDepartmentAndSlug(env, departmentId, squadSlug)
  let squadCreated = false
  let adoptedViaOverride = false
  if (squad) {
    const adoptable = await squadIsAdoptable(env, squad.id, tenant, slugBase)
    if (!adoptable) {
      if (!(input.adopt === true && isOrgAdmin(auth))) {
        const owners = await listSquadCapabilityHolders(env, squad.id)
        return {
          ok: false,
          error: 'squad_slug_taken',
          detail: { squad_id: squad.id, department_id: departmentId, owners },
        }
      }
      // Athena, round-2 sharpening on PR #1510: "find-or-create is create +
      // explicit adopt" — an org-admin's `adopt: true` override is an
      // AUDITED operator decision, receipted as its own disposition
      // ('adopted', below) rather than silently folded into 'existing'.
      adoptedViaOverride = true
    }
  } else {
    const created = await createSquad(env, departmentId, { slug: squadSlug, name })
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
        actorMemberId: auth.memberId,
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
        .bind(invite.id, invite.email, departmentId, squad.id, invite.capability, auth.memberId, now)
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
      actorMemberId: auth.memberId,
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
  const disposition: TeamBootstrapDisposition = adoptedViaOverride
    ? 'adopted'
    : projectCreated || squadCreated || preparedAgent !== null || invitesToInsert.length > 0
      ? 'created'
      : 'existing'
  const receiptId = await writeReceipt(env, {
    tenant,
    actorMemberId: auth.memberId,
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
