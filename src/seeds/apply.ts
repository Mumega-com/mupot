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
import { requestKey, canonicalText } from './canonical'
import { verifyAcceptToken } from './accept-token'

export const SEED_PROJECT_SLUG_SUFFIX = '-prj'
const LEASE_MS = 120_000

// The no-takeover predicate, shared by the claim INSERT and the resume UPDATE: true only when no project
// `<slug>-prj` and no squad `<slug>-sqd` (in the shared projects department) exists that the caller did not
// create, or that is archived. NULL provenance and home squads count as "not theirs".
const noTakeoverSql = (slugP: string, callerP: string, squadSlugP: string, deptSlugP: string): string =>
  `NOT EXISTS (SELECT 1 FROM projects p WHERE p.slug = ${slugP}
        AND (p.created_by_member_id IS NULL OR p.created_by_member_id <> ${callerP} OR p.status = 'archived'))
   AND NOT EXISTS (SELECT 1 FROM squads q WHERE q.slug = ${squadSlugP}
        AND q.department_id IN (SELECT id FROM departments WHERE slug = ${deptSlugP})
        AND (q.kind = 'home' OR q.status = 'archived' OR q.created_by_member_id IS NULL OR q.created_by_member_id <> ${callerP}))`
const MAX_ACCEPT = 400
const ACCEPT_KEY_MAX = 80

export interface KeyedSeedRequest extends SeedRequest { key: string }

