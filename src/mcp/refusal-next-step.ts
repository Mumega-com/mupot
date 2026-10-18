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
//   - link      : a URL, only from a dedicated `link` field of the refusal's own detail (never scraped, never invented).
//
// RULE: no advertised next step may itself be refused for the session that reads it. Where the honest answer
// depends on what the credential is (the refusal does not know), the line branches on that in words.
//
// PRESENTATION ONLY. This module never decides anything: the status, the error code and the refused set are
// untouched. The text is static, so a refusal teaches a stranger nothing about what exists. The envelope is
// added to the MCP result only (mcpToolRefusalResult); REST /actions keeps its plain body.

export type WhoActs = 'self' | 'owner' | 'admin' | 'org_admin'

/**
 * What kind of connection is reading the refusal. The same code needs a different actor per kind (a chat
 * connector cannot use a minted bearer; a bearer cannot re-consent), so rows may pin a kind.
 *   chat_plain    directory connector, no harness, no agent   (consented "No agent")
 *   chat_harness  directory connector with a harness, no seat/agent yet
 *   chat_bound    directory connector acting as an agent (seat, attached thread or consent-bound)
 *   bearer_unbound workspace/other bearer with no agent
 *   bearer_bound   workspace/other bearer bound to an agent
 */
export type ConnKind = 'chat_plain' | 'chat_harness' | 'chat_bound' | 'bearer_unbound' | 'bearer_bound'

export interface GuideCtx {
  kind?: ConnKind
  /** True only when the consent page shows the "How will this app connect?" labels (SEAT_AUTO_ENROLL and SEAT_ATTACH). */
  choiceLabels?: boolean
  /** Public origin, for absolute URLs. */
  origin?: string
}

export interface RefusalGuidance {
  who_acts: WhoActs
  next_step?: string
  next_tool?: string
  link?: string
}

export interface GuidanceEntry {
  error: string
  /** Only for this refused tool. */
  tool?: string
  /** Only for these connection kinds. */
  kinds?: readonly ConnKind[]
  status?: number
  /** Matches a string detail (prose-only refusals that share a code). */
  detailMatch?: RegExp
  /** The detail's `reason` must equal this (forbidden refusals that carry a machine reason). */
  reasonIs?: string
  /** The code needs a `need` in the detail (forbidden). */
  needsNeed?: boolean
  who_acts: WhoActs
  /** Tokens: {many} {one} (consent labels), {full_mcp} (absolute full endpoint), {reach} (how to reach the actor). */
  next_step: string
  next_tool?: string
  /** The detail's own `reason` is a bare machine code, not teaching: still give the step. */
  overridesReason?: boolean
}

const BOOT_MAP = 'Call boot_context and follow its next_step, available_doors and channel_limits: they name the route that applies to THIS session.'
const REACH = 'To reach them: message the squad owner with the send tool if this session has it; otherwise ask the person who connected this app.'
const CHAT_KINDS: readonly ConnKind[] = ['chat_plain', 'chat_harness', 'chat_bound']

/** The labels the consent page actually shows: the choice wording needs SEAT_AUTO_ENROLL and SEAT_ATTACH both on. */
export function consentLabels(choiceLabels: boolean): { many: string; one: string } {
  return choiceLabels ? { many: '"Many chats"', one: '"One agent"' } : { many: '"Me (auto)"', one: '"Existing agent"' }
}

export function consentChoiceLabels(env: { SEAT_AUTO_ENROLL?: string; SEAT_ATTACH?: string }): boolean {
  return env.SEAT_AUTO_ENROLL === '1' && env.SEAT_ATTACH === '1'
}

export const SEAT_SELECT_STEP = 'Call seat_select { project: "<workspace name>" } (add folder and thread labels to key a seat per thread; every value is a label, none grants authority). Then send the returned seat_handle as the X-Mupot-Seat header, or as _meta["mupot/seat"] when your client cannot set headers, on every later request.'

const MINT = 'an admin mints an agent-bound workspace token with mint_agent_token { agent }'
const NEEDS_MINT = 'an admin to mint it an agent-bound workspace token with mint_agent_token { agent }'

