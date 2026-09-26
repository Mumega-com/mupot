#!/usr/bin/env node
// scripts/data-hygiene-audit.mjs — read-only classifier for mupot#1496.
//
// WHY THIS EXISTS
//
// Hadi, 2026-09-22 (mupot#1496): "the current data in mupot is garbage majority because
// we were building the system, but now we need to take data seriously." The mumega
// tenant's members/agents/squads/projects accumulated 3+ months of build-time debris —
// connector OAuth sessions that never had an invite accepted, throwaway test walkers,
// duplicate identities from renames, and scratch verification rows — sitting as
// first-class rows next to real production data with no way to tell them apart.
//
// This script is READ-ONLY. It classifies; it never writes. Mark-and-archive (the
// mupot#1496 ask) is a *separate*, human-gated step per issue's own instruction:
// "execution needs Hadi's go per row class (identity tables)." Nothing in this file
// calls a mutating tool, issues an UPDATE, or deletes anything.
//
// INPUT SHAPE
//
// The classifier is a pure function over plain arrays shaped exactly like the D1 tables
// it reads (see loadSnapshotFromDir / buildD1SelectStatements below for the exact
// columns). It never assumes a live D1 binding — a JSON snapshot (as produced by
// `wrangler d1 execute ... --json` per table, or hand-built fixtures in tests) is enough.
// The --d1 CLI path shells out to `wrangler d1 execute` with the SAME SELECTs and feeds
// the result through the identical classifier, so a future live run classifies exactly
// what this file's rules say — but that path is documented, not exercised, here (no D1
// access from this environment; see AGENTS/CLAUDE.md for why).
//
// CLASSES (one of, never more than one, per row):
//   real              — confirmed live/human/production data. Default is NEVER real;
//                        a row must clear an explicit bar (login identity, external
//                        human email, canonical bound-agent seat, or live recent
//                        activity) to land here.
//   test              — self-declared or strongly-named test/throwaway data (DNU,
//                        walker, canary, probe, "delete me", verify-scratch). These are
//                        the safest to archive: the name itself is the evidence.
//   connector-debris   — the #1496 "OAuth directory session created a member row with
//                        no invite ever accepted" shape: no login identity, no email,
//                        no capability grant, no activity beyond the instant of creation.
//   duplicate         — same identity (by normalized name, or by agent slug) already
//                        exists elsewhere with stronger evidence (login identity, live
//                        binding, more recent activity), and THIS row is the weaker copy.
//   dormant           — real once, or plausibly real, but inactive well past the
//                        dormancy window with no receipts to show for it. Distinct from
//                        connector-debris (dormant rows DID show some sign of use).
//   review            — every rule below fell through. THE CONSERVATIVE DEFAULT.
//                        "Rules must be conservative: when unsure -> review, never
//                        debris" (mupot#1496 ask #1) — review is the ONLY thing an
//                        unmatched row can become. No rule in this file emits
//                        connector-debris/test/duplicate/dormant except on POSITIVE,
//                        named evidence; every negative/absent-data path falls to review.
//
// EVIDENCE, PER ROW (see buildIndexes / the classify* functions):
//   - last activity: max(presence.last_seen_at, fleet_agents.last_reported_at,
//     task_counts.latest for the owning squad, created_at) with the SOURCE field named,
//     so a reviewer can see which signal (if any) is actually load-bearing.
//   - bindings: login identity present (member_identities), Telegram bound (has_tg),
//     owner_member_id (agents), capability count (capabilities.json, scope_type/member).
//   - naming signals: DNU / smoke / walker / canary / test / stm*/sm* prefixes / dgd /
//     duplicate names or slugs differing only by case.
//   - receipts: task_counts.n summed for the row's squad (members/agents don't have
//     their own task counts in this snapshot; squad-level receipts are the closest
//     available signal and are labelled as such, never conflated with a personal count).
//
// KNOWN GAP, STATED NOT HIDDEN: member_tokens carries no `last_used_at` column (the
// snapshot only has label/channel/created_at/revoked_at/expires_at — no hashes, no use
// timestamps). Every place this script would want "last token use" it instead reports
// token COUNT and creation recency, and says so in the evidence, rather than inventing a
// signal the data cannot support.
//
// THRESHOLDS (named constants, not magic numbers, so a reviewer can see exactly what
// "dormant" means and dispute the number):
//   RECENT_DAYS = 7   — activity within this window counts as "currently live".
//   DORMANT_DAYS = 30 — inactivity beyond this, with zero receipts, counts as dormant.
//     Chosen deliberately LONGER than the unrelated 14-day project
//     recommit_or_kill cycle (src/projects loop) — that boundary governs an automated
//     kill switch on live product loops; this is a one-off human-reviewed data-hygiene
//     pass and should err toward NOT flagging something that simply hasn't had its
//     14-day cycle event yet.
//
// USAGE
//   node scripts/data-hygiene-audit.mjs --dir <snapshot-dir> [--out <prefix>] [--asof <ISO>]
//   node scripts/data-hygiene-audit.mjs --d1 <db-name> [--remote] [--out <prefix>]  (documented, unexercised path)
//
// Snapshot dir must contain: members.json, member_identities.json, member_tokens.json,
// agents.json, squads.json, projects.json, capabilities.json, presence.json,
// fleet_agents.json, task_counts.json — each the JSON array a `SELECT * FROM <table>`
// (or the narrower projection in buildD1SelectStatements) would produce.