// Every displayed request gets a DISTINCT key. A repeat of an identical request (same kind and fields,
// e.g. a `path` and a `type` direct surface naming the same target) gets a `#n` occurrence suffix, so
// accepting one can never stand for both. The first occurrence keeps the plain key (stable for
// seeds with no repeats).
export async function keyRequests(requests: SeedRequest[]): Promise<KeyedSeedRequest[]> {
  const seen = new Map<string, number>()
  const out: KeyedSeedRequest[] = []
  for (const r of requests) {
    const base = await requestKey(r)
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    out.push({ ...r, key: n === 1 ? base : `${base}#${n}` })
  }
  return out
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

async function releaseClaim(env: Env, rowId: string, token: string, projectSlug: string, caller: string): Promise<void> {
  // Decided by provenance: if no project of that slug was created by THIS caller, nothing of ours exists
  // (a foreign project is not ours) -> drop the claim so the slug is not reserved; otherwise expire the
  // lease so the same member can resume at once.
  const dropped = await env.DB.prepare(
    `DELETE FROM project_seeds WHERE id = ?1 AND status = 'applying' AND lease_token = ?2
        AND NOT EXISTS (SELECT 1 FROM projects WHERE slug = ?3 AND created_by_member_id = ?4)`,
  ).bind(rowId, token, projectSlug, caller).run()
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
  // EVERYTHING persisted or passed on is built from the CANONICAL seed (NFC, trailing whitespace trimmed),
  // never from the raw validated strings: NFC-equivalent spellings of one seed yield identical rows.
  const cs = JSON.parse(v.canonical) as SeedV1 // as: v.canonical is canonicalSeedJson of the validated seed
  const seatCap = cs.wants?.seats?.max ?? null
  const canonFields = (f: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(f).map(([k, x]) => [k, canonicalText(x)]))
  const requestsJson = JSON.stringify(v.requests.map((r) => ({ key: r.key, kind: r.kind, fields: canonFields(r.fields), status: 'pending_human' })))

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
      rowId, tenant, projectSlug, v.seedSha256, v.canonical, requestsJson, cs.owner, seatCap,
      caller, nowIso, token, new Date(Date.now() + LEASE_MS).toISOString(), squadSlug, PROJECT_SQUAD_DEPARTMENT_SLUG,
    ).run()
    return r.meta.changes === 1
  }
  const loadRow = () =>
    env.DB.prepare(`SELECT ${SEED_COLUMNS} FROM project_seeds WHERE tenant = ?1 AND project_slug = ?2`)
      .bind(tenant, projectSlug).first<SeedRow>()

  let claimedRowId = rowId
  let tookOver = false
  let claimed = await tryClaim()
  if (!claimed) {
    let row = await loadRow()
    // A crashed apply leaves an 'applying' claim behind. Once its lease has lapsed AND no project of that
    // slug exists, nothing was created under it: delete the stale claim (one conditional statement, never a
    // live lease, never a row whose project exists) and claim once more. The DELETE's own predicate
    // (status, lapsed lease, no project) is the only gate.
    if (row && row.status === 'applying') {
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
      // RECOVERY: a claim another member left 'applying' whose lease lapsed, while the project of that slug
      // was created by THIS caller (the split a stalled apply can leave: project under A, row under B).
      // The caller takes the row over in one conditional statement and resumes; nothing is created twice.
      if (row.status === 'applying' && row.applied_by_member_id !== caller) {
        const takeoverToken = crypto.randomUUID()
        const took = await env.DB.prepare(
          `UPDATE project_seeds SET applied_by_member_id = ?4, seed_sha256 = ?5, canonical_json = ?6,
                  requests_json = ?7, owner_label = ?8, seat_cap = ?9, lease_token = ?2, lease_expires_at = ?3
            WHERE id = ?1 AND status = 'applying' AND lease_expires_at <= ?10
              AND EXISTS (SELECT 1 FROM projects p WHERE p.slug = ?11 AND p.created_by_member_id = ?4)
              AND ${noTakeoverSql('?11', '?4', '?12', '?13')}`,
        ).bind(row.id, takeoverToken, new Date(Date.now() + LEASE_MS).toISOString(), caller, v.seedSha256, v.canonical,
          requestsJson, cs.owner, seatCap, new Date().toISOString(), projectSlug, squadSlug, PROJECT_SQUAD_DEPARTMENT_SLUG).run()
        if (took.meta.changes === 1) {
          token = takeoverToken
          claimedRowId = row.id
          tookOver = true
        }
      }
      if (!tookOver && !(await callerCanSee(env, auth, row, caller))) return UNAVAILABLE
      if (!tookOver && row.seed_sha256 !== v.seedSha256) {
        return { ok: false, status: 409, error: 'seed_digest_conflict',
          detail: { existing_seed_sha256: row.seed_sha256, submitted_seed_sha256: v.seedSha256 } }
      }
      if (!tookOver && row.status === 'applied') return replayResult(v, row)
      // Same digest, still 'applying' (a project exists, or the lease is live). Only the member who
      // started it may resume, and only once the lease lapsed. The owner check is defence in depth:
      // callerCanSee above already refuses other members while project_id is NULL.
      const expired = row.lease_expires_at === null || row.lease_expires_at <= new Date().toISOString()
      if (!tookOver && !(expired && row.applied_by_member_id === caller)) return IN_PROGRESS
      if (!tookOver) {
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
  }

  try {
    // ── create phase: every create goes through the existing team_bootstrap core ──────────────────
    // READ-ONLY pre-check, before team_bootstrap can commit anything (its `adopted` receipt would let any
    // admin's team_bootstrap adopt this project later): when the caller already owns BOTH the project and the
    // squad and the edge between them is below ADMIN, refuse now. The post-call check below stays as defence.
    const weak = await env.DB.prepare(
      `SELECT a.access_level AS level FROM project_squad_access a
         JOIN projects p ON p.id = a.project_id AND p.slug = ?1 AND p.created_by_member_id = ?2
         JOIN squads q ON q.id = a.squad_id AND q.slug = ?3 AND q.created_by_member_id = ?2
         JOIN departments d ON d.id = q.department_id AND d.slug = ?4
        WHERE a.access_level <> 'admin' LIMIT 1`,
    ).bind(projectSlug, caller, squadSlug, PROJECT_SQUAD_DEPARTMENT_SLUG).first<{ level: string }>()
    if (weak) {
      await releaseClaim(env, claimedRowId, token, projectSlug, caller)
      return { ok: false, status: 409, error: 'seed_footprint_incompatible', detail: { existing_edge: weak.level, needs: 'admin' } }
    }
    const departmentId = await resolveProjectSquadDepartmentId(env, caller)
    if (!departmentId) {
      await releaseClaim(env, claimedRowId, token, projectSlug, caller)
      return { ok: false, status: 409, error: 'seed_apply_failed', detail: { reason: 'department_unavailable' } }
    }
    // FENCE: re-assert the claim's lease immediately before creating anything, renewing it. If a sweep
    // deleted or replaced our row while we stalled, abort and create nothing (the other apply owns the slug).
    const fenced = await env.DB.prepare(
      `UPDATE project_seeds SET lease_expires_at = ?3
        WHERE id = ?1 AND lease_token = ?2 AND status = 'applying' AND lease_expires_at > ?4`,
    ).bind(claimedRowId, token, new Date(Date.now() + LEASE_MS).toISOString(), new Date().toISOString()).run()
    if (fenced.meta.changes !== 1) return IN_PROGRESS
    // Prefixed with the slug so a seed cannot name its squad to look like an existing one (e.g. squad-core).
    const squadName = `${slug}: ${cs.wants?.seats?.squad ?? 'core'}`
    const boot = await teamBootstrap(env, auth, {
      slug_base: slug, name: cs.name, department: departmentId, squad_name: squadName,
      bot: { enabled: false }, humans: [], adopt: false, require_provenance: true,
    })
    if (!boot.ok) {
      await releaseClaim(env, claimedRowId, token, projectSlug, caller)
      if (boot.error === 'project_slug_taken' || boot.error === 'squad_slug_taken' || boot.error === 'cannot_adopt_home_squad') return UNAVAILABLE
      return { ok: false, status: 409, error: 'seed_apply_failed', detail: { reason: boot.error } }
    }

    // A pre-existing project<->squad edge below ADMIN (team_bootstrap never raises one) means this apply
    // cannot deliver its footprint: refuse, keep the claim resumable, never finalize as applied.
    if (boot.edge_kept !== null) {
      await releaseClaim(env, claimedRowId, token, projectSlug, caller)
      return { ok: false, status: 409, error: 'seed_footprint_incompatible', detail: { existing_edge: boot.edge_kept, needs: 'admin' } }
    }

    // ── flip + receipt in ONE batch; the receipt is written only when this call won the flip ──────
    const projectId = boot.project.project.id
    const squadId = boot.squad.squad.id
    const appliedAt = new Date().toISOString()
    const evidence = JSON.stringify({
      seed_sha256: v.seedSha256, accepted_keys: [...accepted].sort(), project_slug: projectSlug,
      squad_id: squadId, seat_cap: seatCap, grants: 'none',
    })
    const flip = await env.DB.batch([
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
    // The guarded UPDATE is the only proof this call won. 0 rows = fenced out (a resume or sweep replaced
    // our claim): never present as the winner, whatever a later read of the row shows.
    if (flip[0].meta.changes !== 1) return IN_PROGRESS
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
    try { await releaseClaim(env, claimedRowId, token, projectSlug, caller) } catch { /* release is best effort */ }
    return { ok: false, status: 409, error: 'seed_apply_failed', detail: { reason: 'internal_error' } }
  }
}
