// mupot — shared org service (department / squad / agent creation).
//
// The single creation path for org-chart rows. Both the JSON API (src/org) and the
// server-rendered dashboard (src/dashboard) call these, so validation + the UNIQUE
// conflict mapping live in ONE place. These functions do NO authz — the caller
// (API route or dashboard handler) gates on the right scope BEFORE calling, using
// the same capability helpers. They return a discriminated result so each surface
// can shape its own response (JSON error vs re-rendered form).

import type { D1PreparedStatement } from '@cloudflare/workers-types'
import type { Env, Department, Squad, Agent, Effort, Autonomy, BudgetWindow, OrgKind, Capability, CapabilityGrant, Membership } from '../types'
import { isEffort, isAutonomy, isBudgetWindow } from '../types'
import { checkCreateLimit } from '../billing/entitlement'
import { assertWritten, assertBatchWritten } from '../lib/receipt'
import { prepareAgentSquadAccess, type AgentAccessCapability } from '../members/agent-access'
// Reused, not duplicated (mupot#1288, Kasra's gate) — src/fleet/boot-self-report.ts's
// bearer-authenticated boot self-report already validates a claimed model against
// this exact shape; update_agent's model/model_fallback fields must accept exactly
// the same values or the two self-report paths silently diverge.
import { MODEL_RE } from '../fleet/boot-self-report'

// ── kind (migration 0093, mupot#925 P0-N1; UNSETTABLE-BY-BODY fix, mupot#925
// P0-N3 / PR #928) ──────────────────────────────────────────────────────────
// 'work' (default) counts against PLAN_LIMITS; 'home' is bootstrap_self's
// per-human identity container and is STRUCTURALLY exempt — the entitlement
// gate below only ever runs when the row being created is kind='work'.
//
// P0-N3: kind used to live on DepartmentInput/SquadInput/AgentInput — the SAME
// shape the three authenticated REST routes (src/org/index.ts) cast an
// unvalidated JSON body into (`body = (await c.req.json()) as CreateXBody`,
// a CAST not a parse — TypeScript's excess-property check does not apply to a
// variable, only an object literal). Any org:admin/department:admin/squad:lead
// caller could POST `{"slug":"x","name":"x","kind":"home"}` and skip the
// entitlement gate entirely — WORSE than the bug P0-N1 fixed, because the
// planted rows are also invisible (GET /departments and GET .../squads select
// an explicit column list that never includes kind).
//
// THE FIX: kind is no longer a field any Input interface can carry, so no
// JSON body — however permissive its parsing — can ever set it. It is instead
// a SEPARATE parameter (`opts.kind`) that only a caller with the TypeScript
// reference to these functions can pass, and the only caller that ever does is
// src/members/bootstrap-self.ts. A route handler that hands a request body
// straight to input can no longer reach this parameter at all — not because
// something strips the key, but because the key has nowhere to bind to. A
// fourth route added later inherits this for free; there is no allowlist to
// forget to update.
export interface CreateOpts {
  // 'work' (default) | 'home'. Omit entirely on every call site except
  // src/members/bootstrap-self.ts — see the block comment above.
  kind?: OrgKind
  // Provenance stamp for squads.created_by_member_id (migration 0166,
  // mupot#1498 P0(b)) — the caller's own member id, when known. SAME
  // discipline as `kind` above: never a field any *Input interface can
  // carry, so no JSON body can spoof it; only a caller with a TypeScript
  // reference to createSquad can pass it. Every production call site should
  // pass its own auth.memberId here so team_bootstrap's provenance-based
  // squad-adoption check (which replaced the old "empty squad" ground
  // entirely — createSquad grants its creator no capability row, so every
  // fresh squad satisfied that test) has something to compare against.
  createdByMemberId?: string
  // Same discipline, one level up: the elevation_grants.id that authorized
  // this create, when it ran under a bounded action:* elevation rather than
  // standing capability (migration 0166). Never a request-body field.
  createdViaElevationGrant?: string
}

const ORG_KINDS: readonly OrgKind[] = ['work', 'home']
export function isOrgKind(v: unknown): v is OrgKind {
  return typeof v === 'string' && (ORG_KINDS as readonly string[]).includes(v)
}

// slugs are URL-safe identifiers: lowercase alphanumeric + single hyphens,
// 1–48 chars, no leading/trailing/double hyphen.
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export function isValidSlug(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= 48 && SLUG_RE.test(v)
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

const AGENT_STATUSES = ['active', 'paused'] as const
export type AgentStatus = (typeof AGENT_STATUSES)[number]
export function isAgentStatus(v: unknown): v is AgentStatus {
  return typeof v === 'string' && (AGENT_STATUSES as readonly string[]).includes(v)
}

// D1 surfaces UNIQUE constraint failures as an Error whose message contains
// "UNIQUE constraint failed". Map those to a conflict rather than a 500.
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message)
}

/** A create result: either the row, or a stable error code the caller maps to a
 *  status / message. Errors are the SAME codes the API already returns. */
export type CreateResult<T> = { ok: true; value: T } | { ok: false; error: string }

// ── departments ────────────────────────────────────────────────────────────────

export interface DepartmentInput {
  slug?: unknown
  name?: unknown
}

export async function createDepartment(
  env: Env,
  input: DepartmentInput,
  opts: CreateOpts = {},
): Promise<CreateResult<Department>> {
  if (!isValidSlug(input.slug)) return { ok: false, error: 'invalid_slug' }
  if (!isNonEmptyString(input.name)) return { ok: false, error: 'invalid_name' }
  // kind is a caller-supplied, TypeScript-typed OrgKind (never parsed from an
  // unknown request body — see the block comment above) — no runtime
  // validation is meaningful here beyond the type system itself.
  const kind: OrgKind = opts.kind ?? 'work'

  // ── Plan ENTITLEMENT gate (mupot#925 P0-N1) — the pot's tier must permit one
  // more department. ONLY when creating a WORK department: a 'home' create
  // (bootstrap_self only) is structurally exempt — never even reads the tier.
  // Fail-closed: an unconfigured pot resolves to 'free'. Existing overage is
  // grandfathered — only the NEXT create is blocked.
  if (kind === 'work') {
    const deptCount =
      (await env.DB.prepare(`SELECT COUNT(*) AS n FROM departments WHERE kind = 'work'`).bind().first<{ n: number }>())
        ?.n ?? 0
    const deptGate = await checkCreateLimit(env, 'maxDepartments', deptCount)
    if (!deptGate.ok) return { ok: false, error: 'department_limit_reached' }
  }

  const dept: Department = {
    id: crypto.randomUUID(),
    slug: input.slug,
    name: input.name.trim(),
    kind,
    created_at: new Date().toISOString(),
  }

  try {
    await env.DB.prepare(
      'INSERT INTO departments (id, slug, name, kind, created_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(dept.id, dept.slug, dept.name, dept.kind, dept.created_at)
      .run()
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, error: 'slug_taken' }
    throw err
  }
  return { ok: true, value: dept }
}

// ── squads ───────────────────────────────────────────────────────────────────

export interface SquadInput {
  slug?: unknown
  name?: unknown
  charter?: unknown
  // work-unit fields (optional; defaults applied when omitted)
  role?: unknown
  okr?: unknown
  kpi_target?: unknown
  effort?: unknown
  autonomy?: unknown
  budget_cap_cents?: unknown
  budget_window?: unknown
}