import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Constants — the whole rule surface in one place, so a reviewer can see every
// number and every regex without hunting through the classify* functions.
// ---------------------------------------------------------------------------

export const RECENT_DAYS = 7
export const DORMANT_DAYS = 30
// Projects carry their OWN native cadence concept (cycle_boundary_at / the
// recommit_or_kill loop documented in src/projects, a 14-day recommit-or-kill cycle
// on ACTIVE projects). A `planned` project that has sat untouched past one full cycle
// without ever being started is a distinct, project-specific staleness signal — using
// the general 30-day DORMANT_DAYS here would silently pass mupot#1496's own worked
// example (`pfc-neuraya`, planned 2026-09-04, still untouched 22 days later at the
// 2026-09-26 snapshot) straight through as "review" instead of flagging it.
export const PROJECT_PLANNED_STALE_DAYS = 14
export const CANONICAL_AGENT_EMAIL_DOMAIN = 'agents.mumega.com'

// Strong, self-declared debris/test markers. Word-boundary anchored so ordinary
// words are not caught (e.g. "contest" must not match "test").
export const RE_DNU = /\bdnu\b/i
export const RE_DELETE_ME = /delete\s*me/i
export const RE_TEST_STRONG = /\b(walker|canary|probe|smoke)\b/i
export const RE_TEST_WORD = /\btest\b/i
export const RE_VERIFY_SCRATCH = /verify-\d+|verify[-_]?proj|-verify-/i
export const RE_RETIRED = /-retired-|\(retired\)/i
// Short connector-family prefixes explicitly named in mupot#1496 ("stm*", "sm*",
// "dgd"). Anchored to the WHOLE slug/local-part (not a substring) and length-bounded
// so this cannot fire on an unrelated word that merely starts with "sm"/"stm".
export const RE_SHORT_CONNECTOR_PREFIX = /^(sm|stm)[a-z]{3,10}$/i
export const RE_DGD = /^dgd(-.*)?$/i

/**
 * Parse a timestamp that may be either ISO-8601 ("...T...Z") or the naive SQLite
 * "YYYY-MM-DD HH:MM:SS" shape (always UTC in this snapshot — D1/SQLite CURRENT_TIMESTAMP
 * has no offset). Returns epoch ms, or null if unparseable so callers can treat "unknown"
 * as unknown rather than silently coercing to 1970.
 */
export function toEpochMs(ts) {
  if (!ts) return null
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts) ? `${ts.replace(' ', 'T')}Z` : ts
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

export function daysBetween(fromMs, toMs) {
  if (fromMs == null || toMs == null) return null
  return (toMs - fromMs) / (24 * 60 * 60 * 1000)
}

function normName(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/\s*\(retired\)\s*$/i, '')
    .replace(/\s+/g, ' ')
}

// ---------------------------------------------------------------------------
// Snapshot loading
// ---------------------------------------------------------------------------

const SNAPSHOT_FILES = {
  members: 'members.json',
  memberIdentities: 'member_identities.json',
  memberTokens: 'member_tokens.json',
  agents: 'agents.json',
  squads: 'squads.json',
  projects: 'projects.json',
  capabilities: 'capabilities.json',
  presence: 'presence.json',
  fleetAgents: 'fleet_agents.json',
  taskCounts: 'task_counts.json',
}

export function loadSnapshotFromDir(dir) {
  const data = {}
  for (const [key, file] of Object.entries(SNAPSHOT_FILES)) {
    const raw = readFileSync(join(dir, file), 'utf8')
    data[key] = JSON.parse(raw)
  }
  return data
}

