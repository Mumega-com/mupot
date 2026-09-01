// mupot — seat enrollment page (GET /enroll, POST /enroll/mint).
//
// The pot already supports many keys per person and per seat (`member_tokens`
// has no unique constraint on (member_id, agent_id); `label` is the seat name
// since migrations/0002_members.sql). What was missing is a single page that
// lets a signed-in human CHOOSE an agent they may act as and COIN a
// workspace-channel key labelled with this seat — plus any MCP refusal that
// cannot resolve identity pointing HERE instead of dying as prose.
//
// This module is the seat-aware sibling of src/dashboard/agent-token.ts:
//   loadEnrollView(...)     → signed-in human + seat + consentable agents + live keys
//   enrollPageBody(...)     → HTML (GET /enroll)
//   enrollMintedBody(...)   → HTML (show-once after POST /enroll/mint)
//   enrollUrl(...)          → the one absolute URL every MCP dead-end links to
//
// The route handlers live in src/dashboard/index.ts. Minting goes through the
// SAME mintAgentBoundToken helper that POST /admin/agent-token/mint and
// mint_agent_token use — never a second write path, never hand-rolled SQL
// against member_tokens. Authorization is the SAME bar mint_agent_token
// enforces: operator principal + admin on the target agent's squad.
//
// Eligibility for the picker is the OAuth consent rule (listConsentableAgents):
// active agent, agent_member_bindings row, human holds admin on its squad.
// Do not invent a looser list.

import { html, raw as honoRaw } from 'hono/html'
import type { AuthContext, Env } from '../types'
import { canOnSquad } from '../auth/capability'
import { describeOrgStanding } from '../auth/refusal'
import { TOKEN_LIVE_PREDICATE, nowSqlUtc } from '../auth/token-lifecycle'
import { listConsentableAgents, type ConsentableAgent } from '../mcp/oauth-authorize'
import { mcpEndpoint, mcpServerKey } from './connect'

export const DEFAULT_ENROLL_SEAT = 'unnamed-seat'

export interface EnrollLiveKey {
  label: string
  channel: string
  created_at: string
}

export interface EnrollAgent extends ConsentableAgent {
  liveKeys: EnrollLiveKey[]
}

export interface EnrollView {
  principal: string
  memberId: string | null
  seat: string
  preselectedAgent: string | null
  agents: EnrollAgent[]
}

/** Absolute enrollment URL, built in exactly one place. Optional seat is
 *  query-encoded; omit or blank → `/enroll` with no guess. */
export function enrollUrl(origin: string, seat?: string | null): string {
  const base = origin.replace(/\/+$/, '')
  const trimmed = (seat ?? '').trim()
  if (!trimmed) return `${base}/enroll`
  return `${base}/enroll?seat=${encodeURIComponent(trimmed)}`
}

/** Seat label for the form: honour `?seat=` when present, otherwise an honest
 *  default — never a guessed harness name. Capped at 64 (member_tokens.label). */
export function normalizeEnrollSeat(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim().slice(0, 64)
  return trimmed.length > 0 ? trimmed : DEFAULT_ENROLL_SEAT
}

/** Paste-ready Cursor/Claude MCP JSON. Reuses connect.ts endpoint + server-key
 *  helpers. Always a `<MEMBER_TOKEN>` placeholder — the raw is shown once
 *  beside this snippet, never woven into it. The seat header is the point. */
export function enrollClientSnippet(slug: string, origin: string, seat: string): string {
  const key = mcpServerKey(slug)
  return JSON.stringify(
    {
      mcpServers: {
        [key]: {
          type: 'http',
          url: mcpEndpoint(origin),
          headers: {
            Authorization: 'Bearer <MEMBER_TOKEN>',
            'x-mupot-seat': seat,
          },
        },
      },
    },
    null,
    2,
  )
}

