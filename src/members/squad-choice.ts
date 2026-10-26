// mupot — squad_choose: a connected agent that is still in the LOBBY (its binding squad is a member's
// private home) picks its own working squad, once.
//
// AUTHORITY, in one paragraph. The agent never holds standing of its own here. A squad is a CANDIDATE only
// if the agent's OWNER (a human member, never an agent) holds at least `lead` on it through the owner's
// live grants (resolveCapabilities + canOnSquad: the same predicate every other squad check uses, so a home
// squad, an archived squad and a squad the owner only reaches through nothing are all out). The level the
// agent receives is `member` by default, `observer` on request, and can never exceed what the owner holds on
// that squad. No self-grant, no escalation: the owner's standing is the ceiling.
//
// THE WRITE is the existing move_agent_squad writer (moveAgentSquad, #1433): one D1 batch that re-points
// agents.squad_id, severs the lobby grants, writes the destination grant and an agent_audit row. It is bound to
// the squad the agent was in when this ran, so a concurrent second choice writes nothing.
//
// ONE-TIME. A choice is only possible while the agent's binding squad is a home. After it, the binding is a
// work squad and every later call is refused (`already_placed`), except the exact same squad, which is
// answered idempotently with no second write. Changes after that go through the owner or a squad admin as today.
//
// RANKING. Candidates carry a deterministic suggestion score. `SquadScorer` is the seam for a smarter scorer
// later (Jev / Clef); nothing here calls a model.

import { brandSquadScope, canOnSquad, CAPABILITY_LIVE_PREDICATE, capabilityRank, nowCapabilitySql, resolveCapabilities } from '../auth/capability'
import { attachedAuthority } from '../auth/attached-ceiling'
import { moveAgentSquad } from '../org/service'
import type { AuthContext, Capability, Env } from '../types'
import { resolveAgentMemberBinding } from './service'

export const SQUAD_CHOICE_LEVELS = ['observer', 'member'] as const
export type SquadChoiceLevel = (typeof SQUAD_CHOICE_LEVELS)[number]
/** An owner needs at least this on a squad for it to be offered at all. */
export const SQUAD_CHOICE_OWNER_FLOOR: Capability = 'lead'
export const SQUAD_CHOICE_REASON_MAX = 300
const CANDIDATE_LIMIT = 200

export interface ChoiceAgent {
  id: string
  name: string
  squad_id: string
  purpose: string | null
  skills: string | null
  capabilities: string | null
}

export interface SquadFacts {
  id: string
  slug: string
  name: string
  charter: string | null
  projects: string[]
  /** Tasks touched in the last 30 days: a rough activity signal. */
  recent_tasks: number
}

export interface SquadScorer {
  score(agent: ChoiceAgent, squad: SquadFacts): { score: number; matched: string[] }
}

const words = (text: string | null | undefined): Set<string> =>
  new Set((text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3))

/** Deterministic: overlap of the agent's skills / capabilities / purpose words with the squad's name, charter and
 *  project names (weighted), then a small activity tiebreak. Pure; same input, same score. */
export const deterministicScorer: SquadScorer = {
  score(agent, squad) {
    const mine = new Set([...words(agent.skills), ...words(agent.capabilities), ...words(agent.purpose)])
    const theirs = new Set([...words(squad.name), ...words(squad.slug), ...words(squad.charter), ...squad.projects.flatMap((p) => [...words(p)])])
    const matched = [...mine].filter((w) => theirs.has(w)).sort()
    return { score: matched.length * 10 + Math.min(squad.recent_tasks, 9), matched }
  },
}

export interface SquadCandidate {
  squad_id: string
  slug: string
  name: string
  reason: { purpose: string | null; active_projects: string[]; matching_skills: string[]; recent_tasks: number }
  score: number
}

export type ChoiceContext =
  | { ok: true; agent: ChoiceAgent; ownerMemberId: string; agentMemberId: string; inLobby: boolean }
  | { ok: false; error: SquadChoiceError }

export type SquadChoiceError =
  | 'agent_session_required'
  | 'attached_session_forbidden'
  | 'agent_not_found'
  | 'agent_inactive'
  | 'agent_identity_unminted'
  | 'owner_unknown'
  | 'already_placed'
  | 'squad_not_a_candidate'
  | 'invalid_squad'
  | 'invalid_level'
  | 'invalid_reason'
  | 'standing_lost'
  | 'choice_refused'

/** The human whose standing bounds the choice: agents.owner_member_id, else the ONE human holding a direct
 *  admin-or-better grant on the agent's home squad (the member whose lobby it is). Anything ambiguous is no owner. */
