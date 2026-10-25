// src/mcp/whoami.ts — ONE answer to "where do I stand, and what is still missing" (door map
// agents/kasra/docs/door-map-20261018.md §2, design-navigable-onboarding-20261017.md Block 1).
//
// Boot used to carry five words for one fact (identity_status, onboarding_state, onboarding.connection_kind,
// binding_source, inbox) and up to four next-step fields that disagreed with each other and with what the tools
// then enforced. `whoami` is the single derivation; boot's next_step / available_doors / channel_limits derive
// from it (see `whoamiDoorFilter`), and status / orient carry the same block.
//
// RULE: a `missing[]` step is built from the SAME predicates the tools enforce, so an advertised step cannot be
// refused for the caller it was shown to:
//   - bootstrap_self: isUnboundDirectorySession + findExistingBootstrap + the stranger rule below (#2020)
//   - seat_select:    unbound directory session + live harness pointer + SEAT_AUTO_ENROLL (members/seat-select.ts)
//   - a harness token (K5) may call only HARNESS_SESSION_ALLOWED_TOOLS (members/harness-credential.ts)
// `next_tool` is set only when who_acts is 'self' (this caller can call it); a step another actor takes carries
// prose and, where one exists, a link.
//
// PURE: no DB read happens here. The caller gathers `WhoamiFacts` (best-effort) and passes them in.

import type { AuthContext, Env } from '../types'
import { hasCapability } from '../auth/capability'
import { HARNESS_SESSION_ALLOWED_TOOLS } from '../members/harness-credential'
import { seatAutoEnrollEnabled } from '../members/harness'
import { seatAttachDesignatedEnabled, seatAttachEnabled } from '../members/seat-attach'
import { attachedAuthority } from '../auth/attached-ceiling'
import { mcpEndpoint } from '../dashboard/connect'
import { consentChoiceLabels, consentLabels, refusalGuidance, SEAT_SELECT_STEP as TABLE_SEAT_SELECT_STEP, type WhoActs as TableWhoActs } from './refusal-next-step'

import type { InstallerWindowView } from '../operators/installer-window'

export type WhoamiState = 'no_agent' | 'own_seat' | 'acting_as' | 'host' | 'harness_unseated'
export type WhoActs = TableWhoActs // one vocabulary with the refusal envelope (refusal-next-step.ts)

export interface WhoamiMissing {
  code: string
  who_acts: WhoActs
  next_step: string
  next_tool?: string
  link?: string
}

export interface Whoami {
  state: WhoamiState
  /** Only for state 'acting_as': 'attached' (K7, a seat attached to an existing agent) or 'legacy_consent' (K8). */
  basis?: 'attached' | 'legacy_consent'
  have: string[]
  missing: WhoamiMissing[]
  agent: { keyed: boolean; inbox: 'consume' | 'peek' | 'none' | 'fenced'; can_self_report: boolean }
  /** Present when the request is bound to a seat. Never carries an agent id: `acts_as` is a slug/name. */
  seat?: { seat_id: string; acts_as: string | null; presented: boolean }
  harness: 'present' | 'absent'
  /** ONE plain sentence for this state: who you are, whether seat tools apply, and the single next call. Derived from the same state as `state`/`missing`. */
  next_step_plain: string
  /** The 3-4 door cases in one table. */
  docs: string
  /** Installer window (flag INSTALLER_WINDOW): present only while this session holds a LIVE window. Never otherwise. */
  installer_window?: InstallerWindowView
  /** ADMISSION_TAPE on AND the seat has a status only. Status band + reason class; the score is never exposed to the seat. */
  admission?: { status: 'observed' | 'trusted' | 'held'; reason_class: string }
}