/**
 * Same authorization mint_agent_token enforces (src/mcp/provision.ts):
 *   - an agent-bound caller is refused (operator_principal_required)
 *   - the caller must hold admin on the target agent's squad (org/dept inherit)
 *
 * This page is a convenience surface. It must never mint what mint_agent_token
 * would refuse.
 *
 * ── THE SQUAD-ADMIN vs ORG-ADMIN DELTA, AS A DECISION (not an oversight) ──────
 *
 * Three doors mint the same artifact and they do NOT agree on the bar:
 *
 *   mint_agent_token (MCP)        squad admin on the target agent's squad
 *   POST /enroll/mint (here)      squad admin on the target agent's squad
 *   POST /admin/agent-token/mint  isOrgAdmin
 *
 * This route deliberately matches the MCP primitive, not its dashboard sibling.
 * The reasoning, recorded so nobody has to re-derive it from a diff:
 *
 *   1. The looser-looking bar is the ALREADY-REACHABLE one. A squad admin who
 *      can mint via mint_agent_token today gains no new power from this page —
 *      it is the same capability behind a form instead of a tool call. Gating
 *      the page at org admin would not close a hole; it would only push the
 *      same person back to the MCP tool to do the identical thing, which is how
 *      you teach people to route around the surface you can see.
 *   2. The org-admin bar on /admin/agent-token is an over-restriction of ONE
 *      surface, not the pot's intended policy. Treating it as the policy would
 *      mean the MCP tool has been over-permissive since it shipped — a much
 *      larger claim, and one no gate has made.
 *   3. Squad admin is not a weak scope here: the grant the minted token records
 *      is hard-clamped to squad scope and capability <= 'member'
 *      (prepareAgentBoundTokenMintForBinding, "THE ESCALATION GUARD"). A squad
 *      admin minting on their own squad cannot manufacture authority they do
 *      not already hold.
 *
 * If the intended policy is in fact org admin everywhere, the fix is to raise
 * mint_agent_token — the primitive — and let both dashboard routes inherit it.
 * Do not raise this route alone: that re-creates the divergence in the other
 * direction and leaves the tool as the soft path.
 *
 * Reviewed by Athena, 2026-09-01 (adversarial pass on PR #1254): "NO widening
 * beyond mint_agent_token's bar ... that bar is an over-restriction of one
 * surface; enroll matches the MCP primitive."
 */
export async function authorizeEnrollMint(
  env: Env,
  auth: AuthContext,
  squadId: string,
): Promise<{ ok: true } | { ok: false; reason: 'operator_principal_required' | 'squad_admin_required' }> {
  if (auth.boundAgentId) return { ok: false, reason: 'operator_principal_required' }
  const grants = auth.capabilities ?? []
  if (!(await canOnSquad(env, grants, squadId, 'admin'))) {
    return { ok: false, reason: 'squad_admin_required' }
  }
  return { ok: true }
}

// ── per-member mint throttle ──────────────────────────────────────────────────
//
// A brake on a runaway loop, NOT an authorization boundary — CSRF (the
// dashboard-wide Origin check) and squad-admin authz are what actually stop an
// attacker. This only bounds how fast a principal who is already allowed to mint
// can do so, which matters because every mint is a live credential and the page
// is one form submit away from a held-down key.
//
// Keyed on the MEMBER, same reasoning as checkBootstrapSelfRateLimit: an
// IP-keyed limiter is bypassed by rotating IPs, but the member id comes from a
// verified Google identity and cannot be rotated at will. Independent budget
// from that limiter and from the OAuth door's B2 — three different actions, and
// sharing a counter would let one starve another.
//
// The ceiling is 10/hour rather than bootstrap_self's 5 because THIS page's
// stated purpose is enrolling several seats in one sitting (laptop, server,
// cloud) — 5 would refuse a legitimate first setup. 10 still stops a loop dead.
export const ENROLL_MINT_RL_MAX = 10
export const ENROLL_MINT_RL_TTL = 3600 // seconds (1 hour)

export interface EnrollRateLimitResult {
  allowed: boolean
  retryAfter: number
}

/** Consumed BEFORE the mint and before the agent is resolved: a refused or
 *  malformed attempt is exactly the abuse shape worth throttling, so it burns
 *  budget too. Fail-open on KV trouble — same posture as the sibling limiters;
 *  the authz gate below is what must never fail open, and it does not. */