/**
 * The exact SELECTs a --d1 run would issue, kept next to the classifier so the
 * live path and the snapshot path are provably reading the same shape. This is
 * NOT exercised by tests or CI — no D1 access from this build environment — but
 * keeping it here (rather than in a runbook) means the next person who runs it
 * live is running the query this file's authors actually reviewed.
 */
export function buildD1SelectStatements() {
  return {
    members: `SELECT id, display_name, email, status, tenant, created_at, has_tg FROM members;`,
    memberIdentities: `SELECT member_id, provider, created_at FROM human_login_identities;`,
    memberTokens: `SELECT member_id, label, channel, created_at, revoked_at, expires_at FROM member_tokens;`,
    agents: `SELECT id, squad_id, slug, name, role, model, status, created_at, owner, owner_member_id, kind FROM agents;`,
    squads: `SELECT id, department_id, slug, name, kind, created_at, created_by_member_id FROM squads;`,
    projects: `SELECT id, slug, name, status, created_at, updated_at, assigned_squad_id, stalled, deploy_status FROM projects;`,
    capabilities: `SELECT member_id, scope_type, scope_id, capability FROM capabilities;`,
    presence: `SELECT agent_id, member_id, display_name, source, label, first_seen_at, last_seen_at FROM presence;`,
    fleetAgents: `SELECT agent_id, member_id, status, runtime, lifecycle, last_reported_at FROM fleet_agents;`,
    taskCounts: `SELECT squad_id, status, COUNT(*) AS n, MAX(created_at) AS latest FROM tasks GROUP BY squad_id, status;`,
  }
}

export function loadSnapshotFromD1(dbName, { remote = false } = {}) {
  const selects = buildD1SelectStatements()
  const data = {}
  for (const [key, sql] of Object.entries(selects)) {
    const flags = ['d1', 'execute', dbName, '--command', sql, '--json']
    flags.push(remote ? '--remote' : '--local')
    const out = execFileSync('npx', ['wrangler', ...flags], { encoding: 'utf8' })
    const parsed = JSON.parse(out)
    // wrangler d1 execute --json returns [{ results: [...], success, meta }]
    data[key] = Array.isArray(parsed) ? (parsed[0]?.results ?? []) : (parsed?.results ?? [])
  }
  return data
}

// ---------------------------------------------------------------------------
// Indexing — build every lookup the classify* functions need, once, up front.
// ---------------------------------------------------------------------------

export function computeSnapshotAsOf(data, override) {
  if (override) {
    const ms = toEpochMs(override)
    if (ms != null) return ms
  }
  let max = 0
  const consider = (ts) => {
    const ms = toEpochMs(ts)
    if (ms != null && ms > max) max = ms
  }
  for (const r of data.presence || []) consider(r.last_seen_at)
  for (const r of data.fleetAgents || []) consider(r.last_reported_at)
  for (const r of data.taskCounts || []) consider(r.latest)
  for (const r of data.members || []) consider(r.created_at)
  for (const r of data.agents || []) consider(r.created_at)
  for (const r of data.memberTokens || []) consider(r.created_at)
  return max || Date.now()
}