/** What the caller already read (best-effort; a failed read passes its safe default). */
export interface WhoamiFacts {
  keyed: boolean
  fenced: boolean
  /** findExistingBootstrap(member) !== null — the tool's own already_bootstrapped predicate. */
  bootstrappedBefore: boolean
  /** Any agents row in this pot. Fails toward `true` (the conservative answer: do not advertise the mint). */
  tenantHasAgents: boolean
  /** Slug/name of the agent this request acts as, when known. */
  actsAs: string | null
  /** Boot only: the runtime self-report step. Absent on status/orient (they take no runtime args). */
  report?: { missingFields: string[]; outcome?: string; detail?: string }
  /** Admission status of this request's seat (ADMISSION_TAPE on, seat has a status). Absent otherwise. */
  admission?: { status: 'observed' | 'trusted' | 'held'; reason_class: string }
}

export const AGENT_DOOR_DOCS_URL = 'https://github.com/Mumega-com/mupot/blob/main/docs/agent-door.md'

export interface WhoamiCtx {
  facts: WhoamiFacts
  /** Canonical public origin, for links. */
  origin: string
}

const hasHarness = (auth: AuthContext): boolean => auth.harnessCredential === true || (typeof auth.harnessId === 'string' && auth.harnessId.length > 0)

/** The ONE state derivation. Exported for boot's legacy fields to share. */
export function whoamiState(env: Env, auth: AuthContext): { state: WhoamiState; basis?: 'attached' | 'legacy_consent' } {
  if (auth.harnessCredential === true) return { state: 'harness_unseated' }
  if (!auth.boundAgentId) {
    return auth.channel === 'directory' && hasHarness(auth) && seatAutoEnrollEnabled(env)
      ? { state: 'harness_unseated' }
      : { state: 'no_agent' }
  }
  if (attachedAuthority(auth) || auth.seatBinding?.attached) return { state: 'acting_as', basis: 'attached' }
  if (auth.seatBinding) return { state: 'own_seat' }
  if (auth.channel === 'directory' && auth.consentedByMemberId) return { state: 'acting_as', basis: 'legacy_consent' }
  return { state: 'host' }
}

/** #2020: bootstrap_self is an ungated identity mint. Advertise it only to a session it will accept AND that
 *  should be offered it: never bootstrapped, and either the pot has no agents (first member) or the member is an
 *  org admin. A stranger in a populated pot must not be shown it. */
export function bootstrapOffered(auth: AuthContext, facts: WhoamiFacts): boolean {
  if (auth.channel !== 'directory' || auth.boundAgentId || typeof auth.memberId !== 'string') return false
  if (hasHarness(auth)) return false // a harness session's door is seat_select, not a second identity
  if (auth.consentedByMemberId) return false // a lapsed consent is repaired by re-consenting, not a new agent
  if (facts.bootstrappedBefore) return false
  const grants = auth.latentCapabilities ?? auth.capabilities ?? []
  return !facts.tenantHasAgents || hasCapability(grants, 'org', null, 'admin')
}

// The seat_select instruction is the refusal table's own sentence (one text, so boot and a refusal cannot disagree).
const SEAT_SELECT_STEP = `this connection is a harness session with no agent yet. ${TABLE_SEAT_SELECT_STEP} Lost the handle? Call seat_select again with the same project/folder/thread labels: you get your existing seat and a new handle.`

/**
 * The attach order, printed on an unattached seat BEFORE the first seat_attach (mupot#1521).
 * A Grok Bot seat learned this only by hitting 409; boot_context/whoami says it up front.
 * One function so boot's next_step and whoami.next_step_plain cannot drift.
 *
 * The 'Allow for me' designation step is included only when seatAttachDesignatedEnabled: that flag is what
 * renders the dashboard button and makes seat_attach return 409 agent_not_designated_for_you. With attach on
 * and designation off, attachDesignatedClause allows attach without that step and the button's endpoint 404s,
 * so naming it would send the human to a dead end (#2178).
 */
const ATTACH_ADMIT =
  "seat_attach {agent}: it returns pending_admission and an attach code; your human admits that code on /connections; call seat_attach again and it returns attached. boot_context then shows acts_as. An attached connection peeks the inbox with inbox {peek:true} and records what it handled with inbox_mark_handled; it cannot ack or lease."

