// scripts/lib/bulk-provision-core.mjs — roster-driven bulk agent provisioning,
// the transport-agnostic core.
//
// WHY THIS EXISTS (2026-09-02, kasra-code)
//
// Every one of Hadi's ~30 agents needs mint_agent_token to have run for it at
// least once, or it is not merely unauthorized — it is ABSENT from the OAuth
// consent screen (src/mcp/oauth-authorize.ts, SELECTION RULE 2: an unminted
// agent has no agent_member_bindings row, so there is nothing to consent to;
// fail closed, excluded, not offered as zero). And every mint-capable tool
// (mint_agent_token, provision_agent_connection, list_agent_tokens,
// revoke_agent_token, grant_agent_capability — src/mcp/provision.ts, every one
// gated `if (auth.boundAgentId) return fail(403, 'operator_principal_required')`)
// refuses ANY agent-bound caller outright. That gate is correct and is not
// touched here — it is what makes agent-to-agent escalation structurally
// impossible. So only an operator (owner/admin, unbound token) can ever run
// this, and this script turns 30 manual ceremonies into one reviewed command
// FOR THAT OPERATOR to run, once.
//
// This module builds on `provision_agent_connection`
// (src/mcp/provision.ts:941 — the composite create -> mint -> grant -> receipt
// transaction, src/members/agent-connection.ts) rather than reimplementing any
// of its steps. It adds exactly what a 30-row roster needs on top:
//
//   - pre-flight, READ-ONLY slug collision detection ACROSS THE WHOLE TENANT
//     (agents.slug is UNIQUE(squad_id, slug), NOT globally unique — the exact
//     ambiguity class deactivate_agent's `COUNT(*) FROM agents WHERE slug = ?`
//     guard exists to route around, src/mcp/provision.ts:1352-ish. A roster
//     that would create a same-named agent in a DIFFERENT squad than one that
//     already exists is refused before any write, naming both squads.)
//   - dry-run by default (the "safe mode" IS the default mode for a
//     credential-issuing tool)
//   - resumability by re-deriving intent from LIVE SERVER STATE every run,
//     never from a local state file — so re-running after a partial failure
//     just sees what already exists and skips it
//   - a receipt per agent containing the credential-CLAIM id (never the raw
//     token — mint_agent_token/provision_agent_connection already refuse to
//     return raw; this module only ever touches claim_id/fingerprint/token_id)
//   - a post-write, independent verification pass that does not trust the
//     write's own response: get_agent_profile (status active) + a live token
//     via list_agent_tokens (agent_member_bindings existing, in proxy)
//
// TRANSPORT-AGNOSTIC BY DESIGN: every live call goes through an injected
// `mcpCall(name, args) -> result` function. The CLI entrypoint
// (scripts/bulk-provision-agents.mjs) wires that to a real `fetch()` against
// the deployed MCP endpoint using whatever bearer token the operator already
// has. Tests wire it to `mcpApp.request(...)` in-process against a real
// migrated SQLite D1 (tests/helpers/sqlite-d1.ts + the real migration chain)
// so the roster logic is proven against the ACTUAL tool/capability/schema
// behavior, not a hand-rolled mock of it.

// ── slug validation (mirrors src/org/service.ts isValidSlug exactly) ─────────
// Client-side validation is a fast local rejection ONLY. The live collision
// check below (resolve_agent) is what actually decides "does this exist" —
// never trust the roster file's own claim about the world.
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function isValidSlugFormat(v) {
  return typeof v === 'string' && v.length >= 1 && v.length <= 48 && SLUG_RE.test(v)
}

const HOME_CAPABILITIES = new Set(['observer', 'member'])

/**
 * Parse + statically validate a roster document. Returns { ok, entries, errors }.
 * NEVER touches the network. Two classes of static error:
 *   - per-entry shape errors (bad slug format, missing name/squad, bad capability)
 *   - roster-internal slug collisions: the SAME slug used for TWO DIFFERENT
 *     squads within the file itself — this is the ambiguity class the whole
 *     script exists to keep out of the tenant, so it is refused before a
 *     single live call, not discovered mid-run.
 */