export function buildIndexes(data) {
  const presenceByMember = new Map()
  const presenceByAgent = new Map()
  for (const r of data.presence || []) {
    if (r.member_id) {
      const arr = presenceByMember.get(r.member_id) || []
      arr.push(r)
      presenceByMember.set(r.member_id, arr)
    }
    if (r.agent_id) {
      const arr = presenceByAgent.get(r.agent_id) || []
      arr.push(r)
      presenceByAgent.set(r.agent_id, arr)
    }
  }

  const fleetByAgent = new Map()
  const fleetByMember = new Map()
  for (const r of data.fleetAgents || []) {
    if (r.agent_id) fleetByAgent.set(r.agent_id, r)
    if (r.member_id) {
      const arr = fleetByMember.get(r.member_id) || []
      arr.push(r)
      fleetByMember.set(r.member_id, arr)
    }
  }

  const identitiesByMember = new Set((data.memberIdentities || []).map((r) => r.member_id))

  const tokensByMember = new Map()
  for (const r of data.memberTokens || []) {
    const arr = tokensByMember.get(r.member_id) || []
    arr.push(r)
    tokensByMember.set(r.member_id, arr)
  }

  const capsByMember = new Map()
  const capsBySquad = new Map()
  for (const r of data.capabilities || []) {
    if (r.member_id) {
      const arr = capsByMember.get(r.member_id) || []
      arr.push(r)
      capsByMember.set(r.member_id, arr)
    }
    if (r.scope_type === 'squad' && r.scope_id) {
      const arr = capsBySquad.get(r.scope_id) || []
      arr.push(r)
      capsBySquad.set(r.scope_id, arr)
    }
  }

  const taskCountsBySquad = new Map()
  for (const r of data.taskCounts || []) {
    const cur = taskCountsBySquad.get(r.squad_id) || { total: 0, latest: null, byStatus: {} }
    cur.total += Number(r.n) || 0
    cur.byStatus[r.status] = (cur.byStatus[r.status] || 0) + (Number(r.n) || 0)
    const ms = toEpochMs(r.latest)
    if (ms != null && (cur.latest == null || ms > cur.latest)) cur.latest = ms
    taskCountsBySquad.set(r.squad_id, cur)
  }

  const agentsBySquad = new Map()
  const agentsBySlug = new Map()
  for (const r of data.agents || []) {
    if (r.squad_id) {
      const arr = agentsBySquad.get(r.squad_id) || []
      arr.push(r)
      agentsBySquad.set(r.squad_id, arr)
    }
    const arr = agentsBySlug.get(r.slug) || []
    arr.push(r)
    agentsBySlug.set(r.slug, arr)
  }

  const membersByNormName = new Map()
  for (const r of data.members || []) {
    const key = normName(r.display_name)
    if (!key) continue
    const arr = membersByNormName.get(key) || []
    arr.push(r)
    membersByNormName.set(key, arr)
  }

  return {
    presenceByMember,
    presenceByAgent,
    fleetByAgent,
    fleetByMember,
    identitiesByMember,
    tokensByMember,
    capsByMember,
    capsBySquad,
    taskCountsBySquad,
    agentsBySquad,
    agentsBySlug,
    membersByNormName,
  }
}

// ---------------------------------------------------------------------------
// Shared evidence helpers
// ---------------------------------------------------------------------------

function lastActivityFor({ presenceRows = [], fleetRow = null, squadReceipts = null, createdAt }) {
  let best = { ms: toEpochMs(createdAt), source: 'created_at' }
  for (const p of presenceRows) {
    const ms = toEpochMs(p.last_seen_at)
    if (ms != null && (best.ms == null || ms > best.ms)) best = { ms, source: 'presence.last_seen_at' }
  }
  if (fleetRow) {
    const ms = toEpochMs(fleetRow.last_reported_at)
    if (ms != null && (best.ms == null || ms > best.ms)) best = { ms, source: 'fleet_agents.last_reported_at' }
  }
  if (squadReceipts && squadReceipts.latest != null) {
    if (best.ms == null || squadReceipts.latest > best.ms) {
      best = { ms: squadReceipts.latest, source: 'squad task_counts.latest (squad-level, not personal)' }
    }
  }
  return best
}

function nameSignals(...texts) {
  const hay = texts.filter(Boolean).join(' ')
  const hits = []
  if (RE_DNU.test(hay)) hits.push('dnu')
  if (RE_DELETE_ME.test(hay)) hits.push('delete-me')
  if (RE_TEST_STRONG.test(hay)) hits.push('walker/canary/probe/smoke')
  if (RE_TEST_WORD.test(hay)) hits.push('test')
  if (RE_VERIFY_SCRATCH.test(hay)) hits.push('verify-scratch')
  if (RE_RETIRED.test(hay)) hits.push('retired-marker')
  if (RE_SHORT_CONNECTOR_PREFIX.test(hay.trim())) hits.push('sm*/stm* connector-family prefix')
  if (RE_DGD.test(hay.trim())) hits.push('dgd tenant-connector prefix')
  return hits
}

// ---------------------------------------------------------------------------
// classifyMember
// ---------------------------------------------------------------------------