export function attachConnectOrder(env: Pick<Env, 'SEAT_ATTACH' | 'SEAT_AUTO_ENROLL' | 'SEAT_ATTACH_DESIGNATED'>): string {
  if (!seatAttachDesignatedEnabled(env)) return `Call ${ATTACH_ADMIT}`
  return "Before seat_attach, your human opens that agent's page and presses 'Allow for me' (the box 'Allow my chats to become this agent'); seat_attach before that returns 409 agent_not_designated_for_you. Then call " + ATTACH_ADMIT
}

/** boot_context available_doors seat_attach copy. Same designation gate as attachConnectOrder (#2178). */
const SEAT_ATTACH_DOOR_TAIL =
  "seat_attach {agent}: pending_admission; your human approves once with their passkey (an approve_url, or they admit the attach code on /connections), then call seat_attach again and your NEXT request acts as that agent. The attached connection peeks the inbox (inbox_mark_handled) and cannot ack or lease."

export function seatAttachDoor(env: Pick<Env, 'SEAT_ATTACH' | 'SEAT_AUTO_ENROLL' | 'SEAT_ATTACH_DESIGNATED'>): { does: string; requires: string } {
  if (seatAttachDesignatedEnabled(env)) {
    return {
      does: "act as an agent you already have. First your human presses 'Allow for me' on that agent's page (otherwise seat_attach returns 409 agent_not_designated_for_you). Then call " + SEAT_ATTACH_DOOR_TAIL,
      requires: "the agent must be one your human administers, and they must have pressed Allow for me; nothing is attached until they tap",
    }
  }
  return {
    does: 'act as an agent you already have. Call ' + SEAT_ATTACH_DOOR_TAIL,
    requires: 'the agent must be one your human administers; nothing is attached until they tap',
  }
}

/** The one-sentence answer per state (exported for the tests). It names whether the seat tools apply, so no agent has to read docs or
 *  source to learn seat_select vs seat_attach or whether a handle is needed. The state is the same derivation as `state`. */
export function plainNextStep(
  env: Env,
  auth: AuthContext,
  state: WhoamiState,
  basis: 'attached' | 'legacy_consent' | undefined,
  facts: WhoamiFacts,
  missing: WhoamiMissing[],
  seatSelectCallable: boolean,
): string {
  const as = facts.actsAs ?? 'your agent'
  if (state === 'acting_as' && basis === 'attached') {
    const ceiling = auth.seatBinding?.attached?.ceiling ?? 'member'
    // A handle-keyed seat that got attached resolves the attachment ON THE HANDLE PATH (seat-handle.ts), so it must keep sending the handle;
    // an OAuth / auto seat carries the attachment on the connection and needs none.
    const handle = auth.seatBinding?.source === 'handle'
      ? 'keep passing your seat handle with each request (this attachment is found through it)'
      : 'no seat handle needed'
    return `You are ${as} (attached to your human's chat, ceiling ${ceiling}). Nothing to set up; your identity rides this connection; ${handle}, and never call seat_select or seat_attach from here. Next: read your inbox with inbox {peek:true} (then inbox_mark_handled; you cannot ack or lease) or your open work with needs_you_list.`
  }
  if (state === 'acting_as') {
    return `You are ${as} (your human consented this connection to it). Nothing to set up; no seat handle needed; the seat tools (seat_select, seat_attach) do not apply. Next: read your inbox or your open work with needs_you_list.`
  }
  if (state === 'own_seat') {
    const handle = auth.seatBinding?.source === 'handle'
      ? 'Keep sending your seat handle with each request.'
      : 'This is an automatic seat tied to this chat: no seat handle is needed.'
    // A held / observed seat is limited to the read floor, and seat_attach is refused at that floor: do not offer it.
    const limited = auth.seatAgentStatus === 'held' || auth.seatAgentStatus === 'observed'
    const attach = limited
      ? `This seat is ${auth.seatAgentStatus}, so it is limited to the read floor until your human lifts it: do not call seat_attach or seat_select; you can read your inbox with inbox {peek:true} and your open work with needs_you_list, and ask your human to lift the limit.`
      : seatAttachEnabled(env)
      ? `${attachConnectOrder(env)} do not call seat_select (you already have a seat).`
      : 'Attaching to an existing agent is not enabled on this pot; do not call seat_select (you already have a seat).'
    return `You are ${as} on this chat's own seat. ${handle} ${attach} Otherwise: read your inbox or your open work with needs_you_list.`
  }
  if (state === 'host') {
    return `You are ${as}; the seat tools (seat_select, seat_attach) do not apply to a workspace-token agent. Next: read your inbox or your open work with needs_you_list.`
  }
  if (state === 'harness_unseated') {
    const attach = seatSelectCallable && seatAttachEnabled(env) ? ` ${attachConnectOrder(env)}` : ''
    return seatSelectCallable
      ? `You have no agent yet. To get your own seat call seat_select {project, folder, thread} and pass the returned mseat_ handle as seat on every later call. To act as an existing agent, get a seat first.${attach}`
      : 'You have no agent yet and seats are not enabled for this connection. ' + (missing[0]?.next_step ?? 'Ask your human or an org admin.')
  }
  return `You have no agent yet. ${missing[0]?.next_step ?? 'Ask your human or an org admin to connect you to one.'}`
}