export async function resolveChoiceOwner(env: Env, agent: ChoiceAgent): Promise<string | null> {
  const row = await env.DB.prepare('SELECT owner_member_id FROM agents WHERE id = ?1').bind(agent.id).first<{ owner_member_id: string | null }>()
  const declared = row?.owner_member_id?.trim()
  const candidates: string[] = []
  if (declared) {
    candidates.push(declared)
  } else {
    const rows = await env.DB.prepare(
      `SELECT DISTINCT c.member_id AS id FROM capabilities c
         JOIN squads s ON s.id = c.scope_id AND s.kind = 'home'
        WHERE c.scope_type = 'squad' AND c.scope_id = ?1 AND c.capability IN ('admin', 'owner')
          AND ${CAPABILITY_LIVE_PREDICATE('c', '?2')}
          AND NOT EXISTS (SELECT 1 FROM agent_member_bindings b WHERE b.member_id = c.member_id)`,
    ).bind(agent.squad_id, nowCapabilitySql()).all<{ id: string }>()
    for (const r of rows.results ?? []) candidates.push(r.id)
    if (candidates.length !== 1) return null
  }
  const id = candidates[0]!
  const human = await env.DB.prepare(
    `SELECT m.id FROM members m WHERE m.id = ?1 AND m.tenant = ?2 AND m.status = 'active' AND m.archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM agent_member_bindings b WHERE b.member_id = m.id)`,
  ).bind(id, env.TENANT_SLUG).first<{ id: string }>()
  return human?.id ?? null
}

export async function loadChoiceContext(env: Env, auth: AuthContext): Promise<ChoiceContext> {
  // Server-derived identity only: the agent is the one this credential is bound to. Attached chats and seat
  // handles act FOR an agent without being it, so they never place it.
  if (!auth.boundAgentId) return { ok: false, error: 'agent_session_required' }
  if (attachedAuthority(auth) || auth.seatBinding) return { ok: false, error: 'attached_session_forbidden' }
  const agent = await env.DB.prepare(
    'SELECT id, name, squad_id, purpose, skills, capabilities, status FROM agents WHERE id = ?1',
  ).bind(auth.boundAgentId).first<ChoiceAgent & { status: string }>()
  if (!agent) return { ok: false, error: 'agent_not_found' }
  if (agent.status !== 'active') return { ok: false, error: 'agent_inactive' }
  const binding = await resolveAgentMemberBinding(env, agent.id)
  if (binding.kind !== 'bound') return { ok: false, error: 'agent_identity_unminted' }
  const home = await env.DB.prepare('SELECT kind FROM squads WHERE id = ?1').bind(agent.squad_id).first<{ kind: string }>()
  const inLobby = home?.kind === 'home'
  const ownerMemberId = await resolveChoiceOwner(env, agent)
  if (!ownerMemberId) return { ok: false, error: 'owner_unknown' }
  return { ok: true, agent, ownerMemberId, agentMemberId: binding.memberId, inLobby }
}

interface SquadRow { id: string; department_id: string; slug: string; name: string; charter: string | null }