export function classifyMember(member, ctx) {
  const { asOf, idx } = ctx
  const hasIdentity = idx.identitiesByMember.has(member.id)
  const tokens = idx.tokensByMember.get(member.id) || []
  const caps = idx.capsByMember.get(member.id) || []
  const presenceRows = idx.presenceByMember.get(member.id) || []
  const fleetRows = idx.fleetByMember.get(member.id) || []
  const signals = nameSignals(member.display_name, member.email)
  const activity = lastActivityFor({ presenceRows, fleetRow: fleetRows[0] || null, createdAt: member.created_at })
  const ageDays = daysBetween(activity.ms, asOf)
  const emailDomain = (member.email || '').split('@')[1]?.toLowerCase() || null
  const nameGroup = (idx.membersByNormName.get(normName(member.display_name)) || []).filter((m) => m.id !== member.id)
  const hasLiveBinding = presenceRows.length > 0 || fleetRows.length > 0 || caps.length > 0

  const evidence = {
    last_activity: activity.ms ? new Date(activity.ms).toISOString() : null,
    last_activity_source: activity.source,
    has_login_identity: hasIdentity,
    telegram_bound: !!member.has_tg,
    email_domain: emailDomain,
    capabilities_count: caps.length,
    token_count: tokens.length,
    naming_signals: signals,
    duplicate_name_siblings: nameGroup.map((m) => m.id),
    created_at: member.created_at,
    status: member.status,
  }

  // R-M1: an authenticated human login is ground truth membership.
  if (hasIdentity) {
    return { id: member.id, class: 'real', reasons: ['has a human_login_identities row (OAuth login) — ground truth membership'], evidence }
  }

  // R-M2: canonical bound-agent seat email (kasra@/loom@/river@/mumega-brain@agents.mumega.com).
  // These back real, actively-capable squad-core agents (verified via capabilities.json).
  if (emailDomain === CANONICAL_AGENT_EMAIL_DOMAIN && caps.length > 0) {
    return { id: member.id, class: 'real', reasons: [`canonical bound-agent seat (@${CANONICAL_AGENT_EMAIL_DOMAIN}) with ${caps.length} capability grant(s)`], evidence }
  }

  // R-M3: a distinct external human email (not the agent-seat domain, not empty) is
  // treated as a known contact even before they have logged in — Gavin Kelpin,
  // Bardiya Rahimi and similar rows are real named humans awaiting/skipping login.
  if (emailDomain && emailDomain !== CANONICAL_AGENT_EMAIL_DOMAIN) {
    return { id: member.id, class: 'real', reasons: [`distinct external email (${emailDomain}) — known human contact, not yet logged in or login not required`], evidence }
  }

  // R-M4: explicit self-declared debris marker beats everything below.
  if (signals.includes('dnu') || signals.includes('delete-me') || signals.includes('walker/canary/probe/smoke')) {
    return { id: member.id, class: 'test', reasons: [`self-declared test/debris marker in name: ${signals.join(', ')}`], evidence }
  }

  // R-M5: duplicate display name, and THIS row carries no live binding at all —
  // a live-bound duplicate (e.g. an active fleet body sharing a canonical name)
  // is deliberately routed to `review` instead, never auto-archived.
  if (nameGroup.length > 0 && !hasLiveBinding) {
    return {
      id: member.id,
      class: 'duplicate',
      reasons: [`shares normalized display_name with ${nameGroup.length} other member row(s); no login identity, no capability, no presence/fleet binding on this row`],
      evidence,
    }
  }

  // R-M6: classic connector-debris shape — no identity, no email, no capability, no
  // token beyond at most one, and activity never moved past the moment of creation.
  const createdMs = toEpochMs(member.created_at)
  const noActivityBeyondCreation = activity.source === 'created_at' || (createdMs != null && activity.ms != null && Math.abs(activity.ms - createdMs) < 5 * 60 * 1000)
  if (!member.email && caps.length === 0 && tokens.length <= 1 && !presenceRows.length && !fleetRows.length && noActivityBeyondCreation) {
    return {
      id: member.id,
      class: 'connector-debris',
      reasons: ['no login identity, no email, no capability grant, no presence/fleet activity beyond the moment of creation — the #1496 "connector session, invite never accepted" shape'],
      evidence,
    }
  }

  // R-M7: dormant — some history, but nothing recent and nothing held.
  if (ageDays != null && ageDays > DORMANT_DAYS && caps.length === 0) {
    return { id: member.id, class: 'dormant', reasons: [`no activity in ${Math.round(ageDays)}d (> ${DORMANT_DAYS}d threshold) and holds no capability`], evidence }
  }

  // R-M8: fall through. Conservative default — never guess debris. If a naming signal
  // fired but wasn't enough on its own (e.g. holds a real capability grant), say so —
  // a reviewer scanning the `review` bucket should not have to re-derive this.
  const fallReason = signals.length
    ? `naming signal (${signals.join(', ')}) present but row holds live evidence (capability/activity) — needs a human look, not auto-archived`
    : 'no rule matched with enough confidence — needs a human look'
  return { id: member.id, class: 'review', reasons: [fallReason], evidence }
}

// ---------------------------------------------------------------------------
// classifyAgent
// ---------------------------------------------------------------------------

