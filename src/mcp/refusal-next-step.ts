// src/mcp/refusal-next-step.ts — ONE refusal envelope for every refusal on the MCP door.
//
// WHY. The refusals every new agent hits first, on every door, arrived as a bare code or as prose that
// named a step the same session could not take (door map 2026-10-18, dead ends 2,5,7,8,9,10,11,12). The
// envelope is `{ error, need?, who_acts, next_step, next_tool?, link? }`:
//   - who_acts  : who must do the next thing. self = the calling agent/session; owner = the human who owns
//                 the agent or connector; admin = an admin on the agent's squad; org_admin = an org admin.
//   - next_step : one line naming the route. Static, never interpolated from tenant data.
//   - next_tool : the tool to call (or that the actor calls), when there is exactly one. NOT `tool`: the
//                 envelope's `tool` already names the REFUSED tool.
//   - link      : a URL, only when the refusal's own detail carries one (never invented).
//
// RULE: no advertised next step may itself be refused for the session that reads it. Where the honest answer
// depends on what the credential is (the refusal does not know), the line branches on that in words.
//
// PRESENTATION ONLY. This module never decides anything: the status, the error code and the refused set are
// untouched. The text is static, so a refusal teaches a stranger nothing about what exists. The envelope is
// added to the MCP result only (mcpToolRefusalResult); REST /actions keeps its plain body.

export type WhoActs = 'self' | 'owner' | 'admin' | 'org_admin'

export interface RefusalGuidance {
  who_acts: WhoActs
  next_step?: string
  next_tool?: string
  link?: string
}

export interface GuidanceEntry {
  error: string
  /** Only for this refused tool. Entries naming a tool win over generic ones. */
  tool?: string
  status?: number
  /** Matches a string detail (prose-only refusals that share a code). */
  detailMatch?: RegExp
  /** The detail's `reason` must equal this (forbidden refusals that carry a machine reason). */
  reasonIs?: string
  /** The code needs a `need` in the detail (forbidden). */
  needsNeed?: boolean
  who_acts: WhoActs
  next_step: string
  next_tool?: string
  /** The detail's own `reason` is a bare machine code, not teaching: still give the step. */
  overridesReason?: boolean
}

const BOOT_MAP = 'Call boot_context and follow its next_step, available_doors and channel_limits: they name the route that applies to THIS session.'

export const SEAT_SELECT_STEP = 'Call seat_select { project: "<workspace name>" } (add folder and thread labels to key a seat per thread; every value is a label, none grants authority). Then send the returned seat_handle as the X-Mupot-Seat header, or as _meta["mupot/seat"] when your client cannot set headers, on every later request.'

