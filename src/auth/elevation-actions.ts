// mupot — elevation action registry (Delivery Sequence step 3, mupot task
// f5fe1222, mumega-com#1173).
//
// Step-3 constraint 3: "GRANT OVER NAMED ACTIONS, NEVER OVER THE WORD
// `admin`." `admin` is undecomposed — it bundles project lifecycle, squad
// lifecycle, identity minting, key registration, capability granting, and
// budget into one word. A human elevation approval ticks one or more of the
// NAMED actions below; there is no 'admin' or 'rank' grant anywhere in this
// module or the elevation ledger it feeds.
//
// Step-3 constraint 4: "CLASSIFY EVERY ACTION BY WHETHER ITS EFFECT SURVIVES
// EXPIRY... A human must be able to see, before clicking, that an action's
// effect outlives the grant." This is the canonical map. It is a static,
// reviewed registry — NOT computed from a live table — because the whole
// point is that a human sees a value that cannot silently drift out from
// under an already-issued grant (see migrations/0148_elevation_ledger.sql's
// `effect` column, which freezes a COPY of this classification at grant
// time).
//
//   reversible            — the action's on-disk effect can be undone by
//                            someone with ordinary standing authority after
//                            the grant expires (create/delete a squad, edit
//                            an access edge, adjust a capability grant).
//   revocable_if_recorded — the action mints something with its own
//                            independent revoke primitive (a token id, a
//                            secret version) IF AND ONLY IF the elevation
//                            recorded what it minted (elevation_usage_log)
//                            so a human knows what to revoke.
//   irreversible          — there is NO undo primitive anywhere in this
//                            codebase for this action's effect. The task's
//                            own audit: register_agent_key is the only two
//                            `DELETE FROM agent_keys` statements in the
//                            codebase both live inside deactivate_agent, and
//                            registerAgentPublicKey (src/fleet/agent-keys.ts)
//                            refuses implicit rotation. A key registered
//                            inside a 15-minute elevation window is
//                            permanent. A D1 schema migration has the same
//                            shape (no down-migration mechanism exists here)
//                            and is classified the same way, conservatively.

export type ElevationActionEffect = 'reversible' | 'revocable_if_recorded' | 'irreversible'

export interface ElevationActionDef {
  /** The literal 'action:*' key stored in elevation_requests/elevation_grants. */
  key: string
  /** Short human label for the approval surface. */
  label: string
  /** One-sentence explanation of what this unlocks, for the approval surface. */
  description: string
  effect: ElevationActionEffect
  /** Human-readable note explaining the effect classification — rendered
   *  next to the effect badge so "irreversible" is never just an unglossed
   *  word on a click-through screen. */
  effectNote: string
  /** TRUE when at least one tool actually CONSULTS this action.
   *
   *  Six of these eight shipped as vocabulary with no consumer: a human could
   *  approve action:deploy, watch it render on the dashboard with a live
   *  countdown and an effect badge, and it authorized nothing. A defined
   *  action with no enforcement branch is a FALSE-AUTHORITY surface — worse
   *  than a missing feature, because the approval screen makes a promise the
   *  system never keeps, and the operator believes a decision was made.
   *
   *  Only enforced actions are requestable (REQUESTABLE_ELEVATION_ACTION_KEYS).
   *  Flip this to true in the same commit that wires the consumer, never
   *  before; tests/elevation-actions-enforced.test.ts fails either way round. */
  enforced: boolean
}