export function classifyAgent(agent, ctx) {
  const { asOf, idx } = ctx
  const presenceRows = idx.presenceByAgent.get(agent.id) || []
  const fleetRow = idx.fleetByAgent.get(agent.id) || null
  const squadReceipts = idx.taskCountsBySquad.get(agent.squad_id) || null
  const activity = lastActivityFor({ presenceRows, fleetRow, squadReceipts, createdAt: agent.created_at })
  const ageDays = daysBetween(activity.ms, asOf)
  const signals = nameSignals(agent.slug, agent.name)
  const siblings = (idx.agentsBySlug.get(agent.slug) || []).filter((a) => a.id !== agent.id)
  const activeSiblingSameSlug = siblings.find((a) => a.status === 'active')

  const evidence = {
    last_activity: activity.ms ? new Date(activity.ms).toISOString() : null,
    last_activity_source: activity.source,
    status: agent.status,
    kind: agent.kind,
    squad_id: agent.squad_id,
    owner_member_id: agent.owner_member_id || null,
    naming_signals: signals,
    duplicate_slug_siblings: siblings.map((a) => a.id),
    squad_task_receipts: squadReceipts ? squadReceipts.total : 0,
    created_at: agent.created_at,
  }

  // R-A1: explicit debris marker.
  if (signals.includes('dnu') || signals.includes('delete-me')) {
    return { id: agent.id, class: 'test', reasons: [`self-declared debris marker: ${signals.join(', ')}`], evidence }
  }

  // R-A2: strong test-shaped naming (walker/canary/probe/smoke).
  if (signals.includes('walker/canary/probe/smoke')) {
    return { id: agent.id, class: 'test', reasons: [`test-shaped name: ${signals.join(', ')}`], evidence }
  }

  // R-A3: self-declared retirement.
  if (signals.includes('retired-marker')) {
    return { id: agent.id, class: 'dormant', reasons: ['slug/name carries an explicit "(retired)" marker'], evidence }
  }

  // R-A4: superseded — this row is inactive and an ACTIVE sibling shares its slug
  // (the identity moved to a different squad; this row is the leftover).
  if (agent.status === 'inactive' && activeSiblingSameSlug) {
    return {
      id: agent.id,
      class: 'dormant',
      reasons: [`inactive; slug "${agent.slug}" is active elsewhere (agent ${activeSiblingSameSlug.id}, squad ${activeSiblingSameSlug.squad_id}) — superseded, not distinct debris`],
      evidence,
    }
  }

  // R-A5: inactive and long past the dormancy window with no receipts.
  if (agent.status === 'inactive' && ageDays != null && ageDays > DORMANT_DAYS && evidence.squad_task_receipts === 0) {
    return { id: agent.id, class: 'dormant', reasons: [`inactive for ${Math.round(ageDays)}d (> ${DORMANT_DAYS}d) with zero squad task receipts`], evidence }
  }

  // R-A6: inactive but recent/ambiguous — do not guess.
  if (agent.status === 'inactive') {
    return { id: agent.id, class: 'review', reasons: ['inactive but activity is recent or squad has live receipts — needs a human look before archiving'], evidence }
  }

  // R-A7: active with GENUINE recent activity (presence, fleet, or squad receipts —
  // never the bare created_at fallback, which would let "created 3 days ago and never
  // seen since" pass as real just because it's young).
  if (agent.status === 'active' && activity.source !== 'created_at' && ageDays != null && ageDays <= RECENT_DAYS) {
    return { id: agent.id, class: 'real', reasons: [`active with activity ${Math.round(ageDays)}d ago via ${activity.source} (<= ${RECENT_DAYS}d)`], evidence }
  }

  // R-A8: active, but zero presence/fleet binding ever and squad has zero receipts,
  // long past creation — likely a seat that was created and never actually run.
  if (agent.status === 'active' && !presenceRows.length && !fleetRow && evidence.squad_task_receipts === 0 && ageDays != null && ageDays > DORMANT_DAYS) {
    return {
      id: agent.id,
      class: 'dormant',
      reasons: [`active flag but no presence/fleet row ever seen and zero squad receipts, created ${Math.round(ageDays)}d ago — looks like a seat that was never actually run`],
      evidence,
    }
  }

  // R-A9: fall through.
  const fallReason = signals.length
    ? `naming signal (${signals.join(', ')}) present but row holds live evidence (activity/receipts) — needs a human look, not auto-archived`
    : 'no rule matched with enough confidence — needs a human look'
  return { id: agent.id, class: 'review', reasons: [fallReason], evidence }
}