/** Most specific first: tool+detail, tool, detail, generic. */
export const GUIDANCE_TABLE: readonly GuidanceEntry[] = [
  // ── harness token with no seat ────────────────────────────────────────────────────────────────
  { error: 'harness_session_seat_required', who_acts: 'self', next_tool: 'seat_select', next_step: SEAT_SELECT_STEP },

  // ── seat_select ───────────────────────────────────────────────────────────────────────────────
  { error: 'not_unbound_directory_session', tool: 'seat_select', who_acts: 'self', next_tool: 'boot_context',
    next_step: 'seat_select is only for a chat session that has no agent yet. This credential is already an agent (a workspace, agent or seat token, or a seat you hold): use it as that agent, call boot_context to see which. Do not retry seat_select.' },
  { error: 'harness_required', tool: 'seat_select', who_acts: 'owner',
    next_step: 'This connection carries no verified harness, so it cannot get a seat. Your human re-consents the connector (remove and add it again) and picks "Many chats" on the consent screen; then call seat_select again.' },
  { error: 'member_not_active', tool: 'seat_select', who_acts: 'org_admin',
    next_step: 'The human behind this connection is not an active member of this pot. An org admin reactivates the membership; nothing you call changes that.' },
  { error: 'home_rank_insufficient', tool: 'seat_select', who_acts: 'org_admin',
    next_step: 'The human does not hold admin on their own home squad, so a seat agent cannot be placed there. An org admin restores that grant; then call seat_select again.' },
  { error: 'seat_cap_reached', tool: 'seat_select', who_acts: 'self', next_tool: 'seat_select',
    next_step: 'This connection holds the maximum number of seats. Reuse one: call seat_select with the same project, folder and thread labels as a seat you already have. If you need more seats than the cap, an org admin raises it.' },
  { error: 'seat_agent_inactive', tool: 'seat_select', who_acts: 'admin', overridesReason: true,
    next_step: 'The agent behind that seat was retired or deactivated. Call seat_select with a different thread label to get a fresh seat, or an admin on that squad reactivates the agent.' },
  { error: 'seat_key_source_conflict', tool: 'seat_select', who_acts: 'self', next_tool: 'seat_select',
    next_step: 'That seat key already belongs to a seat from the other pool (explicit vs conversation-keyed). Call seat_select again with a different project or thread label.' },
  { error: 'provisioning_failed', tool: 'seat_select', who_acts: 'self', next_tool: 'seat_select',
    next_step: 'The seat could not be created. Retry seat_select once; if it fails again, tell your human so an org admin can look at the audit log. Do not loop.' },

  // ── seat_attach / bootstrap_self ──────────────────────────────────────────────────────────────
  { error: 'seat_required', who_acts: 'self',
    next_step: 'seat_attach is only for a chat thread that has a seat, and this session has none. If boot_context lists a harness (a connector consented as "Many chats"), call seat_select first; if it does not, your human re-consents the connector choosing "Many chats". A workspace bearer (CLI or daemon) does not attach: it acts as the agent its token is bound to, or an admin must mint it one. A connector chat consented to ONE agent already is that agent.' },
  { error: 'not_unbound_directory_session', tool: 'bootstrap_self', who_acts: 'self', next_tool: 'boot_context',
    next_step: 'bootstrap_self only runs for a chat session that has no agent yet. If this credential is an agent or seat token you already are that agent: call boot_context. If it is an unbound member token with no agent, an admin mints you one: mint_agent_token. Do not retry bootstrap_self.' },
  { error: 'rate_limited', tool: 'bootstrap_self', who_acts: 'self',
    next_step: 'You hit the bootstrap rate limit. Stop retrying in a loop: wait, then call bootstrap_self once more.' },

  // ── agent-bound credential refusals ───────────────────────────────────────────────────────────
  { error: 'agent_bound_credential_required', tool: 'verify_agent_connection', who_acts: 'admin', next_tool: 'mint_agent_token',
    next_step: 'verify_agent_connection proves a workspace token that is bound to an agent. A chat seat, an attached thread or a connector cannot call it even if it acts as an agent. It needs a workspace token an admin mints for the agent: admin calls mint_agent_token { agent }; the daemon then connects with that bearer and calls this tool.' },
  { error: 'agent_bound_workspace_credential_required', who_acts: 'self', next_tool: 'token_binding_attest',
    next_step: 'This needs a workspace token bound to an active agent. If yours is, call token_binding_attest {} first, then retry (runtime_seat_register_pending takes the returned attestationId). If token_binding_attest refuses the same way, your credential is not agent-bound: an admin mints one with mint_agent_token { agent }.' },
  { error: 'agent_bound_credential_required', who_acts: 'admin', next_tool: 'mint_agent_token',
    next_step: `This tool needs an agent-bound credential and this session is not one. ${BOOT_MAP} A CLI or daemon agent needs an org admin or a squad admin to mint it an agent-bound workspace token: mint_agent_token { agent }.` },
  { error: 'not_agent_bound', who_acts: 'admin', next_tool: 'mint_agent_token',
    next_step: `This tool needs an agent-bound credential and this session is not one. ${BOOT_MAP} A CLI or daemon agent needs an org admin or a squad admin to mint it an agent-bound workspace token: mint_agent_token { agent }.` },

  // ── pot features off ──────────────────────────────────────────────────────────────────────────
  { error: 'seat_attach_disabled', who_acts: 'org_admin', next_step: `This pot has not enabled that feature, so retrying will not help. ${BOOT_MAP}` },
  { error: 'seat_auto_enroll_disabled', who_acts: 'org_admin', next_step: `This pot has not enabled that feature, so retrying will not help. ${BOOT_MAP}` },

  // ── check_in / inbox ──────────────────────────────────────────────────────────────────────────
  { error: 'not_member_bound', tool: 'check_in', who_acts: 'self',
    next_step: 'check_in needs a credential that belongs to a member (a workspace token, a connector grant or a seat). This one belongs to none: connect with a member-bound credential, then call check_in.' },
  { error: 'invalid_args', tool: 'check_in', detailMatch: /poll requires an agent-bound/, who_acts: 'admin', next_tool: 'mint_agent_token',
    next_step: 'presence_mode "poll" is for a daemon with its own agent-bound workspace token (an admin mints it: mint_agent_token { agent }). Without one, call check_in without presence_mode.' },
  { error: 'attached_seat_cannot_set_presence_mode', who_acts: 'self', next_tool: 'check_in',
    next_step: 'An attached chat is not the agent\'s runtime and cannot set the agent\'s presence. Call check_in without presence_mode; the agent\'s own daemon sets poll presence from its workspace token.' },
  { error: 'consumer_fenced', who_acts: 'admin', next_tool: 'set_agent_inbox_consumer',
    next_step: 'Another consumer holds this agent\'s inbox. Read without consuming: inbox { peek: true }. To consume here, an admin sets the consumer with set_agent_inbox_consumer, or the agent\'s own host process (the registered inbox consumer) does the consuming.' },

  // ── orient / connect ──────────────────────────────────────────────────────────────────────────
  { error: 'invalid_args', tool: 'orient', detailMatch: /agent required/, who_acts: 'self', next_tool: 'orient',
    next_step: 'orient needs an agent. For one you can observe, call orient { agent: "<id-or-slug>" }. In a chat connector that has no seat, call seat_select { project: "<workspace name>" } first (it needs a connector consented as "Many chats"); a seated session then calls orient with no arguments.' },

  // ── profile door ──────────────────────────────────────────────────────────────────────────────
  { error: 'tool_not_in_profile', who_acts: 'self', next_step: 'This tool is not on this limited endpoint. Use the full endpoint /mcp for this tool.' },
  { error: 'profile_args_not_allowed', who_acts: 'self', next_step: 'Those arguments are not allowed on this limited endpoint. Call the tool without them, or use the full endpoint /mcp.' },

  // ── generic floors ────────────────────────────────────────────────────────────────────────────
  { error: 'forbidden', status: 403, reasonIs: 'directory_channel_zero_capability', who_acts: 'owner', overridesReason: true,
    next_step: 'This chat session is on the directory door, which carries no capability by design; connect cannot change that (it only reads) and a squad grant is discarded. Your human binds the connector: re-consent it (remove and add it again) and choose the agent ("One agent") or "Many chats" on the consent screen. A CLI or daemon agent instead uses a workspace token an admin mints with mint_agent_token { agent }. Do not retry connect.' },
  { error: 'forbidden', status: 403, needsNeed: true, who_acts: 'admin', next_tool: 'grant_agent_capability',
    next_step: 'This session does not hold the capability this needs on that target (need). An admin on that scope grants it: grant_agent_capability { agent, capability: <need> } (grant_gate_capability for a gate), or ask the owner of this agent to ask one. A squad grant does not help a connector chat session: that needs a seat or a workspace token an admin mints.' },
  { error: 'rate_limited', status: 429, who_acts: 'self',
    next_step: 'You hit a rate or budget limit. Stop retrying in a loop: wait, then try again once.' },
]