// Design doc "Authorization Semantics" names the first five presets
// (manage_access, deploy, migrate, secrets, dispatch); register_key and
// mint_token are added because they are the two actions the step-3 task
// brief calls out by name as needing explicit effect classification.
export const ELEVATION_ACTIONS: Readonly<Record<string, ElevationActionDef>> = Object.freeze({
  'action:manage_access': {
    key: 'action:manage_access',
    enforced: true,
    label: 'Manage access',
    description: 'Grant agent capabilities on a squad you have been granted. Does NOT cover project↔squad access edits (project_squad_set is standing org admin only).',
    effect: 'reversible',
    effectNote: 'Access edges and capability grants can be edited or removed by standing authority after expiry.',
  },
  'action:project_lifecycle': {
    key: 'action:project_lifecycle',
    enforced: true,
    label: 'Create/update squads',
    description: 'Create a squad inside a department you have been granted.',
    effect: 'reversible',
    effectNote: 'Created/updated records can be edited or removed by standing authority after expiry.',
  },
  // Org STRUCTURE gets its OWN keys, not a widening of action:project_lifecycle: that grant is approved under the label
  // "Create/update squads" and a live grant must never acquire department power it was not approved for.
  // Creating a department is its OWN, IRREVERSIBLE action (below): there is no delete/archive path for departments, so a
  // department created under an elevation outlives it and the approval screen must not call it undoable (bot P1).
  'action:org_department_create': {
    key: 'action:org_department_create',
    enforced: true,
    label: 'Create a department (cannot be undone)',
    description: 'Create one or more departments. Org scope only (a department or squad grant does not match). There is no delete path: a department created here stays until standing authority removes it by hand.',
    effect: 'irreversible',
    effectNote: 'Created departments are never removed automatically and no tool deletes or archives a department; standing authority must clean up by hand.',
  },
  'action:org_structure': {
    key: 'action:org_structure',
    enforced: true,
    label: 'Create/update departments and squads',
    description: 'Rename a work department, or update a squad (slug, and LOWER its budget cap) inside the scope you have been granted. Cannot raise or clear a budget, never archives or deletes, never creates a department.',
    effect: 'reversible',
    effectNote: 'Renamed departments and updated squads can be edited again by standing authority after expiry.',
  },
  'action:workspace_project': {
    key: 'action:workspace_project',
    enforced: true,
    label: 'Create/update workspace projects',
    description: 'Create or update a workspace project.',
    effect: 'reversible',
    effectNote: 'Created/updated records can be edited or removed by standing authority after expiry.',
  },
  // S14 (PR #1831 review F1, consent scope): the routine-policy and
  // project-status powers get their OWN keys. Grants persist only the action
  // string, and the labels of action:workspace_project / action:project_lifecycle
  // are creation-only ("Create/update workspace projects", "Create/update
  // squads") — a live grant approved under those labels must never acquire
  // these powers, so they are not folded into either.
  'action:routine_policy': {
    key: 'action:routine_policy',
    enforced: true,
    label: 'Enable, pause or update routines',
    description: 'Enable, pause or update routines of a squad you have been granted. Does NOT include archiving.',
    effect: 'reversible',
    effectNote: 'A routine can be re-enabled, paused or edited again by standing authority after expiry.',
  },
  // Archive is split from routine_policy: it cannot be undone (no restore path;
  // transitionRoutine/updateRoutine return routine_archived), so it must not
  // ride a grant whose label says "reversible".
  'action:routine_archive': {
    key: 'action:routine_archive',
    enforced: true,
    label: 'Archive a routine permanently (cannot be restored)',
    description: 'Archive a routine of a squad you have been granted. An archived routine cannot be restored.',
    effect: 'irreversible',
    effectNote: 'There is no restore path for an archived routine; expiry of the grant does not undo it.',
  },
  'action:project_status': {
    key: 'action:project_status',
    enforced: true,
    label: 'Change project status or restore archived rows',
    description: 'Change a project\'s status, or restore an archived project or squad.',
    effect: 'reversible',
    effectNote: 'A status change or restore can be reverted by standing authority after expiry.',
  },
  'action:mint_token': {
    key: 'action:mint_token',
    enforced: true,
    label: 'Mint agent token',
    description: 'Issue a new bound bearer credential for an agent.',
    effect: 'revocable_if_recorded',
    effectNote:
      'A minted token is revocable by id via revoke_agent_token — but ONLY if this grant\'s usage log recorded the minted token id. Unrecorded, it is effectively irreversible.',
  },
  'action:register_key': {
    key: 'action:register_key',
    enforced: false,
    label: 'Register agent signing key',
    description: 'Register a public Ed25519 key for an agent\'s signed runtime identity.',
    effect: 'irreversible',
    effectNote:
      'There is no key rotation in this codebase — registerAgentPublicKey refuses implicit rotation. A key registered under this grant is permanent until a future owner-ceremony feature exists.',
  },
  'action:deploy': {
    key: 'action:deploy',
    enforced: false,
    label: 'Deploy',
    description: 'Trigger a project deploy.',
    effect: 'reversible',
    effectNote: 'A later deploy (by standing authority) can supersede this one.',
  },
  'action:migrate': {
    key: 'action:migrate',
    enforced: false,
    label: 'Apply migration',
    description: 'Apply a D1 schema migration.',
    effect: 'irreversible',
    effectNote: 'This codebase has no down-migration mechanism; an applied schema change is not automatically undone.',
  },
  'action:secrets': {
    key: 'action:secrets',
    enforced: false,
    label: 'Manage secrets',
    description: 'Set or rotate a secret value.',
    effect: 'revocable_if_recorded',
    effectNote: 'A set secret can be rotated again by standing authority — but only once someone knows it was set, which requires this grant\'s usage log to record it.',
  },
  'action:dispatch': {
    key: 'action:dispatch',
    enforced: false,
    label: 'Dispatch work',
    description: 'Dispatch a task/flight to a squad or agent.',
    effect: 'reversible',
    effectNote: 'Dispatching enqueues work; it does not itself grant standing authority beyond the dispatch record.',
  },
  // FP-01 Slice 1 v2 (G-FP1b point 4): the ONE additional door into a
  // kind='home' squad besides createHomeForMember's own write — a time-
  // boxed, human-approved, exact-squad-scoped read for a BOUND-AGENT session
  // (never a standing grant). Consumed by src/auth/capability.ts's
  // canOnSquadAuth. A pure web-session (dashboard) operator cannot use this
  // action today — hasElevatedAction refuses any non-agent session with
  // `not_agent_session` before this registry is ever consulted, and
  // migrations/0148_elevation_ledger.sql's elevation_requests.agent_session_id
  // is NOT NULL, so a human-operator variant needs a schema decision out of
  // scope for this PR (see the PR body's "not done" list).
  'action:home_access': {
    key: 'action:home_access',
    enforced: true,
    label: 'Access a member\'s home',
    description: 'Time-boxed read on ONE named home squad (never a standing grant).',
    effect: 'reversible',
    effectNote: 'Read-only and scoped to a single squad; the access itself leaves no lasting effect once the grant expires.',
  },
  // OWNER SUDO ("/muapprove = sudo"; src/auth/owner-sudo.ts, docs/architecture/approval-bot.md). Each key names EXACTLY ONE
  // owner-only tool. A live grant lets the agent that holds it make ONE call of that tool, run AS the approving human (their live
  // standing, their rank ceilings, the tool's own checks unchanged), with the agent recorded as executor and the human as
  // authority. They are deliberately NOT folded into action:manage_access / action:org_structure: those labels promise something
  // narrower ("grant capabilities as an agent", "lower a budget"), and a live grant must never acquire power it was not approved
  // under (S14 F1). Requested alone, org or squad scope, 60 minutes at most, single-use (see owner-sudo.ts).
  'action:sudo_squad_member_add': {
    key: 'action:sudo_squad_member_add',
    enforced: true,
    label: 'Add an agent to a squad, as you (one call)',
    description: 'ONE squad_member_add call, run as you: add one agent to a squad you hold at observer or member standing. Single-use; cannot add the requesting agent to itself or confer lead/admin.',
    effect: 'reversible',
    effectNote: 'A squad membership can be removed by standing authority (squad_member_remove) after the call.',
  },
  'action:sudo_squad_dyad_pin': {
    key: 'action:sudo_squad_dyad_pin',
    enforced: true,
    label: 'Pin or clear a squad review pair, as you (one call)',
    description: 'ONE update_squad call that sets (or clears) the squad dyad review pair, run as you. Nothing else on the squad can change in that call. Single-use. The pair decides who reviews that squad\'s work by default, so you must be an org owner/admin to approve it.',
    effect: 'reversible',
    effectNote: 'The pair can be changed or cleared again by an org owner/admin.',
  },
  'action:sudo_grant_gate_capability': {
    key: 'action:sudo_grant_gate_capability',
    enforced: true,
    label: 'Grant gate (verdict) authority, as you (one call)',
    description: 'ONE grant_gate_capability call, run as you: give one gate:<owner> verdict capability to one member or agent (never the requesting agent or its own member). Single-use. Org scope only.',
    effect: 'reversible',
    effectNote: 'revoke_gate_capability removes the grant; it stays until someone with standing authority does.',
  },
  'action:sudo_seat_event_grant': {
    key: 'action:sudo_seat_event_grant',
    enforced: true,
    label: 'Authorize a host to receive an agent\'s seat events, as you (one call)',
    description: 'ONE seat_event_grant call, run as you: let one fleet host receive the seat-event hints of one agent. Single-use.',
    effect: 'reversible',
    effectNote: 'The seat-event grant can be revoked (DELETE /api/fleet/events/grants/:agent) after the call.',
  },
  // Installer window (PR-C, design S1). Consumed by src/operators/installer-window.ts, which turns a LIVE grant of one of
  // these into an in-memory delegation row for the structural-write chokepoint. Tier table: src/operators/installer-tiers.ts.
  // Credentials (token/key mint) are never part of either tier; request them separately as action:mint_token.
  'action:install_standard': {
    key: 'action:install_standard',
    enforced: true,
    label: 'Installer window (standard)',
    description: 'Time-boxed (max 50 writes): organise squads and agents (create squads and agents, add, remove and move agents) up to MEMBER standing inside the scope you grant. Cannot touch anything above member. Never changes project access, never mints credentials, never grants admin or gates, never touches humans or home squads.',
    effect: 'reversible',
    effectNote: 'Every act is receipted and ends at expiry; the window is revocable in one tap. Squads and agents it creates can be edited or removed by standing authority afterwards.',
  },
  'action:install_high': {
    key: 'action:install_high',
    enforced: true,
    label: 'Installer window (high: may touch up to lead; grants capped at member)',
    description: 'Time-boxed (max 200 writes), passkey only: everything in the standard window plus it may touch agents that hold up to LEAD standing and use grant_agent_capability. Standing grants it makes are still capped at MEMBER. Never mints credentials, never grants admin or gates, never touches humans or home squads.',
    effect: 'reversible',
    effectNote: 'Every act is receipted and ends at expiry; the window is revocable in one tap. Standing grants made inside the window (capped at member) stay until standing authority removes them.',
  },
})