export async function checkEnrollMintRateLimit(
  env: Env,
  memberId: string,
): Promise<EnrollRateLimitResult> {
  const key = `enroll-mint-rl:${memberId}`
  try {
    const raw = await env.SESSIONS.get(key)
    const count = raw !== null ? parseInt(raw, 10) : 0
    if (count >= ENROLL_MINT_RL_MAX) return { allowed: false, retryAfter: ENROLL_MINT_RL_TTL }
    await env.SESSIONS.put(key, String(count + 1), { expirationTtl: ENROLL_MINT_RL_TTL })
    return { allowed: true, retryAfter: 0 }
  } catch {
    return { allowed: true, retryAfter: 0 }
  }
}

export function enrollThrottledBody(retryAfterSeconds: number) {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60))
  return html`
<h1>Too many keys, too fast</h1>
<div class="card">
  <p style="margin:0 0 10px;font-size:14px">
    This account has coined ${ENROLL_MINT_RL_MAX} seat keys in the last hour, which is
    the ceiling. Nothing is wrong with your permissions — try again in about
    ${minutes} minute${minutes === 1 ? '' : 's'}.
  </p>
  <p style="margin:0;font-size:14px">
    If you are enrolling a large fleet, mint through
    <code class="inline">mint_agent_token</code> instead of this page; it is the
    same write path without the browser-shaped throttle.
  </p>
</div>
<p style="margin-top:16px"><a href="/enroll">← Back to enrollment</a></p>`
}

export async function loadEnrollView(
  env: Env,
  auth: AuthContext,
  opts: { seat?: string | null; agent?: string | null } = {},
): Promise<EnrollView> {
  const seat = normalizeEnrollSeat(opts.seat)
  const principal = (auth.email && auth.email.trim().length > 0)
    ? auth.email.trim()
    : (auth.memberId ?? auth.userId)
  const memberId = auth.memberId ?? null

  if (!memberId) {
    return { principal, memberId, seat, preselectedAgent: null, agents: [] }
  }

  const consentable = await listConsentableAgents(env, memberId)
  const liveByAgent = await loadLiveKeysForAgents(env, consentable.map((a) => a.id))
  const want = (opts.agent ?? '').trim()
  const preselectedAgent = want && consentable.some((a) => a.id === want || a.slug === want)
    ? (consentable.find((a) => a.id === want || a.slug === want)?.id ?? null)
    : null

  return {
    principal,
    memberId,
    seat,
    preselectedAgent,
    agents: consentable.map((a) => ({ ...a, liveKeys: liveByAgent.get(a.id) ?? [] })),
  }
}