export async function createSquad(
  env: Env,
  departmentId: string,
  input: SquadInput,
  opts: CreateOpts = {},
): Promise<CreateResult<Squad>> {
  if (!isValidSlug(input.slug)) return { ok: false, error: 'invalid_slug' }
  if (!isNonEmptyString(input.name)) return { ok: false, error: 'invalid_name' }

  const charter =
    input.charter === undefined || input.charter === null
      ? null
      : typeof input.charter === 'string'
        ? input.charter
        : undefined
  if (charter === undefined) return { ok: false, error: 'invalid_charter' }

  // work-unit field validation + defaults
  const role =
    input.role === undefined || input.role === null
      ? null
      : typeof input.role === 'string'
        ? input.role.trim() || null
        : undefined
  if (role === undefined) return { ok: false, error: 'invalid_role' }

  const okr =
    input.okr === undefined || input.okr === null
      ? null
      : typeof input.okr === 'string'
        ? input.okr
        : undefined
  if (okr === undefined) return { ok: false, error: 'invalid_okr' }

  const kpi_target =
    input.kpi_target === undefined || input.kpi_target === null
      ? null
      : typeof input.kpi_target === 'string'
        ? input.kpi_target
        : undefined
  if (kpi_target === undefined) return { ok: false, error: 'invalid_kpi_target' }

  const effort: Effort = input.effort === undefined ? 'standard' : (input.effort as Effort)
  if (!isEffort(effort)) return { ok: false, error: 'invalid_effort' }

  const autonomy: Autonomy = input.autonomy === undefined ? 'draft' : (input.autonomy as Autonomy)
  if (!isAutonomy(autonomy)) return { ok: false, error: 'invalid_autonomy' }

  const budget_cap_cents =
    input.budget_cap_cents === undefined || input.budget_cap_cents === null
      ? null
      : typeof input.budget_cap_cents === 'number' &&
          Number.isInteger(input.budget_cap_cents) &&
          input.budget_cap_cents >= 0
        ? input.budget_cap_cents
        : undefined
  if (budget_cap_cents === undefined) return { ok: false, error: 'invalid_budget_cap_cents' }

  const budget_window: BudgetWindow =
    input.budget_window === undefined ? 'week' : (input.budget_window as BudgetWindow)
  if (!isBudgetWindow(budget_window)) return { ok: false, error: 'invalid_budget_window' }

  // kind is a caller-supplied, TypeScript-typed OrgKind (never parsed from an
  // unknown request body — see the block comment near CreateOpts above).
  const kind: OrgKind = opts.kind ?? 'work'

  // ── Plan ENTITLEMENT gate (S6; kind-filtered per mupot#925 P0-N1) — the pot's
  // tier must permit one more WORK squad. This is a pot-level invariant (the
  // tier's maxSquads), NOT caller authz (the route already gated scope).
  // Fail-closed: an unconfigured pot resolves to 'free'. Existing overage is
  // grandfathered — only the NEXT create is blocked. A 'home' create
  // (bootstrap_self only) is structurally exempt — never reaches this block.
  if (kind === 'work') {
    const squadCount =
      (await env.DB.prepare(`SELECT COUNT(*) AS n FROM squads WHERE kind = 'work'`).bind().first<{ n: number }>())
        ?.n ?? 0
    const squadGate = await checkCreateLimit(env, 'maxSquads', squadCount)
    if (!squadGate.ok) return { ok: false, error: 'squad_limit_reached' }
  }

  const squad: Squad = {
    id: crypto.randomUUID(),
    department_id: departmentId,
    slug: input.slug,
    name: input.name.trim(),
    charter,
    kind,
    role,
    okr,
    kpi_target,
    kpi_progress: 0,
    effort,
    autonomy,
    budget_cap_cents,
    budget_window,
    created_by_member_id: opts.createdByMemberId ?? null,
    created_via_elevation_grant: opts.createdViaElevationGrant ?? null,
    created_at: new Date().toISOString(),
  }

  try {
    await env.DB.prepare(
      `INSERT INTO squads
        (id, department_id, slug, name, charter, kind,
         role, okr, kpi_target, kpi_progress, effort, autonomy, budget_cap_cents, budget_window,
         created_by_member_id, created_via_elevation_grant, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        squad.id,
        squad.department_id,
        squad.slug,
        squad.name,
        squad.charter,
        squad.kind,
        squad.role,
        squad.okr,
        squad.kpi_target,
        squad.kpi_progress,
        squad.effort,
        squad.autonomy,
        squad.budget_cap_cents,
        squad.budget_window,
        squad.created_by_member_id,
        squad.created_via_elevation_grant,
        squad.created_at,
      )
      .run()
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, error: 'slug_taken' }
    throw err
  }
  return { ok: true, value: squad }
}

// ── home (member-owned) ──────────────────────────────────────────────────────
//
// createHomeForMember — a member's own private space, on first contact (FP-01
// Slice 1, mupot#1443; Athena pre-rulings seq 4972/4976, mumega.com brief
// `agents/kasra/briefs/flight-first-person-mubot-meets-shadi-20260920.md`
// §2/§2b/§2c). Hadi, 2026-09-20: "mubot start to learn about them, give them
// a private space, then give them access to rbac resources."
//
// WHAT THIS IS: exactly one `squads` row, `kind='home'`,
// `slug='home-<first 8 chars of memberId>'`, plus exactly one `capabilities`
// row granting the member `admin` on it — their own room. Both rows land in
// ONE env.DB.batch() call: either both land or neither does. No observer ever
// sees a home squad with no owner, or a capability row with no squad behind
// it.
//
// WHAT THIS IS NOT: it does not create an agent. Contrast bootstrapSelf
// (src/members/bootstrap-self.ts), which mints department + squad + agent +
// token for a NEWLY NAMED agent identity, and whose home squad is a
// side-effect of that naming act. A human's private space is not conditioned
// on ever naming an agent — Hadi's requirement is a room the moment they
// exist as a member, full stop. That is also why this function's signature is
// `(env, memberId)` and nothing else: no display name, no agent, no auth
// context (see AUTHZ below).
//
// DEPARTMENT — "do not invent a new default" (brief §2, slice 1): this reuses
// the EXACT convention bootstrapSelf already established for a member's own
// home department (src/members/bootstrap-self.ts's `findDepartmentBySlug` /
// `deptSlug = 'dept-home-' + memberId`, kind='home') rather than inventing a
// second one. If bootstrapSelf (or a prior createHomeForMember call, or a
// prior partial attempt at either) already created that department, THIS SAME
// ROW is adopted — never a second one for the same human. The department is
// resolved (found, or created if genuinely absent) BEFORE the batch below,
// exactly as bootstrapSelf treats its own department/squad creation as
// individually-committing steps ahead of its atomic cluster: a member's home
// department is standing identity infrastructure, not per-call state.
//
// SQUAD SLUG — the brief specifies a SHORT slug, `home-<first 8 hex chars of
// memberId>`, unlike bootstrapSelf's full-UUID `home-<memberId>`. This is
// still collision-safe: squads.slug is UNIQUE only WITHIN a department
// (migrations/0001_init.sql: `UNIQUE(department_id, slug)`), and this
// member's home department is itself derived from their FULL id, so two
// different members can never land in the same department — an 8-char prefix
// collision between two different humans lands in two different uniqueness
// buckets, never the same row.
//
// IDEMPOTENT (#2b: "same member -> same squad_id, no duplicate rows, no
// second grant"): a second call for the same member finds the existing home
// squad — joined through the member's OWN capability row, not slug alone (see
// bootstrap-self.ts's WARN-1 for why a slug match is never proof of
// provenance by itself) — and returns it unchanged. Zero new rows; the batch
// below is never even prepared on that path.
//
// FAILS CLOSED ON AN UNKNOWN MEMBER (#2c-2): a `members` row is the ONLY way a
// human enters this pot (the #1438 invite door, or an admin create) — Mubot
// never mints one. This function's first read is the members table; an
// unknown id returns `member_not_found` before touching anything else, and
// writes zero rows.
//
// AUTHZ — NO AUTHZ INSIDE, same doctrine as createDepartment/createSquad
// above (file header: "these functions do NO authz — the caller ... gates on
// the right scope BEFORE calling"). This function trusts `memberId` as given.
// THE CALLER MUST verify, before calling, that `auth.memberId === memberId`
// (the member is asking for their OWN home) OR `isOrgAdmin(auth)`
// (src/auth/capability.ts) — an agent-bound principal must never be able to
// create, or read the identity of, a home for a member it does not own.
// There is no MCP tool wired to this function in Slice 1 — that is Slice 2's
// Mubot proposal flow — so today the only enforcement point is the reviewed
// call site itself; when a tool is added, its ToolSpec.run() becomes the real
// gate, exactly as toolCreateSquad/toolCreateDepartment gate createSquad/
// createDepartment today.
//
// CAPABILITY FLOOR — 'admin' on the member's OWN home is the existing pattern
// bootstrapSelf already establishes for its own founder grant (river addendum
// A, above: "a room whose owner cannot admit a second chair is a cell"), and
// Athena's G-FP1 gate accepted it unchanged for this function. It is safe
// specifically because capability scope never bubbles UP or SIDEWAYS: 'admin'
// on a squad with zero `project_squad_access` edges confers nothing on any
// project (§2c-1) and nothing on any other squad — see
// tests/home-squad.test.ts's "home-admin only" cases, which prove this rather
// than assume it.

function homeDepartmentSlug(memberId: string): string {
  return `dept-home-${memberId}`
}

async function findHomeDepartmentBySlug(env: Env, slug: string): Promise<Department | null> {
  return env.DB.prepare(`SELECT * FROM departments WHERE slug = ?1 AND kind = 'home' LIMIT 1`)
    .bind(slug)
    .first<Department>()
}

/** Find-or-create the member's own home department, adopting bootstrapSelf's
 *  row (or a prior createHomeForMember's) rather than ever creating a second
 *  one for the same human. See the block comment above for why this is not a
 *  fresh convention. */
async function resolveHomeDepartmentId(
  env: Env,
  memberId: string,
  memberDisplayName: string,
): Promise<CreateResult<string>> {
  const slug = homeDepartmentSlug(memberId)
  const existing = await findHomeDepartmentBySlug(env, slug)
  if (existing) return { ok: true, value: existing.id }

  const created = await createDepartment(env, { slug, name: `Home — ${memberDisplayName}` }, { kind: 'home' })
  if (created.ok) return { ok: true, value: created.value.id }
  if (created.error === 'slug_taken') {
    // Race: bootstrapSelf, or a concurrent createHomeForMember call for the
    // SAME member, committed between our SELECT and this INSERT. Adopt it —
    // gated by kind='home' inside findHomeDepartmentBySlug, so a colliding
    // work-kind row (deliberately squatted or otherwise) is never adopted.
    const raced = await findHomeDepartmentBySlug(env, slug)
    if (raced) return { ok: true, value: raced.id }
  }
  return { ok: false, error: created.error }
}

interface HomeSquadRow {
  id: string
  slug: string
  name: string
  department_id: string
  capability_id: string
  capability: Capability
}

/**
 * findHomeSquadByDepartment — G-FP1b point 5: "one home lookup by department
 * shared by bootstrapSelf and createHomeForMember; two homes per human is
 * structurally impossible." The two functions use DIFFERENT squad slug
 * conventions for the SAME human (bootstrapSelf: `home-<full-uuid>`;
 * createHomeForMember: `home-<8-char-prefix>`), so a slug-keyed lookup can
 * never see across them — a member bootstrapped via one path and then hit by
 * the other would get a SECOND home squad in the SAME home department, which
 * is exactly the structural impossibility this point requires. A member's
 * home department (see homeDepartmentSlug/resolveHomeDepartmentId, shared by
 * both functions already) holds at most ONE squad, identity-wise: itself. So
 * the department, not the squad slug, is the shared join key.
 *
 * `ORDER BY created_at ASC LIMIT 1`: if more than one kind='home' squad ever
 * exists under one home department (a pre-fix data anomaly from before this
 * lookup existed), the earliest one wins deterministically — never "whichever
 * row the query planner returns first".
 */
export async function findHomeSquadByDepartment(env: Env, departmentId: string): Promise<Squad | null> {
  return env.DB.prepare(
    `SELECT * FROM squads WHERE department_id = ?1 AND kind = 'home' ORDER BY created_at ASC LIMIT 1`,
  )
    .bind(departmentId)
    .first<Squad>()
}

/**
 * getMemberHomeSquad — FP-01 Slice 2 (mupot#1443, brief §2 Task A): the ONE
 * read-only lookup a project-access grant executor uses to find "this
 * member's own room" — the ONLY squad a project_access proposal's grant may
 * ever land on (never an arbitrary squad_id from the payload). Reuses the
 * SAME department-keyed join createHomeForMember/bootstrapSelf already share
 * (homeDepartmentSlug + findHomeSquadByDepartment, G-FP1b point 5) rather
 * than inventing a second lookup — a member with no home yet (createHomeForMember
 * never ran) returns null, and the caller must fail closed rather than create
 * one on the fly: creating a home is createHomeForMember's job alone, gated by
 * the member's own first contact (brief §2f(a)), never a side effect of a
 * grant executor.
 */
export async function getMemberHomeSquad(env: Env, memberId: string): Promise<Squad | null> {
  const department = await findHomeDepartmentBySlug(env, homeDepartmentSlug(memberId))
  if (!department) return null
  return findHomeSquadByDepartment(env, department.id)
}

async function findExistingHomeSquad(env: Env, memberId: string, squadSlug: string): Promise<HomeSquadRow | null> {
  // Joined on the member's OWN capability row, not slug alone — a slug match
  // is never proof of provenance by itself (see bootstrap-self.ts's WARN-1
  // doc comment for the same reasoning applied to its department/squad
  // adoption).
  return env.DB.prepare(
    `SELECT s.id AS id, s.slug AS slug, s.name AS name, s.department_id AS department_id,
            c.id AS capability_id, c.capability AS capability
       FROM capabilities c
       JOIN squads s ON s.id = c.scope_id AND s.kind = 'home'
      WHERE c.member_id = ?1 AND c.scope_type = 'squad' AND s.slug = ?2
      LIMIT 1`,
  )
    .bind(memberId, squadSlug)
    .first<HomeSquadRow>()
}

/** The member's own capability row on a given squad, or null. Used to detect
 *  the "squad exists (created by the OTHER home-provisioning function under
 *  its own slug convention) but this member's own grant row is missing" case
 *  — point 6's `repaired` disposition. */
async function findMemberCapabilityOnSquad(
  env: Env,
  memberId: string,
  squadId: string,
): Promise<{ id: string; capability: Capability } | null> {
  return env.DB.prepare(
    `SELECT id, capability FROM capabilities
      WHERE member_id = ?1 AND scope_type = 'squad' AND scope_id = ?2 LIMIT 1`,
  )
    .bind(memberId, squadId)
    .first<{ id: string; capability: Capability }>()
}

export interface CreateHomeForMemberSquad {
  id: string
  slug: string
  name: string
  department_id: string
}

export interface CreateHomeForMemberGrant {
  id: string
  capability: Capability
}

export type CreateHomeForMemberOk = {
  ok: true
  // Point 6 (Athena's round-2 ruling): 'repaired' was REMOVED. It would have
  // written a capability row for an already-existing squad with no
  // receipted ledger to record it on (see the doc comment inside the
  // function, at the department-lookup branch, for the three ledgers
  // checked and rejected) — rather than ship that write with no receipt,
  // the repair path is closed. This disposition is now exactly two values.
  disposition: 'created' | 'existing'
  squad: CreateHomeForMemberSquad
  grant: CreateHomeForMemberGrant
}

export type CreateHomeForMemberError = 'member_not_found' | 'provisioning_failed'

export type CreateHomeForMemberResult =
  | CreateHomeForMemberOk
  | { ok: false; error: CreateHomeForMemberError; detail?: unknown }

export async function createHomeForMember(
  env: Env,
  memberId: string,
): Promise<CreateHomeForMemberResult> {
  // #2c-2 / mupot#1452 P1-1 (restored — adversarial round 1 on #1472 flagged
  // this gate as LOST in the v2 port): fail closed on an unknown, foreign-
  // tenant, or non-active member id — zero rows, before anything else runs.
  // A members row is the ONLY door in (the #1438 invite path, or an admin
  // create); Mubot never mints one. `tenant IS NULL` covers pre-tenant-
  // column rows the same way this file's other member reads do — never
  // widened to admit a DIFFERENT tenant's member.
  const member = await env.DB.prepare(
    `SELECT id, display_name FROM members WHERE id = ?1 AND status = 'active' AND (tenant = ?2 OR tenant IS NULL) LIMIT 1`,
  )
    .bind(memberId, env.TENANT_SLUG)
    .first<{ id: string; display_name: string }>()
  if (!member) return { ok: false, error: 'member_not_found' }

  const squadSlug = `home-${memberId.slice(0, 8)}`

  // Adversarial round 1 on G-FP1b (P2, Athena): this function used to check
  // the SLUG-keyed findExistingHomeSquad BEFORE resolving the member's own
  // department — even though that check is itself member-guarded
  // (member_id in its WHERE clause), leading with a lookup keyed on an
  // 8-CHAR PREFIX invited exactly the class of confusion (two member ids
  // sharing a prefix; different callers reasoning about "which check ran
  // first") that a full, unambiguous key should never have to share space
  // with. The DEPARTMENT lookup below is keyed on the member's FULL id
  // (dept-home-<full-memberId>, never truncated) and is now the ONLY path —
  // slug is used nowhere in this function's OWN lookup logic any more
  // (findExistingHomeSquad now exists solely as this function's own
  // unique-constraint race-recovery helper, further down, which is
  // additionally member-guarded there too).
  const deptResult = await resolveHomeDepartmentId(env, memberId, member.display_name)
  if (!deptResult.ok) {
    return { ok: false, error: 'provisioning_failed', detail: { stage: 'department', reason: deptResult.error } }
  }
  const departmentId = deptResult.value

  // ── point 5: DEPARTMENT-keyed lookup, ahead of creating a new squad ──────
  // Catches the case bootstrapSelf's own slug convention (`home-<full-uuid>`)
  // hides from findExistingHomeSquad above: bootstrapSelf already created
  // (or a prior createHomeForMember call already created) the ONE home squad
  // for this department, under a DIFFERENT slug than the one this call would
  // otherwise mint. Adopting it here — rather than proceeding to INSERT a
  // second squad row under this function's own slug — is what makes "two
  // homes per human" structurally impossible rather than merely unlikely.
  const departmentSquad = await findHomeSquadByDepartment(env, departmentId)
  if (departmentSquad) {
    const grant = await findMemberCapabilityOnSquad(env, memberId, departmentSquad.id)
    if (grant) {
      return {
        ok: true,
        disposition: 'existing',
        squad: {
          id: departmentSquad.id,
          slug: departmentSquad.slug,
          name: departmentSquad.name,
          department_id: departmentSquad.department_id,
        },
        grant: { id: grant.id, capability: grant.capability },
      }
    }
    // Athena's round-2 ruling on point 6 (2026-09-21): the 'repaired'
    // disposition asked for a receipt on an existing ledger; NONE of the
    // three checked (0148 elevation_grants/elevation_usage_log — NOT NULL
    // elevation_grant_id/agent_session_id; door_receipts — NOT NULL
    // onboarding_doors.door_id; membership_receipts — NOT NULL
    // target_agent_id) fit a member-only, agent-less, door-less,
    // session-less event without a schema change. Rather than ship a write
    // path with no receipt ("both-pending"), the repair path is CLOSED: this
    // function NEVER writes a capability row for an already-existing squad,
    // regardless of who is calling. The squad exists (minted by the OTHER
    // home-provisioning function, or a prior partial attempt) but this
    // member holds no capability row on it — reported as 'existing' with no
    // grant, always. Re-repair, if ever needed, happens only through the
    // CREATE path's own idempotent adoption once a real receipted mechanism
    // exists for it — not silently here.
    return {
      ok: true,
      disposition: 'existing',
      squad: {
        id: departmentSquad.id,
        slug: departmentSquad.slug,
        name: departmentSquad.name,
        department_id: departmentSquad.department_id,
      },
      grant: { id: '', capability: 'observer' },
    }
  }

  const squadId = crypto.randomUUID()
  const capabilityId = crypto.randomUUID()
  const homeName = `Home — ${member.display_name}`
  const createdAt = new Date().toISOString()

  // ── the ONE atomic batch: squad + capability, together or not at all ──────
  const statements: [D1PreparedStatement, D1PreparedStatement] = [
    env.DB.prepare(
      `INSERT INTO squads (id, department_id, slug, name, kind, created_at)
       VALUES (?1, ?2, ?3, ?4, 'home', ?5)`,
    ).bind(squadId, departmentId, squadSlug, homeName, createdAt),
    env.DB.prepare(
      `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
       VALUES (?1, ?2, 'squad', ?3, 'admin')`,
    ).bind(capabilityId, memberId, squadId),
  ]

  try {
    const writes = await env.DB.batch(statements)
    assertBatchWritten(writes, 'create_home_for_member', 1)
  } catch (err) {
    // Race: a concurrent createHomeForMember call for the SAME member won.
    // Adopt its rows rather than reporting a failure for a home that now
    // genuinely exists — same "classify, don't compensate a real winner"
    // doctrine bootstrap-self.ts documents for its own audit-conflict race.
    if (isUniqueViolation(err)) {
      const raced = await findExistingHomeSquad(env, memberId, squadSlug)
      if (raced) {
        return {
          ok: true,
          disposition: 'existing',
          squad: { id: raced.id, slug: raced.slug, name: raced.name, department_id: raced.department_id },
          grant: { id: raced.capability_id, capability: raced.capability },
        }
      }
      // The race may equally have been bootstrapSelf (or another
      // createHomeForMember caller) landing the DEPARTMENT'S squad under
      // ITS OWN slug between our lookups above and this INSERT. Re-check by
      // department before giving up — same adopt-a-real-winner doctrine.
      const racedByDept = await findHomeSquadByDepartment(env, departmentId)
      if (racedByDept) {
        const racedGrant = await findMemberCapabilityOnSquad(env, memberId, racedByDept.id)
        if (racedGrant) {
          return {
            ok: true,
            disposition: 'existing',
            squad: {
              id: racedByDept.id,
              slug: racedByDept.slug,
              name: racedByDept.name,
              department_id: racedByDept.department_id,
            },
            grant: { id: racedGrant.id, capability: racedGrant.capability },
          }
        }
      }
    }
    throw err
  }

  return {
    ok: true,
    disposition: 'created',
    squad: { id: squadId, slug: squadSlug, name: homeName, department_id: departmentId },
    grant: { id: capabilityId, capability: 'admin' },
  }
}

// ── agents ───────────────────────────────────────────────────────────────────

export interface AgentInput {
  slug?: unknown
  name?: unknown
  role?: unknown
  model?: unknown
  status?: unknown
  // work-unit fields (optional; defaults applied when omitted)
  okr?: unknown
  kpi_target?: unknown
  effort?: unknown
  autonomy?: unknown
  budget_cap_cents?: unknown
  budget_window?: unknown
  // profile fields (0068_agent_profile.sql) — Port 1.3, all optional
  purpose?: unknown
  owner?: unknown
  model_fallback?: unknown
  capabilities?: unknown // string[] on the wire
  skills?: unknown // string[] on the wire
  parent_agent_id?: unknown
  qnft_ref?: unknown
  death_condition?: unknown // JSON object or string
}

export type CreateAgentInput = AgentInput

export interface PreparedAgentCreate {
  agent: Agent
  statements: [D1PreparedStatement, D1PreparedStatement]
}

// A nullable free-text profile field: undefined|null → null; a string → itself;
// anything else → the sentinel `undefined` (caller maps to an invalid_* error).
function optString(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null
  return typeof v === 'string' ? v : undefined
}

// A nullable JSON string-array field (capabilities/skills). Stored as a JSON text
// column, so validate it is an array of strings and re-serialize canonically.
// undefined|null → null; string[] → JSON; anything else → undefined (invalid).
function optStringArrayJson(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return undefined
  return JSON.stringify(v)
}

// A plain (non-null, non-array) JSON object.
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// death_condition: a JSON lifecycle-policy OBJECT stored as text. Accept an object
// (serialize it) or a string (must itself parse to a plain object, stored verbatim).
// undefined|null → null; anything that is not a plain object → undefined (invalid).
// Rejecting arrays / scalars ("null", "42", "[...]") keeps the stored blob a policy
// object, so a future enforcement sweep can trust its shape.
function optJsonObject(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null
  if (typeof v === 'string') {
    try {
      return isPlainObject(JSON.parse(v)) ? v : undefined
    } catch {
      return undefined
    }
  }
  if (isPlainObject(v)) return JSON.stringify(v)
  return undefined
}

export async function prepareAgentCreate(
  env: Env,
  squadId: string,
  input: AgentInput,
  opts: CreateOpts = {},
): Promise<CreateResult<PreparedAgentCreate>> {
  if (!isValidSlug(input.slug)) return { ok: false, error: 'invalid_slug' }
  if (!isNonEmptyString(input.name)) return { ok: false, error: 'invalid_name' }

  // role/model fall back to the schema defaults when omitted.
  const role = input.role === undefined ? 'member' : input.role
  if (!isNonEmptyString(role)) return { ok: false, error: 'invalid_role' }
  // '@cf/meta/llama-3.3' is NOT a valid Workers AI model id — the real one is
  // '@cf/meta/llama-3.3-70b-instruct-fp8-fast'. Using the wrong id yields a 5007
  // error from Workers AI on first wake. (Bug introduced in initial scaffold, fixed here.)
  const model = input.model === undefined ? '@cf/meta/llama-3.3-70b-instruct-fp8-fast' : input.model
  if (!isNonEmptyString(model)) return { ok: false, error: 'invalid_model' }
  const status: AgentStatus = input.status === undefined ? 'active' : (input.status as AgentStatus)
  if (!isAgentStatus(status)) return { ok: false, error: 'invalid_status' }

  // work-unit field validation + defaults
  const okr =
    input.okr === undefined || input.okr === null
      ? null
      : typeof input.okr === 'string'
        ? input.okr
        : undefined
  if (okr === undefined) return { ok: false, error: 'invalid_okr' }

  const kpi_target =
    input.kpi_target === undefined || input.kpi_target === null
      ? null
      : typeof input.kpi_target === 'string'
        ? input.kpi_target
        : undefined
  if (kpi_target === undefined) return { ok: false, error: 'invalid_kpi_target' }

  const effort: Effort = input.effort === undefined ? 'standard' : (input.effort as Effort)
  if (!isEffort(effort)) return { ok: false, error: 'invalid_effort' }

  const autonomy: Autonomy = input.autonomy === undefined ? 'draft' : (input.autonomy as Autonomy)
  if (!isAutonomy(autonomy)) return { ok: false, error: 'invalid_autonomy' }

  const budget_cap_cents =
    input.budget_cap_cents === undefined || input.budget_cap_cents === null
      ? null
      : typeof input.budget_cap_cents === 'number' &&
          Number.isInteger(input.budget_cap_cents) &&
          input.budget_cap_cents >= 0
        ? input.budget_cap_cents
        : undefined
  if (budget_cap_cents === undefined) return { ok: false, error: 'invalid_budget_cap_cents' }

  const budget_window: BudgetWindow =
    input.budget_window === undefined ? 'week' : (input.budget_window as BudgetWindow)
  if (!isBudgetWindow(budget_window)) return { ok: false, error: 'invalid_budget_window' }

  // ── profile field validation + defaults (0068, Port 1.3) ────────────────────────
  const purpose = optString(input.purpose)
  if (purpose === undefined) return { ok: false, error: 'invalid_purpose' }
  const owner = optString(input.owner)
  if (owner === undefined) return { ok: false, error: 'invalid_owner' }
  const model_fallback = optString(input.model_fallback)
  if (model_fallback === undefined) return { ok: false, error: 'invalid_model_fallback' }
  const qnft_ref = optString(input.qnft_ref)
  if (qnft_ref === undefined) return { ok: false, error: 'invalid_qnft_ref' }
  const capabilities = optStringArrayJson(input.capabilities)
  if (capabilities === undefined) return { ok: false, error: 'invalid_capabilities' }
  const skills = optStringArrayJson(input.skills)
  if (skills === undefined) return { ok: false, error: 'invalid_skills' }
  const death_condition = optJsonObject(input.death_condition)
  if (death_condition === undefined) return { ok: false, error: 'invalid_death_condition' }

  // parent_agent_id: soft self-reference (no FK, see migration). Validate the
  // parent exists so the placement tree can't point at a phantom id.
  const parent_agent_id = optString(input.parent_agent_id)
  if (parent_agent_id === undefined) return { ok: false, error: 'invalid_parent_agent_id' }
  if (parent_agent_id !== null) {
    const parent = await env.DB.prepare('SELECT 1 AS ok FROM agents WHERE id = ?')
      .bind(parent_agent_id)
      .first<{ ok: number }>()
    if (!parent) return { ok: false, error: 'parent_agent_not_found' }
  }

  // kind is a caller-supplied, TypeScript-typed OrgKind (never parsed from an
  // unknown request body — see the block comment near CreateOpts above).
  const kind: OrgKind = opts.kind ?? 'work'

  // ── Plan ENTITLEMENT gate (S6; kind-filtered per mupot#925 P0-N1) — the pot's
  // tier must permit one more WORK agent. Pot-level invariant (the tier's
  // maxAgents), NOT caller authz. Fail-closed to 'free' when unconfigured.
  // Existing overage grandfathered — only the NEXT create is blocked. A 'home'
  // create (bootstrap_self only) is structurally exempt — never reaches this.
  if (kind === 'work') {
    const agentCount =
      (await env.DB.prepare(`SELECT COUNT(*) AS n FROM agents WHERE kind = 'work'`).bind().first<{ n: number }>())
        ?.n ?? 0
    const agentGate = await checkCreateLimit(env, 'maxAgents', agentCount)
    if (!agentGate.ok) return { ok: false, error: 'agent_limit_reached' }
  }

  // The AgentDO is lazy — provisioned on first wake. Here we only insert the row;
  // the agent's id doubles as the DurableObject id name.
  const agent: Agent = {
    id: crypto.randomUUID(),
    squad_id: squadId,
    slug: input.slug,
    name: input.name.trim(),
    role: (role as string).trim(),
    model: (model as string).trim(),
    status,
    kind,
    okr,
    kpi_target,
    kpi_progress: 0,
    effort,
    autonomy,
    budget_cap_cents,
    budget_window,
    created_at: new Date().toISOString(),
    // profile (0068) — arrays are parsed for the return value; JSON text goes to the DB.
    purpose,
    owner,
    model_fallback,
    capabilities: capabilities === null ? null : (JSON.parse(capabilities) as string[]),
    skills: skills === null ? null : (JSON.parse(skills) as string[]),
    parent_agent_id,
    qnft_ref,
    death_condition,
    // owner_member_id is never set at creation — an agent starts unowned and
    // is attached to a member only via update_agent (admin-only), see 0155.
    owner_member_id: null,
  }

  // Prepare the agent AND its neutral home routing membership. The caller may
  // compose these statements into a larger provisioning transaction.
  // (agent_id -> its own squad, 'member') is what the project-scoped message path
  // (src/agents/messages.ts) checks — without it, an onboarded agent could not send
  // or receive a project-scoped message (see gh #469).
  const statements: [D1PreparedStatement, D1PreparedStatement] = [
    env.DB.prepare(
      `INSERT INTO agents
      (id, squad_id, slug, name, role, model, status, kind,
       okr, kpi_target, kpi_progress, effort, autonomy, budget_cap_cents, budget_window,
       created_at,
       purpose, owner, model_fallback, capabilities, skills, parent_agent_id, qnft_ref, death_condition)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      agent.id,
      agent.squad_id,
      agent.slug,
      agent.name,
      agent.role,
      agent.model,
      agent.status,
      agent.kind,
      agent.okr,
      agent.kpi_target,
      agent.kpi_progress,
      agent.effort,
      agent.autonomy,
      agent.budget_cap_cents,
      agent.budget_window,
      agent.created_at,
      purpose,
      owner,
      model_fallback,
      capabilities,
      skills,
      parent_agent_id,
      qnft_ref,
      death_condition,
    ),
    env.DB.prepare(
      `INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES (?, ?, ?, 'member')`,
    ).bind(crypto.randomUUID(), agent.id, agent.squad_id),
  ]
  return { ok: true, value: { agent, statements } }
}

export async function createAgent(
  env: Env,
  squadId: string,
  input: AgentInput,
  opts: CreateOpts = {},
): Promise<CreateResult<Agent>> {
  const prepared = await prepareAgentCreate(env, squadId, input, opts)
  if (!prepared.ok) return prepared
  try {
    await env.DB.batch(prepared.value.statements)
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, error: 'slug_taken' }
    throw err
  }
  return { ok: true, value: prepared.value.agent }
}

// ── profile reads (0068, Port 1.3) ──────────────────────────────────────────────

// A lightweight profile summary — enough for resolve-before-mint and roster display.
export interface AgentProfileSummary {
  id: string
  squad_id: string
  slug: string
  name: string
  role: string
  status: string
  model: string
  model_fallback: string | null
  purpose: string | null
  owner: string | null
  capabilities: string[] | null
  skills: string[] | null
  parent_agent_id: string | null
  qnft_ref: string | null
  death_condition: string | null
  budget_cap_cents: number | null
  budget_window: string
  // owner_member_id (0155): who mupot says owns this agent's harness — see
  // the field comment on Agent.owner_member_id in src/types.ts.
  owner_member_id: string | null
}

interface AgentProfileRow {
  id: string
  squad_id: string
  slug: string
  name: string
  role: string
  status: string
  model: string
  model_fallback: string | null
  purpose: string | null
  owner: string | null
  capabilities: string | null
  skills: string | null
  parent_agent_id: string | null
  qnft_ref: string | null
  death_condition: string | null
  budget_cap_cents: number | null
  budget_window: string
  owner_member_id: string | null
}

// JSON-array text column → string[]; tolerate a corrupt/legacy value by returning null
// rather than throwing (a bad stored value must not brick a read path).
function parseArrayColumn(v: string | null): string[] | null {
  if (v === null) return null
  try {
    const parsed = JSON.parse(v)
    return Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') ? parsed : null
  } catch {
    return null
  }
}

function rowToProfileSummary(r: AgentProfileRow): AgentProfileSummary {
  return {
    id: r.id,
    squad_id: r.squad_id,
    slug: r.slug,
    name: r.name,
    role: r.role,
    status: r.status,
    model: r.model,
    model_fallback: r.model_fallback,
    purpose: r.purpose,
    owner: r.owner,
    capabilities: parseArrayColumn(r.capabilities),
    skills: parseArrayColumn(r.skills),
    parent_agent_id: r.parent_agent_id,
    qnft_ref: r.qnft_ref,
    death_condition: r.death_condition,
    budget_cap_cents: r.budget_cap_cents,
    budget_window: r.budget_window,
    owner_member_id: r.owner_member_id,
  }
}

const PROFILE_COLUMNS =
  'id, squad_id, slug, name, role, status, model, model_fallback, purpose, owner, capabilities, skills, parent_agent_id, qnft_ref, death_condition, budget_cap_cents, budget_window, owner_member_id'

// Read one agent's profile by id. null when the agent does not exist.
export async function getAgentProfile(env: Env, agentId: string): Promise<AgentProfileSummary | null> {
  const row = await env.DB.prepare(`SELECT ${PROFILE_COLUMNS} FROM agents WHERE id = ?`)
    .bind(agentId)
    .first<AgentProfileRow>()
  return row ? rowToProfileSummary(row) : null
}

// resolve-before-mint: find existing agents matching a name/slug query, across ALL
// squads, so onboarding surfaces existing ROLES before minting a duplicate identity.
// This is the anti-sprawl primitive (the 2026-07-21 3-hermes incident). Case-
// insensitive substring match on name OR slug; excludes 'inactive' by default.
export async function findAgentsByName(
  env: Env,
  query: string,
  opts: { includeInactive?: boolean; limit?: number } = {},
): Promise<AgentProfileSummary[]> {
  const q = query.trim().toLowerCase()
  if (q === '') return []
  const like = `%${q.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100)
  const statusClause = opts.includeInactive ? '' : " AND status != 'inactive'"
  const rows = await env.DB.prepare(
    `SELECT ${PROFILE_COLUMNS} FROM agents
      WHERE (LOWER(name) LIKE ?1 ESCAPE '\\' OR LOWER(slug) LIKE ?1 ESCAPE '\\')${statusClause}
      ORDER BY name ASC, slug ASC
      LIMIT ?2`,
  )
    .bind(like, limit)
    .all<AgentProfileRow>()
  return (rows.results ?? []).map(rowToProfileSummary)
}

// ── work-unit helpers ─────────────────────────────────────────────────────────

/**
 * autonomyImpliesGate returns true when the autonomy level requires that tasks
 * produced by this unit are automatically gated (gate_owner will be auto-set
 * when the loop builds tasks — that wiring lands in #27).
 */
export function autonomyImpliesGate(autonomy: Autonomy): boolean {
  return autonomy === 'execute_with_approval'
}

// The set of fields updateUnitConfig may patch (any subset is valid).
export interface UnitConfigPatch {
  okr?: unknown
  kpi_target?: unknown
  effort?: unknown
  autonomy?: unknown
  budget_cap_cents?: unknown
  budget_window?: unknown
  // role is patchable on squads (and on agents, though agents already have role
  // in the core shape — it is included here for uniform patch surface).
  role?: unknown
  // slug — SQUAD ONLY (mupot#1495 "type-safe slugs": update_squad had NO slug
  // field at all before this — renaming a squad needed a raw D1 UPDATE by
  // hand). Rejected outright when kind='agent': agents already have their own
  // governed slug-patch path (update_agent's UPDATABLE_TEXT_COLUMNS), which
  // does not carry a suffix requirement — routing a second, differently-
  // validated writer at the SAME column through this generic patch would let
  // an agent's slug bypass update_agent's own checks. See isValidSquadSlugUpdate
  // below for why a squad's NEW slug must carry the '-sqd' suffix.
  slug?: unknown
}

export type UpdateUnitConfigResult =
  | { ok: true }
  | {
      ok: false
      error:
        | 'not_found'
        | 'invalid_role'
        | 'invalid_okr'
        | 'invalid_kpi_target'
        | 'invalid_effort'
        | 'invalid_autonomy'
        | 'invalid_budget_cap_cents'
        | 'invalid_budget_window'
        | 'invalid_slug'
        | 'slug_taken'
    }

/**
 * mupot#1495 "type-safe slugs" (Hadi, 2026-09-22): "projects `*-prj`, squads
 * `*-sqd`, departments `*-dep`, agents `*-bot`". This enforces the suffix on
 * the ONE NEW path this PR adds (update_squad's slug field) — the broader
 * sweep (project_create/update, create_squad, create_department,
 * create_agent/update_agent, and a backfill migration for existing rows) is
 * explicitly #1495's own, separate migration, so an EXISTING unsuffixed
 * squad slug (e.g. a squad created before this ships) is untouched and stays
 * valid until #1495 lands — this validator only gates a squad's NEW slug on
 * a WRITE through this new field, never a read, and never an existing row.
 */
const SQUAD_SLUG_SUFFIX = '-sqd'
export function isValidSquadSlugUpdate(v: unknown): v is string {
  return isValidSlug(v) && (v as string).endsWith(SQUAD_SLUG_SUFFIX) && (v as string).length > SQUAD_SLUG_SUFFIX.length
}

/**
 * Patch any subset of the work-unit config fields on an agent or squad.
 * Validates every supplied field before touching D1. Returns not_found when
 * the row does not exist (zero changes). Returns invalid_* for bad values.
 * Fields absent from the patch are left untouched.
 */
export async function updateUnitConfig(
  env: Env,
  kind: 'agent' | 'squad',
  id: string,
  patch: UnitConfigPatch,
): Promise<UpdateUnitConfigResult> {
  const setClauses: string[] = []
  const binds: (string | number | null)[] = []

  // role (optional field on both agents and squads)
  if ('role' in patch) {
    const v = patch.role
    if (v === null || v === undefined) {
      if (kind === 'squad') {
        // squads allow null role
        setClauses.push('role = ?')
        binds.push(null)
      } else {
        return { ok: false, error: 'invalid_role' }
      }
    } else if (typeof v === 'string' && v.trim().length > 0) {
      setClauses.push('role = ?')
      binds.push(v.trim())
    } else {
      return { ok: false, error: 'invalid_role' }
    }
  }

  if ('okr' in patch) {
    const v = patch.okr
    if (v === null || v === undefined) {
      setClauses.push('okr = ?')
      binds.push(null)
    } else if (typeof v === 'string') {
      setClauses.push('okr = ?')
      binds.push(v)
    } else {
      return { ok: false, error: 'invalid_okr' }
    }
  }

  if ('kpi_target' in patch) {
    const v = patch.kpi_target
    if (v === null || v === undefined) {
      setClauses.push('kpi_target = ?')
      binds.push(null)
    } else if (typeof v === 'string') {
      setClauses.push('kpi_target = ?')
      binds.push(v)
    } else {
      return { ok: false, error: 'invalid_kpi_target' }
    }
  }

  if ('effort' in patch) {
    if (!isEffort(patch.effort)) return { ok: false, error: 'invalid_effort' }
    setClauses.push('effort = ?')
    binds.push(patch.effort)
  }

  if ('autonomy' in patch) {
    if (!isAutonomy(patch.autonomy)) return { ok: false, error: 'invalid_autonomy' }
    setClauses.push('autonomy = ?')
    binds.push(patch.autonomy)
  }

  if ('budget_cap_cents' in patch) {
    const v = patch.budget_cap_cents
    if (v === null || v === undefined) {
      setClauses.push('budget_cap_cents = ?')
      binds.push(null)
    } else if (typeof v === 'number' && Number.isInteger(v) && v >= 0) {
      // >= 0 matches the creation-path guard (prepareSquadCreate/prepareAgentCreate,
      // above) — this branch was missing it, so a negative cap could previously be
      // set post-creation even though creation itself always rejected one. A cap of
      // -1 clamps nothing (meter.ts only applies budgetCapMicroDollars when it is a
      // POSITIVE finite number — see the Governor/budget-cap inversion note), so a
      // negative value here was not a stricter cap, it was a silently-ignored one.
      setClauses.push('budget_cap_cents = ?')
      binds.push(v)
    } else {
      return { ok: false, error: 'invalid_budget_cap_cents' }
    }
  }

  if ('budget_window' in patch) {
    if (!isBudgetWindow(patch.budget_window)) return { ok: false, error: 'invalid_budget_window' }
    setClauses.push('budget_window = ?')
    binds.push(patch.budget_window)
  }

  // slug — squad-only (see UnitConfigPatch's field comment + isValidSquadSlugUpdate
  // above). An agent kind reaching this branch is a caller bug (update_agent owns
  // agent slug patching through a different, unsuffixed path) — refused rather
  // than silently applied with a validation rule that path never asked for.
  if ('slug' in patch) {
    if (kind !== 'squad') return { ok: false, error: 'invalid_slug' }
    if (!isValidSquadSlugUpdate(patch.slug)) return { ok: false, error: 'invalid_slug' }
    setClauses.push('slug = ?')
    binds.push(patch.slug)
  }

  // Nothing to patch — treat as a no-op success (caller is responsible for sending
  // a non-empty patch; we do not 400 here because a partial update with unknown
  // keys simply elides those keys and the result is consistent).
  if (setClauses.length === 0) return { ok: true }

  const table = kind === 'agent' ? 'agents' : 'squads'
  const sql = `UPDATE ${table} SET ${setClauses.join(', ')} WHERE id = ?`
  binds.push(id)

  let result
  try {
    result = await env.DB.prepare(sql).bind(...binds).run()
  } catch (err) {
    // squads.slug is UNIQUE(department_id, slug) — a rename colliding with a
    // sibling squad's slug in the SAME department surfaces here, not as a
    // generic 500 (parity with createSquad's own slug_taken mapping above).
    if ('slug' in patch && isUniqueViolation(err)) return { ok: false, error: 'slug_taken' }
    throw err
  }

  if (!result.meta.changes) return { ok: false, error: 'not_found' }
  return { ok: true }
}

// ── agent mutations ───────────────────────────────────────────────────────────

export type SetStatusResult = { ok: true } | { ok: false; error: 'not_found' }

/**
 * Pause or resume an agent by updating its status column.
 * Returns ok:true on success or ok:false + 'not_found' when the id does not exist.
 */
export async function setAgentStatus(
  env: Env,
  agentId: string,
  status: AgentStatus,
): Promise<SetStatusResult> {
  const result = await env.DB.prepare('UPDATE agents SET status = ? WHERE id = ?')
    .bind(status, agentId)
    .run()
  if (!result.meta.changes) return { ok: false, error: 'not_found' }
  return { ok: true }
}

export type UpdateAgentProfileResult =
  | { ok: true; value: AgentProfileSummary; auditId: string }
  | { ok: false; error: 'not_found' | 'slug_taken' | 'no_fields' | 'invalid_field' | 'owner_member_not_found' }

/** Who made a correction. `actor_type` is constrained by 0086's CHECK; a member
 *  acting through the MCP tool is a 'user'. */
export interface AuditActor {
  id: string
  type: 'agent' | 'user' | 'system'
}

// A call that supplies no actor is a system-initiated correction — migrations,
// reconciliation jobs, tests. The MCP tool always passes the real member.
const SYSTEM_ACTOR: AuditActor = { id: 'system', type: 'system' }

// The audited snapshot, built in SQL so it can be taken inside the transaction.
// Deliberately excludes `id` (the audit row already carries agent_id) and
// created_at (immutable). Keep in sync with the updatable columns above: a
// field that can be corrected but is not snapshotted is a change no one can
// reverse from the trail.
const AGENT_SNAPSHOT_JSON = `json_object(
  'squad_id', squad_id, 'slug', slug, 'name', name, 'role', role, 'status', status,
  'model', model, 'model_fallback', model_fallback, 'purpose', purpose, 'owner', owner,
  'capabilities', capabilities, 'skills', skills, 'parent_agent_id', parent_agent_id,
  'qnft_ref', qnft_ref, 'budget_cap_cents', budget_cap_cents, 'budget_window', budget_window,
  'owner_member_id', owner_member_id
)`

// Fields an admin may correct on an existing agent. `status` is deliberately
// excluded — setAgentStatus/deactivateAgent own that transition and carry their
// own semantics. `id` and `squad_id` are excluded because moving an agent
// between squads changes its capability scope and is not a profile edit.
//
// `parent_agent_id` is excluded for the same reason, and it is the sharper case.
// It shipped on this list and reached the SET clause through the generic text
// path — trimmed, bound, written — with none of createAgent's validation. That
// made the governed repair path the ONLY way to write the corruption it exists
// to prevent:
//
//   phantom  update_agent(a, {parent_agent_id: 'not-an-agent'})
//   self     update_agent(a, {parent_agent_id: a})
//   cycle    update_agent(a, {parent_agent_id: b}) + update_agent(b, {parent_agent_id: a})
//
// The column is a soft self-reference with no foreign key (see migration), so
// D1 catches none of it, and a cycle makes every consumer that walks the
// placement tree loop forever.
//
// createAgent cannot produce any of the three: it validates that the parent row
// exists, and the new agent's id is crypto.randomUUID() generated server-side —
// a caller cannot name it, so it can be neither its own parent nor an ancestor
// of anything. With this column off the update list, no service path can create
// a cycle at all, which is why this is an exclusion and not a validator.
//
// Re-parenting remains possible by re-provisioning, exactly as with squad_id. If
// a governed in-place re-parent is wanted later, it needs its own entry point
// with an existence check, a self check, and a bounded ancestor walk — not a
// line on this list.
const UPDATABLE_TEXT_COLUMNS = [
  'slug',
  'name',
  'role',
  'model',
  'model_fallback',
  'purpose',
  'owner',
  'qnft_ref',
] as const

const UPDATABLE_ARRAY_COLUMNS = ['capabilities', 'skills'] as const

// Shape caps for update_agent's self-lane fields (mupot#1288, Kasra's gate F3) —
// enforced HERE, not just at the MCP tool layer, so the admin path gets them too
// (an admin fat-fingering a 100k-char purpose is the same corrupted row as an
// agent doing it). MODEL_RE is imported, not redefined, so this and boot-time
// self-report (src/fleet/boot-self-report.ts) can never silently diverge on what
// a "valid model string" is.
//
// PURPOSE_MAX_LEN / PURPOSE_CONTROL_CHAR_RE: purpose is free text (unlike model,
// which is a slug-shaped identifier), so it only gets a length ceiling and a
// control-character ban — NUL and friends have no legitimate reason to appear in
// a one-line self-description, and letting them through risks corrupting log
// lines / CSV exports / terminal renders downstream. \n is allowed (a purpose can
// be a short paragraph); every other C0 control code and DEL are not.
const PURPOSE_MAX_LEN = 2000
// eslint-disable-next-line no-control-regex -- deliberately matching control chars to REJECT them
const PURPOSE_CONTROL_CHAR_RE = /[\x00-\x09\x0B-\x1F\x7F]/

// skills: capped at 32 entries, each a short lowercase tag — same shape family as
// a capability/permission string elsewhere in this codebase, not free text.
const SKILLS_MAX_COUNT = 32
const SKILL_RE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/

// NAME_MAX_LEN / ROLE_MAX_LEN / IDENTITY_CONTROL_CHAR_RE (mupot#1288 gate round 3,
// R4): name and role had NO shape cap on the admin path even after F3 capped
// model/model_fallback/purpose/skills — and they are the two fields
// interpolated RAW into an agent's own system turn (src/agents/execute.ts,
// src/agents/loop.ts, src/agents/agent-do.ts), a stricter authority surface
// than purpose (which reaches no prompt builder). Unlike purpose,
// \n is NOT allowed here — a newline in role/name forges a standalone
// prompt LINE, not just an oversized one, so the ban is every C0 control
// code AND \n, not "every control code except \n". Bounds are generous for
// a one-line identity string, not a paragraph: name tracks a short display
// name (80 chars), role a short descriptor (200 chars — mirrors purpose's
// intent but at a fraction of its length, since role is a title, not a brief).
const NAME_MAX_LEN = 80
const ROLE_MAX_LEN = 200
// eslint-disable-next-line no-control-regex -- deliberately matching control chars to REJECT them
const IDENTITY_CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/

// budget_cap_cents/budget_window (mupot#611 item 1): before this, budget_cap_cents
// was settable ONLY at creation (prepareSquadCreate/prepareAgentCreate above). An
// agent or squad created without a cap — or one whose spend profile changed — could
// never dispatch a budgeted flight again (src/mcp/index.ts's flight_budget_policy_missing
// gate requires a positive integer cap on the bound agent AND every referenced squad),
// and the only "fix" was recreating the row, discarding its grants and history. These
// two get their own category (not TEXT, not ARRAY) because the valid shape is a typed
// number/enum, not a free string — validation below mirrors prepareAgentCreate's guard
// exactly (integer >= 0 or null; budget_window ∈ BudgetWindow).
const UPDATABLE_NUMERIC_COLUMNS = ['budget_cap_cents'] as const
const UPDATABLE_ENUM_COLUMNS = ['budget_window'] as const

// autonomy (mupot#1337): the ONLY MCP write path for this column was
// POST /dashboard/agents/:id/config (src/dashboard/index.ts), which
// authenticates by cookie session only — a bearer-token caller gets 302 to
// /auth/login, so no MCP-bound agent, at any capability level, could ever
// change autonomy through the MCP surface. It gets its own category (not
// folded into UPDATABLE_ENUM_COLUMNS) because its validator is isAutonomy,
// not isBudgetWindow — the two enums are not interchangeable and a shared
// branch would either need a lookup table or risk validating one enum's
// value against the other's predicate.
const UPDATABLE_AUTONOMY_COLUMNS = ['autonomy'] as const

// owner_member_id (0155, mupot#1424 slice): admin-only on EVERY path — never
// added to SELF_PATCHABLE_FIELDS (src/mcp/provision.ts) — because it is the
// column resolveHarnessAttestedOrigin (src/im/origin-verdict.ts) trusts to
// decide whose member identity an agent's harness may carry into a verdict.
// An agent-bound token setting its OWN owner_member_id would be a self-grant
// of exactly that authority, which is why it gets its own category (not
// UPDATABLE_TEXT_COLUMNS): the value must reference a REAL member in this
// tenant, or be null to clear — a free-text write, unlike `owner`, is not
// merely cosmetically wrong here, it is a security-relevant lie.
const UPDATABLE_MEMBER_REF_COLUMNS = ['owner_member_id'] as const

export type UpdatableAgentField =
  | (typeof UPDATABLE_TEXT_COLUMNS)[number]
  | (typeof UPDATABLE_ARRAY_COLUMNS)[number]
  | (typeof UPDATABLE_NUMERIC_COLUMNS)[number]
  | (typeof UPDATABLE_ENUM_COLUMNS)[number]
  | (typeof UPDATABLE_AUTONOMY_COLUMNS)[number]
  | (typeof UPDATABLE_MEMBER_REF_COLUMNS)[number]

export type AgentProfilePatch = Partial<Record<UpdatableAgentField, unknown>>

/**
 * Correct an existing agent's profile row in place.
 *
 * Exists because the registry drifts: a seat is re-harnessed or re-modelled and
 * the row keeps asserting what was true at creation. Before this, the only
 * mutations on `agents` were status and kpi_progress, so a wrong model or a
 * stale role could be fixed only by direct database access — which meant it
 * never stayed fixed.
 *
 * Partial by construction: only the keys present in `patch` are written, so a
 * caller correcting a model cannot accidentally blank a purpose. An explicit
 * null clears a nullable column; `slug` and `name` reject null because the
 * schema requires them.
 */
export async function updateAgentProfile(
  env: Env,
  agentId: string,
  patch: AgentProfilePatch,
  actor: AuditActor = SYSTEM_ACTOR,
): Promise<UpdateAgentProfileResult> {
  const sets: string[] = []
  const binds: (string | number | null)[] = []

  for (const [key, raw] of Object.entries(patch)) {
    if (raw === undefined) continue

    if ((UPDATABLE_NUMERIC_COLUMNS as readonly string[]).includes(key)) {
      // budget_cap_cents: null clears the cap; otherwise integer >= 0, exactly
      // mirroring prepareAgentCreate/prepareSquadCreate's guard (lines ~139-147
      // above). A negative value is not a stricter cap — meter.ts only applies
      // budgetCapMicroDollars when it is positive — so rejecting it here rather
      // than silently storing a no-op cap matches the creation path's intent,
      // not just its shape.
      if (raw === null) {
        sets.push(`${key} = ?`)
        binds.push(null)
        continue
      }
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
        return { ok: false, error: 'invalid_field' }
      }
      sets.push(`${key} = ?`)
      binds.push(raw)
      continue
    }

    if ((UPDATABLE_ENUM_COLUMNS as readonly string[]).includes(key)) {
      // budget_window has a schema DEFAULT and is never null-valued on a live
      // row (prepareAgentCreate defaults it to 'week' when omitted) — unlike
      // budget_cap_cents, null is not accepted here.
      if (!isBudgetWindow(raw)) return { ok: false, error: 'invalid_field' }
      sets.push(`${key} = ?`)
      binds.push(raw)
      continue
    }

    if ((UPDATABLE_AUTONOMY_COLUMNS as readonly string[]).includes(key)) {
      // autonomy has a schema DEFAULT and is never null-valued on a live row
      // (mirrors budget_window above) — null is not accepted, only one of
      // the four isAutonomy enum values.
      if (!isAutonomy(raw)) return { ok: false, error: 'invalid_field' }
      sets.push(`${key} = ?`)
      binds.push(raw)
      continue
    }

    if ((UPDATABLE_MEMBER_REF_COLUMNS as readonly string[]).includes(key)) {
      // null clears the owner (a legitimate admin action — detach the harness
      // from any member, e.g. before re-provisioning). A non-null value must
      // reference a REAL member in THIS tenant — checked here, not merely
      // shaped like an id, because a member that does not exist would make
      // resolveHarnessAttestedOrigin's ownership conjunct permanently false
      // for an owner_member_id nobody can ever satisfy, silently bricking the
      // harness-attested path for that agent with no error at write time.
      if (raw === null) {
        sets.push(`${key} = ?`)
        binds.push(null)
        continue
      }
      if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: 'invalid_field' }
      const memberRow = await env.DB.prepare('SELECT 1 FROM members WHERE id = ? AND tenant = ?')
        .bind(raw.trim(), env.TENANT_SLUG)
        .first<{ 1: number }>()
      if (!memberRow) return { ok: false, error: 'owner_member_not_found' }
      sets.push(`${key} = ?`)
      binds.push(raw.trim())
      continue
    }

    if ((UPDATABLE_ARRAY_COLUMNS as readonly string[]).includes(key)) {
      if (raw === null) {
        sets.push(`${key} = ?`)
        binds.push(null)
        continue
      }
      if (!Array.isArray(raw) || !raw.every((x) => typeof x === 'string')) {
        return { ok: false, error: 'invalid_field' }
      }
      // mupot#1288 F3 — skills is the one array column reachable from
      // update_agent's self lane, so it gets the same shape discipline as a
      // capability/permission tag: capped count, short lowercase-tag shape.
      // `capabilities` (the other UPDATABLE_ARRAY_COLUMNS member) is
      // admin-only on every path and keeps its existing string[] check only.
      if (key === 'skills') {
        if (raw.length > SKILLS_MAX_COUNT) return { ok: false, error: 'invalid_field' }
        if (!raw.every((s) => SKILL_RE.test(s))) return { ok: false, error: 'invalid_field' }
      }
      sets.push(`${key} = ?`)
      binds.push(JSON.stringify(raw))
      continue
    }

    if (!(UPDATABLE_TEXT_COLUMNS as readonly string[]).includes(key)) {
      return { ok: false, error: 'invalid_field' }
    }

    if (raw === null) {
      // slug, name, role and model are NOT NULL in the schema (migration 0049
      // — role/model carry schema DEFAULTs, but D1 still rejects an explicit
      // NULL). Before mupot#1288 F4, role/model were missing from this list:
      // a { role: null } or { model: null } patch sailed through this
      // function's own validation, then threw a raw SQLite NOT NULL
      // constraint violation out of the D1 batch — an admin-path patch that
      // 500'd instead of failing closed with a named field.
      if (key === 'slug' || key === 'name' || key === 'role' || key === 'model') {
        return { ok: false, error: 'invalid_field' }
      }
      sets.push(`${key} = ?`)
      binds.push(null)
      continue
    }

    if (typeof raw !== 'string') return { ok: false, error: 'invalid_field' }
    const trimmed = raw.trim()
    if ((key === 'slug' || key === 'name' || key === 'role' || key === 'model') && !trimmed) {
      return { ok: false, error: 'invalid_field' }
    }
    // mupot#1288 F3 — model/model_fallback are the two update_agent self-lane
    // fields shaped like an identifier rather than free text; model_fallback
    // is nullable (handled above) but once it IS a string it must be shaped
    // the same as model, or a fallback nobody validated becomes the live
    // model the moment the primary fails.
    if ((key === 'model' || key === 'model_fallback') && !MODEL_RE.test(trimmed)) {
      return { ok: false, error: 'invalid_field' }
    }
    if (key === 'purpose') {
      if (trimmed.length > PURPOSE_MAX_LEN) return { ok: false, error: 'invalid_field' }
      if (PURPOSE_CONTROL_CHAR_RE.test(trimmed)) return { ok: false, error: 'invalid_field' }
    }
    // mupot#1288 gate round 3, R4 — name/role reach the system prompt raw
    // (see the block comment above IDENTITY_CONTROL_CHAR_RE); the non-empty
    // check above already enforces the 1-char floor, this adds the ceiling
    // and bans EVERY control character including \n (a newline here forges
    // a standalone prompt line, unlike purpose where \n is legitimate).
    if (key === 'name') {
      if (trimmed.length > NAME_MAX_LEN) return { ok: false, error: 'invalid_field' }
      if (IDENTITY_CONTROL_CHAR_RE.test(trimmed)) return { ok: false, error: 'invalid_field' }
    }
    if (key === 'role') {
      if (trimmed.length > ROLE_MAX_LEN) return { ok: false, error: 'invalid_field' }
      if (IDENTITY_CONTROL_CHAR_RE.test(trimmed)) return { ok: false, error: 'invalid_field' }
    }
    sets.push(`${key} = ?`)
    binds.push(trimmed)
  }

  if (!sets.length) return { ok: false, error: 'no_fields' }

  const auditId = crypto.randomUUID()
  const fieldsChanged = JSON.stringify(Object.keys(patch).filter((k) => patch[k as UpdatableAgentField] !== undefined))

  let changes = 0
  try {
    // No updated_at column on `agents` — 0049 rebuilt the table without one and
    // no later migration adds it. Provenance for a correction lives in the audit
    // trail, not on the row, which is why that trail must be durable.
    //
    // All three statements run in ONE D1 batch, i.e. one transaction. This is
    // load-bearing on both counts:
    //
    //   Durability — the audit row commits WITH the update or not at all. The
    //   previous design wrote the row, then emitted a bus event that was caught
    //   and swallowed on failure, so a correction could land with no record of
    //   what changed or what it was before. On a table with no updated_at, that
    //   is an unrecorded mutation the design tells operators to trust.
    //
    //   Accuracy — the before-image is captured in SQL, inside the transaction,
    //   rather than by a separate SELECT beforehand. A concurrent write between
    //   a client-side read and the UPDATE would otherwise make before_state a
    //   fabrication: a diff that never happened.
    //
    // Same shape as 0046_flight_event_outbox ("Landing and outbox insertion
    // share one D1 batch").
    //
    // Statement 1 uses INSERT..SELECT so a missing agent inserts no audit row;
    // statement 2 then reports 0 changes and we return not_found with nothing
    // written. Statement 3 backfills after_state from the committed row.
    const batch = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO agent_audit
           (id, agent_id, actor_id, actor_type, action, fields_changed, before_state, after_state)
         SELECT ?, id, ?, ?, 'update_agent', ?, ${AGENT_SNAPSHOT_JSON}, ''
           FROM agents WHERE id = ?`,
      ).bind(auditId, actor.id, actor.type, fieldsChanged, agentId),
      env.DB.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, agentId),
      env.DB.prepare(
        `UPDATE agent_audit
            SET after_state = (SELECT ${AGENT_SNAPSHOT_JSON} FROM agents WHERE id = ?)
          WHERE id = ?`,
      ).bind(agentId, auditId),
    ])
    changes = batch[1]?.meta.changes ?? 0
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, error: 'slug_taken' }
    throw err
  }
  if (!changes) return { ok: false, error: 'not_found' }

  const profile = await getAgentProfile(env, agentId)
  if (!profile) return { ok: false, error: 'not_found' }
  return { ok: true, value: profile, auditId }
}

// ── moveAgentSquad ────────────────────────────────────────────────────────────
// The re-provision path update_agent refused to grow: agents.squad_id is one FK,
// so changing home is a capability-scope change, not a profile edit. This write
// is the whole move in ONE D1 batch — old-squad severance, home-row update,
// destination grant, and agent_audit — so a caller never observes a moved agent
// with dangling dual-squad grants or a grantless new home.
//
// owner_member_id is deliberately absent from the UPDATE. That column is the
// human-attestation binding (0155 / PR #1425); a squad move must not rewrite
// whose member identity the agent's harness may carry.
//
// The destination grant is the same writer setAgentSquadAccess uses
// (prepareAgentSquadAccess). We do not call setAgentSquadAccess as a second
// transaction after the home-row UPDATE: a grant failure there would leave the
// agent already moved and severed. Same statements, one batch.
//
// Athena HARD-BLOCK 3 asked source-squad grants to stay dangling. The original
// Kasra/Hadi BUILD said to clear them. We keep the DELETE (access visibly
// shrinks) and return grant_impact.no_longer_applies so the shrink is listed.
// Gate may invert the DELETE; the impact list stays either way.
// In-flight tasks/flights are not reassigned by this write.

export type MoveAgentSquadError =
  | 'not_found'
  | 'same_squad'
  | 'agent_identity_unminted'
  | 'agent_identity_conflict'
  | 'squad_not_found'
  | 'receipt_failed'

export interface MoveGrantImpact {
  no_longer_applies: Array<{
    kind: 'membership' | 'capability' | 'gate_grant'
    squad_id: string
    capability: string
  }>
  destination_grant: {
    squad_id: string
    capability: AgentAccessCapability
    opt_in: 'capability'
  }
  tasks_reassigned: false
  flights_reassigned: false
}

export type MoveAgentSquadResult =
  | {
      ok: true
      auditId: string
      fromSquadId: string
      toSquadId: string
      capability: AgentAccessCapability
      membership: Membership
      grant: CapabilityGrant
      grantImpact: MoveGrantImpact
    }
  | { ok: false; error: MoveAgentSquadError }

// Capability rows the move severs from the old home (memberships + squad-scoped
// capabilities + the agent's/member's gate_grants). gate_grants are not
// squad-scoped — they become inert on the old board once home standing is
// gone — and they are the only place `gate:<cap>` strings can live
// (`capabilities.capability` CHECKs observer/member/lead/admin/owner).
export async function listMoveGrantImpact(
  env: Env,
  input: { agentId: string; memberId: string; fromSquadId: string },
): Promise<MoveGrantImpact['no_longer_applies']> {
  const [priorMemberships, priorCapabilities, priorGateGrants] = await Promise.all([
    env.DB.prepare(
      `SELECT capability FROM memberships WHERE agent_id = ? AND squad_id = ?`,
    ).bind(input.agentId, input.fromSquadId).all<{ capability: string }>(),
    env.DB.prepare(
      `SELECT capability FROM capabilities
        WHERE member_id = ? AND scope_type = 'squad' AND scope_id = ?`,
    ).bind(input.memberId, input.fromSquadId).all<{ capability: string }>(),
    env.DB.prepare(
      `SELECT capability FROM gate_grants
        WHERE (principal_type = 'agent' AND principal_id = ?)
           OR (principal_type = 'member' AND principal_id = ?)`,
    ).bind(input.agentId, input.memberId).all<{ capability: string }>(),
  ])
  return [
    ...(priorMemberships.results ?? []).map((row) => ({
      kind: 'membership' as const,
      squad_id: input.fromSquadId,
      capability: row.capability,
    })),
    ...(priorCapabilities.results ?? []).map((row) => ({
      kind: 'capability' as const,
      squad_id: input.fromSquadId,
      capability: row.capability,
    })),
    ...(priorGateGrants.results ?? []).map((row) => ({
      kind: 'gate_grant' as const,
      squad_id: input.fromSquadId,
      capability: row.capability,
    })),
  ]
}

export async function moveAgentSquad(
  env: Env,
  input: {
    agentId: string
    fromSquadId: string
    toSquadId: string
    memberId: string
    capability: AgentAccessCapability
    actor: AuditActor
    reason?: string
  },
): Promise<MoveAgentSquadResult> {
  if (input.fromSquadId === input.toSquadId) {
    return { ok: false, error: 'same_squad' }
  }

  const noLongerApplies = await listMoveGrantImpact(env, {
    agentId: input.agentId,
    memberId: input.memberId,
    fromSquadId: input.fromSquadId,
  })

  const prepared = await prepareAgentSquadAccess(env, {
    agentId: input.agentId,
    memberId: input.memberId,
    squadId: input.toSquadId,
    capability: input.capability,
  }, {
    agentId: input.agentId,
    memberId: input.memberId,
    homeSquadId: input.fromSquadId,
    disposition: 'existing',
  })
  if (!prepared.ok) {
    if (prepared.error === 'agent_not_found') return { ok: false, error: 'not_found' }
    // prepareAgentSquadAccess never returns home_squad_immutable (that is
    // removeAgentSquadAccess's home-row guard). Map it closed rather than
    // widening this result type for a path that cannot happen here.
    if (prepared.error === 'home_squad_immutable') return { ok: false, error: 'receipt_failed' }
    return { ok: false, error: prepared.error }
  }

  const auditId = crypto.randomUUID()
  // Structured object, not update_agent's field-name array: a move is not a
  // profile-field patch. agent_audit has no dedicated columns for old/new
  // squad, granted capability, or reason — those facts live here. Timestamp
  // is created_at; actor is actor_id / actor_type. before_state / after_state
  // stay the AGENT_SNAPSHOT_JSON convention so owner_member_id is in both
  // images and a reader can prove the move left it untouched.
  const fieldsChanged = JSON.stringify({
    squad_id: { from: input.fromSquadId, to: input.toSquadId },
    capability: input.capability,
    reason: input.reason ?? null,
  })

  const writes = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO agent_audit
         (id, agent_id, actor_id, actor_type, action, fields_changed, before_state, after_state)
       SELECT ?, id, ?, ?, 'move_agent_squad', ?, ${AGENT_SNAPSHOT_JSON}, ''
         FROM agents WHERE id = ? AND squad_id = ?`,
    ).bind(
      auditId,
      input.actor.id,
      input.actor.type,
      fieldsChanged,
      input.agentId,
      input.fromSquadId,
    ),
    // ONLY squad_id. owner_member_id (and every other column) stay put.
    env.DB.prepare(
      `UPDATE agents SET squad_id = ? WHERE id = ? AND squad_id = ?`,
    ).bind(input.toSquadId, input.agentId, input.fromSquadId),
    env.DB.prepare(
      `DELETE FROM memberships WHERE agent_id = ? AND squad_id = ?`,
    ).bind(input.agentId, input.fromSquadId),
    env.DB.prepare(
      `DELETE FROM capabilities
        WHERE member_id = ? AND scope_type = 'squad' AND scope_id = ?`,
    ).bind(input.memberId, input.fromSquadId),
    ...prepared.value.statements,
    env.DB.prepare(
      `UPDATE agent_audit
          SET after_state = (SELECT ${AGENT_SNAPSHOT_JSON} FROM agents WHERE id = ?)
        WHERE id = ?`,
    ).bind(input.agentId, auditId),
  ])

  try {
    assertWritten(writes[0]!, 'move_agent_squad.audit_insert')
    assertWritten(writes[1]!, 'move_agent_squad.squad_id')
    assertWritten(writes[writes.length - 1]!, 'move_agent_squad.audit_after')
    // Destination grant statements are the two prepareAgentSquadAccess writes
    // immediately before the after_state backfill — same receipt bar
    // setAgentSquadAccess uses.
    assertWritten(writes[writes.length - 3]!, 'move_agent_squad.membership')
    assertWritten(writes[writes.length - 2]!, 'move_agent_squad.capability')
  } catch {
    return { ok: false, error: 'receipt_failed' }
  }

  const [membership, grant] = await Promise.all([
    env.DB.prepare(
      `SELECT id, agent_id, squad_id, capability
         FROM memberships WHERE agent_id = ? AND squad_id = ? LIMIT 1`,
    ).bind(input.agentId, input.toSquadId).first<Membership>(),
    env.DB.prepare(
      `SELECT member_id, scope_type, scope_id, capability
         FROM capabilities
        WHERE member_id = ? AND scope_type = 'squad' AND scope_id = ?
        LIMIT 1`,
    ).bind(input.memberId, input.toSquadId).first<CapabilityGrant>(),
  ])
  if (!membership || !grant || grant.capability !== input.capability) {
    return { ok: false, error: 'receipt_failed' }
  }

  return {
    ok: true,
    auditId,
    fromSquadId: input.fromSquadId,
    toSquadId: input.toSquadId,
    capability: input.capability,
    membership,
    grant,
    grantImpact: {
      no_longer_applies: noLongerApplies,
      destination_grant: {
        squad_id: input.toSquadId,
        capability: input.capability,
        opt_in: 'capability',
      },
      tasks_reassigned: false,
      flights_reassigned: false,
    },
  }
}

export type DeleteAgentResult = { ok: true } | { ok: false; error: 'not_found' }

/**
 * Delete an agent row and null out any task assignee references.
 *
 * The AgentDO is lazy — it is only provisioned on first wake. A deleted agent
 * id is simply never woken again, so no explicit DurableObject teardown is
 * required (the stub exists but no calls reach it once the row is gone from D1).
 *
 * We also null out tasks.assignee_agent_id where it references this agent to
 * avoid orphaned assignee ids that would otherwise render as '—' in the UI.
 */
export async function deleteAgent(
  env: Env,
  agentId: string,
): Promise<DeleteAgentResult> {
  // Keep assignment cleanup and deletion in one D1 transaction. A canonical
  // binding or any other delete guard rolls the cleanup back instead of
  // returning an error after tasks have already been destructively unassigned.
  const writes = await env.DB.batch([
    env.DB.prepare(
      `UPDATE tasks
          SET assignee_agent_id = NULL
        WHERE assignee_agent_id = ?
          AND EXISTS (SELECT 1 FROM agents WHERE id = ?)`,
    ).bind(agentId, agentId),
    env.DB.prepare('DELETE FROM agents WHERE id = ?').bind(agentId),
  ])
  if (!writes[1]?.meta.changes) return { ok: false, error: 'not_found' }
  return { ok: true }
}
