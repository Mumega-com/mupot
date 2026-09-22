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
// row (migration 0163). The bot's credential claim and the optional
// project_remember seed are NOT written here — see the doc comment below on
// why, and src/mcp/team-bootstrap.ts for where they happen.
//
// ATOMICITY — ONE D1 BATCH WHERE POSSIBLE, same doctrine as
// createHomeForMember (src/org/service.ts): department/project/squad
// resolution happens BEFORE the batch (each is its OWN independently
// committing, entitlement-gated create — createProject/createSquad already
// own that discipline and this function does not fork it), and everything
// that is a plain row write with no side channel of its own — the ADMIN
// edge, the bot agent + its home membership row, the human invites, and the
// receipt — lands in exactly ONE env.DB.batch() call: either all of them
// land or none do. Two things are deliberately NOT in that batch because
// they are not D1 writes at all and each already owns its own atomic unit:
// mintAgentBoundToken (members/service.ts — its own D1 writes) and
// createMemory().remember() (D1 + Vectorize, two systems D1.batch() cannot
// span). Both run AFTER this batch commits — see src/mcp/team-bootstrap.ts.
//
// IDEMPOTENT ON slug_base: a second call with the same slug_base finds the
// existing project/squad/bot (reads before every create), sends no duplicate
// invite for an email that already has a live invite into this squad, and
// mints no second bot. The receipt row is UNIQUE(tenant, slug_base) — a
// replay updates invited_count on the SAME row rather than inserting a
// second one.
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
import { assertBatchWritten } from '../lib/receipt'
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
  const disposition: TeamBootstrapDisposition =
    projectCreated || squadCreated || preparedAgent !== null || invitesToInsert.length > 0 ? 'created' : 'existing'

  // ── the ONE atomic batch: edge + bot + invites + receipt, together or not at all ──
  const statements: D1PreparedStatement[] = []
  const now = new Date().toISOString()

  statements.push(
    env.DB.prepare(
      `INSERT INTO project_squad_access (project_id, squad_id, access_level, granted_at)
       VALUES (?1, ?2, 'admin', ?3)
       ON CONFLICT(project_id, squad_id) DO UPDATE SET access_level = 'admin'`,
    ).bind(project.id, squad.id, now),
  )

  if (preparedAgent) {
    statements.push(preparedAgent.statements[0], preparedAgent.statements[1])
  }

  for (const invite of invitesToInsert) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO invites (id, email, department_id, squad_id, capability, invited_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      ).bind(invite.id, invite.email, departmentId, squad.id, invite.capability, auth.memberId ?? null, now),
    )
  }

  const totalInvitedCount = (existingReceipt?.invited_count ?? 0) + invitesToInsert.length
  const receiptId = existingReceipt?.id ?? crypto.randomUUID()
  if (existingReceipt) {
    statements.push(
      env.DB.prepare(`UPDATE team_bootstrap_receipts SET invited_count = ?1 WHERE id = ?2`)
        .bind(totalInvitedCount, receiptId),
    )
  } else {
    statements.push(
      env.DB.prepare(
        `INSERT INTO team_bootstrap_receipts
          (id, tenant, actor_member_id, slug_base, project_id, squad_id, bot_agent_id, disposition, invited_count, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      ).bind(
        receiptId,
        auth.tenant,
        auth.memberId ?? null,
        slugBase,
        project.id,
        squad.id,
        preparedAgent?.agent.id ?? existingAgent?.id ?? null,
        disposition,
        totalInvitedCount,
        now,
      ),
    )
  }

  try {
    const results = await env.DB.batch(statements)
    assertBatchWritten(results, 'team_bootstrap', 1)
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Race: a concurrent identical call won underneath us. D1.batch() is one
      // transaction — nothing from THIS call's batch landed (no partial rows) —
      // so surface a clean failure rather than a mixed result; the caller retries
      // and the idempotent reads above adopt the winner's rows.
      return { ok: false, error: 'provisioning_failed', detail: { stage: 'batch', reason: 'race' } }
    }
    throw err
  }

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
