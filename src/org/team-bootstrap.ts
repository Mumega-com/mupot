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
// row (migration 0166). The bot's credential claim and the optional
// project_remember seed are NOT written here — see the doc comment below on
// why, and src/mcp/team-bootstrap.ts for where they happen.
//
// ATOMICITY — NOT one giant transaction, deliberately (Athena round-1 gate on
// PR #1510, 2026-09-22, resumability requirement). Department/project/squad
// resolution happens BEFORE any of the below (each is its OWN independently
// committing, entitlement-gated create — createProject/createSquad already
// own that discipline and this function does not fork it). After that, the
// write phase has THREE stages, in order:
//
//   1. ONE env.DB.batch(): the ADMIN project<->squad edge + the bot agent's
//      two prepareAgentCreate statements (only when a bot needs creating).
//      All-or-nothing — a failure here (a genuine D1 error, a trigger abort)
//      rolls back both, and neither is left half-wired.
//   2. Per-human invite inserts, ONE AT A TIME, not batched together. A
//      failure on invite N of M does NOT undo invites 1..N-1 — they already
//      committed as their own statements. The loop stops at the first
//      failure rather than skipping ahead, so a systemic fault (not a
//      one-off) does not spray partial state across every remaining human.
//   3. The team_bootstrap_receipts write — ALWAYS attempted, whether stage 1
//      or 2 succeeded or failed (migration 0166's `failed` disposition is
//      exactly for this). This is a separate write from whatever failed, by
//      construction: it never shares a transaction with stage 1's batch or
//      any stage-2 insert, so it survives their failure.
//
// This means a genuinely partial, real state — project+squad+maybe-bot+
// SOME invites, with the composite call itself incomplete — is an EXPECTED
// resting state, not corruption: see migration 0166's "FAILED ATTEMPTS ARE
// RECEIPTED, AND RESUMABLE" section. A retry with the same slug_base adopts
// every already-committed piece (project, squad, bot, and each invite that
// already landed) and only attempts what is left.
//
// Two things are NOT written here at all because they are not D1 writes and
// each already owns its own atomic unit: mintAgentBoundToken
// (members/service.ts — its own D1 writes) and createMemory().remember()
// (D1 + Vectorize, two systems D1.batch() cannot span). Both run AFTER stage
// 3 commits, and only on full success — see src/mcp/team-bootstrap.ts.
//
// IDEMPOTENT ON slug_base: a second call with the same slug_base finds the
// existing project/squad/bot (reads before every create), sends no duplicate
// invite for an email that already has a live invite into this squad, and
// mints no second bot. The receipt row is UNIQUE(tenant, slug_base) — every
// call for the same team UPDATEs the SAME row (disposition, invited_count,
// and on a stage-2 failure, failed_step/failure_reason) rather than
// inserting a second one; see migration 0166 for exactly which columns are
// immutable (tenant/slug_base/project_id/squad_id/created_at only) versus
// which reflect the latest attempt.
//
// AUTHZ — NO AUTHZ INSIDE for the ADMIN gate itself, same doctrine as
// createDepartment/createSquad/createHomeForMember (src/org/service.ts's own
// file header): the caller (src/mcp/team-bootstrap.ts's ToolSpec) gates
// org-admin and refuses an agent-bound principal outright (grant tools never
// run as an agent — the same rule mint_agent_token/update_squad already
// enforce). The PER-HUMAN rank ceiling below, however, IS enforced here, not
// left to the caller — so a future elevation path that lowers team_bootstrap's
// own floor cannot silently skip it (defense in depth; same pattern
// project-invites.ts's POST /invites applies to the legacy plain-squad
// invite route).

import type { D1PreparedStatement } from '@cloudflare/workers-types'
import type { Agent, AuthContext, Capability, Env, Project, Squad } from '../types'
import { actorRankOnScopeFor, capabilityRank } from '../auth/capability'
import { projectSelectSql } from '../projects/columns'
import { createProject } from '../projects/service'
import { assertBatchWritten, assertWritten } from '../lib/receipt'
import { createSquad, isValidSlug, isNonEmptyString, prepareAgentCreate } from './service'
import { resolveDepartmentRef } from './resolve'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PROJECT_SLUG_SUFFIX = '-prj'
const SQUAD_SLUG_SUFFIX = '-sqd'
const AGENT_SLUG_SUFFIX = '-bot'

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message)
}

/**
 * slug_base is the UNSUFFIXED root this tool appends `-prj`/`-sqd`/`-bot` to.
 * It must pass isValidSlug's own charset rules (lowercase alphanumeric +
 * single hyphens, 1-48 chars) AND must not already carry one of the three
 * kind suffixes — a caller passing `psychonom-prj` as slug_base would
 * otherwise mint `psychonom-prj-prj`.
 */