export type ElevationActionKey = keyof typeof ELEVATION_ACTIONS

export function isKnownElevationAction(key: string): key is ElevationActionKey {
  return Object.prototype.hasOwnProperty.call(ELEVATION_ACTIONS, key)
}

export function elevationActionEffect(key: string): ElevationActionEffect | null {
  return isKnownElevationAction(key) ? ELEVATION_ACTIONS[key].effect : null
}

export const ALL_ELEVATION_ACTION_KEYS: readonly string[] = Object.freeze(Object.keys(ELEVATION_ACTIONS))

/** The actions a request may actually name. An unenforced action is refused at
 *  REQUEST time rather than granted and silently ignored at use time, so nobody
 *  approves something decorative. */
export const REQUESTABLE_ELEVATION_ACTION_KEYS: readonly string[] = Object.freeze(
  Object.keys(ELEVATION_ACTIONS).filter((k) => ELEVATION_ACTIONS[k].enforced),
)

export function isRequestableElevationAction(key: string): boolean {
  return isKnownElevationAction(key) && ELEVATION_ACTIONS[key].enforced
}

// 1446 minutes (~24.1 hours) is Hadi's own explicit duration — asked for
// twice, verbatim "time limited 1446" (mupot task f5fe1222). It is not a
// round-hour value; formatMinutes() in src/dashboard/elevation.ts renders it
// as "1446 minutes (~24 hours)" rather than pretending it is exactly a day.
export const ELEVATION_DURATION_PRESETS_MINUTES = Object.freeze([15, 60, 240, 480, 1440, 1446] as const)
export type ElevationDurationMinutes = (typeof ELEVATION_DURATION_PRESETS_MINUTES)[number]
export const ELEVATION_DEFAULT_DURATION_MINUTES: ElevationDurationMinutes = 60