export function buildWhoami(env: Env, auth: AuthContext, ctx: WhoamiCtx): Whoami {
  const { facts } = ctx
  const { state, basis } = whoamiState(env, auth)
  const seat = auth.seatBinding ?? null
  const bound = Boolean(auth.boundAgentId)
  const consentUrl = mcpEndpoint(ctx.origin)
  const labels = consentLabels(consentChoiceLabels(env)) // the consent tabs this pot actually shows (SEAT_ATTACH on/off)
  const missing: WhoamiMissing[] = []

  // Silent downgrades, said out loud (dead end 13). State below already reflects the downgraded reality.
  const seatSelectCallable = state === 'harness_unseated' && seatAutoEnrollEnabled(env)
  if (auth.seatInputs?.handleRejected) {
    missing.push({
      code: 'seat_handle_rejected',
      who_acts: 'self',
      next_step: seatSelectCallable
        ? `the seat handle you sent was not accepted (unknown, revoked or belonging to another connection), so this request has no seat. ${SEAT_SELECT_STEP}`
        : 'the seat handle you sent was not accepted and was ignored; stop sending it. This request is bound the way boot_context says it is, with no handle.',
      ...(seatSelectCallable ? { next_tool: 'seat_select' } : {}),
    })
  }
  if (auth.seatInputs?.autoSeatRefused) {
    const reason = auth.seatInputs.autoSeatRefused
    // seat_select runs the same resolveOrCreateSeat path as the auto seat, so a reason that cannot clear on retry is refused
    // again with the same code. Each such reason maps to the actor and sentence of the refusal table's own row (one text).
    const g = refusalGuidance(reason, 403, undefined, 'seat_select', { kind: 'chat_harness', choiceLabels: consentChoiceLabels(env), origin: ctx.origin })
    if (reason === 'harness_required' || reason === 'member_not_active' || reason === 'home_rank_insufficient') {
      missing.push({
        code: 'auto_seat_refused',
        who_acts: g.who_acts,
        next_step: `this chat's automatic seat was refused (${reason}). ${g.next_step ?? ''}`.trim(),
        ...(reason === 'harness_required' ? { link: consentUrl } : {}),
      })
    } else if (reason === 'seat_cap_reached' || reason === 'rate_limited') {
      // The auto pool has its own cap and window (migration 0205), separate from the select pool seat_select draws on, so seat_select
      // is expected to work. The step is the refusal table's seat_cap_reached row ("call seat_select with the same labels").
      const row = refusalGuidance('seat_cap_reached', 403, undefined, 'seat_select', { kind: 'chat_harness', choiceLabels: consentChoiceLabels(env), origin: ctx.origin })
      missing.push({
        code: 'auto_seat_refused',
        who_acts: row.who_acts,
        next_step: `this chat's automatic seat was refused (${reason}). ${row.next_step ?? ''}`.trim(),
        ...(seatSelectCallable && row.next_tool ? { next_tool: row.next_tool } : {}),
      })
    } else {
      // Reasons that can clear on retry (seat_not_live, error, no_capabilities, ...) keep the seat_select step.
      missing.push({
        code: 'auto_seat_refused',
        who_acts: seatSelectCallable ? 'self' : 'owner',
        next_step: `this chat's automatic seat was refused (${reason}), so it has no agent of its own. ${seatSelectCallable ? SEAT_SELECT_STEP : `Your human can reconnect the connector and pick ${labels.many} to retry.`}`,
        ...(seatSelectCallable ? { next_tool: 'seat_select' } : { link: consentUrl }),
      })
    }
  }
  if (auth.seatInputs?.attachRefused) {
    missing.push({
      code: 'attach_refused',
      who_acts: 'owner',
      next_step: `this chat asked to act as an existing agent but was kept on its own seat (${auth.seatInputs.attachRefused}). Your human can re-approve it on their Connections page.`,
      link: `${ctx.origin.replace(/\/+$/, '')}/connections`,
    })
  }
  if (!bound && auth.channel === 'directory' && auth.consentedByMemberId) {
    missing.push({
      code: 'consent_lapsed',
      who_acts: 'owner',
      next_step: `the agent this connection was bound to is no longer active or your human no longer holds standing on it, so the binding was dropped and this session is unbound. Your human reconnects the connector and picks ${labels.one} (or ${labels.many}).`,
      link: consentUrl,
    })
  }

  if (state === 'harness_unseated') {
    if (seatAutoEnrollEnabled(env)) {
      // A seat handle was already shown the dead-end way if handleRejected; seat_select is the one next move either way.
      // A refused auto seat has already said what to do (its reason decides whether seat_select can work): no second, generic step.
      if (!missing.some((m) => m.next_tool === 'seat_select' || m.code === 'auto_seat_refused')) {
        missing.push({ code: 'seat_required', who_acts: 'self', next_step: SEAT_SELECT_STEP, next_tool: 'seat_select' })
      }
    } else {
      missing.push({
        code: 'seat_auto_enroll_disabled',
        who_acts: 'org_admin',
        next_step: 'seats are not enabled on this pot, so this harness connection cannot pick one. An org admin enables seat enrolment, or mints this agent a workspace token (mint_agent_token).',
      })
    }
  } else if (state === 'no_agent') {
    if (bootstrapOffered(auth, facts)) {
      missing.push({
        code: 'no_agent',
        who_acts: 'self',
        next_step: 'you have no agent yet: call bootstrap_self { agent_name: "<the name you are giving it>" } to create it, mint its credential and grant yourself admin on its squad in one act. No other human is required.',
        next_tool: 'bootstrap_self',
      })
    } else if (auth.channel === 'directory') {
      const wasBootstrapped = facts.bootstrappedBefore
      missing.push({
        code: wasBootstrapped ? 'bind_existing_agent' : 'no_agent',
        who_acts: 'owner',
        next_step: wasBootstrapped
          ? `you already bootstrapped an agent. Reconnect this connector and pick ${labels.one} on the consent screen to bind this connection to it.`
          : `You are connected as a person with no agent yet. Ask your human to remove and re-add this MCP server (URL in link) and on the consent screen choose ${labels.many} (each chat gets its own agent) or ${labels.one}.`,
        link: consentUrl,
      })
    } else {
      missing.push({
        code: 'agent_required',
        who_acts: 'org_admin',
        next_step: 'This token is a person, not an agent. Ask an org admin to run mint_agent_token for your agent, then reconnect with that token.',
      })
    }
  } else if (state === 'acting_as' && basis === 'attached' && facts.fenced) {
    missing.push({
      code: 'inbox_fenced',
      who_acts: 'admin',
      next_step: "this agent's inbox is fenced to its signing host (signed_only): peek is refused for this thread, so there is nothing to read here. The agent host consumes it; an org admin can change the fence with set_agent_inbox_consumer.",
    })
  } else if (state === 'host' && !facts.keyed && facts.report) {
    const r = facts.report
    if (r.outcome === 'refused_not_adopted') {
      missing.push({
        code: 'report_refused',
        who_acts: 'self',
        next_step: `boot_context refused the runtime you reported (${r.detail ?? 'not an adopted runtime'}). Report the runtime you are actually running on (not that one), or skip the report: nothing else is blocked.`,
      })
    } else if (r.outcome === 'refused_not_a_string') {
      missing.push({
        code: 'report_refused',
        who_acts: 'self',
        next_step: `boot_context refused your report (${r.detail ?? 'a value was not a string'}). runtime, model and host must each be a string.`,
        next_tool: 'boot_context',
      })
    } else if (r.missingFields.length > 0) {
      missing.push({
        code: 'report_runtime',
        who_acts: 'self',
        next_step: `call boot_context again passing ${r.missingFields.join(', ')} (any short string: what you are actually running on) so the registry shows your real seat.`,
        next_tool: 'boot_context',
      })
    }
  }

  const agent: Whoami['agent'] = !bound
    ? { keyed: false, inbox: 'none', can_self_report: false }
    : state === 'acting_as' && basis === 'attached'
      ? { keyed: facts.keyed, inbox: facts.fenced ? 'fenced' : 'peek', can_self_report: false }
      : { keyed: facts.keyed, inbox: facts.fenced ? 'fenced' : 'consume', can_self_report: state === 'host' && !facts.keyed }

  const have: string[] = []
  if (auth.memberId) have.push('member')
  if (hasHarness(auth)) have.push('harness')
  if (seat) have.push('seat')
  if (bound) have.push('agent')
  if (bound && facts.keyed) have.push('keyed')
  if (bound) have.push(`inbox:${agent.inbox}`)

  return {
    state,
    ...(basis ? { basis } : {}),
    next_step_plain: plainNextStep(env, auth, state, basis, facts, missing, seatSelectCallable),
    docs: AGENT_DOOR_DOCS_URL,
    have,
    missing,
    agent,
    ...(seat ? { seat: { seat_id: seat.seatId, acts_as: facts.actsAs, presented: seat.source === 'handle' } } : {}),
    harness: hasHarness(auth) ? 'present' : 'absent',
    ...(facts.admission ? { admission: facts.admission } : {}),
  }
}