export function isValidSlugBase(v: unknown): v is string {
  if (!isValidSlug(v)) return false
  const s = v as string
  return !s.endsWith(PROJECT_SLUG_SUFFIX) && !s.endsWith(SQUAD_SLUG_SUFFIX) && !s.endsWith(AGENT_SLUG_SUFFIX)
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

export type TeamBootstrapDisposition = 'created' | 'existing'

export interface TeamBootstrapOk {
  ok: true
  disposition: TeamBootstrapDisposition
  project: Project
  squad: Squad
  bot: TeamBootstrapBotResult | null
  invites: TeamBootstrapInvite[]
  receipt_id: string
}

export type TeamBootstrapError =
  | 'invalid_slug_base'
  | 'invalid_name'
  | 'invalid_department'
  | 'department_not_found'
  | 'ambiguous_department'
  | 'invalid_human_email'
  | 'invalid_human_capability'
  | 'cannot_invite_above_own_rank'
  | 'invalid_bot_name'
  | 'squad_limit_reached'
  | 'agent_limit_reached'
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

async function findLiveInvite(env: Env, squadId: string, email: string): Promise<{ id: string } | null> {
  return env.DB.prepare(
    `SELECT id FROM invites WHERE squad_id = ?1 AND lower(email) = lower(?2) AND accepted_at IS NULL LIMIT 1`,
  )
    .bind(squadId, email)
    .first<{ id: string }>()
}

interface ReceiptRow {
  id: string
  invited_count: number
}

async function findReceipt(env: Env, tenant: string, slugBase: string): Promise<ReceiptRow | null> {
  return env.DB.prepare(
    `SELECT id, invited_count FROM team_bootstrap_receipts WHERE tenant = ?1 AND slug_base = ?2 LIMIT 1`,
  )
    .bind(tenant, slugBase)
    .first<ReceiptRow>()
}

/** Where the write phase stopped, for a 'failed' receipt row (migration 0166). */
export type TeamBootstrapFailedStep = 'edge_or_bot' | 'invite_insert'
/** A short, STRUCTURAL classification — never the raw driver error text, never an
 *  email or other human PII (migration 0166's header explains why). */
export type TeamBootstrapFailureReason = 'unique_violation' | 'write_failed'

function classifyWriteFailure(err: unknown): TeamBootstrapFailureReason {
  return isUniqueViolation(err) ? 'unique_violation' : 'write_failed'
}

interface WriteReceiptOutcomeInput {
  existingReceipt: ReceiptRow | null
  tenant: string
  actorMemberId: string | null
  slugBase: string
  projectId: string
  squadId: string
  botAgentId: string | null
  disposition: 'created' | 'existing' | 'failed'
  invitedCount: number
  failedStep: TeamBootstrapFailedStep | null
  failureReason: TeamBootstrapFailureReason | null
}

/**
 * The ONE place team_bootstrap writes its receipt — on success (a fresh
 * 'created'/'existing' row, or an update to invited_count on a replay) AND
 * on a stage-1/stage-2 write-phase failure (a 'failed' row, migration
 * 0166). Always its own statement, never sharing a transaction with the
 * thing that may have just failed — see this file's ATOMICITY doc comment.
 * A retry finds the SAME row (UNIQUE(tenant, slug_base)) and UPDATEs it —
 * the row is the CURRENT state of this team's bootstrap attempts, not a
 * historical log entry (migration 0166's "RESUMABILITY" section).
 */
async function writeReceiptOutcome(env: Env, input: WriteReceiptOutcomeInput): Promise<string> {
  if (input.existingReceipt) {
    await env.DB.prepare(
      `UPDATE team_bootstrap_receipts
          SET actor_member_id = ?1, bot_agent_id = ?2, disposition = ?3,
              invited_count = ?4, failed_step = ?5, failure_reason = ?6
        WHERE id = ?7`,
    )
      .bind(
        input.actorMemberId,
        input.botAgentId,
        input.disposition,
        input.invitedCount,
        input.failedStep,
        input.failureReason,
        input.existingReceipt.id,
      )
      .run()
    return input.existingReceipt.id
  }

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO team_bootstrap_receipts
      (id, tenant, actor_member_id, slug_base, project_id, squad_id, bot_agent_id,
       disposition, invited_count, failed_step, failure_reason, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
  )
    .bind(
      id,
      input.tenant,
      input.actorMemberId,
      input.slugBase,
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
  if (!isValidSlugBase(input.slug_base)) return { ok: false, error: 'invalid_slug_base' }
  if (!isNonEmptyString(input.name)) return { ok: false, error: 'invalid_name' }
  const slugBase = input.slug_base
  const name = input.name.trim()

  if (!isNonEmptyString(input.department)) return { ok: false, error: 'invalid_department' }
  const deptResult = await resolveDepartmentRef(env, input.department)
  if (!deptResult.ok) {
    return { ok: false, error: deptResult.reason === 'ambiguous' ? 'ambiguous_department' : 'department_not_found' }
  }
  const departmentId = deptResult.value.id

  // Validate every human BEFORE any write — a bad email/capability in the
  // list must not leave the project/squad half-provisioned.
  const humans = input.humans ?? []
  for (const h of humans) {
    if (!isNonEmptyString(h.email) || !EMAIL_RE.test(h.email.trim())) return { ok: false, error: 'invalid_human_email' }
    if (h.capability !== 'observer' && h.capability !== 'member') return { ok: false, error: 'invalid_human_capability' }
  }

  const botEnabled = input.bot?.enabled !== false
  if (input.bot?.name !== undefined && !isNonEmptyString(input.bot.name)) {
    return { ok: false, error: 'invalid_bot_name' }
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

  // ── resolve-or-create SQUAD — its own commit, its own entitlement gate ────
  let squad = await findSquadByDepartmentAndSlug(env, departmentId, squadSlug)
  let squadCreated = false
  if (!squad) {
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

  // ── rank ceiling: cannot invite above the caller's own rank on THIS squad ─
  if (humans.length > 0) {
    const actorRank = await actorRankOnScopeFor(env, auth, 'squad', squad.id)
    for (const h of humans) {
      if (capabilityRank(h.capability) > actorRank) {
        return { ok: false, error: 'cannot_invite_above_own_rank', detail: { email: h.email, capability: h.capability } }
      }
    }
  }

  // ── which humans still need a fresh invite (idempotency) ──────────────────
  const inviteRows: TeamBootstrapInvite[] = []
  const invitesToInsert: { id: string; email: string; capability: Capability }[] = []
  for (const h of humans) {
    const email = h.email.trim()
    const existing = await findLiveInvite(env, squad.id, email)
    if (existing) {
      inviteRows.push({ id: existing.id, email, capability: h.capability, created: false })
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

  const existingReceipt = await findReceipt(env, auth.tenant, slugBase)
  const now = new Date().toISOString()

  // ── stage 1: ONE atomic batch — the ADMIN edge + the bot (if any) ─────────
  const structuralStatements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO project_squad_access (project_id, squad_id, access_level, granted_at)
       VALUES (?1, ?2, 'admin', ?3)
       ON CONFLICT(project_id, squad_id) DO UPDATE SET access_level = 'admin'`,
    ).bind(project.id, squad.id, now),
  ]
  if (preparedAgent) {
    structuralStatements.push(preparedAgent.statements[0], preparedAgent.statements[1])
  }

  try {
    const results = await env.DB.batch(structuralStatements)
    assertBatchWritten(results, 'team_bootstrap.structural', 1)
  } catch (err) {
    // Stage 1 failed — the ADMIN edge and/or the bot did not land. Nothing
    // from stage 2 (invites) has run yet. Receipt the failure as its own,
    // separate write (never inside the batch that just rolled back) so a
    // retry — and any operator watching this table — sees it.
    await writeReceiptOutcome(env, {
      existingReceipt,
      tenant: auth.tenant,
      actorMemberId: auth.memberId ?? null,
      slugBase,
      projectId: project.id,
      squadId: squad.id,
      botAgentId: existingAgent?.id ?? null,
      disposition: 'failed',
      invitedCount: existingReceipt?.invited_count ?? 0,
      failedStep: 'edge_or_bot',
      failureReason: classifyWriteFailure(err),
    })
    return { ok: false, error: 'provisioning_failed', detail: { stage: 'edge_or_bot', reason: classifyWriteFailure(err) } }
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
        .bind(invite.id, invite.email, departmentId, squad.id, invite.capability, auth.memberId ?? null, now)
        .run()
      assertWritten(result, 'team_bootstrap.invite_insert', 1)
      insertedInviteCount += 1
    } catch (err) {
      inviteFailure = err
      break
    }
  }

  const totalInvitedCount = (existingReceipt?.invited_count ?? 0) + insertedInviteCount

  if (inviteFailure) {
    await writeReceiptOutcome(env, {
      existingReceipt,
      tenant: auth.tenant,
      actorMemberId: auth.memberId ?? null,
      slugBase,
      projectId: project.id,
      squadId: squad.id,
      botAgentId,
      disposition: 'failed',
      invitedCount: totalInvitedCount,
      failedStep: 'invite_insert',
      failureReason: classifyWriteFailure(inviteFailure),
    })
    return {
      ok: false,
      error: 'provisioning_failed',
      detail: { stage: 'invite_insert', reason: classifyWriteFailure(inviteFailure) },
    }
  }

  // ── stage 3: the success receipt ──────────────────────────────────────────
  const disposition: TeamBootstrapDisposition =
    projectCreated || squadCreated || preparedAgent !== null || invitesToInsert.length > 0 ? 'created' : 'existing'
  const receiptId = await writeReceiptOutcome(env, {
    existingReceipt,
    tenant: auth.tenant,
    actorMemberId: auth.memberId ?? null,
    slugBase,
    projectId: project.id,
    squadId: squad.id,
    botAgentId,
    disposition,
    invitedCount: totalInvitedCount,
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
    project,
    squad,
    bot: botResult,
    invites: inviteRows,
    receipt_id: receiptId,
  }
}