export function isValidElevationDuration(minutes: number): minutes is ElevationDurationMinutes {
  return (ELEVATION_DURATION_PRESETS_MINUTES as readonly number[]).includes(minutes)
}

/** Actions requiring the approving human's web session to have proven a
 *  fresh (≤5min) reauthentication round-trip before the approval is
 *  admitted — design doc Approval Flow step 5. */
export const SENSITIVE_STEP_UP_ACTIONS: ReadonlySet<string> = new Set([
  'action:manage_access',
  'action:deploy',
  'action:migrate',
  'action:secrets',
  'action:register_key',
  'action:mint_token',
  'action:routine_archive', // irreversible
  'action:org_department_create', // irreversible: no tool deletes or archives a department
  'action:install_high', // installer window, lead ceiling: passkey only (standard stays Telegram-biometric approvable)
  'action:sudo_squad_member_add', // owner sudo: the agent acts as the approving human
  'action:sudo_squad_dyad_pin',
  'action:sudo_grant_gate_capability',
  'action:sudo_seat_event_grant',
])

/** Owner-sudo actions: each names exactly one owner-only tool (src/auth/owner-sudo.ts). */
export const OWNER_SUDO_ACTIONS: readonly string[] = Object.freeze([
  'action:sudo_squad_member_add',
  'action:sudo_squad_dyad_pin',
  'action:sudo_grant_gate_capability',
  'action:sudo_seat_event_grant',
])

export function isOwnerSudoAction(key: string): boolean {
  return OWNER_SUDO_ACTIONS.includes(key)
}

/** A sudo request is for ONE act: asked alone, in an org or squad scope, for at most this long. */
export const OWNER_SUDO_MAX_MINUTES = 60

/**
 * The ONLY actions whose step-up a tap in the approval bot's verified private chat may satisfy. Everything else that needs a
 * step-up (SENSITIVE_STEP_UP_ACTIONS, e.g. the broad action:manage_access) stays passkey / Mini App / Access only: a bot tap
 * is refused for it. An allow-list, never a global "a bot tap is a fresh reauth". Only args-bound single-use actions belong here.
 */
export const BOT_STEP_UP_ACTIONS: readonly string[] = OWNER_SUDO_ACTIONS // all four sudo actions are args-bound (the digest is mandatory), single-use