/** Which advertised doors this connection can actually call. A door is kept iff it passes. Used by boot's
 *  available_doors so the list is whoami's callable tools, not a second opinion. */
export function whoamiDoorFilter(env: Env, auth: AuthContext, w: Whoami): (tool: string | null) => boolean {
  const offered = new Set(w.missing.flatMap((m) => (m.next_tool ? [m.next_tool] : [])))
  return (tool) => {
    if (tool === null) return true // a human-step door is a link, not a tool call
    if (auth.harnessCredential === true) return HARNESS_SESSION_ALLOWED_TOOLS.has(tool)
    if (tool === 'bootstrap_self') return offered.has('bootstrap_self')
    if (tool === 'seat_select') return offered.has('seat_select')
    if (tool === 'seat_attach') return seatAttachEnabled(env) && w.state === 'own_seat' && auth.seatAgentStatus !== 'held' && auth.seatAgentStatus !== 'observed'
    // K3/K4: connect needs a slug this caller was never handed (the step is a human re-consent or seat_select), so it is not a door.
    if (tool === 'connect' && (w.state === 'no_agent' || w.state === 'harness_unseated')) return false
    // K2 (member token, no agent): connect answers no_squad_access and the step is an org admin's mint_agent_token, so only that stays.
    if (w.state === 'no_agent' && auth.channel !== 'directory') return tool === 'mint_agent_token' || tool === 'status' || tool === 'boot_context'
    return true
  }
}
