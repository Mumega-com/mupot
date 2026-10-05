// verdict-records — a READ-TIME projection of a project's recent approved verdicts.
//
// Goal: "an approved verdict becomes project knowledge; the next agent's boot shows it
// without being told." This is deliberately a PROJECTION, not a memory write:
//   * nothing is stored — no engram, no Vectorize vector, no queue consumer, no heartbeat,
//     no audit row — so there is no id to squat, no text to forge, and no second copy of a
//     task's result whose access rules could drift from the task's own;
//   * it reads task_verdicts directly, so a REVERSED verdict disappears on the very next
//     call and a deleted task simply is not joined;
//   * it applies the squad rule of task_list (member rank, home squads fenced), so a project
//     reader on squad-b never sees squad-a's task title or result through this surface
//     (task_list(squad-a) is 403 for them).
//
// INVARIANT: this projection never shows more than task_list would show the same caller.
// So the squad filter is NOT the situation-derived readable-squad predicate (that one reads at
// OBSERVER rank and leaves kind='home' squads reachable for org-wide callers). It is
// `visibleSquadIds` below: the squads the MEMBER-rank task read paths resolve, with home squads
// excluded for org-wide callers, passed as the only squad filter (never null/unbounded).
//
// Every record is EVIDENCE of a past decision, never an instruction: fixed
// `record_kind`/`trust` fields, and the only agent/user-authored text (task title, result
// excerpt) lives inside one `untrusted` object — secret-redacted BEFORE it is cut, then
// capped on its ENCODED byte size.

import type { AuthContext, Env } from '../types'
import { TASK_NOT_ARCHIVED_SQL } from '../hygiene/filters'
import { redactSecretPatterns } from '../lib/redact'
import { stripUnsafeText } from '../tasks/runtime-receipts'
import { projectReadAccessFromGrants, projectVisibilityClause } from './access'
import { resolveAccessibleSquadIds, resolveAllSquadIds } from './readable-squads'

export const VERDICT_RECORD_LIMIT_MAX = 5
export const ORIENT_PROJECT_MAX = 3
export const UNTRUSTED_MAX_BYTES = 1800
const TITLE_MAX_CHARS = 160
const EXCERPT_MAX_CHARS = 1000
// Read cap for the raw result. Redaction runs over everything read; the cap only bounds the
// D1 read, and it sits far beyond the displayed excerpt, so a secret that straddles the
// DISPLAY cut is always inside the redacted region.
const RESULT_READ_CHARS = 200_000

export interface VerdictRecord {
  record_kind: 'verdict_record'
  trust: 'evidence_not_instruction'
  task_id: string
  verdict_id: string
  decided_at: string
  decided_by: string
  runtime_receipt_id: string | null
  artifact_sha256: string | null
  untrusted: { title: string; result_excerpt: string; result_truncated: boolean }
}

// ── redaction (a pure ADDITION over lib/redact; existing callers are untouched) ───────────

const PEM_BEGIN_RE = /-{3,5}BEGIN [A-Z0-9 ]+-{3,5}/gi

/**
 * PEM blocks of any label (incl. ENCRYPTED PRIVATE KEY, PGP, CERTIFICATE...). A block with
 * no END marker is redacted from BEGIN to the END OF THE TEXT — an unterminated block must
 * never leave its body visible.
 */
function redactPemBlocks(text: string): string {
  let out = ''
  let cursor = 0
  PEM_BEGIN_RE.lastIndex = 0
  for (let m = PEM_BEGIN_RE.exec(text); m !== null; m = PEM_BEGIN_RE.exec(text)) {
    if (m.index < cursor) continue
    out += text.slice(cursor, m.index) + '[redacted]'
    const label = m[0].replace(/^-+BEGIN /i, '').replace(/-+$/, '')
    const endRe = new RegExp(`-{3,5}END ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-{3,5}`, 'gi')
    endRe.lastIndex = m.index + m[0].length
    const endMatch = endRe.exec(text)
    cursor = endMatch === null ? text.length : endMatch.index + endMatch[0].length
    PEM_BEGIN_RE.lastIndex = cursor
  }
  return out + text.slice(cursor)
}