/** Who acts when no table entry matches: a 4xx the agent can usually read and fix itself. */
function defaultWhoActs(error: string, status: number): WhoActs {
  if (error === 'forbidden' || status === 403) return 'admin'
  return 'self'
}

/** A refusal whose detail already teaches (a hint, a reason, its own next_step) is never overwritten. */
function alreadyTeaches(detail: unknown): boolean {
  if (typeof detail !== 'object' || detail === null) return false
  return 'next_step' in detail || 'hint' in detail || 'reason' in detail
}

function hasNeed(detail: unknown): boolean {
  return typeof detail === 'object' && detail !== null && 'need' in detail
}

function matchEntry(error: string, status: number, detail: unknown, tool: string | undefined): GuidanceEntry | undefined {
  // Tool-scoped entries first, so a generic row never shadows the specific one.
  for (const scoped of [true, false]) {
    for (const e of GUIDANCE_TABLE) {
      if ((e.tool !== undefined) !== scoped) continue
      if (e.error !== error) continue
      if (e.tool !== undefined && e.tool !== tool) continue
      if (e.status !== undefined && e.status !== status) continue
      if (e.reasonIs !== undefined && !(typeof detail === 'object' && detail !== null && (detail as { reason?: unknown }).reason === e.reasonIs)) continue // narrowed by the typeof/null checks
      if (e.needsNeed === true && !hasNeed(detail)) continue
      if (e.detailMatch !== undefined && !(typeof detail === 'string' && e.detailMatch.test(detail))) continue
      return e
    }
  }
  return undefined
}

