// mupot — seed apply. Turns a validated mupot.seed/v1 into the smallest durable footprint:
// project, squad, squad<->project ADMIN edge (all via the existing team_bootstrap core), the seat CAP,
// one project_seeds row and one audit receipt. It GRANTS NOTHING: every request in the seed stays a
// recorded 'pending_human' request. Contract: docs/architecture/seed-v1.md.
//
// SAFETY MODEL
//  - Insert-first idempotency: the project_seeds row (UNIQUE tenant+project_slug) is inserted BEFORE
//    anything is created. A racing or repeated apply hits the UNIQUE key and creates nothing.
//  - The INSERT itself carries the no-takeover guard (an existing project of that slug that this caller
//    did not create blocks the claim), so there is no read-then-insert window.
//  - Only the canonical form is stored, never the raw source. `owner` is a label, never resolved.
//  - A conflicting project of that slug is refused with ONE generic body: no id, name or creator.
//  - The status flip and the receipt run in one batch; the receipt is keyed (UNIQUE) per seed row.

import type { AuthContext, Env } from '../types'
import { readAccess, readableProject } from '../mcp/projects'
import { teamBootstrap, isValidSlugBase } from '../org/team-bootstrap'
import { resolveProjectSquadDepartmentId, PROJECT_SQUAD_DEPARTMENT_SLUG } from '../projects/start-gate'
import type { SeedRequest, SeedV1 } from './contract'
import { requestKey } from './canonical'
import { verifyAcceptToken } from './accept-token'

export const SEED_PROJECT_SLUG_SUFFIX = '-prj'
const LEASE_MS = 120_000

// The no-takeover predicate, shared by the claim INSERT and the resume UPDATE: true only when no project
// `<slug>-prj` and no squad `<slug>-sqd` (in the shared projects department) exists that the caller did not
// create. NULL provenance and home squads count as "not theirs".
const noTakeoverSql = (slugP: string, callerP: string, squadSlugP: string, deptSlugP: string): string =>
  `NOT EXISTS (SELECT 1 FROM projects p WHERE p.slug = ${slugP}
        AND (p.created_by_member_id IS NULL OR p.created_by_member_id <> ${callerP}))
   AND NOT EXISTS (SELECT 1 FROM squads q WHERE q.slug = ${squadSlugP}
        AND q.department_id IN (SELECT id FROM departments WHERE slug = ${deptSlugP})
        AND (q.kind = 'home' OR q.created_by_member_id IS NULL OR q.created_by_member_id <> ${callerP}))`
const MAX_ACCEPT = 400
const ACCEPT_KEY_MAX = 80

export interface KeyedSeedRequest extends SeedRequest { key: string }

export async function keyRequests(requests: SeedRequest[]): Promise<KeyedSeedRequest[]> {
  return Promise.all(requests.map(async (r) => ({ ...r, key: await requestKey(r) })))
}

export interface ValidatedSeed {
  seed: SeedV1
  canonical: string
  seedSha256: string
  requests: KeyedSeedRequest[]
}

export type SeedApplyOutcome =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; status: 400 | 403 | 409 | 503; error: string; detail?: unknown }

// ONE body for every refusal the caller is not entitled to explain.
const UNAVAILABLE: SeedApplyOutcome = {
  ok: false, status: 409, error: 'seed_slug_unavailable',
  detail: { message: 'this seed cannot be applied to this pot as submitted' },
}

// An apply that may still fail is never success-shaped.
const IN_PROGRESS: SeedApplyOutcome = {
  ok: false, status: 409, error: 'seed_apply_in_progress',
  detail: { message: 'an apply of this seed is in progress; retry shortly' },
}

export const seedProjectSlug = (slug: string): string => `${slug}${SEED_PROJECT_SLUG_SUFFIX}`

interface SeedRow {
  id: string
  project_id: string | null
  squad_id: string | null
  seed_sha256: string
  applied_by_member_id: string
  status: 'applying' | 'applied'
  lease_expires_at: string | null
  seat_cap: number | null
}

const SEED_COLUMNS = 'id, project_id, squad_id, seed_sha256, applied_by_member_id, status, lease_expires_at, seat_cap'