/** Rendered per request; the most specific matching row wins (tool 2, kinds 1). */
export const GUIDANCE_TABLE: readonly GuidanceEntry[] = [
  // ── harness token with no seat ────────────────────────────────────────────────────────────────
  { error: 'harness_session_seat_required', who_acts: 'self', next_tool: 'seat_select', next_step: SEAT_SELECT_STEP },

  // ── seat_select ───────────────────────────────────────────────────────────────────────────────
  { error: 'not_unbound_directory_session', tool: 'seat_select', kinds: ['bearer_unbound'], who_acts: 'admin', next_tool: 'mint_agent_token',
    next_step: `seat_select is for chat connectors; this is a workspace token with no agent behind it. ${'An admin mints it an agent: mint_agent_token { agent }.'} {reach}` },
  { error: 'not_unbound_directory_session', tool: 'seat_select', who_acts: 'self', next_tool: 'boot_context',
    next_step: 'seat_select is only for a chat session that has no agent yet. This credential is already an agent (a workspace, agent or seat token, or a seat you hold): use it as that agent, call boot_context to see which. Do not retry seat_select.' },
  { error: 'harness_required', tool: 'seat_select', who_acts: 'owner',
    next_step: 'This connection carries no verified harness, so it cannot get a seat. Your human re-consents the connector (remove and add it again) and picks {many} on the consent screen; then call seat_select again. {reach}' },
  { error: 'member_not_active', tool: 'seat_select', who_acts: 'org_admin',
    next_step: 'The human behind this connection is not an active member of this pot. An org admin reactivates the membership; nothing you call changes that. {reach}' },
  { error: 'home_rank_insufficient', tool: 'seat_select', who_acts: 'org_admin',
    next_step: 'The human does not hold admin on their own home squad, so a seat agent cannot be placed there. An org admin restores that grant; then call seat_select again. {reach}' },
  { error: 'seat_cap_reached', tool: 'seat_select', who_acts: 'self', next_tool: 'seat_select',
    next_step: 'This connection holds the maximum number of seats. Reuse one: call seat_select with the same project, folder and thread labels as a seat you already have. If you need more seats than the cap, an org admin raises it.' },
  { error: 'seat_agent_inactive', tool: 'seat_select', who_acts: 'self', next_tool: 'seat_select', overridesReason: true,
    next_step: 'The agent behind that seat was retired or deactivated. Call seat_select with a different thread label to get a fresh seat. If you need that same agent back, an admin on its squad reactivates it. {reach}' },
  { error: 'seat_key_source_conflict', tool: 'seat_select', who_acts: 'self', next_tool: 'seat_select',
    next_step: 'That seat key already belongs to a seat from the other pool (explicit vs conversation-keyed). Call seat_select again with a different project or thread label.' },
  { error: 'provisioning_failed', tool: 'seat_select', who_acts: 'self', next_tool: 'seat_select',
    next_step: 'The seat could not be created. Retry seat_select once; if it fails again, tell your human so an org admin can look at the audit log. Do not loop.' },

  // ── seat_attach / bootstrap_self ──────────────────────────────────────────────────────────────
  { error: 'seat_required', kinds: ['chat_harness'], who_acts: 'self', next_tool: 'seat_select',
    next_step: `seat_attach needs a seat and this thread has none yet. ${SEAT_SELECT_STEP} Then call seat_attach again.` },
  { error: 'seat_required', kinds: ['chat_plain'], who_acts: 'owner',
    next_step: 'seat_attach needs a seat, and a seat needs a harness; this connector was consented without one. Your human re-consents the connector (remove and add it again) and picks {many}; then call seat_select, then seat_attach. {reach}' },
  { error: 'seat_required', kinds: ['chat_bound'], who_acts: 'self', next_tool: 'orient',
    next_step: 'This connector chat is already consented to an agent, so it already is that agent: call orient. seat_attach is for a chat that has a seat and wants to act as another agent.' },
  { error: 'seat_required', kinds: ['bearer_bound'], who_acts: 'self', next_tool: 'orient',
    next_step: 'A workspace bearer does not attach: it acts as the agent its token is bound to. Call orient to see which.' },
  { error: 'seat_required', kinds: ['bearer_unbound'], who_acts: 'admin', next_tool: 'mint_agent_token',
    next_step: 'A workspace bearer does not attach, and this one has no agent behind it. An admin mints it an agent-bound token: mint_agent_token { agent }. {reach}' },
  { error: 'seat_required', who_acts: 'self',
    next_step: 'seat_attach is only for a chat thread that has a seat, and this session has none. If boot_context lists a harness, call seat_select first; if it does not, your human re-consents the connector choosing {many}. A workspace bearer acts as the agent its token is bound to.' },
  { error: 'not_unbound_directory_session', tool: 'bootstrap_self', kinds: ['bearer_unbound'], who_acts: 'admin', next_tool: 'mint_agent_token',
    next_step: 'bootstrap_self only runs for a chat session that has no agent yet; this is an unbound member token. An admin mints it an agent: mint_agent_token { agent }. {reach}' },
  { error: 'not_unbound_directory_session', tool: 'bootstrap_self', who_acts: 'self', next_tool: 'boot_context',
    next_step: 'bootstrap_self only runs for a chat session that has no agent yet. This credential is already an agent or a seat: call boot_context to see which. Do not retry bootstrap_self.' },
  { error: 'rate_limited', tool: 'bootstrap_self', who_acts: 'self',
    next_step: 'You hit the bootstrap rate limit. Stop retrying in a loop: wait, then call bootstrap_self once more.' },

  // ── agent-bound credential refusals ───────────────────────────────────────────────────────────
  { error: 'agent_bound_credential_required', tool: 'verify_agent_connection', kinds: CHAT_KINDS, who_acts: 'owner',
    next_step: 'verify_agent_connection proves a daemon\'s workspace token, so it cannot be run from a chat connector, even one that acts as an agent. The person running the agent\'s daemon calls it with that daemon\'s bearer. {reach}' },
  { error: 'agent_bound_credential_required', tool: 'verify_agent_connection', who_acts: 'admin', next_tool: 'mint_agent_token',
    next_step: 'verify_agent_connection proves a workspace token that is bound to an agent. It needs a workspace token an admin mints for the agent: admin calls mint_agent_token { agent }; the daemon then connects with that bearer and calls this tool. {reach}' },
  { error: 'agent_bound_workspace_credential_required', kinds: CHAT_KINDS, who_acts: 'owner',
    next_step: `This needs a daemon\'s workspace token bound to an active agent; a chat connector cannot use one. Whoever runs the agent's daemon connects with that bearer (${MINT}). {reach}` },
  { error: 'agent_bound_workspace_credential_required', who_acts: 'self', next_tool: 'token_binding_attest',
    next_step: `This needs a workspace token bound to an active agent. If yours is, call token_binding_attest {} first, then retry (runtime_seat_register_pending takes the returned attestationId). If token_binding_attest refuses the same way, your credential is not agent-bound: ${MINT}. {reach}` },
  { error: 'agent_bound_credential_required', kinds: CHAT_KINDS, who_acts: 'owner',
    next_step: 'This tool needs an agent-bound credential and this chat connector is not one; a connector cannot use a minted bearer. Your human re-consents the connector and picks {one} (or {many}, then seat_select). {reach}' },
  { error: 'not_agent_bound', kinds: CHAT_KINDS, who_acts: 'owner',
    next_step: 'This tool needs an agent-bound credential and this chat connector is not one; a connector cannot use a minted bearer. Your human re-consents the connector and picks {one} (or {many}, then seat_select). {reach}' },
  { error: 'agent_bound_credential_required', who_acts: 'admin', next_tool: 'mint_agent_token',
    next_step: `This tool needs an agent-bound credential and this session is not one. A CLI or daemon agent needs ${NEEDS_MINT}. {reach}` },
  { error: 'not_agent_bound', who_acts: 'admin', next_tool: 'mint_agent_token',
    next_step: `This tool needs an agent-bound credential and this session is not one. A CLI or daemon agent needs ${NEEDS_MINT}. {reach}` },

  // ── pot features off ──────────────────────────────────────────────────────────────────────────
  { error: 'seat_attach_disabled', who_acts: 'org_admin', next_step: `This pot has not enabled that feature, so retrying will not help. ${BOOT_MAP} {reach}` },
  { error: 'seat_auto_enroll_disabled', who_acts: 'org_admin', next_step: `This pot has not enabled that feature, so retrying will not help. ${BOOT_MAP} {reach}` },

  // ── check_in / inbox ──────────────────────────────────────────────────────────────────────────
  { error: 'not_member_bound', tool: 'check_in', who_acts: 'org_admin',
    next_step: 'check_in needs a credential that belongs to a member (a workspace token, a connector grant or a seat). This one belongs to none, and nothing you call changes that: an org admin issues a member-bound credential. {reach}' },
  { error: 'invalid_args', tool: 'check_in', detailMatch: /poll requires an agent-bound/, who_acts: 'self', next_tool: 'check_in',
    next_step: 'presence_mode "poll" is for a daemon with its own agent-bound workspace token. Call check_in again without presence_mode; if you are that daemon, an admin mints the token (mint_agent_token { agent }). {reach}' },
  { error: 'attached_seat_cannot_set_presence_mode', who_acts: 'self', next_tool: 'check_in',
    next_step: 'An attached chat is not the agent\'s runtime and cannot set the agent\'s presence. Call check_in without presence_mode; the agent\'s own daemon sets poll presence from its workspace token.' },
  { error: 'consumer_fenced', who_acts: 'self', next_tool: 'inbox',
    next_step: 'Another consumer holds this agent\'s inbox. Read without consuming: call inbox { peek: true }. To consume here instead, an admin sets the consumer with set_agent_inbox_consumer, or the agent\'s own host process (the registered inbox consumer) does the consuming. {reach}' },

  // ── orient / connect ──────────────────────────────────────────────────────────────────────────
  { error: 'invalid_args', tool: 'orient', detailMatch: /agent required/, kinds: ['chat_plain'], who_acts: 'owner',
    next_step: 'orient needs an agent and this plain connector has none and cannot get a seat. Your human re-consents the connector (remove and add it again) and picks {one}, or {many} (then seat_select). {reach}' },
  { error: 'invalid_args', tool: 'orient', detailMatch: /agent required/, kinds: ['bearer_unbound'], who_acts: 'self', next_tool: 'orient',
    next_step: `orient needs an agent and this workspace token has none. For an agent you can observe, pass orient { agent: "<id-or-slug>" }. To act as an agent yourself, you need ${NEEDS_MINT} (this token cannot seat_select: that is for chat connectors). {reach}` },
  { error: 'invalid_args', tool: 'orient', detailMatch: /agent required/, who_acts: 'self', next_tool: 'seat_select',
    next_step: 'orient needs an agent and this session is not one yet. In a chat connector with no seat, call seat_select { project: "<workspace name>" } first (it needs a connector consented as {many}); a seated session then calls orient with no arguments. For an agent you can observe, pass orient { agent: "<id-or-slug>" }.' },

  // ── profile door ──────────────────────────────────────────────────────────────────────────────
  { error: 'tool_not_in_profile', who_acts: 'owner',
    next_step: 'This tool is not on this limited endpoint, and a session cannot change its own endpoint. Whoever configured this connector points it at the full endpoint {full_mcp}. {reach}' },
  { error: 'profile_args_not_allowed', who_acts: 'self', next_step: 'Those arguments are not allowed on this limited endpoint. Call the tool again without them.' },

  // ── generic floors ────────────────────────────────────────────────────────────────────────────
  { error: 'forbidden', tool: 'orient', status: 403, needsNeed: true, who_acts: 'owner',
    next_step: 'This session cannot observe that agent. Ask the owner for the slug of an agent you can observe, then call orient with it. {reach}' },
  { error: 'forbidden', status: 403, reasonIs: 'directory_channel_zero_capability', who_acts: 'owner', overridesReason: true,
    next_step: 'This chat session is on the directory door, which carries no capability by design; connect cannot change that (it only reads) and a squad grant is discarded. Your human binds the connector: re-consent it (remove and add it again) and choose the agent ({one}) or {many} on the consent screen. A CLI or daemon agent instead uses a workspace token an admin mints with mint_agent_token { agent }. Do not retry connect. {reach}' },
  { error: 'forbidden', status: 403, needsNeed: true, who_acts: 'admin', next_tool: 'grant_agent_capability',
    next_step: 'This session does not hold the capability this needs on that target (need). An admin on that scope grants it: grant_agent_capability { agent, capability: <need> } (grant_gate_capability for a gate), or ask the owner of this agent to ask one. A squad grant does not help a connector chat session: that needs a seat or a workspace token an admin mints. {reach}' },
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

function matchEntry(error: string, status: number, detail: unknown, tool: string | undefined, kind: ConnKind | undefined): GuidanceEntry | undefined {
  let best: GuidanceEntry | undefined
  let bestScore = -1
  for (const e of GUIDANCE_TABLE) {
    if (e.error !== error) continue
    if (e.tool !== undefined && e.tool !== tool) continue
    if (e.kinds !== undefined && (kind === undefined || !e.kinds.includes(kind))) continue
    if (e.status !== undefined && e.status !== status) continue
    if (e.reasonIs !== undefined && !(typeof detail === 'object' && detail !== null && (detail as { reason?: unknown }).reason === e.reasonIs)) continue // narrowed by the typeof/null checks
    if (e.needsNeed === true && !hasNeed(detail)) continue
    if (e.detailMatch !== undefined && !(typeof detail === 'string' && e.detailMatch.test(detail))) continue
    const score = (e.tool !== undefined ? 2 : 0) + (e.kinds !== undefined ? 1 : 0)
    if (score > bestScore) { best = e; bestScore = score }
  }
  return best
}

/** A link only from a dedicated `link` field of the refusal's own detail: never scraped out of prose. */
function linkFromDetail(detail: unknown): string | undefined {
  if (typeof detail !== 'object' || detail === null) return undefined
  const v = (detail as { link?: unknown }).link // narrowed by the typeof/null checks
  return typeof v === 'string' && /^https?:\/\//.test(v) ? v : undefined
}

/** A squad-access miss is an org admin's to fix. */
function reasonWho(detail: unknown): WhoActs | undefined {
  if (typeof detail !== 'object' || detail === null || !('reason' in detail)) return undefined
  const reason = (detail as { reason?: unknown }).reason // narrowed by the 'in' check above
  if (reason === 'no_squad_access') return 'org_admin'
  return undefined
}

export function renderStep(text: string, ctx: GuideCtx): string {
  const labels = consentLabels(ctx.choiceLabels === true)
  return text
    .replaceAll('{many}', labels.many)
    .replaceAll('{one}', labels.one)
    .replaceAll('{full_mcp}', ctx.origin ? `${ctx.origin}/mcp` : 'this pot\'s full /mcp endpoint')
    .replaceAll('{reach}', REACH)
}

/**
 * The envelope guidance for a refusal. `who_acts` is ALWAYS present. `next_step` is present unless the
 * refusal's own detail already teaches (then the detail stays the teaching surface), and absent when the
 * code has no entry.
 */
export function refusalGuidance(error: string, status: number, detail: unknown, tool?: string, ctx: GuideCtx = {}): RefusalGuidance {
  const entry = matchEntry(error, status, detail, tool, ctx.kind)
  const detailTeaches = alreadyTeaches(detail) && entry?.overridesReason !== true
  const who_acts = reasonWho(detail) ?? entry?.who_acts ?? defaultWhoActs(error, status)
  if (entry === undefined || detailTeaches) return { who_acts }
  const link = linkFromDetail(detail)
  return {
    who_acts,
    next_step: renderStep(entry.next_step, ctx),
    ...(entry.next_tool !== undefined ? { next_tool: entry.next_tool } : {}),
    ...(link !== undefined ? { link } : {}),
  }
}

/** Back-compat: the bare teaching line, or undefined when the refusal has no universal one. */
export function refusalNextStep(error: string, status: number, detail: unknown, tool?: string, ctx: GuideCtx = {}): string | undefined {
  return refusalGuidance(error, status, detail, tool, ctx).next_step
}

/**
 * The envelope as SIBLING members of a JSON-RPC `error` (beside `data`, never inside it), so `data` keeps
 * the exact shape every existing client reads. Only when the table has a real row for the code.
 */
export function refusalEnvelope(error: string, status: number, detail: unknown, tool?: string, ctx: GuideCtx = {}): RefusalGuidance | undefined {
  if (matchEntry(error, status, detail, tool, ctx.kind) === undefined) return undefined
  return refusalGuidance(error, status, detail, tool, ctx)
}