// ---------------------------------------------------------------------------
// classifySquad
// ---------------------------------------------------------------------------

export function classifySquad(squad, ctx) {
  const { asOf, idx } = ctx
  const agentsHere = idx.agentsBySquad.get(squad.id) || []
  const capsHere = idx.capsBySquad.get(squad.id) || []
  const receipts = idx.taskCountsBySquad.get(squad.id) || null
  const signals = nameSignals(squad.slug, squad.name)
  const hasActiveAgent = agentsHere.some((a) => a.status === 'active')
  const createdMs = toEpochMs(squad.created_at)
  const ageDays = daysBetween(createdMs, asOf)

  const evidence = {
    naming_signals: signals,
    kind: squad.kind,
    agent_count: agentsHere.length,
    active_agent_count: agentsHere.filter((a) => a.status === 'active').length,
    capability_grant_count: capsHere.length,
    squad_task_receipts: receipts ? receipts.total : 0,
    last_receipt_at: receipts && receipts.latest ? new Date(receipts.latest).toISOString() : null,
    created_at: squad.created_at,
  }

  // R-S1: explicit debris/test naming.
  if (signals.includes('dnu') || signals.includes('walker/canary/probe/smoke') || signals.includes('delete-me')) {
    return { id: squad.id, class: 'test', reasons: [`test/debris-shaped squad name: ${signals.join(', ')}`], evidence }
  }

  // R-S2: home squads inherit their sole owning agent's liveness rather than being
  // judged as empty — a home squad with zero OTHER agents and zero receipts is
  // structural scaffolding, not first-class debris on its own.
  if (squad.kind === 'home') {
    if (!hasActiveAgent && (!receipts || receipts.total === 0) && ageDays != null && ageDays > DORMANT_DAYS) {
      return { id: squad.id, class: 'dormant', reasons: [`home squad, no active agent, zero receipts, ${Math.round(ageDays)}d old`], evidence }
    }
    return { id: squad.id, class: 'review', reasons: ['home squad — classify jointly with its owning agent, not standalone'], evidence }
  }

  // R-S3: never had any agent and never had a receipt — empty scaffold.
  if (agentsHere.length === 0 && capsHere.length === 0 && (!receipts || receipts.total === 0)) {
    return { id: squad.id, class: 'connector-debris', reasons: ['zero agents, zero capability grants, zero task receipts — empty scaffold, never used'], evidence }
  }

  // R-S4: had agents once, all now inactive, no receipts, old.
  if (agentsHere.length > 0 && !hasActiveAgent && (!receipts || receipts.total === 0) && ageDays != null && ageDays > DORMANT_DAYS) {
    return { id: squad.id, class: 'dormant', reasons: [`all ${agentsHere.length} agent(s) inactive, zero receipts, squad is ${Math.round(ageDays)}d old`], evidence }
  }

  // R-S5: live signal present.
  if (hasActiveAgent || (receipts && receipts.total > 0)) {
    return { id: squad.id, class: 'real', reasons: ['has an active agent and/or task receipts'], evidence }
  }

  // R-S6: fall through.
  return { id: squad.id, class: 'review', reasons: ['no rule matched with enough confidence — needs a human look'], evidence }
}

// ---------------------------------------------------------------------------
// classifyProject
// ---------------------------------------------------------------------------

export function classifyProject(project, ctx) {
  const { asOf } = ctx
  const signals = nameSignals(project.slug, project.name)
  const updatedMs = toEpochMs(project.updated_at) ?? toEpochMs(project.created_at)
  const ageDays = daysBetween(updatedMs, asOf)

  const evidence = {
    naming_signals: signals,
    status: project.status,
    stalled: !!project.stalled,
    deploy_status: project.deploy_status,
    created_at: project.created_at,
    updated_at: project.updated_at || null,
    days_since_update: ageDays == null ? null : Math.round(ageDays),
  }

  // R-P1: explicit test/verify-scratch/canary naming.
  if (signals.includes('dnu') || signals.includes('walker/canary/probe/smoke') || signals.includes('verify-scratch')) {
    return { id: project.id, class: 'test', reasons: [`test/verify-shaped project name: ${signals.join(', ')}`], evidence }
  }

  // R-P2: mupot's own stall detector already flagged it — trust that product signal.
  if (project.stalled) {
    return { id: project.id, class: 'dormant', reasons: ['stalled=1 (mupot stall detector already flagged this project)'], evidence }
  }

  // R-P3: already archived — audit confirms, no further action implied.
  if (project.status === 'archived') {
    return { id: project.id, class: 'dormant', reasons: ['already archived — audit confirms, no further action needed'], evidence }
  }

  // R-P4: planned and untouched past one full recommit-or-kill cycle (see
  // PROJECT_PLANNED_STALE_DAYS above for why this threshold differs from DORMANT_DAYS).
  if (project.status === 'planned' && ageDays != null && ageDays > PROJECT_PLANNED_STALE_DAYS) {
    return { id: project.id, class: 'dormant', reasons: [`status=planned, untouched for ${Math.round(ageDays)}d (> ${PROJECT_PLANNED_STALE_DAYS}d recommit-cycle threshold)`], evidence }
  }

  // R-P5: active is real.
  if (project.status === 'active') {
    return { id: project.id, class: 'real', reasons: ['status=active'], evidence }
  }

  // R-P6: fall through (e.g. planned but still within the window).
  return { id: project.id, class: 'review', reasons: ['no rule matched with enough confidence — needs a human look'], evidence }
}