export function validateRoster(doc) {
  const errors = []
  const rawList = Array.isArray(doc) ? doc : Array.isArray(doc?.agents) ? doc.agents : null
  if (!rawList) {
    return { ok: false, entries: [], errors: ['roster must be a JSON array, or an object with an "agents" array'] }
  }

  const entries = []
  const bySlug = new Map() // slug -> [{ index, squad }]

  rawList.forEach((raw, index) => {
    const where = `agents[${index}]`
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`${where}: must be an object`)
      return
    }
    const slug = typeof raw.slug === 'string' ? raw.slug.trim().toLowerCase() : raw.slug
    const name = typeof raw.name === 'string' ? raw.name.trim() : raw.name
    const squad = typeof raw.squad === 'string' ? raw.squad.trim() : raw.squad
    const capability = raw.capability === undefined || raw.capability === null ? 'member' : raw.capability
    const role = raw.role === undefined ? undefined : raw.role
    const purpose = raw.purpose === undefined ? undefined : raw.purpose
    const model = raw.model === undefined ? undefined : raw.model

    if (!isValidSlugFormat(slug)) {
      errors.push(`${where}: invalid slug ${JSON.stringify(raw.slug)} (lowercase alnum + single hyphens, 1-48 chars)`)
      return
    }
    if (typeof name !== 'string' || name.length === 0) {
      errors.push(`${where} (${slug}): name is required`)
      return
    }
    if (typeof squad !== 'string' || squad.length === 0) {
      errors.push(`${where} (${slug}): squad is required (id or slug of the home squad)`)
      return
    }
    if (!HOME_CAPABILITIES.has(capability)) {
      errors.push(`${where} (${slug}): capability must be "observer" or "member" (got ${JSON.stringify(raw.capability)}) — provision_agent_connection never grants a home capability above member`)
      return
    }
    if (role !== undefined && typeof role !== 'string') {
      errors.push(`${where} (${slug}): role must be a string if present`)
      return
    }
    if (model !== undefined && typeof model !== 'string') {
      errors.push(`${where} (${slug}): model must be a string if present`)
      return
    }

    const entry = { index, slug, name, squad, capability, role, purpose, model }
    entries.push(entry)
    if (!bySlug.has(slug)) bySlug.set(slug, [])
    bySlug.get(slug).push(entry)
  })

  for (const [slug, group] of bySlug) {
    const squads = new Set(group.map((e) => e.squad))
    if (squads.size > 1) {
      errors.push(
        `slug "${slug}" appears ${group.length} times in the roster for DIFFERENT squads `
        + `(${[...squads].join(', ')}) — agents.slug is unique per squad, not tenant-wide, `
        + `and this exact ambiguity is what deactivate_agent's slug-sweep guard exists to `
        + `route around downstream. Fix the roster: use distinct slugs.`,
      )
    } else if (group.length > 1) {
      errors.push(`slug "${slug}" is listed ${group.length} times for the same squad (${group[0].squad}) — remove the duplicate row.`)
    }
  }

  return { ok: errors.length === 0, entries, errors }
}

// ── live plan: one roster entry -> what to actually call ────────────────────
//
// Resolves the roster entry against LIVE server state via two read-only tools:
//   squad_member_list  — resolves a squad ref (id or slug) to its canonical id
//                         (min:'observer', never mutates)
//   resolve_agent       — fuzzy name/slug search, min:'observer'; we filter its
//                         matches down to an EXACT (case-insensitive) slug match
//                         ourselves, since the server call is substring LIKE.
//
// Returns one of:
//   { kind: 'create',  homeSquadId }                        — no live agent has this slug anywhere
//   { kind: 'reuse',   agentId, homeSquadId }                — exact slug match IN the roster's own squad
//   { kind: 'collision', conflicts: [{ agentId, squadId, status }] } — exact slug match in a DIFFERENT squad
//   { kind: 'error',   reason }                              — squad ref didn't resolve, etc.
export async function planEntry(entry, { mcpCall, squadCache }) {
  let homeSquadId = squadCache.get(entry.squad)
  if (homeSquadId === undefined) {
    const squadResult = await mcpCall('squad_member_list', { squad: entry.squad })
    if (!squadResult.ok) {
      squadCache.set(entry.squad, null)
      return { kind: 'error', reason: `squad "${entry.squad}" did not resolve: ${squadResult.error}${squadResult.detail ? ' ' + JSON.stringify(squadResult.detail) : ''}` }
    }
    homeSquadId = squadResult.result.squad.id
    squadCache.set(entry.squad, homeSquadId)
  }
  if (homeSquadId === null) {
    return { kind: 'error', reason: `squad "${entry.squad}" did not resolve (cached failure)` }
  }

  const resolved = await mcpCall('resolve_agent', { query: entry.slug, include_inactive: true, limit: 100 })
  if (!resolved.ok) {
    return { kind: 'error', reason: `resolve_agent failed for "${entry.slug}": ${resolved.error}` }
  }
  const exact = (resolved.result.matches ?? []).filter(
    (m) => typeof m.slug === 'string' && m.slug.toLowerCase() === entry.slug,
  )
  if (exact.length === 0) {
    return { kind: 'create', homeSquadId }
  }

  const sameSquad = exact.filter((m) => m.squad_id === homeSquadId)
  const elsewhere = exact.filter((m) => m.squad_id !== homeSquadId)

  if (elsewhere.length > 0) {
    // P0 refusal: this slug already lives in a squad the roster did NOT name.
    // Do not create (would produce a second, cross-squad same-slug row) and do
    // not silently "reuse" a different context's identity either. Surface it.
    return {
      kind: 'collision',
      conflicts: elsewhere.map((m) => ({ agentId: m.id, squadId: m.squad_id, status: m.status, name: m.name })),
    }
  }

  // Exact match in the SAME squad the roster names -> this is the resumable
  // path: either already fully provisioned (issue_if_missing will report
  // agent_already_connected and we treat that as a skip) or created-but-never-
  // minted (issue_if_missing will mint it now — closing exactly the gap this
  // script exists to close for a half-onboarded agent).
  return { kind: 'reuse', agentId: sameSquad[0].id, homeSquadId }
}