function parseAccept(raw: unknown): { ok: true; keys: string[] } | { ok: false; outcome: SeedApplyOutcome } {
  const bad = (message: string): { ok: false; outcome: SeedApplyOutcome } =>
    ({ ok: false, outcome: { ok: false, status: 400, error: 'invalid_args', detail: message } })
  if (!Array.isArray(raw)) return bad('accept must be an array of request keys from the dry run (use [] for a seed with no requests)')
  if (raw.length > MAX_ACCEPT) return bad('accept is too long')
  const keys: string[] = []
  for (const k of raw) {
    if (typeof k !== 'string' || k.length === 0 || k.length > ACCEPT_KEY_MAX) return bad('accept entries must be non-empty strings')
    keys.push(k.trim())
  }
  return { ok: true, keys }
}

async function callerCanSee(env: Env, auth: AuthContext, row: SeedRow, caller: string): Promise<boolean> {
  if (row.applied_by_member_id === caller) return true
  if (!row.project_id) return false
  return (await readableProject(env, row.project_id, readAccess(auth))) !== null
}

function replayResult(v: ValidatedSeed, row: SeedRow): SeedApplyOutcome {
  return {
    ok: true,
    result: {
      ok: true, dry_run: false, replay: true, status: row.status, seed_sha256: v.seedSha256,
      project_id: row.project_id, squad_id: row.squad_id, seat_cap: row.seat_cap,
    },
  }
}

async function releaseClaim(env: Env, rowId: string, token: string, projectSlug: string): Promise<void> {
  // Nothing of ours exists -> drop the claim so another digest can use the slug; otherwise expire the
  // lease so the same member can resume at once.
  const dropped = await env.DB.prepare(
    `DELETE FROM project_seeds WHERE id = ?1 AND status = 'applying' AND lease_token = ?2
        AND NOT EXISTS (SELECT 1 FROM projects WHERE slug = ?3)`,
  ).bind(rowId, token, projectSlug).run()
  if (dropped.meta.changes === 1) return
  await env.DB.prepare(
    `UPDATE project_seeds SET lease_expires_at = ?3 WHERE id = ?1 AND status = 'applying' AND lease_token = ?2`,
  ).bind(rowId, token, new Date(0).toISOString()).run()
}