/** Live (non-revoked, non-expired) keys — never selects token_hash. */
async function loadLiveKeysForAgents(
  env: Env,
  agentIds: string[],
): Promise<Map<string, EnrollLiveKey[]>> {
  const out = new Map<string, EnrollLiveKey[]>()
  if (agentIds.length === 0) return out

  const placeholders = agentIds.map((_, i) => `?${i + 3}`).join(', ')
  const rows = await env.DB.prepare(
    `SELECT t.agent_id AS agent_id, t.label AS label, t.channel AS channel, t.created_at AS created_at
       FROM member_tokens t
      WHERE t.tenant = ?1
        AND ${TOKEN_LIVE_PREDICATE('?2')}
        AND t.agent_id IN (${placeholders})
      ORDER BY t.created_at ASC`,
  )
    .bind(env.TENANT_SLUG, nowSqlUtc(), ...agentIds)
    .all<{ agent_id: string; label: string; channel: string; created_at: string }>()

  for (const row of rows.results ?? []) {
    const list = out.get(row.agent_id) ?? []
    list.push({ label: row.label, channel: row.channel, created_at: row.created_at })
    out.set(row.agent_id, list)
  }
  return out
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function enrollPageBody(view: EnrollView, error?: string) {
  const errorHtml = error
    ? `<div class="warn-box"><strong>Error:</strong> ${esc(error)}</div>`
    : ''

  const emptyState = `
<div class="card">
  <p style="margin:0;font-size:14px;color:var(--muted)">
    You may not act as any agent yet. This page uses the same rule as the
    <a href="/authorize">OAuth consent screen</a>: an agent is selectable only
    when it is active, has an identity binding, and you hold
    <code class="inline">admin</code> on its squad. Ask an org-admin to grant
    that, or open <a href="/authorize">/authorize</a> after they do.
  </p>
</div>`

  const agentCards = view.agents.map((a) => {
    const checked = view.preselectedAgent === a.id ? ' checked' : ''
    const keys = a.liveKeys.length === 0
      ? `<p style="margin:8px 0 0;font-size:13px;color:var(--muted)">No live key for this agent yet.</p>`
      : `<ul style="margin:8px 0 0;padding-left:18px;font-size:13px">
          ${a.liveKeys.map((k) =>
            `<li><code class="inline">${esc(k.label || '(unlabelled)')}</code>
             · ${esc(k.channel)} · ${esc(k.created_at)}</li>`,
          ).join('')}
        </ul>`
    return `
    <label class="card" style="display:block;cursor:pointer;margin-bottom:10px">
      <input type="radio" name="agent_id" value="${esc(a.id)}" required${checked}
        style="margin-right:8px"/>
      <strong>${esc(a.name)}</strong>
      <code class="inline">${esc(a.slug)}</code>
      <span style="color:var(--muted);font-size:13px"> · ${esc(a.squad_name)}</span>
      ${keys}
    </label>`
  }).join('')

  return html`
<div class="crumbs"><a href="/">Overview</a> › Enroll seat</div>
<h1>Enroll a seat key</h1>
<p style="color:var(--muted);font-size:14px;max-width:640px;margin-bottom:20px">
  Choose the agent this harness should act as, then coin a workspace-channel
  key labelled with this seat. One person may hold many keys (laptop, server,
  this cloud seat). If a live key for this seat already exists, pick it
  instead of minting a duplicate.
</p>

${honoRaw(errorHtml)}

<div class="card" style="margin-bottom:18px">
  <h2 style="margin-top:0">Who you are</h2>
  <p style="margin:0 0 12px;font-size:14px">
    Signed in as <strong>${esc(view.principal)}</strong>${honoRaw(
      view.memberId
        ? ` · member <code class="inline">${esc(view.memberId)}</code>`
        : '',
    )}
  </p>
  <form method="post" action="/enroll/mint" autocomplete="off">
    <label>
      Seat
      <input name="seat" value="${esc(view.seat)}" maxlength="64" required
        style="min-width:220px;margin-top:6px" />
    </label>
    <p style="font-size:12px;color:var(--muted);margin:6px 0 0">
      Shown on the key as its <code class="inline">label</code> and sent as
      <code class="inline">x-mupot-seat</code>. Default is
      <code class="inline">${esc(DEFAULT_ENROLL_SEAT)}</code> — correct it if
      this harness has a real name.
    </p>

    <h2 style="margin-top:24px">Choose an agent</h2>
    ${view.agents.length === 0
      ? honoRaw(emptyState)
      : honoRaw(`<div>${agentCards}</div>`)}

    ${view.agents.length === 0
      ? ''
      : honoRaw(`
    <div style="margin-top:16px">
      <button class="btn" type="submit">Coin a key for this seat</button>
      <a href="/members" class="btn secondary sm" style="margin-left:10px">Cancel</a>
    </div>`)}
  </form>
</div>`
}

/**
 * The 403 for a caller who may not mint on this agent's squad.
 *
 * Deliberately NOT orgAdminForbiddenBody: that copy says the action "requires
 * owner or admin at ORG scope" and that "a squad or department grant will not
 * help". Both are false here — this gate is canOnSquad(..., 'admin'), so a squad
 * grant is exactly what unblocks it. Pointing a refused user at an org-scope
 * grant they do not need is the failure #678 records: four round-trips and a
 * redundant grant for someone who already held enough. Name the real scope.
 */
export function enrollForbiddenBody(
  auth: AuthContext,
  agentName: string,
  squadName: string | null,
) {
  const s = describeOrgStanding(auth)
  const where = squadName ? `squad "${squadName}"` : `that agent's squad`
  return html`
<h1>Not allowed</h1>
<div class="card">
  <p style="margin:0 0 10px;font-size:14px">
    You are signed in as <strong>${esc(s.principal)}</strong> — org role
    <code class="inline">${esc(s.role)}</code>.
  </p>
  <p style="margin:0 0 10px;font-size:14px">
    Coining a seat key for <strong>${esc(agentName)}</strong> requires the
    <code class="inline">admin</code> capability on ${esc(where)} — the same bar
    <code class="inline">mint_agent_token</code> enforces. An org-scope grant
    also satisfies it, but it is not required: a squad-scope grant is enough.
  </p>
  <p style="margin:0;font-size:14px">
    Ask an owner or admin on ${esc(where)} to grant you
    <code class="inline">admin</code> there, then reload this page.
  </p>
</div>
<p style="margin-top:16px">
  <a href="/" style="margin-right:16px">← Back to overview</a>
  <a href="/agents">Agents</a>
</p>`
}

/** Show-once page after a successful seat mint. Reuses the agent-token ceremony
 *  (raw in <code class="token">, copy button, no-store is dashboard-wide) and
 *  adds the paste-ready snippet with x-mupot-seat. */
export function enrollMintedBody(
  agentName: string,
  agentSlug: string,
  squadName: string | null,
  raw: string,
  tokenId: string,
  capability: string,
  seat: string,
  snippet: string,
) {
  const scopeLabel = squadName ? `${esc(squadName)} / ${esc(agentName)}` : esc(agentName)
  return html`
<div class="crumbs"><a href="/">Overview</a> › <a href="/enroll">Enroll seat</a> › Key coined</div>
<h1>Seat key coined</h1>
<div class="card">
  <p style="font-size:14px;color:var(--muted);margin:0 0 14px">
    Bound to <strong>${honoRaw(scopeLabel)}</strong> (slug: <code class="inline">${honoRaw(esc(agentSlug))}</code>) ·
    Seat: <code class="inline">${honoRaw(esc(seat))}</code> ·
    Token ID: <code class="inline">${honoRaw(esc(tokenId))}</code> ·
    Squad grant: <code class="inline">${honoRaw(esc(capability))}</code>
  </p>
  <div class="warn-box" style="margin-bottom:14px">
    <strong>Shown once only.</strong> Copy this token now — it cannot be retrieved again.
    Place it at <code class="inline">~/.fleet/agents/${honoRaw(esc(agentSlug))}.token</code> on the host.
    Never paste it in chat, bus messages, or version control.
  </div>
  <code class="token" id="rawToken">${honoRaw(esc(raw))}</code>
  <div style="margin-top:12px;display:flex;gap:10px;align-items:center">
    <button class="btn secondary sm" onclick="copyToken()">Copy</button>
    <a href="/enroll?seat=${encodeURIComponent(seat)}" class="btn secondary sm">Mint another</a>
    <a href="/members" class="btn secondary sm">Done</a>
    <span id="copyFeedback" style="font-size:13px;color:var(--ok);display:none">Copied!</span>
  </div>
</div>

<div class="card" style="margin-top:18px">
  <h2 style="margin-top:0">Paste-ready MCP config</h2>
  <p style="font-size:14px;color:var(--muted);margin:0 0 12px">
    Replace <code class="inline">&lt;MEMBER_TOKEN&gt;</code> with the token above.
    The <code class="inline">x-mupot-seat</code> header is already set to this seat
    so the harness declares it from the first call.
  </p>
  <pre style="overflow:auto;font-size:13px" id="enrollSnippet">${honoRaw(esc(snippet))}</pre>
</div>
<script>
  function copyToken() {
    const text = document.getElementById('rawToken').textContent.trim();
    navigator.clipboard.writeText(text).then(function() {
      const fb = document.getElementById('copyFeedback');
      fb.style.display = 'inline';
      setTimeout(function() { fb.style.display = 'none'; }, 2000);
    });
  }
</script>`
}