// ---------------------------------------------------------------------------
// runAudit — orchestration
// ---------------------------------------------------------------------------

const CLASS_ORDER = ['test', 'connector-debris', 'duplicate', 'dormant', 'review', 'real']

export function runAudit(data, opts = {}) {
  const asOf = computeSnapshotAsOf(data, opts.asOf)
  const idx = buildIndexes(data)
  const ctx = { asOf, idx }

  const members = (data.members || []).map((m) => classifyMember(m, ctx))
  const agents = (data.agents || []).map((a) => classifyAgent(a, ctx))
  const squads = (data.squads || []).map((s) => classifySquad(s, ctx))
  const projects = (data.projects || []).map((p) => classifyProject(p, ctx))

  const totals = {}
  for (const [key, rows] of Object.entries({ members, agents, squads, projects })) {
    totals[key] = {}
    for (const c of CLASS_ORDER) totals[key][c] = 0
    for (const r of rows) totals[key][r.class] = (totals[key][r.class] || 0) + 1
  }

  return { asOf: new Date(asOf).toISOString(), members, agents, squads, projects, totals }
}

function sortWorstFirst(rows) {
  const rank = new Map(CLASS_ORDER.map((c, i) => [c, i]))
  return [...rows].sort((a, b) => (rank.get(a.class) ?? 99) - (rank.get(b.class) ?? 99))
}

function nameFor(kind, id, data) {
  const table = { members: 'members', agents: 'agents', squads: 'squads', projects: 'projects' }[kind]
  const row = (data[table] || []).find((r) => r.id === id)
  if (!row) return id
  return row.display_name || row.name || row.slug || id
}

export function toMarkdown(result, data) {
  const lines = []
  lines.push(`# Data hygiene audit — as of ${result.asOf}`, '')
  for (const kind of ['members', 'agents', 'squads', 'projects']) {
    const rows = sortWorstFirst(result[kind])
    lines.push(`## ${kind} (${rows.length})`, '')
    lines.push('| id | name | class | reason |', '|---|---|---|---|')
    for (const r of rows) {
      const name = nameFor(kind, r.id, data)
      const reason = (r.reasons[0] || '').replace(/\|/g, '\\|')
      lines.push(`| ${r.id} | ${name} | ${r.class} | ${reason} |`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { dir: null, d1: null, remote: false, out: null, asof: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dir') out.dir = argv[++i]
    else if (a === '--d1') out.d1 = argv[++i]
    else if (a === '--remote') out.remote = true
    else if (a === '--out') out.out = argv[++i]
    else if (a === '--asof') out.asof = argv[++i]
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.dir && !args.d1) {
    console.error('Usage: node scripts/data-hygiene-audit.mjs --dir <snapshot-dir> [--out <prefix>] [--asof <ISO>]')
    console.error('   or: node scripts/data-hygiene-audit.mjs --d1 <db-name> [--remote] [--out <prefix>]')
    process.exit(1)
  }

  const data = args.d1 ? loadSnapshotFromD1(args.d1, { remote: args.remote }) : loadSnapshotFromDir(args.dir)
  const result = runAudit(data, { asOf: args.asof })
  const md = toMarkdown(result, data)

  if (args.out) {
    writeFileSync(`${args.out}.json`, JSON.stringify(result, null, 2))
    writeFileSync(`${args.out}.md`, md)
    console.log(`Wrote ${args.out}.json and ${args.out}.md`)
  } else {
    console.log(JSON.stringify(result.totals, null, 2))
    console.log('')
    console.log(md)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