export async function applySeed(env: Env, auth: AuthContext, caller: string, v: ValidatedSeed, acceptRaw: unknown, acceptToken: unknown): Promise<SeedApplyOutcome> {
  const slug = v.seed.slug
  if (!isValidSlugBase(slug)) {
    return { ok: false, status: 400, error: 'seed_slug_not_applicable',
      detail: 'slug must be at most 44 characters and must not end in -prj, -sqd or -bot to be applied' }
  }
  const parsed = parseAccept(acceptRaw)
  if (!parsed.ok) return parsed.outcome
  const tokenCheck = await verifyAcceptToken(env, caller, v.seedSha256, acceptToken)
  if (tokenCheck === 'unavailable') return { ok: false, status: 503, error: 'accept_token_unavailable', detail: 'this pot has no server secret configured for accept tokens' }
  if (tokenCheck === 'invalid') {
    return { ok: false, status: 409, error: 'accept_token_invalid', detail: 'accept_token must come from a dry run of this exact seed by this member in the last 15 minutes' }
  }
  const accepted = new Set(parsed.keys)
  const known = new Set(v.requests.map((r) => r.key))
  if ([...accepted].some((k) => !known.has(k))) {
    return { ok: false, status: 400, error: 'unknown_accept_keys', detail: 'accept lists a key this seed does not produce; re-run the dry run' }
  }
  const missing = v.requests.filter((r) => !accepted.has(r.key)).map((r) => ({ key: r.key, kind: r.kind }))
  if (missing.length > 0) return { ok: false, status: 409, error: 'requests_not_accepted', detail: { missing } }

  const tenant = env.TENANT_SLUG
  const projectSlug = seedProjectSlug(slug)
  const rowId = crypto.randomUUID()
  let token = crypto.randomUUID()
  const nowIso = new Date().toISOString()
  const seatCap = v.seed.wants?.seats?.max ?? null
  const requestsJson = JSON.stringify(v.requests.map((r) => ({ key: r.key, kind: r.kind, fields: r.fields, status: 'pending_human' })))

  // INSERT FIRST. The WHERE blocks the claim when a project of that slug exists that this caller did
  // not create, or when a squad `<slug>-sqd` exists in the shared projects department that this caller
  // did not create (NULL provenance and home squads count as "not theirs"): refusing HERE keeps a
  // refusal from reaching team_bootstrap, which would write a failed receipt. ON CONFLICT hands a
  // repeat to the UNIQUE key.
  const squadSlug = `${slug}-sqd`
  const tryClaim = async (): Promise<boolean> => {
    const r = await env.DB.prepare(
      `INSERT INTO project_seeds
         (id, tenant, project_slug, seed_sha256, canonical_json, requests_json, owner_label, seat_cap,
          applied_by_member_id, applied_at, status, lease_token, lease_expires_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'applying', ?11, ?12
        WHERE ${noTakeoverSql('?3', '?9', '?13', '?14')}
       ON CONFLICT (tenant, project_slug) DO NOTHING`,
    ).bind(
      rowId, tenant, projectSlug, v.seedSha256, v.canonical, requestsJson, v.seed.owner, seatCap,
      caller, nowIso, token, new Date(Date.now() + LEASE_MS).toISOString(), squadSlug, PROJECT_SQUAD_DEPARTMENT_SLUG,
    ).run()
    return r.meta.changes === 1
  }
  const loadRow = () =>
    env.DB.prepare(`SELECT ${SEED_COLUMNS} FROM project_seeds WHERE tenant = ?1 AND project_slug = ?2`)
      .bind(tenant, projectSlug).first<SeedRow>()

  let claimedRowId = rowId
  let claimed = await tryClaim()
  if (!claimed) {
    let row = await loadRow()
    // A crashed apply leaves an 'applying' claim behind. Once its lease has lapsed AND no project of that
    // slug exists, nothing was created under it: delete the stale claim (one conditional statement, never a
    // live lease, never a row whose project exists) and claim once more.
    if (row && row.status === 'applying' && row.lease_expires_at !== null && row.lease_expires_at <= new Date().toISOString()) {
      const swept = await env.DB.prepare(
        `DELETE FROM project_seeds WHERE id = ?1 AND status = 'applying' AND lease_expires_at <= ?2
            AND NOT EXISTS (SELECT 1 FROM projects WHERE slug = ?3)`,
      ).bind(row.id, new Date().toISOString(), projectSlug).run()
      if (swept.meta.changes === 1) {
        claimed = await tryClaim()
        if (!claimed) row = await loadRow()
      }
    }
    if (claimed) {
      // swept the stale claim and claimed anew: fall through to the create phase
    } else if (!row) {
      // The guard refused: a project or squad of that name exists and is not this caller's. ONE generic
      // body, whoever the caller is: no id, name, creator or readability signal (the dry run's `diffs`
      // is the place a caller who CAN read that project learns about it).
      return UNAVAILABLE
    } else {
      if (!(await callerCanSee(env, auth, row, caller))) return UNAVAILABLE
      if (row.seed_sha256 !== v.seedSha256) {
        return { ok: false, status: 409, error: 'seed_digest_conflict',
          detail: { existing_seed_sha256: row.seed_sha256, submitted_seed_sha256: v.seedSha256 } }
      }
      if (row.status === 'applied') return replayResult(v, row)
      // Same digest, still 'applying' (a project exists, or the lease is live). Only the member who
      // started it may resume, and only once the lease lapsed. The owner check is defence in depth:
      // callerCanSee above already refuses other members while project_id is NULL.
      const expired = row.lease_expires_at === null || row.lease_expires_at <= new Date().toISOString()
      if (!(expired && row.applied_by_member_id === caller)) return IN_PROGRESS
      token = crypto.randomUUID()
      const resumed = await env.DB.prepare(
        `UPDATE project_seeds SET lease_token = ?2, lease_expires_at = ?3
          WHERE id = ?1 AND status = 'applying' AND applied_by_member_id = ?4
            AND (lease_expires_at IS NULL OR lease_expires_at <= ?5)
            AND ${noTakeoverSql('?6', '?4', '?7', '?8')}`,
      ).bind(row.id, token, new Date(Date.now() + LEASE_MS).toISOString(), caller, new Date().toISOString(),
        projectSlug, squadSlug, PROJECT_SQUAD_DEPARTMENT_SLUG).run()
      if (resumed.meta.changes !== 1) {
        // The resume is itself guarded: a foreign project or squad appeared under that name since the claim.
        const clear = await env.DB.prepare(`SELECT 1 AS ok WHERE ${noTakeoverSql('?1', '?2', '?3', '?4')}`)
          .bind(projectSlug, caller, squadSlug, PROJECT_SQUAD_DEPARTMENT_SLUG).first()
        return clear ? IN_PROGRESS : UNAVAILABLE
      }
      claimedRowId = row.id
    }
  }

  try {
    // ── create phase: every create goes through the existing team_bootstrap core ──────────────────
    const departmentId = await resolveProjectSquadDepartmentId(env, caller)
    if (!departmentId) {
      await releaseClaim(env, claimedRowId, token, projectSlug)
      return { ok: false, status: 409, error: 'seed_apply_failed', detail: { reason: 'department_unavailable' } }
    }
    // Prefixed with the slug so a seed cannot name its squad to look like an existing one (e.g. squad-core).
    const squadName = `${slug}: ${v.seed.wants?.seats?.squad ?? 'core'}`
    const boot = await teamBootstrap(env, auth, {
      slug_base: slug, name: v.seed.name, department: departmentId, squad_name: squadName,
      bot: { enabled: false }, humans: [], adopt: false, require_provenance: true,
    })
    if (!boot.ok) {
      await releaseClaim(env, claimedRowId, token, projectSlug)
      if (boot.error === 'project_slug_taken' || boot.error === 'squad_slug_taken' || boot.error === 'cannot_adopt_home_squad') return UNAVAILABLE
      return { ok: false, status: 409, error: 'seed_apply_failed', detail: { reason: boot.error } }
    }

    // ── flip + receipt in ONE batch; the receipt is written only when this call won the flip ──────
    const projectId = boot.project.project.id
    const squadId = boot.squad.squad.id
    const appliedAt = new Date().toISOString()
    const evidence = JSON.stringify({
      seed_sha256: v.seedSha256, accepted_keys: [...accepted].sort(), project_slug: projectSlug,
      squad_id: squadId, seat_cap: seatCap, grants: 'none',
    })
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE project_seeds SET status = 'applied', project_id = ?2, squad_id = ?3, applied_at = ?4,
                lease_token = NULL, lease_expires_at = NULL
          WHERE id = ?1 AND status = 'applying' AND lease_token = ?5`,
      ).bind(claimedRowId, projectId, squadId, appliedAt, token),
      env.DB.prepare(
        `INSERT INTO mutation_audit_entries (
           id, tenant, principal_kind, principal_id, member_id, origin, handler, operation,
           target_kind, target_id, request_id, idempotency_key, evidence_json, recorded_at)
         SELECT ?1, ?2, 'member', ?3, ?3, 'mcp', 'seed_attach', 'apply', 'project', ?4, ?5, ?6, ?7, ?8
          WHERE changes() = 1
         ON CONFLICT DO NOTHING`,
      ).bind(crypto.randomUUID(), tenant, caller, projectId, `seed-apply:${claimedRowId}`, v.seedSha256, evidence, appliedAt),
    ])
    const final = await env.DB.prepare(`SELECT ${SEED_COLUMNS} FROM project_seeds WHERE id = ?1`).bind(claimedRowId).first<SeedRow>()
    if (!final || final.status !== 'applied') {
      return { ok: false, status: 409, error: 'seed_apply_failed', detail: { reason: 'claim_lost' } }
    }
    return {
      ok: true,
      result: {
        ok: true, dry_run: false, replay: false, status: 'applied', seed_sha256: v.seedSha256,
        project: { id: projectId, slug: boot.project.project.slug, created: boot.project.created },
        squad: { id: squadId, slug: boot.squad.squad.slug, created: boot.squad.created },
        seat_cap: seatCap, grants: 'none',
        requests: v.requests.map((r) => ({ key: r.key, kind: r.kind, status: 'pending_human' })),
      },
    }
  } catch (err) {
    // Any uncaught failure after the claim: never leave the slug reserved. Releases only when nothing was
    // created; otherwise the lease is expired so the same member can resume.
    try { await releaseClaim(env, claimedRowId, token, projectSlug) } catch { /* release is best effort */ }
    return { ok: false, status: 409, error: 'seed_apply_failed', detail: { reason: 'internal_error' } }
  }
}