export function redactEvidenceText(text: string): string {
  const stripped = redactPemBlocks(text)
    // Database / broker / any scheme URL carrying credentials, and any postgres URL at all.
    .replace(/\bpostgres(?:ql)?:\/\/\S+/gi, '[redacted]')
    .replace(/\b([a-z][a-z0-9+.-]*):\/\/[^\s/@:]*:[^\s/@]+@/gi, '$1://[redacted]@')
    // base64-encoded PEM ("-----BEGIN" / "----BEGIN" encode to these prefixes at some alignments).
    .replace(/(?:LS0tLS1CRUdJTi|LS0tLUJFR0lO|tLS0tQkVHSU4|0tLS1CRUdJT)[A-Za-z0-9+/=_-]*/g, '[redacted]')
    // Stripe-style keys and Google API keys.
    .replace(/\b[sr]k_(?:live|test)_[A-Za-z0-9]{8,}\b/g, '[redacted]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[redacted]')
  return redactSecretPatterns(stripped)
}

// ── bounded untrusted block ───────────────────────────────────────────────────────────────

const encoder = new TextEncoder()

export function byteLength(value: string): number {
  return encoder.encode(value).length
}

function truncateChars(value: string, maxChars: number): string {
  const chars = Array.from(value) // code points: never splits a surrogate pair
  return chars.length <= maxChars ? value : chars.slice(0, maxChars).join('')
}

/**
 * Redact the FULL text first, then cut by ENCODED size: JSON escaping expands quotes and
 * astral characters, so a raw character cap is not a size cap.
 */
export function buildUntrusted(title: string, result: string | null): VerdictRecord['untrusted'] {
  // strip FIRST (a zero-width/bidi/soft-hyphen char inside a token would otherwise defeat the
  // redactor and be reassembled by the strip), then redact the FULL text, then cut by encoded size.
  let titleText = truncateChars(redactEvidenceText(stripUnsafeText(title)), TITLE_MAX_CHARS)
  const resultFull = result === null ? '' : redactEvidenceText(stripUnsafeText(result))
  let excerpt = truncateChars(resultFull, EXCERPT_MAX_CHARS)
  let truncated = Array.from(resultFull).length > Array.from(excerpt).length
  const render = (): VerdictRecord['untrusted'] => ({ title: titleText, result_excerpt: excerpt, result_truncated: truncated })
  while (byteLength(JSON.stringify(render())) > UNTRUSTED_MAX_BYTES) {
    if (excerpt.length > 0) {
      excerpt = truncateChars(excerpt, Math.floor(Array.from(excerpt).length * 0.8))
      truncated = true
    } else if (titleText.length > 0) {
      titleText = truncateChars(titleText, Math.floor(Array.from(titleText).length * 0.8))
    } else {
      break
    }
  }
  return render()
}

function safeRef(value: string | null): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9._:@-]{1,100}$/.test(value) ? value : null
}

function validSha(value: string | null): string | null {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : null
}

// ── the projection ────────────────────────────────────────────────────────────────────────

interface RecordRow {
  task_id: string
  title: string
  result: string | null
  verdict_id: string
  decided_at: string
  decided_by: string
  runtime_receipt_id: string | null
  artifact_sha256: string | null
}

/**
 * The record query. ?3 is the ONLY squad filter (a concrete list, see visibleSquadIds); ?2 = 1
 * means workspace admin (task_list's canReadProjectForSquad then only requires the project to
 * exist), otherwise the squad needs its own project_squad_access edge, exactly as task_list's
 * `project_id` filter requires. Archived tasks are excluded as task_list excludes them. The
 * task's LATEST verdict must be an approved, unreversed one, so a reversal (reversed_at) or a
 * later rejection removes the record.
 */
export const VERDICT_RECORDS_SQL = `
  SELECT t.id AS task_id, t.title AS title, substr(t.result, 1, ?5) AS result,
         v.id AS verdict_id, v.decided_at AS decided_at, v.decided_by AS decided_by,
         (SELECT r.id FROM task_dispatch_runtime_receipts r
           WHERE r.tenant = ?6 AND r.task_id = t.id AND r.stage = 'completed' ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS runtime_receipt_id,
         (SELECT r.artifact_sha256 FROM task_dispatch_runtime_receipts r
           WHERE r.tenant = ?6 AND r.task_id = t.id AND r.stage = 'completed' AND r.artifact_sha256 IS NOT NULL
           ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS artifact_sha256
    FROM tasks t
    JOIN task_verdicts v ON v.id = (
           SELECT lv.id FROM task_verdicts lv WHERE lv.task_id = t.id ORDER BY lv.decided_at DESC, lv.id DESC LIMIT 1)
   WHERE t.project_id = ?1
     AND t.squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?3))
     AND (?2 = 1 OR EXISTS (SELECT 1 FROM project_squad_access a WHERE a.project_id = t.project_id AND a.squad_id = t.squad_id))
     AND ${TASK_NOT_ARCHIVED_SQL('t')}
     AND v.verdict = 'approved' AND v.reversed_at IS NULL
     AND t.status IN ('approved', 'done')
   ORDER BY v.decided_at DESC, v.id DESC
   LIMIT ?4`