/**
 * Execute (or dry-run) provisioning for one roster entry, given its plan.
 * Never called for a 'collision' or 'error' plan — the caller handles those
 * as refusals before reaching here.
 */
export async function provisionEntry(entry, plan, { mcpCall, requestIdPrefix, apply }) {
  // The request_id is scoped by (actor, request_id) server-side and replay is
  // fingerprint-checked against the ACTUAL request shape (agent_connection.ts
  // normalizeInput/replayOutcome) — the fingerprint includes `target`. A
  // roster row's plan can legitimately change shape ACROSS runs (a fresh
  // create the first time; a reuse of the now-existing agent the second time
  // a resumed run finds it) even though the slug is stable, so `plan.kind` is
  // folded into the id. Getting this wrong surfaces as a real, observed
  // failure mode: reusing `<prefix>:<slug>` verbatim across a create->reuse
  // transition trips the server's `request_id_conflict` refusal instead of
  // the intended graceful `agent_already_connected` skip.
  const requestId = `${requestIdPrefix}:${plan.kind}:${entry.slug}`.slice(0, 128)
  const credential = { action: 'issue_if_missing', label: entry.name, home_capability: entry.capability }

  const args = plan.kind === 'create'
    ? {
        request_id: requestId,
        new_agent: {
          home_squad: plan.homeSquadId,
          slug: entry.slug,
          name: entry.name,
          ...(entry.role ? { role: entry.role } : {}),
          ...(entry.model ? { model: entry.model } : {}),
        },
        credential,
      }
    : {
        request_id: requestId,
        existing_agent: plan.agentId,
        credential,
      }

  if (!apply) {
    return {
      status: 'dry_run',
      would: plan.kind === 'create' ? 'create_and_mint' : 'reuse_and_mint_if_missing',
      args,
    }
  }

  const outcome = await mcpCall('provision_agent_connection', args)
  if (outcome.ok) {
    const r = outcome.result
    return {
      status: 'provisioned',
      agent_disposition: r.receipt?.agent_disposition ?? null,
      agent_id: r.receipt?.agent_id ?? null,
      member_id: r.receipt?.member_id ?? null,
      token_id: r.credential?.tokenId ?? null,
      claim_id: r.credential?.claim?.claim_id ?? null,
      claim_fingerprint: r.credential?.claim?.fingerprint ?? null,
      claim_expires_at: r.credential?.claim?.expires_at ?? null,
      receipt_id: r.verification?.receiptId ?? null,
    }
  }

  if (outcome.error === 'agent_already_connected') {
    // Not a failure — the resumable "nothing to do" case. plan.agentId is set
    // for 'reuse'; for 'create' this error cannot occur (a brand-new agent has
    // no binding yet), so plan.agentId is only read when defined.
    return { status: 'skipped_already_connected', agent_id: plan.agentId ?? null }
  }

  return { status: 'error', error: outcome.error, detail: outcome.detail }
}

/**
 * Independently confirm an agent is consent-eligible per oauth-authorize.ts's
 * SELECTION RULE (status active + an agent_member_bindings row exists). This
 * module has no direct D1 access, so it uses the closest MCP-exposed proxy:
 *   - get_agent_profile -> status === 'active'
 *   - list_agent_tokens -> live_count >= 1 (a non-revoked token welded to a
 *     member proves a binding was created; mint_agent_token/
 *     provision_agent_connection are the only paths that create one)
 * This is NOT a re-read of agent_member_bindings itself (no MCP tool exposes
 * that table directly) — it is stated as a proxy, not equivalence, in every
 * caller-facing surface (CLI help, docs, receipts).
 */
export async function verifyConsentEligible(agentId, { mcpCall }) {
  if (!agentId) return { verified: false, reason: 'no_agent_id' }
  const profile = await mcpCall('get_agent_profile', { agent_id: agentId })
  if (!profile.ok) return { verified: false, reason: `get_agent_profile: ${profile.error}` }
  const active = profile.result.profile.status === 'active'

  const tokens = await mcpCall('list_agent_tokens', { agent: agentId })
  if (!tokens.ok) return { verified: false, reason: `list_agent_tokens: ${tokens.error}`, active }
  const hasLiveToken = (tokens.result.live_count ?? 0) >= 1

  return { verified: active && hasLiveToken, active, has_live_token: hasLiveToken }
}