/** The first URL a refusal's own detail carries (string detail or any string field), else undefined. */
function linkFromDetail(detail: unknown): string | undefined {
  const URL_RE = /https?:\/\/[^\s"'<>)]+/
  if (typeof detail === 'string') return URL_RE.exec(detail)?.[0]
  if (typeof detail === 'object' && detail !== null) {
    for (const v of Object.values(detail)) {
      if (typeof v === 'string') {
        const m = URL_RE.exec(v)
        if (m) return m[0]
      }
    }
  }
  return undefined
}

/** A squad-access miss is an org admin's to fix. */
function reasonWho(detail: unknown): WhoActs | undefined {
  if (typeof detail !== 'object' || detail === null || !('reason' in detail)) return undefined
  const reason = (detail as { reason?: unknown }).reason // narrowed by the 'in' check above
  if (reason === 'no_squad_access') return 'org_admin'
  return undefined
}

/**
 * The envelope guidance for a refusal. `who_acts` is ALWAYS present. `next_step` is present unless the
 * refusal's own detail already teaches (then the detail stays the teaching surface), and absent when the
 * code has no entry.
 */
export function refusalGuidance(error: string, status: number, detail: unknown, tool?: string): RefusalGuidance {
  const entry = matchEntry(error, status, detail, tool)
  const detailTeaches = alreadyTeaches(detail) && entry?.overridesReason !== true
  const who_acts = reasonWho(detail) ?? entry?.who_acts ?? defaultWhoActs(error, status)
  if (entry === undefined || detailTeaches) return { who_acts }
  const link = linkFromDetail(detail)
  return {
    who_acts,
    next_step: entry.next_step,
    ...(entry.next_tool !== undefined ? { next_tool: entry.next_tool } : {}),
    ...(link !== undefined ? { link } : {}),
  }
}

/**
 * Back-compat: the bare teaching line, or undefined when the refusal has no universal one (the tool's own
 * detail is then the teaching surface).
 */
export function refusalNextStep(error: string, status: number, detail: unknown, tool?: string): string | undefined {
  return refusalGuidance(error, status, detail, tool).next_step
}

/**
 * For JSON-RPC errors that carry no isError result (tool_not_in_profile, 5xx, invalid_args): merge the
 * envelope into `data`, keeping the original detail. Only when the table has a real entry for the code,
 * so an unrelated error keeps its exact data.
 */
export function withRefusalGuidance(error: string, status: number, detail: unknown, tool?: string): unknown {
  if (matchEntry(error, status, detail, tool) === undefined) return detail
  const g = refusalGuidance(error, status, detail, tool)
  const base = typeof detail === 'object' && detail !== null ? detail : detail === undefined ? {} : { detail }
  return { ...base, ...g }
}