/** Candidate squads for this agent, best suggestion first. Empty unless the agent is in the lobby. */
export async function listSquadCandidates(
  env: Env,
  ctx: Extract<ChoiceContext, { ok: true }>,
  scorer: SquadScorer = deterministicScorer,
): Promise<SquadCandidate[]> {
  if (!ctx.inLobby) return []
  const grants = await resolveCapabilities(env, ctx.ownerMemberId)
  const squads = await env.DB.prepare(
    `SELECT id, department_id, slug, name, charter FROM squads
      WHERE kind = 'work' AND status = 'active' AND id <> ?1 ORDER BY name LIMIT ${CANDIDATE_LIMIT}`,
  ).bind(ctx.agent.squad_id).all<SquadRow>()
  const out: SquadCandidate[] = []
  for (const sq of squads.results ?? []) {
    const scope = brandSquadScope({ id: sq.id, department_id: sq.department_id, kind: 'work' })
    if (!(await canOnSquad(env, grants, scope, SQUAD_CHOICE_OWNER_FLOOR))) continue
    const [projects, activity] = await Promise.all([
      env.DB.prepare(
        `SELECT p.name FROM project_squad_access a JOIN projects p ON p.id = a.project_id
          WHERE a.squad_id = ?1 AND p.status = 'active' ORDER BY p.name LIMIT 5`,
      ).bind(sq.id).all<{ name: string }>(),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE squad_id = ?1 AND updated_at >= datetime('now', '-30 days')`)
        .bind(sq.id).first<{ n: number }>(),
    ])
    const facts: SquadFacts = {
      id: sq.id, slug: sq.slug, name: sq.name, charter: sq.charter,
      projects: (projects.results ?? []).map((p) => p.name),
      recent_tasks: Number(activity?.n ?? 0),
    }
    const { score, matched } = scorer.score(ctx.agent, facts)
    out.push({
      squad_id: sq.id, slug: sq.slug, name: sq.name, score,
      reason: { purpose: sq.charter, active_projects: facts.projects, matching_skills: matched, recent_tasks: facts.recent_tasks },
    })
  }
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
}

export type ChooseSquadResult =
  | { ok: true; already: boolean; squad: { id: string; slug: string; name: string }; level: SquadChoiceLevel; audit_id: string | null }
  | { ok: false; error: SquadChoiceError }

export async function chooseSquad(
  env: Env,
  auth: AuthContext,
  input: { squadId: unknown; level?: unknown; reason?: unknown },
): Promise<ChooseSquadResult> {
  const ctx = await loadChoiceContext(env, auth)
  if (!ctx.ok) return ctx
  if (typeof input.squadId !== 'string' || input.squadId.trim() === '') return { ok: false, error: 'invalid_squad' }
  const squadId = input.squadId.trim()
  const level = input.level === undefined || input.level === null ? 'member' : input.level
  if (typeof level !== 'string' || !(SQUAD_CHOICE_LEVELS as readonly string[]).includes(level)) return { ok: false, error: 'invalid_level' }
  const reasonRaw = input.reason === undefined || input.reason === null ? '' : input.reason
  if (typeof reasonRaw !== 'string' || reasonRaw.length > SQUAD_CHOICE_REASON_MAX) return { ok: false, error: 'invalid_reason' }

  // Idempotent: already sitting in exactly this (work) squad. Nothing is written or re-granted.
  if (!ctx.inLobby) {
    if (ctx.agent.squad_id === squadId) {
      const sq = await env.DB.prepare('SELECT id, slug, name FROM squads WHERE id = ?1').bind(squadId).first<{ id: string; slug: string; name: string }>()
      if (sq) return { ok: true, already: true, squad: sq, level: level as SquadChoiceLevel, audit_id: null }
    }
    return { ok: false, error: 'already_placed' }
  }

  const candidates = await listSquadCandidates(env, ctx)
  const chosen = candidates.find((c) => c.squad_id === squadId)
  if (!chosen) return { ok: false, error: 'squad_not_a_candidate' }

  // Re-derive the owner's standing NOW, at the write, and cap the level by it (never above what the owner holds).
  const grants = await resolveCapabilities(env, ctx.ownerMemberId)
  const row = await env.DB.prepare('SELECT department_id FROM squads WHERE id = ?1').bind(squadId).first<{ department_id: string }>()
  if (!row) return { ok: false, error: 'invalid_squad' }
  const scope = brandSquadScope({ id: squadId, department_id: row.department_id, kind: 'work' })
  if (!(await canOnSquad(env, grants, scope, SQUAD_CHOICE_OWNER_FLOOR)) || !(await canOnSquad(env, grants, scope, level as Capability))) {
    return { ok: false, error: 'standing_lost' }
  }
  if (capabilityRank(level as Capability) > capabilityRank('member')) return { ok: false, error: 'invalid_level' }

  const moved = await moveAgentSquad(env, {
    agentId: ctx.agent.id,
    fromSquadId: ctx.agent.squad_id,
    toSquadId: squadId,
    memberId: ctx.agentMemberId,
    capability: level as SquadChoiceLevel,
    actor: { id: ctx.agentMemberId, type: 'agent' },
    reason: `squad_choose by agent under owner ${ctx.ownerMemberId}${reasonRaw.trim() ? `: ${reasonRaw.trim()}` : ''}`,
  })
  if (!moved.ok) return { ok: false, error: moved.error === 'source_squad_changed' ? 'already_placed' : 'choice_refused' }
  return { ok: true, already: false, squad: { id: chosen.squad_id, slug: chosen.slug, name: chosen.name }, level: level as SquadChoiceLevel, audit_id: moved.auditId }
}

/** What boot_context / seat_select show an agent that is still in the lobby. null = nothing to choose. */
export async function squadChoiceStep(env: Env, auth: AuthContext): Promise<Record<string, unknown> | null> {
  const ctx = await loadChoiceContext(env, auth)
  if (!ctx.ok || !ctx.inLobby) return null
  const candidates = await listSquadCandidates(env, ctx)
  if (candidates.length === 0) return null
  return {
    choose_squad: true,
    tool: 'squad_choose',
    why: 'You are in your owner\'s private home squad (the lobby). Pick the squad you will work in; this is a one-time choice bounded by your owner\'s standing. Until you choose, you stay here.',
    candidates: candidates.slice(0, 10),
  }
}