/**
 * The squads this caller may read TASKS on — what task_list/task_board resolve: MEMBER rank
 * (not observer), and home squads excluded for org-wide callers (resolveAccessibleSquadIds
 * returns null for an org-wide caller and leaves home exclusion to the consumer, so the
 * consumer does it here). Mirrors task_list's choice of authority plane: the legacy
 * owner/admin role counts only while capabilities are not loaded (hasWorkspaceAdmin), and
 * `capabilities` (ambient) is the only grant source — latentCapabilities are never consulted.
 */
export async function visibleSquadIds(env: Env, auth: AuthContext): Promise<string[]> {
  const normalized: AuthContext = {
    ...auth,
    capabilities: auth.capabilities ?? [],
    role: auth.capabilities === undefined ? auth.role : 'member',
  }
  const resolved = await resolveAccessibleSquadIds(env, normalized, 'member')
  return resolved === null ? resolveAllSquadIds(env, { excludeHome: true }) : resolved
}

/**
 * Recent approved verdict records of ONE project, visible to THIS caller only: the project
 * must be readable by the caller and every record's task must sit on a squad the caller can
 * read. Throws on a DB error (callers decide how to degrade); returns [] for "nothing
 * visible", including a project the caller cannot read (no oracle).
 */
export async function listProjectVerdictRecords(
  env: Env,
  auth: AuthContext,
  projectId: string,
  limit: number = VERDICT_RECORD_LIMIT_MAX,
): Promise<VerdictRecord[]> {
  const bounded = Math.max(0, Math.min(Math.floor(limit), VERDICT_RECORD_LIMIT_MAX))
  if (bounded === 0) return []
  // Ambient grants only (never latentCapabilities): a directory seat with zero ambient
  // authority reads nothing here, exactly as it reads nothing from project_context.
  const access = projectReadAccessFromGrants(auth, auth.capabilities ?? [])
  const visibility = projectVisibilityClause(access)
  const project = await env.DB.prepare(`SELECT p.id FROM projects p WHERE p.id = ? AND ${visibility.sql}`)
    .bind(projectId, ...visibility.binds).first<{ id: string }>()
  if (!project) return []
  const squads = await visibleSquadIds(env, auth)
  if (squads.length === 0) return []
  const rows = await env.DB.prepare(VERDICT_RECORDS_SQL)
    .bind(projectId, access.workspaceAdmin ? 1 : 0, JSON.stringify([...new Set(squads)]), bounded, RESULT_READ_CHARS, env.TENANT_SLUG)
    .all<RecordRow>()
  return (rows.results ?? []).map((row) => ({
    record_kind: 'verdict_record',
    trust: 'evidence_not_instruction',
    task_id: row.task_id,
    verdict_id: row.verdict_id,
    decided_at: row.decided_at,
    decided_by: row.decided_by,
    runtime_receipt_id: safeRef(row.runtime_receipt_id),
    artifact_sha256: validSha(row.artifact_sha256),
    untrusted: buildUntrusted(row.title, row.result),
  }))
}

export interface OrientProjectVerdicts {
  project_id: string
  records: VerdictRecord[]
}

/**
 * Boot section for orient: the projects of the agent's own ASSIGNED, still-open tasks
 * (max 3, most recently touched first), each with up to 5 records. Visibility is derived
 * from the CALLER's grants, never from the oriented agent's: orienting a peer must not
 * widen what the caller can read. Per-project failures degrade to "omitted", never fail
 * orient.
 */
export async function listOrientProjectVerdicts(
  env: Env,
  auth: AuthContext,
  agentId: string,
): Promise<OrientProjectVerdicts[]> {
  const projects = await env.DB.prepare(
    `SELECT project_id FROM tasks
      WHERE assignee_agent_id = ?1 AND project_id IS NOT NULL AND status IN ('open','in_progress','review','blocked')
      GROUP BY project_id ORDER BY MAX(updated_at) DESC, project_id LIMIT ?2`,
  ).bind(agentId, ORIENT_PROJECT_MAX).all<{ project_id: string }>()
  const out: OrientProjectVerdicts[] = []
  for (const { project_id: projectId } of projects.results ?? []) {
    try {
      const records = await listProjectVerdictRecords(env, auth, projectId, VERDICT_RECORD_LIMIT_MAX)
      if (records.length > 0) out.push({ project_id: projectId, records })
    } catch {
      // omitted: boot must still work
    }
  }
  return out
}
